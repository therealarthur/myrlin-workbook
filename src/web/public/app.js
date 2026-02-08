/* ═══════════════════════════════════════════════════════════════
   Claude Workspace Manager — Frontend Application
   Vanilla JS SPA with Catppuccin Mocha theme
   ═══════════════════════════════════════════════════════════════ */

/* ─── Global Error Handler: Fallback Recovery ─────────────── */

window.__cwmInitTimeout = setTimeout(() => {
  // If CWMApp hasn't initialized within 5 seconds, something is very wrong
  if (!window.cwm) window.dispatchEvent(new ErrorEvent('error', { message: 'CWMApp failed to initialize' }));
}, 5000);

window.addEventListener('error', function _cwmFallbackHandler(e) {
  // Only act if CWMApp failed to construct (real crash, not minor runtime error)
  if (window.cwm) return;

  // Prevent multiple triggers
  window.removeEventListener('error', _cwmFallbackHandler);
  clearTimeout(window.__cwmInitTimeout);

  // Check if server is healthy (problem is frontend, not backend)
  fetch('/api/health').then(r => r.json()).then(data => {
    if (data.status !== 'ok') return;

    // Server is fine — show fallback recovery UI
    document.body.innerHTML = `
      <div style="
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        min-height:100vh;background:#1e1e2e;color:#cdd6f4;font-family:system-ui,sans-serif;
        padding:24px;text-align:center;
      ">
        <div style="max-width:420px;">
          <div style="font-size:48px;margin-bottom:16px;">&#9888;</div>
          <h2 style="margin:0 0 8px;font-size:20px;color:#f38ba8;">UI Failed to Load</h2>
          <p style="margin:0 0 24px;font-size:14px;color:#a6adc8;">
            The frontend encountered an error during initialization.
            A previous working version may be available.
          </p>
          <p style="margin:0 0 24px;font-size:12px;color:#585b70;word-break:break-all;">
            ${e.message || 'Unknown error'}
          </p>
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            <button onclick="
              fetch('/api/fallback/status').then(r=>{
                if(!r.ok){alert('No backup available. The server may need manual repair.');return;}
                return r.json();
              }).then(s=>{
                if(!s)return;
                if(!confirm('Restore backup from '+new Date(s.timestamp).toLocaleString()+'?'))return;
                const token=localStorage.getItem('cwm_token');
                fetch('/api/fallback/restore',{
                  method:'POST',
                  headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}
                }).then(r=>r.json()).then(d=>{
                  if(d.success){
                    localStorage.setItem('cwm_fallback_active',s.timestamp);
                    location.reload();
                  }else{alert('Restore failed: '+(d.error||'unknown'));}
                });
              });
            " style="
              padding:12px 24px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:8px;
              font-size:14px;font-weight:600;cursor:pointer;
            ">Restore Previous Version</button>
            <button onclick="location.reload()" style="
              padding:12px 24px;background:#313244;color:#cdd6f4;border:1px solid #45475a;
              border-radius:8px;font-size:14px;cursor:pointer;
            ">Retry</button>
          </div>
        </div>
      </div>`;
  }).catch(() => {
    // Server is also down — nothing we can do from the client
    document.body.innerHTML = `
      <div style="
        display:flex;align-items:center;justify-content:center;
        min-height:100vh;background:#1e1e2e;color:#cdd6f4;font-family:system-ui,sans-serif;
        text-align:center;padding:24px;
      ">
        <div>
          <h2 style="color:#f38ba8;">Server Unreachable</h2>
          <p style="color:#a6adc8;">The CWM server is not responding. Check if it's running.</p>
          <button onclick="location.reload()" style="
            margin-top:16px;padding:12px 24px;background:#313244;color:#cdd6f4;
            border:1px solid #45475a;border-radius:8px;font-size:14px;cursor:pointer;
          ">Retry</button>
        </div>
      </div>`;
  });
});

class CWMApp {
  constructor() {
    // ─── State ─────────────────────────────────────────────────
    this.state = {
      token: localStorage.getItem('cwm_token') || null,
      workspaces: [],
      sessions: [],
      allSessions: [],  // Always holds ALL sessions (for sidebar rendering)
      groups: [],
      projects: [],
      activeWorkspace: null,
      selectedSession: null,
      viewMode: localStorage.getItem('cwm_viewMode') || 'terminal',       // workspace | all | recent | terminal
      stats: { totalWorkspaces: 0, totalSessions: 0, runningSessions: 0, activeWorkspace: null },
      notifications: [],
      sidebarOpen: false,
      projectsCollapsed: false,
      docs: null,
      docsRawMode: false,
      hiddenSessions: new Set(JSON.parse(localStorage.getItem('cwm_hiddenSessions') || '[]')),
      hiddenProjectSessions: new Set(JSON.parse(localStorage.getItem('cwm_hiddenProjectSessions') || '[]')),
      showHidden: false,
    };

    // ─── Terminal panes ──────────────────────────────────────────
    this.terminalPanes = [null, null, null, null];
    this._activeTerminalSlot = null;
    this._gridColSizes = [1, 1];  // fr ratios for column widths
    this._gridRowSizes = [1, 1];  // fr ratios for row heights

    // ─── Quick Switcher state ──────────────────────────────────
    this.qsHighlightIndex = -1;
    this.qsResults = [];

    // ─── SSE ───────────────────────────────────────────────────
    this.eventSource = null;
    this.sseRetryTimeout = null;

    // ─── Modal state ───────────────────────────────────────────
    this.modalResolve = null;

    // ─── Boot ──────────────────────────────────────────────────
    this.cacheElements();
    this.bindEvents();
    this.init();

    // Clear the init timeout — we made it
    clearTimeout(window.__cwmInitTimeout);

    // Check if running a restored fallback version
    this._checkFallbackBanner();
  }

  _checkFallbackBanner() {
    const fallbackTs = localStorage.getItem('cwm_fallback_active');
    if (!fallbackTs) return;

    const banner = document.createElement('div');
    banner.className = 'fallback-banner';
    banner.innerHTML = `
      <span style="margin-right:8px;">&#9888;</span>
      Running fallback version (restored from ${new Date(fallbackTs).toLocaleString()}).
      Some recent changes may be missing.
      <button class="fallback-dismiss" title="Dismiss">&#10005;</button>
    `;
    banner.querySelector('.fallback-dismiss').addEventListener('click', () => {
      localStorage.removeItem('cwm_fallback_active');
      banner.remove();
    });
    document.body.prepend(banner);
  }


  /* ═══════════════════════════════════════════════════════════
     INITIALIZATION
     ═══════════════════════════════════════════════════════════ */

  cacheElements() {
    // Login
    this.els = {
      loginScreen: document.getElementById('login-screen'),
      loginForm: document.getElementById('login-form'),
      loginPassword: document.getElementById('login-password'),
      loginError: document.getElementById('login-error'),
      loginBtn: document.getElementById('login-btn'),

      // App
      app: document.getElementById('app'),
      sidebarToggle: document.getElementById('sidebar-toggle'),
      sidebar: document.getElementById('sidebar'),
      workspaceList: document.getElementById('workspace-list'),
      workspaceCount: document.getElementById('workspace-count'),
      createWorkspaceBtn: document.getElementById('create-workspace-btn'),
      toggleHiddenBtn: document.getElementById('toggle-hidden-btn'),
      toggleHiddenLabel: document.getElementById('toggle-hidden-label'),

      // Header
      viewTabs: document.querySelectorAll('.view-tab'),
      statRunning: document.getElementById('stat-running'),
      statTotal: document.getElementById('stat-total'),
      openSwitcherBtn: document.getElementById('open-switcher-btn'),
      logoutBtn: document.getElementById('logout-btn'),

      // Sessions
      sessionPanelTitle: document.getElementById('session-panel-title'),
      sessionList: document.getElementById('session-list'),
      sessionEmpty: document.getElementById('session-empty'),
      createSessionBtn: document.getElementById('create-session-btn'),
      sessionListPanel: document.getElementById('session-list-panel'),

      // Detail
      detailPanel: document.getElementById('session-detail-panel'),
      detailBackBtn: document.getElementById('detail-back-btn'),
      detailStatusDot: document.getElementById('detail-status-dot'),
      detailTitle: document.getElementById('detail-title'),
      detailRenameBtn: document.getElementById('detail-rename-btn'),
      detailDeleteBtn: document.getElementById('detail-delete-btn'),
      detailStatusBadge: document.getElementById('detail-status-badge'),
      detailWorkspace: document.getElementById('detail-workspace'),
      detailDir: document.getElementById('detail-dir'),
      detailTopic: document.getElementById('detail-topic'),
      detailCommand: document.getElementById('detail-command'),
      detailPid: document.getElementById('detail-pid'),
      detailCreated: document.getElementById('detail-created'),
      detailLastActive: document.getElementById('detail-last-active'),
      detailStartBtn: document.getElementById('detail-start-btn'),
      detailStopBtn: document.getElementById('detail-stop-btn'),
      detailRestartBtn: document.getElementById('detail-restart-btn'),
      detailLogs: document.getElementById('detail-logs'),

      // Quick Switcher
      qsOverlay: document.getElementById('quick-switcher-overlay'),
      qsInput: document.getElementById('qs-input'),
      qsResultsContainer: document.getElementById('qs-results'),

      // Modal
      modalOverlay: document.getElementById('modal-overlay'),
      modal: document.getElementById('modal'),
      modalTitle: document.getElementById('modal-title'),
      modalBody: document.getElementById('modal-body'),
      modalFooter: document.getElementById('modal-footer'),
      modalCloseBtn: document.getElementById('modal-close-btn'),
      modalCancelBtn: document.getElementById('modal-cancel-btn'),
      modalConfirmBtn: document.getElementById('modal-confirm-btn'),

      // Toast
      toastContainer: document.getElementById('toast-container'),

      // Context Menu
      contextMenu: document.getElementById('context-menu'),
      contextMenuItems: document.getElementById('context-menu-items'),

      // Projects
      projectsList: document.getElementById('projects-list'),
      projectsToggle: document.getElementById('projects-toggle'),

      // Terminal Grid
      terminalGrid: document.getElementById('terminal-grid'),
      terminalTabStrip: document.getElementById('terminal-tab-strip'),

      // Mobile
      mobileTabBar: document.getElementById('mobile-tab-bar'),
      actionSheetOverlay: document.getElementById('action-sheet-overlay'),
      actionSheet: document.getElementById('action-sheet'),
      actionSheetHeader: document.getElementById('action-sheet-header'),
      actionSheetItems: document.getElementById('action-sheet-items'),
      actionSheetCancel: document.getElementById('action-sheet-cancel'),

      // Sidebar resize & collapse
      sidebarResizeHandle: document.getElementById('sidebar-resize-handle'),
      sidebarCollapseBtn: document.getElementById('sidebar-collapse-btn'),

      // Docs panel
      docsPanel: document.getElementById('docs-panel'),
      docsWorkspaceName: document.getElementById('docs-workspace-name'),
      docsToggleRaw: document.getElementById('docs-toggle-raw'),
      docsSaveBtn: document.getElementById('docs-save-btn'),
      docsStructured: document.getElementById('docs-structured'),
      docsRaw: document.getElementById('docs-raw'),
      docsRawEditor: document.getElementById('docs-raw-editor'),
      docsNotesList: document.getElementById('docs-notes-list'),
      docsGoalsList: document.getElementById('docs-goals-list'),
      docsTasksList: document.getElementById('docs-tasks-list'),
      docsNotesCount: document.getElementById('docs-notes-count'),
      docsGoalsCount: document.getElementById('docs-goals-count'),
      docsTasksCount: document.getElementById('docs-tasks-count'),
      docsAiInsights: document.getElementById('docs-ai-insights'),
      docsAiRefresh: document.getElementById('docs-ai-refresh'),

      // Terminal Tab Groups
      terminalGroupsBar: document.getElementById('terminal-groups-bar'),
      terminalGroupsTabs: document.getElementById('terminal-groups-tabs'),
      terminalGroupsAdd: document.getElementById('terminal-groups-add'),

      // Notes Editor
      notesEditorOverlay: document.getElementById('notes-editor-overlay'),
      notesEditorTitle: document.getElementById('notes-editor-title'),
      notesEditorTextarea: document.getElementById('notes-editor-textarea'),
      notesEditorClose: document.getElementById('notes-editor-close'),
      notesEditorCancel: document.getElementById('notes-editor-cancel'),
      notesEditorSave: document.getElementById('notes-editor-save'),

      // Resources
      resourcesPanel: document.getElementById('resources-panel'),
      resourcesBody: document.getElementById('resources-body'),
    };
  }

  get isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  bindEvents() {
    // Login
    this.els.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.login(this.els.loginPassword.value);
    });

    // Logout & Restart All
    this.els.logoutBtn.addEventListener('click', () => this.logout());
    document.getElementById('restart-all-btn').addEventListener('click', () => this.restartAllSessions());

    // Sidebar toggle (mobile)
    this.els.sidebarToggle.addEventListener('click', () => this.toggleSidebar());

    // View tabs
    this.els.viewTabs.forEach(tab => {
      tab.addEventListener('click', () => this.setViewMode(tab.dataset.mode));
    });

    // Projects toggle
    if (this.els.projectsToggle) {
      this.els.projectsToggle.addEventListener('click', () => this.toggleProjectsPanel());
    }

    // Toggle hidden sessions
    if (this.els.toggleHiddenBtn) {
      this.els.toggleHiddenBtn.addEventListener('click', () => this.toggleShowHidden());
    }

    // Sidebar collapse (desktop)
    if (this.els.sidebarCollapseBtn) {
      this.els.sidebarCollapseBtn.addEventListener('click', () => this.toggleSidebarCollapse());
    }

    // Sidebar resize handle (desktop drag-to-resize)
    if (this.els.sidebarResizeHandle) {
      this.initSidebarResize();
    }

    // Vertical resize between workspaces & projects sections
    this.initSidebarSectionResize();

    // Workspace
    this.els.createWorkspaceBtn.addEventListener('click', () => this.createWorkspace());

    // Session
    this.els.createSessionBtn.addEventListener('click', () => this.createSession());
    document.getElementById('discover-btn').addEventListener('click', () => this.discoverSessions());

    // Detail actions
    this.els.detailBackBtn.addEventListener('click', () => this.deselectSession());
    this.els.detailRenameBtn.addEventListener('click', () => {
      if (this.state.selectedSession) this.renameSession(this.state.selectedSession.id);
    });
    this.els.detailDeleteBtn.addEventListener('click', () => {
      if (this.state.selectedSession) this.deleteSession(this.state.selectedSession.id);
    });
    this.els.detailStartBtn.addEventListener('click', () => {
      if (this.state.selectedSession) this.startSession(this.state.selectedSession.id);
    });
    this.els.detailStopBtn.addEventListener('click', () => {
      if (this.state.selectedSession) this.stopSession(this.state.selectedSession.id);
    });
    this.els.detailRestartBtn.addEventListener('click', () => {
      if (this.state.selectedSession) this.restartSession(this.state.selectedSession.id);
    });

    // Context Menu — dismiss on click outside or Escape
    document.addEventListener('click', () => this.hideContextMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideContextMenu();
    });

    // Suppress browser's native right-click menu within the app
    this.els.app.addEventListener('contextmenu', (e) => {
      // Allow native menu on text inputs/textareas for copy/paste
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
    });

    // Quick Switcher
    this.els.openSwitcherBtn.addEventListener('click', () => this.openQuickSwitcher());
    this.els.qsInput.addEventListener('input', () => this.onQuickSwitcherInput());
    this.els.qsOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.qsOverlay) this.closeQuickSwitcher();
    });
    this.els.qsInput.addEventListener('keydown', (e) => this.onQuickSwitcherKeydown(e));

    // Modal
    this.els.modalCloseBtn.addEventListener('click', () => this.closeModal(null));
    this.els.modalCancelBtn.addEventListener('click', () => this.closeModal(null));
    this.els.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.modalOverlay) this.closeModal(null);
    });

    // Docs panel
    if (this.els.docsToggleRaw) {
      this.els.docsToggleRaw.addEventListener('click', () => this.toggleDocsRawMode());
    }
    if (this.els.docsSaveBtn) {
      this.els.docsSaveBtn.addEventListener('click', () => this.saveDocsRaw());
    }
    document.querySelectorAll('.docs-add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addDocsItem(btn.dataset.section);
      });
    });
    document.querySelectorAll('.docs-section-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.docs-add-btn')) return;
        const body = header.nextElementSibling;
        const chevron = header.querySelector('.docs-section-chevron');
        if (body) body.hidden = !body.hidden;
        if (chevron) chevron.classList.toggle('open');
      });
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+K / Cmd+K — Quick Switcher
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (this.state.token) this.openQuickSwitcher();
      }
      // Escape
      if (e.key === 'Escape') {
        if (this.els.actionSheetOverlay && !this.els.actionSheetOverlay.hidden) {
          this.hideActionSheet();
        } else if (!this.els.qsOverlay.hidden) {
          this.closeQuickSwitcher();
        } else if (!this.els.modalOverlay.hidden) {
          this.closeModal(null);
        }
      }
    });

    // ─── Mobile: Bottom Tab Bar ─────────────────────────────
    if (this.els.mobileTabBar) {
      this.els.mobileTabBar.querySelectorAll('.mobile-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const view = tab.dataset.view;
          if (view === 'more') {
            this.showMoreMenu();
          } else if (view === 'workspace') {
            this.setViewMode('workspace');
            // Also open sidebar on mobile for workspace access
            if (this.isMobile && !this.state.sidebarOpen) {
              this.toggleSidebar();
            }
          } else {
            this.setViewMode(view);
            // Close sidebar if open
            if (this.state.sidebarOpen) {
              this.toggleSidebar();
            }
          }
        });
      });
    }

    // ─── Mobile: Action Sheet ───────────────────────────────
    if (this.els.actionSheetOverlay) {
      this.els.actionSheetOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.actionSheetOverlay) this.hideActionSheet();
      });
    }
    if (this.els.actionSheetCancel) {
      this.els.actionSheetCancel.addEventListener('click', () => this.hideActionSheet());
    }

    // ─── Mobile: Touch Gestures ─────────────────────────────
    if ('ontouchstart' in window) {
      this.initTouchGestures();
    }

    // ─── Mobile: VisualViewport resize (soft keyboard) ───────
    // When the mobile keyboard opens/closes, the visual viewport shrinks/grows.
    // Refit terminal panes so they fill the available space without cutoff.
    if (window.visualViewport) {
      let vpResizeTimer = null;
      window.visualViewport.addEventListener('resize', () => {
        clearTimeout(vpResizeTimer);
        vpResizeTimer = setTimeout(() => {
          if (this.state.viewMode === 'terminal') {
            this.terminalPanes.forEach(tp => {
              if (tp && tp.fitAddon) {
                try { tp.fitAddon.fit(); } catch (_) {}
              }
            });
          }
        }, 150);
      });
    }

    // ─── Mobile: Terminal Toolbar ──────────────────────────────
    document.querySelectorAll('.terminal-mobile-toolbar button').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        // Use the tracked active terminal pane
        const activePane = this._activeTerminalSlot !== null
          ? this.terminalPanes[this._activeTerminalSlot]
          : this.terminalPanes.find(tp => tp !== null);
        if (!activePane || !activePane.ws || activePane.ws.readyState !== WebSocket.OPEN) return;

        const keyMap = {
          'enter': '\r',
          'tab': '\t',
          'ctrlc': '\x03',
          'ctrld': '\x04',
          'escape': '\x1b',
          'up': '\x1b[A',
          'down': '\x1b[B',
        };
        const data = keyMap[key];
        if (data) {
          activePane.ws.send(JSON.stringify({ type: 'input', data }));
          // Refocus terminal
          if (activePane.term) activePane.term.focus();
        }
      });
    });
  }

  async init() {
    // Restore sidebar width & collapse state from localStorage
    this.restoreSidebarState();

    if (this.state.token) {
      const valid = await this.checkAuth();
      if (valid) {
        this.showApp();
        this.initDragAndDrop();
        this.initTerminalResize();
        this.initTerminalGroups();
        this.initNotesEditor();
        this.initAIInsights();
        await this.loadAll();
        this.connectSSE();
      } else {
        this.state.token = null;
        localStorage.removeItem('cwm_token');
        this.showLogin();
      }
    } else {
      this.showLogin();
    }
  }


  /* ═══════════════════════════════════════════════════════════
     API HELPER
     ═══════════════════════════════════════════════════════════ */

  async api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.state.token) {
      headers['Authorization'] = `Bearer ${this.state.token}`;
    }
    const opts = { method, headers };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(path, opts);

      if (res.status === 401) {
        this.state.token = null;
        localStorage.removeItem('cwm_token');
        this.showLogin();
        this.disconnectSSE();
        throw new Error('Unauthorized');
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }

      // Handle 204 No Content
      if (res.status === 204) return {};
      return await res.json();
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        console.error(`API ${method} ${path}:`, err);
      }
      throw err;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     AUTHENTICATION
     ═══════════════════════════════════════════════════════════ */

  async checkAuth() {
    try {
      const data = await this.api('GET', '/api/auth/check');
      return data.authenticated === true;
    } catch {
      return false;
    }
  }

  async login(password) {
    this.els.loginError.textContent = '';
    this.els.loginBtn.classList.add('loading');
    this.els.loginBtn.disabled = true;

    try {
      const data = await this.api('POST', '/api/auth/login', { password });
      if (data.success && data.token) {
        this.state.token = data.token;
        localStorage.setItem('cwm_token', data.token);
        this.showApp();
        this.initDragAndDrop();
        this.initTerminalResize();
        this.initTerminalGroups();
        this.initNotesEditor();
        this.initAIInsights();
        await this.loadAll();
        this.connectSSE();
      } else {
        this.els.loginError.textContent = 'Invalid password. Please try again.';
      }
    } catch (err) {
      this.els.loginError.textContent = err.message || 'Connection failed. Is the server running?';
    } finally {
      this.els.loginBtn.classList.remove('loading');
      this.els.loginBtn.disabled = false;
    }
  }

  async logout() {
    try {
      await this.api('POST', '/api/auth/logout');
    } catch {
      // ignore — we clear locally regardless
    }
    this.state.token = null;
    localStorage.removeItem('cwm_token');
    this.disconnectSSE();
    this.showLogin();
  }


  /* ═══════════════════════════════════════════════════════════
     VIEW TRANSITIONS
     ═══════════════════════════════════════════════════════════ */

  showLogin() {
    this.els.app.hidden = true;
    this.els.loginScreen.hidden = false;
    this.els.loginPassword.value = '';
    this.els.loginError.textContent = '';
    this.els.loginPassword.focus();
    // Hide mobile tab bar on login screen
    if (this.els.mobileTabBar) this.els.mobileTabBar.hidden = true;
  }

  showApp() {
    this.els.loginScreen.hidden = true;
    this.els.app.hidden = false;
    // Show mobile tab bar after login
    if (this.els.mobileTabBar) this.els.mobileTabBar.hidden = false;
  }


  /* ═══════════════════════════════════════════════════════════
     DATA LOADING
     ═══════════════════════════════════════════════════════════ */

  async loadAll() {
    // Restore persisted state
    const savedWorkspaceId = localStorage.getItem('cwm_activeWorkspace');
    const savedViewMode = localStorage.getItem('cwm_viewMode');
    if (savedViewMode && ['workspace', 'all', 'recent', 'terminal', 'docs', 'resources'].includes(savedViewMode)) {
      this.state.viewMode = savedViewMode;
    }
    // Always apply the current view mode (handles default 'terminal' for new users)
    this.setViewMode(this.state.viewMode);

    await Promise.all([
      this.loadWorkspaces(),
      this.loadStats(),
      this.loadGroups(),
      this.loadProjects(),
    ]);

    // Restore active workspace from localStorage if still valid
    if (savedWorkspaceId && !this.state.activeWorkspace) {
      const ws = this.state.workspaces.find(w => w.id === savedWorkspaceId);
      if (ws) {
        this.state.activeWorkspace = ws;
        this.renderWorkspaces();
      }
    }

    await this.loadSessions();
  }

  async loadWorkspaces() {
    try {
      const data = await this.api('GET', '/api/workspaces');
      let workspaces = data.workspaces || [];
      // Sort by server-side order if available
      const order = data.workspaceOrder || [];
      if (order.length > 0) {
        const orderMap = {};
        order.forEach((id, idx) => { orderMap[id] = idx; });
        workspaces.sort((a, b) => {
          const ai = orderMap[a.id] !== undefined ? orderMap[a.id] : 9999;
          const bi = orderMap[b.id] !== undefined ? orderMap[b.id] : 9999;
          return ai - bi;
        });
      }
      this.state.workspaces = workspaces;
      // Auto-select first workspace if none active
      if (!this.state.activeWorkspace && this.state.workspaces.length > 0) {
        this.state.activeWorkspace = this.state.workspaces[0];
      }
      this.renderWorkspaces();
    } catch (err) {
      this.showToast('Failed to load workspaces', 'error');
    }
  }

  async loadSessions() {
    try {
      const mode = this.state.viewMode;

      // Always fetch ALL sessions for sidebar workspace rendering
      const allData = await this.api('GET', '/api/sessions?mode=all');
      this.state.allSessions = allData.sessions || [];

      // If workspace mode but no workspace active, show empty
      if (mode === 'workspace' && !this.state.activeWorkspace) {
        this.state.sessions = [];
        this.renderSessions();
        this.renderWorkspaces();
        return;
      }

      // Fetch mode-specific sessions for the main session list panel
      if (mode === 'workspace' || mode === 'recent') {
        let path = `/api/sessions?mode=${mode}`;
        if (mode === 'workspace' && this.state.activeWorkspace) {
          path += `&workspaceId=${this.state.activeWorkspace.id}`;
        }
        const data = await this.api('GET', path);
        this.state.sessions = data.sessions || [];
      } else {
        // 'all' mode — reuse the full list we already fetched
        this.state.sessions = this.state.allSessions;
      }

      this.renderSessions();
      // Re-render workspace accordion to update session sub-items
      this.renderWorkspaces();
    } catch (err) {
      this.showToast('Failed to load sessions', 'error');
    }
  }

  async loadStats() {
    try {
      this.state.stats = await this.api('GET', '/api/stats');
      this.renderStats();
    } catch {
      // non-critical
    }
  }


  /* ═══════════════════════════════════════════════════════════
     WORKSPACES
     ═══════════════════════════════════════════════════════════ */

  async selectWorkspace(id) {
    const ws = this.state.workspaces.find(w => w.id === id) || null;
    this.state.activeWorkspace = ws;

    // Persist to localStorage
    if (ws) {
      localStorage.setItem('cwm_activeWorkspace', ws.id);
    } else {
      localStorage.removeItem('cwm_activeWorkspace');
    }

    // Activate on server
    if (ws) {
      try {
        await this.api('POST', `/api/workspaces/${id}/activate`);
      } catch {
        // non-critical
      }
    }

    this.renderWorkspaces();

    if (this.state.viewMode === 'workspace') {
      await this.loadSessions();
    }

    // Close mobile sidebar
    if (this.state.sidebarOpen) this.toggleSidebar();
  }

  async createWorkspace() {
    const result = await this.showPromptModal({
      title: 'New Workspace',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'my-project', required: true },
        { key: 'description', label: 'Description', placeholder: 'What is this workspace for?', type: 'textarea' },
        { key: 'color', label: 'Color', type: 'color' },
      ],
      confirmText: 'Create',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      await this.api('POST', '/api/workspaces', result);
      this.showToast('Workspace created', 'success');
      await this.loadWorkspaces();
      await this.loadStats();
    } catch (err) {
      this.showToast(err.message || 'Failed to create workspace', 'error');
    }
  }

  async renameWorkspace(id) {
    const ws = this.state.workspaces.find(w => w.id === id);
    if (!ws) return;

    const result = await this.showPromptModal({
      title: 'Edit Workspace',
      fields: [
        { key: 'name', label: 'Name', value: ws.name, required: true },
        { key: 'description', label: 'Description', value: ws.description || '', type: 'textarea' },
        { key: 'color', label: 'Color', type: 'color', value: ws.color },
      ],
      confirmText: 'Save',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      await this.api('PUT', `/api/workspaces/${id}`, result);
      this.showToast('Workspace updated', 'success');
      await this.loadWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to update workspace', 'error');
    }
  }

  async deleteWorkspace(id) {
    const ws = this.state.workspaces.find(w => w.id === id);
    if (!ws) return;

    const confirmed = await this.showConfirmModal({
      title: 'Delete Workspace',
      message: `Are you sure you want to delete <strong>${this.escapeHtml(ws.name)}</strong>? This will remove the workspace and unlink all its sessions.`,
      confirmText: 'Delete',
      confirmClass: 'btn-danger',
    });

    if (!confirmed) return;

    try {
      await this.api('DELETE', `/api/workspaces/${id}`);
      this.showToast('Workspace deleted', 'success');
      if (this.state.activeWorkspace && this.state.activeWorkspace.id === id) {
        this.state.activeWorkspace = null;
      }
      await this.loadWorkspaces();
      await this.loadSessions();
      await this.loadStats();
    } catch (err) {
      this.showToast(err.message || 'Failed to delete workspace', 'error');
    }
  }


  /**
   * Reorder a workspace in the sidebar by moving it before or after a target.
   */
  async reorderWorkspace(draggedId, targetId, position) {
    const order = this.state.workspaces.map(w => w.id);
    const fromIdx = order.indexOf(draggedId);
    if (fromIdx === -1) return;

    // Remove dragged item from current position
    order.splice(fromIdx, 1);

    // Find target position (after removal, indices may have shifted)
    let toIdx = order.indexOf(targetId);
    if (toIdx === -1) return;
    if (position === 'after') toIdx++;

    // Insert at new position
    order.splice(toIdx, 0, draggedId);

    // Reorder the local state array to match
    const wsMap = {};
    this.state.workspaces.forEach(w => { wsMap[w.id] = w; });
    this.state.workspaces = order.map(id => wsMap[id]).filter(Boolean);
    this.renderWorkspaces();

    // Persist to server
    try {
      await this.api('PUT', '/api/workspaces/reorder', { order });
    } catch (err) {
      this.showToast('Failed to save order: ' + (err.message || ''), 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     SESSIONS
     ═══════════════════════════════════════════════════════════ */

  async selectSession(id) {
    const session = this.state.sessions.find(s => s.id === id)
      || (this.state.allSessions && this.state.allSessions.find(s => s.id === id))
      || null;
    this.state.selectedSession = session;
    this.renderSessionDetail();
    this.renderSessions(); // update active state

    // Mobile: slide detail panel in from right
    if (this.isMobile) {
      this.els.detailPanel.hidden = false;
      requestAnimationFrame(() => {
        this.els.detailPanel.classList.add('mobile-visible');
      });
    } else if (window.innerWidth <= 768) {
      this.els.sessionListPanel.classList.add('detail-active');
    }

    // If session is stopped, offer to start it
    if (session && (!session.status || session.status === 'stopped')) {
      const confirmed = await this.showConfirmModal({
        title: 'Start Session?',
        message: `<strong>${this.escapeHtml(session.name)}</strong> is not running. Would you like to start it?`,
        confirmText: 'Start',
        confirmClass: 'btn-primary',
      });
      if (confirmed) {
        await this.startSession(id);
      }
    }
  }

  deselectSession() {
    this.state.selectedSession = null;
    // Mobile: slide detail panel out
    if (this.isMobile) {
      this.els.detailPanel.classList.remove('mobile-visible');
      // Hide after transition completes
      setTimeout(() => {
        if (!this.els.detailPanel.classList.contains('mobile-visible')) {
          this.els.detailPanel.hidden = true;
        }
      }, 300);
    } else {
      this.els.detailPanel.hidden = true;
    }
    this.els.sessionListPanel.classList.remove('detail-active');
    this.renderSessions();
  }

  async createSession() {
    const fields = [
      { key: 'name', label: 'Name', placeholder: 'feature-auth', required: true },
      { key: 'topic', label: 'Topic', placeholder: 'Working on authentication flow' },
      { key: 'workingDir', label: 'Working Directory', placeholder: 'C:\\Users\\...\\project' },
      { key: 'command', label: 'Command', placeholder: 'claude (default)' },
    ];

    // If we have a workspace selected, pre-fill workspaceId
    if (this.state.activeWorkspace) {
      fields.push({
        key: 'workspaceId',
        type: 'hidden',
        value: this.state.activeWorkspace.id,
      });
    } else if (this.state.workspaces.length > 0) {
      fields.push({
        key: 'workspaceId',
        label: 'Workspace',
        type: 'select',
        options: this.state.workspaces.map(w => ({ value: w.id, label: w.name })),
        required: true,
      });
    }

    const result = await this.showPromptModal({
      title: 'New Session',
      fields,
      confirmText: 'Create',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      const data = await this.api('POST', '/api/sessions', result);
      const session = data.session || data;
      this.showToast(`Session "${session.name || 'New'}" created`, 'success');
      await this.loadSessions();
      await this.loadStats();
    } catch (err) {
      this.showToast(err.message || 'Failed to create session', 'error');
    }
  }

  async renameSession(id) {
    const session = this.state.sessions.find(s => s.id === id);
    if (!session) return;

    const result = await this.showPromptModal({
      title: 'Edit Session',
      fields: [
        { key: 'name', label: 'Name', value: session.name, required: true },
        { key: 'topic', label: 'Topic', value: session.topic || '' },
        { key: 'workingDir', label: 'Working Directory', value: session.workingDir || '' },
      ],
      confirmText: 'Save',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      const data = await this.api('PUT', `/api/sessions/${id}`, result);
      const updated = data.session || data;
      this.showToast('Session updated', 'success');
      await this.loadSessions();
      if (this.state.selectedSession && this.state.selectedSession.id === id) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to update session', 'error');
    }
  }

  async deleteSession(id) {
    const session = this.state.sessions.find(s => s.id === id);
    if (!session) return;

    // Hide session — never delete. Persisted in localStorage.
    this.state.hiddenSessions.add(id);
    localStorage.setItem('cwm_hiddenSessions', JSON.stringify([...this.state.hiddenSessions]));

    if (this.state.selectedSession && this.state.selectedSession.id === id) {
      this.deselectSession();
    }
    this.renderWorkspaces();
    this.renderSessions();
    this.showToast(`Hidden "${session.name}" — toggle "Show hidden" to see it again`, 'info');
  }

  unhideSession(id) {
    this.state.hiddenSessions.delete(id);
    localStorage.setItem('cwm_hiddenSessions', JSON.stringify([...this.state.hiddenSessions]));
    this.renderWorkspaces();
    this.renderSessions();
  }

  async moveSessionToWorkspace(sessionId, targetWorkspaceId) {
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    const targetWs = this.state.workspaces.find(w => w.id === targetWorkspaceId);
    if (!session || !targetWs) return;

    try {
      await this.api('PUT', `/api/sessions/${sessionId}`, { workspaceId: targetWorkspaceId });
      session.workspaceId = targetWorkspaceId;
      // Update allSessions too
      const allSession = this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId);
      if (allSession && allSession !== session) allSession.workspaceId = targetWorkspaceId;
      this.renderWorkspaces();
      this.renderSessions();
      this.showToast(`Moved "${session.name}" to "${targetWs.name}"`, 'success');
    } catch (err) {
      this.showToast('Failed to move session: ' + (err.message || ''), 'error');
    }
  }

  async removeSessionFromWorkspace(sessionId) {
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    if (!session) return;

    const confirmed = await this.showConfirmModal({
      title: 'Remove Session',
      message: `Remove "${session.name}" from this workspace? This deletes the session record (your Claude conversation files are not affected).`,
      confirmText: 'Remove',
      confirmClass: 'btn-danger',
    });
    if (!confirmed) return;

    try {
      await this.api('DELETE', `/api/sessions/${sessionId}`);
      this.state.sessions = this.state.sessions.filter(s => s.id !== sessionId);
      if (this.state.allSessions) {
        this.state.allSessions = this.state.allSessions.filter(s => s.id !== sessionId);
      }
      if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
        this.deselectSession();
      }
      this.renderWorkspaces();
      this.renderSessions();
      this.showToast(`Removed "${session.name}"`, 'success');
    } catch (err) {
      this.showToast('Failed to remove session: ' + (err.message || ''), 'error');
    }
  }

  toggleShowHidden() {
    this.state.showHidden = !this.state.showHidden;
    if (this.els.toggleHiddenBtn) this.els.toggleHiddenBtn.classList.toggle('active', this.state.showHidden);
    if (this.els.toggleHiddenLabel) this.els.toggleHiddenLabel.textContent = this.state.showHidden ? 'Hide hidden' : 'Show hidden';
    this.renderWorkspaces();
    this.renderSessions();
  }

  async startSession(id) {
    try {
      await this.api('POST', `/api/sessions/${id}/start`);
      this.showToast('Session started', 'success');
      await this.refreshSessionData(id);
    } catch (err) {
      this.showToast(err.message || 'Failed to start session', 'error');
    }
  }

  async stopSession(id) {
    try {
      await this.api('POST', `/api/sessions/${id}/stop`);
      this.showToast('Session stopped', 'info');
      await this.refreshSessionData(id);
    } catch (err) {
      this.showToast(err.message || 'Failed to stop session', 'error');
    }
  }

  async restartSession(id) {
    try {
      await this.api('POST', `/api/sessions/${id}/restart`);
      this.showToast('Session restarted', 'success');
      await this.refreshSessionData(id);
    } catch (err) {
      this.showToast(err.message || 'Failed to restart session', 'error');
    }
  }

  async refreshSessionData(id) {
    await this.loadSessions();
    await this.loadStats();
    if (this.state.selectedSession && this.state.selectedSession.id === id) {
      const updated = this.state.sessions.find(s => s.id === id);
      if (updated) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════
     CONTEXT MENU
     ═══════════════════════════════════════════════════════════ */

  showContextMenu(sessionId, x, y) {
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    if (!session) return;

    const isRunning = session.status === 'running' || session.status === 'idle';
    const isBypassed = !!session.bypassPermissions;
    const isVerbose = !!session.verbose;
    const currentModel = session.model || null;

    const modelOptions = [
      { id: 'claude-opus-4-6', label: 'Opus' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
    ];

    const items = [];

    // Open in terminal (quick action)
    items.push({
      label: 'Open in Terminal', icon: '&#9654;', action: () => {
        const emptySlot = this.terminalPanes.findIndex(p => p === null);
        if (emptySlot !== -1) {
          this.setViewMode('terminal');
          this.openTerminalInPane(emptySlot, sessionId, session.name);
        } else {
          this.showToast('All terminal panes full. Close one first.', 'warning');
        }
      },
    });

    items.push({ type: 'sep' });

    if (!isRunning) {
      items.push(
        { label: 'Start', icon: '&#9654;', action: () => this.startSession(sessionId) },
        { label: 'Start (Bypass)', icon: '&#9888;', action: () => this.startSessionWithFlags(sessionId, { bypassPermissions: true }) },
      );
    } else {
      items.push(
        { label: 'Stop', icon: '&#9632;', action: () => this.stopSession(sessionId) },
        { label: 'Restart', icon: '&#8635;', action: () => this.restartSession(sessionId) },
      );
    }

    items.push({ type: 'sep' });

    // Model selection
    items.push({ label: 'Model:', icon: '&#9881;', disabled: true });
    modelOptions.forEach(m => {
      items.push({
        label: '  ' + m.label,
        icon: '&#183;',
        action: () => this.setSessionModel(sessionId, m.id),
        check: currentModel === m.id,
      });
    });
    if (currentModel) {
      items.push({ label: '  Default', icon: '&#183;', action: () => this.setSessionModel(sessionId, null), check: !currentModel });
    }

    items.push({ type: 'sep' });

    // Flags
    items.push(
      { label: 'Bypass Permissions', icon: '&#9888;', action: () => this.toggleBypass(sessionId), check: isBypassed },
      { label: 'Verbose', icon: '&#128483;', action: () => this.toggleVerbose(sessionId), check: isVerbose },
    );

    items.push({ type: 'sep' });

    // Actions
    items.push(
      { label: 'Rename', icon: '&#9998;', action: () => this.renameSession(sessionId) },
      { label: 'Auto Title', icon: '&#9733;', action: () => this.autoTitleSession(sessionId) },
      { label: 'Summarize', icon: '&#128220;', action: () => this.summarizeSession(sessionId) },
      { label: 'Copy Session ID', icon: '&#128203;', action: () => {
        navigator.clipboard.writeText(session.resumeSessionId || session.id);
        this.showToast('Session ID copied', 'success');
      }},
    );

    // Move to another workspace
    const otherWorkspaces = this.state.workspaces.filter(w => w.id !== session.workspaceId);
    if (otherWorkspaces.length > 0) {
      items.push({ type: 'sep' });
      items.push({ label: 'Move to:', icon: '&#8594;', disabled: true });
      otherWorkspaces.slice(0, 5).forEach(ws => {
        items.push({
          label: '  ' + (ws.name.length > 20 ? ws.name.substring(0, 20) + '...' : ws.name),
          icon: '&#183;',
          action: () => this.moveSessionToWorkspace(sessionId, ws.id),
        });
      });
    }

    items.push({ type: 'sep' });

    const isSessionHidden = this.state.hiddenSessions.has(sessionId);
    if (isSessionHidden) {
      items.push({ label: 'Unhide', icon: '&#128065;', action: () => this.unhideSession(sessionId) });
    } else {
      items.push({ label: 'Hide', icon: '&#128065;', action: () => this.deleteSession(sessionId) });
    }

    // Remove from workspace (actually deletes the session record)
    items.push({ label: 'Remove from Workspace', icon: '&#10005;', danger: true, action: () => this.removeSessionFromWorkspace(sessionId) });

    this._renderContextItems(session.name, items, x, y);
  }

  hideContextMenu() {
    this.els.contextMenu.hidden = true;
  }

  showProjectSessionContextMenu(sessionName, projectPath, x, y) {
    const items = [];

    // Open in terminal (resume the Claude session) — no workspace needed
    items.push({
      label: 'Open in Terminal', icon: '&#9654;', action: () => {
        const emptySlot = this.terminalPanes.findIndex(p => p === null);
        if (emptySlot === -1) {
          this.showToast('All terminal panes full. Close one first.', 'warning');
          return;
        }
        this.setViewMode('terminal');
        this.openTerminalInPane(emptySlot, sessionName, sessionName, {
          cwd: projectPath,
          resumeSessionId: sessionName,
          command: 'claude',
        });
      },
    });

    // Add to active workspace (without opening terminal)
    items.push({
      label: 'Add to Workspace', icon: '&#43;', action: () => {
        if (!this.state.activeWorkspace) {
          this.showToast('Select or create a workspace first', 'warning');
          return;
        }
        // Use project folder name as friendly default name instead of raw UUID
        const projectName = projectPath ? projectPath.split('\\').pop() || projectPath.split('/').pop() || sessionName : sessionName;
        const shortId = sessionName.length > 8 ? sessionName.substring(0, 8) : sessionName;
        const friendlyName = projectName + ' (' + shortId + ')';
        this.api('POST', '/api/sessions', {
          name: friendlyName,
          workspaceId: this.state.activeWorkspace.id,
          workingDir: projectPath,
          topic: 'Resumed session',
          command: 'claude',
          resumeSessionId: sessionName,
        }).then(async () => {
          await this.loadSessions();
          await this.loadStats();
          this.renderWorkspaces();
          this.showToast(`Session added to ${this.state.activeWorkspace.name}`, 'success');
        }).catch(err => {
          this.showToast(err.message || 'Failed to add session', 'error');
        });
      },
    });

    items.push({ type: 'sep' });

    // Auto Title (reads first user message and stores a friendly name)
    items.push({
      label: 'Auto Title', icon: '&#9733;', action: () => this.autoTitleProjectSession(sessionName),
    });

    // Summarize session
    items.push({
      label: 'Summarize', icon: '&#128220;', action: () => this.summarizeSession(sessionName, sessionName),
    });

    items.push({ type: 'sep' });

    // Copy session ID
    items.push({
      label: 'Copy Session ID', icon: '&#128203;', action: () => {
        navigator.clipboard.writeText(sessionName);
        this.showToast('Session ID copied', 'success');
      },
    });

    // Copy project path
    items.push({
      label: 'Copy Path', icon: '&#128193;', action: () => {
        navigator.clipboard.writeText(projectPath);
        this.showToast('Path copied', 'success');
      },
    });

    items.push({ type: 'sep' });

    // Hide/unhide project session
    const isHidden = this.state.hiddenProjectSessions.has(sessionName);
    if (isHidden) {
      items.push({ label: 'Unhide', icon: '&#128065;', action: () => {
        this.state.hiddenProjectSessions.delete(sessionName);
        localStorage.setItem('cwm_hiddenProjectSessions', JSON.stringify([...this.state.hiddenProjectSessions]));
        this.renderProjects();
        this.showToast('Session unhidden', 'info');
      }});
    } else {
      items.push({ label: 'Hide', icon: '&#128065;', action: () => {
        this.state.hiddenProjectSessions.add(sessionName);
        localStorage.setItem('cwm_hiddenProjectSessions', JSON.stringify([...this.state.hiddenProjectSessions]));
        this.renderProjects();
        this.showToast('Session hidden', 'info');
      }});
    }

    const projectName = projectPath ? projectPath.split('\\').pop() || projectPath.split('/').pop() || sessionName : sessionName;
    this._renderContextItems(projectName, items, x, y);
  }

  async toggleBypass(sessionId) {
    const session = this.state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    const newVal = !session.bypassPermissions;
    try {
      const data = await this.api('PUT', `/api/sessions/${sessionId}`, { bypassPermissions: newVal });
      const updated = data.session || data;
      this.showToast(`Bypass permissions ${newVal ? 'enabled' : 'disabled'}`, newVal ? 'warning' : 'info');
      await this.loadSessions();
      if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to update session', 'error');
    }
  }

  async toggleVerbose(sessionId) {
    const session = this.state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    const newVal = !session.verbose;
    try {
      const data = await this.api('PUT', `/api/sessions/${sessionId}`, { verbose: newVal });
      const updated = data.session || data;
      this.showToast(`Verbose mode ${newVal ? 'enabled' : 'disabled'}`, 'info');
      await this.loadSessions();
      if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to update session', 'error');
    }
  }

  async autoTitleSession(sessionId) {
    try {
      this.showToast('Generating title...', 'info');
      const data = await this.api('POST', `/api/sessions/${sessionId}/auto-title`);
      if (data && data.title) {
        this.showToast(`Titled: "${data.title}"`, 'success');
        await this.loadSessions();
        this.renderWorkspaces();
        if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
          this.state.selectedSession = this.state.sessions.find(s => s.id === sessionId);
          this.renderSessionDetail();
        }
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to auto-title', 'error');
    }
  }

  /**
   * Auto-title a project session (not in store).
   * Reads the first user message, stores the title in localStorage, and re-renders.
   */
  async autoTitleProjectSession(claudeSessionId) {
    try {
      this.showToast('Generating title...', 'info');
      const data = await this.api('POST', `/api/sessions/${claudeSessionId}/auto-title`, { claudeSessionId });
      if (data && data.title) {
        // Store title mapping in localStorage
        const titles = JSON.parse(localStorage.getItem('cwm_projectSessionTitles') || '{}');
        titles[claudeSessionId] = data.title;
        localStorage.setItem('cwm_projectSessionTitles', JSON.stringify(titles));
        this.showToast(`Titled: "${data.title}"`, 'success');
        this.renderProjects();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to auto-title', 'error');
    }
  }

  /**
   * Get a stored project session title (from localStorage), or null.
   */
  getProjectSessionTitle(claudeSessionId) {
    const titles = JSON.parse(localStorage.getItem('cwm_projectSessionTitles') || '{}');
    return titles[claudeSessionId] || null;
  }

  /**
   * Show a summary modal for a session with overall theme, recent tasking,
   * and option to add to a workspace.
   * Works for both store sessions (by ID) and project sessions (by Claude UUID).
   */
  async summarizeSession(sessionId, claudeSessionId) {
    try {
      this.showToast('Loading summary...', 'info');
      const body = claudeSessionId ? { claudeSessionId } : {};
      const data = await this.api('POST', `/api/sessions/${sessionId}/summarize`, body);

      // Build workspace options for "Send to Workspace"
      const wsOptions = this.state.workspaces.map(ws =>
        `<option value="${ws.id}">${this.escapeHtml(ws.name)}</option>`
      ).join('');

      const html = `
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <div style="font-size:11px;text-transform:uppercase;color:var(--overlay0);font-weight:600;margin-bottom:6px;">Overall Theme</div>
            <div style="font-size:13px;color:var(--text-primary);line-height:1.5;background:var(--surface0);padding:10px 12px;border-radius:8px;">${this.escapeHtml(data.overallTheme)}</div>
          </div>
          <div>
            <div style="font-size:11px;text-transform:uppercase;color:var(--overlay0);font-weight:600;margin-bottom:6px;">Most Recent Tasking</div>
            <div style="font-size:13px;color:var(--text-primary);line-height:1.5;background:var(--surface0);padding:10px 12px;border-radius:8px;">${this.escapeHtml(data.recentTasking)}</div>
          </div>
          ${data.recentAssistant ? `<div>
            <div style="font-size:11px;text-transform:uppercase;color:var(--overlay0);font-weight:600;margin-bottom:6px;">Last Assistant Response</div>
            <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;background:var(--surface0);padding:10px 12px;border-radius:8px;max-height:120px;overflow-y:auto;">${this.escapeHtml(data.recentAssistant)}</div>
          </div>` : ''}
          <div style="font-size:11px;color:var(--overlay0);">File size: ${this.formatSize(data.fileSize)}</div>
          ${this.state.workspaces.length > 0 ? `<div style="border-top:1px solid var(--border-subtle);padding-top:12px;">
            <div style="font-size:11px;text-transform:uppercase;color:var(--overlay0);font-weight:600;margin-bottom:8px;">Send to Workspace</div>
            <div style="display:flex;gap:8px;">
              <select id="summary-ws-select" style="flex:1;padding:8px;border-radius:6px;background:var(--surface0);color:var(--text-primary);border:1px solid var(--surface1);font-size:13px;">
                ${wsOptions}
              </select>
              <button class="btn btn-primary btn-sm" id="summary-send-btn" style="white-space:nowrap;">Add to Workspace</button>
            </div>
          </div>` : ''}
        </div>
      `;

      // Show modal
      this.els.modalTitle.textContent = data.sessionName || 'Session Summary';
      this.els.modalBody.innerHTML = html;
      this.els.modalFooter.hidden = true;
      this.els.modalOverlay.hidden = false;

      // Bind "Send to Workspace" button
      const sendBtn = document.getElementById('summary-send-btn');
      if (sendBtn) {
        sendBtn.addEventListener('click', async () => {
          const wsId = document.getElementById('summary-ws-select').value;
          if (!wsId) return;
          const ws = this.state.workspaces.find(w => w.id === wsId);
          const cId = data.claudeSessionId || claudeSessionId || sessionId;
          try {
            await this.api('POST', '/api/sessions', {
              name: data.sessionName || cId.substring(0, 12),
              workspaceId: wsId,
              workingDir: '',
              topic: (data.overallTheme || '').substring(0, 100),
              command: 'claude',
              resumeSessionId: cId,
            });
            await this.loadSessions();
            await this.loadStats();
            this.renderWorkspaces();
            this.closeModal(null);
            this.showToast(`Added to ${ws ? ws.name : 'workspace'}`, 'success');
          } catch (err) {
            this.showToast(err.message || 'Failed to add session', 'error');
          }
        });
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to summarize session', 'error');
    }
  }

  async setSessionModel(sessionId, model) {
    try {
      const data = await this.api('PUT', `/api/sessions/${sessionId}`, { model: model || null });
      const updated = data.session || data;
      const modelName = model ? (model.includes('opus') ? 'Opus' : model.includes('sonnet') ? 'Sonnet' : model.includes('haiku') ? 'Haiku' : model) : 'Default';
      this.showToast(`Model set to ${modelName}`, 'info');
      await this.loadSessions();
      if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to set model', 'error');
    }
  }

  async startSessionWithFlags(sessionId, flags) {
    try {
      // First set the flags on the session
      if (flags.bypassPermissions !== undefined) {
        await this.api('PUT', `/api/sessions/${sessionId}`, { bypassPermissions: flags.bypassPermissions });
      }
      if (flags.verbose !== undefined) {
        await this.api('PUT', `/api/sessions/${sessionId}`, { verbose: flags.verbose });
      }
      // Then start the session
      await this.api('POST', `/api/sessions/${sessionId}/start`);
      this.showToast('Session started', 'success');
      await this.refreshSessionData(sessionId);
    } catch (err) {
      this.showToast(err.message || 'Failed to start session', 'error');
    }
  }

  async restartSessionWithFlags(sessionId, flags) {
    try {
      // First set the flags on the session
      if (flags.bypassPermissions !== undefined) {
        await this.api('PUT', `/api/sessions/${sessionId}`, { bypassPermissions: flags.bypassPermissions });
      }
      if (flags.verbose !== undefined) {
        await this.api('PUT', `/api/sessions/${sessionId}`, { verbose: flags.verbose });
      }
      // Then restart the session
      await this.api('POST', `/api/sessions/${sessionId}/restart`);
      this.showToast('Session restarted', 'success');
      await this.refreshSessionData(sessionId);
    } catch (err) {
      this.showToast(err.message || 'Failed to restart session', 'error');
    }
  }

  async restartAllSessions() {
    const runningSessions = this.state.sessions.filter(s => s.status === 'running' || s.status === 'idle');
    if (runningSessions.length === 0) {
      this.showToast('No running sessions to restart', 'info');
      return;
    }

    const confirmed = await this.showConfirmModal({
      title: 'Restart All Sessions',
      message: `Restart <strong>${runningSessions.length}</strong> running session(s)? This will stop and relaunch each one, picking up any new login credentials.`,
      confirmText: 'Restart All',
      confirmClass: 'btn-primary',
    });

    if (!confirmed) return;

    for (const s of runningSessions) {
      try {
        await this.api('POST', `/api/sessions/${s.id}/restart`);
      } catch {
        // continue with others
      }
    }
    this.showToast(`Restarted ${runningSessions.length} session(s)`, 'success');
    await this.loadSessions();
    await this.loadStats();
  }


  /* ═══════════════════════════════════════════════════════════
     DISCOVER LOCAL SESSIONS
     ═══════════════════════════════════════════════════════════ */

  async discoverSessions() {
    try {
      const data = await this.api('GET', '/api/discover');
      const projects = data.projects || [];

      if (projects.length === 0) {
        this.showToast('No Claude projects found on this PC', 'info');
        return;
      }

      // Build the discover modal content
      const projectRows = projects.map(p => {
        const name = p.realPath.split('\\').pop() || p.encodedName;
        const active = p.lastActive ? this.relativeTime(p.lastActive) : 'never';
        const badges = [
          p.hasClaudeMd ? '<span class="discover-badge discover-badge-claude">CLAUDE.md</span>' : '',
          !p.dirExists ? '<span class="discover-badge discover-badge-missing">missing</span>' : '',
        ].filter(Boolean).join(' ');

        return `<div class="discover-row" data-path="${this.escapeHtml(p.realPath)}" data-name="${this.escapeHtml(name)}">
          <div class="discover-check">
            <input type="checkbox" class="discover-cb" ${p.dirExists ? 'checked' : ''} ${!p.dirExists ? 'disabled' : ''}>
          </div>
          <div class="discover-info">
            <div class="discover-name">${this.escapeHtml(name)} ${badges}</div>
            <div class="discover-path">${this.escapeHtml(p.realPath)}</div>
          </div>
          <div class="discover-meta">
            <span class="discover-count">${p.sessionCount} sessions</span>
            <span class="discover-time">${active}</span>
          </div>
        </div>`;
      }).join('');

      this.els.modalTitle.textContent = 'Discover Claude Sessions';
      this.els.modalBody.innerHTML = `
        <p style="color: var(--text-secondary); margin-bottom: 12px; font-size: 13px;">
          Found <strong>${projects.length}</strong> Claude projects on this PC. Select which ones to import as sessions into the current workspace.
        </p>
        <div class="discover-actions" style="display: flex; gap: 8px; margin-bottom: 12px;">
          <button class="btn btn-ghost btn-sm" id="discover-select-all">Select All</button>
          <button class="btn btn-ghost btn-sm" id="discover-select-none">Select None</button>
        </div>
        <div class="discover-list" style="max-height: 400px; overflow-y: auto;">${projectRows}</div>
      `;
      this.els.modalConfirmBtn.textContent = 'Import Selected';
      this.els.modalConfirmBtn.className = 'btn btn-primary';
      this.els.modalCancelBtn.textContent = 'Cancel';
      this.els.modalOverlay.hidden = false;

      // Select all / none
      document.getElementById('discover-select-all').addEventListener('click', () => {
        this.els.modalBody.querySelectorAll('.discover-cb:not(:disabled)').forEach(cb => cb.checked = true);
      });
      document.getElementById('discover-select-none').addEventListener('click', () => {
        this.els.modalBody.querySelectorAll('.discover-cb').forEach(cb => cb.checked = false);
      });

      // Wait for confirm/cancel
      const result = await new Promise(resolve => {
        this.modalResolve = resolve;
      });

      if (!result) return;

      // Get checked projects
      const rows = this.els.modalBody.querySelectorAll('.discover-row');
      const selected = [];
      rows.forEach(row => {
        const cb = row.querySelector('.discover-cb');
        if (cb && cb.checked) {
          selected.push({
            name: row.dataset.name,
            path: row.dataset.path,
          });
        }
      });

      if (selected.length === 0) {
        this.showToast('No projects selected', 'info');
        return;
      }

      // Need an active workspace to import into
      if (!this.state.activeWorkspace) {
        this.showToast('Select or create a workspace first', 'warning');
        return;
      }

      // Create sessions for each selected project
      let created = 0;
      for (const proj of selected) {
        try {
          await this.api('POST', '/api/sessions', {
            name: proj.name,
            workspaceId: this.state.activeWorkspace.id,
            workingDir: proj.path,
            topic: '',
            command: 'claude',
          });
          created++;
        } catch {
          // skip duplicates or errors
        }
      }

      this.showToast(`Imported ${created} session(s)`, 'success');
      await this.loadSessions();
      await this.loadStats();

    } catch (err) {
      this.showToast(err.message || 'Failed to discover sessions', 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     VIEW MODE
     ═══════════════════════════════════════════════════════════ */

  setViewMode(mode) {
    this.state.viewMode = mode;
    localStorage.setItem('cwm_viewMode', mode);

    // Update desktop tab states
    this.els.viewTabs.forEach(tab => {
      const isActive = tab.dataset.mode === mode;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive);
    });

    // Update mobile tab bar
    if (this.els.mobileTabBar) {
      this.els.mobileTabBar.querySelectorAll('.mobile-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === mode);
      });
    }

    // Stop resources polling when leaving resources view
    if (mode !== 'resources' && this._resourcesInterval) {
      clearInterval(this._resourcesInterval);
      this._resourcesInterval = null;
    }

    // Toggle terminal grid vs session panels vs docs vs resources
    const isTerminal = mode === 'terminal';
    const isDocs = mode === 'docs';
    const isResources = mode === 'resources';
    this.els.sessionListPanel.hidden = isTerminal || isDocs || isResources;
    this.els.detailPanel.hidden = isTerminal || isDocs || isResources || !this.state.selectedSession;
    if (this.els.terminalGrid) {
      this.els.terminalGrid.hidden = !isTerminal;
    }
    if (this.els.terminalGroupsBar) {
      this.els.terminalGroupsBar.hidden = !isTerminal;
    }
    // On mobile: lock page scroll when terminal is visible, unlock otherwise.
    // Terminal uses xterm.js internal scrolling; page scroll causes conflicts.
    // Applied to both <html> and <body> for cross-browser iOS Safari support.
    if (isTerminal) {
      document.documentElement.classList.add('terminal-active');
      document.body.classList.add('terminal-active');
    } else {
      document.documentElement.classList.remove('terminal-active');
      document.body.classList.remove('terminal-active');
    }
    if (this.els.docsPanel) {
      this.els.docsPanel.hidden = !isDocs;
    }
    if (this.els.resourcesPanel) {
      this.els.resourcesPanel.hidden = !isResources;
    }

    if (isDocs) {
      this.loadDocs();
    } else if (isResources) {
      this.loadResources();
    } else if (isTerminal) {
      if (this._tabGroups) this.renderTerminalGroupTabs();
      // Update mobile terminal tab strip when switching to terminal view
      if (this.isMobile) {
        this.updateTerminalTabs();
      }
      // Refit all terminal panes after view switch (viewport size may differ)
      requestAnimationFrame(() => {
        this.terminalPanes.forEach(tp => {
          if (tp && tp.fitAddon) {
            try { tp.fitAddon.fit(); } catch (_) {}
          }
        });
      });
    } else {
      // Update panel title
      const titles = { workspace: 'Sessions', all: 'All Sessions', recent: 'Recent Sessions' };
      this.els.sessionPanelTitle.textContent = titles[mode] || 'Sessions';

      // Load sessions for new mode
      this.loadSessions();
    }
  }


  /* ═══════════════════════════════════════════════════════════
     SIDEBAR
     ═══════════════════════════════════════════════════════════ */

  toggleSidebar() {
    this.state.sidebarOpen = !this.state.sidebarOpen;
    this.els.sidebar.classList.toggle('open', this.state.sidebarOpen);

    // Handle backdrop
    const existing = document.querySelector('.sidebar-backdrop');
    if (this.state.sidebarOpen) {
      if (!existing) {
        const backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop';
        backdrop.addEventListener('click', () => this.toggleSidebar());
        this.els.sidebar.parentElement.insertBefore(backdrop, this.els.sidebar);
      }
    } else if (existing) {
      existing.remove();
    }
  }


  /* ═══════════════════════════════════════════════════════════
     SIDEBAR RESIZE & COLLAPSE (DESKTOP)
     ═══════════════════════════════════════════════════════════ */

  toggleSidebarCollapse() {
    const sidebar = this.els.sidebar;
    const isCollapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('cwm_sidebarCollapsed', isCollapsed ? '1' : '0');

    // Trigger resize on terminal panes after animation
    setTimeout(() => {
      this.terminalPanes.forEach(tp => {
        if (tp && tp.fitAddon) tp.fitAddon.fit();
      });
    }, 250);
  }

  restoreSidebarState() {
    // Restore sidebar width
    const savedWidth = localStorage.getItem('cwm_sidebarWidth');
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= 180 && width <= 600) {
        this.els.sidebar.style.width = width + 'px';
      }
    }

    // Restore sidebar collapse
    const collapsed = localStorage.getItem('cwm_sidebarCollapsed');
    if (collapsed === '1') {
      this.els.sidebar.classList.add('collapsed');
    }
  }

  initSidebarResize() {
    const handle = this.els.sidebarResizeHandle;
    const sidebar = this.els.sidebar;
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newWidth = Math.max(180, Math.min(600, startWidth + dx));
      sidebar.style.width = newWidth + 'px';
      sidebar.style.transition = 'none'; // disable transition during drag
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      sidebar.style.transition = ''; // re-enable transition

      // Save width
      const finalWidth = parseInt(sidebar.style.width, 10);
      if (finalWidth) {
        localStorage.setItem('cwm_sidebarWidth', finalWidth.toString());
      }

      // Refit terminal panes
      this.terminalPanes.forEach(tp => {
        if (tp && tp.fitAddon) tp.fitAddon.fit();
      });

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', (e) => {
      // Don't resize if sidebar is collapsed
      if (sidebar.classList.contains('collapsed')) return;

      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  initSidebarSectionResize() {
    const handle = document.getElementById('sidebar-section-resize');
    if (!handle) return;

    const wsList = this.els.workspaceList;
    const projList = this.els.projectsList;
    if (!wsList || !projList) return;

    let isResizing = false;
    let startY = 0;
    let startWsHeight = 0;

    const onMove = (clientY) => {
      if (!isResizing) return;
      const dy = clientY - startY;
      const sidebar = this.els.sidebar;
      const sidebarRect = sidebar.getBoundingClientRect();
      const totalAvailable = sidebarRect.height - 200; // Reserve space for headers/footer
      const newWsHeight = Math.max(80, Math.min(totalAvailable, startWsHeight + dy));
      wsList.style.flex = 'none';
      wsList.style.height = newWsHeight + 'px';
      projList.style.flex = '1';
    };

    const onEnd = () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save to localStorage
      const height = parseInt(wsList.style.height, 10);
      if (height) localStorage.setItem('cwm_wsSectionHeight', height.toString());
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };

    const onMouseMove = (e) => onMove(e.clientY);
    const onMouseUp = () => onEnd();
    const onTouchMove = (e) => { e.preventDefault(); onMove(e.touches[0].clientY); };
    const onTouchEnd = () => onEnd();

    const startResize = (clientY) => {
      isResizing = true;
      startY = clientY;
      startWsHeight = wsList.getBoundingClientRect().height;
      handle.classList.add('active');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onTouchEnd);
    };

    handle.addEventListener('mousedown', (e) => { e.preventDefault(); startResize(e.clientY); });
    handle.addEventListener('touchstart', (e) => { e.preventDefault(); startResize(e.touches[0].clientY); }, { passive: false });

    // Restore saved height
    const saved = localStorage.getItem('cwm_wsSectionHeight');
    if (saved) {
      wsList.style.flex = 'none';
      wsList.style.height = saved + 'px';
      projList.style.flex = '1';
    }
  }


  /* ═══════════════════════════════════════════════════════════
     QUICK SWITCHER
     ═══════════════════════════════════════════════════════════ */

  openQuickSwitcher() {
    this.els.qsOverlay.hidden = false;
    this.els.qsInput.value = '';
    this.qsHighlightIndex = -1;
    this.renderQuickSwitcherResults('');
    // Small delay so animation plays before focus
    requestAnimationFrame(() => this.els.qsInput.focus());
  }

  closeQuickSwitcher() {
    this.els.qsOverlay.hidden = true;
    this.els.qsInput.value = '';
  }

  onQuickSwitcherInput() {
    const query = this.els.qsInput.value.trim().toLowerCase();
    this.qsHighlightIndex = query ? 0 : -1;
    this.renderQuickSwitcherResults(query);
  }

  onQuickSwitcherKeydown(e) {
    const total = this.qsResults.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.qsHighlightIndex = Math.min(this.qsHighlightIndex + 1, total - 1);
      this.updateQuickSwitcherHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.qsHighlightIndex = Math.max(this.qsHighlightIndex - 1, 0);
      this.updateQuickSwitcherHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.qsHighlightIndex >= 0 && this.qsResults[this.qsHighlightIndex]) {
        this.onQuickSwitcherSelect(this.qsResults[this.qsHighlightIndex]);
      }
    }
  }

  renderQuickSwitcherResults(query) {
    this.qsResults = [];
    const container = this.els.qsResultsContainer;

    if (!query) {
      // Show recent workspaces and sessions
      const recentWorkspaces = [...this.state.workspaces].sort((a, b) =>
        new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)
      ).slice(0, 3);
      const recentSessions = [...this.state.sessions].sort((a, b) =>
        new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)
      ).slice(0, 5);

      this.qsResults = [
        ...recentWorkspaces.map(w => ({ type: 'workspace', item: w })),
        ...recentSessions.map(s => ({ type: 'session', item: s })),
      ];
    } else {
      // Search
      const matchingWorkspaces = this.state.workspaces.filter(w =>
        w.name.toLowerCase().includes(query) ||
        (w.description && w.description.toLowerCase().includes(query))
      );
      const matchingSessions = this.state.sessions.filter(s =>
        s.name.toLowerCase().includes(query) ||
        (s.topic && s.topic.toLowerCase().includes(query)) ||
        (s.workingDir && s.workingDir.toLowerCase().includes(query))
      );

      this.qsResults = [
        ...matchingWorkspaces.map(w => ({ type: 'workspace', item: w })),
        ...matchingSessions.map(s => ({ type: 'session', item: s })),
      ];
    }

    if (this.qsResults.length === 0) {
      container.innerHTML = '<div class="qs-empty">No results found</div>';
      return;
    }

    let html = '';
    let lastType = '';
    this.qsResults.forEach((r, i) => {
      if (r.type !== lastType) {
        html += `<div class="qs-result-group">${r.type === 'workspace' ? 'Workspaces' : 'Sessions'}</div>`;
        lastType = r.type;
      }
      const highlighted = i === this.qsHighlightIndex ? ' highlighted' : '';
      if (r.type === 'workspace') {
        html += `
          <div class="qs-result${highlighted}" data-index="${i}">
            <div class="qs-result-icon">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <rect x="8" y="1" width="5" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <rect x="1" y="8" width="5" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <rect x="8" y="8" width="5" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
              </svg>
            </div>
            <div class="qs-result-info">
              <div class="qs-result-name">${this.escapeHtml(r.item.name)}</div>
              <div class="qs-result-detail">${r.item.sessions ? r.item.sessions.length : 0} sessions</div>
            </div>
            <span class="qs-result-type">workspace</span>
          </div>`;
      } else {
        html += `
          <div class="qs-result${highlighted}" data-index="${i}">
            <div class="qs-result-icon">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 2h8a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/>
                <path d="M5 6l2 2 2-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="qs-result-info">
              <div class="qs-result-name">${this.escapeHtml(r.item.name)}</div>
              <div class="qs-result-detail">${r.item.topic ? this.escapeHtml(r.item.topic) : (r.item.workingDir || '')}</div>
            </div>
            <span class="qs-result-type">${r.item.status || 'session'}</span>
          </div>`;
      }
    });

    container.innerHTML = html;

    // Bind click events on results
    container.querySelectorAll('.qs-result').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index, 10);
        if (this.qsResults[idx]) {
          this.onQuickSwitcherSelect(this.qsResults[idx]);
        }
      });
    });
  }

  updateQuickSwitcherHighlight() {
    const items = this.els.qsResultsContainer.querySelectorAll('.qs-result');
    items.forEach((el, i) => {
      el.classList.toggle('highlighted', i === this.qsHighlightIndex);
    });
    // Scroll into view
    if (items[this.qsHighlightIndex]) {
      items[this.qsHighlightIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  onQuickSwitcherSelect(result) {
    this.closeQuickSwitcher();
    if (result.type === 'workspace') {
      this.setViewMode('workspace');
      this.selectWorkspace(result.item.id);
    } else {
      this.selectSession(result.item.id);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     MODALS
     ═══════════════════════════════════════════════════════════ */

  showConfirmModal({ title, message, confirmText = 'Confirm', confirmClass = 'btn-primary' }) {
    return new Promise((resolve) => {
      this.modalResolve = resolve;
      this.els.modalTitle.textContent = title;
      this.els.modalBody.innerHTML = `<p>${message}</p>`;
      this.els.modalConfirmBtn.textContent = confirmText;
      this.els.modalConfirmBtn.className = `btn ${confirmClass}`;
      this.els.modalCancelBtn.textContent = 'Cancel';

      // Rebind confirm
      const confirmHandler = () => {
        this.els.modalConfirmBtn.removeEventListener('click', confirmHandler);
        this.closeModal(true);
      };
      this.els.modalConfirmBtn.addEventListener('click', confirmHandler);

      this.els.modalOverlay.hidden = false;
    });
  }

  showPromptModal({ title, fields, confirmText = 'Confirm', confirmClass = 'btn-primary' }) {
    return new Promise((resolve) => {
      this.modalResolve = resolve;
      this.els.modalTitle.textContent = title;

      const colorOptions = [
        { name: 'mauve', hex: '#cba6f7' },
        { name: 'blue', hex: '#89b4fa' },
        { name: 'green', hex: '#a6e3a1' },
        { name: 'red', hex: '#f38ba8' },
        { name: 'peach', hex: '#fab387' },
        { name: 'teal', hex: '#94e2d5' },
        { name: 'pink', hex: '#f5c2e7' },
        { name: 'yellow', hex: '#f9e2af' },
        { name: 'lavender', hex: '#b4befe' },
        { name: 'sapphire', hex: '#74c7ec' },
        { name: 'sky', hex: '#89dceb' },
        { name: 'flamingo', hex: '#f2cdcd' },
      ];

      let bodyHtml = '';
      fields.forEach(f => {
        if (f.type === 'hidden') {
          bodyHtml += `<input type="hidden" id="modal-field-${f.key}" value="${this.escapeHtml(f.value || '')}">`;
          return;
        }
        if (f.type === 'color') {
          const selectedColor = f.value || 'mauve';
          bodyHtml += `
            <div class="input-group">
              <label class="input-label">${f.label}</label>
              <div class="color-picker" id="modal-field-${f.key}">
                ${colorOptions.map(c => `
                  <div class="color-swatch${c.name === selectedColor ? ' selected' : ''}"
                       data-color="${c.name}"
                       style="background: ${c.hex}"
                       title="${c.name}">
                  </div>
                `).join('')}
              </div>
            </div>`;
          return;
        }
        if (f.type === 'select') {
          bodyHtml += `
            <div class="input-group">
              <label class="input-label" for="modal-field-${f.key}">${f.label}</label>
              <select id="modal-field-${f.key}" class="input" ${f.required ? 'required' : ''}>
                ${(f.options || []).map(o =>
                  `<option value="${this.escapeHtml(o.value)}">${this.escapeHtml(o.label)}</option>`
                ).join('')}
              </select>
            </div>`;
          return;
        }
        const tag = f.type === 'textarea' ? 'textarea' : 'input';
        const typeAttr = f.type === 'textarea' ? '' : `type="${f.type || 'text'}"`;
        bodyHtml += `
          <div class="input-group">
            <label class="input-label" for="modal-field-${f.key}">${f.label}</label>
            <${tag} id="modal-field-${f.key}" class="input" ${typeAttr}
              placeholder="${this.escapeHtml(f.placeholder || '')}"
              value="${tag === 'input' ? this.escapeHtml(f.value || '') : ''}"
              ${f.required ? 'required' : ''}
            >${tag === 'textarea' ? this.escapeHtml(f.value || '') : ''}</${tag === 'textarea' ? 'textarea' : ''}>
          </div>`;
      });

      this.els.modalBody.innerHTML = bodyHtml;
      this.els.modalConfirmBtn.textContent = confirmText;
      this.els.modalConfirmBtn.className = `btn ${confirmClass}`;
      this.els.modalCancelBtn.textContent = 'Cancel';

      // Color picker behavior
      const colorPickers = this.els.modalBody.querySelectorAll('.color-picker');
      colorPickers.forEach(picker => {
        picker.querySelectorAll('.color-swatch').forEach(swatch => {
          swatch.addEventListener('click', () => {
            picker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
          });
        });
      });

      // Confirm handler
      const confirmHandler = () => {
        this.els.modalConfirmBtn.removeEventListener('click', confirmHandler);
        const result = {};
        fields.forEach(f => {
          if (f.type === 'color') {
            const selected = this.els.modalBody.querySelector(`#modal-field-${f.key} .color-swatch.selected`);
            result[f.key] = selected ? selected.dataset.color : 'mauve';
          } else {
            const el = document.getElementById(`modal-field-${f.key}`);
            if (el) result[f.key] = el.value;
          }
        });
        // Validate required
        for (const f of fields) {
          if (f.required && !result[f.key]) {
            const el = document.getElementById(`modal-field-${f.key}`);
            if (el && el.focus) el.focus();
            return;
          }
        }
        this.closeModal(result);
      };
      this.els.modalConfirmBtn.addEventListener('click', confirmHandler);

      this.els.modalOverlay.hidden = false;

      // Focus first visible input
      requestAnimationFrame(() => {
        const firstInput = this.els.modalBody.querySelector('input:not([type="hidden"]), textarea, select');
        if (firstInput) firstInput.focus();
      });
    });
  }

  closeModal(result) {
    this.els.modalOverlay.hidden = true;
    if (this.modalResolve) {
      this.modalResolve(result);
      this.modalResolve = null;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     TOASTS
     ═══════════════════════════════════════════════════════════ */

  showToast(message, level = 'info') {
    const icons = {
      info: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M9 8v4M9 6v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      success: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M6 9.5l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      warning: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2l7.5 13H1.5L9 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 7.5v3M9 12.5v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      error: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 6.5l5 5M11.5 6.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${level}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[level] || icons.info}</span>
      <span class="toast-message">${this.escapeHtml(message)}</span>
      <button class="toast-close" aria-label="Dismiss">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => this.dismissToast(toast));

    this.els.toastContainer.appendChild(toast);

    // Auto-dismiss after 4 seconds
    setTimeout(() => this.dismissToast(toast), 4000);
  }

  dismissToast(toast) {
    if (!toast.parentNode) return;
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }


  /* ═══════════════════════════════════════════════════════════
     SSE (Server-Sent Events)
     ═══════════════════════════════════════════════════════════ */

  connectSSE() {
    this.disconnectSSE();

    try {
      // SSE doesn't support custom headers, pass token as query param
      this.eventSource = new EventSource(`/api/events?token=${encodeURIComponent(this.state.token)}`);

      this.eventSource.onopen = () => {
        console.log('[SSE] Connected');
      };

      this.eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          this.handleSSEEvent(data);
        } catch {
          // ignore unparseable
        }
      };

      this.eventSource.onerror = (e) => {
        // If readyState is CLOSED, the server rejected the connection (likely 401)
        if (this.eventSource && this.eventSource.readyState === EventSource.CLOSED) {
          console.warn('[SSE] Connection rejected (auth expired?). Not retrying.');
          this.disconnectSSE();
          return;
        }
        console.warn('[SSE] Connection lost, retrying in 5s...');
        this.disconnectSSE();
        this.sseRetryTimeout = setTimeout(() => this.connectSSE(), 5000);
      };
    } catch (err) {
      console.error('[SSE] Failed to connect:', err);
    }
  }

  disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sseRetryTimeout) {
      clearTimeout(this.sseRetryTimeout);
      this.sseRetryTimeout = null;
    }
  }

  handleSSEEvent(data) {
    switch (data.type) {
      case 'session:started':
        this.showToast(`Session "${data.name || 'unknown'}" started`, 'success');
        this.loadSessions();
        this.loadStats();
        break;
      case 'session:stopped':
        this.showToast(`Session "${data.name || 'unknown'}" stopped`, 'info');
        this.loadSessions();
        this.loadStats();
        break;
      case 'session:error':
        this.showToast(`Session "${data.name || 'unknown'}" encountered an error`, 'error');
        this.loadSessions();
        this.loadStats();
        break;
      case 'session:created':
      case 'session:deleted':
      case 'session:updated':
        this.loadSessions();
        this.loadStats();
        break;
      case 'workspace:created':
      case 'workspace:deleted':
      case 'workspace:updated':
        this.loadWorkspaces();
        this.loadStats();
        break;
      case 'stats:updated':
        if (data.stats) {
          this.state.stats = data.stats;
          this.renderStats();
        }
        break;
      case 'docs:updated':
        // Reload docs if we're viewing docs for the updated workspace
        if (this.state.viewMode === 'docs' && this.state.activeWorkspace &&
            data.data && data.data.workspaceId === this.state.activeWorkspace.id) {
          this.loadDocs();
        }
        break;
      default:
        // Refresh all for unknown events
        this.loadAll();
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RENDERING
     ═══════════════════════════════════════════════════════════ */

  renderWorkspaces() {
    const list = this.els.workspaceList;
    const workspaces = this.state.workspaces;

    if (workspaces.length === 0) {
      list.innerHTML = `
        <div style="padding: 24px 12px; text-align: center;">
          <p style="font-size: 12px; color: var(--overlay0); margin-bottom: 8px;">No workspaces</p>
          <button class="btn btn-ghost btn-sm" id="sidebar-create-ws">Create one</button>
        </div>`;
      const btn = document.getElementById('sidebar-create-ws');
      if (btn) btn.addEventListener('click', () => this.createWorkspace());
      this.els.workspaceCount.textContent = '0 workspaces';
      return;
    }

    const colorMap = {
      mauve: '#cba6f7', blue: '#89b4fa', green: '#a6e3a1', red: '#f38ba8',
      peach: '#fab387', teal: '#94e2d5', pink: '#f5c2e7', yellow: '#f9e2af',
      lavender: '#b4befe', sapphire: '#74c7ec', sky: '#89dceb', flamingo: '#f2cdcd',
      rosewater: '#f5e0dc',
    };

    const renderWorkspaceItem = (ws) => {
      const isActive = this.state.activeWorkspace && this.state.activeWorkspace.id === ws.id;
      const color = colorMap[ws.color] || colorMap.mauve;
      const allWsSessions = (this.state.allSessions || this.state.sessions).filter(s => s.workspaceId === ws.id);
      const wsSessions = allWsSessions.filter(s => this.state.showHidden || !this.state.hiddenSessions.has(s.id));
      const hiddenCount = allWsSessions.length - wsSessions.length;
      const sessionCount = wsSessions.length;

      // Group sessions by workingDir for nested display
      const projectGroupState = JSON.parse(localStorage.getItem('cwm_projectGroupState') || '{}');
      const sessionsByDir = {};
      wsSessions.forEach(s => {
        const dir = s.workingDir || '(no directory)';
        if (!sessionsByDir[dir]) sessionsByDir[dir] = [];
        sessionsByDir[dir].push(s);
      });

      const renderSessionItem = (s) => {
        const isHidden = this.state.hiddenSessions.has(s.id);
        const statusDot = s.status === 'running' ? 'var(--green)' : 'var(--overlay0)';
        const name = s.name || s.id.substring(0, 12);
        const timeStr = s.lastActive ? this.relativeTime(s.lastActive) : '';
        return `<div class="ws-session-item${isHidden ? ' ws-session-hidden' : ''}" data-session-id="${s.id}" draggable="true" title="${this.escapeHtml(s.workingDir || '')}">
          <span class="ws-session-dot" style="background: ${statusDot}"></span>
          <span class="ws-session-name">${this.escapeHtml(name.length > 22 ? name.substring(0, 22) + '...' : name)}</span>
          ${timeStr ? `<span class="ws-session-time">${timeStr}</span>` : ''}
        </div>`;
      };

      const dirKeys = Object.keys(sessionsByDir);
      let sessionItems;
      if (dirKeys.length <= 1) {
        // Single directory or no sessions — flat list (no nesting needed)
        sessionItems = wsSessions.map(renderSessionItem).join('');
      } else {
        // Multiple directories — group into nested accordions
        sessionItems = dirKeys.map(dir => {
          const dirSessions = sessionsByDir[dir];
          const groupKey = ws.id + ':' + dir;
          const isCollapsed = projectGroupState[groupKey] === false;
          // Show last 2 path segments for readability
          const parts = dir.replace(/\\/g, '/').split('/');
          const shortDir = parts.slice(-2).join('/');
          return `<div class="ws-project-group" data-group-key="${this.escapeHtml(groupKey)}">
            <div class="ws-project-group-header" title="${this.escapeHtml(dir)}">
              <span class="ws-project-group-chevron${isCollapsed ? ' collapsed' : ''}">&#9654;</span>
              <span class="ws-project-group-path">${this.escapeHtml(shortDir)}</span>
              <span class="ws-project-group-count">${dirSessions.length}</span>
            </div>
            <div class="ws-project-group-body${isCollapsed ? ' collapsed' : ''}">
              ${dirSessions.map(renderSessionItem).join('')}
            </div>
          </div>`;
        }).join('');
      }

      return `
        <div class="workspace-accordion" data-id="${ws.id}">
          <div class="workspace-item${isActive ? ' active' : ''}" data-id="${ws.id}" draggable="true">
            <span class="ws-chevron${isActive ? ' open' : ''}">&#9654;</span>
            <div class="workspace-color-dot" style="background: ${color}"></div>
            <div class="workspace-info">
              <div class="workspace-name">${this.escapeHtml(ws.name)}</div>
              <div class="workspace-session-count">${sessionCount} session${sessionCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="workspace-actions">
              <button class="btn btn-ghost btn-icon btn-sm ws-rename-btn" data-id="${ws.id}" title="Edit">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M8.5 2.5l3 3M2 9.5V12h2.5L11 5.5l-3-3L2 9.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="btn btn-ghost btn-icon btn-sm btn-danger-hover ws-delete-btn" data-id="${ws.id}" title="Delete">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 4h9M5 4V2.5h4V4M3.5 4v7.5a1 1 0 001 1h5a1 1 0 001-1V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="workspace-accordion-body"${isActive ? '' : ' hidden'}>
            ${sessionItems || '<div class="ws-session-empty">No sessions</div>'}
          </div>
        </div>`;
    };

    // Split workspaces into grouped and ungrouped
    const groups = this.state.groups || [];
    const groupedIds = new Set();
    groups.forEach(g => (g.workspaceIds || []).forEach(id => groupedIds.add(id)));
    const ungrouped = workspaces.filter(ws => !groupedIds.has(ws.id));

    let html = '';

    // Render ungrouped workspaces first
    html += ungrouped.map(ws => renderWorkspaceItem(ws)).join('');

    // Render groups
    groups.forEach(group => {
      const groupColor = colorMap[group.color] || colorMap.mauve;
      const groupWorkspaces = (group.workspaceIds || [])
        .map(id => workspaces.find(ws => ws.id === id))
        .filter(Boolean);

      if (groupWorkspaces.length === 0) return;

      html += `
        <div class="workspace-group" data-group-id="${group.id}">
          <div class="workspace-group-header" data-group-id="${group.id}">
            <span class="group-chevron">&#9662;</span>
            <span class="group-color-dot" style="background: ${groupColor}"></span>
            <span>${this.escapeHtml(group.name)}</span>
          </div>
          <div class="workspace-group-items">
            ${groupWorkspaces.map(ws => renderWorkspaceItem(ws)).join('')}
          </div>
        </div>`;
    });

    list.innerHTML = html;

    // Bind workspace item events
    list.querySelectorAll('.workspace-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.ws-rename-btn') || e.target.closest('.ws-delete-btn')) return;
        const wsId = el.dataset.id;
        this.selectWorkspace(wsId);

        // Toggle accordion body
        const accordion = el.closest('.workspace-accordion');
        if (accordion) {
          const body = accordion.querySelector('.workspace-accordion-body');
          const chevron = el.querySelector('.ws-chevron');
          const isOpen = body && !body.hidden;
          // Close all other accordions
          list.querySelectorAll('.workspace-accordion-body').forEach(b => b.hidden = true);
          list.querySelectorAll('.ws-chevron').forEach(c => c.classList.remove('open'));
          // Open this one (or close if it was already open)
          if (body) body.hidden = isOpen;
          if (chevron) chevron.classList.toggle('open', !isOpen);
        }
      });

      // Context menu on workspace items
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showWorkspaceContextMenu(el.dataset.id, e.clientX, e.clientY);
      });

      // Long-press for mobile (500ms hold)
      let wsLongPress = null;
      el.addEventListener('touchstart', (e) => {
        wsLongPress = setTimeout(() => {
          e.preventDefault();
          const touch = e.touches[0];
          this.showWorkspaceContextMenu(el.dataset.id, touch.clientX, touch.clientY);
        }, 500);
      }, { passive: false });
      el.addEventListener('touchend', () => clearTimeout(wsLongPress));
      el.addEventListener('touchmove', () => clearTimeout(wsLongPress));

      // Drag events for workspace reorder
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('cwm/workspace', el.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
      });

      // Accept session drops (move session to workspace) and workspace drops (reorder)
      el.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('cwm/session')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          el.classList.add('workspace-drop-target');
        } else if (e.dataTransfer.types.includes('cwm/workspace')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          // Show drop indicator above or below based on mouse position
          const rect = el.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          el.classList.remove('ws-drop-before', 'ws-drop-after');
          if (e.clientY < midY) {
            el.classList.add('ws-drop-before');
          } else {
            el.classList.add('ws-drop-after');
          }
        }
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('workspace-drop-target', 'ws-drop-before', 'ws-drop-after');
      });
      el.addEventListener('drop', (e) => {
        const dropBefore = el.classList.contains('ws-drop-before');
        el.classList.remove('workspace-drop-target', 'ws-drop-before', 'ws-drop-after');

        // Handle session drop — move session to this workspace
        const sessionId = e.dataTransfer.getData('cwm/session');
        if (sessionId) {
          e.preventDefault();
          e.stopPropagation();
          const targetWsId = el.dataset.id;
          const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
          if (session && session.workspaceId !== targetWsId) {
            this.moveSessionToWorkspace(sessionId, targetWsId);
          }
          return;
        }

        // Handle workspace drop — reorder
        const draggedWsId = e.dataTransfer.getData('cwm/workspace');
        if (draggedWsId && draggedWsId !== el.dataset.id) {
          e.preventDefault();
          e.stopPropagation();
          this.reorderWorkspace(draggedWsId, el.dataset.id, dropBefore ? 'before' : 'after');
        }
      });
    });

    // Bind project group accordion toggle
    list.querySelectorAll('.ws-project-group-header').forEach(hdr => {
      hdr.addEventListener('click', (e) => {
        e.stopPropagation();
        const group = hdr.closest('.ws-project-group');
        const body = group.querySelector('.ws-project-group-body');
        const chevron = hdr.querySelector('.ws-project-group-chevron');
        const key = group.dataset.groupKey;
        const isCollapsed = body.classList.toggle('collapsed');
        chevron.classList.toggle('collapsed', isCollapsed);
        // Persist state
        const state = JSON.parse(localStorage.getItem('cwm_projectGroupState') || '{}');
        state[key] = !isCollapsed;
        localStorage.setItem('cwm_projectGroupState', JSON.stringify(state));
      });
    });

    // Bind workspace session item events (drag to terminal, click to select)
    list.querySelectorAll('.ws-session-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = el.dataset.sessionId;
        const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
        if (!session) return;

        if (this.state.viewMode === 'terminal') {
          // In terminal view, clicking a session opens it in the next empty terminal pane
          const emptySlot = this.terminalPanes.findIndex(p => p === null);
          if (emptySlot !== -1) {
            if (!session.resumeSessionId) {
              this.showToast('Starting new Claude session (no previous conversation to resume)', 'info');
            }
            this.openTerminalInPane(emptySlot, sessionId, session.name);
          } else {
            this.showToast('All terminal panes are full. Close one first.', 'warning');
          }
        } else {
          this.state.selectedSession = session;
          this.renderSessionDetail();
        }
      });
      // Right-click context menu on sidebar session items
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showContextMenu(el.dataset.sessionId, e.clientX, e.clientY);
      });

      // Long-press for mobile (500ms hold)
      let wsSessLongPress = null;
      el.addEventListener('touchstart', (e) => {
        wsSessLongPress = setTimeout(() => {
          e.preventDefault();
          const touch = e.touches[0];
          this.showContextMenu(el.dataset.sessionId, touch.clientX, touch.clientY);
        }, 500);
      }, { passive: false });
      el.addEventListener('touchend', () => clearTimeout(wsSessLongPress));
      el.addEventListener('touchmove', () => clearTimeout(wsSessLongPress));

      // Double-click session name for inline rename
      const nameEl = el.querySelector('.ws-session-name');
      if (nameEl) {
        nameEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this.startInlineRename(nameEl, el.dataset.sessionId, true);
        });
      }

      el.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        console.log('[DnD] Drag started: ws-session-item', el.dataset.sessionId);
        e.dataTransfer.setData('cwm/session', el.dataset.sessionId);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });

    list.querySelectorAll('.ws-rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.renameWorkspace(btn.dataset.id);
      });
    });

    list.querySelectorAll('.ws-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteWorkspace(btn.dataset.id);
      });
    });

    // Bind group collapse toggle
    list.querySelectorAll('.workspace-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const group = header.closest('.workspace-group');
        const items = group.querySelector('.workspace-group-items');
        const chevron = header.querySelector('.group-chevron');
        if (items) items.classList.toggle('collapsed');
        if (chevron) chevron.classList.toggle('collapsed');
      });
    });

    this.els.workspaceCount.textContent = `${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''}`;
  }

  showWorkspaceContextMenu(workspaceId, x, y) {
    const ws = this.state.workspaces.find(w => w.id === workspaceId);
    if (!ws) return;

    const groups = this.state.groups || [];
    const groupItems = groups.map(g => ({
      label: g.name,
      icon: '&#9673;',
      action: () => this.moveWorkspaceToGroup(workspaceId, g.id),
    }));

    const wsSessions = this.state.sessions.filter(s => s.workspaceId === workspaceId);
    const visibleSessions = wsSessions.filter(s => !this.state.hiddenSessions.has(s.id));

    const items = [
      // Quick actions
      { label: 'Open Terminal', icon: '&#9654;', action: () => {
        const emptySlot = this.terminalPanes.findIndex(p => p === null);
        if (emptySlot === -1) { this.showToast('All terminal panes full', 'warning'); return; }
        // Create a new session in this workspace and open terminal
        this.api('POST', '/api/sessions', { name: `${ws.name} terminal`, workspaceId }).then(data => {
          if (data && data.session) {
            this.loadSessions();
            this.setViewMode('terminal');
            this.openTerminalInPane(emptySlot, data.session.id, ws.name);
          }
        }).catch(err => this.showToast(err.message, 'error'));
      }},
      { label: 'View Docs', icon: '&#128196;', action: () => {
        this.selectWorkspace(workspaceId);
        this.setViewMode('docs');
      }},
      { label: 'Add Session', icon: '&#43;', action: () => {
        this.selectWorkspace(workspaceId);
        this.createSession();
      }},
      { type: 'sep' },
      { label: 'Edit', icon: '&#9998;', action: () => this.renameWorkspace(workspaceId) },
      { type: 'sep' },
      ...(groupItems.length > 0 ? [
        { label: 'Move to Group', icon: '&#8594;', disabled: true },
        ...groupItems,
        { type: 'sep' },
      ] : []),
      { label: 'New Group...', icon: '&#43;', action: () => this.createGroup() },
    ];

    // Hide all sessions
    if (visibleSessions.length > 0) {
      items.push({ type: 'sep' });
      items.push({ label: `Hide All Sessions (${visibleSessions.length})`, icon: '&#128065;', action: () => {
        visibleSessions.forEach(s => this.state.hiddenSessions.add(s.id));
        localStorage.setItem('cwm_hiddenSessions', JSON.stringify([...this.state.hiddenSessions]));
        this.renderWorkspaces();
        this.renderSessions();
        this.showToast(`Hidden ${visibleSessions.length} sessions`, 'info');
      }});
    }

    items.push({ type: 'sep' });
    items.push({ label: 'Delete Workspace', icon: '&#10005;', action: () => this.deleteWorkspace(workspaceId), danger: true });

    this._renderContextItems(ws.name, items, x, y);
  }

  async createGroup() {
    const result = await this.showPromptModal({
      title: 'New Group',
      fields: [
        { key: 'name', label: 'Group Name', placeholder: 'My Group', required: true },
        { key: 'color', label: 'Color', type: 'color' },
      ],
      confirmText: 'Create',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      await this.api('POST', '/api/groups', { name: result.name, color: result.color || 'mauve' });
      this.showToast('Group created', 'success');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to create group', 'error');
    }
  }

  async moveWorkspaceToGroup(workspaceId, groupId) {
    try {
      await this.api('POST', `/api/groups/${groupId}/add`, { workspaceId });
      this.showToast('Workspace moved to group', 'success');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to move workspace', 'error');
    }
  }

  renderSessions() {
    const list = this.els.sessionList;
    const sessions = this.state.sessions.filter(s => this.state.showHidden || !this.state.hiddenSessions.has(s.id));
    const empty = this.els.sessionEmpty;

    if (sessions.length === 0) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    list.innerHTML = sessions.map(s => {
      const isSelected = this.state.selectedSession && this.state.selectedSession.id === s.id;
      const statusClass = `status-dot-${s.status || 'stopped'}`;

      // Build flags badges
      const flagBadges = [];
      if (s.bypassPermissions) flagBadges.push('<span class="status-badge" style="font-size:10px;padding:1px 6px;background:rgba(249,226,175,0.1);color:var(--yellow);">bypass</span>');
      if (s.model) {
        const modelShort = s.model.includes('opus') ? 'opus' : s.model.includes('haiku') ? 'haiku' : s.model.includes('sonnet') ? 'sonnet' : '';
        if (modelShort) flagBadges.push('<span class="status-badge" style="font-size:10px;padding:1px 6px;background:rgba(203,166,247,0.1);color:var(--mauve);">' + modelShort + '</span>');
      }

      return `
        <div class="session-item${isSelected ? ' active' : ''}" data-id="${s.id}" draggable="true">
          <div class="session-status">
            <span class="status-dot ${statusClass}"></span>
          </div>
          <div class="session-info">
            <div class="session-name">${this.escapeHtml(s.name)} ${flagBadges.join(' ')}</div>
            <div class="session-meta-row">
              ${s.workingDir ? `<span class="session-dir" title="${this.escapeHtml(s.workingDir)}">${this.escapeHtml(this.truncatePath(s.workingDir))}</span>` : ''}
              ${s.topic ? `<span class="session-topic">${this.escapeHtml(s.topic)}</span>` : ''}
            </div>
          </div>
          <span class="session-time">${this.relativeTime(s.lastActive || s.createdAt)}</span>
        </div>`;
    }).join('');

    // Bind events
    list.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', () => this.selectSession(el.dataset.id));

      // Right-click context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showContextMenu(el.dataset.id, e.clientX, e.clientY);
      });

      // Long-press for mobile (500ms hold)
      let longPressTimer = null;
      el.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
          e.preventDefault();
          const touch = e.touches[0];
          this.showContextMenu(el.dataset.id, touch.clientX, touch.clientY);
        }, 500);
      }, { passive: false });
      el.addEventListener('touchend', () => clearTimeout(longPressTimer));
      el.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    });
  }

  renderSessionDetail() {
    const session = this.state.selectedSession;
    // Never show detail panel in terminal or docs view
    if (!session || this.state.viewMode === 'terminal' || this.state.viewMode === 'docs') {
      this.els.detailPanel.hidden = true;
      return;
    }

    this.els.detailPanel.hidden = false;

    // Status dot
    this.els.detailStatusDot.className = `detail-status-dot status-dot-${session.status || 'stopped'}`;

    // Title
    this.els.detailTitle.textContent = session.name;

    // Status badge
    const status = session.status || 'stopped';
    const statusIcons = {
      running: '<span class="status-dot status-dot-running"></span>',
      stopped: '<span class="status-dot status-dot-stopped"></span>',
      error: '<span class="status-dot status-dot-error"></span>',
      idle: '<span class="status-dot status-dot-idle"></span>',
    };
    this.els.detailStatusBadge.innerHTML = `<span class="status-badge status-badge-${status}">${statusIcons[status] || ''} ${status}</span>`;

    // Meta
    const ws = this.state.workspaces.find(w => w.id === session.workspaceId);
    this.els.detailWorkspace.textContent = ws ? ws.name : 'None';
    this.els.detailDir.textContent = session.workingDir || '--';
    this.els.detailTopic.textContent = session.topic || '--';
    // Build full command display with flags
    let cmdDisplay = session.command || 'claude';
    if (session.model) {
      const modelShort = session.model.includes('opus') ? 'opus' : session.model.includes('sonnet') ? 'sonnet' : session.model.includes('haiku') ? 'haiku' : session.model;
      cmdDisplay += ' --model ' + modelShort;
    }
    if (session.bypassPermissions) cmdDisplay += ' --dangerously-skip-permissions';
    if (session.verbose) cmdDisplay += ' --verbose';
    this.els.detailCommand.textContent = cmdDisplay;
    this.els.detailPid.textContent = session.pid || '--';
    this.els.detailCreated.textContent = session.createdAt ? this.formatDateTime(session.createdAt) : '--';
    this.els.detailLastActive.textContent = session.lastActive ? this.relativeTime(session.lastActive) : '--';

    // Control buttons — enable/disable based on status
    const isRunning = status === 'running' || status === 'idle';
    this.els.detailStartBtn.disabled = isRunning;
    this.els.detailStopBtn.disabled = !isRunning;
    this.els.detailRestartBtn.disabled = !isRunning;

    // Logs
    this.renderLogs(session.logs || []);
  }

  renderLogs(logs) {
    const container = this.els.detailLogs;
    if (!logs || logs.length === 0) {
      container.innerHTML = '<div class="logs-empty">No activity recorded</div>';
      return;
    }
    container.innerHTML = logs.map(log => `
      <div class="log-entry">
        <span class="log-time">${this.formatTime(log.time)}</span>
        <span class="log-message">${this.escapeHtml(log.message)}</span>
      </div>
    `).join('');
    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  renderStats() {
    const { totalSessions, runningSessions } = this.state.stats;
    this.els.statRunning.textContent = runningSessions || 0;
    this.els.statTotal.textContent = totalSessions || 0;
  }


  /* ═══════════════════════════════════════════════════════════
     PROJECTS PANEL
     ═══════════════════════════════════════════════════════════ */

  async loadProjects() {
    try {
      // Try sessionStorage cache first
      const cached = sessionStorage.getItem('cwm_projects');
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed.ts && Date.now() - parsed.ts < 30000) {
            this.state.projects = parsed.data || [];
            this.renderProjects();
            return;
          }
        } catch { /* ignore stale cache */ }
      }

      const data = await this.api('GET', '/api/discover');
      this.state.projects = data.projects || [];
      // Cache for 30s
      sessionStorage.setItem('cwm_projects', JSON.stringify({ ts: Date.now(), data: this.state.projects }));
      this.renderProjects();
    } catch {
      // Non-critical — projects panel just stays empty
    }
  }

  renderProjects() {
    const list = this.els.projectsList;
    if (!list) return;

    const projects = this.state.projects;
    if (projects.length === 0) {
      list.innerHTML = '<div style="padding: 12px; text-align: center; font-size: 12px; color: var(--overlay0);">No projects found</div>';
      return;
    }

    list.innerHTML = projects.map(p => {
      const name = p.realPath ? (p.realPath.split('\\').pop() || p.encodedName) : p.encodedName;
      const encoded = p.encodedName || '';
      const missingClass = !p.dirExists ? ' missing' : '';
      const sizeStr = p.totalSize ? this.formatSize(p.totalSize) : '';
      const allSessions = p.sessions || [];
      // Filter out hidden project sessions (unless showHidden is on)
      const sessions = allSessions.filter(s => this.state.showHidden || !this.state.hiddenProjectSessions.has(s.name));

      // Build session sub-items
      const sessionItems = sessions.map(s => {
        const sessName = s.name || 'unnamed';
        const storedTitle = this.getProjectSessionTitle(sessName);
        const displayName = storedTitle || (sessName.length > 24 ? sessName.substring(0, 24) + '...' : sessName);
        const sessSize = s.size ? this.formatSize(s.size) : '';
        const sessTime = s.modified ? this.relativeTime(s.modified) : '';
        return `<div class="project-session-item" draggable="true" data-session-name="${this.escapeHtml(sessName)}" data-project-path="${this.escapeHtml(p.realPath || '')}" data-project-encoded="${this.escapeHtml(encoded)}">
          <span class="project-session-name" title="${this.escapeHtml(sessName)}">${this.escapeHtml(displayName)}</span>
          ${sessSize ? `<span class="project-session-size">${sessSize}</span>` : ''}
          ${sessTime ? `<span class="project-session-time">${sessTime}</span>` : ''}
        </div>`;
      }).join('');

      return `<div class="project-accordion${missingClass}" data-encoded="${this.escapeHtml(encoded)}" data-path="${this.escapeHtml(p.realPath || '')}">
        <div class="project-accordion-header" draggable="${p.dirExists ? 'true' : 'false'}">
          <span class="project-accordion-chevron">&#9654;</span>
          <span class="project-name" title="${this.escapeHtml(p.realPath || '')}">${this.escapeHtml(name)}</span>
          <span class="project-session-count">${sessions.length}</span>
          ${sizeStr ? `<span class="project-size">${sizeStr}</span>` : ''}
        </div>
        <div class="project-accordion-body" hidden>
          ${sessionItems || '<div style="padding: 6px 12px 6px 28px; font-size: 11px; color: var(--overlay0);">No sessions</div>'}
        </div>
      </div>`;
    }).join('');

    // Bind accordion toggle
    list.querySelectorAll('.project-accordion-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('[draggable]') && e.target.classList.contains('project-session-item')) return;
        const accordion = header.closest('.project-accordion');
        const body = accordion.querySelector('.project-accordion-body');
        const chevron = header.querySelector('.project-accordion-chevron');
        const isOpen = !body.hidden;
        body.hidden = isOpen;
        chevron.classList.toggle('open', !isOpen);
      });

      // Drag entire project
      header.addEventListener('dragstart', (e) => {
        const accordion = header.closest('.project-accordion');
        e.dataTransfer.setData('cwm/project', JSON.stringify({
          encoded: accordion.dataset.encoded,
          path: accordion.dataset.path,
          name: header.querySelector('.project-name').textContent,
        }));
        e.dataTransfer.effectAllowed = 'copy';
        header.classList.add('dragging');
      });
      header.addEventListener('dragend', () => header.classList.remove('dragging'));
    });

    // Bind drag + context menu on individual session items inside projects
    list.querySelectorAll('.project-session-item').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.stopPropagation(); // don't trigger parent project drag
        e.dataTransfer.setData('cwm/project-session', JSON.stringify({
          sessionName: el.dataset.sessionName,
          projectPath: el.dataset.projectPath,
          projectEncoded: el.dataset.projectEncoded,
        }));
        e.dataTransfer.effectAllowed = 'copy';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));

      // Right-click context menu on project sessions
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showProjectSessionContextMenu(el.dataset.sessionName, el.dataset.projectPath, e.clientX, e.clientY);
      });

      // Long-press for mobile (500ms hold)
      let longPressTimer = null;
      el.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
          e.preventDefault();
          const touch = e.touches[0];
          this.showProjectSessionContextMenu(el.dataset.sessionName, el.dataset.projectPath, touch.clientX, touch.clientY);
        }, 500);
      }, { passive: false });
      el.addEventListener('touchend', () => clearTimeout(longPressTimer));
      el.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    });
  }

  toggleProjectsPanel() {
    this.state.projectsCollapsed = !this.state.projectsCollapsed;
    const list = this.els.projectsList;
    if (list) {
      list.hidden = this.state.projectsCollapsed;
    }
    // Rotate the toggle chevron
    const toggle = this.els.projectsToggle;
    if (toggle) {
      const svg = toggle.querySelector('svg');
      if (svg) {
        svg.style.transform = this.state.projectsCollapsed ? 'rotate(-90deg)' : '';
        svg.style.transition = 'transform var(--transition-fast)';
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════
     WORKSPACE GROUPS
     ═══════════════════════════════════════════════════════════ */

  async loadGroups() {
    try {
      const data = await this.api('GET', '/api/groups');
      this.state.groups = data.groups || [];
    } catch {
      this.state.groups = [];
    }
  }


  /* ═══════════════════════════════════════════════════════════
     DRAG & DROP SYSTEM
     ═══════════════════════════════════════════════════════════ */

  initDragAndDrop() {
    // Session items: make draggable
    this.els.sessionList.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.session-item');
      if (!item) return;
      console.log('[DnD] Drag started: session-item', item.dataset.id);
      e.dataTransfer.setData('cwm/session', item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    this.els.sessionList.addEventListener('dragend', (e) => {
      const item = e.target.closest('.session-item');
      if (item) item.classList.remove('dragging');
    });

    // Workspace items: accept project + project-session drops to create sessions
    this.els.workspaceList.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('cwm/project') || e.dataTransfer.types.includes('cwm/project-session')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const item = e.target.closest('.workspace-item');
        if (item) item.classList.add('drag-over');
      }
    });
    this.els.workspaceList.addEventListener('dragleave', (e) => {
      const item = e.target.closest('.workspace-item');
      if (item) item.classList.remove('drag-over');
    });
    this.els.workspaceList.addEventListener('drop', async (e) => {
      e.preventDefault();
      const item = e.target.closest('.workspace-item');
      if (item) item.classList.remove('drag-over');
      if (!item) return;

      const workspaceId = item.dataset.id;

      // Drop a project-session (individual .jsonl from project accordion)
      const projSessJson = e.dataTransfer.getData('cwm/project-session');
      if (projSessJson) {
        try {
          const ps = JSON.parse(projSessJson);
          const claudeSessionId = ps.sessionName;
          // Create a friendly default name: project folder name + short session ID
          const projectName = ps.projectPath ? (ps.projectPath.split('\\').pop() || ps.projectPath.split('/').pop() || claudeSessionId) : claudeSessionId;
          const shortId = claudeSessionId.length > 8 ? claudeSessionId.substring(0, 8) : claudeSessionId;
          const friendlyName = projectName + ' (' + shortId + ')';
          await this.api('POST', '/api/sessions', {
            name: friendlyName,
            workspaceId,
            workingDir: ps.projectPath,
            topic: 'Resumed session',
            command: 'claude',
            resumeSessionId: claudeSessionId,
          });
          this.showToast(`Session "${friendlyName}" added`, 'success');
          await this.loadSessions();
          await this.loadStats();
          this.renderWorkspaces();
        } catch (err) {
          this.showToast(err.message || 'Failed to create session', 'error');
        }
        return;
      }

      // Drop an entire project
      const projectJson = e.dataTransfer.getData('cwm/project');
      if (projectJson) {
        try {
          const project = JSON.parse(projectJson);
          await this.api('POST', '/api/sessions', {
            name: project.name,
            workspaceId,
            workingDir: project.path,
            topic: '',
            command: 'claude',
          });
          this.showToast(`Session "${project.name}" created`, 'success');
          await this.loadSessions();
          await this.loadStats();
        } catch (err) {
          this.showToast(err.message || 'Failed to create session from project', 'error');
        }
      }
    });

    // Terminal panes: accept session and project drops
    if (this.els.terminalGrid) {
      const panes = this.els.terminalGrid.querySelectorAll('.terminal-pane');
      console.log('[DnD] Setting up drop handlers on', panes.length, 'terminal panes');
      panes.forEach((pane, slotIdx) => {
        // Helper: check if drag types contain a value (works with both Array and DOMStringList)
        const hasType = (types, val) => {
          if (types.includes) return types.includes(val);
          if (types.contains) return types.contains(val);
          for (let i = 0; i < types.length; i++) { if (types[i] === val) return true; }
          return false;
        };

        pane.addEventListener('dragover', (e) => {
          const isSession = hasType(e.dataTransfer.types, 'cwm/session');
          const isProject = hasType(e.dataTransfer.types, 'cwm/project');
          const isProjectSession = hasType(e.dataTransfer.types, 'cwm/project-session');
          const isWorkspace = hasType(e.dataTransfer.types, 'cwm/workspace');
          if (isSession || isProject || isProjectSession || isWorkspace) {
            e.preventDefault();
            // Match the effectAllowed set by the drag source:
            // sessions use 'move', projects/project-sessions use 'copy', workspaces use 'move'
            e.dataTransfer.dropEffect = (isProject || isProjectSession) ? 'copy' : 'move';
            pane.classList.add('drag-over');
          }
        });
        pane.addEventListener('dragleave', () => {
          pane.classList.remove('drag-over');
        });
        pane.addEventListener('drop', async (e) => {
          e.preventDefault();
          pane.classList.remove('drag-over');
          console.log('[DnD] Drop on pane', slotIdx, 'types:', Array.from(e.dataTransfer.types));

          // Drop an app session into terminal pane
          const sessionId = e.dataTransfer.getData('cwm/session');
          if (sessionId) {
            console.log('[DnD] Session drop:', sessionId);
            const session = this.state.sessions.find(s => s.id === sessionId);
            if (session && !session.resumeSessionId) {
              this.showToast('Starting new Claude session (no previous conversation to resume)', 'info');
            }
            this.openTerminalInPane(slotIdx, sessionId, session ? session.name : 'Terminal');
            return;
          }

          // Drop a project-session (individual .jsonl from project accordion) into terminal pane
          // Opens directly in terminal WITHOUT adding to any workspace
          const projSessJson = e.dataTransfer.getData('cwm/project-session');
          if (projSessJson) {
            try {
              const ps = JSON.parse(projSessJson);
              const claudeSessionId = ps.sessionName; // This IS the Claude session UUID
              console.log('[DnD] Project-session drop — resumeSessionId:', claudeSessionId, 'cwd:', ps.projectPath);
              // Open terminal directly — use the Claude session UUID as the PTY session ID
              // so the PTY manager can reuse it on subsequent drops
              this.openTerminalInPane(slotIdx, claudeSessionId, claudeSessionId, {
                cwd: ps.projectPath,
                resumeSessionId: claudeSessionId,
                command: 'claude',
              });
              this.showToast('Opening session — drag to a workspace to save it', 'info');
            } catch (err) {
              this.showToast(err.message || 'Failed to open session', 'error');
            }
            return;
          }

          // Drop an entire project into terminal pane
          // Opens a new Claude session in the project dir WITHOUT adding to workspace
          const projectJson = e.dataTransfer.getData('cwm/project');
          if (projectJson) {
            try {
              const project = JSON.parse(projectJson);
              const tempId = 'pty-project-' + Date.now();
              this.openTerminalInPane(slotIdx, tempId, project.name, {
                cwd: project.path,
                command: 'claude',
              });
              this.showToast('Opening project — drag to a workspace to save it', 'info');
            } catch (err) {
              this.showToast(err.message || 'Failed to open project', 'error');
            }
            return;
          }

          // Drop a workspace into terminal pane — start a new Claude session
          const workspaceId = e.dataTransfer.getData('cwm/workspace');
          if (workspaceId) {
            console.log('[DnD] Workspace drop:', workspaceId);
            try {
              const ws = this.state.workspaces.find(w => w.id === workspaceId);
              const wsName = ws ? ws.name : 'Workspace';
              const data = await this.api('POST', '/api/sessions', {
                name: `${wsName} terminal`,
                workspaceId: workspaceId,
                topic: '',
                command: 'claude',
              });
              await this.loadSessions();
              await this.loadStats();
              if (data && data.session) {
                this.openTerminalInPane(slotIdx, data.session.id, wsName);
              }
            } catch (err) {
              this.showToast(err.message || 'Failed to create session', 'error');
            }
          }
        });

        // Close button
        const closeBtn = pane.querySelector('.terminal-pane-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => this.closeTerminalPane(slotIdx));
        }

        // Click-to-focus: clicking/tapping anywhere in a pane focuses its terminal
        const focusPane = () => {
          if (this.terminalPanes[slotIdx]) {
            this.setActiveTerminalPane(slotIdx);
          }
        };
        pane.addEventListener('mousedown', focusPane, true); // capture phase
        pane.addEventListener('touchstart', focusPane, { passive: true, capture: true });
      });
    }
  }


  /* ═══════════════════════════════════════════════════════════
     TERMINAL GRID VIEW
     ═══════════════════════════════════════════════════════════ */

  openTerminalInPane(slotIdx, sessionId, sessionName, spawnOpts) {
    console.log('[DnD] openTerminalInPane slot:', slotIdx, 'session:', sessionId, 'name:', sessionName);
    // If the target slot already has an active terminal, find the next empty slot
    if (this.terminalPanes[slotIdx]) {
      const emptySlot = this.terminalPanes.findIndex(p => p === null);
      if (emptySlot !== -1) {
        slotIdx = emptySlot;
      } else {
        // All 4 slots full — replace the target slot
        this.terminalPanes[slotIdx].dispose();
        this.terminalPanes[slotIdx] = null;
      }
    }

    const containerId = `term-container-${slotIdx}`;
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;

    // Ensure pane is visible before mounting terminal
    paneEl.hidden = false;

    // Update pane state
    paneEl.classList.remove('terminal-pane-empty');
    const titleEl = paneEl.querySelector('.terminal-pane-title');
    if (titleEl) titleEl.textContent = sessionName || sessionId;
    const closeBtn = paneEl.querySelector('.terminal-pane-close');
    if (closeBtn) closeBtn.hidden = false;

    // Create and mount TerminalPane
    const tp = new TerminalPane(containerId, sessionId, sessionName, spawnOpts);
    this.terminalPanes[slotIdx] = tp;
    tp.mount();

    this.updateTerminalGridLayout();

    // Focus the newly opened terminal pane
    requestAnimationFrame(() => this.setActiveTerminalPane(slotIdx));

    // Update mobile terminal tab strip
    if (this.isMobile) {
      this.updateTerminalTabs();
      this.switchTerminalTab(slotIdx);
    }
  }

  closeTerminalPane(slotIdx) {
    const tp = this.terminalPanes[slotIdx];
    const sessionName = tp ? tp.sessionName : '';

    if (tp) {
      // Dispose disconnects the WebSocket but the PTY keeps running in the background
      tp.dispose();
      this.terminalPanes[slotIdx] = null;
    }

    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;

    // Reset to empty state
    paneEl.classList.remove('terminal-pane-active');
    paneEl.classList.add('terminal-pane-empty');
    const titleEl = paneEl.querySelector('.terminal-pane-title');
    if (titleEl) titleEl.textContent = 'Drop a session here';
    const closeBtn = paneEl.querySelector('.terminal-pane-close');
    if (closeBtn) closeBtn.hidden = true;
    const container = document.getElementById(`term-container-${slotIdx}`);
    if (container) container.innerHTML = '';

    // If closing the active pane, focus another terminal
    if (this._activeTerminalSlot === slotIdx) {
      this._activeTerminalSlot = null;
      const nextActive = this.terminalPanes.findIndex(p => p !== null);
      if (nextActive !== -1) {
        this.setActiveTerminalPane(nextActive);
      }
    }

    this.updateTerminalGridLayout();

    // Update mobile terminal tab strip
    if (this.isMobile) {
      this.updateTerminalTabs();
    }

    if (sessionName) {
      this.showToast(`"${sessionName}" moved to background — drag it back to reconnect`, 'info');
    }
  }

  updateTerminalGridLayout() {
    const grid = this.els.terminalGrid;
    if (!grid) return;

    const filledCount = this.terminalPanes.filter(p => p !== null).length;
    // Only show empty drop target when no terminals are open
    const visibleCount = filledCount > 0 ? filledCount : 1;

    grid.setAttribute('data-panes', visibleCount.toString());

    let emptyShown = false;
    for (let i = 0; i < 4; i++) {
      const paneEl = document.getElementById(`term-pane-${i}`);
      if (!paneEl) continue;

      if (this.terminalPanes[i]) {
        // Filled pane — always show
        paneEl.hidden = false;
      } else if (!emptyShown && filledCount === 0) {
        // Only show one empty pane as drop target when no terminals exist
        paneEl.hidden = false;
        paneEl.classList.add('terminal-pane-empty');
        emptyShown = true;
      } else {
        // Hide all other empty panes
        paneEl.hidden = true;
      }
    }

    // Apply dynamic grid sizes and position resize handles
    this._applyGridSizes();

    // Refit visible terminal panes after layout change
    requestAnimationFrame(() => {
      this.terminalPanes.forEach(tp => {
        if (tp && tp.fitAddon) tp.fitAddon.fit();
      });
    });
  }


  /* ═══════════════════════════════════════════════════════════
     TERMINAL FOCUS & RESIZE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Set the active terminal pane — blurs all others, focuses target, highlights it.
   */
  setActiveTerminalPane(slotIdx) {
    // Blur all other terminals
    this.terminalPanes.forEach((tp, i) => {
      if (tp && i !== slotIdx) tp.blur();
      const pane = document.getElementById(`term-pane-${i}`);
      if (pane) pane.classList.remove('terminal-pane-active');
    });

    // Activate target
    const pane = document.getElementById(`term-pane-${slotIdx}`);
    if (pane) pane.classList.add('terminal-pane-active');

    const tp = this.terminalPanes[slotIdx];
    if (tp) tp.focus();

    this._activeTerminalSlot = slotIdx;
  }

  /**
   * Initialize resize handles for the terminal grid.
   * Creates two overlay handles (column + row dividers) that can be dragged.
   */
  initTerminalResize() {
    const grid = this.els.terminalGrid;
    if (!grid || grid.dataset.resizeInit) return;
    grid.dataset.resizeInit = 'true';

    // Column resize handle (vertical bar between left/right columns)
    this._colResizeHandle = document.createElement('div');
    this._colResizeHandle.className = 'terminal-resize-handle terminal-resize-col';
    this._colResizeHandle.hidden = true;
    grid.appendChild(this._colResizeHandle);

    // Row resize handle (horizontal bar between top/bottom rows)
    this._rowResizeHandle = document.createElement('div');
    this._rowResizeHandle.className = 'terminal-resize-handle terminal-resize-row';
    this._rowResizeHandle.hidden = true;
    grid.appendChild(this._rowResizeHandle);

    this._setupResizeDrag(this._colResizeHandle, 'col');
    this._setupResizeDrag(this._rowResizeHandle, 'row');

    // ── Mobile touch scroll isolation ──
    // iOS Safari doesn't fully support CSS overscroll-behavior.
    // Prevent terminal touchmove events from scrolling the page.
    // xterm.js handles its own scrolling internally via .xterm-viewport.
    grid.addEventListener('touchmove', (e) => {
      // Only intercept when terminal is the active view on mobile
      if (!document.body.classList.contains('terminal-active')) return;
      // Allow the touch event for xterm's internal scroll handling,
      // but stop it from propagating to the page/body scroll.
      e.stopPropagation();
    }, { passive: true });
  }

  _setupResizeDrag(handle, direction) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const grid = this.els.terminalGrid;
      const gridRect = grid.getBoundingClientRect();

      // Create a full-screen overlay to capture mouse events during drag
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:${direction === 'col' ? 'col-resize' : 'row-resize'};`;
      document.body.appendChild(overlay);

      handle.classList.add('active');

      const onMove = (e) => {
        if (direction === 'col') {
          const ratio = (e.clientX - gridRect.left) / gridRect.width;
          const clamped = Math.max(0.15, Math.min(0.85, ratio));
          this._gridColSizes = [clamped, 1 - clamped];
        } else {
          const ratio = (e.clientY - gridRect.top) / gridRect.height;
          const clamped = Math.max(0.15, Math.min(0.85, ratio));
          this._gridRowSizes = [clamped, 1 - clamped];
        }
        this._applyGridSizes();
      };

      const onUp = () => {
        handle.classList.remove('active');
        overlay.remove();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Refit all terminals after resize completes
        this.terminalPanes.forEach(tp => {
          if (tp && tp.fitAddon) {
            try { tp.fitAddon.fit(); } catch (_) {}
            // Notify server of new dimensions
            if (tp.ws && tp.ws.readyState === WebSocket.OPEN && tp.term) {
              tp.ws.send(JSON.stringify({ type: 'resize', cols: tp.term.cols, rows: tp.term.rows }));
            }
          }
        });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /**
   * Apply dynamic grid column/row sizes and position resize handles.
   */
  _applyGridSizes() {
    const grid = this.els.terminalGrid;
    if (!grid) return;

    const filledCount = this.terminalPanes.filter(p => p !== null).length;

    if (filledCount <= 1) {
      grid.style.gridTemplateColumns = '1fr';
      grid.style.gridTemplateRows = '1fr';
    } else if (filledCount === 2) {
      grid.style.gridTemplateColumns = `${this._gridColSizes[0]}fr ${this._gridColSizes[1]}fr`;
      grid.style.gridTemplateRows = '1fr';
    } else {
      grid.style.gridTemplateColumns = `${this._gridColSizes[0]}fr ${this._gridColSizes[1]}fr`;
      grid.style.gridTemplateRows = `${this._gridRowSizes[0]}fr ${this._gridRowSizes[1]}fr`;
    }

    // Position and show/hide resize handles
    if (this._colResizeHandle) {
      const showCol = filledCount >= 2;
      this._colResizeHandle.hidden = !showCol;
      if (showCol) {
        const totalFr = this._gridColSizes[0] + this._gridColSizes[1];
        const pct = (this._gridColSizes[0] / totalFr) * 100;
        this._colResizeHandle.style.left = `calc(${pct}% - 3px)`;
      }
    }
    if (this._rowResizeHandle) {
      const showRow = filledCount >= 3;
      this._rowResizeHandle.hidden = !showRow;
      if (showRow) {
        const totalFr = this._gridRowSizes[0] + this._gridRowSizes[1];
        const pct = (this._gridRowSizes[0] / totalFr) * 100;
        this._rowResizeHandle.style.top = `calc(${pct}% - 3px)`;
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════
     MOBILE: ACTION SHEET + TAB BAR + TERMINAL TABS + GESTURES
     ═══════════════════════════════════════════════════════════ */

  /**
   * Show a bottom action sheet (mobile replacement for context menus).
   * @param {string} title - Header text (or empty string)
   * @param {Array<{label:string, icon?:string, action:Function, danger?:boolean, check?:boolean, disabled?:boolean}|{type:'sep'}>} items
   */
  showActionSheet(title, items) {
    if (!this.els.actionSheetOverlay) return;

    // Header
    this.els.actionSheetHeader.textContent = title || '';

    // Build items HTML
    const container = this.els.actionSheetItems;
    container.innerHTML = items.map((item, i) => {
      if (item.type === 'sep') return '<div class="action-sheet-sep"></div>';
      const cls = ['action-sheet-item'];
      if (item.danger) cls.push('as-danger');
      const disabledAttr = item.disabled ? ' disabled' : '';
      const icon = item.icon ? `<span class="as-icon">${item.icon}</span>` : '';
      const check = (item.check !== undefined) ? `<span class="as-check">${item.check ? '&#10003;' : ''}</span>` : '';
      return `<button class="${cls.join(' ')}"${disabledAttr} data-idx="${i}">
        ${icon}${item.label}${check}
      </button>`;
    }).join('');

    // Bind click handlers
    container.querySelectorAll('.action-sheet-item:not([disabled])').forEach(btn => {
      const idx = parseInt(btn.dataset.idx, 10);
      const item = items[idx];
      if (item && item.action) {
        btn.addEventListener('click', () => {
          this.hideActionSheet();
          item.action();
        });
      }
    });

    // Show
    this.els.actionSheetOverlay.hidden = false;
    document.body.classList.add('sheet-open');
  }

  hideActionSheet() {
    if (this.els.actionSheetOverlay) {
      this.els.actionSheetOverlay.hidden = true;
    }
    document.body.classList.remove('sheet-open');
  }

  /**
   * "More" tab menu — shows action sheet with utility actions.
   */
  showMoreMenu() {
    const items = [
      { label: 'Quick Switcher', icon: '&#128269;', action: () => this.openQuickSwitcher() },
      { label: 'Discover Sessions', icon: '&#128260;', action: () => this.discoverSessions() },
      { type: 'sep' },
      { label: 'Restart All Sessions', icon: '&#8635;', action: () => this.restartAllSessions() },
      { type: 'sep' },
      { label: 'Logout', icon: '&#9211;', action: () => this.logout(), danger: true },
    ];
    this.showActionSheet('', items);
  }

  /**
   * Render items as an action sheet on mobile, or as a floating context menu on desktop.
   * Both use the same item format: { label, icon, action, danger, check, disabled } | { type: 'sep' }
   */
  _renderContextItems(title, items, x, y) {
    if (this.isMobile) {
      this.showActionSheet(title, items);
      return;
    }

    // Desktop: render floating context menu (existing behavior)
    const container = this.els.contextMenuItems;
    container.innerHTML = items.map(item => {
      if (item.type === 'sep') return '<div class="context-menu-sep"></div>';
      const cls = ['context-menu-item'];
      if (item.danger) cls.push('ctx-danger');
      const disabledAttr = item.disabled ? ' disabled' : '';
      const checkMark = item.check !== undefined ? `<span class="ctx-check">${item.check ? '&#10003;' : ''}</span>` : '';
      return `<button class="${cls.join(' ')}"${disabledAttr} data-action="${item.label}">
        <span class="ctx-icon">${item.icon || ''}</span>${item.label}${checkMark}
      </button>`;
    }).join('');

    // Bind click handlers
    const actionItems = items.filter(it => !it.type && !it.disabled);
    let actionIdx = 0;
    container.querySelectorAll('.context-menu-item:not([disabled])').forEach(btn => {
      const item = actionItems[actionIdx++];
      if (item && item.action) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hideContextMenu();
          item.action();
        });
      }
    });

    // Position the menu, clamping to viewport
    const menu = this.els.contextMenu;
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const mx = Math.min(x, window.innerWidth - rect.width - 8);
    const my = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(4, mx) + 'px';
    menu.style.top = Math.max(4, my) + 'px';
  }

  /* ─── Mobile Terminal Tab Strip ──────────────────────────── */

  updateTerminalTabs() {
    const strip = this.els.terminalTabStrip;
    if (!strip) return;

    // Only show on mobile
    if (!this.isMobile) {
      strip.hidden = true;
      return;
    }

    const activePanes = this.terminalPanes.map((tp, i) => tp ? { idx: i, tp } : null).filter(Boolean);

    if (activePanes.length === 0) {
      strip.hidden = true;
      return;
    }

    strip.hidden = false;

    // Find which pane is currently mobile-active
    let activeIdx = activePanes[0].idx;
    for (const p of activePanes) {
      const el = document.getElementById(`term-pane-${p.idx}`);
      if (el && el.classList.contains('mobile-active')) {
        activeIdx = p.idx;
        break;
      }
    }

    strip.innerHTML = activePanes.map(p => {
      const isActive = p.idx === activeIdx;
      return `<button class="terminal-tab${isActive ? ' active' : ''}" data-slot="${p.idx}">
        ${this.escapeHtml(p.tp.sessionName || 'Terminal')}
        <button class="terminal-tab-close" data-slot="${p.idx}" title="Close">&times;</button>
      </button>`;
    }).join('') + `<button class="terminal-tab terminal-tab-add" title="Open terminal">+</button>`;

    // Bind tab click handlers
    strip.querySelectorAll('.terminal-tab:not(.terminal-tab-add)').forEach(tab => {
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('terminal-tab-close')) return;
        this.switchTerminalTab(parseInt(tab.dataset.slot, 10));
      });
    });

    // Bind close handlers
    strip.querySelectorAll('.terminal-tab-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTerminalPane(parseInt(btn.dataset.slot, 10));
        this.updateTerminalTabs();
      });
    });

    // Bind "+" button
    const addBtn = strip.querySelector('.terminal-tab-add');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        // Show action sheet to pick a session to open
        const sessionItems = this.state.sessions
          .filter(s => !this.state.hiddenSessions.has(s.id))
          .slice(0, 10)
          .map(s => ({
            label: s.name,
            icon: '&#9654;',
            action: () => {
              const emptySlot = this.terminalPanes.findIndex(p => p === null);
              if (emptySlot === -1) {
                this.showToast('All terminal panes full', 'warning');
                return;
              }
              this.openTerminalInPane(emptySlot, s.id, s.name);
            },
          }));
        if (sessionItems.length === 0) {
          this.showToast('No sessions available', 'info');
          return;
        }
        this.showActionSheet('Open in Terminal', sessionItems);
      });
    }

    // Ensure the active pane is showing
    this.switchTerminalTab(activeIdx);
  }

  switchTerminalTab(slotIdx) {
    // Hide all panes, show the selected one
    for (let i = 0; i < 4; i++) {
      const el = document.getElementById(`term-pane-${i}`);
      if (!el) continue;
      el.classList.remove('mobile-active');
    }

    const activeEl = document.getElementById(`term-pane-${slotIdx}`);
    if (activeEl) {
      activeEl.classList.add('mobile-active');
    }

    // Update tab strip active states
    if (this.els.terminalTabStrip) {
      this.els.terminalTabStrip.querySelectorAll('.terminal-tab').forEach(tab => {
        tab.classList.toggle('active', parseInt(tab.dataset.slot, 10) === slotIdx);
      });
    }

    // Set as active pane and focus it
    this.setActiveTerminalPane(slotIdx);

    // Refit the terminal after switching
    const tp = this.terminalPanes[slotIdx];
    if (tp && tp.fitAddon) {
      requestAnimationFrame(() => {
        try { tp.fitAddon.fit(); } catch (_) {}
      });
    }
  }

  /* ─── Touch Gestures ─────────────────────────────────────── */

  initTouchGestures() {
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
      tracking = true;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const elapsed = Date.now() - startTime;

      // Only count as swipe if: fast (<300ms), mostly horizontal, >60px distance
      if (elapsed > 300 || Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 60) return;

      // Swipe right from left edge → open sidebar
      if (dx > 0 && startX < 30 && !this.state.sidebarOpen) {
        this.toggleSidebar();
        return;
      }

      // Swipe left while sidebar open → close sidebar
      if (dx < 0 && this.state.sidebarOpen) {
        this.toggleSidebar();
        return;
      }

      // Swipe right on detail panel → back to session list
      if (dx > 0 && this.els.detailPanel && this.els.detailPanel.classList.contains('mobile-visible')) {
        this.deselectSession();
        return;
      }
    }, { passive: true });
  }


  /* ═══════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════ */

  escapeHtml(str) {
    if (!str) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(str).replace(/[&<>"']/g, c => map[c]);
  }

  relativeTime(isoString) {
    if (!isoString) return '';
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diff = now - then;

    if (diff < 0) return 'just now';

    const seconds = Math.floor(diff / 1000);
    if (seconds < 30) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;

    return `${Math.floor(months / 12)}y ago`;
  }

  formatDateTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  truncatePath(path, maxLen = 45) {
    if (!path) return '';
    if (path.length <= maxLen) return path;
    // Show beginning and end
    const start = path.substring(0, 15);
    const end = path.substring(path.length - (maxLen - 18));
    return `${start}...${end}`;
  }


  /* ═══════════════════════════════════════════════════════════
     WORKSPACE DOCUMENTATION
     ═══════════════════════════════════════════════════════════ */

  async loadDocs() {
    if (!this.state.activeWorkspace) {
      this.state.docs = null;
      this.renderDocs();
      return;
    }
    try {
      const data = await this.api('GET', `/api/workspaces/${this.state.activeWorkspace.id}/docs`);
      this.state.docs = data;
      this.renderDocs();
    } catch (err) {
      this.showToast('Failed to load documentation', 'error');
    }
  }

  renderDocs() {
    const docs = this.state.docs;
    const ws = this.state.activeWorkspace;

    // Update header
    if (this.els.docsWorkspaceName) {
      this.els.docsWorkspaceName.textContent = ws ? ws.name : 'No workspace selected';
    }

    if (!docs || docs.raw === null) {
      // Empty state
      if (this.els.docsNotesList) this.els.docsNotesList.innerHTML = '<div class="docs-empty">No notes yet. Click + to add one.</div>';
      if (this.els.docsGoalsList) this.els.docsGoalsList.innerHTML = '<div class="docs-empty">No goals yet. Click + to add one.</div>';
      if (this.els.docsTasksList) this.els.docsTasksList.innerHTML = '<div class="docs-empty">No tasks yet. Click + to add one.</div>';
      if (this.els.docsNotesCount) this.els.docsNotesCount.textContent = '0';
      if (this.els.docsGoalsCount) this.els.docsGoalsCount.textContent = '0';
      if (this.els.docsTasksCount) this.els.docsTasksCount.textContent = '0';
      if (this.els.docsRawEditor) this.els.docsRawEditor.value = '';
      return;
    }

    // Counts
    if (this.els.docsNotesCount) this.els.docsNotesCount.textContent = (docs.notes || []).length;
    if (this.els.docsGoalsCount) this.els.docsGoalsCount.textContent = (docs.goals || []).length;
    if (this.els.docsTasksCount) this.els.docsTasksCount.textContent = (docs.tasks || []).length;

    // Notes
    if (this.els.docsNotesList) {
      this.els.docsNotesList.innerHTML = (docs.notes || []).length > 0
        ? (docs.notes || []).map((n, i) => `
          <div class="docs-item" data-index="${i}">
            <span class="docs-note-time">${this.escapeHtml(n.timestamp || '')}</span>
            <span class="docs-note-text">${this.escapeHtml(n.text)}</span>
            <button class="docs-item-delete btn btn-ghost btn-icon btn-sm" data-section="notes" data-index="${i}" title="Remove">&times;</button>
          </div>`).join('')
        : '<div class="docs-empty">No notes yet. Click + to add one.</div>';
    }

    // Goals
    if (this.els.docsGoalsList) {
      this.els.docsGoalsList.innerHTML = (docs.goals || []).length > 0
        ? (docs.goals || []).map((g, i) => `
          <div class="docs-item${g.done ? ' docs-item-done' : ''}" data-index="${i}">
            <label class="docs-checkbox">
              <input type="checkbox" ${g.done ? 'checked' : ''} data-section="goals" data-index="${i}">
            </label>
            <span class="docs-item-text">${this.escapeHtml(g.text)}</span>
            <button class="docs-item-delete btn btn-ghost btn-icon btn-sm" data-section="goals" data-index="${i}" title="Remove">&times;</button>
          </div>`).join('')
        : '<div class="docs-empty">No goals yet. Click + to add one.</div>';
    }

    // Tasks
    if (this.els.docsTasksList) {
      this.els.docsTasksList.innerHTML = (docs.tasks || []).length > 0
        ? (docs.tasks || []).map((t, i) => `
          <div class="docs-item${t.done ? ' docs-item-done' : ''}" data-index="${i}">
            <label class="docs-checkbox">
              <input type="checkbox" ${t.done ? 'checked' : ''} data-section="tasks" data-index="${i}">
            </label>
            <span class="docs-item-text">${this.escapeHtml(t.text)}</span>
            <button class="docs-item-delete btn btn-ghost btn-icon btn-sm" data-section="tasks" data-index="${i}" title="Remove">&times;</button>
          </div>`).join('')
        : '<div class="docs-empty">No tasks yet. Click + to add one.</div>';
    }

    // Bind checkbox change events
    if (this.els.docsPanel) {
      this.els.docsPanel.querySelectorAll('.docs-checkbox input').forEach(cb => {
        cb.addEventListener('change', () => this.toggleDocsItem(cb.dataset.section, parseInt(cb.dataset.index)));
      });
      // Bind delete buttons
      this.els.docsPanel.querySelectorAll('.docs-item-delete').forEach(btn => {
        btn.addEventListener('click', () => this.removeDocsItem(btn.dataset.section, parseInt(btn.dataset.index)));
      });

      // Click note text to edit in large editor
      this.els.docsPanel.querySelectorAll('.docs-note-text, .docs-item-text').forEach(span => {
        span.style.cursor = 'pointer';
        span.title = 'Click to edit';
        span.addEventListener('click', (e) => {
          const item = e.target.closest('.docs-item');
          if (!item) return;
          const index = parseInt(item.dataset.index);
          // Determine section from parent list
          const parent = item.closest('[id]');
          let section = 'notes';
          if (parent) {
            if (parent.id.includes('goals')) section = 'goals';
            else if (parent.id.includes('tasks')) section = 'tasks';
          }
          const text = e.target.textContent;
          this.showNotesEditor(section, index, text);
        });
      });
    }

    // Raw editor
    if (this.els.docsRawEditor) {
      this.els.docsRawEditor.value = docs.raw || '';
    }
  }

  async addDocsItem(section) {
    if (!this.state.activeWorkspace) {
      this.showToast('Select a workspace first', 'warning');
      return;
    }
    this.showNotesEditor(section);
  }

  async toggleDocsItem(section, index) {
    if (!this.state.activeWorkspace) return;
    try {
      await this.api('PUT', `/api/workspaces/${this.state.activeWorkspace.id}/docs/${section}/${index}`);
      await this.loadDocs();
    } catch (err) {
      this.showToast(err.message || 'Failed to update item', 'error');
    }
  }

  async removeDocsItem(section, index) {
    if (!this.state.activeWorkspace) return;
    try {
      await this.api('DELETE', `/api/workspaces/${this.state.activeWorkspace.id}/docs/${section}/${index}`);
      await this.loadDocs();
    } catch (err) {
      this.showToast(err.message || 'Failed to remove item', 'error');
    }
  }

  toggleDocsRawMode() {
    this.state.docsRawMode = !this.state.docsRawMode;
    if (this.els.docsStructured) this.els.docsStructured.hidden = this.state.docsRawMode;
    if (this.els.docsRaw) this.els.docsRaw.hidden = !this.state.docsRawMode;
    if (this.els.docsToggleRaw) this.els.docsToggleRaw.classList.toggle('active', this.state.docsRawMode);
    if (this.els.docsSaveBtn) this.els.docsSaveBtn.hidden = !this.state.docsRawMode;
  }

  async saveDocsRaw() {
    if (!this.state.activeWorkspace) return;
    const raw = this.els.docsRawEditor ? this.els.docsRawEditor.value : '';
    try {
      await this.api('PUT', `/api/workspaces/${this.state.activeWorkspace.id}/docs`, { content: raw });
      this.showToast('Documentation saved', 'success');
      await this.loadDocs();
    } catch (err) {
      this.showToast(err.message || 'Failed to save documentation', 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     PHASE 3: INLINE SESSION RENAME
     ═══════════════════════════════════════════════════════════ */

  startInlineRename(nameEl, sessionId, isStoreSession = true) {
    const currentName = nameEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = currentName;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          if (isStoreSession) {
            await this.api('PUT', `/api/sessions/${sessionId}`, { name: newName });
            const s = this.state.sessions.find(s => s.id === sessionId);
            if (s) s.name = newName;
            // Also update in allSessions
            const as = this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId);
            if (as && as !== s) as.name = newName;
          } else {
            // Project session — save to localStorage titles
            const titles = JSON.parse(localStorage.getItem('cwm_projectSessionTitles') || '{}');
            titles[sessionId] = newName;
            localStorage.setItem('cwm_projectSessionTitles', JSON.stringify(titles));
          }
          nameEl.textContent = newName;
          nameEl.classList.add('rename-flash');
          setTimeout(() => nameEl.classList.remove('rename-flash'), 600);
        } catch (err) {
          nameEl.textContent = currentName;
          this.showToast('Rename failed: ' + (err.message || ''), 'error');
        }
      } else {
        nameEl.textContent = currentName;
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }


  /* ═══════════════════════════════════════════════════════════
     PHASE 4: TERMINAL TAB GROUPS
     ═══════════════════════════════════════════════════════════ */

  initTerminalGroups() {
    // Load layout from server
    this._tabGroups = [];
    this._activeGroupId = null;
    this._layoutSaveTimer = null;

    // Bind events
    if (this.els.terminalGroupsAdd) {
      this.els.terminalGroupsAdd.addEventListener('click', () => this.createTerminalGroup());
    }

    // Load saved layout
    this.loadTerminalLayout();
  }

  async loadTerminalLayout() {
    try {
      const layout = await this.api('GET', '/api/layout');
      if (layout && layout.tabGroups && layout.tabGroups.length > 0) {
        this._tabGroups = layout.tabGroups;
        this._activeGroupId = layout.activeGroupId || this._tabGroups[0].id;
      } else {
        // Create default group
        this._tabGroups = [{ id: 'tg_default', name: 'Main', panes: [] }];
        this._activeGroupId = 'tg_default';
      }
    } catch (_) {
      this._tabGroups = [{ id: 'tg_default', name: 'Main', panes: [] }];
      this._activeGroupId = 'tg_default';
    }
    this.renderTerminalGroupTabs();
  }

  renderTerminalGroupTabs() {
    if (!this.els.terminalGroupsTabs) return;

    const html = this._tabGroups.map(g => {
      const isActive = g.id === this._activeGroupId;
      const paneCount = g.panes ? g.panes.length : 0;
      const hasActive = g.panes && g.panes.some(p => {
        const tp = this.terminalPanes.find((_, i) => p.slot === i);
        return tp !== null;
      });
      return `<button class="terminal-group-tab${isActive ? ' active' : ''}" data-group-id="${g.id}">
        <span class="terminal-group-tab-dot${hasActive ? '' : ' inactive'}"></span>
        <span class="terminal-group-tab-name">${this.escapeHtml(g.name)}</span>
        ${paneCount > 0 ? `<span class="terminal-group-tab-count">${paneCount}</span>` : ''}
      </button>`;
    }).join('');

    this.els.terminalGroupsTabs.innerHTML = html;

    // Bind tab click events
    this.els.terminalGroupsTabs.querySelectorAll('.terminal-group-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTerminalGroup(tab.dataset.groupId));

      // Double-click to rename
      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const nameEl = tab.querySelector('.terminal-group-tab-name');
        if (nameEl) this.startInlineRenameGroup(nameEl, tab.dataset.groupId);
      });

      // Right-click context menu
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const groupId = tab.dataset.groupId;
        this._renderContextItems('Tab Group', [
          { label: 'Rename', action: () => {
            const nameEl = tab.querySelector('.terminal-group-tab-name');
            if (nameEl) this.startInlineRenameGroup(nameEl, groupId);
          }},
          { label: 'Delete', danger: true, action: () => this.deleteTerminalGroup(groupId) },
        ], e.clientX, e.clientY);
      });
    });
  }

  switchTerminalGroup(groupId) {
    if (groupId === this._activeGroupId) return;

    // Save current group's pane state
    this.saveCurrentGroupPanes();

    // Close current panes (disconnect but don't kill PTYs)
    for (let i = 0; i < 4; i++) {
      if (this.terminalPanes[i]) {
        this.terminalPanes[i].dispose();
        this.terminalPanes[i] = null;
        const paneEl = document.getElementById(`term-pane-${i}`);
        if (paneEl) {
          paneEl.classList.add('terminal-pane-empty');
          const header = paneEl.querySelector('.terminal-pane-title');
          if (header) header.textContent = 'Drop a session here';
          const closeBtn = paneEl.querySelector('.terminal-pane-close');
          if (closeBtn) closeBtn.hidden = true;
        }
      }
    }

    this._activeGroupId = groupId;

    // Restore the new group's panes
    const group = this._tabGroups.find(g => g.id === groupId);
    if (group && group.panes) {
      group.panes.forEach(p => {
        if (p.sessionId) {
          this.openTerminalInPane(p.slot, p.sessionId, p.sessionName || 'Terminal');
        }
      });
    }

    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
  }

  saveCurrentGroupPanes() {
    const group = this._tabGroups.find(g => g.id === this._activeGroupId);
    if (!group) return;

    group.panes = [];
    for (let i = 0; i < 4; i++) {
      if (this.terminalPanes[i]) {
        group.panes.push({
          slot: i,
          sessionId: this.terminalPanes[i].sessionId,
          sessionName: this.terminalPanes[i].sessionName,
        });
      }
    }
  }

  createTerminalGroup() {
    const id = 'tg_' + Date.now().toString(36);
    const name = 'Tab ' + (this._tabGroups.length + 1);
    this._tabGroups.push({ id, name, panes: [] });
    this.saveTerminalLayout();
    this.renderTerminalGroupTabs();
    this.showToast(`Created tab group "${name}"`, 'success');
  }

  deleteTerminalGroup(groupId) {
    if (this._tabGroups.length <= 1) {
      this.showToast('Cannot delete the last tab group', 'warning');
      return;
    }
    this._tabGroups = this._tabGroups.filter(g => g.id !== groupId);
    if (this._activeGroupId === groupId) {
      this._activeGroupId = this._tabGroups[0].id;
      this.switchTerminalGroup(this._activeGroupId);
    }
    this.saveTerminalLayout();
    this.renderTerminalGroupTabs();
  }

  startInlineRenameGroup(nameEl, groupId) {
    const currentName = nameEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = currentName;
    input.style.width = '80px';
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newName = input.value.trim() || currentName;
      nameEl.textContent = newName;
      const group = this._tabGroups.find(g => g.id === groupId);
      if (group) group.name = newName;
      this.saveTerminalLayout();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  saveTerminalLayout() {
    clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = setTimeout(async () => {
      this.saveCurrentGroupPanes();
      try {
        await this.api('PUT', '/api/layout', {
          tabGroups: this._tabGroups,
          activeGroupId: this._activeGroupId,
        });
      } catch (_) {}
    }, 500);
  }


  /* ═══════════════════════════════════════════════════════════
     PHASE 5: NOTES EDITOR MODAL
     ═══════════════════════════════════════════════════════════ */

  initNotesEditor() {
    if (!this.els.notesEditorOverlay) return;

    this.els.notesEditorClose.addEventListener('click', () => this.hideNotesEditor());
    this.els.notesEditorCancel.addEventListener('click', () => this.hideNotesEditor());
    this.els.notesEditorSave.addEventListener('click', () => this.saveNotesEditor());

    // Ctrl+Enter to save
    this.els.notesEditorTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.saveNotesEditor();
      }
    });

    // Toolbar buttons
    this.els.notesEditorOverlay.querySelectorAll('.notes-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const ta = this.els.notesEditorTextarea;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const selected = ta.value.substring(start, end);
        let insert = '';

        switch (action) {
          case 'bold': insert = `**${selected || 'bold text'}**`; break;
          case 'italic': insert = `*${selected || 'italic text'}*`; break;
          case 'code': insert = selected.includes('\n') ? `\`\`\`\n${selected}\n\`\`\`` : `\`${selected || 'code'}\``; break;
          case 'link': insert = `[${selected || 'link text'}](url)`; break;
          case 'list': insert = `- ${selected || 'item'}`; break;
        }

        ta.value = ta.value.substring(0, start) + insert + ta.value.substring(end);
        ta.focus();
        ta.selectionStart = start;
        ta.selectionEnd = start + insert.length;
      });
    });

    // Click overlay to close
    this.els.notesEditorOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.notesEditorOverlay) this.hideNotesEditor();
    });
  }

  showNotesEditor(section, index = null, existingText = '') {
    this._notesEditorSection = section;
    this._notesEditorIndex = index;
    const isEdit = index !== null;
    this.els.notesEditorTitle.textContent = isEdit ? `Edit ${section.slice(0, -1)}` : `Add ${section.slice(0, -1)}`;
    this.els.notesEditorTextarea.value = existingText;
    this.els.notesEditorOverlay.hidden = false;
    setTimeout(() => this.els.notesEditorTextarea.focus(), 50);
  }

  hideNotesEditor() {
    this.els.notesEditorOverlay.hidden = true;
    this.els.notesEditorTextarea.value = '';
  }

  async saveNotesEditor() {
    const text = this.els.notesEditorTextarea.value.trim();
    if (!text) {
      this.showToast('Note cannot be empty', 'warning');
      return;
    }
    if (!this.state.activeWorkspace) return;

    const wsId = this.state.activeWorkspace.id;
    const section = this._notesEditorSection;

    try {
      if (this._notesEditorIndex !== null) {
        // Edit existing — remove old, add new
        await this.api('DELETE', `/api/workspaces/${wsId}/docs/${section}/${this._notesEditorIndex}`);
        await this.api('POST', `/api/workspaces/${wsId}/docs/${section}`, { text });
      } else {
        await this.api('POST', `/api/workspaces/${wsId}/docs/${section}`, { text });
      }
      this.hideNotesEditor();
      this.showToast('Saved', 'success');
      await this.loadDocs();
    } catch (err) {
      this.showToast(err.message || 'Failed to save', 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     PHASE 6: AI INSIGHTS
     ═══════════════════════════════════════════════════════════ */

  initAIInsights() {
    if (this.els.docsAiRefresh) {
      this.els.docsAiRefresh.addEventListener('click', () => this.loadAIInsights());
    }
    this._aiInsightsCache = {};
  }

  async loadAIInsights() {
    if (!this.state.activeWorkspace) return;
    const wsId = this.state.activeWorkspace.id;
    const container = this.els.docsAiInsights;
    if (!container) return;

    // Get sessions for this workspace
    const wsSessions = this.state.sessions.filter(s => s.workspaceId === wsId);
    if (wsSessions.length === 0) {
      container.innerHTML = '<div class="ai-insights-empty">No sessions in this workspace</div>';
      return;
    }

    // Show loading state — spinning refresh button + header + skeletons
    const refreshBtn = this.els.docsAiRefresh;
    if (refreshBtn) {
      refreshBtn.classList.add('ai-loading');
      refreshBtn.disabled = true;
    }

    container.innerHTML = `
      <div class="ai-insights-loading-header">
        <span class="ai-loading-spinner"></span>
        Generating summaries for ${wsSessions.length} session${wsSessions.length !== 1 ? 's' : ''}...
      </div>` +
      wsSessions.map((s) =>
        `<div class="ai-insight-skeleton">
          <div class="ai-insight-skeleton-label">${this.escapeHtml(s.name || s.id.substring(0, 12))}</div>
          <div class="ai-insight-skeleton-line"></div>
          <div class="ai-insight-skeleton-line"></div>
          <div class="ai-insight-skeleton-line"></div>
        </div>`
      ).join('');

    // Fetch summaries for each session
    const results = await Promise.allSettled(
      wsSessions.map(async (s) => {
        const cacheKey = s.id + ':' + (s.lastActive || '');
        if (this._aiInsightsCache[cacheKey]) return { session: s, data: this._aiInsightsCache[cacheKey] };
        try {
          const data = await this.api('POST', `/api/sessions/${s.id}/summarize`, {
            claudeSessionId: s.resumeSessionId || s.id,
          });
          this._aiInsightsCache[cacheKey] = data;
          return { session: s, data };
        } catch (err) {
          return { session: s, error: err.message };
        }
      })
    );

    // Stop loading state
    if (refreshBtn) {
      refreshBtn.classList.remove('ai-loading');
      refreshBtn.disabled = false;
    }

    // Render results
    container.innerHTML = results.map(r => {
      if (r.status === 'rejected' || r.value.error) {
        const s = r.value ? r.value.session : {};
        return `<div class="ai-insight-card ai-insight-error">
          <div class="ai-insight-header">
            <span class="ai-insight-name">${this.escapeHtml(s.name || 'Unknown')}</span>
            <span class="ai-insight-badge ai-badge-error">Error</span>
          </div>
          <div class="ai-insight-theme">${this.escapeHtml(r.value?.error || 'Failed to load')}</div>
        </div>`;
      }
      const { session, data } = r.value;
      const sizeKB = data.fileSize ? Math.round(data.fileSize / 1024) : '?';
      return `<div class="ai-insight-card">
        <div class="ai-insight-header">
          <span class="ai-insight-name">${this.escapeHtml(session.name)}</span>
          <span class="ai-insight-badge">${sizeKB}KB / ${data.messageCount || '?'} msgs</span>
        </div>
        <div class="ai-insight-theme"><strong>Theme:</strong> ${this.escapeHtml(data.overallTheme || 'Unknown')}</div>
        <div class="ai-insight-recent"><strong>Recent:</strong> ${this.escapeHtml(data.recentTasking || 'No recent activity')}</div>
      </div>`;
    }).join('');
  }


  /* ═══════════════════════════════════════════════════════════
     PHASE 7: RESOURCE MONITORING
     ═══════════════════════════════════════════════════════════ */

  async loadResources() {
    // Start auto-refresh polling
    if (this._resourcesInterval) clearInterval(this._resourcesInterval);
    this._resourcesInterval = setInterval(() => {
      if (this.state.viewMode === 'resources') this.fetchResources();
    }, 10000);

    await this.fetchResources();
  }

  async fetchResources() {
    const body = this.els.resourcesBody;
    if (!body) return;

    try {
      const data = await this.api('GET', '/api/resources');
      this.renderResources(data);
    } catch (err) {
      body.innerHTML = `<div class="resources-empty">Failed to load resources: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  renderResources(data) {
    const body = this.els.resourcesBody;
    if (!body || !data) return;

    const sys = data.system || {};
    const cpuPercent = Math.round(sys.cpuUsage || 0);
    const memUsedMB = sys.usedMemoryMB || 0;
    const memTotalMB = sys.totalMemoryMB || 1;
    const memPercent = Math.round((memUsedMB / memTotalMB) * 100);

    const barLevel = (pct) => pct > 80 ? 'level-danger' : pct > 60 ? 'level-warn' : 'level-ok';
    const formatUptime = (s) => {
      if (!s) return '--';
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    let html = `<div class="resources-system-grid">
      <div class="resource-card">
        <div class="resource-card-label">CPU Usage</div>
        <div class="resource-card-value">${cpuPercent}%</div>
        <div class="resource-bar"><div class="resource-bar-fill ${barLevel(cpuPercent)}" style="width: ${cpuPercent}%"></div></div>
      </div>
      <div class="resource-card">
        <div class="resource-card-label">Memory</div>
        <div class="resource-card-value">${memPercent}%</div>
        <div class="resource-bar"><div class="resource-bar-fill ${barLevel(memPercent)}" style="width: ${memPercent}%"></div></div>
        <div style="font-size:11px;color:var(--subtext0);margin-top:4px;">${Math.round(memUsedMB/1024*10)/10} / ${Math.round(memTotalMB/1024*10)/10} GB</div>
      </div>
      <div class="resource-card">
        <div class="resource-card-label">CPUs</div>
        <div class="resource-card-value">${sys.cpuCount || '--'}</div>
      </div>
      <div class="resource-card">
        <div class="resource-card-label">System Uptime</div>
        <div class="resource-card-value">${formatUptime(sys.uptimeSeconds)}</div>
      </div>
    </div>`;

    // Claude sessions section
    const claudeSessions = data.claudeSessions || [];
    const totalMem = data.totalClaudeMemoryMB || 0;

    html += `<div class="resources-claude-section">
      <div class="resources-section-title">
        Claude Sessions
        <span class="total-badge">${claudeSessions.length} active / ${Math.round(totalMem)} MB total</span>
      </div>`;

    if (claudeSessions.length === 0) {
      html += '<div class="resources-empty">No running Claude sessions</div>';
    } else {
      html += `<table class="claude-session-table">
        <thead><tr><th>Session</th><th>PID</th><th>Memory</th><th>Status</th></tr></thead>
        <tbody>`;
      claudeSessions.forEach(s => {
        html += `<tr>
          <td class="session-name-cell">${this.escapeHtml(s.sessionName || s.sessionId)}</td>
          <td class="pid-cell">${s.pid || '--'}</td>
          <td class="mem-cell">${s.memoryMB ? Math.round(s.memoryMB) + ' MB' : '--'}</td>
          <td>${s.status || '--'}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    html += '</div>';
    body.innerHTML = html;
  }
}


/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  window.cwm = new CWMApp();
});
