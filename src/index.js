#!/usr/bin/env node
/**
 * Claude Workspace Manager (CWM)
 * Lightweight terminal workspace manager for Claude Code sessions.
 *
 * Usage:
 *   node src/index.js          Launch the TUI
 *   node src/index.js --demo   Launch with sample demo data
 *   node src/index.js --reset  Clear all state and start fresh
 */

const { getStore } = require('./state/store');
const { getNotificationManager } = require('./core/notifications');
const { markStaleSessionsStopped } = require('./core/recovery');
const { createApp } = require('./ui/app');

function main() {
  const args = process.argv.slice(2);
  const isDemo = args.includes('--demo');
  const isReset = args.includes('--reset');

  // Initialize store
  const store = getStore();

  // Handle --reset
  if (isReset) {
    const fs = require('fs');
    const path = require('path');
    const stateFile = path.join(__dirname, '..', 'state', 'workspaces.json');
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
      console.log('State cleared. Restart without --reset.');
      process.exit(0);
    }
    console.log('No state file found.');
    process.exit(0);
  }

  // Initialize notification manager (attaches to store events)
  const notifications = getNotificationManager();

  // Run recovery check - mark stale sessions as stopped
  const staleIds = markStaleSessionsStopped();
  if (staleIds.length > 0) {
    notifications.notify('warning', 'Recovery',
      `${staleIds.length} session(s) were found stale and marked stopped`);
  }

  // Populate demo data if --demo and no workspaces exist
  if (isDemo && Object.keys(store.workspaces).length === 0) {
    seedDemoData(store, notifications);
  }

  // Launch the TUI
  const app = createApp(store, notifications.getRecent(5));

  // Graceful shutdown
  process.on('SIGINT', () => {
    app.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    app.destroy();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    store.save();
    console.error('Uncaught exception:', err.message);
    process.exit(1);
  });
}

/**
 * Seed the store with realistic demo data for showcasing the UI
 */
function seedDemoData(store, notifications) {
  // Create workspaces
  const ws1 = store.createWorkspace({
    name: 'Project Alpha',
    description: 'Frontend application and components',
    color: 'cyan',
  });

  const ws2 = store.createWorkspace({
    name: 'Backend API',
    description: 'Backend API for data processing',
    color: 'magenta',
  });

  const ws3 = store.createWorkspace({
    name: 'Documentation',
    description: 'Technical docs and guides',
    color: 'yellow',
  });

  // Create sessions for Project Alpha
  const s1 = store.createSession({
    name: 'ui-components',
    workspaceId: ws1.id,
    workingDir: 'C:\\Projects\\project-alpha\\src',
    topic: 'React component library',
    command: 'claude',
  });
  store.updateSession(s1.id, { status: 'running', pid: 12340 });
  store.addSessionLog(s1.id, 'Session launched with PID 12340');
  store.addSessionLog(s1.id, 'Working on data table component');

  const s2 = store.createSession({
    name: 'perf-analysis',
    workspaceId: ws1.id,
    workingDir: 'C:\\Projects\\project-alpha\\perf',
    topic: 'Performance profiling and optimization',
    command: 'claude',
  });
  store.updateSession(s2.id, { status: 'idle', pid: 12341 });
  store.addSessionLog(s2.id, 'Analyzing render performance');

  const s3 = store.createSession({
    name: 'test-runner',
    workspaceId: ws1.id,
    workingDir: 'C:\\Projects\\project-alpha\\test',
    topic: 'Integration tests for UI components',
    command: 'claude',
  });
  store.updateSession(s3.id, { status: 'stopped' });
  store.addSessionLog(s3.id, 'Tests completed: 47/48 passed');

  // Create sessions for Backend API
  const s4 = store.createSession({
    name: 'api-endpoints',
    workspaceId: ws2.id,
    workingDir: 'C:\\Projects\\backend-api\\src',
    topic: 'REST API for resource management',
    command: 'claude',
  });
  store.updateSession(s4.id, { status: 'running', pid: 12345 });
  store.addSessionLog(s4.id, 'Implementing /api/v1/resources endpoint');

  const s5 = store.createSession({
    name: 'db-migrations',
    workspaceId: ws2.id,
    workingDir: 'C:\\Projects\\backend-api\\db',
    topic: 'Database schema and migrations',
    command: 'claude',
  });
  store.updateSession(s5.id, { status: 'error' });
  store.addSessionLog(s5.id, 'Migration failed: FK constraint violation');

  // Create sessions for Documentation
  const s6 = store.createSession({
    name: 'architecture-docs',
    workspaceId: ws3.id,
    workingDir: 'C:\\Projects\\docs',
    topic: 'System architecture documentation',
    command: 'claude',
  });
  store.updateSession(s6.id, { status: 'stopped' });

  // Set Project Alpha as active
  store.setActiveWorkspace(ws1.id);

  // Add some startup notifications
  notifications.notify('success', 'Demo', 'Demo workspace data loaded');
  notifications.notify('info', 'Welcome', 'Press ? for keyboard shortcuts');

  store.save();
}

main();
