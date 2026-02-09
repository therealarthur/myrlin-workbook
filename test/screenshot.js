#!/usr/bin/env node
/**
 * Screenshot capture for Claude Workspace Manager
 * Generates HTML screenshots with Catppuccin Mocha theme showing:
 * - Main dashboard with workspace view
 * - All Sessions view
 * - Help dialog
 * - Quick switcher
 */

const fs = require('fs');
const path = require('path');
const blessed = require('blessed');

const screenshotDir = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

// Clean state for fresh demo
const stateDir = path.join(__dirname, '..', 'state');
const stateFile = path.join(stateDir, 'workspaces.json');
if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
delete require.cache[require.resolve('../src/state/store')];

const { getStore } = require('../src/state/store');
const theme = require('../src/ui/theme');

// ─── Catppuccin Mocha CSS Variables ────────────────
const CSS_VARS = `
  --ctp-base: #1e1e2e;
  --ctp-mantle: #181825;
  --ctp-crust: #11111b;
  --ctp-surface0: #313244;
  --ctp-surface1: #45475a;
  --ctp-surface2: #585b70;
  --ctp-overlay0: #6c7086;
  --ctp-overlay1: #7f849c;
  --ctp-text: #cdd6f4;
  --ctp-subtext0: #a6adc8;
  --ctp-subtext1: #bac2de;
  --ctp-mauve: #cba6f7;
  --ctp-blue: #89b4fa;
  --ctp-sapphire: #74c7ec;
  --ctp-sky: #89dceb;
  --ctp-teal: #94e2d5;
  --ctp-green: #a6e3a1;
  --ctp-yellow: #f9e2af;
  --ctp-peach: #fab387;
  --ctp-maroon: #eba0ac;
  --ctp-red: #f38ba8;
  --ctp-pink: #f5c2e7;
  --ctp-flamingo: #f2cdcd;
  --ctp-rosewater: #f5e0dc;
  --ctp-lavender: #b4befe;
`;

function captureScreenshots() {
  const store = getStore();
  seedDemoData(store);

  const screen = blessed.screen({
    title: 'Claude Workspace Manager',
    smartCSR: true,
    fullUnicode: true,
    dump: path.join(screenshotDir, 'debug.log'),
    width: 120,
    height: 35,
  });

  // Build UI
  const statusBarMod = require('../src/ui/status-bar');
  const workspacePanelMod = require('../src/ui/workspace-panel');
  const sessionListMod = require('../src/ui/session-list');
  const sessionDetailMod = require('../src/ui/session-detail');
  const notificationBarMod = require('../src/ui/notification-bar');

  const bar = statusBarMod.create(screen);
  const wsPanel = workspacePanelMod.create(screen);
  const sessList = sessionListMod.create(screen);
  const sessDetail = sessionDetailMod.create(screen);
  const notifBar = notificationBarMod.create(screen);

  // Populate
  statusBarMod.update(bar, store, 'workspace');
  workspacePanelMod.update(wsPanel.widget, store);

  const activeWs = store.getActiveWorkspace();
  sessionListMod.setViewMode(sessList.widget, 'workspace');
  sessionListMod.update(sessList.widget, store, activeWs ? activeWs.id : null);

  const sessions = store.getWorkspaceSessions(activeWs.id);
  if (sessions.length > 0) {
    sessionDetailMod.update(sessDetail, sessions[0]);
  }

  notificationBarMod.push(notifBar, { level: 'success', message: 'Demo workspace data loaded successfully' });
  notificationBarMod.push(notifBar, { level: 'info', message: 'Press ? for keyboard shortcuts' });

  wsPanel.widget.focus();
  screen.render();

  // ─── Capture blessed text screenshot ──────────
  try {
    const textScreenshot = screen.screenshot();
    fs.writeFileSync(path.join(screenshotDir, 'dashboard.txt'), textScreenshot, 'utf-8');
    console.log('  \x1b[32m✓\x1b[0m Captured dashboard.txt');
  } catch (err) {
    console.log('  \x1b[33m!\x1b[0m dashboard.txt:', err.message);
  }

  // ─── Generate HTML screenshots ────────────────
  const allSessions = store.getAllSessionsList();
  generateDashboardHTML(store, sessions, 'workspace');
  generateDashboardHTML(store, allSessions, 'all');
  generateHelpHTML();
  generateQuickSwitcherHTML(store);

  screen.destroy();
  store.destroy();

  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  const backupFile = path.join(stateDir, 'workspaces.backup.json');
  if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);

  console.log(`\n  Screenshots saved to ${screenshotDir}`);
}

/**
 * Generate the main dashboard HTML screenshot
 */
function generateDashboardHTML(store, sessions, mode) {
  const activeWs = store.getActiveWorkspace();
  const workspaces = store.getAllWorkspacesList();

  const statusIcons = {
    running: { icon: '\u25CF', color: '#a6e3a1' },
    stopped: { icon: '\u25CB', color: '#6c7086' },
    error: { icon: '\u2717', color: '#f38ba8' },
    idle: { icon: '\u25D2', color: '#f9e2af' },
  };

  // Workspace list HTML
  let wsListHtml = '';
  for (const ws of workspaces) {
    const count = store.getWorkspaceSessions(ws.id).length;
    const isActive = ws.id === activeWs?.id;
    wsListHtml += `<div class="list-item${isActive ? ' active' : ''}">` +
      `<span class="dot" style="color:${isActive ? '#cba6f7' : '#6c7086'}">●</span> ` +
      `<span class="name">${ws.name}</span> ` +
      `<span class="count">(${count})</span></div>\n`;
  }

  // Session list HTML
  let sessListHtml = '';
  for (const s of sessions) {
    const st = statusIcons[s.status] || statusIcons.stopped;
    const timeAgo = theme.formatTimestamp(s.lastActive);
    const ws = store.getWorkspace(s.workspaceId);
    const wsTag = mode !== 'workspace' ? `<span class="ws-tag">[${ws ? ws.name : '?'}]</span> ` : '';
    sessListHtml += `<div class="list-item">` +
      `<span style="color:${st.color}">${st.icon}</span> ` +
      wsTag +
      `<span class="name">${s.name}</span>` +
      `<span class="dir">${s.workingDir || ''}</span>` +
      `<span class="time">${timeAgo}</span></div>\n`;
  }

  // Detail HTML for first session
  const firstSess = sessions[0];
  let detailHtml = '';
  if (firstSess) {
    const st = statusIcons[firstSess.status] || statusIcons.stopped;
    const fields = [
      ['Status', `<span style="color:${st.color}">${st.icon} ${firstSess.status}</span>`],
      ['PID', firstSess.pid || 'none'],
      ['Directory', firstSess.workingDir || 'not set'],
      ['Topic', firstSess.topic || 'none'],
      ['Command', firstSess.command || 'claude'],
      ['Created', theme.formatTimestamp(firstSess.createdAt)],
      ['Last Active', theme.formatTimestamp(firstSess.lastActive)],
    ];
    detailHtml = `<div class="detail-header">${firstSess.name}</div>\n<div class="detail-sep"></div>\n`;
    for (const [k, v] of fields) {
      detailHtml += `<div class="detail-row"><span class="detail-key">${k}</span><span class="detail-val">${v}</span></div>\n`;
    }
    const logs = firstSess.logs || [];
    if (logs.length > 0) {
      detailHtml += `<div class="detail-sep"></div>\n<div class="detail-header" style="font-size:12px">Recent Logs</div>\n`;
      for (const log of logs.slice(-3)) {
        detailHtml += `<div class="log-entry"><span class="log-time">${theme.formatTimestamp(log.time)}</span> ${log.message}</div>\n`;
      }
    }
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const running = sessions.filter(s => s.status === 'running').length;
  const vm = theme.viewModes[mode];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CWM - ${vm.label} View</title>
<style>
  :root { ${CSS_VARS} }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--ctp-crust);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 40px;
    font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
  }
  .terminal {
    background: var(--ctp-base);
    border: 1px solid var(--ctp-surface0);
    border-radius: 12px;
    width: 960px;
    height: 560px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(203,166,247,0.05);
  }
  .titlebar {
    background: var(--ctp-mantle);
    height: 36px;
    display: flex;
    align-items: center;
    padding: 0 14px;
    gap: 8px;
    border-bottom: 1px solid var(--ctp-surface0);
  }
  .titlebar .dot { width: 12px; height: 12px; border-radius: 50%; }
  .titlebar .dot.red { background: var(--ctp-red); }
  .titlebar .dot.yellow { background: var(--ctp-yellow); }
  .titlebar .dot.green { background: var(--ctp-green); }
  .titlebar .title {
    flex: 1; text-align: center;
    color: var(--ctp-overlay0); font-size: 12px;
  }
  .status-bar {
    background: var(--ctp-mantle);
    height: 28px;
    display: flex;
    align-items: center;
    padding: 0 14px;
    font-size: 12px;
    border-bottom: 1px solid var(--ctp-surface0);
  }
  .status-bar .brand { color: var(--ctp-mauve); font-weight: bold; }
  .status-bar .sep { color: var(--ctp-surface2); margin: 0 10px; }
  .status-bar .mode { color: ${vm.color}; font-weight: 600; }
  .status-bar .ws-name { color: var(--ctp-text); }
  .status-bar .sess-count { color: var(--ctp-subtext0); }
  .status-bar .clock { color: var(--ctp-subtext0); }
  .status-bar .help-hint { color: var(--ctp-overlay0); }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .sidebar {
    width: 30%;
    border-right: 1px solid var(--ctp-surface0);
    display: flex;
    flex-direction: column;
  }
  .panel-label {
    color: var(--ctp-subtext0);
    font-size: 11px;
    font-weight: bold;
    padding: 8px 14px 6px;
    border-bottom: 1px solid var(--ctp-surface0);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .panel-label.focused {
    color: var(--ctp-mauve);
    border-bottom-color: var(--ctp-mauve);
  }
  .content-area {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .top-panel {
    flex: 1;
    border-bottom: 1px solid var(--ctp-surface0);
    overflow: auto;
  }
  .bottom-panel {
    flex: 1;
    overflow: auto;
  }
  .list-item {
    padding: 5px 14px;
    font-size: 12px;
    color: var(--ctp-subtext0);
    cursor: pointer;
    display: flex;
    gap: 8px;
    align-items: center;
    transition: background 0.1s;
  }
  .list-item:hover { background: var(--ctp-surface0); }
  .list-item.active {
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    border-left: 2px solid var(--ctp-mauve);
    padding-left: 12px;
  }
  .list-item .dot { font-size: 10px; }
  .list-item .name { color: var(--ctp-text); flex-shrink: 0; }
  .list-item .count { color: var(--ctp-overlay0); font-size: 11px; }
  .list-item .dir { color: var(--ctp-overlay0); font-size: 11px; margin-left: auto; }
  .list-item .time { color: var(--ctp-overlay1); font-size: 11px; flex-shrink: 0; margin-left: 12px; }
  .list-item .ws-tag {
    color: var(--ctp-blue);
    font-size: 11px;
    font-weight: 500;
  }
  .detail-header {
    color: var(--ctp-mauve); font-weight: bold;
    padding: 8px 14px 4px;
    font-size: 13px;
  }
  .detail-sep {
    border-bottom: 1px solid var(--ctp-surface0);
    margin: 4px 14px;
  }
  .detail-row {
    padding: 2px 14px;
    font-size: 12px;
    display: flex;
    gap: 14px;
  }
  .detail-key { color: var(--ctp-subtext0); width: 100px; flex-shrink: 0; }
  .detail-val { color: var(--ctp-text); }
  .log-entry {
    padding: 1px 14px;
    font-size: 11px;
    color: var(--ctp-subtext0);
  }
  .log-time { color: var(--ctp-overlay0); }
  .notif-bar {
    height: 52px;
    border-top: 1px solid var(--ctp-surface0);
    padding: 6px 14px;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
  }
  .notif-item {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .notif-time { color: var(--ctp-overlay0); }
  .notif-icon { font-size: 10px; }
  .notif-msg { color: var(--ctp-text); }
</style>
</head>
<body>
<div class="terminal">
  <div class="titlebar">
    <div class="dot red"></div>
    <div class="dot yellow"></div>
    <div class="dot green"></div>
    <div class="title">Claude Workspace Manager</div>
  </div>
  <div class="status-bar">
    <span class="brand">CWM</span>
    <span class="sep">│</span>
    <span class="mode">${vm.label}</span>
    <span class="sep">│</span>
    <span class="ws-name">${activeWs ? activeWs.name : 'No Workspace'}</span>
    <span class="sep">│</span>
    <span class="sess-count">${running}/${sessions.length} sessions</span>
    <span class="sep">│</span>
    <span class="clock">◷ ${timeStr}</span>
    <span class="sep">│</span>
    <span class="help-hint">? help</span>
  </div>
  <div class="main">
    <div class="sidebar">
      <div class="panel-label focused">Workspaces</div>
      ${wsListHtml}
    </div>
    <div class="content-area">
      <div class="top-panel">
        <div class="panel-label"><span style="color:${vm.color}">${vm.label}</span> Sessions</div>
        ${sessListHtml}
      </div>
      <div class="bottom-panel">
        <div class="panel-label">Detail</div>
        ${detailHtml}
      </div>
    </div>
  </div>
  <div class="notif-bar">
    <div class="notif-item">
      <span class="notif-time">${timeStr}</span>
      <span class="notif-icon" style="color:var(--ctp-green)">●</span>
      <span class="notif-msg">Demo workspace data loaded successfully</span>
    </div>
    <div class="notif-item">
      <span class="notif-time">${timeStr}</span>
      <span class="notif-icon" style="color:var(--ctp-blue)">●</span>
      <span class="notif-msg">Press ? for keyboard shortcuts · w workspace · a all · e recent · Ctrl+K search</span>
    </div>
  </div>
</div>
</body>
</html>`;

  const filename = mode === 'all' ? 'all-sessions.html' : 'dashboard.html';
  fs.writeFileSync(path.join(screenshotDir, filename), html, 'utf-8');
  console.log(`  \x1b[32m✓\x1b[0m Generated ${filename}`);
}

/**
 * Generate help dialog HTML screenshot
 */
function generateHelpHTML() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CWM - Help</title>
<style>
  :root { ${CSS_VARS} }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--ctp-crust);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 40px;
    font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
  }
  .terminal {
    background: var(--ctp-base);
    border: 1px solid var(--ctp-surface0);
    border-radius: 12px;
    width: 960px;
    height: 560px;
    overflow: hidden;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
  }
  .overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(17,17,27,0.7);
  }
  .help-box {
    position: relative;
    background: var(--ctp-mantle);
    border: 1px solid var(--ctp-mauve);
    border-radius: 8px;
    width: 440px;
    padding: 20px 24px;
    z-index: 1;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  }
  .help-title {
    color: var(--ctp-mauve);
    font-weight: bold;
    font-size: 14px;
    margin-bottom: 14px;
    text-align: center;
  }
  .section-title {
    color: var(--ctp-mauve);
    font-weight: bold;
    font-size: 12px;
    margin-top: 12px;
    margin-bottom: 4px;
  }
  .shortcut {
    display: flex;
    padding: 2px 0;
    font-size: 12px;
  }
  .key {
    color: var(--ctp-text);
    width: 100px;
    flex-shrink: 0;
  }
  .desc { color: var(--ctp-subtext0); }
  .key-accent { color: var(--ctp-blue); }
  .key-peach { color: var(--ctp-peach); }
  .hint {
    color: var(--ctp-overlay0);
    font-size: 11px;
    margin-top: 14px;
    text-align: center;
  }
</style>
</head>
<body>
<div class="terminal">
  <div class="overlay"></div>
  <div class="help-box">
    <div class="help-title">Keyboard Shortcuts</div>

    <div class="section-title">Navigation</div>
    <div class="shortcut"><span class="key">Tab</span><span class="desc">Cycle focus between panels</span></div>
    <div class="shortcut"><span class="key">j / k</span><span class="desc">Move up / down in lists</span></div>
    <div class="shortcut"><span class="key">Enter</span><span class="desc">Select / activate item</span></div>

    <div class="section-title">View Modes</div>
    <div class="shortcut"><span class="key" style="color:var(--ctp-mauve)">w</span><span class="desc">Workspace sessions (default)</span></div>
    <div class="shortcut"><span class="key key-accent">a</span><span class="desc">All sessions across workspaces</span></div>
    <div class="shortcut"><span class="key key-peach">e</span><span class="desc">Recent sessions</span></div>
    <div class="shortcut"><span class="key" style="color:var(--ctp-mauve)">Ctrl+K</span><span class="desc">Quick switcher (fuzzy search)</span></div>

    <div class="section-title">Workspaces <span style="color:var(--ctp-overlay0)">(left panel)</span></div>
    <div class="shortcut"><span class="key">n</span><span class="desc">Create new workspace</span></div>
    <div class="shortcut"><span class="key">d</span><span class="desc">Delete workspace</span></div>
    <div class="shortcut"><span class="key">r</span><span class="desc">Rename workspace</span></div>

    <div class="section-title">Sessions <span style="color:var(--ctp-overlay0)">(right panel)</span></div>
    <div class="shortcut"><span class="key">n</span><span class="desc">Create new session</span></div>
    <div class="shortcut"><span class="key">s</span><span class="desc">Start session</span></div>
    <div class="shortcut"><span class="key">x</span><span class="desc">Stop session</span></div>
    <div class="shortcut"><span class="key">d</span><span class="desc">Delete session</span></div>

    <div class="section-title">General</div>
    <div class="shortcut"><span class="key">?</span><span class="desc">Show this help</span></div>
    <div class="shortcut"><span class="key">q / Ctrl-c</span><span class="desc">Quit application</span></div>

    <div class="hint">Press Esc or ? to close</div>
  </div>
</div>
</body>
</html>`;

  fs.writeFileSync(path.join(screenshotDir, 'help-dialog.html'), html, 'utf-8');
  console.log('  \x1b[32m✓\x1b[0m Generated help-dialog.html');
}

/**
 * Generate quick switcher HTML screenshot
 */
function generateQuickSwitcherHTML(store) {
  const workspaces = store.getAllWorkspacesList();
  const sessions = store.getAllSessionsList();

  let resultsHtml = '';
  for (const ws of workspaces) {
    const count = store.getWorkspaceSessions(ws.id).length;
    resultsHtml += `<div class="result-item">
      <span class="type-icon" style="color:var(--ctp-mauve)">■</span>
      <span class="result-name">${ws.name}</span>
      <span class="result-detail">${count} sessions</span>
    </div>\n`;
  }
  for (const s of sessions.slice(0, 5)) {
    const ws = store.getWorkspace(s.workspaceId);
    resultsHtml += `<div class="result-item">
      <span class="type-icon" style="color:var(--ctp-blue)">─</span>
      <span class="result-name">${s.name}</span>
      <span class="result-detail">${ws ? ws.name : ''}</span>
    </div>\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CWM - Quick Switcher</title>
<style>
  :root { ${CSS_VARS} }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--ctp-crust);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 40px;
    font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
  }
  .terminal {
    background: var(--ctp-base);
    border: 1px solid var(--ctp-surface0);
    border-radius: 12px;
    width: 960px;
    height: 560px;
    overflow: hidden;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
  }
  .overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(17,17,27,0.7);
  }
  .switcher {
    position: relative;
    background: var(--ctp-mantle);
    border: 1px solid var(--ctp-mauve);
    border-radius: 8px;
    width: 480px;
    z-index: 1;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
    overflow: hidden;
  }
  .switcher-header {
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--ctp-surface0);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .switcher-icon { color: var(--ctp-mauve); font-size: 14px; }
  .switcher-title { color: var(--ctp-mauve); font-weight: bold; font-size: 12px; }
  .search-input {
    background: var(--ctp-surface1);
    border: none;
    color: var(--ctp-text);
    font-family: inherit;
    font-size: 13px;
    padding: 8px 14px;
    width: 100%;
    outline: none;
    border-bottom: 1px solid var(--ctp-surface0);
  }
  .search-input::placeholder { color: var(--ctp-overlay0); }
  .result-item {
    padding: 6px 16px;
    font-size: 12px;
    display: flex;
    gap: 10px;
    align-items: center;
    cursor: pointer;
    transition: background 0.1s;
  }
  .result-item:first-child {
    background: var(--ctp-surface0);
  }
  .result-item:hover { background: var(--ctp-surface0); }
  .type-icon { font-size: 11px; width: 14px; text-align: center; }
  .result-name { color: var(--ctp-text); }
  .result-detail { color: var(--ctp-overlay0); font-size: 11px; margin-left: auto; }
  .switcher-hint {
    padding: 8px 16px;
    border-top: 1px solid var(--ctp-surface0);
    font-size: 11px;
    color: var(--ctp-overlay0);
  }
</style>
</head>
<body>
<div class="terminal">
  <div class="overlay"></div>
  <div class="switcher">
    <div class="switcher-header">
      <span class="switcher-icon">⌕</span>
      <span class="switcher-title">Quick Switcher</span>
    </div>
    <input class="search-input" placeholder="Type to search workspaces and sessions..." value="" readonly>
    ${resultsHtml}
    <div class="switcher-hint">Enter select · ↑↓ navigate · Esc close</div>
  </div>
</div>
</body>
</html>`;

  fs.writeFileSync(path.join(screenshotDir, 'quick-switcher.html'), html, 'utf-8');
  console.log('  \x1b[32m✓\x1b[0m Generated quick-switcher.html');
}

/**
 * Seed demo data
 */
function seedDemoData(store) {
  const ws1 = store.createWorkspace({ name: 'Project Alpha', description: 'Frontend app', color: 'cyan' });
  const ws2 = store.createWorkspace({ name: 'Backend API', description: 'Backend API', color: 'magenta' });
  const ws3 = store.createWorkspace({ name: 'Documentation', description: 'Docs', color: 'yellow' });

  const s1 = store.createSession({ name: 'ui-components', workspaceId: ws1.id, workingDir: 'C:\\Projects\\project-alpha\\src', topic: 'React components', command: 'claude' });
  store.updateSession(s1.id, { status: 'running', pid: 12340 });
  store.addSessionLog(s1.id, 'Session launched with PID 12340');
  store.addSessionLog(s1.id, 'Working on data table component');

  const s2 = store.createSession({ name: 'perf-analysis', workspaceId: ws1.id, workingDir: 'C:\\Projects\\project-alpha\\perf', topic: 'Performance tuning', command: 'claude' });
  store.updateSession(s2.id, { status: 'idle', pid: 12341 });
  store.addSessionLog(s2.id, 'Analyzing render performance');

  const s3 = store.createSession({ name: 'test-runner', workspaceId: ws1.id, workingDir: 'C:\\Projects\\project-alpha\\test', topic: 'Integration tests', command: 'claude' });
  store.updateSession(s3.id, { status: 'stopped' });
  store.addSessionLog(s3.id, 'Tests completed: 47/48 passed');

  const s4 = store.createSession({ name: 'api-endpoints', workspaceId: ws2.id, workingDir: 'C:\\Projects\\backend-api\\src', topic: 'REST API', command: 'claude' });
  store.updateSession(s4.id, { status: 'running', pid: 12345 });

  const s5 = store.createSession({ name: 'db-migrations', workspaceId: ws2.id, workingDir: 'C:\\Projects\\backend-api\\db', topic: 'Database migrations', command: 'claude' });
  store.updateSession(s5.id, { status: 'error' });
  store.addSessionLog(s5.id, 'Migration failed: FK constraint violation');

  store.createSession({ name: 'architecture-docs', workspaceId: ws3.id, workingDir: 'C:\\Projects\\docs', topic: 'Architecture docs', command: 'claude' });

  store.setActiveWorkspace(ws1.id);

  // Touch some sessions as recent
  store.touchRecent(s1.id);
  store.touchRecent(s4.id);
  store.touchRecent(s2.id);

  store.save();
}

// ─── Run ──────────────────────────────────────────
console.log('\n\x1b[1m\x1b[36m  CWM Screenshot Capture (Catppuccin Mocha)\x1b[0m\n');
captureScreenshots();
console.log('');
