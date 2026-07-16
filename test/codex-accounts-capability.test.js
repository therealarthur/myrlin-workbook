#!/usr/bin/env node
/**
 * Unit tests for src/providers/codex/accounts.js (the Codex account
 * switcher capability): decodeJwtPayload, parseAccountFromAuth,
 * mapUsageResponse, and the capability object's pure surface.
 *
 * Hermetic: pure-function tests only, plus env-based path checks against
 * a sandbox CODEX_HOME. Fixtures use SYNTHETIC JWTs (base64url of
 * fabricated payloads, unsigned) and never real tokens. Nothing reads or
 * writes the real ~/.codex.
 *
 * Design: docs/plans/2026-07-03-codex-account-switcher-design.md Part 8.1.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const path = require('path');

// Sandbox CWM_DATA_DIR (and, below, CODEX_HOME) before anything loads.
require('./_test-data-dir');
process.env.CODEX_HOME = path.join(process.env.CWM_DATA_DIR, 'codex-home');
delete process.env.CWM_CODEX_USAGE_URL;

const {
  decodeJwtPayload,
  parseAccountFromAuth,
  mapUsageResponse,
  accountsCapability,
  CODEX_USAGE_URL,
} = require('../src/providers/codex/accounts');

let passed = 0;
let failed = 0;

/**
 * Minimal test harness: runs fn, records pass/fail, prints result.
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (throws to fail).
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed += 1;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + ((err && err.message) || err) + '\x1b[0m');
  }
}

/** Assert a condition. @param {*} cond @param {string} [msg] */
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

/** Assert strict equality. @param {*} a @param {*} e @param {string} [msg] */
function assertEqual(a, e, msg) {
  if (a !== e) throw new Error(msg || ('Expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)));
}

// ─── Synthetic JWT builders (NEVER real tokens) ────────────────────────────

/**
 * base64url-encode a JSON object (JWT segment form, no padding).
 * @param {object} obj - Payload object.
 * @returns {string} base64url text.
 */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an unsigned synthetic JWT with the given payload.
 * @param {object} payload - Claims object.
 * @returns {string} header.payload.signature text.
 */
function makeJwt(payload) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(payload) + '.SYNTHSIG';
}

const ACCOUNT_ID = 'abcdefab-1111-2222-3333-444455556601';
const NOW_SEC = Math.floor(Date.now() / 1000);
const OPENAI_CLAIM = 'https://api.openai.com/auth';

/**
 * Build a synthetic chatgpt-mode auth.json object.
 * @param {object} [over] - Field overrides.
 * @returns {object} auth.json-shaped fixture.
 */
function makeAuth(over = {}) {
  const claim = {};
  claim[OPENAI_CLAIM] = {
    chatgpt_account_id: over.claimAccountId || ACCOUNT_ID,
    chatgpt_plan_type: over.plan !== undefined ? over.plan : 'prolite',
  };
  return {
    auth_mode: over.auth_mode !== undefined ? over.auth_mode : 'chatgpt',
    OPENAI_API_KEY: over.OPENAI_API_KEY !== undefined ? over.OPENAI_API_KEY : null,
    tokens: over.tokens !== undefined ? over.tokens : {
      id_token: makeJwt({ email: over.email || 'fixture@example.com', name: 'Fixture Person', sub: 'sub-1', exp: NOW_SEC + 3600, ...claim }),
      access_token: makeJwt({ exp: over.accessExpSec !== undefined ? over.accessExpSec : NOW_SEC + 10 * 24 * 3600 }),
      refresh_token: 'rt-SYNTH-OPAQUE',
      account_id: over.account_id !== undefined ? over.account_id : ACCOUNT_ID,
    },
    last_refresh: over.last_refresh !== undefined ? over.last_refresh : '2026-07-01T10:00:00.000Z',
  };
}

console.log('\n  codex accounts capability tests');
console.log('  ' + '─'.repeat(60));

// ─── decodeJwtPayload ──────────────────────────────────────────────────────

test('decodeJwtPayload decodes a synthetic base64url payload', () => {
  const payload = decodeJwtPayload(makeJwt({ email: 'a@b.c', exp: 12345 }));
  assert(payload, 'payload decoded');
  assertEqual(payload.email, 'a@b.c');
  assertEqual(payload.exp, 12345);
});

test('decodeJwtPayload handles base64url alphabet and missing padding', () => {
  // A payload engineered to produce - and _ characters and length % 4 != 0.
  const payload = { k: '????>>>>~~~ÿþ', n: 7 };
  const decoded = decodeJwtPayload(makeJwt(payload));
  assert(decoded && decoded.n === 7, 'survived alphabet swap + re-padding');
});

test('decodeJwtPayload rejects malformed inputs without throwing', () => {
  assertEqual(decodeJwtPayload(null), null, 'null');
  assertEqual(decodeJwtPayload(undefined), null, 'undefined');
  assertEqual(decodeJwtPayload(''), null, 'empty string');
  assertEqual(decodeJwtPayload(42), null, 'number');
  assertEqual(decodeJwtPayload('onlyone'), null, 'one segment');
  assertEqual(decodeJwtPayload('two.segments'), null, 'two segments');
  assertEqual(decodeJwtPayload('a.b.c.d'), null, 'four segments');
  assertEqual(decodeJwtPayload('x.!!!not-base64!!!.y'), null, 'bad base64 payload');
  assertEqual(decodeJwtPayload('x.' + Buffer.from('not json').toString('base64') + '.y'), null, 'non-JSON payload');
  assertEqual(decodeJwtPayload('x.' + Buffer.from('"just a string"').toString('base64') + '.y'), null, 'non-object payload');
  assertEqual(decodeJwtPayload('x.' + Buffer.from('[1,2]').toString('base64') + '.y'), null, 'array payload');
  // Huge string: must not throw or hang.
  assertEqual(decodeJwtPayload('x'.repeat(100000)), null, 'huge junk string');
});

// ─── parseAccountFromAuth ──────────────────────────────────────────────────

test('parseAccountFromAuth derives full identity from chatgpt mode', () => {
  const parsed = parseAccountFromAuth(makeAuth({ email: 'person@example.com' }));
  assertEqual(parsed.accountId, ACCOUNT_ID);
  assertEqual(parsed.email, 'person@example.com');
  assertEqual(parsed.plan, 'prolite');
  assertEqual(parsed.name, 'Fixture Person');
  assertEqual(parsed.authMode, 'chatgpt');
  assertEqual(parsed.lastRefresh, '2026-07-01T10:00:00.000Z');
  assert(typeof parsed.accessTokenExp === 'number', 'access exp decoded');
  assert(parsed.accessTokenExp > Date.now(), 'exp converted seconds -> ms (future)');
});

test('parseAccountFromAuth: apikey mode has no switchable identity', () => {
  const parsed = parseAccountFromAuth(makeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-SYNTH-KEY', tokens: undefined }));
  assertEqual(parsed.authMode, 'apikey');
  assertEqual(parsed.accountId, null, 'apikey mode never exposes an accountId');
});

test('parseAccountFromAuth: apikey mode with residual tokens still nulls the id', () => {
  const parsed = parseAccountFromAuth(makeAuth({ auth_mode: 'apikey' }));
  assertEqual(parsed.authMode, 'apikey');
  assertEqual(parsed.accountId, null);
});

test('parseAccountFromAuth: missing tokens degrade to nulls', () => {
  const parsed = parseAccountFromAuth({ auth_mode: 'chatgpt', tokens: null, last_refresh: null });
  assertEqual(parsed.accountId, null);
  assertEqual(parsed.email, '');
  assertEqual(parsed.accessTokenExp, null);
});

test('parseAccountFromAuth: junk inputs never throw', () => {
  assertEqual(parseAccountFromAuth(null).authMode, 'unknown');
  assertEqual(parseAccountFromAuth(undefined).accountId, null);
  assertEqual(parseAccountFromAuth('text').accountId, null);
  assertEqual(parseAccountFromAuth({ tokens: { id_token: 'garbage', access_token: 42 } }).email, '');
});

test('parseAccountFromAuth: tokens.account_id wins over the id_token claim', () => {
  const parsed = parseAccountFromAuth(makeAuth({ claimAccountId: 'deadbeef-9999-8888-7777-666655554444' }));
  assertEqual(parsed.accountId, ACCOUNT_ID, 'tokens.account_id is authoritative on mismatch');
});

test('parseAccountFromAuth: the id_token claim fills a MISSING account_id', () => {
  const auth = makeAuth({});
  delete auth.tokens.account_id;
  const parsed = parseAccountFromAuth(auth);
  assertEqual(parsed.accountId, ACCOUNT_ID, 'claim used as fallback');
});

// ─── mapUsageResponse ──────────────────────────────────────────────────────

test('mapUsageResponse maps windows and converts epoch SECONDS to ISO', () => {
  const resetSec = NOW_SEC + 1800;
  const usage = mapUsageResponse({
    email: 'person@example.com',
    plan_type: 'prolite',
    rate_limit: {
      primary_window: { used_percent: 42.5, limit_window_seconds: 18000, reset_after_seconds: 1800, reset_at: resetSec },
      secondary_window: { used_percent: 71, limit_window_seconds: 604800, reset_at: resetSec + 86400 },
    },
  }, '2026-07-15T00:00:00.000Z');
  assert(usage, 'mapped');
  assertEqual(usage.five_hour.utilization, 42.5);
  assertEqual(usage.five_hour.resets_at, new Date(resetSec * 1000).toISOString(), 'seconds converted to ms ISO');
  assertEqual(usage.seven_day.utilization, 71);
  assertEqual(usage.plan_type, 'prolite');
  assertEqual(usage.fetchedAt, '2026-07-15T00:00:00.000Z', 'injected nowIso used');
});

test('mapUsageResponse tolerates a missing window', () => {
  const usage = mapUsageResponse({
    rate_limit: { primary_window: { used_percent: 10, reset_at: NOW_SEC + 60 } },
  }, new Date().toISOString());
  assert(usage, 'mapped with one window');
  assert(usage.five_hour, 'primary present');
  assertEqual(usage.seven_day, null, 'missing secondary maps to null');
});

test('mapUsageResponse returns null on junk input', () => {
  assertEqual(mapUsageResponse(null, ''), null);
  assertEqual(mapUsageResponse(undefined, ''), null);
  assertEqual(mapUsageResponse('nope', ''), null);
  assertEqual(mapUsageResponse({}, ''), null, 'no windows at all is not usage data');
  assertEqual(mapUsageResponse({ rate_limit: {} }, ''), null);
});

test('mapUsageResponse whitelists: no token-ish fields survive', () => {
  const usage = mapUsageResponse({
    rate_limit: { primary_window: { used_percent: 1, reset_at: NOW_SEC + 60 } },
    credits: { secret: 'x' },
    spend_control: { y: 1 },
    access_token: 'at-SHOULD-NEVER-SURVIVE',
  }, new Date().toISOString());
  const raw = JSON.stringify(usage);
  assert(raw.indexOf('SHOULD-NEVER-SURVIVE') === -1, 'unknown fields dropped');
  assert(raw.indexOf('credits') === -1, 'credits dropped');
});

// ─── capability object surface ─────────────────────────────────────────────

test('capability paths derive from CODEX_HOME (sandboxed here)', () => {
  const home = process.env.CODEX_HOME;
  assertEqual(accountsCapability.authFilePath(), path.join(home, 'auth.json'));
  assertEqual(accountsCapability.watchDir(), home);
  assertEqual(accountsCapability.watchFileName, 'auth.json');
});

test('capability usage.url honors the CWM_CODEX_USAGE_URL override per call', () => {
  assertEqual(accountsCapability.usage.url(), CODEX_USAGE_URL, 'default without override');
  process.env.CWM_CODEX_USAGE_URL = 'http://127.0.0.1:1/stub-usage';
  assertEqual(accountsCapability.usage.url(), 'http://127.0.0.1:1/stub-usage', 'env override applies after load');
  delete process.env.CWM_CODEX_USAGE_URL;
});

test('capability usage.headers carries the token ONLY in Authorization', () => {
  const auth = makeAuth({});
  const headers = accountsCapability.usage.headers(auth);
  assertEqual(headers['Authorization'], 'Bearer ' + auth.tokens.access_token);
  assertEqual(headers['chatgpt-account-id'], ACCOUNT_ID);
  assertEqual(headers['Accept'], 'application/json');
});

test('capability isNewerThan is a strict last_refresh comparison', () => {
  const older = { last_refresh: '2026-07-01T00:00:00Z' };
  const newer = { last_refresh: '2026-07-02T00:00:00Z' };
  assert(accountsCapability.isNewerThan(newer, older), 'newer wins');
  assert(!accountsCapability.isNewerThan(older, newer), 'older never wins');
  assert(!accountsCapability.isNewerThan(older, older), 'equal is NOT newer (strict)');
  assert(accountsCapability.isNewerThan(newer, {}), 'newer vs missing adopts');
  assert(!accountsCapability.isNewerThan({}, older), 'missing vs stored never regresses');
  assert(!accountsCapability.isNewerThan({ last_refresh: 'garbage' }, older), 'unparseable reads as epoch 0');
});

test('capability serializeAuth round-trips unknown fields verbatim', () => {
  const auth = makeAuth({});
  auth.some_future_field = { nested: true };
  const roundTripped = JSON.parse(accountsCapability.serializeAuth(auth));
  assertEqual(roundTripped.some_future_field.nested, true, 'unknown field survived');
  assertEqual(roundTripped.tokens.refresh_token, 'rt-SYNTH-OPAQUE');
});

// ─── Results ───────────────────────────────────────────────────────────────

console.log('  ' + '─'.repeat(60));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
