#!/usr/bin/env node
/**
 * One-shot recovery script for the 2026-05-19 incident.
 *
 * Background: tests pointed CWM_DATA_DIR at ./state/ and on 2026-05-11 wiped
 * the real workspaces.json with 1019 pty-test-ws-* / codex-test-ws-* entries.
 * The May 13 clean backup restores the session records, but ~/.myrlin/layout.json
 * was modified after May 13 and now references sessionIds the May 13 backup
 * doesn't know about. This script rebinds every orphan pane to either:
 *   (a) a matching session in the restored workspaces.json (by name+workspace), or
 *   (b) a freshly inserted session record carrying the pane's own metadata.
 *
 * Also clears resumeSessionIds whose upstream JSONL is no longer on disk so
 * `claude --resume <missing>` doesn't fail when you click "start".
 *
 * Writes to /tmp first, verifies, then atomically replaces both files. The
 * already-running workbook picks the changes up via checkDiskSync() on the
 * next /api/* GET.
 *
 * Usage:
 *   node scripts/recover-orphan-panes.js --dry-run    # print plan, write nothing
 *   node scripts/recover-orphan-panes.js              # apply
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const STATE_FILE = path.join(os.homedir(), '.myrlin', 'workspaces.json');
const LAYOUT_FILE = path.join(os.homedir(), '.myrlin', 'layout.json');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const layout = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

// Index restored data.
const sessionIds = new Set(Object.keys(state.sessions || {}));
const wsByName = {};
for (const w of Object.values(state.workspaces || {})) {
  if (!wsByName[w.name]) wsByName[w.name] = [];
  wsByName[w.name].push(w);
}
const sessionsByWs = {};
for (const s of Object.values(state.sessions || {})) {
  if (!sessionsByWs[s.workspaceId]) sessionsByWs[s.workspaceId] = [];
  sessionsByWs[s.workspaceId].push(s);
}

// On-disk Claude JSONL transcripts (so we know which resumeIds are still valid).
const onDisk = new Set();
for (const proj of fs.readdirSync(CLAUDE_PROJECTS)) {
  const dir = path.join(CLAUDE_PROJECTS, proj);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.jsonl')) onDisk.add(f.replace(/\.jsonl$/, ''));
  }
}

/**
 * Find a session in the restored state that matches a pane.
 * Tries exact name match first, then prefix match (handles truncated names).
 */
function findMatch(groupName, paneName) {
  const candidates = (wsByName[groupName] || []).flatMap((w) => sessionsByWs[w.id] || []);
  let m = candidates.find((s) => s.name === paneName);
  if (m) return { match: m, mode: 'exact' };
  m = candidates.find(
    (s) =>
      paneName.toLowerCase().startsWith((s.name || '').toLowerCase()) ||
      (s.name || '').toLowerCase().startsWith(paneName.toLowerCase())
  );
  if (m) return { match: m, mode: 'prefix' };
  return null;
}

/** Pick a workspace by tab group name. Prefers the workspace with most sessions. */
function pickWorkspaceForGroup(groupName) {
  const candidates = wsByName[groupName] || [];
  if (!candidates.length) return null;
  return candidates
    .map((w) => ({ w, count: (sessionsByWs[w.id] || []).length }))
    .sort((a, b) => b.count - a.count)[0].w;
}

const plan = {
  rewrites: [], // {group, paneName, oldSid, newSid, mode}
  inserts: [], // {sessionId, name, workspaceId, workspaceName, cwd, command, resumeSessionId}
  resumeClears: [], // {group, paneName, clearedResume}
};

const insertSet = new Set(); // dedup inserts (e.g., shared b22e13aa)

for (const g of layout.tabGroups || []) {
  for (const p of g.panes) {
    const sid = p.sessionId || '';
    if (sid.startsWith('proj-') || sessionIds.has(sid)) continue;

    const paneResume = (p.spawnOpts && p.spawnOpts.resumeSessionId) || '';

    // (a) name match
    const found = findMatch(g.name, p.sessionName);
    if (found) {
      plan.rewrites.push({
        group: g.name,
        paneName: p.sessionName,
        oldSid: sid,
        newSid: found.match.id,
        mode: found.mode,
      });
      // The pane keeps its own spawnOpts, but if the pane's resumeSessionId
      // points at a JSONL that no longer exists on disk, clear it so resume
      // doesn't fail later. Pane is still usable (starts a fresh conversation).
      if (paneResume && !onDisk.has(paneResume)) {
        plan.resumeClears.push({
          group: g.name,
          paneName: p.sessionName,
          clearedResume: paneResume,
        });
      }
      continue;
    }

    // (b) unmatched — insert a fresh session record carrying the pane's metadata.
    const ws = pickWorkspaceForGroup(g.name);
    if (!ws) {
      console.warn('NO WORKSPACE FOR GROUP:', g.name, '— skipping pane', p.sessionName);
      continue;
    }
    if (!insertSet.has(sid)) {
      insertSet.add(sid);
      plan.inserts.push({
        sessionId: sid,
        name: p.sessionName,
        workspaceId: ws.id,
        workspaceName: ws.name,
        cwd: (p.spawnOpts && p.spawnOpts.cwd) || '',
        command: (p.spawnOpts && p.spawnOpts.command) || 'claude',
        resumeSessionId: paneResume && onDisk.has(paneResume) ? paneResume : '',
        bypassPermissions: !!(p.spawnOpts && p.spawnOpts.bypassPermissions),
      });
      if (paneResume && !onDisk.has(paneResume)) {
        plan.resumeClears.push({
          group: g.name,
          paneName: p.sessionName,
          clearedResume: paneResume,
        });
      }
    }
  }
}

console.log('=== PLAN ===');
console.log('Rewrites:', plan.rewrites.length);
plan.rewrites.forEach((r) =>
  console.log(`  [${r.mode.padEnd(6)}] ${r.group} / ${r.paneName.slice(0, 38)} : ${r.oldSid.slice(0, 8)} -> ${r.newSid.slice(0, 8)}`)
);
console.log('Inserts:', plan.inserts.length);
plan.inserts.forEach((i) =>
  console.log(`  ${i.workspaceName} / ${i.name} : sid=${i.sessionId.slice(0, 8)} resume=${(i.resumeSessionId || '-').slice(0, 8)} cwd=${i.cwd}`)
);
console.log('Resume clears:', plan.resumeClears.length);
plan.resumeClears.forEach((c) =>
  console.log(`  ${c.group} / ${c.paneName.slice(0, 38)} : drop resume ${c.clearedResume.slice(0, 8)}`)
);

if (DRY) {
  console.log('\n(dry run — no files written)');
  process.exit(0);
}

// Apply.
const layoutPatched = JSON.parse(JSON.stringify(layout));
for (const g of layoutPatched.tabGroups || []) {
  for (const p of g.panes) {
    const rw = plan.rewrites.find(
      (r) => r.group === g.name && r.paneName === p.sessionName && r.oldSid === p.sessionId
    );
    if (rw) p.sessionId = rw.newSid;
    const rc = plan.resumeClears.find(
      (c) => c.group === g.name && c.paneName === p.sessionName
    );
    if (rc && p.spawnOpts) delete p.spawnOpts.resumeSessionId;
  }
}

const statePatched = JSON.parse(JSON.stringify(state));
const now = new Date().toISOString();
for (const ins of plan.inserts) {
  // Add to sessions map
  statePatched.sessions[ins.sessionId] = {
    id: ins.sessionId,
    workspaceId: ins.workspaceId,
    name: ins.name,
    workingDir: ins.cwd || '',
    command: ins.command || 'claude',
    provider: 'claude',
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
    logs: [],
    pid: null,
    startedAt: null,
    stoppedAt: null,
    resumeSessionId: ins.resumeSessionId || undefined,
    bypassPermissions: !!ins.bypassPermissions,
  };
  // Cross-link in workspace.sessions array if the workspace shape uses one
  const wsRec = statePatched.workspaces[ins.workspaceId];
  if (wsRec) {
    if (!Array.isArray(wsRec.sessions)) wsRec.sessions = [];
    if (!wsRec.sessions.includes(ins.sessionId)) wsRec.sessions.push(ins.sessionId);
  }
}

// Atomic write: temp + rename, layout first then state.
function atomicWrite(file, data) {
  const tmp = file + '.recover.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
atomicWrite(LAYOUT_FILE, layoutPatched);
atomicWrite(STATE_FILE, statePatched);

// Also keep the legacy ./state/ copy in sync so a future migration can't bring
// a stale version back. (Same content, just keeping the two mirrors aligned.)
const legacyState = path.join(process.cwd(), 'state', 'workspaces.json');
const legacyBackup = path.join(process.cwd(), 'state', 'workspaces.backup.json');
if (fs.existsSync(path.dirname(legacyState))) {
  fs.copyFileSync(STATE_FILE, legacyState);
  fs.copyFileSync(STATE_FILE, legacyBackup);
}

// Force newer mtime so the running process's checkDiskSync notices.
const future = new Date(Date.now() + 1000);
fs.utimesSync(LAYOUT_FILE, future, future);
fs.utimesSync(STATE_FILE, future, future);

console.log('\n=== APPLIED ===');
console.log('rewrites:', plan.rewrites.length, '| inserts:', plan.inserts.length, '| resume clears:', plan.resumeClears.length);
