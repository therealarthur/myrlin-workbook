#!/usr/bin/env node
/**
 * Tests for the Quota widget support patches (claude-swap design
 * docs/plans/2026-09-25-usage-widget-design.md section 7):
 *
 *   W1  the Claude apply keeps mcpOAuth and every other top-level key of the
 *       live .credentials.json on apply AND on the verify rollback, writes
 *       atomically, and aborts unwritten when the existing file does not parse;
 *   W2  the Codex apply warns about running Codex writers: 409 CODEX_RUNNING
 *       with the process list unless force:true, success carries
 *       runningProcesses, the lister is injectable, nothing is ever killed;
 *   W3  POST /api/credentials/import-isolated and
 *       POST /api/provider-accounts/codex/import-isolated: capture-root
 *       allowlist via real paths, identity check through an injectable
 *       profile fetcher, ALREADY_LIVE / IDENTITY_MISMATCH conflicts, upsert
 *       keyed like Workbook keys, broadcast, ownership guard.
 *
 * HERMETIC: CWM_DATA_DIR is sandboxed FIRST (test/_test-data-dir.js) and
 * LOCALAPPDATA is repointed into that sandbox before any module loads, so
 * the default capture root is a throwaway dir. Every manager gets explicit
 * sandbox paths (claudeDir, claudeJsonPath, accountsDir, a capability whose
 * authFilePath points into the sandbox); every network call goes through an
 * injected fetch or profile fetcher (an unexpected call fails loudly); the
 * process lister is always a fake. src/web/server is never loaded. Nothing
 * here can read or write the real ~/.claude, ~/.claude.json, ~/.codex or
 * ~/.myrlin. All tokens are synthetic.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

// Repoint LOCALAPPDATA into the sandbox BEFORE anything resolves the
// default capture root (it is resolved per call, but be strict anyway).
const SANDBOX = process.env.CWM_DATA_DIR;
process.env.LOCALAPPDATA = path.join(SANDBOX, 'localappdata');
const CAPTURE_ROOT = path.join(process.env.LOCALAPPDATA, 'Quota', 'capture');
fs.mkdirSync(CAPTURE_ROOT, { recursive: true });

const express = require('express');
const {
  createCredentialManager,
  serializeCredentialsFile,
  credError,
  ANTHROPIC_PROFILE_URL,
} = require('../src/web/credential-manager');
const { setupCredentialRoutes } = require('../src/web/credential-routes');
const { createProviderAccountManager } = require('../src/web/provider-account-manager');
const { setupProviderAccountRoutes, EVENT_CHANGED } = require('../src/web/provider-account-routes');
const { accountsCapability } = require('../src/providers/codex/accounts');
const { isCodexWriterProcess, normalizeProcessRow, CODEX_RUNNING_CODE } = require('../src/providers/codex/running-writers');
const { defaultCaptureRoot, resolveCaptureDir } = require('../src/web/isolated-capture-paths');

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * Minimal async test harness: runs fn, records pass/fail, prints result.
 * A body that returns the string 'SKIP' is counted as skipped.
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (may be async).
 * @returns {Promise<void>}
 */
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((outcome) => {
      if (outcome === 'SKIP') {
        skipped += 1;
        console.log('  - SKIP ' + name);
        return;
      }
      passed += 1;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    })
    .catch((err) => {
      failed += 1;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + ((err && err.message) || err) + '\x1b[0m');
    });
}

/** Assert a condition. @param {*} cond @param {string} [msg] */
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

/** Assert strict equality. @param {*} a @param {*} e @param {string} [msg] */
function assertEqual(a, e, msg) {
  if (a !== e) throw new Error(msg || ('Expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)));
}

/** Assert deep JSON equality. @param {*} a @param {*} e @param {string} [msg] */
function assertJsonEqual(a, e, msg) {
  const ja = JSON.stringify(a);
  const je = JSON.stringify(e);
  if (ja !== je) throw new Error((msg || 'JSON mismatch') + ': expected ' + je + ', got ' + ja);
}

/** Sleep helper. @param {number} ms @returns {Promise<void>} */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const silentLog = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} };

// ─── Synthetic Claude fixtures (NEVER real tokens) ─────────────────────────
const UUID_A = 'aaaaaaaa-1111-2222-3333-888888888801'; // live on the fixture PC
const UUID_B = 'bbbbbbbb-1111-2222-3333-888888888802'; // apply / import target
const UUID_C = 'cccccccc-1111-2222-3333-888888888803'; // mismatch partner
const UUID_D = 'dddddddd-1111-2222-3333-888888888804'; // second import target

/**
 * Build a claudeAiOauth fixture with distinctive (greppable) token values.
 * @param {string} tag @param {number} expiresAt @param {object} [extra]
 * @returns {object}
 */
function makeOauth(tag, expiresAt, extra = {}) {
  return {
    accessToken: 'at-QW-' + tag,
    refreshToken: 'rt-QW-' + tag,
    expiresAt,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    ...extra,
  };
}

/**
 * Build an oauthAccount identity fixture.
 * @param {string} uuid @param {string} email @returns {object}
 */
function makeIdentity(uuid, email) {
  return {
    accountUuid: uuid,
    emailAddress: email,
    organizationUuid: 'ffffffff-0000-0000-0000-000000000009',
    organizationType: 'claude_max',
    displayName: 'Quota Fixture',
    organizationName: 'Quota Org',
  };
}

/** The mcpOAuth block every W1 fixture carries (synthetic secrets). */
function makeMcpOAuth() {
  return {
    'figma|d39d3b0000000000': {
      serverName: 'figma',
      serverUrl: 'https://mcp.figma.invalid/mcp',
      accessToken: '',
      clientId: 'mcp-client-QW',
      clientSecret: 'mcp-secret-QW',
      redirectUri: 'http://localhost:1/callback',
    },
  };
}

// ─── Synthetic Codex fixtures (NEVER real tokens) ──────────────────────────
const CX_A = 'aaaaaaaa-1111-2222-3333-999999999901'; // live in the fixture home
const CX_B = 'bbbbbbbb-1111-2222-3333-999999999902'; // apply / import target
const CX_C = 'cccccccc-1111-2222-3333-999999999903'; // claim-mismatch partner
const OPENAI_CLAIM = 'https://api.openai.com/auth';

/**
 * base64url-encode a JSON object (JWT segment form, no padding).
 * @param {object} obj @returns {string}
 */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an unsigned synthetic JWT.
 * @param {object} payload @returns {string}
 */
function makeJwt(payload) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(payload) + '.SYNTHSIG';
}

/**
 * Build a synthetic chatgpt-mode auth.json object.
 * @param {string} accountId @param {string} tag
 * @param {object} [over] - claimAccountId, plan, omit (array of token keys to drop).
 * @returns {object}
 */
function makeAuth(accountId, tag, over = {}) {
  const claim = {};
  claim[OPENAI_CLAIM] = { chatgpt_account_id: over.claimAccountId || accountId, chatgpt_plan_type: over.plan || 'pro' };
  const tokens = {
    id_token: makeJwt({ email: tag.toLowerCase() + '@example.com', name: 'Quota ' + tag, exp: Math.floor(Date.now() / 1000) + 3600, ...claim }),
    access_token: makeJwt({ exp: Math.floor((Date.now() + 10 * DAY_MS) / 1000), tag: 'at-SYNTH-' + tag }),
    refresh_token: 'rt-SYNTH-' + tag,
    account_id: accountId,
  };
  for (const k of (over.omit || [])) delete tokens[k];
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: new Date().toISOString() };
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Unexpected network calls land here; every test asserts it stays empty. */
const unexpectedFetches = [];
/**
 * fetch that fails loudly: hermetic managers must never reach the network
 * unless a test injects its own stub.
 * @param {string} url @returns {Promise<never>}
 */
async function forbiddenFetch(url) {
  unexpectedFetches.push(String(url));
  throw new Error('unexpected network call in a hermetic test');
}

/**
 * Assert raw text contains no token material (values or key names).
 * @param {string} raw @param {string} where @returns {void}
 */
function assertNoTokenMaterial(raw, where) {
  const text = String(raw || '');
  for (const needle of ['at-QW-', 'rt-QW-', 'mcp-secret-QW', 'rt-SYNTH', 'SYNTHSIG',
    'accessToken', 'refreshToken', 'access_token', 'refresh_token', 'id_token', 'clientSecret']) {
    assert(text.indexOf(needle) === -1, where + ': token material leaked (' + needle + ')');
  }
}

let seq = 0;
/**
 * Make a fresh directory inside the sandbox.
 * @param {string} prefix @returns {string}
 */
function freshDir(prefix) {
  seq += 1;
  const d = path.join(SANDBOX, prefix + '-' + seq);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Make a fresh capture dir under the default capture root.
 * @param {string} prefix @returns {string}
 */
function freshCaptureDir(prefix) {
  seq += 1;
  const d = path.join(CAPTURE_ROOT, prefix + '-' + seq);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Create a hermetic Claude manager over a throwaway tree. The live token
 * file carries mcpOAuth plus extra top-level keys unless liveCred is given.
 *
 * @param {object} [cfg]
 * @param {object|string|null} [cfg.liveCred] - Live file object, raw text, or null.
 * @param {object|null} [cfg.liveIdentity] - Live oauthAccount (null = none).
 * @param {object} [cfg.managerOpts] - Extra createCredentialManager opts.
 * @param {object} [cfg.settings] - Mutable settings object.
 * @returns {{manager: object, claudeDir: string, claudeJsonPath: string, credPath: string, accountsDir: string}}
 */
function makeClaudeFixture(cfg = {}) {
  const root = freshDir('claude-fx');
  const claudeDir = path.join(root, 'dot-claude');
  const claudeJsonPath = path.join(root, 'dot-claude.json');
  const accountsDir = path.join(root, 'accounts');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  const credPath = path.join(claudeDir, '.credentials.json');
  const liveCred = cfg.liveCred !== undefined ? cfg.liveCred : {
    mcpOAuth: makeMcpOAuth(),
    claudeAiOauth: makeOauth('LIVE-A', Date.now() + 12 * HOUR_MS, { liveOnlyKey: 'dropped-on-apply' }),
    organizationUuid: 'org-top-level-key',
    designOauth: { note: 'unknown future key' },
  };
  if (typeof liveCred === 'string') fs.writeFileSync(credPath, liveCred, 'utf-8');
  else if (liveCred) fs.writeFileSync(credPath, JSON.stringify(liveCred), 'utf-8');
  const liveIdentity = cfg.liveIdentity !== undefined ? cfg.liveIdentity : makeIdentity(UUID_A, 'live.a@example.com');
  if (liveIdentity) {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ numStartups: 7, oauthAccount: liveIdentity }, null, 2), 'utf-8');
  }
  const settings = cfg.settings || {};
  const manager = createCredentialManager({
    claudeDir,
    claudeJsonPath,
    accountsDir,
    settingsProvider: () => settings,
    fetchImpl: forbiddenFetch,
    usageUrl: 'https://usage.invalid/usage',
    tokenUrl: 'https://token.invalid/token',
    profileUrl: 'https://profile.invalid/api/oauth/profile',
    seedDir: path.join(root, 'no-seed-here'),
    log: silentLog,
    ...(cfg.managerOpts || {}),
  });
  return { manager, claudeDir, claudeJsonPath, credPath, accountsDir };
}

/**
 * Create a hermetic Codex manager over a throwaway fake CODEX home.
 *
 * @param {object} [cfg]
 * @param {object|null} [cfg.liveAuth] - Live auth.json object (null = none).
 * @param {object} [cfg.managerOpts] - Extra createProviderAccountManager opts.
 * @returns {{manager: object, authPath: string, accountsDir: string}}
 */
function makeCodexFixture(cfg = {}) {
  const root = freshDir('codex-fx');
  const home = path.join(root, 'codex-home');
  const accountsDir = path.join(root, 'accounts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  const authPath = path.join(home, accountsCapability.watchFileName);
  const liveAuth = cfg.liveAuth !== undefined ? cfg.liveAuth : makeAuth(CX_A, 'LIVE-A');
  if (liveAuth) fs.writeFileSync(authPath, JSON.stringify(liveAuth), 'utf-8');
  const capability = {
    ...accountsCapability,
    authFilePath: () => authPath,
    watchDir: () => home,
    usage: { ...accountsCapability.usage, url: () => 'https://usage.invalid/wham' },
  };
  const manager = createProviderAccountManager(capability, {
    accountsDir,
    fetchImpl: forbiddenFetch,
    log: silentLog,
    ...(cfg.managerOpts || {}),
  });
  return { manager, authPath, accountsDir };
}

/**
 * List files in a dir, tolerating a missing dir.
 * @param {string} dir @returns {string[]}
 */
function listDir(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

// ─── Route harness ──────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-token-quota-widget-support';

/**
 * Bearer auth middleware mirroring the production requireAuth contract.
 * @param {import('express').Request} req @param {import('express').Response} res
 * @param {Function} next @returns {void}
 */
function requireAuth(req, res, next) {
  if (String(req.headers.authorization || '') === 'Bearer ' + TEST_TOKEN) return next();
  res.status(401).json({ error: 'UNAUTHORIZED', code: 401, message: 'auth required', retryable: false });
}

/**
 * The server's structuredError, copied verbatim (shape contract).
 * @param {import('express').Response} res @param {number} statusCode
 * @param {string} errorCode @param {string} message @param {boolean} [retryable]
 * @returns {import('express').Response}
 */
function structuredError(res, statusCode, errorCode, message, retryable = false) {
  return res.status(statusCode).json({ error: errorCode, code: statusCode, message, retryable });
}

/**
 * Issue one HTTP request; keeps the raw body for leak assertions.
 * @param {import('http').Server} server @param {string} method @param {string} urlPath
 * @param {{body?: object, skipAuth?: boolean}} [opts]
 * @returns {Promise<{status: number, body: *, raw: string}>}
 */
function req(server, method, urlPath, opts) {
  opts = opts || {};
  const data = opts.body == null ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (!opts.skipAuth) headers['Authorization'] = 'Bearer ' + TEST_TOKEN;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let body = buf;
        try { body = buf ? JSON.parse(buf) : null; } catch (_) { /* keep raw */ }
        resolve({ status: res.statusCode, body, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Every deadline timer in the code under test is unref'd (by design, so it
// can never hold a server open). A test that awaits one of those deadlines
// with nothing else pending would let Node drain the loop and exit 0 in the
// middle of the run; this ref'd interval keeps the loop alive until the end
// (same pattern as credential-protections-gate.test.js).
const keepAlive = setInterval(() => {}, 1000);
// A run that ends before the results line must never read as green.
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.log('  FATAL: the test run ended before completion');
    process.exitCode = 1;
  }
});

(async function main() {
  console.log('\n  quota-widget-support tests (W1, W2, W3)');
  console.log('  ' + '─'.repeat(70));

  // ═══ Sandbox sanity ═══════════════════════════════════════════════════
  await test('the default capture root resolves inside the sandboxed LOCALAPPDATA', async () => {
    assertEqual(defaultCaptureRoot(), CAPTURE_ROOT);
    assert(CAPTURE_ROOT.indexOf(SANDBOX) === 0, 'capture root is inside the test sandbox');
  });

  // ═══ W1: read-modify-write of the live token file ════════════════════
  await test('W1 apply: replaces ONLY claudeAiOauth; mcpOAuth and every other top-level key survive', async () => {
    const fx = makeClaudeFixture();
    const before = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8'));
    const targetCreds = makeOauth('B-APPLY', Date.now() + 6 * HOUR_MS, { clientId: 'client-B', refreshTokenExpiresAt: Date.now() + 20 * DAY_MS });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: 'b@example.com', credentials: targetCreds,
      identity: makeIdentity(UUID_B, 'b@example.com'), tokenState: 'ok',
    });
    const result = await fx.manager.applyCredential(UUID_B);
    assertEqual(result.applied, true);
    const after = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8'));
    assertJsonEqual(after.mcpOAuth, before.mcpOAuth, 'mcpOAuth survived the apply');
    assertEqual(after.organizationUuid, 'org-top-level-key', 'other top-level key survived');
    assertJsonEqual(after.designOauth, before.designOauth, 'unknown future key survived');
    assertJsonEqual(after.claudeAiOauth, targetCreds, 'claudeAiOauth is exactly the snapshot credentials (every key)');
    assert(after.claudeAiOauth.liveOnlyKey === undefined, 'claudeAiOauth replaced, not merged with the old account');
    assertJsonEqual(Object.keys(after), Object.keys(before), 'top-level key order kept');
    assertEqual(JSON.parse(fs.readFileSync(fx.claudeJsonPath, 'utf-8')).oauthAccount.accountUuid, UUID_B);
    assertEqual(unexpectedFetches.length, 0, 'no network');
    fx.manager.stopCredentialWatcher();
  });

  await test('W1 apply: a file holding only claudeAiOauth keeps its exact historical bytes format', async () => {
    const fx = makeClaudeFixture({ liveCred: { claudeAiOauth: makeOauth('LIVE-A', Date.now() + 12 * HOUR_MS) } });
    const targetCreds = makeOauth('B-PLAIN', Date.now() + 6 * HOUR_MS);
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: 'b@example.com', credentials: targetCreds,
      identity: makeIdentity(UUID_B, 'b@example.com'), tokenState: 'ok',
    });
    await fx.manager.applyCredential(UUID_B);
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), serializeCredentialsFile(targetCreds), 'byte-identical to the old writer');
    fx.manager.stopCredentialWatcher();
  });

  await test('W1 apply: a missing live token file is created with just claudeAiOauth', async () => {
    const fx = makeClaudeFixture({ liveCred: null });
    const targetCreds = makeOauth('B-NEWFILE', Date.now() + 6 * HOUR_MS);
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: 'b@example.com', credentials: targetCreds,
      identity: makeIdentity(UUID_B, 'b@example.com'), tokenState: 'ok',
    });
    const r = await fx.manager.applyCredential(UUID_B);
    assertEqual(r.applied, true);
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), serializeCredentialsFile(targetCreds));
    fx.manager.stopCredentialWatcher();
  });

  await test('W1 apply: an unparseable live token file aborts with 409 CRED_LIVE_UNPARSEABLE and writes NOTHING', async () => {
    const garbage = '{"mcpOAuth": {"figma": SECRETGARBAGE';
    const fx = makeClaudeFixture({ liveCred: garbage });
    const identityBefore = fs.readFileSync(fx.claudeJsonPath, 'utf-8');
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: 'b@example.com', credentials: makeOauth('B-ABORT', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, 'b@example.com'), tokenState: 'ok',
    });
    let threw = null;
    try { await fx.manager.applyCredential(UUID_B); } catch (err) { threw = err; }
    assert(threw, 'apply must throw');
    assertEqual(threw.status, 409);
    assertEqual(threw.code, 'CRED_LIVE_UNPARSEABLE');
    assertEqual(threw.retryable, true, 'retryable: the writer may just be mid-write');
    assert(threw.message.indexOf('SECRETGARBAGE') === -1, 'error message never echoes file content');
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), garbage, 'live token file untouched');
    assertEqual(fs.readFileSync(fx.claudeJsonPath, 'utf-8'), identityBefore, 'identity file untouched (abort BEFORE identity-first)');
    assertEqual(listDir(fx.manager.backupsDir).length, 0, 'not even a backup was taken');
    fx.manager.stopCredentialWatcher();
  });

  await test('W1 apply: valid JSON that is not an object (array) also aborts unwritten', async () => {
    const fx = makeClaudeFixture({ liveCred: '[1,2,3]' });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: 'b@example.com', credentials: makeOauth('B-ARR', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, 'b@example.com'), tokenState: 'ok',
    });
    let threw = null;
    try { await fx.manager.applyCredential(UUID_B); } catch (err) { threw = err; }
    assert(threw && threw.code === 'CRED_LIVE_UNPARSEABLE', 'got ' + (threw && threw.code));
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), '[1,2,3]');
    fx.manager.stopCredentialWatcher();
  });

  await test('W1 rollback: verify failure restores claudeAiOauth by read-modify-write; mcpOAuth (even a NEW entry) survives', async () => {
    const fx = makeClaudeFixture();
    const before = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8'));
    const identityBefore = fs.readFileSync(fx.claudeJsonPath, 'utf-8');
    // Snapshot keyed B whose identity names C: the post-apply verify sees C
    // live instead of B and must roll BOTH halves back.
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: 'b@example.com', credentials: makeOauth('B-VERIFYFAIL', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_C, 'c@example.com'), tokenState: 'ok',
    });
    // Simulate Claude Code registering a new MCP server right after our
    // token write (between backup and restore). A verbatim backup restore
    // would erase it; the read-modify-write restore must keep it.
    const realRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function (src, dest) {
      const out = realRename.call(fs, src, dest);
      if (!injected && path.resolve(dest) === path.resolve(fx.credPath)) {
        injected = true;
        const cur = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8'));
        cur.mcpOAuth['linear|0000'] = { serverName: 'linear', clientId: 'mcp-client-QW-2' };
        fs.writeFileSync(fx.credPath, JSON.stringify(cur), 'utf-8');
      }
      return out;
    };
    let threw = null;
    try {
      await fx.manager.applyCredential(UUID_B);
    } catch (err) {
      threw = err;
    } finally {
      fs.renameSync = realRename;
    }
    assert(injected, 'the concurrent-writer simulation ran');
    assert(threw && threw.code === 'CRED_VERIFY_FAILED', 'verify failure surfaced, got ' + (threw && threw.code));
    const after = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8'));
    assertJsonEqual(after.claudeAiOauth, before.claudeAiOauth, 'prior claudeAiOauth restored exactly');
    assert(after.mcpOAuth['figma|d39d3b0000000000'], 'original mcpOAuth entry kept');
    assert(after.mcpOAuth['linear|0000'], 'mcpOAuth entry written after the backup kept (read-modify-write restore)');
    assertEqual(after.organizationUuid, 'org-top-level-key', 'other keys kept through rollback');
    assertEqual(fs.readFileSync(fx.claudeJsonPath, 'utf-8'), identityBefore, 'identity file restored byte for byte');
    fx.manager.stopCredentialWatcher();
  });

  // ═══ W2: Codex running-writer detection ══════════════════════════════
  await test('W2 matcher: Store app, npm package, IDE and CLI binaries match; unrelated processes do not', async () => {
    const yes = [
      { name: 'ChatGPT.exe', path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe\\app\\ChatGPT.exe' },
      { name: 'Codex.exe', path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe\\app\\Codex.exe' },
      { name: 'codex.exe', path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe' },
      { name: 'codex.exe', path: 'C:\\Users\\x\\.vscode\\extensions\\openai.chatgpt-26.1.0-win32-x64\\bin\\windows-x86_64\\codex.exe' },
      { name: 'codex.exe', path: null },
      { name: 'CODEX.EXE', path: 'D:/tools/codex.exe' },
      { name: 'codex-code-mode-host.exe', path: 'C:\\somewhere\\codex-code-mode-host.exe' },
      { name: 'helper.exe', path: 'C:/Users/x/AppData/Roaming/npm/node_modules/@openai/codex/bin/helper.exe' },
    ];
    const no = [
      { name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe' },
      { name: 'notepad.exe', path: 'C:\\Windows\\notepad.exe' },
      { name: 'codexfoo.exe', path: 'C:\\x\\codexfoo.exe' },
      { name: 'Code.exe', path: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' },
      { name: 'claude.exe', path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe' },
      { name: '', path: null },
    ];
    for (const p of yes) assert(isCodexWriterProcess(p), 'should match: ' + JSON.stringify(p));
    for (const p of no) assert(!isCodexWriterProcess(p), 'should NOT match: ' + JSON.stringify(p));
    assertEqual(CODEX_RUNNING_CODE, 'CODEX_RUNNING');
  });

  await test('W2 normalizeProcessRow maps Win32_Process rows to {pid, name, path}', async () => {
    assertJsonEqual(normalizeProcessRow({ ProcessId: 42, Name: 'codex.exe', ExecutablePath: 'C:\\a\\codex.exe' }),
      { pid: 42, name: 'codex.exe', path: 'C:\\a\\codex.exe' });
    assertJsonEqual(normalizeProcessRow({ ProcessId: 7, Name: 'System', ExecutablePath: null }), { pid: 7, name: 'System', path: null });
    assertEqual(normalizeProcessRow({ ProcessId: 0, Name: 'Idle' }), null);
    assertEqual(normalizeProcessRow(null), null);
  });

  const WRITER = { pid: 4101, name: 'Codex.exe', path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc\\app\\Codex.exe' };
  const NON_WRITER = { pid: 4102, name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe' };

  /**
   * Seed an apply target snapshot into a Codex fixture.
   * @param {object} fx @returns {void}
   */
  function seedCodexTarget(fx) {
    fx.manager.saveSnapshot({
      accountId: CX_B, email: 'target-b@example.com', plan: 'pro', authMode: 'chatgpt',
      auth: makeAuth(CX_B, 'TARGET-B'), tokenState: 'ok',
    });
  }

  await test('W2 apply: a running writer without force -> 409 CODEX_RUNNING with the list; NOTHING changes', async () => {
    let listerCalls = 0;
    const fx = makeCodexFixture({ managerOpts: { processLister: async () => { listerCalls += 1; return [WRITER, NON_WRITER]; } } });
    seedCodexTarget(fx);
    const liveBefore = fs.readFileSync(fx.authPath, 'utf-8');
    let threw = null;
    try { await fx.manager.applyAccount(CX_B); } catch (err) { threw = err; }
    assert(threw, 'apply must refuse');
    assertEqual(threw.status, 409);
    assertEqual(threw.code, 'CODEX_RUNNING');
    assertEqual(threw.retryable, true);
    assertJsonEqual(threw.processes, [WRITER], 'only matched writers are reported');
    assertEqual(listerCalls, 1);
    assertEqual(fs.readFileSync(fx.authPath, 'utf-8'), liveBefore, 'live auth.json untouched');
    assertEqual(listDir(fx.manager.backupsDir).length, 0, 'no backup taken: nothing changed');
    assertEqual(fx.manager.readSnapshot(CX_A), null, 'no capture-before-overwrite ran either');
  });

  await test('W2 apply: force:true swaps anyway and reports runningProcesses + processCheck ok', async () => {
    const fx = makeCodexFixture({ managerOpts: { processLister: async () => [WRITER, NON_WRITER] } });
    seedCodexTarget(fx);
    const r = await fx.manager.applyAccount(CX_B, { force: true });
    assertEqual(r.applied, true);
    assertJsonEqual(r.runningProcesses, [WRITER]);
    assertEqual(r.processCheck, 'ok');
    assertEqual(fx.manager.getActiveAccountId(), CX_B, 'live auth now reports the target');
  });

  await test('W2 apply: force must be exactly true (a truthy string does not force)', async () => {
    const fx = makeCodexFixture({ managerOpts: { processLister: async () => [WRITER] } });
    seedCodexTarget(fx);
    let threw = null;
    try { await fx.manager.applyAccount(CX_B, { force: 'yes' }); } catch (err) { threw = err; }
    assert(threw && threw.code === 'CODEX_RUNNING', 'string force refused');
  });

  await test('W2 apply: no writers running -> applied, runningProcesses [], processCheck ok', async () => {
    const fx = makeCodexFixture({ managerOpts: { processLister: async () => [NON_WRITER] } });
    seedCodexTarget(fx);
    const r = await fx.manager.applyAccount(CX_B);
    assertEqual(r.applied, true);
    assertJsonEqual(r.runningProcesses, []);
    assertEqual(r.processCheck, 'ok');
  });

  await test('W2 apply: lister failure -> proceeds with processCheck unavailable', async () => {
    const fx = makeCodexFixture({ managerOpts: { processLister: async () => { throw new Error('powershell missing'); } } });
    seedCodexTarget(fx);
    const r = await fx.manager.applyAccount(CX_B);
    assertEqual(r.applied, true);
    assertEqual(r.processCheck, 'unavailable');
    assertJsonEqual(r.runningProcesses, []);
  });

  await test('W2 apply: a lister that never settles is cut off by its deadline (chain not wedged)', async () => {
    const fx = makeCodexFixture({ managerOpts: { processLister: () => new Promise(() => {}), processCheckTimeoutMs: 150 } });
    seedCodexTarget(fx);
    const t0 = Date.now();
    const r = await fx.manager.applyAccount(CX_B);
    assert(Date.now() - t0 < 3000, 'deadline fired promptly');
    assertEqual(r.applied, true);
    assertEqual(r.processCheck, 'unavailable');
    const after = await fx.manager.syncActiveAuthToSnapshot();
    assertEqual(after, CX_B, 'the serialized chain still advances');
  });

  await test('W2 apply: no injected lister -> never enumerates, processCheck unavailable (hermetic default)', async () => {
    const fx = makeCodexFixture({});
    seedCodexTarget(fx);
    const r = await fx.manager.applyAccount(CX_B);
    assertEqual(r.applied, true);
    assertEqual(r.processCheck, 'unavailable');
  });

  await test('W2 apply: alreadyActive no-op skips the enumeration entirely', async () => {
    let listerCalls = 0;
    const fx = makeCodexFixture({ managerOpts: { processLister: async () => { listerCalls += 1; return [WRITER]; } } });
    fx.manager.saveSnapshot({ accountId: CX_A, email: 'live-a@example.com', auth: makeAuth(CX_A, 'LIVE-A'), tokenState: 'ok' });
    const r = await fx.manager.applyAccount(CX_A);
    assertEqual(r.alreadyActive, true);
    assertEqual(r.processCheck, 'skipped');
    assertEqual(listerCalls, 0, 'no enumeration for a no-op');
  });

  // ═══ W3 manager units ═══════════════════════════════════════════════
  await test('W3 allowlist: rejects outside, relative, missing, the root itself; accepts a child dir', async () => {
    const inside = freshCaptureDir('allow');
    const ok = resolveCaptureDir(inside);
    assert(ok.dir && ok.root, 'child dir accepted');
    const cases = [
      freshDir('outside'),
      'relative\\capture\\dir',
      path.join(CAPTURE_ROOT, 'does-not-exist'),
      CAPTURE_ROOT,
      path.join(CAPTURE_ROOT, '..', 'capture-sibling'),
    ];
    fs.mkdirSync(path.join(CAPTURE_ROOT, '..', 'capture-sibling'), { recursive: true });
    for (const c of cases) {
      let threw = null;
      try { resolveCaptureDir(c); } catch (err) { threw = err; }
      assert(threw && threw.status === 400 && threw.code === 'PATH_NOT_ALLOWED', 'must refuse ' + c + ', got ' + (threw && threw.code));
    }
    let v = null;
    try { resolveCaptureDir(''); } catch (err) { v = err; }
    assert(v && v.code === 'VALIDATION' && v.status === 400, 'empty string is a validation error');
  });

  await test('W3 allowlist: a junction inside the capture root that points outside is refused', async () => {
    const outside = freshDir('junction-target');
    fs.writeFileSync(path.join(outside, '.credentials.json'), JSON.stringify({ claudeAiOauth: makeOauth('ESCAPE', Date.now() + HOUR_MS) }));
    const link = path.join(CAPTURE_ROOT, 'junction-' + Date.now());
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return 'SKIP';
      throw err;
    }
    let threw = null;
    try { resolveCaptureDir(link); } catch (err) { threw = err; }
    assert(threw && threw.code === 'PATH_NOT_ALLOWED', 'junction escape refused, got ' + (threw && threw.code));
  });

  await test('W3 fetchProfile (default fetcher): GET profile URL with Bearer + beta header; classifies answers', async () => {
    const calls = [];
    let answer = { status: 200, json: { account: { uuid: UUID_B, email: 'b@example.com' }, organization: { uuid: 'org-1' } } };
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init && init.method, headers: (init && init.headers) || {} });
      if (answer === 'network') throw new Error('ECONNRESET');
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.json };
    };
    const fx = makeClaudeFixture({ managerOpts: { fetchImpl, profileUrl: 'https://profile.invalid/api/oauth/profile' } });
    const ok = await fx.manager.fetchProfile('at-QW-PROFILE');
    assertEqual(ok.ok, true);
    assertEqual(ok.profile.account.uuid, UUID_B);
    assertEqual(calls[0].url, 'https://profile.invalid/api/oauth/profile');
    assertEqual(calls[0].method, 'GET');
    assertEqual(calls[0].headers['Authorization'], 'Bearer at-QW-PROFILE');
    assertEqual(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    answer = { status: 401, json: { type: 'error' } };
    assertEqual((await fx.manager.fetchProfile('at-QW-PROFILE')).kind, 'auth');
    answer = { status: 503, json: {} };
    assertEqual((await fx.manager.fetchProfile('at-QW-PROFILE')).kind, 'transient');
    answer = { status: 200, json: { account: {} } };
    assertEqual((await fx.manager.fetchProfile('at-QW-PROFILE')).kind, 'transient', 'no uuid is not an identity');
    answer = 'network';
    const net = await fx.manager.fetchProfile('at-QW-PROFILE');
    assertEqual(net.kind, 'transient');
    assertNoTokenMaterial(JSON.stringify(net), 'classification detail');
    assertEqual(ANTHROPIC_PROFILE_URL, 'https://api.anthropic.com/api/oauth/profile', 'production default URL');
    fx.manager.stopCredentialWatcher();
  });

  await test('W3 Claude import through the DEFAULT profile fetcher (fetchImpl stub) upserts the snapshot', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ account: { uuid: UUID_D, email: 'd@example.com' }, organization: { uuid: 'org-d', name: 'D Org' } }) });
    const fx = makeClaudeFixture({ managerOpts: { fetchImpl } });
    const dir = freshCaptureDir('claude-default-fetcher');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: makeOauth('IMPORT-D', Date.now() + 8 * HOUR_MS) }));
    const out = await fx.manager.importIsolated({ configDir: dir });
    assertJsonEqual(out, { profileId: UUID_D, created: true });
    const snap = fx.manager.readSnapshot(UUID_D);
    assertEqual(snap.identity.accountUuid, UUID_D, 'identity built from the profile when the capture has no .claude.json');
    assertEqual(snap.identity.emailAddress, 'd@example.com');
    assertEqual(snap.identity.organizationName, 'D Org');
    assertEqual(snap.email, 'd@example.com');
    fx.manager.stopCredentialWatcher();
  });

  // ═══ W3 routes (real managers over sandbox paths) ════════════════════
  const events = [];
  const claudeSettings = {};
  let profileImpl = null;
  let profileCalls = 0;
  const claudeFx = makeClaudeFixture({
    settings: claudeSettings,
    managerOpts: {
      profileFetcher: async (token) => { profileCalls += 1; return profileImpl(token); },
    },
  });
  let listerImpl = async () => [];
  let ownerBlocked = false;
  const codexFx = makeCodexFixture({ managerOpts: { processLister: () => listerImpl() } });

  const app = express();
  app.use(express.json());
  setupCredentialRoutes(app, {
    requireAuth,
    getStore: () => ({ settings: {}, updateSettings: () => {} }),
    broadcast: (type, data) => events.push({ type, data }),
    structuredError,
    manager: claudeFx.manager,
  });
  setupProviderAccountRoutes(app, {
    requireAuth,
    broadcast: (type, data) => events.push({ type, data }),
    structuredError,
    managers: new Map([[accountsCapability.providerId, codexFx.manager]]),
    ownerGuard: (operation) => {
      if (ownerBlocked) throw credError(409, 'CRED_POOL_EXTERNAL_OWNER', operation + ' is disabled (test owner guard).');
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  const CLAUDE_IMPORT = '/api/credentials/import-isolated';
  const CODEX_IMPORT = '/api/provider-accounts/' + accountsCapability.providerId + '/import-isolated';
  const CODEX_APPLY = '/api/provider-accounts/' + accountsCapability.providerId + '/apply';
  assertEqual(CODEX_IMPORT, '/api/provider-accounts/codex/import-isolated', 'route path matches the design');

  /**
   * Write a Claude capture dir.
   * @param {object} opts - {uuidInIdentity, tag, noIdentity, credObj}
   * @returns {string} The capture dir.
   */
  function writeClaudeCapture(opts = {}) {
    const dir = freshCaptureDir('claude-cap');
    const credObj = opts.credObj || { claudeAiOauth: makeOauth(opts.tag || 'IMPORT', Date.now() + 8 * HOUR_MS, { refreshTokenExpiresAt: Date.now() + 30 * DAY_MS }) };
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(credObj));
    if (!opts.noIdentity) {
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
        numStartups: 1,
        oauthAccount: makeIdentity(opts.uuidInIdentity || UUID_B, 'b.captured@example.com'),
      }));
    }
    return dir;
  }

  const profileFor = (uuid, email) => async () => ({
    ok: true, status: 200,
    profile: { account: { uuid, email: email || 'profile@example.com' }, organization: { uuid: 'org-x', name: 'X Org' } },
  });

  await test('W3 routes: 401 without a bearer token on both import routes and the Codex apply', async () => {
    for (const [method, url] of [['POST', CLAUDE_IMPORT], ['POST', CODEX_IMPORT], ['POST', CODEX_APPLY]]) {
      const r = await req(server, method, url, { body: {}, skipAuth: true });
      assertEqual(r.status, 401, method + ' ' + url + ' must 401, got ' + r.status);
    }
  });

  await test('W3 Claude import: new account -> 200 {profile, created:true}; snapshot upserted; live files untouched; broadcast', async () => {
    profileImpl = profileFor(UUID_B, 'b.profile@example.com');
    const credBefore = fs.readFileSync(claudeFx.credPath, 'utf-8');
    const identityBefore = fs.readFileSync(claudeFx.claudeJsonPath, 'utf-8');
    const dir = writeClaudeCapture({ tag: 'IMPORT-B' });
    const eventsBefore = events.length;
    const r = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: dir, label: 'Work B' } });
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertNoTokenMaterial(r.raw, 'import response');
    assertEqual(r.body.created, true);
    assertEqual(r.body.profile.profileId, UUID_B);
    assertEqual(r.body.profile.label, 'Work B');
    assertEqual(r.body.profile.tokenState, 'ok');
    assertEqual(r.body.profile.isActive, false);
    const snap = claudeFx.manager.readSnapshot(UUID_B);
    assertEqual(snap.credentials.accessToken, 'at-QW-IMPORT-B', 'captured credentials stored');
    assert(Number.isFinite(snap.credentials.refreshTokenExpiresAt), 'every captured credential key kept');
    assertEqual(snap.identity.accountUuid, UUID_B, 'captured identity stored');
    assertEqual(snap.email, 'b.captured@example.com');
    assertEqual(snap.tokenState, 'ok');
    assertEqual(snap.lastRefreshError, null);
    assertEqual(fs.readFileSync(claudeFx.credPath, 'utf-8'), credBefore, 'live token file untouched');
    assertEqual(fs.readFileSync(claudeFx.claudeJsonPath, 'utf-8'), identityBefore, 'live identity untouched');
    const ev = events.slice(eventsBefore).find((e) => e.type === 'credentials:changed');
    assert(ev && ev.data.imported === true && ev.data.profileId === UUID_B && ev.data.created === true, 'credentials:changed broadcast');
    assert(ev.data.id === undefined, 'no bare id key');
    assertNoTokenMaterial(JSON.stringify(ev), 'import broadcast');
  });

  await test('W3 Claude import: re-import upserts (created:false), keeps the label unless given, resets needs_login', async () => {
    claudeFx.manager.saveSnapshot({
      accountUuid: UUID_B, tokenState: 'needs_login',
      lastRefreshError: { at: new Date().toISOString(), kind: 'auth', status: 400, detail: 'invalid_grant' },
      usage: { five_hour: { utilization: 12, resets_at: null }, fetchedAt: new Date().toISOString() },
    });
    profileImpl = profileFor(UUID_B);
    const r1 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ tag: 'REIMPORT-1' }) } });
    assertEqual(r1.status, 200, 'body=' + r1.raw);
    assertEqual(r1.body.created, false);
    assertEqual(r1.body.profile.label, 'Work B', 'existing label kept when none is given');
    assertEqual(r1.body.profile.tokenState, 'ok', 'needs_login cleared by a fresh login');
    const snap = claudeFx.manager.readSnapshot(UUID_B);
    assertEqual(snap.lastRefreshError, null);
    assertEqual(snap.credentials.accessToken, 'at-QW-REIMPORT-1', 'new credentials replace the dead pair');
    assertEqual(snap.usage && snap.usage.five_hour.utilization, 12, 'cached usage carried forward');
    const r2 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ tag: 'REIMPORT-2' }), label: 'Renamed B' } });
    assertEqual(r2.body.profile.label, 'Renamed B', 'a given label replaces the old one');
  });

  await test('W3 Claude import: captured identity disagreeing with the profile -> 409 IDENTITY_MISMATCH, nothing written', async () => {
    profileImpl = profileFor(UUID_D);
    const before = listDir(claudeFx.accountsDir).sort().join(',');
    const r = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ uuidInIdentity: UUID_C, tag: 'MISMATCH' }) } });
    assertEqual(r.status, 409, 'body=' + r.raw);
    assertEqual(r.body.error, 'IDENTITY_MISMATCH');
    assertEqual(r.body.code, 409);
    assertNoTokenMaterial(r.raw, 'mismatch response');
    assertEqual(listDir(claudeFx.accountsDir).sort().join(','), before, 'no snapshot written');
    assertEqual(claudeFx.manager.readSnapshot(UUID_D), null);
  });

  await test('W3 Claude import: the live PC account -> 409 ALREADY_LIVE', async () => {
    profileImpl = profileFor(UUID_A);
    const r = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ uuidInIdentity: UUID_A, tag: 'LIVE-AGAIN' }) } });
    assertEqual(r.status, 409, 'body=' + r.raw);
    assertEqual(r.body.error, 'ALREADY_LIVE');
    const snapA = claudeFx.manager.readSnapshot(UUID_A);
    assert(!snapA || snapA.credentials.accessToken !== 'at-QW-LIVE-AGAIN', 'live account snapshot not replaced');
  });

  await test('W3 Claude import: path outside the capture root -> 400 PATH_NOT_ALLOWED before any read or profile call', async () => {
    profileImpl = profileFor(UUID_B);
    const outside = freshDir('claude-outside');
    fs.writeFileSync(path.join(outside, '.credentials.json'), JSON.stringify({ claudeAiOauth: makeOauth('OUTSIDE', Date.now() + HOUR_MS) }));
    const callsBefore = profileCalls;
    for (const configDir of [outside, claudeFx.claudeDir, 'relative/dir']) {
      const r = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir } });
      assertEqual(r.status, 400, configDir + ' body=' + r.raw);
      assertEqual(r.body.error, 'PATH_NOT_ALLOWED');
    }
    assertEqual(profileCalls, callsBefore, 'profile endpoint never consulted for a refused path');
  });

  await test('W3 Claude import: incomplete or missing credentials -> 422 CRED_IMPORT_INCOMPLETE', async () => {
    profileImpl = profileFor(UUID_B);
    const noRefresh = writeClaudeCapture({ credObj: { claudeAiOauth: { accessToken: 'at-QW-HALF', expiresAt: Date.now() + HOUR_MS } } });
    const r1 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: noRefresh } });
    assertEqual(r1.status, 422, 'body=' + r1.raw);
    assertEqual(r1.body.error, 'CRED_IMPORT_INCOMPLETE');
    assertNoTokenMaterial(r1.raw, 'incomplete response');
    const empty = freshCaptureDir('claude-empty');
    const r2 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: empty } });
    assertEqual(r2.status, 422);
    assertEqual(r2.body.error, 'CRED_IMPORT_INCOMPLETE');
  });

  await test('W3 Claude import: profile 401 -> 422 PROFILE_REJECTED; network trouble -> 502 PROFILE_FETCH_FAILED retryable', async () => {
    profileImpl = async () => ({ ok: false, kind: 'auth', status: 401, detail: 'rejected' });
    const r1 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ tag: 'REJ' }) } });
    assertEqual(r1.status, 422, 'body=' + r1.raw);
    assertEqual(r1.body.error, 'PROFILE_REJECTED');
    assertEqual(r1.body.retryable, false);
    profileImpl = async () => ({ ok: false, kind: 'transient', status: null, detail: 'timeout' });
    const r2 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ tag: 'NET' }) } });
    assertEqual(r2.status, 502, 'body=' + r2.raw);
    assertEqual(r2.body.error, 'PROFILE_FETCH_FAILED');
    assertEqual(r2.body.retryable, true);
    profileImpl = async () => { throw new Error('fetcher blew up'); };
    const r3 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ tag: 'THROW' }) } });
    assertEqual(r3.status, 502, 'a throwing fetcher is transient, never a crash');
  });

  await test('W3 Claude import: body validation (missing configDir, non-string label) -> 400 VALIDATION', async () => {
    const r1 = await req(server, 'POST', CLAUDE_IMPORT, { body: {} });
    assertEqual(r1.status, 400);
    assertEqual(r1.body.error, 'VALIDATION');
    const r2 = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({}), label: 42 } });
    assertEqual(r2.status, 400);
    assertEqual(r2.body.error, 'VALIDATION');
  });

  await test('W3 Claude import: passive mode (external pool owner) -> 409 CRED_POOL_EXTERNAL_OWNER', async () => {
    claudeSettings.externalBridgeOwner = true;
    try {
      profileImpl = profileFor(UUID_D);
      const r = await req(server, 'POST', CLAUDE_IMPORT, { body: { configDir: writeClaudeCapture({ uuidInIdentity: UUID_D }) } });
      assertEqual(r.status, 409, 'body=' + r.raw);
      assertEqual(r.body.error, 'CRED_POOL_EXTERNAL_OWNER');
      assertEqual(claudeFx.manager.readSnapshot(UUID_D), null, 'nothing imported in passive mode');
    } finally {
      delete claudeSettings.externalBridgeOwner;
    }
  });

  /**
   * Write a Codex capture dir (fake CODEX_HOME with auth.json).
   * @param {object} auth - auth.json object.
   * @returns {string} The capture dir.
   */
  function writeCodexCapture(auth) {
    const dir = freshCaptureDir('codex-cap');
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
    return dir;
  }

  await test('W3 Codex import: new account -> 200 {account, created:true}; stored like capture; live auth untouched; broadcast', async () => {
    const liveBefore = fs.readFileSync(codexFx.authPath, 'utf-8');
    const eventsBefore = events.length;
    const r = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: writeCodexCapture(makeAuth(CX_B, 'IMPORT-CXB', { plan: 'plus' })), label: 'Side' } });
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertNoTokenMaterial(r.raw, 'codex import response');
    assertEqual(r.body.created, true);
    assertEqual(r.body.account.accountId, CX_B);
    assertEqual(r.body.account.email, 'import-cxb@example.com', 'email from id_token claims');
    assertEqual(r.body.account.plan, 'plus', 'plan from id_token claims');
    assertEqual(r.body.account.label, 'Side');
    assertEqual(r.body.account.tokenState, 'ok');
    const snap = codexFx.manager.readSnapshot(CX_B);
    assertEqual(snap.auth.tokens.refresh_token, 'rt-SYNTH-IMPORT-CXB', 'full auth payload stored verbatim');
    assertEqual(snap.lastError, null);
    assertEqual(fs.readFileSync(codexFx.authPath, 'utf-8'), liveBefore, 'live auth.json untouched');
    const ev = events.slice(eventsBefore).find((e) => e.type === EVENT_CHANGED);
    assert(ev && ev.data.imported === true && ev.data.accountId === CX_B && ev.data.providerId === accountsCapability.providerId, 'provider-accounts:changed broadcast');
    assert(ev.data.id === undefined, 'no bare id key');
    assertNoTokenMaterial(JSON.stringify(ev), 'codex import broadcast');
  });

  await test('W3 Codex import: re-import keeps the label, clears needs_login and lastError, created:false', async () => {
    codexFx.manager.saveSnapshot({ accountId: CX_B, tokenState: 'needs_login', lastError: { at: new Date().toISOString(), kind: 'auth', status: 401 } });
    const r = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: writeCodexCapture(makeAuth(CX_B, 'REIMPORT-CXB')) } });
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertEqual(r.body.created, false);
    assertEqual(r.body.account.label, 'Side');
    assertEqual(r.body.account.tokenState, 'ok');
    assertEqual(codexFx.manager.readSnapshot(CX_B).lastError, null);
  });

  await test('W3 Codex import: the live account -> 409 ALREADY_LIVE', async () => {
    const r = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: writeCodexCapture(makeAuth(CX_A, 'LIVE-AGAIN')) } });
    assertEqual(r.status, 409, 'body=' + r.raw);
    assertEqual(r.body.error, 'ALREADY_LIVE');
  });

  await test('W3 Codex import: id_token claim naming another account -> 409 IDENTITY_MISMATCH', async () => {
    const r = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: writeCodexCapture(makeAuth(CX_C, 'CLAIMX', { claimAccountId: CX_B })) } });
    assertEqual(r.status, 409, 'body=' + r.raw);
    assertEqual(r.body.error, 'IDENTITY_MISMATCH');
    assertEqual(codexFx.manager.readSnapshot(CX_C), null);
  });

  await test('W3 Codex import: missing token fields -> 422 ACCT_IMPORT_INCOMPLETE; no auth.json -> 422', async () => {
    const r1 = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: writeCodexCapture(makeAuth(CX_C, 'NORT', { omit: ['refresh_token'] })) } });
    assertEqual(r1.status, 422, 'body=' + r1.raw);
    assertEqual(r1.body.error, 'ACCT_IMPORT_INCOMPLETE');
    assert(r1.body.message.indexOf('tokens.refresh_token') !== -1, 'names the missing field');
    const r2 = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: freshCaptureDir('codex-empty') } });
    assertEqual(r2.status, 422);
    assertEqual(r2.body.error, 'ACCT_IMPORT_INCOMPLETE');
  });

  await test('W3 Codex import: outside the capture root -> 400 PATH_NOT_ALLOWED; missing codexHome -> 400 VALIDATION', async () => {
    const outside = freshDir('codex-outside');
    fs.writeFileSync(path.join(outside, 'auth.json'), JSON.stringify(makeAuth(CX_C, 'OUT')));
    const r1 = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: outside } });
    assertEqual(r1.status, 400, 'body=' + r1.raw);
    assertEqual(r1.body.error, 'PATH_NOT_ALLOWED');
    const r2 = await req(server, 'POST', CODEX_IMPORT, { body: { configDir: outside } });
    assertEqual(r2.status, 400);
    assertEqual(r2.body.error, 'VALIDATION', 'the Codex route reads codexHome, not configDir');
  });

  await test('W3 Codex import: ownership guard -> 409 CRED_POOL_EXTERNAL_OWNER, nothing imported', async () => {
    ownerBlocked = true;
    try {
      const r = await req(server, 'POST', CODEX_IMPORT, { body: { codexHome: writeCodexCapture(makeAuth(CX_C, 'BLOCKED')) } });
      assertEqual(r.status, 409, 'body=' + r.raw);
      assertEqual(r.body.error, 'CRED_POOL_EXTERNAL_OWNER');
      assertEqual(codexFx.manager.readSnapshot(CX_C), null);
    } finally {
      ownerBlocked = false;
    }
  });

  // ═══ W2 route contract ══════════════════════════════════════════════
  await test('W2 route: running writer -> 409 {error:CODEX_RUNNING, code, message, retryable:true, processes}; force:true -> 200 runningProcesses', async () => {
    listerImpl = async () => [WRITER, NON_WRITER];
    const liveBefore = fs.readFileSync(codexFx.authPath, 'utf-8');
    const r1 = await req(server, 'POST', CODEX_APPLY, { body: { accountId: CX_B } });
    assertEqual(r1.status, 409, 'body=' + r1.raw);
    assertJsonEqual(Object.keys(r1.body).sort(), ['code', 'error', 'message', 'processes', 'retryable']);
    assertEqual(r1.body.error, 'CODEX_RUNNING');
    assertEqual(r1.body.code, 409);
    assertEqual(r1.body.retryable, true);
    assertJsonEqual(r1.body.processes, [WRITER]);
    assertEqual(fs.readFileSync(codexFx.authPath, 'utf-8'), liveBefore, 'nothing changed on 409');
    const r2 = await req(server, 'POST', CODEX_APPLY, { body: { accountId: CX_B, force: true } });
    assertEqual(r2.status, 200, 'body=' + r2.raw);
    assertEqual(r2.body.applied, true);
    assertEqual(r2.body.activeAccountId, CX_B);
    assertJsonEqual(r2.body.runningProcesses, [WRITER]);
    assertEqual(r2.body.processCheck, 'ok');
    assertNoTokenMaterial(r2.raw, 'forced apply response');
    const r3 = await req(server, 'POST', CODEX_APPLY, { body: { accountId: CX_B } });
    assertEqual(r3.status, 200, 'alreadyActive never 409s');
    assertEqual(r3.body.alreadyActive, true);
    assertEqual(r3.body.processCheck, 'skipped');
    assertJsonEqual(r3.body.runningProcesses, []);
  });

  await test('hermetic: no test reached the network', async () => {
    assertEqual(unexpectedFetches.length, 0, 'unexpected fetches: ' + unexpectedFetches.join(', '));
  });

  server.close();
  claudeFx.manager.stopCredentialWatcher();
  await sleep(10);
  clearInterval(keepAlive);

  console.log('  ' + '─'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  finished = true;
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + ((err && err.stack) || err));
  process.exit(1);
});
