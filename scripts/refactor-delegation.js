/**
 * Refactoring script: Convert per-render addEventListener to event delegation
 *
 * This script transforms app.js to use event delegation on persistent container
 * elements instead of creating new event listeners on every render cycle.
 *
 * What it does:
 * 1. Inserts _setupEventDelegation() method after bindEvents()
 * 2. Adds call to _setupEventDelegation() at end of bindEvents()
 * 3. Removes per-render listener blocks from renderWorkspaces(), renderSessions(), renderProjects()
 * 4. Removes overlapping handlers from initDragAndDrop()
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
let code = fs.readFileSync(filePath, 'utf-8');
const originalLength = code.length;

// Helper: remove a block between two unique markers (inclusive of start, exclusive of end)
function removeBetween(src, startMarker, endMarker, inclusive = 'start') {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    console.error(`START MARKER NOT FOUND: "${startMarker.substring(0, 60)}..."`);
    process.exit(1);
  }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    console.error(`END MARKER NOT FOUND: "${endMarker.substring(0, 60)}..."`);
    process.exit(1);
  }

  if (inclusive === 'start') {
    // Remove from start of startMarker to start of endMarker
    return src.substring(0, startIdx) + src.substring(endIdx);
  } else if (inclusive === 'both') {
    return src.substring(0, startIdx) + src.substring(endIdx + endMarker.length);
  }
  return src;
}

// ═══════════════════════════════════════════════════════════
// STEP 1: Insert _setupEventDelegation() method after bindEvents()
// ═══════════════════════════════════════════════════════════

const delegationMethod = `
  /* ═══════════════════════════════════════════════════════════
     EVENT DELEGATION
     One-time setup on persistent container elements.
     Replaces per-render addEventListener in render methods.
     ═══════════════════════════════════════════════════════════ */

  _setupEventDelegation() {

    // ── WORKSPACE SIDEBAR LIST ───────────────────────────────
    const wsList = this.els.workspaceList;
    let wsLPTimer = null;

    // Click delegation
    wsList.addEventListener('click', (e) => {
      if (e.target.closest('#sidebar-create-ws')) { this.createWorkspace(); return; }

      const renameBtn = e.target.closest('.ws-rename-btn');
      if (renameBtn) { e.stopPropagation(); this.renameWorkspace(renameBtn.dataset.id); return; }

      const deleteBtn = e.target.closest('.ws-delete-btn');
      if (deleteBtn) { e.stopPropagation(); this.deleteWorkspace(deleteBtn.dataset.id); return; }

      const wsSessionItem = e.target.closest('.ws-session-item');
      if (wsSessionItem) {
        e.stopPropagation();
        const sessionId = wsSessionItem.dataset.sessionId;
        const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
        if (!session) return;
        if (this.state.viewMode === 'terminal') {
          const emptySlot = this.terminalPanes.findIndex(p => p === null);
          if (emptySlot !== -1) {
            if (!session.resumeSessionId) this.showToast('Starting new Claude session (no previous conversation to resume)', 'info');
            const spawnOpts = {};
            if (session.resumeSessionId) spawnOpts.resumeSessionId = session.resumeSessionId;
            if (session.workingDir) spawnOpts.cwd = session.workingDir;
            if (session.command) spawnOpts.command = session.command;
            if (session.bypassPermissions) spawnOpts.bypassPermissions = true;
            if (session.verbose) spawnOpts.verbose = true;
            if (session.model) spawnOpts.model = session.model;
            if (session.agentTeams) spawnOpts.agentTeams = true;
            this.openTerminalInPane(emptySlot, sessionId, session.name, spawnOpts);
          } else {
            this.showToast('All terminal panes are full. Close one first.', 'warning');
          }
        } else {
          this.selectSession(sessionId);
        }
        return;
      }

      const projectGroupHeader = e.target.closest('.ws-project-group-header');
      if (projectGroupHeader) {
        e.stopPropagation();
        const group = projectGroupHeader.closest('.ws-project-group');
        const body = group.querySelector('.ws-project-group-body');
        const chevron = projectGroupHeader.querySelector('.ws-project-group-chevron');
        const key = group.dataset.groupKey;
        const isCollapsed = body.classList.toggle('collapsed');
        chevron.classList.toggle('collapsed', isCollapsed);
        const st = JSON.parse(localStorage.getItem('cwm_projectGroupState') || '{}');
        st[key] = !isCollapsed;
        localStorage.setItem('cwm_projectGroupState', JSON.stringify(st));
        return;
      }

      const groupHeader = e.target.closest('.workspace-group-header');
      if (groupHeader) {
        const group = groupHeader.closest('.workspace-group');
        if (!group) return;
        const items = group.querySelector('.workspace-group-items');
        const chevron = groupHeader.querySelector('.group-chevron');
        if (items) items.hidden = !items.hidden;
        if (chevron) chevron.classList.toggle('open', items && !items.hidden);
        if (!this._groupCollapseState) this._groupCollapseState = {};
        const gid = groupHeader.dataset.groupId;
        this._groupCollapseState[gid] = items ? items.hidden : false;
        try { localStorage.setItem('cwm_groupCollapseState', JSON.stringify(this._groupCollapseState)); } catch (_) {}
        return;
      }

      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        const wsId = workspaceItem.dataset.id;
        const isAlreadyActive = this.state.activeWorkspace && this.state.activeWorkspace.id === wsId;
        if (isAlreadyActive) {
          const accordion = workspaceItem.closest('.workspace-accordion');
          if (accordion) {
            const body = accordion.querySelector('.workspace-accordion-body');
            const chevron = workspaceItem.querySelector('.ws-chevron');
            if (body) body.hidden = !body.hidden;
            if (chevron) chevron.classList.toggle('open', body && !body.hidden);
          }
        } else {
          wsList.querySelectorAll('.workspace-accordion-body').forEach(b => b.hidden = true);
          wsList.querySelectorAll('.ws-chevron').forEach(c => c.classList.remove('open'));
          this.selectWorkspace(wsId);
        }
        return;
      }
    });

    // Context menu delegation
    wsList.addEventListener('contextmenu', (e) => {
      const wsSessionItem = e.target.closest('.ws-session-item');
      if (wsSessionItem) {
        e.preventDefault(); e.stopPropagation();
        this.showContextMenu(wsSessionItem.dataset.sessionId, e.clientX, e.clientY);
        return;
      }
      const projectGroupHeader = e.target.closest('.ws-project-group-header');
      if (projectGroupHeader) {
        e.preventDefault(); e.stopPropagation();
        const dir = projectGroupHeader.dataset.dir;
        const wsId = projectGroupHeader.dataset.wsId;
        if (!dir || !wsId) return;
        const parts = dir.replace(/\\\\/g, '/').split('/');
        const shortDir = parts.slice(-2).join('/');
        this._renderContextItems(shortDir, [
          { label: 'New Session Here', icon: '&#9654;', action: () => this.createSessionInDir(wsId, dir) },
          { label: 'New Session (Bypass)', icon: '&#9888;', action: () => this.createSessionInDir(wsId, dir, { bypassPermissions: true }) },
        ], e.clientX, e.clientY);
        return;
      }
      const groupHeader = e.target.closest('.workspace-group-header');
      if (groupHeader) {
        e.preventDefault(); e.stopPropagation();
        this.showGroupContextMenu(groupHeader.dataset.groupId, e.clientX, e.clientY);
        return;
      }
      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        e.preventDefault(); e.stopPropagation();
        this.showWorkspaceContextMenu(workspaceItem.dataset.id, e.clientX, e.clientY);
        return;
      }
    });

    // Touch long-press delegation
    wsList.addEventListener('touchstart', (e) => {
      clearTimeout(wsLPTimer);
      const wsSessionItem = e.target.closest('.ws-session-item');
      if (wsSessionItem) {
        wsLPTimer = setTimeout(() => {
          const touch = e.touches[0];
          if (touch) this.showContextMenu(wsSessionItem.dataset.sessionId, touch.clientX, touch.clientY);
        }, 500);
        return;
      }
      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        wsLPTimer = setTimeout(() => {
          const touch = e.touches[0];
          if (touch) this.showWorkspaceContextMenu(workspaceItem.dataset.id, touch.clientX, touch.clientY);
        }, 500);
        return;
      }
      const groupHeader = e.target.closest('.workspace-group-header');
      if (groupHeader) {
        wsLPTimer = setTimeout(() => {
          const touch = e.touches[0];
          if (touch) this.showGroupContextMenu(groupHeader.dataset.groupId, touch.clientX, touch.clientY);
        }, 500);
        return;
      }
    }, { passive: false });
    wsList.addEventListener('touchend', () => clearTimeout(wsLPTimer));
    wsList.addEventListener('touchmove', () => clearTimeout(wsLPTimer));

    // Double-click for inline rename
    wsList.addEventListener('dblclick', (e) => {
      const nameEl = e.target.closest('.ws-session-name');
      if (nameEl) {
        e.stopPropagation();
        const sessionItem = nameEl.closest('.ws-session-item');
        if (sessionItem) this.startInlineRename(nameEl, sessionItem.dataset.sessionId, true);
      }
    });

    // Drag start/end delegation
    wsList.addEventListener('dragstart', (e) => {
      const wsSessionItem = e.target.closest('.ws-session-item');
      if (wsSessionItem) {
        e.stopPropagation();
        console.log('[DnD] Drag started: ws-session-item', wsSessionItem.dataset.sessionId);
        e.dataTransfer.setData('cwm/session', wsSessionItem.dataset.sessionId);
        e.dataTransfer.effectAllowed = 'move';
        wsSessionItem.classList.add('dragging');
        return;
      }
      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        e.dataTransfer.setData('cwm/workspace', workspaceItem.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        workspaceItem.classList.add('dragging');
        return;
      }
    });

    wsList.addEventListener('dragend', (e) => {
      const el = e.target.closest('.ws-session-item, .workspace-item');
      if (el) el.classList.remove('dragging');
    });

    // Drag over/leave/drop delegation (handles session move, workspace reorder,
    // project drop, project-session drop, group drop, and ungroup)
    wsList.addEventListener('dragover', (e) => {
      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        if (e.dataTransfer.types.includes('cwm/session')) {
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          workspaceItem.classList.add('workspace-drop-target');
        } else if (e.dataTransfer.types.includes('cwm/workspace')) {
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          const rect = workspaceItem.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          workspaceItem.classList.remove('ws-drop-before', 'ws-drop-after');
          workspaceItem.classList.add(e.clientY < midY ? 'ws-drop-before' : 'ws-drop-after');
        } else if (e.dataTransfer.types.includes('cwm/project') || e.dataTransfer.types.includes('cwm/project-session')) {
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
          workspaceItem.classList.add('drag-over');
        }
        return;
      }
      const groupHeader = e.target.closest('.workspace-group-header');
      if (groupHeader) {
        if (e.dataTransfer.types.includes('cwm/workspace')) {
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          groupHeader.classList.add('group-drop-target');
        }
        return;
      }
      // List background drop (for ungrouping workspace)
      if (!e.dataTransfer.types.includes('cwm/workspace')) return;
      if (e.target.closest('.workspace-item') || e.target.closest('.workspace-group-header')) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      wsList.classList.add('workspace-list-drop-target');
    });

    wsList.addEventListener('dragleave', (e) => {
      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) workspaceItem.classList.remove('workspace-drop-target', 'ws-drop-before', 'ws-drop-after', 'drag-over');
      const groupHeader = e.target.closest('.workspace-group-header');
      if (groupHeader) groupHeader.classList.remove('group-drop-target');
      if (!wsList.contains(e.relatedTarget)) wsList.classList.remove('workspace-list-drop-target');
    });

    wsList.addEventListener('drop', async (e) => {
      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        const dropBefore = workspaceItem.classList.contains('ws-drop-before');
        workspaceItem.classList.remove('workspace-drop-target', 'ws-drop-before', 'ws-drop-after', 'drag-over');
        const targetWsId = workspaceItem.dataset.id;

        // Session move to workspace
        const sessionId = e.dataTransfer.getData('cwm/session');
        if (sessionId) {
          e.preventDefault(); e.stopPropagation();
          const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
          if (session && session.workspaceId !== targetWsId) this.moveSessionToWorkspace(sessionId, targetWsId);
          return;
        }
        // Project-session drop (create session from individual .jsonl)
        const projSessJson = e.dataTransfer.getData('cwm/project-session');
        if (projSessJson) {
          e.preventDefault(); e.stopPropagation();
          try {
            const ps = JSON.parse(projSessJson);
            const claudeSessionId = ps.sessionName;
            const projectName = ps.projectPath ? (ps.projectPath.split('\\\\').pop() || ps.projectPath.split('/').pop() || claudeSessionId) : claudeSessionId;
            const shortId = claudeSessionId.length > 8 ? claudeSessionId.substring(0, 8) : claudeSessionId;
            const friendlyName = projectName + ' (' + shortId + ')';
            await this.api('POST', '/api/sessions', {
              name: friendlyName, workspaceId: targetWsId, workingDir: ps.projectPath,
              topic: 'Resumed session', command: 'claude', resumeSessionId: claudeSessionId,
            });
            this.showToast(\`Session "\${friendlyName}" added\`, 'success');
            await this.loadSessions();
            await this.loadStats();
            this.renderWorkspaces();
          } catch (err) {
            this.showToast(err.message || 'Failed to create session', 'error');
          }
          return;
        }
        // Project drop (create session from entire project)
        const projectJson = e.dataTransfer.getData('cwm/project');
        if (projectJson) {
          e.preventDefault(); e.stopPropagation();
          try {
            const project = JSON.parse(projectJson);
            await this.api('POST', '/api/sessions', {
              name: project.name, workspaceId: targetWsId, workingDir: project.path,
              topic: '', command: 'claude',
            });
            this.showToast(\`Session "\${project.name}" created\`, 'success');
            await this.loadSessions();
            await this.loadStats();
          } catch (err) {
            this.showToast(err.message || 'Failed to create session from project', 'error');
          }
          return;
        }
        // Workspace reorder
        const draggedWsId = e.dataTransfer.getData('cwm/workspace');
        if (draggedWsId && draggedWsId !== targetWsId) {
          e.preventDefault(); e.stopPropagation();
          this.reorderWorkspace(draggedWsId, targetWsId, dropBefore ? 'before' : 'after');
        }
        return;
      }

      const groupHeader = e.target.closest('.workspace-group-header');
      if (groupHeader) {
        groupHeader.classList.remove('group-drop-target');
        const workspaceId = e.dataTransfer.getData('cwm/workspace');
        if (workspaceId) { e.preventDefault(); this.moveWorkspaceToGroup(workspaceId, groupHeader.dataset.groupId); }
        return;
      }

      // List background drop (ungroup workspace)
      wsList.classList.remove('workspace-list-drop-target');
      const workspaceId = e.dataTransfer.getData('cwm/workspace');
      if (!workspaceId) return;
      const groups = this.state.groups || [];
      const inGroup = groups.find(g => (g.workspaceIds || []).includes(workspaceId));
      if (inGroup) { e.preventDefault(); e.stopPropagation(); this.removeWorkspaceFromGroup(workspaceId); }
    });

    // ── SESSION LIST (main panel) ────────────────────────────
    const sessList = this.els.sessionList;
    let sessLPTimer = null;

    sessList.addEventListener('click', (e) => {
      const item = e.target.closest('.session-item');
      if (item) this.selectSession(item.dataset.id);
    });

    sessList.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.session-item');
      if (item) { e.preventDefault(); e.stopPropagation(); this.showContextMenu(item.dataset.id, e.clientX, e.clientY); }
    });

    sessList.addEventListener('touchstart', (e) => {
      clearTimeout(sessLPTimer);
      const item = e.target.closest('.session-item');
      if (item) {
        sessLPTimer = setTimeout(() => {
          const touch = e.touches[0];
          if (touch) this.showContextMenu(item.dataset.id, touch.clientX, touch.clientY);
        }, 500);
      }
    }, { passive: false });
    sessList.addEventListener('touchend', () => clearTimeout(sessLPTimer));
    sessList.addEventListener('touchmove', () => clearTimeout(sessLPTimer));

    // Session list drag (moved from initDragAndDrop)
    sessList.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.session-item');
      if (!item) return;
      console.log('[DnD] Drag started: session-item', item.dataset.id);
      e.dataTransfer.setData('cwm/session', item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    sessList.addEventListener('dragend', (e) => {
      const item = e.target.closest('.session-item');
      if (item) item.classList.remove('dragging');
    });

    // ── PROJECTS LIST ────────────────────────────────────────
    const projList = this.els.projectsList;
    if (projList) {
      let projLPTimer = null;

      projList.addEventListener('click', (e) => {
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          if (e.target.closest('.project-session-item')) return;
          const accordion = header.closest('.project-accordion');
          const body = accordion.querySelector('.project-accordion-body');
          const chevron = header.querySelector('.project-accordion-chevron');
          body.hidden = !body.hidden;
          chevron.classList.toggle('open', !body.hidden);
        }
      });

      projList.addEventListener('contextmenu', (e) => {
        const sessionItem = e.target.closest('.project-session-item');
        if (sessionItem) {
          e.preventDefault(); e.stopPropagation();
          this.showProjectSessionContextMenu(sessionItem.dataset.sessionName, sessionItem.dataset.projectPath, e.clientX, e.clientY);
          return;
        }
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          e.preventDefault(); e.stopPropagation();
          const accordion = header.closest('.project-accordion');
          this.showProjectContextMenu(accordion.dataset.encoded, header.querySelector('.project-name').textContent, accordion.dataset.path, e.clientX, e.clientY);
        }
      });

      projList.addEventListener('dragstart', (e) => {
        const sessionItem = e.target.closest('.project-session-item');
        if (sessionItem) {
          e.stopPropagation();
          e.dataTransfer.setData('cwm/project-session', JSON.stringify({
            sessionName: sessionItem.dataset.sessionName,
            projectPath: sessionItem.dataset.projectPath,
            projectEncoded: sessionItem.dataset.projectEncoded,
          }));
          e.dataTransfer.effectAllowed = 'copy';
          sessionItem.classList.add('dragging');
          return;
        }
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          const accordion = header.closest('.project-accordion');
          e.dataTransfer.setData('cwm/project', JSON.stringify({
            encoded: accordion.dataset.encoded,
            path: accordion.dataset.path,
            name: header.querySelector('.project-name').textContent,
          }));
          e.dataTransfer.effectAllowed = 'copy';
          header.classList.add('dragging');
        }
      });
      projList.addEventListener('dragend', (e) => {
        const el = e.target.closest('.project-session-item, .project-accordion-header');
        if (el) el.classList.remove('dragging');
      });

      projList.addEventListener('touchstart', (e) => {
        clearTimeout(projLPTimer);
        const sessionItem = e.target.closest('.project-session-item');
        if (sessionItem) {
          projLPTimer = setTimeout(() => {
            const touch = e.touches[0];
            if (touch) this.showProjectSessionContextMenu(sessionItem.dataset.sessionName, sessionItem.dataset.projectPath, touch.clientX, touch.clientY);
          }, 500);
          return;
        }
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          projLPTimer = setTimeout(() => {
            const touch = e.touches[0];
            if (touch) {
              const accordion = header.closest('.project-accordion');
              this.showProjectContextMenu(accordion.dataset.encoded, header.querySelector('.project-name').textContent, accordion.dataset.path, touch.clientX, touch.clientY);
            }
          }, 500);
        }
      }, { passive: false });
      projList.addEventListener('touchend', () => clearTimeout(projLPTimer));
      projList.addEventListener('touchmove', () => clearTimeout(projLPTimer));
    }
  }

`;

// Find the insertion point: after bindEvents() closing brace, before async init()
const bindEventsEndMarker = '  }\n\n  async init() {';
const insertionIdx = code.indexOf(bindEventsEndMarker);
if (insertionIdx === -1) {
  console.error('Could not find bindEvents/init boundary');
  process.exit(1);
}
// Insert delegation method between bindEvents closing and init
code = code.substring(0, insertionIdx + 4) + // includes "  }\n"
  delegationMethod +
  '\n' + code.substring(insertionIdx + 4); // keeps "  async init() {"

console.log('✓ Inserted _setupEventDelegation() method');

// ═══════════════════════════════════════════════════════════
// STEP 2: Add call to _setupEventDelegation() at end of bindEvents()
// ═══════════════════════════════════════════════════════════

// Find the last line inside bindEvents - the closing of the mobile toolbar section
// Look for the pattern where bindEvents ends
const bindEventsCallMarker = "        if (data) {\n          activePane.ws.send(JSON.stringify({ type: 'input', data }));\n        }\n      });\n    });\n  }";
const callIdx = code.indexOf(bindEventsCallMarker);
if (callIdx === -1) {
  console.error('Could not find bindEvents end for call insertion');
  process.exit(1);
}
// Insert before the closing brace of bindEvents
const insertCallBefore = "    });\n  }";
const callInsertIdx = code.indexOf(insertCallBefore, callIdx);
code = code.substring(0, callInsertIdx) +
  "    });\n\n    // Set up event delegation on persistent containers (replaces per-render addEventListener)\n    this._setupEventDelegation();\n  }" +
  code.substring(callInsertIdx + insertCallBefore.length);

console.log('✓ Added _setupEventDelegation() call in bindEvents()');

// ═══════════════════════════════════════════════════════════
// STEP 3: Remove per-render listeners from renderWorkspaces()
// ═══════════════════════════════════════════════════════════

// The block starts with "// Bind workspace item events" and ends right before
// "this.els.workspaceCount.textContent"
const wsBindStart = '    // Bind workspace item events';
const wsBindEnd = "    this.els.workspaceCount.textContent = `${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''}`;";

const wsStartIdx = code.indexOf(wsBindStart);
const wsEndIdx = code.indexOf(wsBindEnd);

if (wsStartIdx === -1 || wsEndIdx === -1) {
  console.error('Could not find renderWorkspaces binding block');
  process.exit(1);
}

// Remove everything from wsBindStart to just before wsBindEnd
// Find the start of the line (go back to newline)
const wsLineStart = code.lastIndexOf('\n', wsStartIdx) + 1;
code = code.substring(0, wsLineStart) + '\n' + code.substring(wsEndIdx);

console.log('✓ Removed per-render listeners from renderWorkspaces()');

// ═══════════════════════════════════════════════════════════
// STEP 4: Remove per-render listeners from renderSessions()
// ═══════════════════════════════════════════════════════════

// Block starts with "    // Bind events" (inside renderSessions)
// and ends with the touchmove clearTimeout line, before "// Async: patch in git branch"
const sessBindStart = '    // Bind events\n    list.querySelectorAll(\'.session-item\').forEach(el => {';
const sessBindEnd = '    // Async: patch in git branch badges';

const sessStartIdx = code.indexOf(sessBindStart);
const sessEndIdx = code.indexOf(sessBindEnd);

if (sessStartIdx === -1 || sessEndIdx === -1) {
  console.error('Could not find renderSessions binding block');
  console.error('sessStart found:', sessStartIdx !== -1);
  console.error('sessEnd found:', sessEndIdx !== -1);
  process.exit(1);
}

const sessLineStart = code.lastIndexOf('\n', sessStartIdx) + 1;
code = code.substring(0, sessLineStart) + '\n' + code.substring(sessEndIdx);

console.log('✓ Removed per-render listeners from renderSessions()');

// ═══════════════════════════════════════════════════════════
// STEP 5: Remove per-render listeners from renderProjects()
// ═══════════════════════════════════════════════════════════

// Block starts with "// Bind accordion toggle"
// and ends with the closing of the project-session-item forEach, before toggleProjectsPanel
const projBindStart = '    // Bind accordion toggle\n    list.querySelectorAll(\'.project-accordion-header\').forEach(header => {';
const projBindEnd = '  toggleProjectsPanel()';

const projStartIdx = code.indexOf(projBindStart);
const projEndIdx = code.indexOf(projBindEnd);

if (projStartIdx === -1 || projEndIdx === -1) {
  console.error('Could not find renderProjects binding block');
  console.error('projStart found:', projStartIdx !== -1);
  console.error('projEnd found:', projEndIdx !== -1);
  process.exit(1);
}

// Remove from projBindStart to just before the closing of renderProjects (the "}" + newline before toggleProjectsPanel)
const projLineStart = code.lastIndexOf('\n', projStartIdx) + 1;
// We need to find the "  }\n\n  toggleProjectsPanel" boundary
const projMethodEnd = code.lastIndexOf('\n', projEndIdx);
const projBlockEnd = code.lastIndexOf('\n', projMethodEnd - 1);
// Actually, let's find "  }\n\n  toggleProjectsPanel" and keep everything from "  }" onwards
const projCloseMarker = '  }\n\n  toggleProjectsPanel()';
const projCloseIdx = code.indexOf(projCloseMarker, projStartIdx);
if (projCloseIdx === -1) {
  console.error('Could not find renderProjects close');
  process.exit(1);
}
code = code.substring(0, projLineStart) + code.substring(projCloseIdx);

console.log('✓ Removed per-render listeners from renderProjects()');

// ═══════════════════════════════════════════════════════════
// STEP 6: Remove session + workspace drag handlers from initDragAndDrop()
// ═══════════════════════════════════════════════════════════

// The session list drag handlers (now in delegation):
const dndSessionStart = '    // Session items: make draggable\n    this.els.sessionList.addEventListener(\'dragstart\'';
const dndSessionEnd = '    // Workspace items: accept project + project-session drops';

const dndSessStartIdx = code.indexOf(dndSessionStart);
const dndSessEndIdx = code.indexOf(dndSessionEnd);

if (dndSessStartIdx === -1 || dndSessEndIdx === -1) {
  console.error('Could not find initDragAndDrop session handlers');
  console.error('dndSessStart found:', dndSessStartIdx !== -1);
  console.error('dndSessEnd found:', dndSessEndIdx !== -1);
  // Not fatal - skip this step
} else {
  const dndSessLineStart = code.lastIndexOf('\n', dndSessStartIdx) + 1;
  code = code.substring(0, dndSessLineStart) + code.substring(dndSessEndIdx);
  console.log('✓ Removed session drag handlers from initDragAndDrop()');
}

// The workspace list project/project-session drop handlers (now in delegation):
const dndWsStart = '    // Workspace items: accept project + project-session drops';
const dndWsEnd = '    // Terminal panes: accept session and project drops';

const dndWsStartIdx = code.indexOf(dndWsStart);
const dndWsEndIdx = code.indexOf(dndWsEnd);

if (dndWsStartIdx === -1 || dndWsEndIdx === -1) {
  console.error('Could not find initDragAndDrop workspace handlers');
  // Not fatal - skip
} else {
  const dndWsLineStart = code.lastIndexOf('\n', dndWsStartIdx) + 1;
  code = code.substring(0, dndWsLineStart) + code.substring(dndWsEndIdx);
  console.log('✓ Removed workspace drop handlers from initDragAndDrop()');
}


// ═══════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════

// Count addEventListener before/after
const beforeCount = fs.readFileSync(filePath, 'utf-8').match(/addEventListener/g)?.length || 0;
const afterCount = (code.match(/addEventListener/g) || []).length;
const removeCount = (code.match(/removeEventListener/g) || []).length;

console.log('\n=== VALIDATION ===');
console.log(`addEventListener count: ${beforeCount} → ${afterCount} (removed ${beforeCount - afterCount})`);
console.log(`removeEventListener count: ${removeCount}`);
console.log(`File size: ${originalLength} → ${code.length} chars (${code.length > originalLength ? '+' : ''}${code.length - originalLength})`);
console.log(`Line count: ${code.split('\n').length}`);

// Write the result
fs.writeFileSync(filePath, code);
console.log('\n✓ File written successfully');
