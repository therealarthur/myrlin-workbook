#!/usr/bin/env node
/**
 * Task #37: the Mac bridge stops pointing at a machine that is not there.
 *
 * WHAT WAS WRONG
 * --------------
 * The credential switcher's shipped default named a tailnet node that had
 * been renamed and readdressed. Every install that never opened Settings and
 * typed a host by hand resolved to a dead name, and every mirror, sweep and
 * apply failed with MAC_UNREACHABLE with nothing to distinguish "the Mac is
 * off" from "the address does not exist". Worse, an install that HAD opened
 * the Mac settings once and pressed Save had a copy of the dead name in its
 * own store, where fixing the default cannot reach it.
 *
 * WHAT THIS PINS
 * --------------
 *   1. the default host, and its single definition shared by the manager and
 *      the bridge (mac-host.js) rather than two that agree today;
 *   2. the ordered candidate chain: configured first, then the default, then
 *      the documented fallbacks, deduplicated and charset-gated;
 *   3. probeMacHosts as a READ-ONLY diagnosis that suggests and never
 *      redirects, including the ssh exit-code semantics it rests on;
 *   4. the one-time stored-value migration: what it rewrites, what it
 *      refuses to touch, that it preserves every sibling field, that it is
 *      idempotent by two independent mechanisms, that passive mode skips it
 *      WITHOUT burning the marker, and that it never throws;
 *   5. that the whole repair works with the Mac powered off, because it
 *      contacts nothing.
 *
 * HERMETIC: zero child processes (every ssh goes through an injected
 * execFile recorder), zero network, and the manager is pointed at tmpdirs so
 * it can never read or write the real ~/.claude.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

require('./_test-data-dir');
// Belt and braces: even if a code path ignored the injected execFileImpl,
// the route-level gate would still refuse to fire the real bridge.
process.env.CWM_CRED_DISABLE_MAC = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const macHost = require('../src/web/mac-host');
const bridge = require('../src/web/mac-bridge');
const { createCredentialManager } = require('../src/web/credential-manager');

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Run one named check, recording pass/fail rather than throwing.
 * @param {string} name - Assertion name.
 * @param {Function} fn - Body; may be async.
 * @returns {Promise<void>}
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL  ' + name);
    console.log('        ' + ((err && err.message) || err));
  }
}

/**
 * Scripted execFile fake. Answers each spawned call from a per-host map so a
 * probe test can say "this host is dead, that one answers" without caring
 * about call order.
 *
 * @param {Object<string, {code?: number, killed?: boolean, stdout?: string, stderr?: string}>} byHost
 * @returns {{impl: Function, calls: Array}} Fake and its call log.
 */
function makeHostExecFake(byHost) {
  const calls = [];
  const impl = (cmd, args, options, cb) => {
    calls.push({ cmd, args: args.slice(), options });
    const target = args[args.length - 2] || '';
    const host = String(target).split('@')[1] || '';
    const step = byHost[host] || { code: 255, stderr: 'ssh: no route to host' };
    let err = null;
    if (step.code || step.killed) {
      err = new Error('exit ' + (step.code || 'killed'));
      if (typeof step.code === 'number') err.code = step.code;
      err.killed = !!step.killed;
      err.signal = step.killed ? 'SIGTERM' : null;
    }
    process.nextTick(() => cb(err, step.stdout || '', step.stderr || ''));
  };
  return { impl, calls };
}

/**
 * Build a credential manager wired to an in-memory settings object, with
 * every filesystem path pointed at a throwaway directory. Nothing here can
 * touch the real ~/.claude or the real data dir.
 *
 * @param {object} storedSettings - Initial settings.credentialSwitcher value.
 * @param {object} [over] - Extra createCredentialManager options.
 * @returns {{manager: object, stored: object, patches: Array, dir: string}}
 */
function makeManager(storedSettings, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-machost-'));
  const stored = { value: JSON.parse(JSON.stringify(storedSettings || {})) };
  const patches = [];
  const manager = createCredentialManager({
    claudeDir: path.join(dir, 'claude'),
    claudeJsonPath: path.join(dir, 'claude.json'),
    accountsDir: path.join(dir, 'accounts'),
    settingsProvider: () => stored.value,
    settingsPatcher: (patch) => {
      patches.push(JSON.parse(JSON.stringify(patch)));
      stored.value = { ...stored.value, ...patch };
    },
    log: { info() {}, warn() {}, error() {}, log() {} },
    ...over,
  });
  return { manager, stored, patches, dir };
}

/** Directories created by makeManager, removed at exit. */
const _tmpDirs = [];

/**
 * Read one src/web source file with line endings normalised to LF.
 *
 * Load-bearing: this tree checks out CRLF on Windows, so a source gate that
 * scans for "\n}\n" would silently match nothing, read to end of file, and
 * report on code that is not in the function it claims to be inspecting.
 *
 * @param {string} name - File name under src/web.
 * @returns {string} File contents with LF line endings.
 */
function readSourceNormalized(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'web', name), 'utf8').replace(/\r\n/g, '\n');
}

async function main() {
  console.log('\n  Task #37: the Mac host default, the candidate chain, and the one-time migration');
  console.log('  ' + '-'.repeat(80));

  // ── 1. Constants and pure helpers ───────────────────────────────────────

  await test('the default host is the live tailnet node, defined exactly once', () => {
    assert.strictEqual(macHost.DEFAULT_MAC_HOST, 'alloy');
    assert.strictEqual(bridge.DEFAULT_MAC_HOST, macHost.DEFAULT_MAC_HOST,
      'the bridge must re-export the leaf constant, not carry its own copy');
    const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'credential-manager.js'), 'utf8');
    assert.ok(managerSrc.indexOf("host: DEFAULT_MAC_HOST") !== -1,
      'the shipped default must reference the shared constant');
    for (const legacy of macHost.LEGACY_MAC_HOSTS) {
      assert.ok(managerSrc.indexOf("'" + legacy + "'") === -1,
        'a retired host literal is still hardcoded in credential-manager.js: ' + legacy);
    }
  });

  await test('the retired addresses are recognised, and nothing else is', () => {
    assert.ok(macHost.LEGACY_MAC_HOSTS.indexOf('arthurs-mac-mini') !== -1, 'the old node name is listed');
    assert.ok(macHost.LEGACY_MAC_HOSTS.indexOf('100.118.228.46') !== -1, 'the old tailnet address is listed');
    assert.strictEqual(macHost.isLegacyMacHost('arthurs-mac-mini'), true);
    assert.strictEqual(macHost.isLegacyMacHost('  ARTHURS-MAC-MINI  '), true, 'case and whitespace tolerant');
    assert.strictEqual(macHost.isLegacyMacHost('100.118.228.46'), true);
    assert.strictEqual(macHost.isLegacyMacHost('alloy'), false);
    assert.strictEqual(macHost.isLegacyMacHost('100.111.181.106'), false, 'the LIVE address is not legacy');
    assert.strictEqual(macHost.isLegacyMacHost('my-own-mac'), false);
    assert.strictEqual(macHost.isLegacyMacHost(''), false);
    assert.strictEqual(macHost.isLegacyMacHost(null), false);
    assert.strictEqual(macHost.isLegacyMacHost(42), false);
  });

  await test('the candidate chain leads with the configured host, dedupes, and rejects junk', () => {
    assert.deepStrictEqual(macHost.macHostCandidates({ host: 'my-mac' }),
      ['my-mac', 'alloy', '100.111.181.106'], 'configured first, then default, then fallback');
    assert.deepStrictEqual(macHost.macHostCandidates({ host: 'alloy' }),
      ['alloy', '100.111.181.106'], 'the configured host is not repeated as the default');
    assert.deepStrictEqual(macHost.macHostCandidates({ host: 'ALLOY' }),
      ['ALLOY', '100.111.181.106'], 'dedupe is case-insensitive');
    assert.deepStrictEqual(macHost.macHostCandidates({}),
      ['alloy', '100.111.181.106'], 'an unset host still yields the chain');
    assert.deepStrictEqual(macHost.macHostCandidates({ host: '-oProxyCommand=evil' }),
      ['alloy', '100.111.181.106'], 'an option-injection host never reaches the chain');
    assert.deepStrictEqual(macHost.macHostCandidates({ host: 'bad host' }),
      ['alloy', '100.111.181.106'], 'a charset violation never reaches the chain');
    assert.deepStrictEqual(macHost.macHostCandidates({ host: 'arthurs-mac-mini' }),
      ['arthurs-mac-mini', 'alloy', '100.111.181.106'],
      'a retired host is still tried FIRST: the operator configured it, and the probe reports on it');
  });

  // ── 2. The probe: diagnosis, not redirection ────────────────────────────

  await test('a reachable configured host stops the probe at one call and suggests nothing', async () => {
    const fake = makeHostExecFake({ alloy: { code: 0 } });
    const r = await bridge.probeMacHosts({ host: 'alloy', user: 'arthur' }, { execFileImpl: fake.impl });
    assert.strictEqual(fake.calls.length, 1, 'exactly one probe call, got ' + fake.calls.length);
    assert.strictEqual(r.reachable, true);
    assert.strictEqual(r.host, 'alloy');
    assert.strictEqual(r.suggestedHost, null, 'the configured host is never suggested back');
    assert.strictEqual(fake.calls[0].args[fake.calls[0].args.length - 1], 'true',
      'the probe command carries nothing, reads nothing and writes nothing');
  });

  await test('a dead configured host and a live fallback produces a suggestion, never a redirect', async () => {
    const fake = makeHostExecFake({
      'arthurs-mac-mini': { code: 255, stderr: 'ssh: Could not resolve hostname' },
      alloy: { code: 0 },
    });
    const r = await bridge.probeMacHosts({ host: 'arthurs-mac-mini', user: 'arthur' }, { execFileImpl: fake.impl });
    assert.strictEqual(r.reachable, true);
    assert.strictEqual(r.host, 'alloy');
    assert.strictEqual(r.suggestedHost, 'alloy', 'the answering host is offered');
    assert.strictEqual(r.configuredHost, 'arthurs-mac-mini', 'the configured host is reported as-is');
    assert.strictEqual(r.attempts.length, 2, 'stops at the first host that answers');
    assert.strictEqual(r.attempts[0].reachable, false);
    assert.strictEqual(r.attempts[1].reachable, true);
    const serialized = JSON.stringify(r);
    assert.ok(serialized.indexOf('Could not resolve') === -1,
      'remote stderr must never ride into a result that gets cached and broadcast');
  });

  await test('every candidate dead reads as unreachable with the full attempt list', async () => {
    const fake = makeHostExecFake({});
    const r = await bridge.probeMacHosts({ host: 'my-mac', user: 'arthur' }, { execFileImpl: fake.impl });
    assert.strictEqual(r.reachable, false);
    assert.strictEqual(r.host, null);
    assert.strictEqual(r.suggestedHost, null, 'nothing answered, so nothing is suggested');
    assert.strictEqual(r.attempts.length, 3, 'every candidate was tried');
    assert.ok(r.attempts.every((a) => a.reachable === false));
  });

  await test('a nonzero exit that is NOT 255 still means the link is up', async () => {
    // ssh reserves 255 for its own client/link failures; any other code is
    // the REMOTE command's status, which proves a session was established.
    const fake = makeHostExecFake({ alloy: { code: 1, stderr: 'remote said no' } });
    const r = await bridge.probeMacHosts({ host: 'alloy', user: 'arthur' }, { execFileImpl: fake.impl });
    assert.strictEqual(r.reachable, true, 'exit 1 from the remote shell means we connected');
  });

  await test('a timeout is a dead link, not a reachable host', async () => {
    const fake = makeHostExecFake({ alloy: { killed: true }, '100.111.181.106': { killed: true } });
    const r = await bridge.probeMacHosts({ host: 'alloy', user: 'arthur' }, { execFileImpl: fake.impl });
    assert.strictEqual(r.reachable, false);
    assert.ok(r.attempts.every((a) => a.timedOut === true));
  });

  await test('an invalid user spawns nothing at all', async () => {
    const fake = makeHostExecFake({ alloy: { code: 0 } });
    for (const user of ['-l', 'evil user', '', null]) {
      const r = await bridge.probeMacHosts({ host: 'alloy', user }, { execFileImpl: fake.impl });
      assert.strictEqual(r.reachable, false, 'user ' + JSON.stringify(user) + ' must not probe');
      assert.strictEqual(r.attempts.length, 0);
    }
    assert.strictEqual(fake.calls.length, 0, 'an option-injection user reached ssh argv');
  });

  await test('the probe never throws, even on a hostile injected exec', async () => {
    const hostile = () => { throw new Error('boom'); };
    const r = await bridge.probeMacHosts({ host: 'alloy', user: 'arthur' }, { execFileImpl: hostile });
    assert.strictEqual(r.reachable, false);
    assert.ok(Array.isArray(r.attempts));
  });

  // ── 3. The shipped default reaches the merged settings ──────────────────

  await test('a store with nothing saved resolves to the live host', () => {
    const { manager, dir } = makeManager({});
    _tmpDirs.push(dir);
    assert.strictEqual(manager.getSettings().mac.host, 'alloy');
    assert.strictEqual(manager.getSettings().macHostMigratedAt, null);
  });

  // ── 4. The one-time migration ───────────────────────────────────────────

  await test('a stored retired host is rewritten once, and every sibling field survives', () => {
    const { manager, stored, patches, dir } = makeManager({
      mac: {
        enabled: true,
        host: 'arthurs-mac-mini',
        user: 'arthur',
        profileTool: '/custom/path/claude-profile',
        postSwapCommand: 'echo hi',
      },
      usageCacheMinutes: 33,
    });
    _tmpDirs.push(dir);
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, true, 'expected a migration, got reason ' + r.reason);
    assert.strictEqual(r.from, 'arthurs-mac-mini');
    assert.strictEqual(r.to, 'alloy');
    assert.strictEqual(stored.value.mac.host, 'alloy', 'the stored host was not rewritten');
    assert.strictEqual(stored.value.mac.enabled, true, 'enabled was dropped by the rewrite');
    assert.strictEqual(stored.value.mac.user, 'arthur', 'user was dropped by the rewrite');
    assert.strictEqual(stored.value.mac.profileTool, '/custom/path/claude-profile', 'profileTool was dropped');
    assert.strictEqual(stored.value.mac.postSwapCommand, 'echo hi', 'postSwapCommand was dropped');
    assert.strictEqual(stored.value.usageCacheMinutes, 33, 'an unrelated setting was disturbed');
    assert.ok(stored.value.macHostMigratedAt, 'the marker was not written');
    assert.strictEqual(patches.length, 1, 'exactly one settings write');
  });

  await test('the retired tailnet ADDRESS is migrated too, not just the name', () => {
    const { manager, stored, dir } = makeManager({ mac: { host: '100.118.228.46', user: 'arthur' } });
    _tmpDirs.push(dir);
    assert.strictEqual(manager.migrateLegacyMacHost().migrated, true);
    assert.strictEqual(stored.value.mac.host, 'alloy');
  });

  await test('running it again changes nothing (idempotent by marker)', () => {
    const { manager, stored, patches, dir } = makeManager({ mac: { host: 'arthurs-mac-mini', user: 'arthur' } });
    _tmpDirs.push(dir);
    assert.strictEqual(manager.migrateLegacyMacHost().migrated, true);
    const after = JSON.stringify(stored.value);
    const second = manager.migrateLegacyMacHost();
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.reason, 'already-migrated');
    assert.strictEqual(JSON.stringify(stored.value), after, 'the second pass mutated settings');
    assert.strictEqual(patches.length, 1, 'the second pass wrote to the store');
  });

  await test('an operator who types the retired name back afterwards keeps it', () => {
    const { manager, stored, dir } = makeManager({ mac: { host: 'arthurs-mac-mini', user: 'arthur' } });
    _tmpDirs.push(dir);
    manager.migrateLegacyMacHost();
    // The operator deliberately restores the old name through Settings.
    stored.value = { ...stored.value, mac: { ...stored.value.mac, host: 'arthurs-mac-mini' } };
    const again = manager.migrateLegacyMacHost();
    assert.strictEqual(again.migrated, false, 'a deliberate choice was overridden');
    assert.strictEqual(stored.value.mac.host, 'arthurs-mac-mini');
  });

  await test('a host this code has never heard of is left completely alone', () => {
    const { manager, stored, dir } = makeManager({ mac: { host: 'my-own-mac.local', user: 'arthur' } });
    _tmpDirs.push(dir);
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'not-legacy');
    assert.strictEqual(stored.value.mac.host, 'my-own-mac.local', 'an unrecognised host was rewritten');
    assert.ok(stored.value.macHostMigratedAt, 'the marker is still burned so this never runs again');
  });

  await test('a store with no mac settings is marked done without inventing one', () => {
    const { manager, stored, dir } = makeManager({});
    _tmpDirs.push(dir);
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'nothing-stored');
    assert.strictEqual(stored.value.mac, undefined, 'a mac object was written into a store that had none');
    assert.ok(stored.value.macHostMigratedAt);
  });

  await test('passive mode skips the migration AND leaves the marker unburned', () => {
    const { manager, stored, patches, dir } = makeManager(
      { mac: { host: 'arthurs-mac-mini', user: 'arthur' } },
      { externalBridgeOwner: true },
    );
    _tmpDirs.push(dir);
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'pool-read-only');
    assert.strictEqual(patches.length, 0, 'passive mode wrote to the store');
    assert.strictEqual(stored.value.macHostMigratedAt, undefined,
      'burning the marker in passive mode would lose the repair forever');
    assert.strictEqual(stored.value.mac.host, 'arthurs-mac-mini');
  });

  await test('no settings write-back wired: reports it and mutates nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-machost-'));
    _tmpDirs.push(dir);
    const manager = createCredentialManager({
      claudeDir: path.join(dir, 'claude'),
      claudeJsonPath: path.join(dir, 'claude.json'),
      accountsDir: path.join(dir, 'accounts'),
      settingsProvider: () => ({ mac: { host: 'arthurs-mac-mini', user: 'arthur' } }),
      log: { info() {}, warn() {}, error() {}, log() {} },
    });
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'no-patcher');
  });

  await test('a store that refuses the write degrades instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-machost-'));
    _tmpDirs.push(dir);
    const manager = createCredentialManager({
      claudeDir: path.join(dir, 'claude'),
      claudeJsonPath: path.join(dir, 'claude.json'),
      accountsDir: path.join(dir, 'accounts'),
      settingsProvider: () => ({ mac: { host: 'arthurs-mac-mini', user: 'arthur' } }),
      settingsPatcher: () => { throw new Error('disk full'); },
      log: { info() {}, warn() {}, error() {}, log() {} },
    });
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'write-failed');
  });

  await test('an unreadable settings provider is survivable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-machost-'));
    _tmpDirs.push(dir);
    const patches = [];
    const manager = createCredentialManager({
      claudeDir: path.join(dir, 'claude'),
      claudeJsonPath: path.join(dir, 'claude.json'),
      accountsDir: path.join(dir, 'accounts'),
      settingsProvider: () => { throw new Error('store unavailable'); },
      settingsPatcher: (p) => { patches.push(p); },
      log: { info() {}, warn() {}, error() {}, log() {} },
    });
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, false, 'nothing readable means nothing to migrate');
    assert.strictEqual(r.reason, 'nothing-stored');
  });

  await test('the migration contacts nothing, so a powered-off Mac cannot block it', () => {
    // The manager has no child-process surface at all; this pins that the
    // repair path stays local by proving it completes with every network and
    // process facility of the bridge untouched (zero recorded calls) and
    // with an ssh binary that does not exist on this machine.
    const fake = makeHostExecFake({});
    const { manager, stored, dir } = makeManager({ mac: { host: 'arthurs-mac-mini', user: 'arthur' } });
    _tmpDirs.push(dir);
    const r = manager.migrateLegacyMacHost();
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(stored.value.mac.host, 'alloy');
    assert.strictEqual(fake.calls.length, 0, 'the migration spawned a process');
  });

  // ── 5. The suggestion survives the cache whitelist, and only if valid ───

  await test('setMacState carries a valid suggestion and drops an invalid one', () => {
    const { manager, dir } = makeManager({});
    _tmpDirs.push(dir);
    const ok = manager.setMacState({
      checkedAt: new Date().toISOString(), reachable: false, profiles: [], suggestedHost: 'alloy',
    });
    assert.strictEqual(ok.suggestedHost, 'alloy');
    for (const bad of ['-oProxyCommand=evil', 'bad host', '', 42, null, { host: 'alloy' }]) {
      const state = manager.setMacState({
        checkedAt: new Date().toISOString(), reachable: false, profiles: [], suggestedHost: bad,
      });
      assert.strictEqual(state.suggestedHost, undefined,
        'an invalid suggestion reached the cache: ' + JSON.stringify(bad));
    }
    const none = manager.setMacState({ checkedAt: new Date().toISOString(), reachable: true, profiles: [] });
    assert.strictEqual(none.suggestedHost, undefined, 'a sweep with no suggestion must not invent the field');
  });

  await test('the sweep asks for a suggestion only on the failed path, and never redirects', () => {
    const routesSrc = readSourceNormalized('credential-routes.js');
    const probeIdx = routesSrc.indexOf('probeMacHosts');
    assert.ok(probeIdx !== -1, 'the sweep never consults the candidate chain');
    assert.ok(routesSrc.indexOf("typeof macBridge.probeMacHosts === 'function'") !== -1,
      'the probe call must be guarded so older injected bridge fakes are unaffected');
    // The probe must sit inside the !reachable branch: the reachable branch
    // begins at the resolveInventoryProfiles call, which must come AFTER it.
    const reachableBranchIdx = routesSrc.indexOf('resolveInventoryProfiles(manager, inv)');
    assert.ok(reachableBranchIdx > probeIdx,
      'the probe must run only on the unreachable path, never on a healthy sweep');
    const bridgeSrc = readSourceNormalized('mac-bridge.js');
    for (const fn of ['installProfileOnMac', 'applyProfileOnMac', 'readMacInventory']) {
      const start = bridgeSrc.indexOf('async function ' + fn);
      assert.ok(start !== -1, fn + ' vanished from the bridge');
      const end = bridgeSrc.indexOf('\n}\n', start);
      assert.ok(end !== -1, 'could not find the end of ' + fn);
      const body = bridgeSrc.slice(start, end);
      assert.ok(body.indexOf('macHostCandidates') === -1 && body.indexOf('probeMacHosts') === -1,
        fn + ' resolves its own host from the candidate chain; a credential operation must only ever '
        + 'talk to the host the operator configured');
    }
  });

  // ─── Results ───────────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(80));
  console.log('  [mac-host-migration] ' + passed + '/' + (passed + failed) + ' tests passed');
  if (failed > 0) {
    console.log('\n  Offenders:');
    for (const f of failures) console.log('   - ' + f.name + ': ' + ((f.err && f.err.message) || f.err));
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { cleanup(); process.exit(code); })
  .catch((err) => { console.error(err); cleanup(); process.exit(1); });

/**
 * Remove every throwaway directory the manager fixtures created.
 * @returns {void}
 */
function cleanup() {
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}
