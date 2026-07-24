#!/usr/bin/env node
/**
 * Unit tests for src/web/mac-bridge.js (Mac credential sync bridge).
 *
 * Hermetic: every ssh/scp child process is replaced by an injected
 * execFileImpl recorder (opts.execFileImpl), so ZERO real processes spawn
 * and no network is touched. CWM_CRED_DISABLE_MAC is set as a second belt
 * so nothing route-level could ever fire either.
 *
 * Load-bearing security assertions:
 *   token material (accessToken/refreshToken values) must NEVER appear in
 *   any argv; secrets travel exclusively inside the 0600 local temp file
 *   that scp ships to a random remote /tmp name, and that temp file is
 *   deleted after the call.
 *
 * Also covered: argv shape (StrictHostKeyChecking=accept-new, BatchMode,
 * ConnectTimeout cap), exit-code mapping (255 = unreachable, 127 = tool
 * missing), the readMacInventory section parser incl. missing and garbage
 * sections, and the install/apply split with its pre-use sync-back.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');
// Belt and braces: even if a code path ignored the injected execFileImpl,
// route-level gates would still refuse to fire the real bridge.
process.env.CWM_CRED_DISABLE_MAC = '1';

const bridge = require('../src/web/mac-bridge');

let passed = 0;
let failed = 0;

/**
 * Minimal async test harness: runs fn, records pass/fail, prints result.
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (may be async).
 * @returns {Promise<void>}
 */
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
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

// ─── Fixture constants ──────────────────────────────────────────────────────
const UUID_M = 'abcd1234-9999-8888-7777-666655554444';
const UUID_2 = 'beefbeef-1111-2222-3333-666655554444';
const CFG = { host: 'alloy', user: 'arthur', sshTimeoutSec: 8 };
// Distinctive secret markers: the leak assertions grep for these.
const AT_SECRET = 'at-BRIDGE-SECRET-001';
const RT_SECRET = 'rt-BRIDGE-SECRET-001';

/**
 * Build a snapshot fixture as the credential manager would store it.
 * @param {object} [over] - Field overrides.
 * @returns {object} Snapshot object.
 */
function makeSnapshot(over = {}) {
  return {
    accountUuid: UUID_M,
    email: 'bridge@example.com',
    label: 'Work Laptop',
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    credentials: {
      accessToken: AT_SECRET,
      refreshToken: RT_SECRET,
      expiresAt: Date.now() + 6 * 3600 * 1000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
    identity: { accountUuid: UUID_M, emailAddress: 'bridge@example.com' },
    usage: null,
    tokenState: 'ok',
    lastRefreshError: null,
    ...over,
  };
}

/**
 * Minimal manager stub exposing exactly what the bridge consumes.
 * @param {object|null} snapshot - What readSnapshot returns.
 * @returns {object} Manager-shaped stub with call recording.
 */
function makeManagerStub(snapshot) {
  const stub = {
    hints: [],
    syncBacks: [],
    readSnapshot: () => snapshot,
    listSnapshots: () => (snapshot ? [snapshot] : []),
    setMacActiveHint: (uuid) => { stub.hints.push(uuid); },
    syncBackFromMac: (uuid, credText) => {
      stub.syncBacks.push({ uuid, credText });
      return Promise.resolve({ synced: true });
    },
  };
  return stub;
}

/**
 * Build a scripted execFile fake. Each spawned call is recorded (cmd, argv,
 * options) and answered from the script: an array of {stdout, stderr, code,
 * killed} steps consumed in order, or a function(call, index) returning one
 * step. Secrets are also captured from the scp source file AT SPAWN TIME so
 * tests can prove the payload traveled by file, not argv.
 *
 * @param {Array|Function} script - Step list or step factory.
 * @returns {{impl: Function, calls: Array}} Fake and its call log.
 */
function makeExecFake(script) {
  const calls = [];
  const impl = (cmd, args, options, cb) => {
    const call = { cmd, args: args.slice(), options };
    // scp calls: snapshot the local source file's content right now (the
    // bridge deletes it in finally, so read it before completing).
    if (cmd === 'scp') {
      const src = args[args.length - 2];
      try { call.scpPayload = fs.readFileSync(src, 'utf-8'); } catch (_) { call.scpPayload = null; }
      call.scpSourcePath = src;
    }
    calls.push(call);
    const idx = calls.length - 1;
    const step = (typeof script === 'function' ? script(call, idx) : script[idx]) || {};
    let err = null;
    if (step.code || step.killed) {
      err = new Error('exit ' + (step.code || 'killed'));
      if (typeof step.code === 'number') err.code = step.code;
      err.killed = !!step.killed;
      err.signal = step.signal || null;
    }
    process.nextTick(() => cb(err, step.stdout || '', step.stderr || ''));
  };
  return { impl, calls };
}

/**
 * Assert that no argv of any recorded call carries token material.
 * @param {Array} calls - Recorded calls from makeExecFake.
 * @param {string} where - Failure label.
 * @returns {void}
 */
function assertNoSecretInArgv(calls, where) {
  for (const c of calls) {
    const joined = c.args.join(' ');
    assert(joined.indexOf(AT_SECRET) === -1, where + ': access token VALUE leaked into ' + c.cmd + ' argv');
    assert(joined.indexOf(RT_SECRET) === -1, where + ': refresh token VALUE leaked into ' + c.cmd + ' argv');
    assert(joined.indexOf('accessToken') === -1, where + ': accessToken key leaked into ' + c.cmd + ' argv');
    assert(joined.indexOf('refreshToken') === -1, where + ': refreshToken key leaked into ' + c.cmd + ' argv');
  }
}

(async function main() {
  console.log('\n  mac-bridge unit tests');
  console.log('  ' + '─'.repeat(70));

  // ─── argv shape ─────────────────────────────────────────────────────────

  await test('sshExec argv: accept-new, BatchMode, capped ConnectTimeout, keep-alives, target, command', async () => {
    const fake = makeExecFake([{ stdout: 'ok\n' }]);
    const r = await bridge.sshExec(CFG, 'echo ok', 60, { execFileImpl: fake.impl });
    assertEqual(r.code, 0);
    assertEqual(r.stdout, 'ok\n');
    assertEqual(fake.calls.length, 1);
    const c = fake.calls[0];
    assertEqual(c.cmd, 'ssh');
    const a = c.args;
    // -o pairs in order-independent form: collect the option values.
    const optVals = [];
    for (let i = 0; i < a.length - 1; i += 1) if (a[i] === '-o') optVals.push(a[i + 1]);
    assert(optVals.includes('StrictHostKeyChecking=accept-new'), 'accept-new host key policy present');
    assert(!optVals.some((v) => /StrictHostKeyChecking=no/.test(v)), 'never =no');
    assert(optVals.includes('BatchMode=yes'), 'BatchMode present');
    assert(optVals.includes('ConnectTimeout=10'), 'ConnectTimeout capped at 10 even with a 60s exec budget');
    assert(optVals.includes('ServerAliveInterval=5'), 'keep-alive interval');
    assert(optVals.includes('ServerAliveCountMax=2'), 'keep-alive count');
    assertEqual(a[a.length - 2], 'arthur@alloy', 'user@host target');
    assertEqual(a[a.length - 1], 'echo ok', 'remote command last');
    assertEqual(c.options.timeout, 60000, 'exec budget in ms');
    assertEqual(c.options.windowsHide, true, 'no console flash on Windows');
  });

  await test('sshExec exit-code and timeout mapping (255 stays 255; kill maps to timedOut)', async () => {
    const fake255 = makeExecFake([{ code: 255, stderr: 'ssh: connect refused' }]);
    const r255 = await bridge.sshExec(CFG, 'true', 5, { execFileImpl: fake255.impl });
    assertEqual(r255.code, 255);
    assertEqual(r255.timedOut, false);
    const fakeKill = makeExecFake([{ killed: true, signal: 'SIGTERM', code: null }]);
    const rKill = await bridge.sshExec(CFG, 'true', 5, { execFileImpl: fakeKill.impl });
    assert(rKill.timedOut, 'killed process maps to timedOut');
  });

  await test('scpSend argv: accept-new, BatchMode, local source, remote target', async () => {
    const tmp = path.join(process.env.CWM_DATA_DIR, 'scp-src.json');
    fs.writeFileSync(tmp, '{"x":1}');
    const fake = makeExecFake([{}]);
    const ok = await bridge.scpSend(CFG, tmp, '/tmp/dst.json', 8, { execFileImpl: fake.impl });
    assertEqual(ok, true);
    const a = fake.calls[0].args;
    assertEqual(fake.calls[0].cmd, 'scp');
    const optVals = [];
    for (let i = 0; i < a.length - 1; i += 1) if (a[i] === '-o') optVals.push(a[i + 1]);
    assert(optVals.includes('StrictHostKeyChecking=accept-new'), 'accept-new on scp too');
    assert(optVals.includes('BatchMode=yes'), 'BatchMode on scp');
    assertEqual(a[a.length - 2], tmp, 'local source path');
    assertEqual(a[a.length - 1], 'arthur@alloy:/tmp/dst.json', 'remote target');
    const fakeFail = makeExecFake([{ code: 1 }]);
    const bad = await bridge.scpSend(CFG, tmp, '/tmp/dst.json', 8, { execFileImpl: fakeFail.impl });
    assertEqual(bad, false, 'scp failure resolves false, never throws');
  });

  await test('validateMacTarget rejects option injection and junk targets', () => {
    assert(bridge.validateMacTarget({ host: 'alloy', user: 'arthur' }));
    assert(bridge.validateMacTarget({ host: '100.111.181.106', user: 'arthur' }));
    for (const bad of [
      { host: '-oProxyCommand=evil', user: 'arthur' },
      { host: 'bad host', user: 'arthur' },
      { host: 'alloy', user: '-l' },
      { host: 'alloy', user: 'evil user' },
      { host: '', user: 'arthur' },
      { host: 'alloy', user: '' },
      null,
    ]) {
      let threw = false;
      try { bridge.validateMacTarget(bad); } catch (_) { threw = true; }
      assert(threw, 'expected rejection for ' + JSON.stringify(bad));
    }
  });

  await test('profileSlug: label slugified, capped, uuid8 fallback', () => {
    assertEqual(bridge.profileSlug({ label: 'Work Laptop', accountUuid: UUID_M }), 'work-laptop');
    assertEqual(bridge.profileSlug({ label: '  ***  ', accountUuid: UUID_M }), UUID_M.slice(0, 8));
    assertEqual(bridge.profileSlug({ label: '', accountUuid: UUID_M }), UUID_M.slice(0, 8));
    assertEqual(bridge.profileSlug({}), 'profile');
    const long = bridge.profileSlug({ label: 'x'.repeat(120), accountUuid: UUID_M });
    assert(long.length <= 40, 'slug capped at 40');
  });

  // ─── readMacInventory (one-round-trip sweep parser) ─────────────────────

  await test('readMacInventory happy path: ONE ssh call, four sections parsed', async () => {
    const liveCred = '{"claudeAiOauth":{"accessToken":"at-MACLIVE-X","refreshToken":"rt-MACLIVE-X","expiresAt":123}}';
    const stdout = 'work-laptop\n__CWM_S1__\nactive\nwork-laptop.credentials.json\npersonal.credentials.json\nnotes.txt\n__CWM_S2__\n'
      + liveCred + '\n__CWM_S3__\n{"email":"mac@example.com","accountUuid":"' + UUID_M + '"}\n';
    const fake = makeExecFake([{ stdout }]);
    const inv = await bridge.readMacInventory(CFG, { execFileImpl: fake.impl });
    assertEqual(fake.calls.length, 1, 'exactly ONE ssh round trip');
    const remoteCmd = fake.calls[0].args[fake.calls[0].args.length - 1];
    assert(remoteCmd.indexOf('.claude-profiles/active') !== -1, 'reads the active marker');
    assert(remoteCmd.indexOf('ls -1') !== -1, 'lists installed profiles');
    assert(remoteCmd.indexOf('.claude/.credentials.json') !== -1, 'reads the live token file');
    assert(remoteCmd.indexOf('python3') !== -1, 'reads the (lagging) identity');
    assertEqual(inv.reachable, true);
    assertEqual(inv.activeName, 'work-laptop');
    assertEqual(inv.profileNames.join(','), 'work-laptop,personal',
      'suffix stripped; non-profile entries (active marker, stray files) ignored');
    assertEqual(inv.liveCredText, liveCred, 'live token text verbatim (Node memory only)');
    assertEqual(inv.identity.email, 'mac@example.com');
    assertEqual(inv.identity.accountUuid, UUID_M);
  });

  await test('readMacInventory: exit 255 and timeout map to reachable:false', async () => {
    const fake255 = makeExecFake([{ code: 255, stderr: 'ssh: no route to host' }]);
    const r1 = await bridge.readMacInventory(CFG, { execFileImpl: fake255.impl });
    assertEqual(r1.reachable, false);
    assert(r1.error && r1.error.indexOf('no route') !== -1, 'stderr surfaced in error');
    assertEqual(r1.liveCredText, null);
    const fakeKill = makeExecFake([{ killed: true, signal: 'SIGTERM' }]);
    const r2 = await bridge.readMacInventory(CFG, { execFileImpl: fakeKill.impl });
    assertEqual(r2.reachable, false, 'timeout maps to unreachable');
  });

  await test('readMacInventory: missing and garbled sections degrade field by field', async () => {
    // Nonzero exit (python3 failed: no ~/.claude.json) still parses the
    // earlier sections; the compound exit code is just the LAST command's.
    const fakePartial = makeExecFake([{ code: 1, stdout: 'p1\n__CWM_S1__\np1.credentials.json\n__CWM_S2__\n\n__CWM_S3__\n' }]);
    const r1 = await bridge.readMacInventory(CFG, { execFileImpl: fakePartial.impl });
    assertEqual(r1.reachable, true, 'non-255 exit still parses');
    assertEqual(r1.activeName, 'p1');
    assertEqual(r1.profileNames.join(','), 'p1');
    assertEqual(r1.liveCredText, null, 'empty cred section reads as absent');
    assertEqual(r1.identity, null, 'empty python section reads as no identity');
    // Garbled python output degrades to identity null, everything else kept.
    const fakeGarbled = makeExecFake([{ stdout: 'x\n__CWM_S1__\n__CWM_S2__\n{"claudeAiOauth":{}}\n__CWM_S3__\nnot json at all\n' }]);
    const r2 = await bridge.readMacInventory(CFG, { execFileImpl: fakeGarbled.impl });
    assertEqual(r2.identity, null);
    assertEqual(r2.activeName, 'x');
    assertEqual(r2.profileNames.length, 0);
    // Separators missing entirely (truncated stream): no crash, empty fields.
    const fakeTrunc = makeExecFake([{ stdout: 'just-noise' }]);
    const r3 = await bridge.readMacInventory(CFG, { execFileImpl: fakeTrunc.impl });
    assertEqual(r3.reachable, true);
    assertEqual(r3.profileNames.length, 0);
    assertEqual(r3.liveCredText, null);
    // Invalid target never spawns anything (option-injection guard).
    const fakeNever = makeExecFake([]);
    const r4 = await bridge.readMacInventory({ host: '-evil', user: 'x' }, { execFileImpl: fakeNever.impl });
    assertEqual(r4.reachable, false);
    assertEqual(fakeNever.calls.length, 0, 'validation rejects before any spawn');
  });

  await test('resolveInventoryProfiles matches remote names to local snapshots by slug', () => {
    const snapA = makeSnapshot(); // label 'Work Laptop' -> slug work-laptop
    const snapB = makeSnapshot({ accountUuid: UUID_2, label: '', email: 'two@example.com' }); // slug = uuid8
    const manager = { listSnapshots: () => [snapA, snapB] };
    const inv = { activeName: 'work-laptop', profileNames: ['work-laptop', UUID_2.slice(0, 8), 'hand-made'] };
    const m = bridge.resolveInventoryProfiles(manager, inv);
    assertEqual(m.activeProfileId, UUID_M);
    assertEqual(m.profiles.length, 3);
    assertEqual(m.profiles[0].profileId, UUID_M);
    assertEqual(m.profiles[1].profileId, UUID_2, 'uuid8 slug matched');
    assertEqual(m.profiles[2].profileId, null, 'unmatched remote profile maps to null');
    const none = bridge.resolveInventoryProfiles(manager, { activeName: 'ghost', profileNames: [] });
    assertEqual(none.activeProfileId, null, 'unknown active name resolves to null');
    const broken = bridge.resolveInventoryProfiles({ listSnapshots: () => { throw new Error('boom'); } }, inv);
    assertEqual(broken.activeProfileId, null, 'unreadable store degrades to zero matches');
  });

  // ─── mirrorToMac (compat alias) end to end ──────────────────────────────

  await test('mirrorToMac success: secret travels ONLY by temp file, argv clean, temp deleted', async () => {
    const manager = makeManagerStub(makeSnapshot());
    // Call order for the alias: inventory pre-sync, scp, install, use, verify.
    const fake = makeExecFake((call, idx) => {
      if (call.cmd === 'scp') return {};
      const remoteCmd = call.args[call.args.length - 1];
      if (remoteCmd.indexOf('__CWM_S1__') !== -1) {
        // Inventory sweep: Mac currently runs the same profile.
        return { stdout: 'work-laptop\n__CWM_S1__\nactive\nwork-laptop.credentials.json\n__CWM_S2__\n{"claudeAiOauth":{"accessToken":"at-MACLIVE","refreshToken":"rt-MACLIVE","expiresAt":1}}\n__CWM_S3__\n{"email":"bridge@example.com","accountUuid":"' + UUID_M + '"}\n' };
      }
      if (remoteCmd.indexOf('mkdir -p') !== -1) return {};
      if (remoteCmd.indexOf(' use ') !== -1) return { stdout: 'switched\n' };
      if (remoteCmd.indexOf('cmp -s') !== -1) return { stdout: 'work-laptop\nCWM_MATCH\n' };
      return {};
    });
    const r = await bridge.mirrorToMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.mirrored, true, JSON.stringify(r));
    assertNoSecretInArgv(fake.calls, 'mirrorToMac');
    const scpCall = fake.calls.find((c) => c.cmd === 'scp');
    assert(scpCall, 'scp ran');
    assert(scpCall.scpPayload && scpCall.scpPayload.indexOf(AT_SECRET) !== -1,
      'secret payload traveled inside the scp temp file');
    assert(scpCall.args[scpCall.args.length - 1].indexOf('/tmp/cwm-mirror-') !== -1,
      'random remote /tmp name');
    assert(!fs.existsSync(scpCall.scpSourcePath), 'local temp file deleted in finally');
    const useCall = fake.calls.find((c) => c.cmd === 'ssh' && c.args[c.args.length - 1].indexOf(' use ') !== -1);
    assert(useCall, 'claude-profile use step ran');
    assert(useCall.options.timeout >= 45000, 'use step gets the 45s floor');
    // Pre-use sync-back: the Mac-active profile (same slug) was matched and
    // its live token text handed to syncBackFromMac before the switch.
    assertEqual(manager.syncBacks.length, 1, 'pre-use sync-back ran once');
    assertEqual(manager.syncBacks[0].uuid, UUID_M, 'synced the matched Mac-active account');
    assert(manager.syncBacks[0].credText.indexOf('at-MACLIVE') !== -1, 'sync-back received the live Mac token text');
    // Lineage hint: a verified apply records the Mac-active account.
    assertEqual(manager.hints.length, 1, 'hint recorded exactly once');
    assertEqual(manager.hints[0], UUID_M, 'hint points at the applied account');
  });

  // ─── installProfileOnMac / applyProfileOnMac split ──────────────────────

  await test('installProfileOnMac: scp + install ONLY, no use, no verify, no hint', async () => {
    const manager = makeManagerStub(makeSnapshot());
    const fake = makeExecFake((call) => {
      if (call.cmd === 'scp') return {};
      if (call.args[call.args.length - 1].indexOf('mkdir -p') !== -1) return {};
      return {};
    });
    const r = await bridge.installProfileOnMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.installed, true, JSON.stringify(r));
    assertEqual(r.name, 'work-laptop', 'slug name returned');
    assertNoSecretInArgv(fake.calls, 'installProfileOnMac');
    const scpCall = fake.calls.find((c) => c.cmd === 'scp');
    assert(scpCall && scpCall.scpPayload && scpCall.scpPayload.indexOf(AT_SECRET) !== -1,
      'secret payload traveled inside the scp temp file');
    assert(!fs.existsSync(scpCall.scpSourcePath), 'local temp file deleted in finally');
    assert(!fake.calls.some((c) => c.cmd === 'ssh' && c.args[c.args.length - 1].indexOf(' use ') !== -1),
      'install NEVER activates (no claude-profile use)');
    assert(!fake.calls.some((c) => c.cmd === 'ssh' && c.args[c.args.length - 1].indexOf('__CWM_S1__') !== -1),
      'install performs no inventory sweep');
    assertEqual(manager.hints.length, 0, 'install never records a lineage hint');
    assertEqual(manager.syncBacks.length, 0, 'install never syncs back');
    // Gates shared with the apply path.
    const dead = await bridge.installProfileOnMac(makeManagerStub(makeSnapshot({ tokenState: 'needs_login' })), CFG, UUID_M, { execFileImpl: makeExecFake([]).impl });
    assertEqual(dead.installed, false);
    assertEqual(dead.error, 'MAC_TOKEN_DEAD');
  });

  await test('applyProfileOnMac: unmatched Mac-active profile warns and is never clobbered silently', async () => {
    const manager = makeManagerStub(makeSnapshot());
    const fake = makeExecFake((call) => {
      if (call.cmd === 'scp') return {};
      const remoteCmd = call.args[call.args.length - 1];
      if (remoteCmd.indexOf('__CWM_S1__') !== -1) {
        // Mac runs a profile that matches NO local snapshot.
        return { stdout: 'hand-made\n__CWM_S1__\nhand-made.credentials.json\n__CWM_S2__\n{"claudeAiOauth":{"accessToken":"at-MACLIVE-STRANGER"}}\n__CWM_S3__\n' };
      }
      if (remoteCmd.indexOf('mkdir -p') !== -1) return {};
      if (remoteCmd.indexOf(' use ') !== -1) return { stdout: 'switched\n' };
      if (remoteCmd.indexOf('cmp -s') !== -1) return { stdout: 'work-laptop\nCWM_MATCH\n' };
      return {};
    });
    const r = await bridge.applyProfileOnMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.mirrored, true, JSON.stringify(r));
    assertEqual(r.name, 'work-laptop');
    assert(r.warning && r.warning.indexOf('hand-made') !== -1, 'warning names the unknown Mac profile');
    assertEqual(manager.syncBacks.length, 0, 'no sync-back for an unmatched profile (identity unknown)');
    assertEqual(manager.hints.length, 1, 'hint still recorded for the verified apply');
    assertEqual(manager.hints[0], UUID_M);
  });

  await test('applyProfileOnMac: unreachable pre-sync degrades to a warning, apply proceeds', async () => {
    const manager = makeManagerStub(makeSnapshot());
    const fake = makeExecFake((call) => {
      if (call.cmd === 'scp') return {};
      const remoteCmd = call.args[call.args.length - 1];
      if (remoteCmd.indexOf('__CWM_S1__') !== -1) return { code: 255, stderr: 'no route' };
      if (remoteCmd.indexOf('mkdir -p') !== -1) return {};
      if (remoteCmd.indexOf(' use ') !== -1) return { stdout: 'switched\n' };
      if (remoteCmd.indexOf('cmp -s') !== -1) return { stdout: 'work-laptop\nCWM_MATCH\n' };
      return {};
    });
    const r = await bridge.applyProfileOnMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.mirrored, true, JSON.stringify(r));
    assert(r.warning && /could not read the mac state/i.test(r.warning), 'pre-sync failure surfaces as a warning');
    assertEqual(manager.syncBacks.length, 0);
    assertNoSecretInArgv(fake.calls, 'applyProfileOnMac');
  });

  await test('mirrorToMac gates: missing snapshot, dead token, no credentials', async () => {
    const missing = await bridge.mirrorToMac(makeManagerStub(null), CFG, UUID_M, { execFileImpl: makeExecFake([]).impl });
    assertEqual(missing.mirrored, false);
    assertEqual(missing.error, 'CRED_NOT_FOUND');
    const dead = await bridge.mirrorToMac(makeManagerStub(makeSnapshot({ tokenState: 'needs_login' })), CFG, UUID_M, { execFileImpl: makeExecFake([]).impl });
    assertEqual(dead.error, 'MAC_TOKEN_DEAD', 'never mirrors a dead token');
    const empty = await bridge.mirrorToMac(makeManagerStub(makeSnapshot({ credentials: null })), CFG, UUID_M, { execFileImpl: makeExecFake([]).impl });
    assertEqual(empty.error, 'CRED_NOT_FOUND');
  });

  await test('external bridge ownership blocks Mac install/apply before any process or temp-file write', async () => {
    const manager = makeManagerStub(makeSnapshot());
    manager.assertCredentialPoolWritable = () => {
      const err = new Error('Mac credential apply is disabled because credential-pool ownership is assigned to myrlin-bridge-gateway.');
      err.status = 409;
      err.code = 'CRED_POOL_EXTERNAL_OWNER';
      throw err;
    };
    const fake = makeExecFake([]);
    const install = await bridge.installProfileOnMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(install.installed, false);
    assertEqual(install.error, 'CRED_POOL_EXTERNAL_OWNER');
    assert(install.message.indexOf('myrlin-bridge-gateway') !== -1, 'owner is actionable');
    const apply = await bridge.applyProfileOnMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(apply.mirrored, false);
    assertEqual(apply.error, 'CRED_POOL_EXTERNAL_OWNER');
    assertEqual(fake.calls.length, 0, 'no ssh/scp process spawned');
    assertEqual(manager.syncBacks.length, 0, 'no remote sync-back attempted');
    assertEqual(manager.hints.length, 0, 'no ownership hint mutation');
  });

  await test('mirrorToMac maps scp failure to MAC_UNREACHABLE and stops', async () => {
    const manager = makeManagerStub(makeSnapshot());
    const fake = makeExecFake((call) => {
      if (call.cmd === 'scp') return { code: 1 };
      if (call.args[call.args.length - 1].indexOf('__CWM_S1__') !== -1) return { code: 255 };
      return {};
    });
    const r = await bridge.mirrorToMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.mirrored, false);
    assertEqual(r.error, 'MAC_UNREACHABLE');
    assert(!fake.calls.some((c) => c.cmd === 'ssh' && c.args[c.args.length - 1].indexOf('mkdir -p') !== -1),
      'install never attempted after a failed scp');
  });

  await test('mirrorToMac maps use exit 127 to MAC_TOOL_MISSING', async () => {
    const manager = makeManagerStub(makeSnapshot());
    const fake = makeExecFake((call) => {
      if (call.cmd === 'scp') return {};
      const remoteCmd = call.args[call.args.length - 1];
      if (remoteCmd.indexOf('__CWM_S1__') !== -1) return { code: 255 };
      if (remoteCmd.indexOf('mkdir -p') !== -1) return {};
      if (remoteCmd.indexOf(' use ') !== -1) return { code: 127, stderr: 'command not found' };
      return {};
    });
    const r = await bridge.mirrorToMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.error, 'MAC_TOOL_MISSING');
    assertEqual(manager.hints.length, 0, 'no hint recorded on a failed apply');
  });

  await test('mirrorToMac maps verify mismatch to MAC_VERIFY_FAILED', async () => {
    const manager = makeManagerStub(makeSnapshot());
    const fake = makeExecFake((call) => {
      if (call.cmd === 'scp') return {};
      const remoteCmd = call.args[call.args.length - 1];
      if (remoteCmd.indexOf('__CWM_S1__') !== -1) return { code: 255 };
      if (remoteCmd.indexOf('mkdir -p') !== -1) return {};
      if (remoteCmd.indexOf(' use ') !== -1) return { stdout: 'switched\n' };
      if (remoteCmd.indexOf('cmp -s') !== -1) return { stdout: 'other-profile\n' }; // wrong active, no CWM_MATCH
      return {};
    });
    const r = await bridge.mirrorToMac(manager, CFG, UUID_M, { execFileImpl: fake.impl });
    assertEqual(r.error, 'MAC_VERIFY_FAILED');
    assertEqual(manager.hints.length, 0, 'no hint on a failed verify');
  });

  console.log('  ' + '─'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + ((err && err.stack) || err));
  process.exit(1);
});
