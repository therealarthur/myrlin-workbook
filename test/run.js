#!/usr/bin/env node
/**
 * Test suite for Claude Workspace Manager
 * Runs unit tests for store, core logic, and module integration.
 */

const path = require('path');

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
// Clean state before tests — PRESERVES production state
const fs = require('fs');
const stateDir = path.join(__dirname, '..', 'state');
const stateFile = path.join(stateDir, 'workspaces.json');
const backupFile = path.join(stateDir, 'workspaces.backup.json');
const backupsDir = path.join(stateDir, 'backups');

// Save production state files before tests so they can be restored after
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
  assertEqual(store.state.version, 1);
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
// Results

console.log('\n  ' + '─'.repeat(42));
console.log(`  \x1b[1mResults:\x1b[0m ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('  ' + '─'.repeat(42) + '\n');

// Restore production state files that were saved before tests
restoreState();

process.exit(failed > 0 ? 1 : 0);
