#!/usr/bin/env node
/**
 * seed-workspace.js: seeds the workspace part of the sandbox Workbook for
 * the end to end run (BUILD-CONTRACT 3.7.1 item 8, 6.1).
 *
 * What: after B2's seed-sandbox.js wrote the transcript fixtures and their
 * manifest (<data>/e2e-fixtures.json), this writes, through Workbook's own
 * store module, the computer name "Sandbox" (settings.serverName), a folder
 * "Work" with the projects "Myrlin iOS" and "Workbook", and the tracked
 * sessions "E2E Claude", "E2E Codex" and "E2E Migrate" bound to fixture
 * transcripts; then layout.json with the tab groups "Main" and "Research"
 * (revision 1, the layout store's format); then the accounts fixture
 * <data>/accounts-fixture.json (named by CWM_MOBILE_ACCOUNTS_FIXTURE) from
 * test/mobile/fixtures/accounts/sandbox-accounts.json with its times moved
 * to now and codexRunning true.
 *
 * Why: the E2E flows rename, move, search, swap and migrate these exact
 * names, and none of that may touch a real Workbook. The script refuses a
 * data folder that is Workbook's default (~/.myrlin) or the in repo state
 * folder, and it writes nothing outside the data folder it is given.
 *
 * Usage: node test/mobile/e2e/seed-workspace.js <home> <data> <codexHome> <state>
 *   (or the flags home, data, codex-home, state with two leading dashes;
 *   the same arguments seed-sandbox.js receives and passes on)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The repository root (test/mobile/e2e/../../..). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
/** The accounts fixture template (BUILD-CONTRACT 3.2: fixtures/accounts/ is B3's). */
const ACCOUNTS_TEMPLATE = path.join(__dirname, '..', 'fixtures', 'accounts', 'sandbox-accounts.json');
/** The file name CWM_MOBILE_ACCOUNTS_FIXTURE names in the sandbox (BUILD-CONTRACT 6.1). */
const ACCOUNTS_FIXTURE_NAME = 'accounts-fixture.json';
/** The computer name the phone shows for the sandbox (BUILD-CONTRACT 6.1). */
const COMPUTER_NAME = 'Sandbox';
/** The first layout revision the seed writes (PROTOCOL.md 3.9). */
const FIRST_LAYOUT_REVISION = 1;
/** Tab group ids of the seeded layout (the desktop's own id style, app.js). */
const GROUP_MAIN = 'tg_main';
const GROUP_RESEARCH = 'tg_research';

/**
 * Arguments as positional or named values (seed-sandbox.js's rule).
 *
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{home: string, data: string, codexHome: string, state: string}}
 */
function parseArgs(argv) {
  const named = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) named[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { home: named.home || pos[0], data: named.data || pos[1], codexHome: named['codex-home'] || pos[2], state: named.state || pos[3] };
}

/**
 * Why a data folder must not be seeded, or null when it may.
 *
 * @param {string} data - Candidate data folder.
 * @returns {string|null}
 */
function refusal(data) {
  if (!data) return 'no data folder given';
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const d = norm(data);
  if (d === norm(path.join(os.homedir(), '.myrlin'))) return 'the data folder is Workbook\'s default (~/.myrlin); the seed only writes sandboxes';
  if (d === norm(path.join(REPO_ROOT, 'state'))) return 'the data folder is the in repo state folder';
  return null;
}

/**
 * A deep copy of a value with every epoch millisecond field (names ending in
 * AtMs, plus asOfMs) moved by delta.
 *
 * @param {*} v - Value.
 * @param {number} delta - Milliseconds to add.
 * @returns {*}
 */
function shiftTimes(v, delta) {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '_comment') continue;
      out[k] = (/AtMs$/.test(k) || k === 'asOfMs') && Number.isFinite(x) ? x + delta : shiftTimes(x, delta);
    }
    return out;
  }
  return v;
}

/**
 * The accounts fixture with its times moved so generatedAtMs is nowMs.
 *
 * @param {number} nowMs - The seed time.
 * @returns {object} {codexRunning, codexProcesses, accounts: AccountsSnapshot}
 */
function accountsFixture(nowMs) {
  const raw = JSON.parse(fs.readFileSync(ACCOUNTS_TEMPLATE, 'utf8'));
  return shiftTimes(raw, nowMs - raw.accounts.generatedAtMs);
}

/**
 * The seeded desktop layout (layout.json, app.js:25774-25838): "Main" with
 * the three E2E sessions as terminal panes, "Research" with the search
 * fixture as a read only mirror pane.
 *
 * @param {object} o - {claude: {sessionId, name}, codex: {...}, migrate: {...}, search: {providerSessionId}|null}
 * @returns {object}
 */
function layoutFor(o) {
  const pane = (slot, s, provider) => ({ slot, sessionId: s.id, sessionName: s.name, provider, spawnOpts: {} });
  const research = o.search ? [{ slot: 0, viewType: 'mirror', viewData: { provider: 'claude', providerSessionId: o.search.providerSessionId } }] : []; // gsd:provider-literal-allowed (sandbox fixture)
  return {
    tabGroups: [
      { id: GROUP_MAIN, name: 'Main', panes: [pane(0, o.claude, 'claude'), pane(1, o.codex, 'codex'), pane(2, o.migrate, 'claude')] }, // gsd:provider-literal-allowed (sandbox fixture)
      { id: GROUP_RESEARCH, name: 'Research', panes: research },
    ],
    tabFolders: [],
    activeGroupId: GROUP_MAIN,
    revision: FIRST_LAYOUT_REVISION,
  };
}

/**
 * Seed a data folder. Loads Workbook's store with CWM_DATA_DIR set to it,
 * so the store writes its own format.
 *
 * @param {{home: string, data: string}} a - Folders.
 * @param {number} [nowMs] - The seed time.
 * @returns {object} What was seeded (ids), for tests.
 */
function seed(a, nowMs) {
  const why = refusal(a.data);
  if (why) throw new Error('seed-workspace: refusing: ' + why);
  const manifestFile = path.join(a.data, 'e2e-fixtures.json');
  if (!fs.existsSync(manifestFile)) throw new Error('seed-workspace: run seed-sandbox.js first (no e2e-fixtures.json)');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const claudeFix = (key) => (manifest.claude || []).find((c) => c.key === key) || null;
  const codexFix = (key) => (manifest.codex || []).find((c) => c.key === key) || null;
  const e2eClaude = claudeFix('e2eClaude');
  const e2eMigrate = claudeFix('e2eMigrate');
  const e2eCodex = codexFix('e2eCodex');
  const search = claudeFix('search');
  if (!e2eClaude || !e2eMigrate || !e2eCodex) throw new Error('seed-workspace: the manifest lacks an E2E fixture');

  process.env.CWM_DATA_DIR = path.resolve(a.data);
  const { getStore } = require(path.join(REPO_ROOT, 'src', 'state', 'store'));
  const store = getStore();
  store.updateSettings({ serverName: COMPUTER_NAME });
  const folder = store.createGroup({ name: 'Work' });
  const ios = store.createWorkspace({ name: 'Myrlin iOS' });
  const wb = store.createWorkspace({ name: 'Workbook' });
  store.moveWorkspaceToGroup(ios.id, folder.id);
  store.moveWorkspaceToGroup(wb.id, folder.id);
  const tracked = (ws, fix, name, provider, upstream) => {
    const s = store.createSession({ name, workspaceId: ws.id, workingDir: fix.cwd, command: provider, resumeSessionId: upstream });
    store.updateSession(s.id, { provider });
    return store.getSession(s.id);
  };
  const cl = tracked(ios, e2eClaude, 'E2E Claude', 'claude', e2eClaude.sessionId); // gsd:provider-literal-allowed (sandbox fixture)
  const mg = tracked(ios, e2eMigrate, 'E2E Migrate', 'claude', e2eMigrate.sessionId); // gsd:provider-literal-allowed (sandbox fixture)
  const cx = tracked(wb, e2eCodex, 'E2E Codex', 'codex', e2eCodex.threadId); // gsd:provider-literal-allowed (sandbox fixture)
  if (store._saveTimer) { clearTimeout(store._saveTimer); store._saveTimer = null; }
  store.save();

  const layout = layoutFor({ claude: cl, codex: cx, migrate: mg, search: search ? { providerSessionId: search.sessionId } : null });
  fs.writeFileSync(path.join(a.data, 'layout.json'), JSON.stringify(layout, null, 2));
  const fixture = accountsFixture(nowMs || Date.now());
  const fixtureFile = path.join(a.data, ACCOUNTS_FIXTURE_NAME);
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));
  return { folderId: folder.id, projects: { ios: ios.id, workbook: wb.id }, sessions: { claude: cl.id, migrate: mg.id, codex: cx.id }, layout, fixtureFile };
}

/** Command line entry. */
function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const k of ['home', 'data']) if (!a[k]) { console.error('seed-workspace: missing ' + k); process.exit(2); }
  try {
    const out = seed(a);
    console.log('seed-workspace: computer ' + COMPUTER_NAME + ', 2 projects in folder Work, 3 tracked sessions, tab groups Main and Research, accounts fixture ' + path.basename(out.fixtureFile));
    process.exit(0);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { seed, accountsFixture, layoutFor, shiftTimes, refusal, parseArgs, ACCOUNTS_FIXTURE_NAME, COMPUTER_NAME, GROUP_MAIN, GROUP_RESEARCH };
