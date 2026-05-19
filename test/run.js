#!/usr/bin/env node
/**
 * Test suite for Claude Workspace Manager
 * Runs unit tests for store, core logic, and module integration.
 */

const path = require('path');

// Sandbox the store into a fresh tmpdir before any module reads CWM_DATA_DIR.
// See test/_test-data-dir.js. Previous implementation pointed at ./state/ which
// is the PRODUCTION dir (was hidden behind the misleading "test isolation" comment)
// and wiped real user data on 2026-05-11.
require('./_test-data-dir');

// Simple test framework
let passed = 0;
let failed = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n  \x1b[1m${name}\x1b[0m`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`    \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotNull(val, msg) {
  if (val == null) throw new Error(msg || 'Expected non-null value');
}

// ──────────────────────────────────────────────────────
// Clean state between tests. Points at the SAME directory the store reads
// from (the sandbox tmpdir created by ./_test-data-dir, set in CWM_DATA_DIR).
// If we pointed at ./state/ here, cleanState() would delete files the store
// doesn't read, every test would inherit the previous test's data, and
// ~5 store-CRUD tests would fail with "Expected 1, got 11" style errors.
const fs = require('fs');
const stateDir = process.env.CWM_DATA_DIR || path.join(__dirname, '..', 'state');
const stateFile = path.join(stateDir, 'workspaces.json');
const backupFile = path.join(stateDir, 'workspaces.backup.json');
const backupsDir = path.join(stateDir, 'backups');

// Legacy: the save/restore-prod block existed when tests ran against the
// real ./state/ dir. The sandbox now isolates them, but the block is kept
// as a no-op safety net for anyone running with CWM_TEST_ALLOW_PROD_DIR=1.
const savedStateFile = stateFile + '.test-save';
const savedBackupFile = backupFile + '.test-save';
if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, savedStateFile);
if (fs.existsSync(backupFile)) fs.copyFileSync(backupFile, savedBackupFile);

/**
 * Clean state files and reset module cache so each test gets a fresh Store.
 * Also cleans timestamped backups so tests don't pollute production backups.
 */
function cleanState() {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
  // Clean timestamped backups from tests
  if (fs.existsSync(backupsDir)) {
    for (const f of fs.readdirSync(backupsDir)) {
      try { fs.unlinkSync(path.join(backupsDir, f)); } catch (_) {}
    }
  }
  // Reset the singleton by clearing module cache
  delete require.cache[require.resolve('../src/state/store')];
}

/**
 * Restore production state files after tests complete.
 */
function restoreState() {
  // Clean test artifacts first
  if (fs.existsSync(stateFile)) try { fs.unlinkSync(stateFile); } catch (_) {}
  if (fs.existsSync(backupFile)) try { fs.unlinkSync(backupFile); } catch (_) {}
  if (fs.existsSync(backupsDir)) {
    for (const f of fs.readdirSync(backupsDir)) {
      try { fs.unlinkSync(path.join(backupsDir, f)); } catch (_) {}
    }
  }
  // Restore originals
  if (fs.existsSync(savedStateFile)) {
    fs.renameSync(savedStateFile, stateFile);
  }
  if (fs.existsSync(savedBackupFile)) {
    fs.renameSync(savedBackupFile, backupFile);
  }
}

// Clean for first test
cleanState();

// Must require AFTER cleaning state
const { Store } = require('../src/state/store');

/** Helper: get a clean store for each test */
function freshStore() {
  cleanState();
  const { Store: S } = require('../src/state/store');
  return new S().init();
}

console.log('\n\x1b[1m\x1b[36m  Claude Workspace Manager - Test Suite\x1b[0m');
console.log('  ' + '─'.repeat(42));

// ──────────────────────────────────────────────────────
suite('Store - Initialization');

test('creates a new store with default state', () => {
  const store = freshStore();
  assertNotNull(store.state);
  assertEqual(store.state.version, 2);
  assertEqual(Object.keys(store.workspaces).length, 0);
  assertEqual(Object.keys(store.sessions).length, 0);
  assert(store.settings.autoRecover === true);
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Store - Workspace CRUD');

test('creates a workspace with name and color', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'Test Workspace', color: 'cyan' });
  assertNotNull(ws);
  assertEqual(ws.name, 'Test Workspace');
  assertEqual(ws.color, 'cyan');
  assertNotNull(ws.id);
  assertNotNull(ws.createdAt);
  store.destroy();
});

test('auto-activates first workspace', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'First' });
  assertEqual(store.activeWorkspace, ws.id);
  store.destroy();
});

test('lists workspaces sorted by lastActive', () => {
  const store = freshStore();
  const wsA = store.createWorkspace({ name: 'Alpha' });
  store.createWorkspace({ name: 'Beta' });
  // Touch Alpha to make it most recent
  store.updateWorkspace(wsA.id, { description: 'updated' });
  const list = store.getAllWorkspacesList();
  assertEqual(list.length, 2);
  // Alpha was updated last, so it should be first
  assertEqual(list[0].name, 'Alpha');
  store.destroy();
});

test('updates workspace properties', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'Original' });
  const updated = store.updateWorkspace(ws.id, { name: 'Renamed' });
  assertEqual(updated.name, 'Renamed');
  store.destroy();
});

test('deletes workspace and its sessions', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'ToDelete' });
  store.createSession({ name: 'Sess1', workspaceId: ws.id });
  store.createSession({ name: 'Sess2', workspaceId: ws.id });
  assertEqual(Object.keys(store.sessions).length, 2);

  store.deleteWorkspace(ws.id);
  assertEqual(Object.keys(store.workspaces).length, 0);
  assertEqual(Object.keys(store.sessions).length, 0);
  store.destroy();
});

test('switches active workspace on delete', () => {
  const store = freshStore();
  const ws1 = store.createWorkspace({ name: 'First' });
  const ws2 = store.createWorkspace({ name: 'Second' });
  store.setActiveWorkspace(ws1.id);
  store.deleteWorkspace(ws1.id);
  assertEqual(store.activeWorkspace, ws2.id);
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Store - Session CRUD');

test('creates a session in a workspace', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'WS' });
  const sess = store.createSession({
    name: 'My Session',
    workspaceId: ws.id,
    workingDir: 'C:\\test',
    topic: 'Testing',
    command: 'claude',
  });
  assertNotNull(sess);
  assertEqual(sess.name, 'My Session');
  assertEqual(sess.status, 'stopped');
  assertEqual(sess.workspaceId, ws.id);
  assert(store.getWorkspace(ws.id).sessions.includes(sess.id));
  store.destroy();
});

test('returns null when creating session for non-existent workspace', () => {
  const store = freshStore();
  const result = store.createSession({ name: 'Bad', workspaceId: 'nonexistent' });
  assert(result === null);
  store.destroy();
});

test('updates session status', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'WS' });
  const sess = store.createSession({ name: 'S', workspaceId: ws.id });
  store.updateSessionStatus(sess.id, 'running', 12345);
  const updated = store.getSession(sess.id);
  assertEqual(updated.status, 'running');
  assertEqual(updated.pid, 12345);
  store.destroy();
});

test('adds log entries to session', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'WS' });
  const sess = store.createSession({ name: 'S', workspaceId: ws.id });
  store.addSessionLog(sess.id, 'Started');
  store.addSessionLog(sess.id, 'Working');
  const updated = store.getSession(sess.id);
  assertEqual(updated.logs.length, 2);
  assertEqual(updated.logs[0].message, 'Started');
  store.destroy();
});

test('deletes a session and removes from workspace', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'WS' });
  const sess = store.createSession({ name: 'S', workspaceId: ws.id });
  store.deleteSession(sess.id);
  assert(store.getSession(sess.id) === undefined || store.getSession(sess.id) === null);
  assert(!store.getWorkspace(ws.id).sessions.includes(sess.id));
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Store - Persistence');

test('saves and loads state from disk', () => {
  cleanState();
  const { Store: S1 } = require('../src/state/store');
  const store1 = new S1().init();
  const ws = store1.createWorkspace({ name: 'Persisted' });
  store1.createSession({ name: 'PersistSess', workspaceId: ws.id });
  store1.save();
  store1.destroy();

  // Load into a fresh instance (but keep the state file)
  delete require.cache[require.resolve('../src/state/store')];
  const { Store: S2 } = require('../src/state/store');
  const store2 = new S2().init();
  const list = store2.getAllWorkspacesList();
  assertEqual(list.length, 1);
  assertEqual(list[0].name, 'Persisted');
  const sessions = store2.getAllSessionsList();
  assertEqual(sessions.length, 1);
  assertEqual(sessions[0].name, 'PersistSess');
  store2.destroy();

  // Clean up
  cleanState();
});

// ──────────────────────────────────────────────────────
suite('Store - Settings');

test('updates settings', () => {
  const store = freshStore();
  store.updateSettings({ autoRecover: false, theme: 'light' });
  assertEqual(store.settings.autoRecover, false);
  assertEqual(store.settings.theme, 'light');
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Store - Events');

test('emits workspace:created event', () => {
  const store = freshStore();
  let emitted = false;
  store.on('workspace:created', () => { emitted = true; });
  store.createWorkspace({ name: 'EventTest' });
  assert(emitted, 'workspace:created event should have been emitted');
  store.destroy();
});

test('emits session:updated event', () => {
  const store = freshStore();
  const ws = store.createWorkspace({ name: 'WS' });
  const sess = store.createSession({ name: 'S', workspaceId: ws.id });
  let emitted = false;
  store.on('session:updated', () => { emitted = true; });
  store.updateSession(sess.id, { status: 'running' });
  assert(emitted, 'session:updated event should have been emitted');
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Theme - Formatting');

const theme = require('../src/ui/theme');

test('formatStatus returns correct icon for running', () => {
  const result = theme.formatStatus('running');
  assertEqual(result.label, 'Running');
  assertNotNull(result.icon);
  assertNotNull(result.color);
});

test('formatStatus handles unknown status', () => {
  const result = theme.formatStatus('unknown');
  assertEqual(result.label, 'Unknown');
});

test('formatTimestamp returns "just now" for recent timestamps', () => {
  const result = theme.formatTimestamp(new Date().toISOString());
  assertEqual(result, 'just now');
});

test('truncate shortens long strings', () => {
  const result = theme.truncate('A very long workspace name that should be truncated', 20);
  assert(result.length <= 20, `Expected length <= 20, got ${result.length}`);
});

test('truncate returns short strings unchanged', () => {
  const result = theme.truncate('Short', 20);
  assertEqual(result, 'Short');
});

// ──────────────────────────────────────────────────────
suite('Core - Session Manager');

test('launchSession returns error for non-existent session', () => {
  // Need fresh store
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  // Re-require to reset singleton
  delete require.cache[require.resolve('../src/state/store')];
  const { getStore } = require('../src/state/store');
  const store = getStore();

  delete require.cache[require.resolve('../src/core/session-manager')];
  const { launchSession } = require('../src/core/session-manager');

  const result = launchSession('nonexistent-id');
  assertEqual(result.success, false);
  assert(result.error.includes('not found'));
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Core - Notifications');

test('NotificationManager stores and retrieves notifications', () => {
  const { NotificationManager } = require('../src/core/notifications');
  const nm = new NotificationManager();
  nm.notify('info', 'Test', 'Test message 1');
  nm.notify('error', 'Error', 'Something broke');
  const recent = nm.getRecent(5);
  assertEqual(recent.length, 2);
  assertEqual(recent[0].title, 'Test');
  assertEqual(recent[1].level, 'error');
  nm.destroy();
});

test('NotificationManager emits notification event', () => {
  const { NotificationManager } = require('../src/core/notifications');
  const nm = new NotificationManager();
  let emitted = null;
  nm.on('notification', (n) => { emitted = n; });
  nm.notify('success', 'Done', 'All good');
  assertNotNull(emitted);
  assertEqual(emitted.title, 'Done');
  nm.destroy();
});

test('NotificationManager clears queue', () => {
  const { NotificationManager } = require('../src/core/notifications');
  const nm = new NotificationManager();
  nm.notify('info', 'Test', 'msg');
  nm.clear();
  assertEqual(nm.count, 0);
  nm.destroy();
});

// ──────────────────────────────────────────────────────
suite('Core - Recovery');

test('checkForRecovery detects stale sessions', () => {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  delete require.cache[require.resolve('../src/state/store')];
  const { getStore } = require('../src/state/store');
  const store = getStore();

  delete require.cache[require.resolve('../src/core/recovery')];
  const { checkForRecovery } = require('../src/core/recovery');

  const ws = store.createWorkspace({ name: 'Recovery Test' });
  const sess = store.createSession({ name: 'Stale', workspaceId: ws.id });
  store.updateSessionStatus(sess.id, 'running', 99999); // Fake PID
  store.save();

  const result = checkForRecovery();
  assert(result.stale.length >= 1, 'Should detect stale session');
  store.destroy();
});

// ──────────────────────────────────────────────────────
suite('Auto-Trust - Pattern Matching');

// Extracted patterns from terminal.js for testability
const AUTO_TRUST_PATTERNS = [
  /\(Y\/n\)/i, /\(y\/N\)/i,
  /trust this (folder|directory|project)/i,
  /allow .*(tool|access|permission)/i,
  /\bproceed\?/i, /\bapprove\b.*\?/i,
  /\bcontinue\?/i, /\baccept\b.*\?/i,
];
const DANGER_KEYWORDS = /\b(delete|remove|credential|secret|password|key|token|destroy|format|drop|wipe|overwrite)\b/i;

function matchAutoTrust(text) {
  for (const p of AUTO_TRUST_PATTERNS) {
    if (p.test(text)) return { matched: true, dangerous: DANGER_KEYWORDS.test(text) };
  }
  return { matched: false, dangerous: false };
}

test('detects (Y/n) prompts', () => {
  assert(matchAutoTrust('Do you want to trust this? (Y/n)').matched);
});

test('detects (y/N) prompts', () => {
  assert(matchAutoTrust('Continue with installation? (y/N)').matched);
});

test('detects trust this folder/directory/project', () => {
  assert(matchAutoTrust('trust this folder?').matched);
  assert(matchAutoTrust('trust this directory?').matched);
  assert(matchAutoTrust('trust this project?').matched);
});

test('detects allow tool access', () => {
  assert(matchAutoTrust('Allow Claude to use tool access?').matched);
});

test('detects proceed/continue/approve/accept prompts', () => {
  assert(matchAutoTrust('Proceed?').matched);
  assert(matchAutoTrust('Do you want to continue?').matched);
  assert(matchAutoTrust('Approve this?').matched);
  assert(matchAutoTrust('Accept the terms?').matched);
});

test('does not match regular output', () => {
  assert(!matchAutoTrust('Reading file src/index.js...').matched);
  assert(!matchAutoTrust('const x = 42;').matched);
});

test('flags dangerous prompts with delete/remove/credential keywords', () => {
  const r1 = matchAutoTrust('Delete 15 files? (Y/n)');
  assert(r1.matched && r1.dangerous, 'delete should be dangerous');
  const r2 = matchAutoTrust('Remove node_modules? Proceed?');
  assert(r2.matched && r2.dangerous, 'remove should be dangerous');
  const r3 = matchAutoTrust('Access credential store? (Y/n)');
  assert(r3.matched && r3.dangerous, 'credential should be dangerous');
});

test('flags dangerous prompts with password/token/destroy keywords', () => {
  assert(matchAutoTrust('Enter password to continue?').dangerous, 'password');
  assert(matchAutoTrust('Overwrite token file? (Y/n)').dangerous, 'token');
  assert(matchAutoTrust('Destroy the database. Proceed?').dangerous, 'destroy');
});

test('does not flag safe trust prompts as dangerous', () => {
  const r = matchAutoTrust('Do you want to trust this folder? (Y/n)');
  assert(r.matched && !r.dangerous, 'Safe trust should not be dangerous');
});

test('strips ANSI codes before matching', () => {
  const ansi = '\x1b[32mProceed?\x1b[0m';
  const clean = ansi.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert(matchAutoTrust(clean).matched, 'Should match after ANSI strip');
});

// ──────────────────────────────────────────────────────
// Diff Viewer - Diff Parsing
// ──────────────────────────────────────────────────────

suite('Diff Viewer - Diff Parsing');

/**
 * Parse unified diff text into structured format for testing.
 * Mirrors the logic from app.js _renderDiffContent() method.
 */
function parseDiff(diffText) {
  const lines = diffText.split('\n');
  const hunks = [];
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') ||
        line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('new file') || line.startsWith('deleted file')) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      currentHunk = { oldStart: parseInt(hunkMatch[1], 10), newStart: parseInt(hunkMatch[2], 10), lines: [] };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;
    if (line.startsWith('+')) currentHunk.lines.push({ type: 'add', text: line.substring(1) });
    else if (line.startsWith('-')) currentHunk.lines.push({ type: 'del', text: line.substring(1) });
    else if (line.startsWith(' ') || line === '') currentHunk.lines.push({ type: 'ctx', text: line.substring(1) });
  }
  return hunks;
}

test('parses unified diff hunks', () => {
  const diff = `diff --git a/file.js b/file.js
index abc..def 100644
--- a/file.js
+++ b/file.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;`;
  const hunks = parseDiff(diff);
  assert(hunks.length === 1, 'Should have one hunk');
  assert(hunks[0].oldStart === 1, 'Old start should be 1');
  assert(hunks[0].newStart === 1, 'New start should be 1');
  assert(hunks[0].lines.length === 4, 'Should have 4 lines');
  assert(hunks[0].lines[1].type === 'add', 'Second line should be addition');
  assert(hunks[0].lines[1].text === 'const b = 2;', 'Addition text should match');
});

test('parses deletions correctly', () => {
  const diff = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -5,4 +5,3 @@
 line5
-removed line
 line7
 line8`;
  const hunks = parseDiff(diff);
  assert(hunks[0].lines[1].type === 'del', 'Should be deletion');
  assert(hunks[0].lines[1].text === 'removed line', 'Deletion text should match');
});

test('parses multiple hunks', () => {
  const diff = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
@@ -10,3 +10,3 @@
 line10
-oldB
+newB
 line12`;
  const hunks = parseDiff(diff);
  assert(hunks.length === 2, 'Should have two hunks');
  assert(hunks[0].oldStart === 1, 'First hunk starts at 1');
  assert(hunks[1].oldStart === 10, 'Second hunk starts at 10');
});

test('handles empty diff', () => {
  const hunks = parseDiff('');
  assert(hunks.length === 0, 'Empty diff should have no hunks');
});

/**
 * Parse git numstat output into file objects.
 * Mirrors the backend /api/worktree-tasks/:id/changes logic.
 */
function parseNumstat(numstatText, nameStatusText) {
  const statusMap = {};
  nameStatusText.trim().split('\n').filter(Boolean).forEach(line => {
    const parts = line.split('\t');
    const statusCode = parts[0].charAt(0);
    const filePath = parts.length > 2 ? parts[2] : parts[1];
    statusMap[filePath] = { status: statusCode };
  });

  return numstatText.trim().split('\n').filter(Boolean).map(line => {
    const [addStr, delStr, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    return {
      path: filePath,
      additions: addStr === '-' ? 0 : parseInt(addStr, 10) || 0,
      deletions: delStr === '-' ? 0 : parseInt(delStr, 10) || 0,
      status: (statusMap[filePath] || { status: 'M' }).status,
    };
  });
}

test('parses numstat with name-status', () => {
  const numstat = '10\t5\tsrc/app.js\n3\t0\tsrc/new.js\n0\t8\tsrc/old.js';
  const nameStatus = 'M\tsrc/app.js\nA\tsrc/new.js\nD\tsrc/old.js';
  const files = parseNumstat(numstat, nameStatus);
  assert(files.length === 3, 'Should have 3 files');
  assert(files[0].status === 'M', 'First file should be Modified');
  assert(files[0].additions === 10, 'First file should have 10 additions');
  assert(files[0].deletions === 5, 'First file should have 5 deletions');
  assert(files[1].status === 'A', 'Second file should be Added');
  assert(files[2].status === 'D', 'Third file should be Deleted');
  assert(files[2].deletions === 8, 'Third file should have 8 deletions');
});

test('handles binary files in numstat (- marks)', () => {
  const numstat = '-\t-\timage.png';
  const nameStatus = 'A\timage.png';
  const files = parseNumstat(numstat, nameStatus);
  assert(files[0].additions === 0, 'Binary file should have 0 additions');
  assert(files[0].deletions === 0, 'Binary file should have 0 deletions');
  assert(files[0].status === 'A', 'Binary file should be Added');
});

// ──────────────────────────────────────────────────────
// URL Auto-Login (One-Time Startup Token)
// ──────────────────────────────────────────────────────

suite('URL Auto-Login - Token Extraction');

/**
 * Extract one-time token from URL query params and build the cleaned URL.
 * Mirrors the logic in app.js init() method.
 * Returns { token, cleanUrl } or { token: null } if no param.
 */
function extractUrlToken(url) {
  const parsed = new URL(url, 'http://localhost');
  const token = parsed.searchParams.get('token');
  if (!token) return { token: null, cleanUrl: null };
  // Build clean URL (pathname only, no query)
  return { token, cleanUrl: parsed.pathname };
}

test('extracts token from ?token=xxx', () => {
  const result = extractUrlToken('http://localhost:40932?token=abc123def');
  assertEqual(result.token, 'abc123def');
});

test('returns clean URL without token param', () => {
  const result = extractUrlToken('http://localhost:40932?token=abc123def');
  assertEqual(result.cleanUrl, '/');
});

test('returns null token when no param present', () => {
  const result = extractUrlToken('http://localhost:40932');
  assertEqual(result.token, null);
});

test('returns null token for empty token param', () => {
  const result = extractUrlToken('http://localhost:40932?token=');
  assertEqual(result.token, null);
});

test('handles token with special characters', () => {
  const result = extractUrlToken('http://localhost:40932?token=abc%2Bdef%3D123');
  assertEqual(result.token, 'abc+def=123');
});

test('preserves pathname when stripping token', () => {
  const result = extractUrlToken('http://localhost:40932/some/path?token=abc');
  assertEqual(result.cleanUrl, '/some/path');
});

// ──────────────────────────────────────────────────────
// Server-Side Startup Token
// ──────────────────────────────────────────────────────

suite('Startup Token - Generation & Validation');

const { generateStartupToken, _startupTokens } = require('../src/web/auth');

test('generateStartupToken returns a non-empty string', () => {
  const token = generateStartupToken();
  assert(typeof token === 'string' && token.length > 0, 'Token should be a non-empty string');
});

test('generateStartupToken returns unique tokens each call', () => {
  const t1 = generateStartupToken();
  const t2 = generateStartupToken();
  assert(t1 !== t2, 'Tokens should be unique');
});

test('generated token is stored in startupTokens map', () => {
  const token = generateStartupToken();
  assert(_startupTokens.has(token), 'Token should be stored in startupTokens map');
  const entry = _startupTokens.get(token);
  assert(typeof entry.createdAt === 'number', 'Should have createdAt timestamp');
  assertEqual(entry.used, false);
});

test('AUTH_PASSWORD is not exported from auth module', () => {
  const authExports = require('../src/web/auth');
  assertEqual(authExports.AUTH_PASSWORD, undefined, 'AUTH_PASSWORD should not be exported');
});

// ──────────────────────────────────────────────────────
// Discovery - Custom Title Extraction
// ──────────────────────────────────────────────────────

suite('Discovery - extractCustomTitle');

const { extractCustomTitle } = require('../src/web/server');
const tmpDir = path.join(__dirname, '..', 'state', '_test_jsonl');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

function writeTmpJsonl(name, lines) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

test('extracts title from a single custom-title entry', () => {
  const p = writeTmpJsonl('single.jsonl', [
    '{"type":"permission-mode","permissionMode":"default","sessionId":"aaa"}',
    '{"type":"custom-title","customTitle":"my-feature","sessionId":"aaa"}',
    '{"type":"user","message":{"role":"user","content":"hello"}}',
  ]);
  assertEqual(extractCustomTitle(p), 'my-feature');
});

test('returns the last title when renamed', () => {
  const p = writeTmpJsonl('renamed.jsonl', [
    '{"type":"custom-title","customTitle":"old-name","sessionId":"bbb"}',
    '{"type":"user","message":{"role":"user","content":"do stuff"}}',
    '{"type":"custom-title","customTitle":"new-name","sessionId":"bbb"}',
  ]);
  assertEqual(extractCustomTitle(p), 'new-name');
});

test('returns null when no custom-title exists', () => {
  const p = writeTmpJsonl('notitle.jsonl', [
    '{"type":"permission-mode","permissionMode":"default","sessionId":"ccc"}',
    '{"type":"user","message":{"role":"user","content":"hello"}}',
  ]);
  assertEqual(extractCustomTitle(p), null);
});

test('returns null for malformed JSON on custom-title line', () => {
  const p = writeTmpJsonl('malformed.jsonl', [
    '{"type":"permission-mode","sessionId":"ddd"}',
    '{"type":"custom-title" BROKEN JSON',
  ]);
  assertEqual(extractCustomTitle(p), null);
});

test('returns null for nonexistent file', () => {
  assertEqual(extractCustomTitle(path.join(tmpDir, 'nonexistent.jsonl')), null);
});

test('finds title in tail of large file', () => {
  // Pad with 20KB of filler lines so the title is only in the last 16KB
  const filler = [];
  for (let i = 0; i < 200; i++) {
    filler.push(`{"type":"user","message":{"role":"user","content":"${'x'.repeat(100)}"}}`);
  }
  filler.push('{"type":"custom-title","customTitle":"deep-title","sessionId":"eee"}');
  const p = writeTmpJsonl('large.jsonl', filler);
  assertEqual(extractCustomTitle(p), 'deep-title');
});

// Clean up temp files
try {
  for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  fs.rmdirSync(tmpDir);
} catch (_) {}

// ──────────────────────────────────────────────────────
// Results

console.log('\n  ' + '─'.repeat(42));
console.log(`  \x1b[1mResults:\x1b[0m ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('  ' + '─'.repeat(42) + '\n');

// Restore production state files that were saved before tests
restoreState();

// Run standalone test files (each has its own runner). Pass results count
// through to the final exit code so CI catches failures in any of them.
const { spawnSync } = require('child_process');
const standaloneTests = [
  'pty-watcher.test.js',
  'scheduler.test.js',
  'scheduler-api.test.js',
  'instance-colors.test.js',
  'providers-registry.test.js', // Plan 14-01: Provider registry contract (ABST-01/02/05/06/07, COST-01)
  'migration.test.js', // Plan 14-02: State schema v1 -> v2 migration (MIG-01..MIG-06)
  'pty-passthrough.test.js', // Plan 14-04: PTY pass-through descriptor flow (PTY-01, PTY-03)
  'cost-worker-via-claude.test.js', // Plan 14-04: claudeProvider.costAdapter wiring (COST-04)
  'grep-gate.test.js', // Plan 14-05: Forbidden provider-name literals outside src/providers/ (ABST-04)
  'find-jsonl-refactor.test.js', // Plan 15-01: getProviderForSession + claudeProvider.findArtifactPath (DISC-03)
  'providers-endpoints.test.js', // Plan 15-03: GET/PUT /api/providers (DISC-06, DISC-07)
  'discover-route.test.js', // Plan 15-02: per-provider GET /api/discover dispatcher + ?legacy=1 (DISC-01/02/04/05)
  'search-dispatch.test.js', // Plan 16-01: GET /api/search Promise.allSettled dispatcher (SRCH-01/02/03/04/06)
  'codex-parse.test.js',     // Plan 17-01: RolloutLine envelope + bare-JSON wrap (CDX-03/04/05/08)
  'codex-discover.test.js',  // Plan 17-01: session_index.jsonl fast-path + walk-fallback + CODEX_HOME (CDX-01/02/07)
  'codex-schema.test.js',    // Plan 17-01: canonical schema fixture + drift gate (CDX-09)
  'codex-spawn.test.js',     // Plan 17-02: SpawnDescriptor + CODEX_HOME scoping (CDX-07 spawn half)
  'codex-search.test.js',    // Plan 17-02: snippet search + compacted exclusion (CDX-05/06)
  'css-tokens.test.js',         // Plan 18-01: :root provider tokens and selectors (UI-04, UI-05)
  'data-provider-attr.test.js', // Plan 18-01: data-provider on render sites (UI-03)
  'provider-tabs.test.js',      // Plan 18-02: sidebar provider tab strip + scroll preservation (UI-01/02/07/08/09)
  'settings-providers.test.js', // Plan 18-03: Settings Providers section + toggle confirmation modal (SET-01..06)
  'cost-display.test.js',       // Plan 18-04: provider-aware cost badges + dashboard disclosure (COST-02/03)
  'search-render.test.js',      // Plan 18-04: search-result provider chip + accent (SRCH-05)
  'dragdrop-provider.test.js',  // Plan 18-04: drag-drop provider propagation + legacy shim removal (UI-10)
  'layout-provider-persist.test.js', // Plan 19-01: layout pane records persist provider for deterministic restore (PTY-07)
  'pty-codex-spawn.test.js',         // Plan 19-01: Codex spawn dispatch through registry-driven sentinel + per-spawn env scoping (PTY-02, PTY-08)
  'idle-signal-dispatch.test.js',    // Plan 19-02: frontend idle dispatch through per-provider spec (PTY-04)
  'keybindings-dispatch.test.js',    // Plan 19-02: Shift+Enter dispatch + backend-frontend parity (PTY-05)
  'idle-signal-parity.test.js',      // Plan 19-02: backend.isIdleSignal vs frontend regex parity (PTY-04 drift gate)
  'bracketed-paste-isolation.test.js', // Plan 19-02: per-pane paste listener scope (PTY-06)
  'codex-settings-route.test.js',    // Plan 21-01: PUT /api/sessions/:id/provider-settings (Codex menu persistence)
  'pane-context-menu.test.js',       // Plan 21-01: Codex pane right-click menu structure gate
  'project-session-resume-provider.test.js', // alpha.5 bug fix: discovered-session right-click routes by provider
  'adhoc-pane-menu.test.js',         // Plan 22-04: ad-hoc pane right-click menu reduced fallback
  'provider-label-pill.test.js',     // Plan 22-02: pane provider pill + sidebar stripes
  'workspace-group-ux.test.js',      // Plan 22-05: workspace group color stripe + chip
  'codex-status-strip.test.js',      // Plan 22-01: Codex bottom status strip + chip click handlers
  'codex-discover-watcher.test.js',  // Plan 22-03: fs.watch debounce + 5-min fallback poll
  'settings-nav-rail.test.js',       // alpha.9: left-side category rail for settings panel
];

let standaloneFailed = 0;
for (const file of standaloneTests) {
  const filePath = path.join(__dirname, file);
  if (!require('fs').existsSync(filePath)) continue;
  console.log(`\n  \x1b[1m\x1b[36m  Running ${file}\x1b[0m`);
  console.log('  ' + '─'.repeat(42));
  const result = spawnSync(process.execPath, [filePath], { stdio: 'inherit' });
  if (result.status !== 0) standaloneFailed++;
}

process.exit(failed > 0 || standaloneFailed > 0 ? 1 : 0);
