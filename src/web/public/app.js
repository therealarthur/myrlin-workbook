/* ═══════════════════════════════════════════════════════════════
   Claude Workspace Manager - Frontend Application
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

    // Server is fine - show fallback recovery UI
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
    // Server is also down - nothing we can do from the client
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
  /** Maximum number of terminal pane slots in the grid */
  static MAX_PANES = 6;

  constructor() {
    // ─── State ─────────────────────────────────────────────────
    this.state = {
      token: localStorage.getItem('cwm_token') || null,
      workspaces: [],
      sessions: [],
      allSessions: [],  // Always holds ALL sessions (for sidebar rendering)
      groups: [],
      projects: [],
      // Phase 18-02 + 18-04: per-provider project storage (v1.2 native object
      // shape). Plan 18-04 retired the Phase 15 back-compat shim; state.projects
      // is now a merged-flat view computed from state.projectsByProvider by
      // loadProjects, kept populated so Plan 18-02's render-time provider
      // filter (which walks state.projects) continues to work unchanged.
      projectsByProvider: {},
      // Phase 18-02: provider metadata loaded from GET /api/providers; used by
      // the sidebar tab strip and Plan 18-03's Settings Providers section.
      providers: [],
      // Phase 18-02: active sidebar tab filter. 'all' shows every provider;
      // any other value is a provider id from state.providers. Persisted to
      // localStorage so reloads land on the user's last selection.
      activeProviderTab: localStorage.getItem('cwm_activeProviderTab') || 'all',
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
      hiddenProjects: new Set(JSON.parse(localStorage.getItem('cwm_hiddenProjects') || '[]')),
      hiddenWorkspaces: new Set(JSON.parse(localStorage.getItem('cwm_hiddenWorkspaces') || '[]')),
      hiddenGroups: new Set(JSON.parse(localStorage.getItem('cwm_hiddenGroups') || '[]')),
      projectSearchQuery: '',
      showHidden: false,
      resourceData: null,
      gitStatusCache: {},
      settings: Object.assign({
        paneColorHighlights: true,
        activityIndicators: true,
        completionNotifications: true,
        sessionCountInHeader: true,
        confirmBeforeClose: true,
        autoOpenTerminal: true,
        autoTrustDialogs: false,
        maxConcurrentTasks: 4,
        headerHeight: 80,
        defaultModelPlanning: '',
        defaultModelRunning: '',
      }, JSON.parse(localStorage.getItem('cwm_settings') || '{}')),
    };

    // Load persisted workspace group collapse state
    try { this._groupCollapseState = JSON.parse(localStorage.getItem('cwm_groupCollapseState') || '{}'); } catch (_) { this._groupCollapseState = {}; }
    // Load persisted workspace accordion collapse state (prevents re-open on re-render)
    try { this._wsCollapseState = JSON.parse(localStorage.getItem('cwm_wsCollapseState') || '{}'); } catch (_) { this._wsCollapseState = {}; }

    // ─── Terminal panes ──────────────────────────────────────────
    this.terminalPanes = new Array(CWMApp.MAX_PANES).fill(null);
    this._activeTerminalSlot = null;
    this._paneRefreshTimers = {};
    // Cache of TerminalPane instances per group to avoid reconnection on tab switch.
    // Key: groupId, Value: { panes: [TerminalPane|null x MAX_PANES], domFragments: [DocumentFragment|null x MAX_PANES] }
    this._groupPaneCache = {};
    this.PANE_SLOT_COLORS = ['mauve', 'blue', 'green', 'peach', 'red', 'pink'];
    this.TAB_COLORS = (window.InstanceColors && window.InstanceColors.TAB_COLORS) || [];
    this._gridColSizes = [1, 1];  // fr ratios for column widths
    this._gridRowSizes = [1, 1];  // fr ratios for row heights
    // Voice recognition instances per slot (for mic-to-terminal input)
    this._voiceRecognitions = {};
    // Feature detection: check if Web Speech API (SpeechRecognition) is available
    this._speechRecognitionAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

    // ─── Quick Switcher state ──────────────────────────────────
    this.qsHighlightIndex = -1;
    this.qsResults = [];

    // ─── Global Search state ─────────────────────────────────
    this._searchDebounceTimer = null;

    // ─── Conflict Detection state ────────────────────────────
    this._conflictCheckInterval = null;
    this._lastConflictKeys = new Set();  // Dedup: tracks conflicts already toasted
    this._jsonlConflicts = [];           // Global JSONL-based conflicts from GET /api/conflicts
    this._lastJsonlConflictKeys = new Set(); // Dedup for JSONL conflict toasts
    this._paneConflictMap = new Map();   // sessionId -> [{ file, sessions }] for per-pane badges

    // ─── SSE ───────────────────────────────────────────────────
    this.eventSource = null;
    this.sseRetryTimeout = null;

    // ─── Modal state ───────────────────────────────────────────
    this.modalResolve = null;

    // ─── Boot ──────────────────────────────────────────────────
    this.cacheElements();
    this.bindEvents();
    this.init();

    // Clear the init timeout - we made it
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
      passwordToggleBtn: document.getElementById('password-toggle-btn'),

      // App
      app: document.getElementById('app'),
      sidebarToggle: document.getElementById('sidebar-toggle'),
      sidebar: document.getElementById('sidebar'),
      // Phase 18-02: sidebar provider tab strip (rendered by renderProviderTabs)
      sidebarProviderTabs: document.getElementById('sidebar-provider-tabs'),
      workspaceList: document.getElementById('workspace-list'),
      workspaceCount: document.getElementById('workspace-count'),
      createWorkspaceBtn: document.getElementById('create-workspace-btn'),
      workspacesRefresh: document.getElementById('workspaces-refresh'),
      toggleHiddenBtn: document.getElementById('toggle-hidden-btn'),
      toggleHiddenLabel: document.getElementById('toggle-hidden-label'),

      // Header
      viewTabs: document.querySelectorAll('.view-tab'),
      statRunning: document.getElementById('stat-running'),
      statTotal: document.getElementById('stat-total'),
      openSwitcherBtn: document.getElementById('open-switcher-btn'),
      logoutBtn: document.getElementById('logout-btn'),
      themeToggleBtn: document.getElementById('theme-toggle-btn'),
      themeDropdown: document.getElementById('theme-dropdown'),
      vkbToggleBtn: document.getElementById('vkb-toggle-btn'),
      scaleDownBtn: document.getElementById('scale-down-btn'),
      scaleUpBtn: document.getElementById('scale-up-btn'),

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
      detailPorts: document.getElementById('detail-ports'),
      detailBranch: document.getElementById('detail-branch'),
      detailCreated: document.getElementById('detail-created'),
      detailLastActive: document.getElementById('detail-last-active'),
      detailCost: document.getElementById('detail-cost'),
      detailCostTotal: document.getElementById('detail-cost-total'),
      detailCostBreakdown: document.getElementById('detail-cost-breakdown'),
      detailTokenBar: document.getElementById('detail-token-bar'),
      detailStartBtn: document.getElementById('detail-start-btn'),
      detailStopBtn: document.getElementById('detail-stop-btn'),
      detailRestartBtn: document.getElementById('detail-restart-btn'),
      detailLogs: document.getElementById('detail-logs'),

      // Quick Switcher
      qsOverlay: document.getElementById('quick-switcher-overlay'),
      qsInput: document.getElementById('qs-input'),
      qsResultsContainer: document.getElementById('qs-results'),

      // Global Search
      searchOverlay: document.getElementById('search-overlay'),
      searchInput: document.getElementById('search-input'),
      searchResults: document.getElementById('search-results'),

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
      projectsRefresh: document.getElementById('projects-refresh'),
      projectsToggle: document.getElementById('projects-toggle'),
      projectsSearchInput: document.getElementById('projects-search-input'),

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
      docsRoadmapList: document.getElementById('docs-roadmap-list'),
      docsRoadmapCount: document.getElementById('docs-roadmap-count'),
      docsRulesList: document.getElementById('docs-rules-list'),
      docsRulesCount: document.getElementById('docs-rules-count'),
      docsAiInsights: document.getElementById('docs-ai-insights'),
      docsAiRefresh: document.getElementById('docs-ai-refresh'),

      // td Issues (docs panel integration)
      docsTdSection: document.getElementById('docs-td-section'),
      docsTdList: document.getElementById('docs-td-list'),
      docsTdCount: document.getElementById('docs-td-count'),
      docsTdAddBtn: document.getElementById('docs-td-add-btn'),
      docsTdRefreshBtn: document.getElementById('docs-td-refresh-btn'),
      docsTdSetupBar: document.getElementById('docs-td-setup-bar'),
      docsTdSetupMsg: document.getElementById('docs-td-setup-msg'),
      docsTdInitBtn: document.getElementById('docs-td-init-btn'),
      docsTdSetdirBtn: document.getElementById('docs-td-setdir-btn'),

      // td Issue Detail Modal
      tdIssueModalOverlay: document.getElementById('td-issue-modal-overlay'),
      tdIssueModalTitle: document.getElementById('td-issue-modal-title'),
      tdIssueModalId: document.getElementById('td-issue-modal-id'),
      tdIssueModalBody: document.getElementById('td-issue-modal-body'),
      tdIssueModalClose: document.getElementById('td-issue-modal-close'),
      tdIssueModalCloseBtn: document.getElementById('td-issue-modal-close-btn'),
      tdIssueModalPromoteBtn: document.getElementById('td-issue-modal-promote-btn'),

      // Feature Board
      featureBoard: document.getElementById('feature-board'),
      boardColumns: document.getElementById('board-columns'),
      boardAddBtn: document.getElementById('board-add-btn'),

      // Terminal Tab Groups
      terminalGroupsBar: document.getElementById('terminal-groups-bar'),
      terminalGroupsTabs: document.getElementById('terminal-groups-tabs'),

      // Notes Editor
      notesEditorOverlay: document.getElementById('notes-editor-overlay'),
      notesEditorTitle: document.getElementById('notes-editor-title'),
      notesEditorTextarea: document.getElementById('notes-editor-textarea'),
      notesEditorClose: document.getElementById('notes-editor-close'),
      notesEditorCancel: document.getElementById('notes-editor-cancel'),
      notesEditorSave: document.getElementById('notes-editor-save'),

      // Tasks
      tasksPanel: document.getElementById('tasks-panel'),
      tasksList: document.getElementById('tasks-list'),
      kanbanBoard: document.getElementById('kanban-board'),
      sidebarViewToggle: document.getElementById('sidebar-view-toggle'),
      sidebarProjectsHeader: document.getElementById('sidebar-projects-header'),
      sidebarTasksHeader: document.getElementById('sidebar-tasks-header'),
      sidebarTasksModeToggle: document.getElementById('sidebar-tasks-mode-toggle'),
      sidebarTasksList: document.getElementById('sidebar-tasks-list'),
      tasksLayoutToggle: document.getElementById('tasks-layout-toggle'),
      tasksSearch: document.getElementById('tasks-search'),
      newTaskBtn: document.getElementById('new-task-btn'),
      newTaskOverlay: document.getElementById('new-task-overlay'),
      newTaskClose: document.getElementById('new-task-close'),
      newTaskCancel: document.getElementById('new-task-cancel'),
      newTaskCreate: document.getElementById('new-task-create'),
      newTaskName: document.getElementById('new-task-name'),
      newTaskDescription: document.getElementById('new-task-description'),
      newTaskStartNow: document.getElementById('new-task-start-now'),
      newTaskBranchPreview: document.getElementById('new-task-branch-preview'),
      newTaskDir: document.getElementById('new-task-dir'),
      newTaskDirCustom: document.getElementById('new-task-dir-custom'),
      newTaskPrompt: document.getElementById('new-task-prompt'),
      newTaskModel: document.getElementById('new-task-model'),
      newTaskTags: document.getElementById('new-task-tags'),
      newTaskFlags: document.getElementById('new-task-flags'),

      // PR dialog
      prDialogOverlay: document.getElementById('pr-dialog-overlay'),
      prDialogClose: document.getElementById('pr-dialog-close'),
      prDialogCancel: document.getElementById('pr-dialog-cancel'),
      prDialogSubmit: document.getElementById('pr-dialog-submit'),
      prTitle: document.getElementById('pr-title'),
      prBody: document.getElementById('pr-body'),
      prBaseBranch: document.getElementById('pr-base-branch'),
      prLabels: document.getElementById('pr-labels'),
      prDraft: document.getElementById('pr-draft'),
      prGenerateDesc: document.getElementById('pr-generate-desc'),

      // Spinoff dialog
      spinoffOverlay: document.getElementById('spinoff-overlay'),
      spinoffClose: document.getElementById('spinoff-close'),
      spinoffCancel: document.getElementById('spinoff-cancel'),
      spinoffCreate: document.getElementById('spinoff-create'),
      spinoffTitle: document.getElementById('spinoff-title'),
      spinoffSubtitle: document.getElementById('spinoff-subtitle'),
      spinoffBody: document.getElementById('spinoff-body'),
      spinoffLoading: document.getElementById('spinoff-loading'),
      spinoffTasks: document.getElementById('spinoff-tasks'),
      spinoffError: document.getElementById('spinoff-error'),
      spinoffFooter: document.getElementById('spinoff-footer'),
      spinoffStartNow: document.getElementById('spinoff-start-now'),
      spinoffSelectedCount: document.getElementById('spinoff-selected-count'),

      // Launcher
      launcherOverlay: document.getElementById('launcher-overlay'),
      launcherClose: document.getElementById('launcher-close'),
      launcherSearch: document.getElementById('launcher-search'),
      launcherList: document.getElementById('launcher-list'),
      launcherForm: document.getElementById('launcher-form'),
      launcherFormSelected: document.getElementById('launcher-form-selected'),
      launcherSessionName: document.getElementById('launcher-session-name'),
      launcherModel: document.getElementById('launcher-model'),
      launcherSubmit: document.getElementById('launcher-submit'),
      sidebarLaunchBtn: document.getElementById('sidebar-launch-btn'),

      // Costs
      costsPanel: document.getElementById('costs-panel'),
      costsBody: document.getElementById('costs-body'),
      costsRefreshBtn: document.getElementById('costs-refresh-btn'),
      costsPeriodSelector: document.getElementById('costs-period-selector'),

      // Resources
      resourcesPanel: document.getElementById('resources-panel'),
      resourcesBody: document.getElementById('resources-body'),
      resourcesRefreshBtn: document.getElementById('resources-refresh-btn'),

      // Subagent tracking
      detailSubagents: document.getElementById('detail-subagents'),
      detailSubagentCount: document.getElementById('detail-subagent-count'),
      detailSubagentList: document.getElementById('detail-subagent-list'),

      // Workspace Analytics
      detailAnalytics: document.getElementById('detail-analytics'),
      analyticsGrid: document.getElementById('analytics-grid'),
      analyticsTopSessions: document.getElementById('analytics-top-sessions'),

      // Update
      updateBtn: document.getElementById('update-btn'),
      updateBadge: document.getElementById('update-badge'),
      updateOverlay: document.getElementById('update-overlay'),
      updateBody: document.getElementById('update-body'),
      updateStatus: document.getElementById('update-status'),
      updateSteps: document.getElementById('update-steps'),
      updateStartBtn: document.getElementById('update-start-btn'),
      updateDismissBtn: document.getElementById('update-dismiss-btn'),
      updateCloseBtn: document.getElementById('update-close-btn'),
      updateFooter: document.getElementById('update-footer'),

      // Image upload
      imageUploadInput: document.getElementById('image-upload-input'),

      // Conflict Center
      conflictIndicatorBtn: document.getElementById('conflict-indicator-btn'),
      conflictBadge: document.getElementById('conflict-badge'),
      conflictCenterOverlay: document.getElementById('conflict-center-overlay'),
      conflictCenterList: document.getElementById('conflict-center-list'),
      conflictCenterSummary: document.getElementById('conflict-center-summary'),
      conflictRefreshBtn: document.getElementById('conflict-refresh-btn'),
      conflictCloseBtn: document.getElementById('conflict-close-btn'),

      // Diff Viewer
      diffViewerOverlay: document.getElementById('diff-viewer-overlay'),
      diffViewerTitle: document.getElementById('diff-viewer-title'),
      diffViewerStats: document.getElementById('diff-viewer-stats'),
      diffViewerFiles: document.getElementById('diff-viewer-files'),
      diffViewerContent: document.getElementById('diff-viewer-content'),
      diffViewerClose: document.getElementById('diff-viewer-close'),

      // Settings
      settingsOverlay: document.getElementById('settings-overlay'),
      settingsBody: document.getElementById('settings-body'),
      settingsSearchInput: document.getElementById('settings-search-input'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsCloseBtn: document.getElementById('settings-close-btn'),

      // Session Manager
      sessionManagerOverlay: document.getElementById('session-manager-overlay'),
      sessionManagerList: document.getElementById('session-manager-list'),
      smSelectAllBtn: document.getElementById('sm-select-all-btn'),
      smStopSelectedBtn: document.getElementById('sm-stop-selected-btn'),
      smCloseBtn: document.getElementById('sm-close-btn'),
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

    // Password visibility toggle
    if (this.els.passwordToggleBtn) {
      this.els.passwordToggleBtn.addEventListener('click', () => this.togglePasswordVisibility());
    }

    // Theme picker dropdown
    if (this.els.themeToggleBtn) {
      this.els.themeToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = this.els.themeDropdown;
        if (dd) dd.hidden = !dd.hidden;
      });
    }
    if (this.els.themeDropdown) {
      this.els.themeDropdown.querySelectorAll('.theme-option').forEach(btn => {
        btn.addEventListener('click', () => {
          this.setTheme(btn.dataset.theme);
          this.els.themeDropdown.hidden = true;
        });
      });
      // Close dropdown when clicking outside
      document.addEventListener('click', () => {
        if (this.els.themeDropdown) this.els.themeDropdown.hidden = true;
      });
    }

    // Virtual keyboard toggle. inputmode="none" is a no-op on devices without
    // a soft keyboard, so we apply it unconditionally instead of trying to
    // detect "is mobile" (which is unreliable across browsers).
    this._vkbDisabled = localStorage.getItem('cwm_vkb_disabled') === '1';
    this._applyVkbState();
    if (this.els.vkbToggleBtn) {
      this.els.vkbToggleBtn.addEventListener('click', () => {
        this._vkbDisabled = !this._vkbDisabled;
        localStorage.setItem('cwm_vkb_disabled', this._vkbDisabled ? '1' : '0');
        this._applyVkbState();
      });
      // Watch for newly-created xterm helper textareas and apply state to them.
      const obs = new MutationObserver((muts) => {
        if (!this._vkbDisabled) return;
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches('.xterm-helper-textarea')) {
              n.setAttribute('inputmode', 'none');
            } else if (n.querySelectorAll) {
              n.querySelectorAll('.xterm-helper-textarea').forEach(t => t.setAttribute('inputmode', 'none'));
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    // While any HTML5 drag is active, mark <body> so the mobile sidebar
    // backdrop becomes pointer-events: none. Without this, on mobile the
    // backdrop occludes terminal panes for elementFromPoint, so the
    // DragDropTouch polyfill never fires dragover/drop on the pane behind it.
    document.addEventListener('dragstart', () => document.body.classList.add('cwm-dragging'), true);
    const clearDragging = () => document.body.classList.remove('cwm-dragging');
    document.addEventListener('dragend', clearDragging, true);
    document.addEventListener('drop', clearDragging, true);

    // Sidebar toggle (mobile)
    this.els.sidebarToggle.addEventListener('click', () => this.toggleSidebar());

    // View tabs
    this.els.viewTabs.forEach(tab => {
      tab.addEventListener('click', () => this.setViewMode(tab.dataset.mode));
    });

    // Workspaces refresh
    if (this.els.workspacesRefresh) {
      this.els.workspacesRefresh.addEventListener('click', () => {
        this.loadWorkspaces();
        this.loadSessions();
        this.loadStats();
        this.showToast('Refreshing projects...', 'info');
      });
    }

    // Projects refresh - bypass both browser and server caches
    if (this.els.projectsRefresh) {
      this.els.projectsRefresh.addEventListener('click', () => {
        sessionStorage.removeItem('cwm_projects');
        this.loadProjects(true);
        this.showToast('Refreshing projects...', 'info');
      });
    }

    // Projects toggle
    if (this.els.projectsToggle) {
      this.els.projectsToggle.addEventListener('click', () => this.toggleProjectsPanel());
    }

    // Projects search/filter
    if (this.els.projectsSearchInput) {
      this.els.projectsSearchInput.addEventListener('input', (e) => {
        this.state.projectSearchQuery = e.target.value.trim().toLowerCase();
        this.renderProjects();
      });
    }

    // Find a Conversation button
    const findConvoBtn = document.getElementById('find-conversation-btn');
    if (findConvoBtn) {
      findConvoBtn.addEventListener('click', () => this.openFindConversation());
    }

    // Launcher button and overlay
    if (this.els.sidebarLaunchBtn) {
      this.els.sidebarLaunchBtn.addEventListener('click', () => this.openLauncher());
    }
    if (this.els.launcherClose) {
      this.els.launcherClose.addEventListener('click', () => this.closeLauncher());
    }
    if (this.els.launcherOverlay) {
      this.els.launcherOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.launcherOverlay) this.closeLauncher();
      });
    }
    if (this.els.launcherSearch) {
      this.els.launcherSearch.addEventListener('input', () => this.filterLauncherProjects());
    }
    if (this.els.launcherSubmit) {
      this.els.launcherSubmit.addEventListener('click', () => this.launchSelectedProject());
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

    // Workspace / Category creation dropdown
    this.els.createWorkspaceBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent document click handler from immediately closing the menu
      const rect = e.currentTarget.getBoundingClientRect();
      this._renderContextItems('New', [
        { label: 'New Project', icon: '&#128193;', action: () => this.createWorkspace() },
        { label: 'New Category', icon: '&#128194;', action: () => this.createGroup() },
      ], rect.left, rect.bottom + 4);
    });

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

    // Context Menu - dismiss on click outside or Escape
    document.addEventListener('click', (e) => {
      // Don't dismiss if clicking inside the context menu (submenus need to stay open)
      if (this.els.contextMenu && this.els.contextMenu.contains(e.target)) return;
      this.hideContextMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideContextMenu();
    });

    // Image upload - file input change handler
    if (this.els.imageUploadInput) {
      this.els.imageUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        this.handleImageUpload(file, this._uploadTargetSlot);
        e.target.value = ''; // Reset so same file can be re-selected
      });
    }

    // Suppress browser's native right-click menu within the app.
    // Show a minimal context menu with "Inspect Element" for non-handled areas.
    // (Specific handlers on child elements call stopPropagation, so this only
    // fires for areas without their own context menu.)
    this.els.app.addEventListener('contextmenu', (e) => {
      // Allow native menu on text inputs/textareas for copy/paste
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      this._showInspectContextMenu(e.target, e.clientX, e.clientY);
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

    // Docs/Board tab switching - use event delegation on parent to avoid listener leaks
    // (Adding listeners to each .docs-tab individually would accumulate if tabs are ever re-rendered)
    const docsTabBar = document.querySelector('.docs-tabs');
    if (docsTabBar) {
      docsTabBar.addEventListener('click', (e) => {
        const tab = e.target.closest('.docs-tab');
        if (!tab) return;
        document.querySelectorAll('.docs-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const view = tab.dataset.tab;
        // Toggle docs structured/raw views vs board
        if (this.els.docsStructured) this.els.docsStructured.hidden = (view === 'board');
        if (this.els.docsRaw) this.els.docsRaw.hidden = true; // always hide raw when switching tabs
        if (this.els.featureBoard) this.els.featureBoard.hidden = (view !== 'board');
        // Hide docs-specific header buttons when on board view
        if (this.els.docsToggleRaw) this.els.docsToggleRaw.hidden = (view === 'board');
        if (this.els.docsSaveBtn) this.els.docsSaveBtn.hidden = true;
        if (view === 'board') this.loadFeatureBoard();
      });
    }

    // Board add button
    if (this.els.boardAddBtn) {
      this.els.boardAddBtn.addEventListener('click', () => this.createFeature());
    }

    // Cost dashboard controls
    if (this.els.costsRefreshBtn) {
      this.els.costsRefreshBtn.addEventListener('click', () => this.loadCosts());
    }
    if (this.els.costsPeriodSelector) {
      this.els.costsPeriodSelector.addEventListener('click', (e) => {
        const btn = e.target.closest('.costs-period-btn');
        if (btn && btn.dataset.period) {
          this.loadCosts(btn.dataset.period);
        }
      });
    }

    // Resources refresh
    if (this.els.resourcesRefreshBtn) {
      this.els.resourcesRefreshBtn.addEventListener('click', () => this.refreshResources());
    }

    // Conflict Center
    if (this.els.conflictIndicatorBtn) {
      this.els.conflictIndicatorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleConflictCenter();
      });
    }
    if (this.els.conflictCloseBtn) {
      this.els.conflictCloseBtn.addEventListener('click', () => this.closeConflictCenter());
    }
    if (this.els.conflictRefreshBtn) {
      this.els.conflictRefreshBtn.addEventListener('click', () => {
        this.checkForConflicts();
        if (this._conflictCenterOpen) this.renderConflictCenter();
      });
    }

    // Session Manager - click stat chips to open overlay
    const statChips = document.querySelectorAll('.stat-chip');
    statChips.forEach(chip => {
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const title = chip.getAttribute('title') || '';
        if (title.includes('Running')) {
          this.toggleSessionManager('running');
        } else {
          this.toggleSessionManager('all');
        }
      });
    });

    // Session Manager overlay controls
    if (this.els.smCloseBtn) {
      this.els.smCloseBtn.addEventListener('click', () => this.closeSessionManager());
    }
    if (this.els.smSelectAllBtn) {
      this.els.smSelectAllBtn.addEventListener('click', () => this.smToggleSelectAll());
    }
    if (this.els.smStopSelectedBtn) {
      this.els.smStopSelectedBtn.addEventListener('click', () => this.smStopSelected());
    }
    // Filter buttons
    if (this.els.sessionManagerOverlay) {
      this.els.sessionManagerOverlay.querySelector('.session-manager-filters')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.sm-filter');
        if (!btn) return;
        this._smFilter = btn.dataset.filter || 'all';
        this.els.sessionManagerOverlay.querySelectorAll('.sm-filter').forEach(f => f.classList.remove('active'));
        btn.classList.add('active');
        this.renderSessionManager();
      });
      // Close on click outside
      this._smOutsideClickHandler = (e) => {
        if (this.els.sessionManagerOverlay && !this.els.sessionManagerOverlay.hidden &&
            !this.els.sessionManagerOverlay.contains(e.target) &&
            !e.target.closest('.stat-chip')) {
          this.closeSessionManager();
        }
      };
    }

    // Settings
    if (this.els.settingsBtn) {
      this.els.settingsBtn.addEventListener('click', () => this.openSettings());
    }
    if (this.els.settingsCloseBtn) {
      this.els.settingsCloseBtn.addEventListener('click', () => this.closeSettings());
    }
    if (this.els.settingsOverlay) {
      this.els.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.settingsOverlay) this.closeSettings();
      });
    }
    if (this.els.settingsSearchInput) {
      this.els.settingsSearchInput.addEventListener('input', () => this.filterSettings());
    }

    // Diff Viewer
    if (this.els.diffViewerClose) {
      this.els.diffViewerClose.addEventListener('click', () => this.closeDiffViewer());
    }
    if (this.els.diffViewerOverlay) {
      this.els.diffViewerOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.diffViewerOverlay) this.closeDiffViewer();
      });
    }

    // Sidebar view toggle (Projects vs Tasks)
    if (this.els.sidebarViewToggle) {
      this.els.sidebarViewToggle.querySelectorAll('.sidebar-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.setSidebarView(btn.dataset.sidebarView);
        });
      });
    }

    // Sidebar tasks mode toggle (native vs td)
    if (this.els.sidebarTasksModeToggle) {
      this.els.sidebarTasksModeToggle.querySelectorAll('.sidebar-tasks-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this._setSidebarTasksMode(btn.dataset.tasksMode);
        });
      });
    }

    // Tasks layout toggle (board vs list)
    if (this.els.tasksLayoutToggle) {
      this.els.tasksLayoutToggle.querySelectorAll('.tasks-layout-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const layout = btn.dataset.layout;
          this.setTasksLayout(layout);
        });
      });
    }

    // Tasks search filter
    if (this.els.tasksSearch) {
      this.els.tasksSearch.addEventListener('input', () => {
        this._tasksSearchQuery = this.els.tasksSearch.value.toLowerCase().trim();
        if (this._worktreeTaskCache) {
          const filtered = this._filterTasks(this._worktreeTaskCache);
          if (this._tasksLayout === 'board') {
            this._renderKanbanBoard(filtered);
          } else {
            this._renderTasksList(filtered);
          }
        }
      });
    }

    // New Task dialog
    if (this.els.newTaskBtn) {
      this.els.newTaskBtn.addEventListener('click', () => this.openNewTaskDialog());
    }
    if (this.els.newTaskClose) {
      this.els.newTaskClose.addEventListener('click', () => this.closeNewTaskDialog());
    }
    if (this.els.newTaskCancel) {
      this.els.newTaskCancel.addEventListener('click', () => this.closeNewTaskDialog());
    }
    if (this.els.newTaskCreate) {
      this.els.newTaskCreate.addEventListener('click', () => this.submitNewTask());
    }
    if (this.els.newTaskOverlay) {
      this.els.newTaskOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.newTaskOverlay) this.closeNewTaskDialog();
      });
    }
    if (this.els.newTaskName) {
      this.els.newTaskName.addEventListener('input', () => this.updateBranchPreview());
    }
    if (this.els.newTaskDir) {
      this.els.newTaskDir.addEventListener('change', () => {
        const isCustom = this.els.newTaskDir.value === '__custom__';
        this.els.newTaskDirCustom.hidden = !isCustom;
        if (isCustom) this.els.newTaskDirCustom.focus();
      });
    }

    // PR dialog bindings
    if (this.els.prDialogClose) {
      this.els.prDialogClose.addEventListener('click', () => this.closePRDialog());
    }
    if (this.els.prDialogCancel) {
      this.els.prDialogCancel.addEventListener('click', () => this.closePRDialog());
    }
    if (this.els.prDialogSubmit) {
      this.els.prDialogSubmit.addEventListener('click', () => this.submitPR());
    }
    if (this.els.prDialogOverlay) {
      this.els.prDialogOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.prDialogOverlay) this.closePRDialog();
      });
    }
    if (this.els.prGenerateDesc) {
      this.els.prGenerateDesc.addEventListener('click', () => this.generatePRDescription());
    }

    // Spinoff dialog bindings
    if (this.els.spinoffClose) {
      this.els.spinoffClose.addEventListener('click', () => this.closeSpinoffDialog());
    }
    if (this.els.spinoffCancel) {
      this.els.spinoffCancel.addEventListener('click', () => this.closeSpinoffDialog());
    }
    if (this.els.spinoffCreate) {
      this.els.spinoffCreate.addEventListener('click', () => this.submitSpinoffTasks());
    }
    if (this.els.spinoffOverlay) {
      this.els.spinoffOverlay.addEventListener('click', (e) => {
        if (e.target === this.els.spinoffOverlay) this.closeSpinoffDialog();
      });
    }

    // Update button
    if (this.els.updateBtn) {
      this.els.updateBtn.addEventListener('click', () => this.showUpdateModal());
    }
    if (this.els.updateStartBtn) {
      this.els.updateStartBtn.addEventListener('click', () => this.performUpdate());
    }
    if (this.els.updateDismissBtn) {
      this.els.updateDismissBtn.addEventListener('click', () => this.hideUpdateModal());
    }
    if (this.els.updateCloseBtn) {
      this.els.updateCloseBtn.addEventListener('click', () => this.hideUpdateModal());
    }

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+K / Cmd+K - Quick Switcher
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (this.state.token) this.openQuickSwitcher();
      }
      // Ctrl+Shift+F / Cmd+Shift+F - Global Search
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        if (this.state.token) this.openGlobalSearch();
      }
      // ? key - Help / Feature Discovery (only when no input is focused)
      if (e.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        if (this.state.token) this.openQuickSwitcher('help');
      }
      // F1 - Help / Feature Discovery
      if (e.key === 'F1') {
        e.preventDefault();
        if (this.state.token) this.openQuickSwitcher('help');
      }
      // Ctrl+, / Cmd+, - Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        if (this.state.token) this.openSettings();
      }
      // Ctrl+Shift+N / Cmd+Shift+N - New Worktree Task
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        if (this.state.token && this.state.settings.enableWorktreeTasks) this.openNewTaskDialog();
      }
      // Ctrl+S / Cmd+S - Save current file (Files tab only)
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        if (this._activeTasksTab === 'files' && this._filesEditorCurrentFile) {
          e.preventDefault();
          this._saveCurrentFile();
        }
      }
      // Escape
      if (e.key === 'Escape') {
        if (this.els.diffViewerOverlay && !this.els.diffViewerOverlay.hidden) {
          this.closeDiffViewer();
        } else
        if (this.els.newTaskOverlay && !this.els.newTaskOverlay.hidden) {
          this.closeNewTaskDialog();
        } else
        if (this.els.settingsOverlay && !this.els.settingsOverlay.hidden) {
          this.closeSettings();
        } else if (this.els.conflictCenterOverlay && !this.els.conflictCenterOverlay.hidden) {
          this.closeConflictCenter();
        } else if (this.els.sessionManagerOverlay && !this.els.sessionManagerOverlay.hidden) {
          this.closeSessionManager();
        } else if (this.els.searchOverlay && !this.els.searchOverlay.hidden) {
          this.closeGlobalSearch();
        } else if (this.els.actionSheetOverlay && !this.els.actionSheetOverlay.hidden) {
          this.hideActionSheet();
        } else if (!this.els.qsOverlay.hidden) {
          this.closeQuickSwitcher();
        } else if (!this.els.modalOverlay.hidden) {
          this.closeModal(null);
        } else {
          // Lowest priority: collapse any expanded terminal pane
          this._collapseAllExpandedPanes();
        }
      }
    });

    // ─── Terminal Completion Notifications ─────────────────────
    // When a terminal pane detects Claude has finished (prompt visible),
    // it dispatches a 'terminal-idle' event. We listen at the document
    // level because the event bubbles from the terminal container.
    document.addEventListener('terminal-idle', (e) => {
      this.onTerminalIdle(e.detail);
    });

    // ─── Terminal Activity Feed ──────────────────────────────────
    // Real-time activity indicator on each pane header (Reading, Writing, etc.)
    // The 'terminal-activity' event bubbles from the terminal container.
    document.addEventListener('terminal-activity', (e) => {
      const { sessionId, activity } = e.detail;
      // Find which slot has this session
      for (let i = 0; i < CWMApp.MAX_PANES; i++) {
        if (this.terminalPanes[i] && this.terminalPanes[i].sessionId === sessionId) {
          this.updatePaneActivity(i, activity);
          break;
        }
      }
    });

    // ─── Terminal Needs-Input Badge ─────────────────────────
    // When auto-trust detects a question it won't auto-answer, show/hide
    // an amber "Needs input" badge on the terminal pane header.
    document.addEventListener('terminal-needs-input', (e) => {
      const { sessionId, needsInput } = e.detail;
      for (let i = 0; i < CWMApp.MAX_PANES; i++) {
        if (this.terminalPanes[i] && this.terminalPanes[i].sessionId === sessionId) {
          const paneEl = document.getElementById(`terminal-pane-${i}`);
          if (paneEl) {
            const header = paneEl.querySelector('.terminal-pane-header');
            if (header) header.dataset.needsInput = needsInput ? 'true' : 'false';
          }
          break;
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
    // Adjust layout height + refit terminal panes.
    if (window.visualViewport) {
      let vpResizeTimer = null;
      window.visualViewport.addEventListener('resize', () => {
        clearTimeout(vpResizeTimer);
        vpResizeTimer = setTimeout(() => {
          // Set --vh CSS variable to actual visible height (keyboard-aware)
          const vh = window.visualViewport.height;
          document.documentElement.style.setProperty('--vh', vh + 'px');

          // Detect keyboard open/close on mobile
          if (window.innerWidth <= 768) {
            const isKeyboardOpen = vh < window.screen.height * 0.75;
            document.body.classList.toggle('keyboard-open', isKeyboardOpen);
          }

          // Refit terminal panes
          if (this.state.viewMode === 'terminal') {
            this.terminalPanes.forEach(tp => {
              if (tp) tp.safeFit();
            });
          }
        }, 150);
      });

      // Compensate for iOS Safari viewport scroll when keyboard opens
      window.visualViewport.addEventListener('scroll', () => {
        if (window.innerWidth > 768) return;
        const offset = window.visualViewport.offsetTop;
        const app = document.getElementById('app');
        if (app) {
          app.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
        }
      });
    }

    // ─── Mobile: Terminal Toolbar ──────────────────────────────
    // Toolbar buttons send input directly via WebSocket - they work in
    // both scroll and type mode, no textarea focus needed.
    document.querySelectorAll('.terminal-mobile-toolbar button').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const activePane = this._activeTerminalSlot !== null
          ? this.terminalPanes[this._activeTerminalSlot]
          : this.terminalPanes.find(tp => tp !== null);
        if (!activePane) return;

        // Image upload trigger
        if (key === 'upload') {
          this._uploadTargetSlot = this._activeTerminalSlot;
          if (this.els.imageUploadInput) this.els.imageUploadInput.click();
          return;
        }

        // Keyboard toggle - show/hide dedicated mobile input field
        // (bypasses xterm.js textarea entirely to avoid autocorrect duplication)
        if (key === 'keyboard') {
          const paneEl = btn.closest('.terminal-pane');
          const inputRow = paneEl && paneEl.querySelector('.terminal-mobile-input-row');
          const inputField = inputRow && inputRow.querySelector('.mobile-type-input');
          const isActive = inputRow && inputRow.classList.contains('active');

          if (isActive) {
            // Closing: hide input row
            if (inputRow) inputRow.classList.remove('active');
            if (inputField) inputField.blur();
            document.querySelectorAll('.toolbar-keyboard').forEach(kb => {
              kb.classList.remove('toolbar-active');
              kb.textContent = '\u2328 Type';
            });
          } else {
            // Opening: show input row and focus
            if (inputRow) inputRow.classList.add('active');
            if (inputField) {
              inputField.value = '';
              inputField.focus();
            }
            document.querySelectorAll('.toolbar-keyboard').forEach(kb => {
              kb.classList.add('toolbar-active');
              kb.textContent = '\u2328 Typing';
            });
          }
          return;
        }

        // Copy terminal content to clipboard (mobile copy button)
        if (key === 'copy') {
          let textToCopy = '';
          // If there's an active selection in the terminal, copy that
          if (activePane.term && activePane.term.hasSelection()) {
            textToCopy = activePane.term.getSelection();
          } else if (activePane.term) {
            // No selection - copy all visible terminal content
            const buffer = activePane.term.buffer.active;
            const lines = [];
            for (let i = 0; i < buffer.length; i++) {
              const line = buffer.getLine(i);
              if (line) lines.push(line.translateToString(true));
            }
            // Trim trailing empty lines
            while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
              lines.pop();
            }
            textToCopy = lines.join('\n');
          }
          if (textToCopy) {
            navigator.clipboard.writeText(textToCopy).then(() => {
              this.showToast('Copied to clipboard', 'success');
            }).catch(() => {
              this.showToast('Failed to copy - check browser permissions', 'error');
            });
          } else {
            this.showToast('Nothing to copy', 'info');
          }
          return;
        }

        // Full-screen reader overlay: extract terminal buffer as scrollable text
        if (key === 'reader') {
          this.openTerminalReader(activePane);
          return;
        }

        // All other buttons: send key via WebSocket directly
        if (!activePane.ws || activePane.ws.readyState !== WebSocket.OPEN) return;

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
        }
      });
    });

    // ── Mobile input field: Send button + Enter key ──────────────
    // Sends typed text to the active terminal's PTY, bypassing xterm.js textarea
    document.querySelectorAll('.terminal-mobile-input-row').forEach(row => {
      const input = row.querySelector('.mobile-type-input');
      const sendBtn = row.querySelector('.mobile-send-btn');
      if (!input || !sendBtn) return;

      const sendInput = () => {
        const paneEl = row.closest('.terminal-pane');
        const slot = paneEl && parseInt(paneEl.dataset.slot, 10);
        const pane = (slot != null) ? this.terminalPanes[slot] : null;
        if (!pane || !pane.ws || pane.ws.readyState !== WebSocket.OPEN) return;
        const text = input.value;
        if (text) {
          pane.ws.send(JSON.stringify({ type: 'input', data: text }));
        }
        // Always send Enter after the text
        pane.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
        input.value = '';
        input.focus();
      };

      sendBtn.addEventListener('click', sendInput);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendInput();
        }
      });
    });

    // Set up event delegation on persistent containers (replaces per-render addEventListener)
    this._setupEventDelegation();

    // Page Visibility API: pause polling when tab is hidden to save resources/battery
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Pause conflict and resource polling
        if (this._conflictCheckInterval) {
          clearInterval(this._conflictCheckInterval);
          this._conflictCheckPaused = true;
        }
        if (this._resourcesInterval) {
          clearInterval(this._resourcesInterval);
          this._resourcesPaused = true;
        }
      } else {
        // Resume polling when tab becomes visible again
        if (this._conflictCheckPaused) {
          this._conflictCheckPaused = false;
          this._conflictCheckInterval = setInterval(() => this.checkForConflicts(), 60000);
          this.checkForConflicts(); // Immediate check on return
        }
        if (this._resourcesPaused && this.state.viewMode === 'resources') {
          this._resourcesPaused = false;
          this._resourcesInterval = setInterval(() => {
            if (this.state.viewMode === 'resources') this.fetchResources();
          }, 10000);
          this.fetchResources(); // Immediate refresh on return
        }
      }
    });
  }

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

      const newTaskBtn = e.target.closest('.ws-new-task-btn');
      if (newTaskBtn) { e.stopPropagation(); this.openNewTaskDialog(newTaskBtn.dataset.wsId); return; }

      const moreBtn = e.target.closest('.ws-more-btn');
      if (moreBtn) {
        e.stopPropagation();
        const wsId = moreBtn.dataset.id;
        const rect = moreBtn.getBoundingClientRect();
        this._renderContextItems('Workspace', [
          { icon: '✏️', label: 'Rename', action: () => this.renameWorkspace(wsId) },
          { icon: '🗑️', label: 'Delete', danger: true, action: () => this.deleteWorkspace(wsId) },
        ], rect.right, rect.bottom);
        return;
      }

      // Pip click — navigate to that instance (handled BEFORE session-item click).
      const pip = e.target.closest('.instance-indicator');
      if (pip && pip.dataset.tabId) {
        e.stopPropagation();
        this._navigateToInstance(pip.dataset.tabId, parseInt(pip.dataset.slot, 10));
        return;
      }

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
        // Toggle: if body is currently visible, hide it (and vice versa)
        const isNowHidden = !body.hidden;
        body.hidden = isNowHidden;
        chevron.classList.toggle('open', !isNowHidden);
        const st = JSON.parse(localStorage.getItem('cwm_projectGroupState') || '{}');
        st[key] = !isNowHidden; // true = expanded, false = collapsed
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

      // Plan 22-05: intercept × clicks on the group chip BEFORE the
      // workspace-item activation. Otherwise clicking × would also fire
      // the row click and toggle the accordion.
      const removeFromGroupBtn = e.target.closest('[data-action="remove-from-group"]');
      if (removeFromGroupBtn) {
        e.stopPropagation();
        e.preventDefault();
        const wsId = removeFromGroupBtn.dataset.workspaceId;
        if (wsId) this.removeWorkspaceFromGroup(wsId);
        return;
      }

      const workspaceItem = e.target.closest('.workspace-item');
      if (workspaceItem) {
        const wsId = workspaceItem.dataset.id;
        const isAlreadyActive = this.state.activeWorkspace && this.state.activeWorkspace.id === wsId;
        if (isAlreadyActive) {
          // Toggle the active workspace accordion and persist the state
          const accordion = workspaceItem.closest('.workspace-accordion');
          if (accordion) {
            const body = accordion.querySelector('.workspace-accordion-body');
            const chevron = workspaceItem.querySelector('.ws-chevron');
            if (body) body.hidden = !body.hidden;
            if (chevron) chevron.classList.toggle('open', body && !body.hidden);
            // Persist so re-renders don't re-open it
            if (!this._wsCollapseState) this._wsCollapseState = {};
            this._wsCollapseState[wsId] = body ? body.hidden : false;
            try { localStorage.setItem('cwm_wsCollapseState', JSON.stringify(this._wsCollapseState)); } catch (_) {}
          }
        } else {
          wsList.querySelectorAll('.workspace-accordion-body').forEach(b => b.hidden = true);
          wsList.querySelectorAll('.ws-chevron').forEach(c => c.classList.remove('open'));
          // Clear collapse state for newly selected workspace so it opens
          if (!this._wsCollapseState) this._wsCollapseState = {};
          delete this._wsCollapseState[wsId];
          try { localStorage.setItem('cwm_wsCollapseState', JSON.stringify(this._wsCollapseState)); } catch (_) {}
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
        const parts = dir.replace(/\\/g, '/').split('/');
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
            const projectName = ps.projectPath ? (ps.projectPath.split('\\').pop() || ps.projectPath.split('/').pop() || claudeSessionId) : claudeSessionId;
            const shortId = claudeSessionId.length > 8 ? claudeSessionId.substring(0, 8) : claudeSessionId;
            const friendlyName = projectName + ' (' + shortId + ')';
            // Phase 18-04 (UI-10): forward the provider tag from the drag
            // payload so the new session record retains provider identity.
            const psProvider = ps.provider || 'claude'; // gsd:provider-literal-allowed (Phase 18 drag-drop default; v1.1-shaped data lacks provider)
            await this.api('POST', '/api/sessions', {
              name: friendlyName, workspaceId: targetWsId, workingDir: ps.projectPath,
              topic: 'Resumed session', command: 'claude', resumeSessionId: claudeSessionId, provider: psProvider, // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
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
        // Project drop (create session from entire project)
        const projectJson = e.dataTransfer.getData('cwm/project');
        if (projectJson) {
          e.preventDefault(); e.stopPropagation();
          try {
            const project = JSON.parse(projectJson);
            // Phase 18-04 (UI-10): forward the provider tag from the drag payload.
            const projProvider = project.provider || 'claude'; // gsd:provider-literal-allowed (Phase 18 drag-drop default; v1.1-shaped data lacks provider)
            await this.api('POST', '/api/sessions', {
              name: project.name, workspaceId: targetWsId, workingDir: project.path,
              topic: '', command: 'claude', provider: projProvider, // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
            });
            this.showToast(`Session "${project.name}" created`, 'success');
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
          // Forward provider from data-provider so Codex sessions resume
          // through `codex resume <id>` instead of `claude resume <id>`.
          // Bug fix v1.2.0-alpha.5: previously hardcoded to claude here.
          const itemProvider = sessionItem.dataset.provider || 'claude'; /* gsd:provider-literal-allowed (back-compat default) */
          this.showProjectSessionContextMenu(sessionItem.dataset.sessionName, sessionItem.dataset.projectPath, e.clientX, e.clientY, itemProvider);
          return;
        }
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          e.preventDefault(); e.stopPropagation();
          const accordion = header.closest('.project-accordion');
          // Forward the project's provider so "New Session Here" spawns the
          // right CLI (was always Claude before — see showProjectContextMenu).
          const accProvider = (accordion && accordion.dataset.provider) || 'claude'; /* gsd:provider-literal-allowed (back-compat default) */
          this.showProjectContextMenu(accordion.dataset.encoded, header.querySelector('.project-name').textContent, accordion.dataset.path, e.clientX, e.clientY, accProvider);
        }
      });

      projList.addEventListener('dragstart', (e) => {
        const sessionItem = e.target.closest('.project-session-item');
        if (sessionItem) {
          e.stopPropagation();
          const nameEl = sessionItem.querySelector('.project-session-name');
          // Phase 18-04 (UI-10): forward the provider id from the dragged
          // element's data-provider attribute (set by Plan 18-01) so drops
          // preserve provider identity end-to-end. v1.1-shaped data lacks
          // the field; default to the back-compat value.
          const dragProvider = sessionItem.dataset.provider || 'claude'; /* gsd:provider-literal-allowed */
          e.dataTransfer.setData('cwm/project-session', JSON.stringify({
            sessionName: sessionItem.dataset.sessionName,
            projectPath: sessionItem.dataset.projectPath,
            projectEncoded: sessionItem.dataset.projectEncoded,
            displayName: nameEl ? nameEl.textContent : '',
            provider: dragProvider,
          }));
          e.dataTransfer.effectAllowed = 'copy';
          sessionItem.classList.add('dragging');
          return;
        }
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          const accordion = header.closest('.project-accordion');
          // Phase 18-04 (UI-10): same provider propagation, sourced from
          // the parent .project-accordion's data-provider attribute.
          const accordionProvider = (accordion && accordion.dataset.provider) || 'claude'; /* gsd:provider-literal-allowed */
          e.dataTransfer.setData('cwm/project', JSON.stringify({
            encoded: accordion.dataset.encoded,
            path: accordion.dataset.path,
            name: header.querySelector('.project-name').textContent,
            provider: accordionProvider,
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
            if (touch) {
              const itemProvider = sessionItem.dataset.provider || 'claude'; /* gsd:provider-literal-allowed (back-compat default) */
              this.showProjectSessionContextMenu(sessionItem.dataset.sessionName, sessionItem.dataset.projectPath, touch.clientX, touch.clientY, itemProvider);
            }
          }, 500);
          return;
        }
        const header = e.target.closest('.project-accordion-header');
        if (header) {
          projLPTimer = setTimeout(() => {
            const touch = e.touches[0];
            if (touch) {
              const accordion = header.closest('.project-accordion');
              const accProvider = (accordion && accordion.dataset.provider) || 'claude'; /* gsd:provider-literal-allowed (back-compat default, mirrors mouse contextmenu) */
              this.showProjectContextMenu(accordion.dataset.encoded, header.querySelector('.project-name').textContent, accordion.dataset.path, touch.clientX, touch.clientY, accProvider);
            }
          }, 500);
        }
      }, { passive: false });
      projList.addEventListener('touchend', () => clearTimeout(projLPTimer));
      projList.addEventListener('touchmove', () => clearTimeout(projLPTimer));
    }
  }



  async _initializeApp() {
    this.showApp();
    this.initDragAndDrop();
    this.initTerminalResize();
    // Plan 19-02 (PTY-04, PTY-05): build window.CWMProviderSpecs BEFORE
    // restoring terminal panes. TerminalPane.mount() reads its provider
    // spec at mount time; if the spec map is missing, idle dispatch and
    // Shift+Enter fall back to the defensive Claude defaults baked into
    // terminal.js. Fetching before initTerminalGroups means real specs are
    // available for both Claude and Codex panes on first paint.
    await this.fetchProviderSpecs();
    // Terminal group restore spawns PTY sessions and can be slow.
    // Run it in the background so login resolves immediately.
    this.initTerminalGroups().catch(e => console.error('Terminal groups init:', e));
    this.initTerminalPaneSwipe();
    this.initNotesEditor();
    this.initAIInsights();
    this.initPairMobile();
    await this.loadAll();
    this.connectSSE();
    this.startConflictChecks();
    this.checkForUpdates();
    this.startSchedulePolling();
  }

  async init() {
    // Restore sidebar width & collapse state from localStorage
    this.restoreSidebarState();

    // Auto-login via URL ?token=xxx parameter (one-time startup token)
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      // Always strip token from URL to avoid leaking in browser history/referrer
      window.history.replaceState({}, '', window.location.pathname);
      try {
        await this.tokenLogin(urlToken);
        return; // tokenLogin() handles showApp/loadAll/connectSSE
      } catch {
        // Fall through to normal login form
      }
    }

    if (this.state.token) {
      const valid = await this.checkAuth();
      if (valid) {
        await this._initializeApp();
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
        await this._initializeApp();
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

  async tokenLogin(startupToken) {
    const data = await this.api('POST', '/api/auth/token-login', { token: startupToken });
    if (data.success && data.token) {
      this.state.token = data.token;
      localStorage.setItem('cwm_token', data.token);
      await this._initializeApp();
    } else {
      throw new Error(data.error || 'Token login failed');
    }
  }

  async logout() {
    try {
      await this.api('POST', '/api/auth/logout');
    } catch {
      // ignore - we clear locally regardless
    }
    this.state.token = null;
    localStorage.removeItem('cwm_token');
    // Clean up conflict check interval to prevent background polling after logout
    if (this._conflictCheckInterval) {
      clearInterval(this._conflictCheckInterval);
      this._conflictCheckInterval = null;
    }
    // Clean up SSE retry timeout to prevent reconnection attempts after logout
    if (this.sseRetryTimeout) {
      clearTimeout(this.sseRetryTimeout);
      this.sseRetryTimeout = null;
    }
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
    if (savedViewMode && ['workspace', 'all', 'costs', 'recent', 'terminal', 'docs', 'resources'].includes(savedViewMode)) {
      this.state.viewMode = savedViewMode;
    }
    // Always apply the current view mode (handles default 'terminal' for new users)
    this.setViewMode(this.state.viewMode);

    await Promise.all([
      this.loadWorkspaces(),
      this.loadStats(),
      this.loadGroups(),
      this.loadProjects(),
      // Phase 18-02: load provider registry so the sidebar tab strip is
      // populated on initial paint. Fails gracefully (warn-only) so a stale
      // server does not block the rest of the UI.
      this.loadProviders(),
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

    // Apply settings (CSS classes, visibility) after initial data is loaded
    this.applySettings();
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
      this.showToast('Failed to load projects', 'error');
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
        // 'all' mode - reuse the full list we already fetched
        this.state.sessions = this.state.allSessions;
      }

      // Clear stale selectedSession if it no longer exists in the loaded session list
      // (e.g. deleted by another client or via SSE session:deleted event)
      if (this.state.selectedSession) {
        const stillExists = this.state.sessions.some(s => s.id === this.state.selectedSession.id)
          || (this.state.allSessions && this.state.allSessions.some(s => s.id === this.state.selectedSession.id));
        if (!stillExists) {
          this.state.selectedSession = null;
          this.renderSessionDetail();
        }
      }

      this.renderSessions();
      // Re-render workspace accordion to update session sub-items
      this.renderWorkspaces();

      // Fetch worktree task data for tri-state dot rendering (best-effort)
      if (this.state.settings.enableWorktreeTasks) {
        try {
          const wtData = await this.api('GET', '/api/worktree-tasks');
          this._worktreeTaskCache = wtData.tasks || [];
        } catch (_) { /* non-critical */ }
      }
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

    // If the tasks tab is open, refresh whichever sub-tab is active for the new workspace
    if (this.state.viewMode === 'tasks' && this._activeTasksTab) {
      // Reset git selection so the right pane doesn't show stale data from old workspace
      this._selectedGitCommit = null;
      this._selectedGitFile = null;
      // Force files panel to re-init for the new workspace
      const filesPanel = document.getElementById('tasks-files-panel');
      if (filesPanel) delete filesPanel._wsId;
      // Re-render the active tab
      const tab = this._activeTasksTab;
      if (tab === 'worktree') this.renderTasksView();
      else if (tab === 'td') this.renderTasksTdPanel();
      else if (tab === 'git') this.renderTasksGitPanel();
      else if (tab === 'files') this.renderTasksFilesPanel();
    }

    // Close mobile sidebar
    if (this.state.sidebarOpen) this.toggleSidebar();
  }

  async createWorkspace() {
    const result = await this.showPromptModal({
      title: 'New Project',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'my-project', required: true },
        { key: 'description', label: 'Description', placeholder: 'What is this project for?', type: 'textarea' },
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'icon', label: 'Icon', type: 'icon' },
      ],
      confirmText: 'Create',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      await this.api('POST', '/api/workspaces', result);
      this.showToast('Project created', 'success');
      await this.loadWorkspaces();
      await this.loadStats();
    } catch (err) {
      this.showToast(err.message || 'Failed to create project', 'error');
    }
  }

  async renameWorkspace(id) {
    const ws = this.state.workspaces.find(w => w.id === id);
    if (!ws) return;

    const result = await this.showPromptModal({
      title: 'Edit Project',
      fields: [
        { key: 'name', label: 'Name', value: ws.name, required: true },
        { key: 'description', label: 'Description', value: ws.description || '', type: 'textarea' },
        { key: 'color', label: 'Color', type: 'color', value: ws.color },
        { key: 'icon', label: 'Icon', type: 'icon', value: ws.icon || '' },
      ],
      confirmText: 'Save',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      await this.api('PUT', `/api/workspaces/${id}`, result);
      this.showToast('Project updated', 'success');
      await this.loadWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to update project', 'error');
    }
  }

  async deleteWorkspace(id) {
    const ws = this.state.workspaces.find(w => w.id === id);
    if (!ws) return;

    const confirmed = await this.showConfirmModal({
      title: 'Delete Project',
      message: `Are you sure you want to delete <strong>${this.escapeHtml(ws.name)}</strong>? This will remove the project and unlink all its sessions.`,
      confirmText: 'Delete',
      confirmClass: 'btn-danger',
    });

    if (!confirmed) return;

    try {
      await this.api('DELETE', `/api/workspaces/${id}`);
      this.showToast('Project deleted', 'success');
      if (this.state.activeWorkspace && this.state.activeWorkspace.id === id) {
        this.state.activeWorkspace = null;
      }
      await this.loadWorkspaces();
      await this.loadSessions();
      await this.loadStats();
    } catch (err) {
      this.showToast(err.message || 'Failed to delete project', 'error');
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

    // If in a view mode that hides the detail panel, switch to a compatible mode
    const hiddenModes = ['terminal', 'docs', 'resources', 'costs'];
    if (session && hiddenModes.includes(this.state.viewMode)) {
      // Switch to workspace view if a workspace is active, otherwise 'recent'
      const targetMode = this.state.activeWorkspace ? 'workspace' : 'recent';
      this.setViewMode(targetMode);
    }

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
    // Load templates for quick-launch chips
    let templates = [];
    try {
      const tData = await this.api('GET', '/api/templates');
      templates = tData.templates || tData || [];
    } catch (_) {}

    const fields = [
      { key: 'name', label: 'Name', placeholder: 'feature-auth', required: true },
      { key: 'topic', label: 'Topic', placeholder: 'Working on authentication flow' },
      { key: 'workingDir', label: 'Working Directory', placeholder: '~/projects/my-app' },
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
        label: 'Project',
        type: 'select',
        options: this.state.workspaces.map(w => ({ value: w.id, label: w.name })),
        required: true,
      });
    }

    const resultPromise = this.showPromptModal({
      title: 'New Session',
      fields,
      confirmText: 'Create',
      confirmClass: 'btn-primary',
      // Show template chips above the form if templates exist
      headerHtml: templates.length > 0 ? `
        <div class="template-list">${templates.map(t => `
          <button class="template-chip" data-template-id="${t.id}" title="${this.escapeHtml(t.workingDir || '')}${t.model ? ' &middot; ' + this.escapeHtml(t.model) : ''}${t.bypassPermissions ? ' &middot; bypass' : ''}">
            <span class="template-chip-icon">&#9889;</span>${this.escapeHtml(t.name)}
          </button>`).join('')}
        </div>` : '',
      onHeaderClick: (e) => {
        const chip = e.target.closest('.template-chip');
        if (!chip) return;
        const tpl = templates.find(t => t.id === chip.dataset.templateId);
        if (!tpl) return;
        // Fill form fields from template
        const nameInput = document.getElementById('modal-field-name');
        const dirInput = document.getElementById('modal-field-workingDir');
        const cmdInput = document.getElementById('modal-field-command');
        if (nameInput && !nameInput.value) nameInput.value = tpl.name;
        if (dirInput && tpl.workingDir) dirInput.value = tpl.workingDir;
        if (cmdInput && tpl.command && tpl.command !== 'claude') cmdInput.value = tpl.command; // gsd:provider-literal-allowed (template default-equality check; refactor deferred to Phase 18)
        this.showToast(`Template "${tpl.name}" applied`, 'success');
      },
    });
    // Inject browse button next to Working Directory field after modal renders
    requestAnimationFrame(() => this._injectBrowseButton('modal-field-workingDir'));
    const result = await resultPromise;

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

  async saveSessionAsTemplate(session) {
    const result = await this.showPromptModal({
      title: 'Save as Template',
      fields: [
        { key: 'name', label: 'Template Name', placeholder: session.name || 'My Template', required: true, value: session.name || '' },
      ],
      confirmText: 'Save',
      confirmClass: 'btn-primary',
    });
    if (!result) return;

    try {
      await this.api('POST', '/api/templates', {
        name: result.name,
        command: session.command || 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
        workingDir: session.workingDir || '',
        bypassPermissions: !!session.bypassPermissions,
        verbose: !!session.verbose,
        model: session.model || null,
        agentTeams: !!session.agentTeams,
      });
      this.showToast(`Template "${result.name}" saved`, 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to save template', 'error');
    }
  }

  /**
   * Quick-create a new session in a specific directory and open it in a terminal pane.
   * Used by right-click on project directory headers in workspace sidebar.
   */
  async createSessionInDir(workspaceId, dir, flags = {}) {
    const dirParts = dir.replace(/\\/g, '/').split('/');
    const name = dirParts[dirParts.length - 1] || 'new-session';
    try {
      const payload = {
        name: `${name} - new`,
        workspaceId,
        workingDir: dir,
        command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
      };
      if (flags.bypassPermissions) payload.bypassPermissions = true;
      const data = await this.api('POST', '/api/sessions', payload);
      const session = data.session || data;
      this.showToast(`Session created in ${name}`, 'success');
      await this.loadSessions();
      // Auto-open in first empty terminal pane
      const emptySlot = this.terminalPanes.findIndex(p => p === null);
      if (emptySlot !== -1) {
        this.setViewMode('terminal');
        const spawnOpts = { cwd: dir, newSession: true };
        if (flags.bypassPermissions) spawnOpts.bypassPermissions = true;
        this.openTerminalInPane(emptySlot, session.id, session.name, spawnOpts);
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to create session', 'error');
    }
  }

  async renameSession(id) {
    const session = this.state.sessions.find(s => s.id === id)
      || (this.state.allSessions && this.state.allSessions.find(s => s.id === id))
      || null;
    if (!session) return;

    const resultPromise = this.showPromptModal({
      title: 'Edit Session',
      fields: [
        { key: 'name', label: 'Name', value: session.name, required: true },
        { key: 'topic', label: 'Topic', value: session.topic || '' },
        { key: 'workingDir', label: 'Working Directory', value: session.workingDir || '' },
      ],
      confirmText: 'Save',
      confirmClass: 'btn-primary',
    });
    // Inject browse button next to Working Directory field after modal renders
    requestAnimationFrame(() => this._injectBrowseButton('modal-field-workingDir'));
    const result = await resultPromise;

    if (!result) return;

    try {
      const data = await this.api('PUT', `/api/sessions/${id}`, result);
      const updated = data.session || data;
      // Sync title to project sessions if this session links to a Claude UUID
      const claudeId = (updated && updated.resumeSessionId) || (session && session.resumeSessionId);
      if (claudeId && result.name) this.syncSessionTitle(claudeId, result.name);
      this.showToast('Session updated', 'success');
      await this.loadSessions();
      this.renderProjects();
      if (this.state.selectedSession && this.state.selectedSession.id === id) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
      // Sync terminal pane titles — if this session is open in a terminal,
      // update the TerminalPane instance and the DOM tab header.
      if (result.name) {
        for (let i = 0; i < this.terminalPanes.length; i++) {
          const tp = this.terminalPanes[i];
          if (tp && tp.sessionId === id) {
            tp.sessionName = result.name;
            const paneEl = document.getElementById(`term-pane-${i}`);
            const titleEl = paneEl && paneEl.querySelector('.terminal-pane-title');
            if (titleEl) titleEl.textContent = result.name;
          }
        }
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to update session', 'error');
    }
  }

  async deleteSession(id) {
    const session = this.state.sessions.find(s => s.id === id)
      || (this.state.allSessions && this.state.allSessions.find(s => s.id === id))
      || null;
    if (!session) return;

    // Hide session - never delete. Persisted in localStorage.
    this.state.hiddenSessions.add(id);
    localStorage.setItem('cwm_hiddenSessions', JSON.stringify([...this.state.hiddenSessions]));

    if (this.state.selectedSession && this.state.selectedSession.id === id) {
      this.deselectSession();
    }
    this.renderWorkspaces();
    this.renderSessions();
    this.showToast(`Hidden "${session.name}" - toggle "Show hidden" to see it again`, 'info');
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
      message: `Remove "${session.name}" from this project? This deletes the session record (your Claude conversation files are not affected).`,
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

  /**
   * Hide a workspace from the sidebar. Persisted in localStorage.
   * @param {string} workspaceId - The workspace ID to hide
   */
  hideWorkspace(workspaceId) {
    const ws = this.state.workspaces.find(w => w.id === workspaceId);
    this.state.hiddenWorkspaces.add(workspaceId);
    localStorage.setItem('cwm_hiddenWorkspaces', JSON.stringify([...this.state.hiddenWorkspaces]));
    this.renderWorkspaces();
    this.renderSessions();
    this.showToast(`Hidden "${ws ? ws.name : 'project'}" - manage in Settings > Hidden Items`, 'info');
  }

  /**
   * Unhide a workspace, making it visible in the sidebar again.
   * @param {string} workspaceId - The workspace ID to unhide
   */
  unhideWorkspace(workspaceId) {
    this.state.hiddenWorkspaces.delete(workspaceId);
    localStorage.setItem('cwm_hiddenWorkspaces', JSON.stringify([...this.state.hiddenWorkspaces]));
    this.renderWorkspaces();
    this.renderSessions();
  }

  /**
   * Hide a category (group) from the sidebar. Persisted in localStorage.
   * @param {string} groupId - The group ID to hide
   */
  hideGroup(groupId) {
    const group = (this.state.groups || []).find(g => g.id === groupId);
    this.state.hiddenGroups.add(groupId);
    localStorage.setItem('cwm_hiddenGroups', JSON.stringify([...this.state.hiddenGroups]));
    this.renderWorkspaces();
    this.showToast(`Hidden category "${group ? group.name : ''}" - manage in Settings > Hidden Items`, 'info');
  }

  /**
   * Unhide a category (group), making it visible in the sidebar again.
   * @param {string} groupId - The group ID to unhide
   */
  unhideGroup(groupId) {
    this.state.hiddenGroups.delete(groupId);
    localStorage.setItem('cwm_hiddenGroups', JSON.stringify([...this.state.hiddenGroups]));
    this.renderWorkspaces();
  }

  toggleShowHidden() {
    this.state.showHidden = !this.state.showHidden;
    if (this.els.toggleHiddenBtn) this.els.toggleHiddenBtn.classList.toggle('active', this.state.showHidden);
    if (this.els.toggleHiddenLabel) this.els.toggleHiddenLabel.textContent = this.state.showHidden ? 'Hide hidden' : 'Show hidden';
    this.renderWorkspaces();
    this.renderSessions();
    this.renderProjects();
  }

  /**
   * Build a flat list of all currently hidden items for the settings panel.
   * Returns array of { type, name, id } objects.
   * @returns {Array<{type: string, name: string, id: string}>}
   */
  _getHiddenItemsList() {
    const items = [];

    // Hidden categories (groups)
    for (const groupId of this.state.hiddenGroups) {
      const group = (this.state.groups || []).find(g => g.id === groupId);
      items.push({ type: 'category', name: group ? group.name : groupId, id: groupId });
    }

    // Hidden workspaces (projects)
    for (const wsId of this.state.hiddenWorkspaces) {
      const ws = this.state.workspaces.find(w => w.id === wsId);
      items.push({ type: 'project', name: ws ? ws.name : wsId, id: wsId });
    }

    // Hidden sessions
    for (const sessionId of this.state.hiddenSessions) {
      const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
      items.push({ type: 'session', name: session ? session.name : sessionId, id: sessionId });
    }

    // Hidden project folders (discovered projects)
    for (const encoded of this.state.hiddenProjects) {
      // Decode the encoded project name for display
      const decoded = decodeURIComponent(encoded).replace(/\+/g, '/');
      items.push({ type: 'folder', name: decoded, id: encoded });
    }

    // Hidden project sessions (by name)
    for (const name of this.state.hiddenProjectSessions) {
      items.push({ type: 'file', name: name, id: name });
    }

    return items;
  }

  /**
   * Unhide a single item by type and ID. Called from the settings panel.
   * @param {string} type - Item type: category, project, session, folder, file
   * @param {string} id - The item identifier
   */
  _unhideItem(type, id) {
    switch (type) {
      case 'category':
        this.unhideGroup(id);
        break;
      case 'project':
        this.unhideWorkspace(id);
        break;
      case 'session':
        this.unhideSession(id);
        break;
      case 'folder':
        this.state.hiddenProjects.delete(id);
        localStorage.setItem('cwm_hiddenProjects', JSON.stringify([...this.state.hiddenProjects]));
        this.renderProjects();
        break;
      case 'file':
        this.state.hiddenProjectSessions.delete(id);
        localStorage.setItem('cwm_hiddenProjectSessions', JSON.stringify([...this.state.hiddenProjectSessions]));
        this.renderProjects();
        break;
    }
    this.showToast('Item unhidden', 'success');
  }

  /**
   * Unhide all hidden items at once. Clears all hidden sets.
   */
  _unhideAllItems() {
    this.state.hiddenGroups.clear();
    this.state.hiddenWorkspaces.clear();
    this.state.hiddenSessions.clear();
    this.state.hiddenProjects.clear();
    this.state.hiddenProjectSessions.clear();
    localStorage.setItem('cwm_hiddenGroups', '[]');
    localStorage.setItem('cwm_hiddenWorkspaces', '[]');
    localStorage.setItem('cwm_hiddenSessions', '[]');
    localStorage.setItem('cwm_hiddenProjects', '[]');
    localStorage.setItem('cwm_hiddenProjectSessions', '[]');
    this.renderWorkspaces();
    this.renderSessions();
    this.renderProjects();
    this.showToast('All items unhidden', 'success');
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

  /**
   * Build the shared session management context menu items.
   * Used by both the sidebar context menu and the terminal pane context menu
   * so that all session actions are available from either location.
   * @param {string} sessionId - The session to build items for
   * @returns {Array|null} Array of menu items, or null if session not found
   */
  _buildSessionContextItems(sessionId, tp = null) {
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    if (!session) {
      // Plan 22-04: ad-hoc fallback. Some panes (Codex Desktop sessions
      // opened via right-click, drag-dropped Claude sessions, etc.) have no
      // Myrlin store record. Build a reduced item list using the pane's
      // spawnOpts so the right-click is still useful. Items that require
      // server-side state we don't have (Start/Stop/Restart by id, Tags,
      // Spinoff Tasks, Move-to-workspace) are skipped on purpose.
      if (!tp) return null;
      return this._buildAdHocSessionContextItems(sessionId, tp);
    }

    const isRunning = session.status === 'running' || session.status === 'idle';
    const isBypassed = !!session.bypassPermissions;
    const isVerbose = !!session.verbose;
    const currentModel = session.model || null;

    const modelOptions = [
      { id: 'opus',        label: 'Opus' },
      { id: 'sonnet',      label: 'Sonnet' },
      { id: 'haiku',       label: 'Haiku' },
      { id: 'sonnet[1m]',  label: 'Sonnet 1M' },
      { id: 'opusplan',    label: 'OpusPlan' },
    ];

    const items = [];

    // Start / Stop / Restart
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

    // Model selection (submenu)
    const modelSubs = modelOptions.map(m => ({
      label: m.label,
      action: () => this.setSessionModel(sessionId, m.id),
      check: currentModel === m.id,
    }));
    if (currentModel) {
      modelSubs.push({ label: 'Default', action: () => this.setSessionModel(sessionId, null), check: !currentModel });
    }
    const currentModelLabel = currentModel ? (modelOptions.find(m => m.id === currentModel)?.label || 'Custom') : 'Default';
    items.push({ label: 'Model', icon: '&#9881;', hint: currentModelLabel, submenu: modelSubs });

    items.push({ type: 'sep' });

    // Flags / Permissions (submenu)
    const isAgentTeams = !!session.agentTeams;
    const activeFlags = [isBypassed && 'Bypass', isVerbose && 'Verbose', isAgentTeams && 'Teams'].filter(Boolean);
    const flagsHint = activeFlags.length ? activeFlags.join(', ') : 'None';
    items.push({
      label: 'Flags / Permissions', icon: '&#9873;', hint: flagsHint,
      submenu: [
        { label: 'Bypass Permissions', action: () => this.toggleBypass(sessionId), check: isBypassed, danger: isBypassed },
        { label: 'Verbose', action: () => this.toggleVerbose(sessionId), check: isVerbose },
        { label: 'Agent Teams', action: () => this.toggleAgentTeams(sessionId), check: isAgentTeams },
      ],
    });

    items.push({ type: 'sep' });

    // Naming submenu — rename and auto-title grouped together
    items.push({
      label: 'Naming', icon: '&#9998;',
      submenu: [
        { label: 'Rename', action: () => this.renameSession(sessionId) },
        { label: 'Auto Title', action: () => this.autoTitleSession(sessionId) },
      ],
    });

    // Tags
    const sessionTags = session.tags || [];
    items.push({
      label: 'Tags...',
      icon: '&#127991;',
      hint: sessionTags.length > 0 ? sessionTags.join(', ') : 'none',
      action: async () => {
        const current = sessionTags.join(', ');
        const result = prompt('Tags (comma-separated):', current);
        if (result === null) return;
        const newTags = result.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        try {
          await this.api('PUT', `/api/sessions/${sessionId}`, { tags: newTags });
          this.showToast('Tags updated', 'success');
          await this.loadSessions();
        } catch (err) {
          this.showToast(err.message || 'Failed to update tags', 'error');
        }
      }
    });

    // Insights submenu — session analysis and export
    items.push({
      label: 'Insights', icon: '&#128220;',
      submenu: [
        { label: 'Summarize', action: () => this.summarizeSession(sessionId) },
        { label: 'Summarize to Docs', action: () => this.summarizeSessionToDocs(sessionId) },
        { label: 'Export Context', action: () => this.exportSessionContext(sessionId) },
        { label: 'Copy Session ID', action: () => {
          navigator.clipboard.writeText(session.resumeSessionId || session.id);
          this.showToast('Session ID copied', 'success');
        }},
      ],
    });

    // Spinoff Tasks — AI-extract tasks from conversation and create worktree branches
    items.push({
      label: 'Spinoff Tasks', icon: '&#10547;',
      action: () => this.openSpinoffDialog(sessionId),
    });

    // Advanced submenu — templates, context, refocus, worktrees
    const advancedItems = [
      { label: 'Start with Context', action: () => this.startSessionWithContext(sessionId) },
      { label: 'Save as Template', action: () => this.saveSessionAsTemplate(session) },
      { label: 'Reset & Refocus', action: () => this.refocusSession(sessionId, 'reset') },
      { label: 'Compact & Refocus', action: () => this.refocusSession(sessionId, 'compact') },
    ];
    if (session.workingDir) {
      advancedItems.push({ label: 'View Worktrees', action: () => this.showWorktreeList(session.workingDir) });
    }
    items.push({ label: 'Advanced', icon: '&#9881;', submenu: advancedItems });

    // Move to another workspace (submenu)
    const otherWorkspaces = this.state.workspaces.filter(w => w.id !== session.workspaceId);
    if (otherWorkspaces.length > 0) {
      items.push({
        label: 'Move to', icon: '&#8594;',
        submenu: otherWorkspaces.slice(0, 8).map(ws => ({
          label: ws.name.length > 24 ? ws.name.substring(0, 24) + '...' : ws.name,
          action: () => this.moveSessionToWorkspace(sessionId, ws.id),
        })),
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
    items.push({ label: 'Remove from Project', icon: '&#10005;', danger: true, action: () => this.removeSessionFromWorkspace(sessionId) });

    return items;
  }

  /**
   * Build a reduced item list for an ad-hoc pane (no Myrlin store record).
   *
   * Plan 22-04: right-click on a Codex Desktop pane opened via "Open in
   * Terminal" used to show almost nothing because _buildSessionContextItems
   * bailed early when no store record existed. This factory returns the
   * universal subset that works without server-side state: naming
   * affordances, insights (copy ID, copy path, summarize), an "Add to
   * active workspace" adopter, and Open in File Manager. Provider-specific
   * settings (Codex's model/sandbox/etc.) live in _buildCodexPaneMenu and
   * are added separately by the pane right-click dispatcher.
   *
   * @param {string} sessionId - Upstream CLI session UUID (Codex rollout
   *   id, Claude session id, etc.).
   * @param {Object} tp - TerminalPane instance for the pane.
   * @returns {Array<Object>} Menu items in the standard {label, icon,
   *   action, submenu?} shape used by _renderContextItems.
   */
  _buildAdHocSessionContextItems(sessionId, tp) {
    const items = [];
    const provider = (tp.spawnOpts && tp.spawnOpts.provider) || 'claude'; // gsd:provider-literal-allowed (back-compat default)
    const cwd = (tp.spawnOpts && tp.spawnOpts.cwd) || null;
    const slotIdx = this.terminalPanes.findIndex(p => p === tp);

    items.push({
      label: 'Naming', icon: '&#9998;',
      submenu: [
        { label: 'Rename Pane', action: () => {
          if (slotIdx < 0) return;
          const titleEl = document.querySelector('#term-pane-' + slotIdx + ' .terminal-pane-title');
          if (titleEl) this.startTerminalPaneRename(titleEl, slotIdx, sessionId, false);
        }},
        { label: 'Auto Title', action: () => this.autoTitleProjectSession(sessionId) },
      ],
    });

    const insightsItems = [
      { label: 'Summarize', action: () => this.summarizeSession(sessionId, sessionId) },
      { label: 'Copy Session ID', action: () => {
        navigator.clipboard.writeText(sessionId);
        this.showToast('Session ID copied', 'success');
      }},
    ];
    if (cwd) {
      insightsItems.push({ label: 'Copy Path', action: () => {
        navigator.clipboard.writeText(cwd);
        this.showToast('Path copied', 'success');
      }});
    }
    items.push({ label: 'Insights', icon: '&#128220;', submenu: insightsItems });

    if (this.state.activeWorkspace) {
      items.push({
        label: 'Add to ' + this.state.activeWorkspace.name, icon: '&#43;', action: async () => {
          const cliBinary = this.getProviderCliBinary(provider);
          const customTitle = this.getProjectSessionTitle(sessionId);
          let friendlyName = customTitle;
          if (!friendlyName) {
            const folder = cwd ? (cwd.split(/[\\/]/).pop() || sessionId) : sessionId;
            const shortId = sessionId.length > 8 ? sessionId.substring(0, 8) : sessionId;
            friendlyName = folder + ' (' + shortId + ')';
          }
          try {
            await this.api('POST', '/api/sessions', {
              name: friendlyName,
              workspaceId: this.state.activeWorkspace.id,
              workingDir: cwd || '',
              topic: 'Adopted from ad-hoc pane',
              command: cliBinary,
              provider,
              resumeSessionId: sessionId,
            });
            if (typeof this.loadSessions === 'function') await this.loadSessions();
            if (typeof this.renderWorkspaces === 'function') this.renderWorkspaces();
            this.showToast('Added to ' + this.state.activeWorkspace.name, 'success');
          } catch (err) {
            this.showToast(err.message || 'Failed to add', 'error');
          }
        },
      });
    }

    return items;
  }

  showContextMenu(sessionId, x, y) {
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    if (!session) return;

    const items = [];

    // Sidebar-specific: View details
    items.push({
      label: 'View Details', icon: '&#128269;', action: () => {
        this.selectSession(sessionId);
      },
    });

    // Sidebar-specific: Open in terminal
    items.push({
      label: 'Open in Terminal', icon: '&#9654;', action: () => {
        const emptySlot = this.terminalPanes.findIndex(p => p === null);
        if (emptySlot !== -1) {
          this.setViewMode('terminal');
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
          this.showToast('All terminal panes full. Close one first.', 'warning');
        }
      },
    });

    items.push({ type: 'sep' });

    // Shared session management items
    const sessionItems = this._buildSessionContextItems(sessionId);
    if (sessionItems) items.push(...sessionItems);

    this._renderContextItems(session.name, items, x, y);
  }

  hideContextMenu() {
    // Hide any open submenus first
    this.els.contextMenu.querySelectorAll('.ctx-submenu-visible').forEach(s => {
      s.classList.remove('ctx-submenu-visible');
    });
    this.els.contextMenu.hidden = true;
  }

  /**
   * Show a minimal context menu with developer utilities like "Inspect Element".
   * Appears when right-clicking areas without a specific context menu handler.
   */
  _showInspectContextMenu(targetEl, x, y) {
    const items = [
      {
        label: 'Inspect Element', icon: '&#128269;', action: () => {
          // Use Chrome DevTools inspect() when available (requires DevTools open)
          if (typeof inspect === 'function') {
            inspect(targetEl);
          } else {
            // Fallback: log element details to console and hint to open DevTools
            console.log('%c[Inspect]', 'color:#cba6f7;font-weight:bold', targetEl);
            console.log('  Tag:', targetEl.tagName, '| Classes:', targetEl.className);
            console.log('  Selector:', this._buildSelector(targetEl));
            this.showToast('Element logged to console (F12)', 'info');
          }
        },
      },
      {
        label: 'Copy Selector', icon: '&#128203;', action: () => {
          const selector = this._buildSelector(targetEl);
          navigator.clipboard.writeText(selector);
          this.showToast('Selector copied', 'success');
        },
      },
    ];
    this._renderContextItems('', items, x, y);
  }

  /** Build a CSS selector path for an element (for debugging) */
  _buildSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { sel += '#' + cur.id; parts.unshift(sel); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) sel += '.' + cls;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  showProjectSessionContextMenu(sessionName, projectPath, x, y, provider) {
    const items = [];
    // Bug fix v1.2.0-alpha.5: previously this function hardcoded the
    // Claude cliBinary so right-click "Open in Terminal" on a Codex Desktop
    // session spawned the wrong CLI and failed with "session id cannot be
    // found". Provider now flows from the data-provider attribute on the
    // session item through the contextmenu dispatcher.
    const resolvedProvider = provider || 'claude'; /* gsd:provider-literal-allowed (back-compat default) */
    const cliBinary = this.getProviderCliBinary(resolvedProvider);

    // Open in terminal - resume the session via the right provider's CLI.
    items.push({
      label: 'Open in Terminal', icon: '&#9654;', action: () => {
        const emptySlot = this.terminalPanes.findIndex(p => p === null);
        if (emptySlot === -1) {
          this.showToast('All terminal panes full. Close one first.', 'warning');
          return;
        }
        this.setViewMode('terminal');
        const title = this.getProjectSessionTitle(sessionName) || sessionName;
        this.openTerminalInPane(emptySlot, sessionName, title, {
          cwd: projectPath,
          resumeSessionId: sessionName,
          command: cliBinary,
          provider: resolvedProvider,
        });
      },
    });

    // Add to active workspace (without opening terminal)
    items.push({
      label: 'Add to Project', icon: '&#43;', action: () => {
        if (!this.state.activeWorkspace) {
          this.showToast('Select or create a project first', 'warning');
          return;
        }
        const customTitle = this.getProjectSessionTitle(sessionName);
        let friendlyName;
        if (customTitle) {
          friendlyName = customTitle;
        } else {
          const projectName = projectPath ? projectPath.split('\\').pop() || projectPath.split('/').pop() || sessionName : sessionName;
          const shortId = sessionName.length > 8 ? sessionName.substring(0, 8) : sessionName;
          friendlyName = projectName + ' (' + shortId + ')';
        }
        this.api('POST', '/api/sessions', {
          name: friendlyName,
          workspaceId: this.state.activeWorkspace.id,
          workingDir: projectPath,
          topic: 'Resumed session',
          command: cliBinary,
          provider: resolvedProvider,
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

    // Grouped: naming + insights
    items.push({
      label: 'Naming', icon: '&#9998;',
      submenu: [
        { label: 'Auto Title', action: () => this.autoTitleProjectSession(sessionName) },
      ],
    });
    items.push({
      label: 'Insights', icon: '&#128220;',
      submenu: [
        { label: 'Summarize', action: () => this.summarizeSession(sessionName, sessionName) },
        { label: 'Copy Session ID', action: () => {
          navigator.clipboard.writeText(sessionName);
          this.showToast('Session ID copied', 'success');
        }},
        { label: 'Copy Path', action: () => {
          navigator.clipboard.writeText(projectPath);
          this.showToast('Path copied', 'success');
        }},
      ],
    });
    items.push({
      label: 'Start with Context', icon: '&#128218;', action: () => this.startProjectWithContext(projectPath),
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

  showProjectContextMenu(encodedName, displayName, projectPath, x, y, projectProvider) {
    const items = [];
    const isHidden = this.state.hiddenProjects.has(encodedName);
    // The project accordion in the sidebar carries data-provider on the parent
    // element. The caller passes it through so the "New Session" menu items
    // below can spawn the right CLI for the folder (was previously hard-coded
    // to the Claude CLI, so right-clicking a Codex folder opened a Claude
    // session). Default falls back to the bootstrap provider when callers
    // pre-date this parameter or state.providers has not loaded yet.
    const resolvedProjectProvider = projectProvider || 'claude'; /* gsd:provider-literal-allowed (back-compat default for callers that don't pass) */

    // Hide/unhide entire project
    if (isHidden) {
      items.push({ label: 'Unhide Project', icon: '&#128065;', action: () => {
        this.state.hiddenProjects.delete(encodedName);
        localStorage.setItem('cwm_hiddenProjects', JSON.stringify([...this.state.hiddenProjects]));
        this.renderProjects();
        this.showToast(`"${displayName}" unhidden`, 'info');
      }});
    } else {
      items.push({ label: 'Hide Project', icon: '&#128065;', action: () => {
        this.state.hiddenProjects.add(encodedName);
        localStorage.setItem('cwm_hiddenProjects', JSON.stringify([...this.state.hiddenProjects]));
        this.renderProjects();
        this.showToast(`"${displayName}" hidden`, 'info');
      }});
    }

    items.push({ type: 'sep' });

    // Copy path
    if (projectPath) {
      items.push({ label: 'Copy Path', icon: '&#128193;', action: () => {
        navigator.clipboard.writeText(projectPath);
        this.showToast('Path copied', 'success');
      }});
    }

    // Copy encoded name
    items.push({ label: 'Copy Encoded Name', icon: '&#128203;', action: () => {
      navigator.clipboard.writeText(encodedName);
      this.showToast('Encoded name copied', 'success');
    }});

    if (projectPath) {
      items.push({ type: 'sep' });

      // Build provider-aware "New Session" items. Folder's native provider
      // appears first; any other enabled provider follows. This replaces the
      // pre-Phase-18 hard-coded command path that always opened a Claude
      // session regardless of the folder's provider, so right-clicking a
      // Codex folder used to start the wrong CLI.
      const enabled = (this.state.providers || []).filter(p => p && p.enabled);
      const ordered = enabled.length
        ? enabled.slice().sort((a, b) =>
            a.id === resolvedProjectProvider ? -1
              : b.id === resolvedProjectProvider ? 1
              : 0)
        : [{ id: 'claude', displayName: 'Claude', enabled: true }]; /* gsd:provider-literal-allowed (last-resort default if providers haven't loaded) */

      for (const prov of ordered) {
        const providerId = prov.id;
        const providerLabel = prov.displayName
          || (providerId.charAt(0).toUpperCase() + providerId.slice(1));
        const cliBinary = this.getProviderCliBinary(providerId);

        items.push({
          label: 'New ' + providerLabel + ' Session Here', icon: '&#9654;', action: () => {
            const emptySlot = this.terminalPanes.findIndex(p => p === null);
            if (emptySlot === -1) {
              this.showToast('All terminal panes full. Close one first.', 'warning');
              return;
            }
            const sid = 'proj-' + Date.now().toString(36);
            this.setViewMode('terminal');
            this.openTerminalInPane(emptySlot, sid, displayName, {
              cwd: projectPath,
              command: cliBinary,
              provider: providerId,
            });
          },
        });

        items.push({
          label: 'New ' + providerLabel + ' Session (Bypass)', icon: '&#9888;', action: () => {
            const emptySlot = this.terminalPanes.findIndex(p => p === null);
            if (emptySlot === -1) {
              this.showToast('All terminal panes full. Close one first.', 'warning');
              return;
            }
            const sid = 'proj-' + Date.now().toString(36);
            this.setViewMode('terminal');
            this.openTerminalInPane(emptySlot, sid, displayName, {
              cwd: projectPath,
              command: cliBinary,
              provider: providerId,
              bypassPermissions: true,
            });
          },
        });
      }

      // Start a new session with project context pre-injected.
      // Currently Claude-only (relies on Claude's --append-system-prompt flag).
      // Surfaced regardless of project provider since the action is opt-in.
      items.push({
        label: 'Start with Context', icon: '&#128218;', action: () => this.startProjectWithContext(projectPath),
      });
    }

    this._renderContextItems(displayName, items, x, y);
  }

  async toggleBypass(sessionId) {
    const session = this.state.sessions.find(s => s.id === sessionId)
      || (this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId));
    if (!session) return;

    const newVal = !session.bypassPermissions;
    try {
      // Update the flag in the store
      const data = await this.api('PUT', `/api/sessions/${sessionId}`, { bypassPermissions: newVal });
      const updated = data.session || data;

      // Immediately update local state so subsequent reads see the new value
      session.bypassPermissions = newVal;
      // Also update in the other array if present
      const otherSession = (this.state.allSessions || []).find(s => s.id === sessionId && s !== session);
      if (otherSession) otherSession.bypassPermissions = newVal;

      this.showToast(`Bypass permissions ${newVal ? 'enabled' : 'disabled'}`, newVal ? 'warning' : 'info');

      // If there's a running PTY for this session, kill it so it respawns with the new flag
      const paneIdx = this.terminalPanes.findIndex(tp => tp && tp.sessionId === sessionId);
      if (paneIdx !== -1) {
        try {
          await this.api('POST', `/api/pty/${encodeURIComponent(sessionId)}/kill`);
          const tp = this.terminalPanes[paneIdx];
          const name = tp.sessionName;
          // Build fresh spawnOpts with the UPDATED bypass value
          const opts = Object.assign({}, tp.spawnOpts, { bypassPermissions: newVal });
          this.closeTerminalPane(paneIdx);
          setTimeout(() => {
            this.openTerminalInPane(paneIdx, sessionId, name, opts);
            this.showToast(`Session restarted with bypass ${newVal ? 'on' : 'off'}`, 'info');
          }, 500);
        } catch (_) {
          // PTY might not be running - flag is saved for next launch
        }
      }

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
    const session = this.state.sessions.find(s => s.id === sessionId)
      || (this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId));
    if (!session) return;

    const newVal = !session.verbose;
    try {
      const data = await this.api('PUT', `/api/sessions/${sessionId}`, { verbose: newVal });
      const updated = data.session || data;
      // Immediately update local state
      session.verbose = newVal;
      const otherSession = (this.state.allSessions || []).find(s => s.id === sessionId && s !== session);
      if (otherSession) otherSession.verbose = newVal;
      this.showToast(`Verbose mode ${newVal ? 'enabled' : 'disabled'}`, 'info');

      // If there's a running PTY, restart with new flag
      const paneIdx = this.terminalPanes.findIndex(tp => tp && tp.sessionId === sessionId);
      if (paneIdx !== -1) {
        try {
          await this.api('POST', `/api/pty/${encodeURIComponent(sessionId)}/kill`);
          const tp = this.terminalPanes[paneIdx];
          const name = tp.sessionName;
          const opts = Object.assign({}, tp.spawnOpts, { verbose: newVal });
          this.closeTerminalPane(paneIdx);
          setTimeout(() => {
            this.openTerminalInPane(paneIdx, sessionId, name, opts);
            this.showToast(`Session restarted with verbose ${newVal ? 'on' : 'off'}`, 'info');
          }, 500);
        } catch (_) {}
      }

      await this.loadSessions();
      if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
        this.state.selectedSession = updated;
        this.renderSessionDetail();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to update session', 'error');
    }
  }

  async toggleAgentTeams(sessionId) {
    const session = this.state.sessions.find(s => s.id === sessionId)
      || (this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId));
    if (!session) return;

    const newVal = !session.agentTeams;
    try {
      const data = await this.api('PUT', `/api/sessions/${sessionId}`, { agentTeams: newVal });
      const updated = data.session || data;
      session.agentTeams = newVal;
      const otherSession = (this.state.allSessions || []).find(s => s.id === sessionId && s !== session);
      if (otherSession) otherSession.agentTeams = newVal;
      this.showToast(`Agent teams ${newVal ? 'enabled' : 'disabled'}`, 'info');

      // If there's a running PTY, restart with new flag
      const paneIdx = this.terminalPanes.findIndex(tp => tp && tp.sessionId === sessionId);
      if (paneIdx !== -1) {
        try {
          await this.api('POST', `/api/pty/${encodeURIComponent(sessionId)}/kill`);
          const tp = this.terminalPanes[paneIdx];
          const name = tp.sessionName;
          const opts = Object.assign({}, tp.spawnOpts, { agentTeams: newVal });
          this.closeTerminalPane(paneIdx);
          setTimeout(() => {
            this.openTerminalInPane(paneIdx, sessionId, name, opts);
            this.showToast(`Session restarted with agent teams ${newVal ? 'on' : 'off'}`, 'info');
          }, 500);
        } catch (_) {}
      }

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
        // Sync title to project sessions via Claude UUID
        const claudeId = data.claudeSessionId || (this.state.sessions.find(s => s.id === sessionId) || {}).resumeSessionId;
        if (claudeId) this.syncSessionTitle(claudeId, data.title);
        this.showToast(`Titled: "${data.title}"`, 'success');
        await this.loadSessions();
        this.renderWorkspaces();
        this.renderProjects();
        if (this.state.selectedSession && this.state.selectedSession.id === sessionId) {
          this.state.selectedSession = this.state.sessions.find(s => s.id === sessionId);
          this.renderSessionDetail();
        }
        // Sync terminal pane titles
        for (let i = 0; i < this.terminalPanes.length; i++) {
          const tp = this.terminalPanes[i];
          if (tp && tp.sessionId === sessionId) {
            tp.sessionName = data.title;
            const paneEl = document.getElementById(`term-pane-${i}`);
            const titleEl = paneEl && paneEl.querySelector('.terminal-pane-title');
            if (titleEl) titleEl.textContent = data.title;
          }
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
        // Sync title across project sessions AND any linked workspace sessions
        this.syncSessionTitle(claudeSessionId, data.title);
        this.showToast(`Titled: "${data.title}"`, 'success');
        this.renderProjects();
        this.renderWorkspaces();
        // Sync terminal pane titles (project sessions use Claude UUID as sessionId)
        for (let i = 0; i < this.terminalPanes.length; i++) {
          const tp = this.terminalPanes[i];
          if (tp && tp.sessionId === claudeSessionId) {
            tp.sessionName = data.title;
            const paneEl = document.getElementById(`term-pane-${i}`);
            const titleEl = paneEl && paneEl.querySelector('.terminal-pane-title');
            if (titleEl) titleEl.textContent = data.title;
          }
        }
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to auto-title', 'error');
    }
  }

  /**
   * Get a stored project session title (from localStorage), or null.
   * Also checks workspace sessions that link to this Claude session UUID.
   */
  getProjectSessionTitle(claudeSessionId) {
    // Check localStorage first
    const titles = JSON.parse(localStorage.getItem('cwm_projectSessionTitles') || '{}');
    if (titles[claudeSessionId]) return titles[claudeSessionId];
    // Fall back: check workspace sessions linked by resumeSessionId.
    // If two sessions share the same UUID (a leftover from older buggy
    // backfills), `find()` would return whichever came first in iteration
    // order and label the JSONL with the wrong session's name. Collect all
    // links, ignore the result if it's ambiguous, and otherwise pick the
    // most-recently-active one for stable display.
    const allSessions = this.state.allSessions || this.state.sessions || [];
    const linked = allSessions.filter(s => s.resumeSessionId === claudeSessionId && s.name);
    if (linked.length === 0) return null;
    if (linked.length > 1) {
      const ids = linked.map(s => s.id).join(', ');
      console.warn(`[CWM] Claude UUID ${claudeSessionId} is linked by ${linked.length} sessions (${ids}); not displaying a name fallback`);
      return null;
    }
    return linked[0].name;
  }

  /**
   * Sync a title across both localStorage project titles and any linked workspace sessions.
   * Call this whenever a title is set from ANY source.
   * @param {string} claudeSessionId - The Claude session UUID
   * @param {string} title - The new title
   */
  syncSessionTitle(claudeSessionId, title) {
    if (!claudeSessionId || !title) return;
    // 1. Update localStorage project titles
    const titles = JSON.parse(localStorage.getItem('cwm_projectSessionTitles') || '{}');
    titles[claudeSessionId] = title;
    localStorage.setItem('cwm_projectSessionTitles', JSON.stringify(titles));
    // 2. Update any workspace sessions that link to this Claude UUID
    const allSessions = this.state.allSessions || [];
    for (const s of allSessions) {
      if (s.resumeSessionId === claudeSessionId && s.name !== title) {
        s.name = title;
        // Fire-and-forget API update
        this.api('PUT', `/api/sessions/${s.id}`, { name: title }).catch(() => {});
      }
    }
    // Also check this.state.sessions (may be a different filtered array)
    for (const s of (this.state.sessions || [])) {
      if (s.resumeSessionId === claudeSessionId && s.name !== title) {
        s.name = title;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     THEME TOGGLE
     ═══════════════════════════════════════════════════════════ */

  setTheme(themeName) {
    if (themeName === 'mocha') {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = themeName;
    }
    localStorage.setItem('cwm_theme', themeName);

    // Update active state in dropdown
    if (this.els.themeDropdown) {
      this.els.themeDropdown.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === themeName);
      });
    }

    // Update all open xterm.js terminal themes
    this.terminalPanes.forEach(tp => {
      if (tp && tp.term) {
        tp.term.options.theme = TerminalPane.getCurrentTheme();
      }
    });
  }

  _applyVkbState() {
    const btn = this.els && this.els.vkbToggleBtn;
    const active = !!this._vkbDisabled;
    if (btn) {
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.title = active
        ? 'On-screen keyboard disabled (click to enable)'
        : 'Disable on-screen keyboard (hardware keyboard only)';
    }
    document.querySelectorAll('.xterm-helper-textarea').forEach(t => {
      if (active) t.setAttribute('inputmode', 'none');
      else t.removeAttribute('inputmode');
    });
  }

  // Legacy alias for any remaining callers
  toggleTheme() {
    const current = document.documentElement.dataset.theme || 'mocha';
    const themes = ['mocha', 'macchiato', 'frappe', 'nord', 'dracula', 'tokyo-night', 'cherry', 'ocean', 'amber', 'mint', 'latte', 'rose-pine-dawn', 'gruvbox-light'];
    const next = themes[(themes.indexOf(current) + 1) % themes.length];
    this.setTheme(next);
  }


  /* ═══════════════════════════════════════════════════════════
     PASSWORD VISIBILITY TOGGLE
     ═══════════════════════════════════════════════════════════ */

  togglePasswordVisibility() {
    const input = this.els.loginPassword;
    const btn = this.els.passwordToggleBtn;
    if (!input || !btn) return;

    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';

    // Toggle icon visibility using hidden attribute
    const showIcon = btn.querySelector('.pw-icon-show');
    const hideIcon = btn.querySelector('.pw-icon-hide');
    if (showIcon) showIcon.hidden = isPassword;
    if (hideIcon) hideIcon.hidden = !isPassword;

    // Keep focus on the password input for quick typing
    input.focus();
  }


  /* ═══════════════════════════════════════════════════════════
     UI SCALE CONTROLS
     ═══════════════════════════════════════════════════════════ */

  scaleUI(direction) {
    const presets = [0.85, 0.9, 1.0, 1.1, 1.2];
    const current = parseFloat(localStorage.getItem('cwm_ui_scale')) || 1.0;

    // Find the nearest preset index
    let idx = presets.indexOf(current);
    if (idx === -1) {
      // Find closest preset
      idx = presets.reduce((closest, val, i) =>
        Math.abs(val - current) < Math.abs(presets[closest] - current) ? i : closest
      , 0);
    }

    if (direction === 'up' && idx < presets.length - 1) {
      idx++;
    } else if (direction === 'down' && idx > 0) {
      idx--;
    } else {
      return; // Already at limit
    }

    const newScale = presets[idx];
    localStorage.setItem('cwm_ui_scale', newScale);
    document.documentElement.style.setProperty('--ui-scale', newScale);

    // Refit all terminal panes after a brief delay for zoom to take effect
    setTimeout(() => {
      this.terminalPanes.forEach(tp => {
        if (tp) tp.safeFit();
      });
    }, 100);
  }


  /* ═══════════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════════ */

  /** Persist settings to localStorage */
  saveSettings() {
    localStorage.setItem('cwm_settings', JSON.stringify(this.state.settings));
  }

  /** Get a single setting value */
  getSetting(key) {
    return this.state.settings[key];
  }

  /** Returns the full settings registry with metadata for rendering */
  getSettingsRegistry() {
    return [
      { key: 'paneColorHighlights', label: 'Pane Color Highlights', description: 'Color-coded left border on terminal pane headers, with matching pips in sidebar', category: 'Terminal' },
      { key: 'activityIndicators', label: 'Activity Indicators', description: 'Show real-time activity labels (Reading, Writing, etc.) on pane headers', category: 'Terminal' },
      { key: 'autoOpenTerminal', label: 'Auto-open Terminal on Start', description: 'Automatically open a terminal when starting a session', category: 'Terminal' },
      { key: 'completionNotifications', label: 'Completion Notifications', description: 'Sound and toast when a background terminal finishes', category: 'Notifications' },
      { key: 'sessionCountInHeader', label: 'Session Count in Header', description: 'Show running/total session stats in the header bar', category: 'Interface' },
      { key: 'confirmBeforeClose', label: 'Confirm Before Close', description: 'Ask for confirmation before closing terminal panes', category: 'Interface' },
      { key: 'uiScale', label: 'UI Scale', description: 'Adjust the overall interface size', category: 'Interface', type: 'scale' },
      { key: 'headerHeight', label: 'Header Height', description: 'Adjust the height of the top header bar', category: 'Interface', type: 'slider', min: 35, max: 80, default: 80, unit: 'px' },
      { key: 'autoTrustDialogs', label: 'Auto-accept Trust Dialogs', description: 'Automatically accept safe trust/permission prompts in terminals. Dangerous prompts (delete, credentials) are never auto-accepted.', category: 'Automation' },
      { key: 'enableWorktreeTasks', label: 'Worktree Tasks', description: 'Enable automated worktree task creation and review workflow', category: 'Advanced' },
      { key: 'enableTd', label: 'td Task Management', description: 'Show td issue tracking integration (github.com/marcus/td). When disabled, hides all td UI including the docs panel section and sidebar toggle.', category: 'Advanced' },
      { key: 'tdBinary', label: 'td Binary Path', description: 'Optional. td is an alternative task management system (github.com/marcus/td) — Myrlin works fine without it. If installed, set the absolute path to the binary here, or leave blank to use the TD_BINARY environment variable or "td" from PATH. Example: /home/user/go/bin/td', category: 'Advanced', type: 'server-text', placeholder: 'e.g. /home/user/go/bin/td', apiEndpoint: '/api/td/binary', apiField: 'binary' },
      { key: 'maxConcurrentTasks', label: 'Max Concurrent Tasks', description: 'Maximum number of worktree tasks that can run simultaneously (1-8)', category: 'Advanced', type: 'number', min: 1, max: 8 },
      { key: 'defaultModelPlanning', label: 'Default Model (Planning)', description: 'Auto-assign when tasks enter Planning. Haiku is fast/cheap for exploration. Only applies to tasks without a model set.', category: 'Advanced', type: 'select', options: [{ value: '', label: 'None' }, { value: 'haiku', label: 'Haiku (fast, cheap)' }, { value: 'sonnet', label: 'Sonnet (balanced)' }, { value: 'opus', label: 'Opus (thorough)' }, { value: 'sonnet[1m]', label: 'Sonnet 1M' }, { value: 'opusplan', label: 'OpusPlan' }] },
      { key: 'defaultModelRunning', label: 'Default Model (Running)', description: 'Auto-assign when tasks enter Running. Sonnet balances speed and quality for implementation. Only applies to tasks without a model set.', category: 'Advanced', type: 'select', options: [{ value: '', label: 'None' }, { value: 'haiku', label: 'Haiku (fast, cheap)' }, { value: 'sonnet', label: 'Sonnet (balanced)' }, { value: 'opus', label: 'Opus (thorough)' }, { value: 'sonnet[1m]', label: 'Sonnet 1M' }, { value: 'opusplan', label: 'OpusPlan' }] },
      { key: 'anthropicApiKey', label: 'Anthropic API Key', description: 'Required for AI-powered session finder. Uses Claude Haiku for fast, low-cost semantic search across your projects and sessions. Get a key at console.anthropic.com.', category: 'AI', type: 'server-text', placeholder: 'sk-ant-...', apiEndpoint: '/api/keys/anthropic', apiField: 'key' },
      { key: 'cfNamedTunnel', label: 'Cloudflare Named Tunnel', description: 'Expose Myrlin on the internet via your own domain. Go to one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel, then copy the token from the install command (the long eyJ… string).', category: 'Remote Access', type: 'tunnel' },
    ];
  }

  /* ═══════════════════════════════════════════════════════════
     FEATURE CATALOG (Command Palette Discovery)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Returns the full feature catalog for the command palette.
   * Each entry describes a discoverable feature, action, or help topic.
   * When adding new features, add a catalog entry here so users can find it via Ctrl+K.
   * @returns {Array<{id:string, name:string, description:string, detail?:string, category:string, tags:string[], shortcut?:string, icon:string, action?:Function, navigateTo?:string, isAvailable?:Function}>}
   */
  getFeatureCatalog() {
    return [
      // ── Actions ──────────────────────────────────────
      {
        id: 'new-session',
        name: 'New Session',
        description: 'Create a new Claude Code session in a project',
        category: 'action',
        tags: ['create', 'session', 'start', 'launch', 'claude', 'add'], // gsd:provider-literal-allowed (command palette search keyword; refactor deferred to Phase 18)
        shortcut: 'Ctrl+N',
        icon: '&#43;',
        action: () => this.createSession(),
      },
      {
        id: 'new-workspace',
        name: 'New Project',
        description: 'Create a new project to organize sessions',
        category: 'action',
        tags: ['create', 'workspace', 'project', 'category', 'focus', 'group', 'organize', 'add'],
        icon: '&#43;',
        action: () => this.createWorkspace(),
      },
      {
        id: 'open-settings',
        name: 'Open Settings',
        description: 'Configure UI scale, notifications, terminal behavior, and more',
        category: 'action',
        tags: ['preferences', 'config', 'options', 'scale', 'zoom', 'settings'],
        shortcut: 'Ctrl+,',
        icon: '&#9881;',
        action: () => this.openSettings(),
      },
      {
        id: 'open-global-search',
        name: 'Search Session History',
        description: 'Full-text search across all session conversation history',
        category: 'action',
        tags: ['search', 'find', 'history', 'content', 'grep', 'global'],
        shortcut: 'Ctrl+Shift+F',
        icon: '&#128269;',
        action: () => this.openGlobalSearch(),
      },
      {
        id: 'discover-sessions',
        name: 'Discover Local Sessions',
        description: 'Scan this PC for existing Claude Code sessions not yet in a project',
        category: 'action',
        tags: ['discover', 'import', 'scan', 'local', 'projects', 'find'],
        icon: '&#128269;',
        action: () => this.discoverSessions(),
      },
      {
        id: 'toggle-theme',
        name: 'Toggle Theme',
        description: 'Cycle through available color themes',
        category: 'action',
        tags: ['theme', 'dark', 'light', 'color', 'appearance', 'switch'],
        icon: '&#127912;',
        action: () => { if (typeof this.toggleTheme === 'function') this.toggleTheme(); },
      },
      {
        id: 'view-terminal',
        name: 'Switch to Terminal View',
        description: 'Open the terminal grid with split panes',
        category: 'action',
        tags: ['terminal', 'pane', 'view', 'switch'],
        icon: '&#9641;',
        action: () => this.setViewMode('terminal'),
      },
      {
        id: 'view-costs',
        name: 'Switch to Costs View',
        description: 'Open the cost tracking dashboard',
        category: 'action',
        tags: ['cost', 'spend', 'view', 'switch', 'money'],
        icon: '&#36;',
        action: () => this.setViewMode('costs'),
      },

      // ── Features ─────────────────────────────────────
      {
        id: 'workspaces',
        name: 'Projects',
        description: 'Organize sessions into named, color-coded categories',
        detail: 'Projects let you group related Claude sessions. Create, rename, color-code, archive, and delete projects. Sessions belong to exactly one project. Right-click a project for all options.',
        category: 'feature',
        tags: ['workspace', 'project', 'category', 'focus', 'group', 'organize', 'color', 'archive', 'rename'],
        icon: '&#9638;',
        navigateTo: 'workspace',
      },
      {
        id: 'terminal-panes',
        name: 'Terminal Panes',
        description: 'Up to 6 split terminal panes with drag-and-drop layout',
        detail: 'The Terminal view supports up to 6 panes. Drag sessions from the sidebar into panes. Panes show real-time activity indicators. Double-click a pane header to maximize.',
        category: 'feature',
        tags: ['terminal', 'pane', 'split', 'layout', 'drag', 'drop', 'resize', 'maximize', 'grid'],
        icon: '&#9641;',
        navigateTo: 'terminal',
      },
      {
        id: 'templates',
        name: 'Session Templates',
        description: 'Save session configurations as reusable templates for quick launch',
        detail: 'Right-click any session and choose "Save as Template" to capture its directory, model, flags, and command. When creating a new session, templates appear as quick-launch chips.',
        category: 'feature',
        tags: ['template', 'quick launch', 'save', 'reuse', 'preset', 'config'],
        icon: '&#9889;',
      },
      {
        id: 'cost-tracking',
        name: 'Cost Tracking',
        description: 'Per-session and aggregate token usage and cost analysis with model breakdown',
        detail: 'The Costs tab shows estimated spend broken down by model, with per-session detail. Filter by day/week/month/all. Cost data is parsed from Claude JSONL logs.',
        category: 'feature',
        tags: ['cost', 'token', 'usage', 'spend', 'money', 'price', 'model', 'budget', 'analytics'],
        icon: '&#36;',
        navigateTo: 'costs',
      },
      {
        id: 'feature-board',
        name: 'Feature Board',
        description: 'Kanban board to track planned/active/review/done features per project',
        detail: 'Available in the Docs tab under the Board sub-tab. Create feature cards, set priority and tags, drag between columns.',
        category: 'feature',
        tags: ['board', 'kanban', 'track', 'feature', 'plan', 'roadmap', 'project'],
        icon: '&#128203;',
        navigateTo: 'docs',
      },
      {
        id: 'workspace-docs',
        name: 'Project Docs',
        description: 'Per-project Notes, Goals, Tasks, Roadmap, and Rules in markdown',
        detail: 'Each project has its own documentation sections. Edit inline or toggle raw markdown mode. Available in the Docs tab.',
        category: 'feature',
        tags: ['docs', 'documentation', 'notes', 'goals', 'tasks', 'rules', 'roadmap', 'markdown'],
        icon: '&#128221;',
        navigateTo: 'docs',
      },
      {
        id: 'conflict-detection',
        name: 'Conflict Detection',
        description: 'Detect when multiple sessions edit the same files, with auto-resolve option',
        detail: 'When two or more sessions modify the same file, a warning badge appears in the header. Click to open the Conflict Center. Auto-resolve can stop non-active sessions.',
        category: 'feature',
        tags: ['conflict', 'collision', 'file', 'edit', 'multi-agent', 'resolve', 'auto-kill'],
        icon: '&#9888;',
      },
      {
        id: 'themes',
        name: 'Themes',
        description: '13 themes including Catppuccin, Nord, Dracula, Tokyo Night, and 3 light themes',
        detail: 'Click the theme icon in the header to pick from 10 dark and 3 light themes. Your preference is saved across sessions.',
        category: 'feature',
        tags: ['theme', 'dark', 'light', 'catppuccin', 'nord', 'dracula', 'tokyo', 'rose', 'gruvbox', 'color', 'appearance'],
        icon: '&#127912;',
        action: () => { const btn = document.getElementById('theme-toggle-btn'); if (btn) btn.click(); },
      },
      {
        id: 'session-flags',
        name: 'Session Flags',
        description: 'Set model (Opus/Sonnet/Haiku), bypass permissions, verbose, agent teams',
        detail: 'Right-click any session to access the Flags/Permissions submenu. Toggle bypass permissions, verbose mode, or agent teams. Select the AI model. Changes take effect on restart.',
        category: 'feature',
        tags: ['flag', 'model', 'opus', 'sonnet', 'haiku', 'bypass', 'permissions', 'verbose', 'agent', 'teams'],
        icon: '&#9873;',
      },
      {
        id: 'drag-and-drop',
        name: 'Drag & Drop',
        description: 'Reorder sessions, move between projects, arrange terminal panes by dragging',
        detail: 'Drag session cards to reorder or move to different projects. Drag sessions into terminal pane slots for split view.',
        category: 'feature',
        tags: ['drag', 'drop', 'reorder', 'move', 'arrange', 'layout'],
        icon: '&#8597;',
      },
      {
        id: 'process-recovery',
        name: 'Process Recovery',
        description: 'Automatically recover sessions after crash or restart',
        detail: 'On startup, PIDs of sessions marked running are checked. Live sessions stay running, dead ones are marked stopped. This happens transparently.',
        category: 'feature',
        tags: ['recovery', 'crash', 'restart', 'auto', 'resilient', 'pid'],
        icon: '&#8635;',
      },
      {
        id: 'resources-monitor',
        name: 'System Resources',
        description: 'Monitor CPU, memory, and process status of running sessions',
        detail: 'The Resources tab shows real-time system metrics per session. Kill or restart processes directly. Auto-refreshes every 10 seconds.',
        category: 'feature',
        tags: ['resources', 'cpu', 'memory', 'process', 'monitor', 'system', 'kill', 'performance'],
        icon: '&#128200;',
        navigateTo: 'resources',
      },
      {
        id: 'worktrees',
        name: 'Git Worktrees',
        description: 'Create and manage git worktrees for parallel branch work',
        detail: 'Right-click a project to "Create Worktree". Worktrees let you have multiple branches checked out simultaneously, each in its own directory with its own session.',
        category: 'feature',
        tags: ['worktree', 'git', 'branch', 'parallel', 'checkout', 'repository', 'isolation'],
        icon: '&#128268;',
      },
      {
        id: 'import-export',
        name: 'Import / Export',
        description: 'Export session context for portability and handoff',
        detail: 'Right-click a session and choose "Export Context" to save the conversation as a portable file for backup or sharing.',
        category: 'feature',
        tags: ['import', 'export', 'backup', 'context', 'handoff', 'portable', 'share'],
        icon: '&#128230;',
      },
      {
        id: 'completion-notifications',
        name: 'Completion Notifications',
        description: 'Sound and toast when a background terminal finishes its task',
        detail: 'Enable in Settings > Notifications. When a terminal pane detects Claude returning to idle, a notification sound plays and a toast appears.',
        category: 'feature',
        tags: ['notification', 'sound', 'alert', 'complete', 'finish', 'idle', 'background'],
        icon: '&#128276;',
      },
      {
        id: 'refocus-session',
        name: 'Refocus Session',
        description: 'Distill and compact a conversation to reduce context length',
        detail: 'Right-click a session > Refocus > Reset & Refocus or Compact & Refocus. Summarizes the conversation so far and starts fresh with reduced token usage.',
        category: 'feature',
        tags: ['refocus', 'reset', 'compact', 'context', 'distill', 'summary', 'tokens'],
        icon: '&#128260;',
      },
      {
        id: 'image-upload',
        name: 'Image Upload',
        description: 'Upload images to Claude directly in terminal panes',
        detail: 'Each terminal pane has an upload button. Click it or drag an image onto the pane to send it to Claude for analysis.',
        category: 'feature',
        tags: ['image', 'upload', 'screenshot', 'picture', 'photo', 'visual', 'drag'],
        icon: '&#128247;',
      },
      {
        id: 'saved-layouts',
        name: 'Saved Layouts',
        description: 'Save and restore terminal pane arrangements',
        detail: 'Save your current pane layout (which sessions in which slots) and restore it later. Access via the Terminal view toolbar.',
        category: 'feature',
        tags: ['layout', 'save', 'restore', 'pane', 'arrangement', 'terminal'],
        icon: '&#128190;',
        navigateTo: 'terminal',
      },
      {
        id: 'activity-feed',
        name: 'Activity Feed',
        description: 'Real-time status labels per terminal pane (Reading, Writing, etc.)',
        detail: 'Terminal pane headers show live activity indicators when enabled. Toggle in Settings > Terminal > Activity Indicators.',
        category: 'feature',
        tags: ['activity', 'status', 'indicator', 'reading', 'writing', 'live', 'real-time'],
        icon: '&#128161;',
      },
      {
        id: 'feature-sessions',
        name: 'Feature Sessions',
        description: 'Dedicated sessions on isolated git branches for building features',
        detail: 'Right-click a project > "New Feature Session". Creates a worktree branch and session in one step. The session works in isolation on that branch.',
        category: 'feature',
        tags: ['feature', 'session', 'branch', 'worktree', 'isolation', 'git'],
        icon: '&#9733;',
      },

      // ── Keyboard Shortcuts ───────────────────────────
      {
        id: 'shortcut-quick-switcher',
        name: 'Command Palette',
        description: 'Search sessions, projects, features, actions, and settings',
        category: 'shortcut',
        tags: ['shortcut', 'command', 'palette', 'search', 'quick', 'switcher'],
        shortcut: 'Ctrl+K',
        icon: '&#9000;',
      },
      {
        id: 'shortcut-new-session',
        name: 'New Session',
        description: 'Create a new Claude Code session',
        category: 'shortcut',
        tags: ['shortcut', 'new', 'session', 'create'],
        shortcut: 'Ctrl+N',
        icon: '&#9000;',
        action: () => this.createSession(),
      },
      {
        id: 'shortcut-global-search',
        name: 'Global Search',
        description: 'Search across all session conversation history',
        category: 'shortcut',
        tags: ['shortcut', 'search', 'global', 'history', 'find'],
        shortcut: 'Ctrl+Shift+F',
        icon: '&#9000;',
        action: () => this.openGlobalSearch(),
      },
      {
        id: 'shortcut-settings',
        name: 'Settings',
        description: 'Open the settings panel',
        category: 'shortcut',
        tags: ['shortcut', 'settings', 'preferences', 'config'],
        shortcut: 'Ctrl+,',
        icon: '&#9000;',
        action: () => this.openSettings(),
      },
      {
        id: 'feature-tasks-view',
        name: 'Tasks View',
        description: 'Dedicated view for worktree tasks showing active, review, and completed tasks with status indicators and quick actions.',
        category: 'feature',
        tags: ['tasks', 'worktree', 'branch', 'autonomous', 'agent', 'view'],
        icon: '&#128736;',
        action: () => this.setViewMode('tasks'),
      },
      {
        id: 'action-new-task',
        name: 'New Worktree Task',
        description: 'Create an isolated worktree branch for Claude to work on autonomously',
        category: 'action',
        tags: ['new', 'task', 'worktree', 'branch', 'create', 'autonomous'],
        shortcut: 'Ctrl+Shift+N',
        icon: '&#43;',
        action: () => this.openNewTaskDialog(),
        isAvailable: () => !!this.state.settings.enableWorktreeTasks,
      },
      {
        id: 'feature-auto-trust',
        name: 'Auto-accept Trust Dialogs',
        description: 'Automatically accept safe trust/permission prompts (Y/n, "trust this folder") in terminals. Dangerous prompts are never auto-accepted. Enable in Settings > Automation.',
        category: 'feature',
        tags: ['auto', 'trust', 'accept', 'permission', 'dialog', 'prompt', 'automation', 'autonomous'],
        icon: '&#128274;',
        action: () => this.openSettings(),
      },
      {
        id: 'shortcut-help',
        name: 'Help / Feature Discovery',
        description: 'Browse all features, actions, and keyboard shortcuts',
        category: 'shortcut',
        tags: ['shortcut', 'help', 'features', 'discover', 'docs'],
        shortcut: '?',
        icon: '&#9000;',
        action: () => this.openQuickSwitcher('help'),
      },
      {
        id: 'feature-tags',
        name: 'Tags',
        description: 'Add comma-separated tags to sessions and tasks. Tags appear as colored badges on kanban cards and session list. Search tasks by tag. Right-click any session or kanban card to edit tags.',
        category: 'feature',
        tags: ['tag', 'label', 'badge', 'category', 'filter', 'organize', 'group'],
        icon: '&#127991;',
      },
      {
        id: 'feature-pr-automation',
        name: 'Pull Request Automation',
        description: 'Create GitHub PRs directly from worktree tasks. AI-generated descriptions from diffs. PR badges on kanban cards link to GitHub. Auto-advances tasks to Done when PR is merged. Available from review column, context menu, or session detail banner.',
        category: 'feature',
        tags: ['pr', 'pull request', 'github', 'merge', 'review', 'branch', 'code review'],
        icon: '&#128279;',
      },
      {
        id: 'feature-model-orchestration',
        name: 'Model Orchestration',
        description: 'Assign models per task from the kanban context menu. Configure default models for Planning and Running stages in Settings > Advanced. Tasks auto-inherit the stage model when dragged between columns.',
        category: 'feature',
        tags: ['model', 'orchestration', 'opus', 'sonnet', 'haiku', 'stage', 'planning', 'running'],
        icon: '&#9881;',
        action: () => this.openSettings(),
      },
    ];
  }

  /**
   * Score a feature catalog entry against a search query.
   * Higher score = better match. 0 = no match.
   * @param {Object} entry - Feature catalog entry
   * @param {string} query - Lowercase trimmed search query
   * @returns {number} Match score (0 = no match)
   */
  scoreFeatureMatch(entry, query) {
    let score = 0;
    const nameLower = entry.name.toLowerCase();

    // Exact name match (highest weight)
    if (nameLower === query) return 100;

    // Name starts with query
    if (nameLower.startsWith(query)) score += 50;
    // Name contains query
    else if (nameLower.includes(query)) score += 30;

    // Shortcut matches
    if (entry.shortcut && entry.shortcut.toLowerCase().includes(query)) score += 25;

    // Description contains query
    if (entry.description.toLowerCase().includes(query)) score += 20;

    // Tags contain query (partial match OK)
    for (const tag of (entry.tags || [])) {
      if (tag.includes(query)) { score += 15; break; }
    }

    // Detail text contains query (lower weight, for deep discovery)
    if (entry.detail && entry.detail.toLowerCase().includes(query)) score += 5;

    return score;
  }

  /**
   * Open the settings panel scrolled to a specific setting key.
   * Used by the command palette when selecting a setting result.
   * @param {string} key - The setting key to scroll to
   */
  scrollToSetting(key) {
    this.openSettings();
    // Small delay to let settings panel render, then scroll to the setting
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-setting-key="${key}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.outline = '2px solid var(--mauve)';
        el.style.borderRadius = 'var(--radius-sm)';
        setTimeout(() => { el.style.outline = ''; }, 2000);
      }
    });
  }

  /** Return one entry per place a session is open across all tab groups. */
  getSessionInstances(sessionId) {
    return window.InstanceColors.getSessionInstances(sessionId, this._tabGroups || []);
  }

  /** Return the (positional) colour for a tab — global index across all tabs. */
  getTabColor(tabId) {
    return window.InstanceColors.getTabColor(tabId, this._tabGroups || []);
  }

  /** Render one indicator: top half = tab colour, bottom half = slot colour, 1px divider. */
  renderInstanceIndicator({ tabColor, slotColor, title, tabId, slot }) {
    return `<span class="instance-indicator"
      title="${this.escapeHtml(title || '')}"
      data-tab-id="${this.escapeHtml(tabId)}"
      data-slot="${slot}"
      style="--c-outer:var(--${tabColor});
             --c-inner:var(--${slotColor})">
      <span class="instance-indicator-square">
        <span class="instance-indicator-inner"></span>
      </span>
    </span>`;
  }

  /** Render the full row of indicators for a session, or empty string. */
  renderInstanceIndicatorRow(sessionId) {
    if (!this.state.settings.paneColorHighlights) return '';
    const instances = this.getSessionInstances(sessionId);
    if (!instances.length) return '';
    return `<span class="instance-indicator-row">${
      instances.map(inst => this.renderInstanceIndicator({
        tabColor:  this.getTabColor(inst.tabId),
        slotColor: this.PANE_SLOT_COLORS[inst.slot % this.PANE_SLOT_COLORS.length],
        title:     this._formatInstanceTooltip(inst),
        tabId:     inst.tabId,
        slot:      inst.slot,
      })).join('')
    }</span>`;
  }

  /** Build a textual tooltip for an instance: "<tab> › slot N". */
  _formatInstanceTooltip({ tabId, slot }) {
    const tab = (this._tabGroups || []).find(g => g.id === tabId);
    const tabName = tab ? tab.name : '?';
    return `${tabName} › slot ${slot + 1}`;
  }

  /** Navigate to a session instance: switch to its tab, then briefly pulse the pane. */
  _navigateToInstance(tabId, slot) {
    if (this._activeGroupId !== tabId) {
      this.switchTerminalGroup(tabId);
    }
    // Pulse the target pane on the next frame so the switch has rendered.
    requestAnimationFrame(() => {
      const paneEls = document.querySelectorAll('.terminal-pane');
      const paneEl = paneEls[slot];
      if (!paneEl) return;
      paneEl.classList.remove('pane-nav-pulse');
      void paneEl.offsetWidth;                 // force reflow so the animation restarts
      paneEl.classList.add('pane-nav-pulse');
      setTimeout(() => paneEl.classList.remove('pane-nav-pulse'), 800);
    });
  }

  /** Open the settings overlay */
  openSettings() {
    if (!this.els.settingsOverlay) return;
    this.els.settingsOverlay.hidden = false;
    if (this.els.settingsSearchInput) {
      this.els.settingsSearchInput.value = '';
      this.els.settingsSearchInput.focus();
    }
    this.renderSettingsBody('');
  }

  /** Close the settings overlay */
  closeSettings() {
    if (this.els.settingsOverlay) this.els.settingsOverlay.hidden = true;
  }

  /** Render settings body, optionally filtered by search string */
  renderSettingsBody(filter) {
    if (!this.els.settingsBody) return;
    const registry = this.getSettingsRegistry();
    const lowerFilter = (filter || '').toLowerCase();

    // Filter entries
    const filtered = lowerFilter
      ? registry.filter(s =>
          s.label.toLowerCase().includes(lowerFilter) ||
          s.description.toLowerCase().includes(lowerFilter) ||
          s.category.toLowerCase().includes(lowerFilter))
      : registry;

    // alpha.7 fix for the user-reported bug: "if i type provider, the
    // providers section does not show up." The Providers section is
    // rendered asynchronously below (_renderProvidersSection), so a
    // static-registry-empty result must NOT short-circuit the render --
    // it would skip the async section entirely and produce a false
    // "No matching settings" state. Instead, render an empty body and
    // let the async section fill it in; if BOTH are empty, the empty
    // state is shown by _renderProvidersSection's fallback.
    if (filtered.length === 0) {
      this.els.settingsBody.innerHTML = '<div id="settings-providers-placeholder"></div><div class="settings-empty" id="settings-empty-fallback">No matching settings</div>';
      this._renderProvidersSection(lowerFilter).then(providersHtml => {
        const placeholder = document.getElementById('settings-providers-placeholder');
        const emptyEl = document.getElementById('settings-empty-fallback');
        if (placeholder && providersHtml) {
          placeholder.outerHTML = providersHtml;
          if (emptyEl) emptyEl.remove();
          this.els.settingsBody.querySelectorAll('input[data-provider-toggle]').forEach(input => {
            input.addEventListener('change', (e) => this._handleProviderToggleChange(e));
          });
        } else if (placeholder) {
          placeholder.remove();
        }
      }).catch(err => {
        console.warn('[settings-providers] render failed:', err);
        const placeholder = document.getElementById('settings-providers-placeholder');
        if (placeholder) placeholder.remove();
      });
      return;
    }

    // Group by category
    const groups = {};
    for (const s of filtered) {
      if (!groups[s.category]) groups[s.category] = [];
      groups[s.category].push(s);
    }

    let html = '';
    for (const [category, items] of Object.entries(groups)) {
      // alpha.9: tag each category with a slug-id + data-category so the
      // settings nav rail can smooth-scroll into it and the scroll-spy
      // can match the visible category back to the rail entry.
      const slug = this._settingsCategorySlug(category);
      html += `<div class="settings-category" id="settings-cat-${this.escapeHtml(slug)}" data-category="${this.escapeHtml(category)}">`;
      html += `<div class="settings-category-label">${this.escapeHtml(category)}</div>`;
      for (const item of items) {
        if (item.type === 'scale') {
          // Custom UI scale control with - / value / + buttons
          const currentScale = parseFloat(localStorage.getItem('cwm_ui_scale')) || 1.0;
          const pct = Math.round(currentScale * 100);
          html += `
            <div class="settings-row" data-setting-key="${item.key}">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <div class="settings-scale-control">
                <button class="settings-scale-btn" data-scale-dir="down" title="Decrease">-</button>
                <span class="settings-scale-value">${pct}%</span>
                <button class="settings-scale-btn" data-scale-dir="up" title="Increase">+</button>
              </div>
            </div>`;
        } else if (item.type === 'slider') {
          const val = this.state.settings[item.key] !== undefined ? this.state.settings[item.key] : (item.default || 0);
          const min = item.min !== undefined ? item.min : 0;
          const max = item.max !== undefined ? item.max : 100;
          html += `
            <div class="settings-row" data-setting-key="${item.key}">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <input type="range" class="settings-slider-input" data-setting-slider="${item.key}" value="${val}" min="${min}" max="${max}" style="width: 100px;" />
                <span class="settings-slider-value" id="slider-val-${item.key}" style="font-size:12px;min-width:35px;text-align:right;">${val}${item.unit || ''}</span>
              </div>
            </div>`;
        } else if (item.type === 'number') {
          const val = this.state.settings[item.key] || 0;
          html += `
            <div class="settings-row" data-setting-key="${item.key}">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <input type="number" class="settings-number-input" data-setting-num="${item.key}" value="${val}" min="0" max="99999" placeholder="0" />
            </div>`;
        } else if (item.type === 'select' && Array.isArray(item.options)) {
          const val = this.state.settings[item.key] || '';
          const optionsHtml = item.options.map(opt =>
            `<option value="${this.escapeHtml(opt.value)}"${opt.value === val ? ' selected' : ''}>${this.escapeHtml(opt.label)}</option>`
          ).join('');
          html += `
            <div class="settings-row" data-setting-key="${item.key}">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <select class="form-select settings-select-input" data-setting-select="${item.key}" style="width: 140px; font-size: 12px;">
                ${optionsHtml}
              </select>
            </div>`;
        } else if (item.type === 'server-text') {
          // A text setting persisted on the server (not localStorage).
          // Value is loaded async after render via loadServerTextSettings().
          html += `
            <div class="settings-row" data-setting-key="${item.key}">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="text" class="settings-server-text-input" id="server-text-${item.key}"
                  data-api-endpoint="${this.escapeHtml(item.apiEndpoint || '')}"
                  data-api-field="${this.escapeHtml(item.apiField || 'value')}"
                  placeholder="${this.escapeHtml(item.placeholder || '')}"
                  style="font-size:12px;padding:4px 8px;background:var(--mantle);border:1px solid var(--surface1);border-radius:4px;color:inherit;width:220px;" />
                <button class="settings-server-text-save btn btn-ghost btn-sm" data-input-id="server-text-${item.key}" style="font-size:12px;">Save</button>
                <span class="settings-server-text-status" id="server-text-status-${item.key}" style="font-size:11px;opacity:0.6;"></span>
              </div>
            </div>`;
        } else if (item.type === 'tunnel') {
          html += `
            <div class="settings-row" data-setting-key="${item.key}" style="flex-direction:column;align-items:flex-start;gap:8px;padding:10px 0;">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <div id="named-tunnel-status" style="font-size:11px;font-family:monospace;opacity:0.65;">checking...</div>
              <ol style="font-size:11px;opacity:0.55;margin:2px 0 4px 16px;padding:0;line-height:1.7;">
                <li>Open <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener" style="color:inherit;">one.dash.cloudflare.com</a> → Networks → Tunnels</li>
                <li>Create a tunnel → Cloudflared → copy the <code style="font-size:10px;">eyJ…</code> token → paste below → Save</li>
                <li>Add a public hostname: subdomain of your choice, your domain, Type <code style="font-size:10px;">HTTP</code>, URL <code style="font-size:10px;">localhost:3456</code></li>
                <li>Click Start below (or enable Auto-start)</li>
              </ol>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;width:100%;">
                <input type="password" id="named-tunnel-token-input" autocomplete="off"
                  placeholder="eyJ… token from Cloudflare dashboard"
                  style="flex:1;min-width:180px;font-size:12px;padding:4px 8px;background:var(--input-bg,#1e1e2e);border:1px solid var(--border,#444);border-radius:4px;color:inherit;" />
                <button id="named-tunnel-save-btn" style="font-size:12px;padding:4px 10px;border-radius:4px;border:1px solid var(--border,#555);background:var(--btn-bg,#313244);color:inherit;cursor:pointer;">Save</button>
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <button id="named-tunnel-start-btn" style="font-size:12px;padding:4px 10px;border-radius:4px;border:none;background:#89b4fa;color:#1e1e2e;cursor:pointer;font-weight:600;">Start</button>
                <button id="named-tunnel-stop-btn" style="font-size:12px;padding:4px 10px;border-radius:4px;border:1px solid var(--border,#555);background:var(--btn-bg,#313244);color:inherit;cursor:pointer;">Stop</button>
                <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;user-select:none;">
                  <input type="checkbox" id="named-tunnel-autostart" style="cursor:pointer;" />
                  Auto-start on launch
                </label>
              </div>
            </div>`;
        } else {
          const checked = this.state.settings[item.key] ? 'checked' : '';
          html += `
            <div class="settings-row" data-setting-key="${item.key}">
              <div class="settings-row-info">
                <div class="settings-row-label">${this.escapeHtml(item.label)}</div>
                <div class="settings-row-desc">${this.escapeHtml(item.description)}</div>
              </div>
              <label class="settings-toggle">
                <input type="checkbox" data-setting="${item.key}" ${checked} />
                <span class="settings-toggle-track"></span>
                <span class="settings-toggle-thumb"></span>
              </label>
            </div>`;
        }
      }
      html += `</div>`;
    }

    // ── Hidden Items section ──────────────────────────────
    // Build a list of all currently hidden items across all categories
    const hiddenItems = this._getHiddenItemsList();
    const hiddenMatchesFilter = !lowerFilter || 'hidden items'.includes(lowerFilter) || 'visibility'.includes(lowerFilter) || 'unhide'.includes(lowerFilter) || 'show'.includes(lowerFilter);
    if (hiddenMatchesFilter) {
      html += `<div class="settings-category">`;
      html += `<div class="settings-category-label">Hidden Items</div>`;
      if (hiddenItems.length === 0) {
        html += `<div class="settings-row"><div class="settings-row-info"><div class="settings-row-desc" style="opacity:0.5;">No hidden items. Right-click projects or categories in the sidebar to hide them.</div></div></div>`;
      } else {
        html += `<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:4px;">`;
        html += `<div class="settings-row-info" style="margin-bottom:4px;"><div class="settings-row-desc">${hiddenItems.length} hidden item${hiddenItems.length !== 1 ? 's' : ''}. Click the eye icon to unhide.</div></div>`;
        for (const item of hiddenItems) {
          html += `
            <div class="settings-hidden-item" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface0);border-radius:6px;">
              <span class="settings-hidden-item-type" style="font-size:10px;text-transform:uppercase;opacity:0.5;min-width:60px;">${this.escapeHtml(item.type)}</span>
              <span class="settings-hidden-item-name" style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(item.name)}</span>
              <button class="btn btn-ghost btn-icon btn-sm settings-unhide-btn" data-unhide-type="${item.type}" data-unhide-id="${this.escapeHtml(item.id)}" title="Unhide" style="opacity:0.5;flex-shrink:0;">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3C4.5 3 1.7 5.1 1 8c.7 2.9 3.5 5 7 5s6.3-2.1 7-5c-.7-2.9-3.5-5-7-5zm0 8a3 3 0 110-6 3 3 0 010 6zm0-5a2 2 0 100 4 2 2 0 000-4z"/></svg>
              </button>
            </div>`;
        }
        // Unhide All button
        html += `<button class="btn btn-ghost btn-sm settings-unhide-all-btn" style="margin-top:4px;font-size:11px;opacity:0.7;">Unhide All</button>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    // ── Providers section placeholder (Phase 18-03) ─────────
    // The Providers section is rendered asynchronously after the main
    // innerHTML assignment because _renderProvidersSection may need to
    // fetch state.providers if it has not been hydrated yet. The
    // placeholder is a stable DOM anchor that gets swapped out via
    // outerHTML once the async render resolves. Honors the search
    // filter: when the filter excludes the section, the placeholder is
    // simply removed (no flash of empty content).
    html += `<div id="settings-providers-placeholder"></div>`;

    this.els.settingsBody.innerHTML = html;

    // alpha.9: build the left-side category nav rail. After the Providers
    // section async-renders below, we re-build the rail so the Providers
    // entry shows up. Empty filter case is handled there too.
    this._buildSettingsNav(Object.keys(groups));

    // Kick off async Providers section render. Fire-and-forget so the
    // synchronous render path is unblocked; the placeholder fills in
    // when the promise resolves. Errors are swallowed (loadProviders
    // already logs); a missing section is a soft degradation.
    this._renderProvidersSection(lowerFilter).then(providersHtml => {
      const placeholder = document.getElementById('settings-providers-placeholder');
      if (!placeholder) return;
      if (providersHtml) {
        // outerHTML swap is atomic at paint time; the placeholder is
        // replaced wholesale by the rendered section.
        placeholder.outerHTML = providersHtml;
        // Bind the toggle change handlers on the freshly rendered
        // checkboxes. Each tile carries data-provider-toggle="<id>"; the
        // handler reads the id off the dataset and routes through
        // _handleProviderToggleChange which owns the modal flow + PUT.
        this.els.settingsBody.querySelectorAll('input[data-provider-toggle]').forEach(input => {
          input.addEventListener('change', (e) => this._handleProviderToggleChange(e));
        });
        // alpha.9: providers section landed — append it to the rail and
        // mark the section element with the slug id so click/spy work.
        const section = this.els.settingsBody.querySelector('.settings-category[data-section="providers"]');
        if (section) {
          section.id = 'settings-cat-providers';
          section.dataset.category = 'Providers';
        }
        const allCats = Array.from(this.els.settingsBody.querySelectorAll('.settings-category'))
          .map(el => el.dataset.category)
          .filter(Boolean);
        this._buildSettingsNav(allCats);
      } else {
        // Filter excluded the section or no providers loaded; remove the
        // placeholder so the DOM stays clean.
        placeholder.remove();
      }
    }).catch(err => {
      console.warn('[settings-providers] render failed:', err);
      const placeholder = document.getElementById('settings-providers-placeholder');
      if (placeholder) placeholder.remove();
    });

    // ── Hidden items event bindings ────────────────────────
    this.els.settingsBody.querySelectorAll('.settings-unhide-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.unhideType;
        const id = btn.dataset.unhideId;
        this._unhideItem(type, id);
        // Re-render settings to update the hidden items list
        const filter = this.els.settingsSearchInput ? this.els.settingsSearchInput.value : '';
        this.renderSettingsBody(filter);
      });
    });
    const unhideAllBtn = this.els.settingsBody.querySelector('.settings-unhide-all-btn');
    if (unhideAllBtn) {
      unhideAllBtn.addEventListener('click', () => {
        this._unhideAllItems();
        const filter = this.els.settingsSearchInput ? this.els.settingsSearchInput.value : '';
        this.renderSettingsBody(filter);
      });
    }

    // ── Named tunnel controls ──────────────────────────────
    const ntStatus = document.getElementById('named-tunnel-status');
    const ntTokenInput = document.getElementById('named-tunnel-token-input');
    const ntSaveBtn = document.getElementById('named-tunnel-save-btn');
    const ntStartBtn = document.getElementById('named-tunnel-start-btn');
    const ntStopBtn = document.getElementById('named-tunnel-stop-btn');
    const ntAutoStart = document.getElementById('named-tunnel-autostart');

    const loadNamedTunnelStatus = async () => {
      try {
        const r = await fetch('/api/tunnel/named', { headers: { Authorization: 'Bearer ' + this.state.token } });
        const d = await r.json();
        if (ntStatus) {
          const dot = d.running ? (d.status === 'connected' ? '🟢' : '🟡') : (d.configured ? '⚫' : '⚪');
          const label = d.running ? d.status : (d.configured ? 'stopped (token saved)' : 'not configured');
          ntStatus.textContent = dot + ' ' + label;
        }
        if (ntAutoStart) ntAutoStart.checked = !!d.autoStart;
        if (ntStartBtn) ntStartBtn.disabled = d.running;
        if (ntStopBtn) ntStopBtn.disabled = !d.running;
      } catch (_) {}
    };
    if (ntStatus) loadNamedTunnelStatus();

    if (ntSaveBtn) {
      ntSaveBtn.addEventListener('click', async () => {
        const token = ntTokenInput ? ntTokenInput.value.trim() : '';
        if (!token) { this.showToast('Paste a tunnel token first', 'error'); return; }
        ntSaveBtn.textContent = 'Saving...';
        ntSaveBtn.disabled = true;
        try {
          const r = await fetch('/api/tunnel/named/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.state.token },
            body: JSON.stringify({ token }),
          });
          const d = await r.json();
          if (d.error) { this.showToast(d.error, 'error'); return; }
          if (ntTokenInput) ntTokenInput.value = '';
          this.showToast('Tunnel token saved', 'success');
          await loadNamedTunnelStatus();
        } catch (_) {
          this.showToast('Failed to save token', 'error');
        } finally {
          ntSaveBtn.textContent = 'Save';
          ntSaveBtn.disabled = false;
        }
      });
    }

    if (ntStartBtn) {
      ntStartBtn.addEventListener('click', async () => {
        ntStartBtn.disabled = true;
        ntStartBtn.textContent = 'Starting...';
        try {
          const r = await fetch('/api/tunnel/named/start', { method: 'POST', headers: { Authorization: 'Bearer ' + this.state.token } });
          const d = await r.json();
          if (d.error) this.showToast(d.error, 'error');
          else this.showToast('Tunnel connecting...', 'info');
          await loadNamedTunnelStatus();
        } catch (_) {
          this.showToast('Failed to start tunnel', 'error');
        } finally {
          ntStartBtn.textContent = 'Start';
          ntStartBtn.disabled = false;
        }
      });
    }

    if (ntStopBtn) {
      ntStopBtn.addEventListener('click', async () => {
        ntStopBtn.disabled = true;
        try {
          await fetch('/api/tunnel/named/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + this.state.token } });
          this.showToast('Tunnel stopped', 'info');
          await loadNamedTunnelStatus();
        } catch (_) {} finally {
          ntStopBtn.disabled = false;
        }
      });
    }

    if (ntAutoStart) {
      ntAutoStart.addEventListener('change', async () => {
        await fetch('/api/tunnel/named/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.state.token },
          body: JSON.stringify({ autoStart: ntAutoStart.checked }),
        });
      });
    }

    // Bind toggle change events
    this.els.settingsBody.querySelectorAll('input[data-setting]').forEach(input => {
      input.addEventListener('change', (e) => {
        const key = e.target.dataset.setting;
        this.state.settings[key] = e.target.checked;
        this.saveSettings();
        this.applySettings();
      });
    });

    // Bind UI scale buttons
    this.els.settingsBody.querySelectorAll('.settings-scale-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.scaleUI(btn.dataset.scaleDir);
        // Re-render to update the percentage display
        const filter = this.els.settingsSearchInput ? this.els.settingsSearchInput.value : '';
        this.renderSettingsBody(filter);
      });
    });

    // Bind slider input change events
    this.els.settingsBody.querySelectorAll('input[data-setting-slider]').forEach(input => {
      input.addEventListener('input', (e) => {
        const key = e.target.dataset.settingSlider;
        const val = parseInt(e.target.value, 10) || 0;
        this.state.settings[key] = val;
        
        const registryItem = this.getSettingsRegistry().find(r => r.key === key);
        const unit = registryItem?.unit || '';
        
        const valSpan = document.getElementById(`slider-val-${key}`);
        if (valSpan) valSpan.textContent = val + unit;

        this.applySettings(); // Apply immediately for preview
      });
      input.addEventListener('change', (e) => {
        this.saveSettings(); // Save only when sliding stops
      });
    });

    // Bind number input change events
    this.els.settingsBody.querySelectorAll('input[data-setting-num]').forEach(input => {
      input.addEventListener('change', (e) => {
        const key = e.target.dataset.settingNum;
        this.state.settings[key] = parseInt(e.target.value, 10) || 0;
        this.saveSettings();
        this.applySettings();
      });
    });

    // Bind select input change events
    this.els.settingsBody.querySelectorAll('select[data-setting-select]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const key = e.target.dataset.settingSelect;
        this.state.settings[key] = e.target.value;
        this.saveSettings();
        this.applySettings();
      });
    });

    // Bind server-text Save buttons (settings persisted server-side)
    this.els.settingsBody.querySelectorAll('.settings-server-text-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const inputId = btn.dataset.inputId;
        const input = document.getElementById(inputId);
        if (!input) return;
        const endpoint = input.dataset.apiEndpoint;
        const field = input.dataset.apiField || 'value';
        const statusEl = document.getElementById('server-text-status-' + inputId.replace('server-text-', ''));
        btn.disabled = true;
        try {
          const result = await this.api('PUT', endpoint, { [field]: input.value.trim() });
          if (statusEl) {
            statusEl.textContent = result.available ? '✓ found' : '⚠ not found';
            statusEl.style.color = result.available ? 'var(--green)' : 'var(--yellow)';
          }
          this.showToast('Setting saved', 'success');
        } catch (err) {
          if (statusEl) { statusEl.textContent = '✗ error'; statusEl.style.color = 'var(--red)'; }
          this.showToast(err.message || 'Failed to save', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Load current server-text values from their respective API endpoints
    this.els.settingsBody.querySelectorAll('.settings-server-text-input').forEach(async input => {
      const endpoint = input.dataset.apiEndpoint;
      const field = input.dataset.apiField || 'value';
      const key = input.id.replace('server-text-', '');
      const statusEl = document.getElementById('server-text-status-' + key);
      try {
        const result = await this.api('GET', endpoint);
        input.value = result[field] || '';
        if (statusEl) {
          statusEl.textContent = result.available ? '✓ found' : '⚠ not on PATH';
          statusEl.style.color = result.available ? 'var(--green)' : 'var(--yellow)';
        }
      } catch (_) {
        if (statusEl) { statusEl.textContent = 'could not load'; }
      }
    });
  }

  /** Filter settings from search input */
  filterSettings() {
    const val = this.els.settingsSearchInput ? this.els.settingsSearchInput.value : '';
    this.renderSettingsBody(val);
  }

  /**
   * Slugify a category name for use as a DOM id. Lowercases, replaces
   * non-alphanumeric runs with single hyphens, strips leading/trailing
   * hyphens. Stable: same input always yields the same slug. Plan
   * alpha.9 nav rail.
   *
   * @param {string} category
   * @returns {string}
   */
  _settingsCategorySlug(category) {
    return String(category || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'misc';
  }

  /**
   * Build the left-side category rail (alpha.9). Idempotent: replaces
   * the rail's innerHTML and re-binds click handlers each call.
   *
   * Click → smooth-scroll the body to the matching #settings-cat-<slug>
   *   section. A ResizeObserver-driven scroll-spy keeps the active item
   *   highlighted as the user scrolls.
   *
   * @param {string[]} categories - ordered list of category names from
   *   the rendered body (sync + async sections combined).
   */
  _buildSettingsNav(categories) {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;
    if (!Array.isArray(categories) || categories.length === 0) {
      nav.innerHTML = '';
      return;
    }
    // Deduplicate while preserving order.
    const seen = new Set();
    const ordered = categories.filter(c => {
      if (!c || seen.has(c)) return false;
      seen.add(c);
      return true;
    });
    nav.innerHTML = ordered.map(cat => {
      const slug = this._settingsCategorySlug(cat);
      return `<button class="settings-nav-item" data-slug="${this.escapeHtml(slug)}" type="button">${this.escapeHtml(cat)}</button>`;
    }).join('');

    nav.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const slug = btn.dataset.slug;
        const target = document.getElementById('settings-cat-' + slug);
        if (target && this.els.settingsBody) {
          // smooth-scroll inside the settings body, not the page
          this.els.settingsBody.scrollTo({
            top: target.offsetTop - 8,
            behavior: 'smooth',
          });
        }
      });
    });

    // Mark the first visible item as active so the rail has an anchor
    // before the user scrolls.
    const firstBtn = nav.querySelector('.settings-nav-item');
    if (firstBtn) firstBtn.classList.add('is-active');

    // Wire scroll-spy once per settings open. The handler is throttled
    // via requestAnimationFrame so smooth-scroll animations don't peg
    // the main thread.
    if (!this._settingsScrollSpyBound && this.els.settingsBody) {
      this._settingsScrollSpyBound = true;
      let ticking = false;
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          this._updateSettingsActiveNavItem();
          ticking = false;
        });
      };
      this.els.settingsBody.addEventListener('scroll', onScroll, { passive: true });
    }
  }

  /**
   * Scroll-spy: find the topmost category section currently in view
   * inside the settings body and mark its rail item is-active.
   * Plan alpha.9 nav rail.
   */
  _updateSettingsActiveNavItem() {
    const body = this.els.settingsBody;
    const nav = document.getElementById('settings-nav');
    if (!body || !nav) return;
    const bodyTop = body.getBoundingClientRect().top;
    const sections = body.querySelectorAll('.settings-category');
    let active = null;
    for (const sec of sections) {
      const rect = sec.getBoundingClientRect();
      // Section counts as "active" once its top crosses 60px below the
      // settings body's top edge.
      if (rect.top - bodyTop <= 60) active = sec;
      else break;
    }
    if (!active) active = sections[0];
    if (!active) return;
    const slug = active.id.replace(/^settings-cat-/, '');
    nav.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.slug === slug);
    });
  }

  /** Apply current settings to the UI (CSS classes, visibility toggles) */
  applySettings() {
    const html = document.documentElement;

    // Header height
    if (this.state.settings.headerHeight !== undefined) {
      html.style.setProperty('--header-height', `${this.state.settings.headerHeight}px`);
    }

    // Pane color highlights
    html.classList.toggle('pane-colors-enabled', !!this.state.settings.paneColorHighlights);

    // Activity indicators
    html.classList.toggle('activity-indicators-disabled', !this.state.settings.activityIndicators);

    // Session count in header
    const headerStats = document.getElementById('header-stats');
    if (headerStats) {
      headerStats.style.display = this.state.settings.sessionCountInHeader ? '' : 'none';
    }

    // Sync auto-trust setting to all open terminals
    const autoTrust = !!this.state.settings.autoTrustDialogs;
    this.terminalPanes.forEach(tp => {
      if (tp) tp._autoTrustEnabled = autoTrust;
    });

    // Re-render sidebar to update pane color pips
    if (typeof this.renderWorkspaces === 'function') {
      this.renderWorkspaces();
    }

    // td integration: show/hide sidebar mode toggle based on enableTd setting
    const tdEnabled = !!this.getSetting('enableTd');
    if (this.els.sidebarTasksHeader) {
      // Only visible when in tasks view AND td is enabled
      const inTasksView = this._sidebarView === 'tasks';
      this.els.sidebarTasksHeader.hidden = !(tdEnabled && inTasksView);
    }
    // If td was just disabled while in td mode, revert to native mode
    if (!tdEnabled && this._sidebarTasksMode === 'td') {
      this._setSidebarTasksMode('native');
    }
    // Reload td docs section if currently visible
    if (typeof this.loadTdIssues === 'function') {
      this.loadTdIssues();
    }

  }


  /* ═══════════════════════════════════════════════════════════
     TASKS VIEW
     Renders worktree tasks in two layout modes:
     - List: vertical groups (Active, Review, Completed)
     - Board: horizontal kanban columns (Backlog, Running, Review, Done)
     Supports drag-and-drop between kanban columns.
     ═══════════════════════════════════════════════════════════ */

  /** Toggle between board and list layout for the tasks view */
  /** Switch sidebar between Projects and Tasks views */
  setSidebarView(view) {
    this._sidebarView = view;

    // Update toggle buttons
    if (this.els.sidebarViewToggle) {
      this.els.sidebarViewToggle.querySelectorAll('.sidebar-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sidebarView === view);
      });
    }

    const isProjects = view === 'projects';

    // Toggle Projects section visibility
    if (this.els.sidebarProjectsHeader) this.els.sidebarProjectsHeader.hidden = !isProjects;
    if (this.els.workspaceList) this.els.workspaceList.hidden = !isProjects;
    if (document.getElementById('sidebar-meta')) document.getElementById('sidebar-meta').hidden = !isProjects;

    // Toggle sidebar tasks visibility
    if (this.els.sidebarTasksList) {
      this.els.sidebarTasksList.hidden = isProjects;
    }

    // Show tasks header (mode toggle) only when td is enabled and tasks view is active
    if (this.els.sidebarTasksHeader) {
      const showHeader = !isProjects && this.getSetting('enableTd');
      this.els.sidebarTasksHeader.hidden = !showHeader;
    }

    if (!isProjects) {
      // Render whichever mode is active
      const mode = this._sidebarTasksMode || 'native';
      if (mode === 'td') {
        this.renderSidebarTdIssues();
      } else {
        this.renderSidebarTasks();
      }
    }
  }

  /** Render a compact task list in the sidebar */
  async renderSidebarTasks() {
    if (!this.els.sidebarTasksList) return;

    try {
      const data = await this.api('GET', '/api/worktree-tasks');
      const tasks = data.tasks || [];

      if (tasks.length === 0) {
        this.els.sidebarTasksList.innerHTML = '<div style="padding:16px;color:var(--overlay0);font-size:12px;text-align:center;">No tasks yet</div>';
        return;
      }

      // Sort: running first, then review, then backlog, then completed
      const order = { running: 0, active: 0, planning: 1, review: 2, backlog: 3, pending: 3, completed: 4, merged: 4, rejected: 5 };
      tasks.sort((a, b) => (order[a.status] || 4) - (order[b.status] || 4));

      this.els.sidebarTasksList.innerHTML = tasks.map(t => {
        let dotClass = 'completed';
        if (t.status === 'running' || t.status === 'active') dotClass = 'busy';
        else if (t.status === 'planning') dotClass = 'waiting';
        else if (t.status === 'review') dotClass = 'review';
        else if (t.status === 'backlog' || t.status === 'pending') dotClass = 'ready';

        const name = t.branch ? t.branch.replace(/^feat\//, '') : (t.description || t.id);
        return `<div class="task-item" data-task-id="${t.id}" data-session-id="${t.sessionId || ''}" style="padding:6px 12px;">
          <span class="task-item-dot ${dotClass}"></span>
          <span class="task-item-branch" style="font-size:12px;">${this.escapeHtml(name)}</span>
        </div>`;
      }).join('');

      // Wire click to switch to kanban
      this.els.sidebarTasksList.querySelectorAll('.task-item').forEach(el => {
        el.addEventListener('click', () => {
          this.setViewMode('tasks');
        });
      });
    } catch (_) {
      this.els.sidebarTasksList.innerHTML = '<div style="padding:16px;color:var(--overlay0);font-size:11px;">Failed to load tasks</div>';
    }
  }

  /**
   * Switch the sidebar tasks panel between native tasks and td issues.
   * @param {'native'|'td'} mode
   */
  _setSidebarTasksMode(mode) {
    this._sidebarTasksMode = mode;

    // Update toggle button state
    if (this.els.sidebarTasksModeToggle) {
      this.els.sidebarTasksModeToggle.querySelectorAll('.sidebar-tasks-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tasksMode === mode);
      });
    }

    if (mode === 'td') {
      this.renderSidebarTdIssues();
    } else {
      this.renderSidebarTasks();
    }
  }

  /** Render td issues list in the sidebar tasks panel. */
  async renderSidebarTdIssues() {
    if (!this.els.sidebarTasksList) return;

    // Use cached issues if available, otherwise fetch
    const ws = this.state.activeWorkspace;
    if (!ws) {
      this.els.sidebarTasksList.innerHTML = '<div style="padding:16px;color:var(--overlay0);font-size:12px;text-align:center;">No active project</div>';
      return;
    }

    this.els.sidebarTasksList.innerHTML = '<div style="padding:16px;color:var(--overlay0);font-size:12px;">Loading td issues…</div>';

    try {
      const data = await this.api('GET', `/api/workspaces/${ws.id}/td/issues`);
      const issues = data.issues || [];

      // Clear
      while (this.els.sidebarTasksList.firstChild) {
        this.els.sidebarTasksList.removeChild(this.els.sidebarTasksList.firstChild);
      }

      if (issues.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:16px;color:var(--overlay0);font-size:12px;text-align:center;';
        empty.textContent = 'No open td issues';
        this.els.sidebarTasksList.appendChild(empty);
        return;
      }

      for (const issue of issues) {
        const id = issue.id;
        const status = issue.status || 'open';
        const title = issue.title || id;

        const row = document.createElement('div');
        row.className = 'sidebar-td-item';
        row.title = title;

        const dot = document.createElement('span');
        dot.className = 'td-status-dot ' + status;
        row.appendChild(dot);

        const idEl = document.createElement('span');
        idEl.className = 'td-issue-id';
        idEl.textContent = id;
        row.appendChild(idEl);

        const titleEl = document.createElement('span');
        titleEl.className = 'td-issue-title';
        titleEl.textContent = title;
        row.appendChild(titleEl);

        row.addEventListener('click', () => this.openTdIssueModal(id));

        this.els.sidebarTasksList.appendChild(row);
      }
    } catch (_) {
      this.els.sidebarTasksList.innerHTML = '<div style="padding:16px;color:var(--overlay0);font-size:11px;">Failed to load td issues</div>';
    }
  }

  _initTasksTabs() {
    const strip = document.getElementById('tasks-tab-strip');
    if (!strip || strip._tabsWired) return;
    strip._tabsWired = true;

    // Show td tab only when enableTd is on
    const tdTab = document.getElementById('tasks-tab-td');
    if (tdTab) tdTab.hidden = !this.getSetting('enableTd');

    strip.addEventListener('click', e => {
      const tab = e.target.closest('.tasks-tab');
      if (!tab) return;
      const name = tab.dataset.tasksTab;
      this._switchTasksTab(name);
    });

    // Restore persisted tab
    const saved = localStorage.getItem('cwm_tasksTab') || 'worktree';
    this._switchTasksTab(saved);
  }

  _switchTasksTab(name) {
    const strip = document.getElementById('tasks-tab-strip');
    if (!strip) return;

    // Guard: prompt before leaving files tab with unsaved changes
    if (this._activeTasksTab === 'files' && name !== 'files' && this._filesEditorDirty) {
      const ok = window.confirm('Unsaved changes in ' + this._filesEditorCurrentFile + '. Discard?');
      if (!ok) return;
      this._filesEditorDirty = false;
    }

    // Update tab buttons
    strip.querySelectorAll('.tasks-tab').forEach(t => {
      const active = t.dataset.tasksTab === name;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active);
    });

    // Show/hide panels
    document.querySelectorAll('.tasks-tab-panel').forEach(p => {
      p.hidden = p.dataset.tasksTab !== name;
    });

    // Show worktree header controls only on worktree tab
    const headerActions = document.querySelector('.tasks-header-actions');
    if (headerActions) headerActions.hidden = name !== 'worktree';

    localStorage.setItem('cwm_tasksTab', name);
    this._activeTasksTab = name;

    // Trigger data load for the active tab
    if (name === 'worktree') this.renderTasksView();
    if (name === 'td') this.renderTasksTdPanel();
    if (name === 'git') {
      this.renderTasksGitPanel();
      // Start auto-refresh every 10 seconds while git tab is active
      if (this._gitRefreshTimer) clearInterval(this._gitRefreshTimer);
      this._gitRefreshTimer = setInterval(() => {
        if (this._activeTasksTab === 'git') this.renderTasksGitPanel();
      }, 10000);
    } else {
      // Clear git refresh timer when switching away from git tab
      if (this._gitRefreshTimer) {
        clearInterval(this._gitRefreshTimer);
        this._gitRefreshTimer = null;
      }
    }
    if (name === 'files') this.renderTasksFilesPanel();
  }

  /**
   * Render the project switcher toolbar inside a td panel toolbar element.
   * Populates a <select> from this._tdProjects (loaded async).
   * @param {HTMLElement} toolbar
   * @param {string} currentDir - the currently shown repo dir
   */
  _renderTdToolbar(toolbar, currentDir) {
    toolbar.textContent = '';
    const label = document.createElement('span');
    label.className = 'tasks-td-toolbar-label';
    label.textContent = 'Project';
    toolbar.appendChild(label);

    const sel = document.createElement('select');
    sel.className = 'tasks-td-project-select';

    const projects = this._tdProjects || [];

    // Always include the current dir even if not yet in projects list
    const allDirs = new Map();
    allDirs.set(currentDir, this._tdProjectName(currentDir));
    for (const p of projects) allDirs.set(p.repoDir, p.name || this._tdProjectName(p.repoDir));

    for (const [dir, name] of allDirs) {
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = name;
      opt.selected = dir === currentDir;
      sel.appendChild(opt);
    }

    sel.addEventListener('change', () => {
      this._tdPanelDir = sel.value;
      // Mark as manually pinned so pane focus changes don't override the selection
      this._tdPanelDirPinned = (sel.value !== this._getTdPanelDir());
      this.renderTasksTdPanel();
    });

    toolbar.appendChild(sel);

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-ghost btn-icon btn-sm tasks-td-refresh';
    refreshBtn.title = 'Refresh';
    refreshBtn.innerHTML = '&#8635;';
    refreshBtn.addEventListener('click', () => this.renderTasksTdPanel());
    toolbar.appendChild(refreshBtn);
  }

  /** Extract a short project name from a directory path */
  _tdProjectName(dir) {
    if (!dir) return '(unknown)';
    return dir.split('/').filter(Boolean).pop() || dir;
  }

  /**
   * Resolve the td repo dir for the currently focused terminal pane.
   * Falls back to the active workspace's resolved dir.
   * Returns null if nothing useful found.
   */
  _getTdPanelDir() {
    // 1. Prefer the focused terminal pane's working dir
    const slot = this._activeTerminalSlot;
    const tp = slot !== null ? this.terminalPanes[slot] : null;
    if (tp && tp.spawnOpts && tp.spawnOpts.cwd) return tp.spawnOpts.cwd;
    // 2. Fall back to any open pane's cwd
    for (const p of this.terminalPanes) {
      if (p && p.spawnOpts && p.spawnOpts.cwd) return p.spawnOpts.cwd;
    }
    return null;
  }

  async renderTasksTdPanel(container = null) {
    const panel = container || document.getElementById('tasks-td-panel');
    if (!panel) return;
    if (!this.getSetting('enableTd')) return;

    const showPlaceholder = (msg, isError) => {
      panel.textContent = '';
      const el = document.createElement('div');
      el.className = isError ? 'tasks-placeholder tasks-placeholder--error' : 'tasks-placeholder';
      el.textContent = msg;
      panel.appendChild(el);
    };

    // Determine which dir to show: manually selected > active pane > nothing
    const autoDir = this._getTdPanelDir();
    if (!this._tdPanelDir && autoDir) this._tdPanelDir = autoDir;
    const dir = this._tdPanelDir;

    if (!dir) {
      showPlaceholder('Open a project in a terminal pane to see its td issues', false);
      return;
    }

    showPlaceholder('Loading td issues\u2026', false);

    // Load projects list for dropdown (non-blocking, updates after issues load)
    this.api('GET', '/api/td/projects').then(projectsData => {
      this._tdProjects = projectsData.projects || [];
      // Re-render toolbar if panel is still showing the td view
      const toolbar = panel.querySelector('.tasks-td-toolbar');
      if (toolbar) this._renderTdToolbar(toolbar, dir);
    }).catch(() => {});

    try {
      const data = await this.api('GET', `/api/td/issues?dir=${encodeURIComponent(dir)}`);
      const issues = data.issues || [];

      panel.textContent = '';
      const toolbar = document.createElement('div');
      toolbar.className = 'tasks-td-toolbar';
      this._renderTdToolbar(toolbar, dir);
      panel.appendChild(toolbar);

      if (issues.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tasks-placeholder';
        empty.textContent = 'No open td issues for this project';
        panel.appendChild(empty);
        return;
      }

      // Group by status in display order
      const STATUS_ORDER = ['in_progress', 'in_review', 'blocked', 'open'];
      const STATUS_LABELS = {
        in_progress: 'In Progress',
        in_review: 'In Review',
        blocked: 'Blocked',
        open: 'Open',
      };
      const groups = {};
      for (const issue of issues) {
        const s = issue.status || 'open';
        if (!groups[s]) groups[s] = [];
        groups[s].push(issue);
      }

      // Sort each group by priority (P0 first)
      const priorityRank = p => ({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 })[p] ?? 5;
      for (const s of Object.keys(groups)) {
        groups[s].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
      }

      const orderedStatuses = [
        ...STATUS_ORDER.filter(s => groups[s]?.length),
        ...Object.keys(groups).filter(s => !STATUS_ORDER.includes(s) && groups[s]?.length),
      ];

      for (const status of orderedStatuses) {
        const groupIssues = groups[status];

        // Section header
        const header = document.createElement('div');
        header.className = 'tasks-td-group-header';
        const label = document.createElement('span');
        label.textContent = STATUS_LABELS[status] || status;
        const count = document.createElement('span');
        count.className = 'tasks-td-group-count';
        count.textContent = groupIssues.length;
        header.append(label, count);
        panel.appendChild(header);

        for (const issue of groupIssues) {
          const row = document.createElement('div');
          row.className = 'tasks-td-row';

          const dot = document.createElement('span');
          dot.className = 'td-status-dot ' + status;

          const idEl = document.createElement('span');
          idEl.className = 'td-issue-id';
          idEl.textContent = issue.id;

          const titleEl = document.createElement('span');
          titleEl.className = 'td-issue-title';
          titleEl.textContent = issue.title || issue.id;

          row.append(dot, idEl, titleEl);

          if (issue.priority) {
            const pri = document.createElement('span');
            pri.className = 'td-priority-badge priority-' + issue.priority.toLowerCase();
            pri.textContent = issue.priority;
            row.appendChild(pri);
          }

          row.addEventListener('click', () => this.openTdIssueModal(issue.id));
          panel.appendChild(row);
        }
      }
    } catch (err) {
      const msg = err.message || 'unknown error';
      if (msg.includes('not initialized')) {
        // td isn't initialized — show a helpful prompt rather than a raw error
        panel.textContent = '';
        const toolbar = document.createElement('div');
        toolbar.className = 'tasks-td-toolbar';
        this._renderTdToolbar(toolbar, dir);
        panel.appendChild(toolbar);
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 24px;';
        const info = document.createElement('div');
        info.className = 'tasks-placeholder';
        info.style.position = 'static';
        info.textContent = 'td is not initialized for this project.';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:12px;color:var(--subtext0);text-align:center;';
        hint.textContent = 'Run td init in the project root to enable task tracking.';
        const initBtn = document.createElement('button');
        initBtn.className = 'btn btn-primary btn-sm';
        initBtn.textContent = 'Run td init';
        initBtn.addEventListener('click', async () => {
          initBtn.disabled = true;
          initBtn.textContent = 'Initializing\u2026';
          try {
            // Use the workspace-scoped init if we can find the ws, otherwise use the dir directly
            const ws = this.state.activeWorkspace;
            if (ws) {
              await this.api('POST', `/api/workspaces/${ws.id}/td/init`, { repoDir: dir });
            } else {
              // Fallback: run td init via a generic endpoint if workspace isn't known
              throw new Error('No active workspace to run td init against. Run `td init` manually in ' + dir);
            }
            this.renderTasksTdPanel();
          } catch (e) {
            initBtn.disabled = false;
            initBtn.textContent = 'Run td init';
            info.textContent = 'td init failed: ' + (e.message || 'unknown error');
          }
        });
        wrap.appendChild(info);
        wrap.appendChild(hint);
        wrap.appendChild(initBtn);
        panel.appendChild(wrap);
      } else {
        showPlaceholder('Failed to load td issues: ' + msg, true);
      }
    }
  }

  // ── Files Tab ─────────────────────────────────────────────────────────────

  /**
   * Render the Files tab panel for the currently active workspace.
   * Builds a two-pane layout: file tree sidebar on left, editor pane on right.
   * Skips re-initialization if already rendered for the same workspace.
   */
  async renderTasksFilesPanel(container = null) {
    const panel = container || document.getElementById('tasks-files-panel');
    if (!panel) return;

    const ws = this.state.activeWorkspace;
    if (!ws) {
      panel.replaceChildren();
      const placeholder = document.createElement('div');
      placeholder.className = 'tasks-placeholder';
      placeholder.textContent = 'No active project selected';
      panel.appendChild(placeholder);
      return;
    }

    // Avoid re-init if already rendered for this workspace
    if (panel._wsId === ws.id && panel.querySelector('.files-container')) return;
    panel._wsId = ws.id;

    panel.replaceChildren();
    container = document.createElement('div');
    container.className = 'files-container';

    const sidebar = document.createElement('div');
    sidebar.className = 'files-sidebar';
    sidebar.id = 'files-tree';

    const editorPane = document.createElement('div');
    editorPane.className = 'files-editor-pane';
    editorPane.id = 'files-editor-pane';
    const editorPlaceholder = document.createElement('div');
    editorPlaceholder.className = 'tasks-placeholder';
    editorPlaceholder.textContent = 'Select a file to edit';
    editorPane.appendChild(editorPlaceholder);

    container.appendChild(sidebar);
    container.appendChild(editorPane);
    panel.appendChild(container);

    await this._loadFileTree(sidebar, ws.id, '');
  }

  /**
   * Load file tree entries for a subpath into a container element.
   * Entries are sorted dirs-first, then files, each group alphabetically.
   * @param {HTMLElement} container - Target container element
   * @param {string} workspaceId - Active workspace ID
   * @param {string} subpath - Relative subpath within workspace root
   */
  async _loadFileTree(container, workspaceId, subpath) {
    container.replaceChildren();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'tasks-placeholder';
    loadingEl.textContent = 'Loading files\u2026';
    container.appendChild(loadingEl);

    try {
      const data = await this.api('GET', `/api/files/tree?workspaceId=${encodeURIComponent(workspaceId)}&subpath=${encodeURIComponent(subpath)}`);
      container.replaceChildren();

      if (!data.entries || !data.entries.length) {
        const empty = document.createElement('div');
        empty.className = 'tasks-placeholder';
        empty.textContent = 'Empty directory';
        container.appendChild(empty);
        return;
      }

      for (const entry of data.entries) {
        const row = document.createElement('div');
        row.className = 'files-tree-row files-tree-' + entry.type;
        row.dataset.path = entry.path;
        row.dataset.type = entry.type;

        const icon = document.createElement('span');
        icon.className = 'files-tree-icon';
        icon.textContent = entry.type === 'dir' ? '\u25B6' : '\u2022';

        const name = document.createElement('span');
        name.className = 'files-tree-name';
        name.textContent = entry.name;

        row.appendChild(icon);
        row.appendChild(name);

        if (entry.type === 'dir') {
          const children = document.createElement('div');
          children.className = 'files-tree-children';
          children.hidden = true;

          row.addEventListener('click', async (e) => {
            e.stopPropagation();
            const expanded = !children.hidden;
            children.hidden = expanded;
            icon.textContent = expanded ? '\u25B6' : '\u25BC';
            if (!children.hidden && !children._loaded) {
              children._loaded = true;
              await this._loadFileTree(children, workspaceId, entry.path);
            }
          });

          container.appendChild(row);
          container.appendChild(children);
        } else {
          row.addEventListener('click', () => {
            const fileContainer = container.closest('.files-container');
            if (fileContainer) {
              fileContainer.querySelectorAll('.files-tree-row').forEach(r => r.classList.remove('active'));
            }
            row.classList.add('active');
            this._openFileInEditor(workspaceId, entry.path);
          });
          container.appendChild(row);
        }
      }
    } catch (err) {
      container.replaceChildren();
      const errEl = document.createElement('div');
      errEl.className = 'tasks-placeholder tasks-placeholder--error';
      errEl.textContent = 'Failed to load tree: ' + (err.message || 'unknown');
      container.appendChild(errEl);
    }
  }

  /**
   * Open a file in the editor pane. Prompts to discard if editor is dirty.
   * @param {string} workspaceId - Active workspace ID
   * @param {string} filePath - Relative path to the file
   */
  async _openFileInEditor(workspaceId, filePath) {
    const pane = document.getElementById('files-editor-pane');
    if (!pane) return;

    if (this._filesEditorDirty) {
      const confirmed = window.confirm('Unsaved changes in ' + this._filesEditorCurrentFile + '. Discard?');
      if (!confirmed) return;
    }

    pane.replaceChildren();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'tasks-placeholder';
    loadingEl.textContent = 'Loading file\u2026';
    pane.appendChild(loadingEl);

    try {
      const data = await this.api('GET', `/api/files/content?workspaceId=${encodeURIComponent(workspaceId)}&file=${encodeURIComponent(filePath)}`);

      pane.replaceChildren();

      const header = document.createElement('div');
      header.className = 'files-editor-header';

      const fileNameEl = document.createElement('span');
      fileNameEl.className = 'files-editor-filename';
      fileNameEl.textContent = filePath;

      const saveBtn = document.createElement('button');
      saveBtn.className = 'files-save-btn';
      saveBtn.textContent = 'Save';
      saveBtn.disabled = true;
      saveBtn.addEventListener('click', () => this._saveCurrentFile(workspaceId));

      header.appendChild(fileNameEl);
      header.appendChild(saveBtn);
      pane.appendChild(header);

      const editorContainer = document.createElement('div');
      editorContainer.className = 'files-cm-container';
      pane.appendChild(editorContainer);

      this._filesEditorDirty = false;
      this._filesEditorCurrentFile = filePath;
      this._filesEditorWorkspaceId = workspaceId;
      this._filesSaveBtn = saveBtn;
      this._filesEditorFilenameEl = fileNameEl;

      await this._initCodeMirror(editorContainer, data.content, data.language, saveBtn);

    } catch (err) {
      pane.replaceChildren();
      const errEl = document.createElement('div');
      errEl.className = 'tasks-placeholder tasks-placeholder--error';
      errEl.textContent = 'Failed to load file: ' + (err.message || 'unknown');
      pane.appendChild(errEl);
    }
  }

  /**
   * Initialize a CodeMirror 6 editor in container. Lazy-loads CM from CDN.
   * @param {HTMLElement} container - Mount point
   * @param {string} content - Initial document text
   * @param {string} language - Language hint (for future syntax extension)
   * @param {HTMLButtonElement} saveBtn - Save button to enable on change
   */
  async _initCodeMirror(container, content, language, saveBtn) {
    if (!window.__cmLoaded) {
      await this._loadCodeMirror();
    }

    const { basicSetup, EditorView, EditorState } = window.__cm;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              this._filesEditorDirty = true;
              if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.classList.add('dirty');
              }
              if (this._filesEditorFilenameEl && this._filesEditorCurrentFile) {
                if (!this._filesEditorFilenameEl.textContent.startsWith('\u2022 ')) {
                  this._filesEditorFilenameEl.textContent = '\u2022 ' + this._filesEditorCurrentFile;
                }
              }
            }
          }),
        ],
      }),
      parent: container,
    });

    this._filesEditorView = view;
  }

  /**
   * Load CodeMirror 6 from the locally-served vendor bundle.
   * The bundle is a self-contained ESM file built by esbuild so no CDN access is needed.
   * Uses a <script type="module"> tag to get a module context for the dynamic import.
   */
  _loadCodeMirror() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      const eventName = '__cm_loaded_' + Date.now();
      script.textContent = [
        "(async () => {",
        "  try {",
        "    const { basicSetup, EditorView, EditorState } = await import('/vendor/codemirror.bundle.js');",
        "    window.__cm = { basicSetup, EditorView, EditorState };",
        "    window.__cmLoaded = true;",
        `    document.dispatchEvent(new Event('${eventName}'));`,
        "  } catch(e) {",
        `    document.dispatchEvent(new CustomEvent('${eventName}_err', { detail: (e && e.message) || String(e) }));`,
        "  }",
        "})();",
      ].join('\n');
      document.addEventListener(eventName, resolve, { once: true });
      document.addEventListener(eventName + '_err', (e) => reject(new Error(e.detail || 'CodeMirror failed to load')), { once: true });
      document.head.appendChild(script);
    });
  }

  /**
   * Save the current file. Shows Saving… / Saved ✓ / Save failed feedback.
   * @param {string} [workspaceId] - Falls back to tracked _filesEditorWorkspaceId
   */
  async _saveCurrentFile(workspaceId) {
    const ws = workspaceId || this._filesEditorWorkspaceId;
    const file = this._filesEditorCurrentFile;
    const view = this._filesEditorView;

    if (!ws || !file || !view) return;

    const content = view.state.doc.toString();

    try {
      if (this._filesSaveBtn) {
        this._filesSaveBtn.disabled = true;
        this._filesSaveBtn.textContent = 'Saving\u2026';
      }

      await this.api('POST', '/api/files/save', { workspaceId: ws, file, content });

      this._filesEditorDirty = false;
      if (this._filesSaveBtn) {
        this._filesSaveBtn.classList.remove('dirty');
        this._filesSaveBtn.textContent = 'Saved \u2713';
        setTimeout(() => {
          if (this._filesSaveBtn) {
            this._filesSaveBtn.textContent = 'Save';
            this._filesSaveBtn.disabled = !this._filesEditorDirty;
          }
        }, 1500);
      }
      if (this._filesEditorFilenameEl && this._filesEditorCurrentFile) {
        this._filesEditorFilenameEl.textContent = this._filesEditorCurrentFile;
      }
    } catch (err) {
      if (this._filesSaveBtn) {
        this._filesSaveBtn.disabled = false;
        this._filesSaveBtn.textContent = 'Save failed';
        setTimeout(() => {
          if (this._filesSaveBtn) this._filesSaveBtn.textContent = 'Save';
        }, 2000);
      }
      console.error('Save failed:', err);
      alert('Save failed: ' + (err.message || 'unknown error'));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  setTasksLayout(layout) {
    this._tasksLayout = layout;
    localStorage.setItem('cwm_tasksLayout', layout);

    // Update toggle buttons
    if (this.els.tasksLayoutToggle) {
      this.els.tasksLayoutToggle.querySelectorAll('.tasks-layout-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.layout === layout);
      });
    }

    // Show/hide the right container
    if (this.els.tasksList) this.els.tasksList.style.display = layout === 'list' ? '' : 'none';
    if (this.els.kanbanBoard) this.els.kanbanBoard.style.display = layout === 'board' ? '' : 'none';

    // Re-render with cached data if available
    if (this._worktreeTaskCache) {
      if (layout === 'board') {
        this._renderKanbanBoard(this._worktreeTaskCache);
      } else {
        this._renderTasksList(this._worktreeTaskCache);
      }
    }
  }

  /**
   * Render the Git tab panel.
   * Shows a two-pane layout: left pane has branch indicator, file status list,
   * and commit log; right pane shows diff for the selected file.
   * Includes 10-second auto-refresh when the tab is active.
   */
  async renderTasksGitPanel(container = null) {
    const panel = container || document.getElementById('tasks-git-panel');
    if (!panel) return;

    const ws = this.state.activeWorkspace;
    if (!ws) {
      panel.textContent = '';
      const pl = document.createElement('div');
      pl.className = 'tasks-placeholder';
      pl.textContent = 'No active project selected';
      panel.appendChild(pl);
      return;
    }

    panel.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'tasks-placeholder';
    loading.textContent = 'Loading git status\u2026';
    panel.appendChild(loading);

    try {
      const status = await this.api('GET', `/api/git/status?workspaceId=${ws.id}`);

      panel.textContent = '';

      container = document.createElement('div');
      container.className = 'git-panel-container';

      const left = document.createElement('div');
      left.className = 'git-panel-left';
      left.id = 'git-status-list';

      // On auto-refresh, preserve the existing right pane so the visible diff
      // isn't wiped while the user is reading it. Clone children via DOM (no innerHTML).
      const existingRight = document.getElementById('git-diff-viewer');
      const hasContent = existingRight &&
        existingRight.children.length &&
        !existingRight.querySelector('.tasks-placeholder');

      const right = hasContent
        ? existingRight.cloneNode(true)
        : document.createElement('div');
      right.className = 'git-panel-right';
      right.id = 'git-diff-viewer';

      if (!hasContent) {
        const diffPlaceholder = document.createElement('div');
        diffPlaceholder.className = 'tasks-placeholder';
        diffPlaceholder.textContent = 'Select a file or commit to view diff';
        right.appendChild(diffPlaceholder);
      }

      panel.appendChild(container);
      container.appendChild(left);
      container.appendChild(right);

      // Branch indicator bar
      const branchBar = document.createElement('div');
      branchBar.className = 'git-branch-bar';
      const branchIcon = document.createElement('span');
      branchIcon.className = 'git-branch-icon';
      branchIcon.textContent = '\u2387 ';
      const branchName = document.createElement('span');
      branchName.className = 'git-branch-name';
      branchName.textContent = status.branch || 'unknown';
      branchBar.appendChild(branchIcon);
      branchBar.appendChild(branchName);
      left.appendChild(branchBar);

      if (status.isClean) {
        const clean = document.createElement('div');
        clean.className = 'tasks-placeholder';
        clean.textContent = 'Working tree clean';
        left.appendChild(clean);
      } else {
        // Group files by their change state
        const groups = [
          { label: 'Staged', files: status.staged || [], staged: true },
          { label: 'Modified', files: status.modified || [], staged: false },
          { label: 'Untracked', files: status.notAdded || [], staged: false },
          { label: 'Deleted', files: status.deleted || [], staged: false },
        ];

        for (const group of groups) {
          if (!group.files.length) continue;

          const header = document.createElement('div');
          header.className = 'git-group-header';
          header.textContent = `${group.label} (${group.files.length})`;
          left.appendChild(header);

          for (const fileObj of group.files) {
            const filename = typeof fileObj === 'string' ? fileObj : fileObj.file;
            const row = document.createElement('div');
            row.className = 'git-file-row';
            row.dataset.file = filename;
            row.dataset.staged = group.staged;

            const stateEl = document.createElement('span');
            stateEl.className = `git-file-state git-state-${group.label.toLowerCase()}`;
            stateEl.textContent = group.label[0]; // S, M, U, D

            const nameEl = document.createElement('span');
            nameEl.className = 'git-file-name';
            nameEl.textContent = filename;

            row.appendChild(stateEl);
            row.appendChild(nameEl);

            row.addEventListener('click', () => {
              left.querySelectorAll('.git-file-row').forEach(r => r.classList.remove('active'));
              row.classList.add('active');
              this._selectedGitFile = { file: filename, staged: group.staged };
              this._selectedGitCommit = null; // clear commit selection
              this._loadGitDiff(right, ws.id, filename, group.staged);
            });

            left.appendChild(row);
          }
        }
      }

      // Commit log section appended below file status
      await this._renderGitLog(left, right, ws.id);

    } catch (err) {
      panel.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'tasks-placeholder tasks-placeholder--error';
      errEl.textContent = 'Failed to load git status: ' + (err.message || 'unknown error');
      panel.appendChild(errEl);
    }
  }

  /**
   * Load and render the diff for a specific file into the diff viewer pane.
   * Renders line-by-line using DOM APIs to prevent XSS from raw diff content.
   * @param {HTMLElement} container - The right pane to render into
   * @param {string} workspaceId - Workspace ID for the API call
   * @param {string} file - File path to diff
   * @param {boolean} staged - Whether to show staged vs unstaged diff
   */
  async _loadGitDiff(container, workspaceId, file, staged) {
    container.textContent = '';
    const loadingEl = document.createElement('div');
    loadingEl.className = 'tasks-placeholder';
    loadingEl.textContent = 'Loading diff\u2026';
    container.appendChild(loadingEl);

    try {
      const data = await this.api('GET', `/api/git/diff?workspaceId=${workspaceId}&file=${encodeURIComponent(file)}&staged=${staged}`);
      const diffText = data.diff || '';

      if (!diffText.trim()) {
        container.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'tasks-placeholder';
        empty.textContent = 'No diff available';
        container.appendChild(empty);
        return;
      }

      container.textContent = '';
      const pre = document.createElement('pre');
      pre.className = 'git-diff-viewer';

      // Parse line-by-line and apply syntax coloring via class, not innerHTML
      const lines = diffText.split('\n');
      for (const line of lines) {
        const span = document.createElement('span');
        span.textContent = line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          span.className = 'diff-add';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          span.className = 'diff-del';
        } else if (line.startsWith('@@')) {
          span.className = 'diff-hunk';
        } else {
          span.className = 'diff-ctx';
        }
        pre.appendChild(span);
      }
      container.appendChild(pre);
    } catch (err) {
      container.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'tasks-placeholder tasks-placeholder--error';
      errEl.textContent = 'Failed to load diff: ' + (err.message || 'unknown');
      container.appendChild(errEl);
    }
  }

  /**
   * Render the recent commit log section inside the left panel.
   * Clicking a row shows the full commit diff in the right pane.
   * Clicking the hash badge copies the full hash to clipboard.
   * @param {HTMLElement} container - The left pane to append the log into
   * @param {HTMLElement} right - The right diff-viewer pane
   * @param {string} workspaceId - Workspace ID for the API call
   */
  async _renderGitLog(container, right, workspaceId) {
    const logSection = document.createElement('div');
    logSection.className = 'git-log-section';

    const logHeader = document.createElement('div');
    logHeader.className = 'git-group-header';
    logHeader.textContent = 'Recent Commits';
    logSection.appendChild(logHeader);
    container.appendChild(logSection);

    try {
      const data = await this.api('GET', `/api/git/log?workspaceId=${workspaceId}&limit=20`);
      const commits = data.commits || [];

      if (!commits.length) {
        const empty = document.createElement('div');
        empty.className = 'tasks-placeholder';
        empty.textContent = 'No commits yet';
        logSection.appendChild(empty);
        return;
      }

      for (const commit of commits) {
        const row = document.createElement('div');
        row.className = 'git-commit-row';
        row.title = 'Click to view commit diff';
        row.style.cursor = 'pointer';

        const hash = document.createElement('span');
        hash.className = 'git-commit-hash';
        hash.textContent = commit.shortHash;
        hash.title = 'Click to copy full hash';
        hash.addEventListener('click', (e) => {
          e.stopPropagation(); // don't also trigger row click
          navigator.clipboard.writeText(commit.hash).catch(() => {});
          hash.textContent = 'copied!';
          setTimeout(() => { hash.textContent = commit.shortHash; }, 1500);
        });

        const msg = document.createElement('span');
        msg.className = 'git-commit-msg';
        msg.textContent = commit.message;

        const meta = document.createElement('span');
        meta.className = 'git-commit-meta';
        meta.textContent = this._relativeTime(new Date(commit.date));

        row.appendChild(hash);
        row.appendChild(msg);
        row.appendChild(meta);
        logSection.appendChild(row);

        // Restore selection state after auto-refresh
        if (this._selectedGitCommit === commit.hash) {
          row.classList.add('selected');
        }

        // Row click: show full commit diff in the right pane
        row.addEventListener('click', () => {
          logSection.querySelectorAll('.git-commit-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          this._selectedGitCommit = commit.hash;
          this._selectedGitFile = null; // clear file selection
          this._loadGitCommitDiff(right, workspaceId, commit.hash);
        });
      }
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'tasks-placeholder tasks-placeholder--error';
      errEl.textContent = 'Failed to load commits: ' + (err.message || 'unknown');
      logSection.appendChild(errEl);
    }
  }

  /**
   * Load and render the full diff for a commit (git show) into the diff viewer.
   * @param {HTMLElement} container - The right pane to render into
   * @param {string} workspaceId - Workspace ID for the API call
   * @param {string} hash - Full commit hash
   */
  async _loadGitCommitDiff(container, workspaceId, hash) {
    container.textContent = '';
    const loadingEl = document.createElement('div');
    loadingEl.className = 'tasks-placeholder';
    loadingEl.textContent = 'Loading commit\u2026';
    container.appendChild(loadingEl);

    try {
      const data = await this.api('GET', `/api/git/commit-diff?workspaceId=${workspaceId}&hash=${encodeURIComponent(hash)}`);
      const diffText = data.diff || '';

      if (!diffText.trim()) {
        container.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'tasks-placeholder';
        empty.textContent = 'No diff available for this commit';
        container.appendChild(empty);
        return;
      }

      container.textContent = '';
      const pre = document.createElement('pre');
      pre.className = 'git-diff-viewer';

      const lines = diffText.split('\n');
      for (const line of lines) {
        const span = document.createElement('span');
        span.textContent = line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          span.className = 'diff-add';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          span.className = 'diff-del';
        } else if (line.startsWith('@@')) {
          span.className = 'diff-hunk';
        } else if (line.startsWith('commit ') || line.startsWith('Author:') || line.startsWith('Date:')) {
          span.className = 'diff-meta';
        } else {
          span.className = 'diff-ctx';
        }
        pre.appendChild(span);
      }
      container.appendChild(pre);
    } catch (err) {
      container.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'tasks-placeholder tasks-placeholder--error';
      errEl.textContent = 'Failed to load commit: ' + (err.message || 'unknown');
      container.appendChild(errEl);
    }
  }

  /**
   * Format a Date as a human-readable relative time string.
   * Returns values like "just now", "5m ago", "2h ago", "3d ago",
   * or a locale date string for dates older than 30 days.
   * @param {Date} date - The date to format
   * @returns {string} Relative time string
   */
  _relativeTime(date) {
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 30) return date.toLocaleDateString();
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  }

  /** Fetch tasks and render in the active layout */
  async renderTasksView(container = null) {
    // Initialize layout from localStorage (default: board)
    if (!this._tasksLayout) {
      this._tasksLayout = localStorage.getItem('cwm_tasksLayout') || 'board';
      // Sync toggle UI
      if (this.els.tasksLayoutToggle) {
        this.els.tasksLayoutToggle.querySelectorAll('.tasks-layout-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.layout === this._tasksLayout);
        });
      }
      // Show/hide containers
      if (this.els.tasksList) this.els.tasksList.style.display = this._tasksLayout === 'list' ? '' : 'none';
      if (this.els.kanbanBoard) this.els.kanbanBoard.style.display = this._tasksLayout === 'board' ? '' : 'none';
    }

    try {
      const data = await this.api('GET', '/api/worktree-tasks');
      const tasks = data.tasks || [];
      this._worktreeTaskCache = tasks;

      if (tasks.length === 0) {
        // Show empty state in whichever container is visible
        const emptyHtml = `
          <div class="tasks-empty">
            <div class="tasks-empty-icon">&#128736;</div>
            <div class="tasks-empty-title">No worktree tasks</div>
            <div class="tasks-empty-desc">Create a task to have Claude work on a feature in an isolated git branch. Click "New Task" above to get started.</div>
          </div>`;
        if (this._tasksLayout === 'board' && this.els.kanbanBoard) {
          this.els.kanbanBoard.innerHTML = emptyHtml;
        } else if (this.els.tasksList) {
          this.els.tasksList.innerHTML = emptyHtml;
        }
        return;
      }

      if (this._tasksLayout === 'board') {
        this._renderKanbanBoard(tasks);
      } else {
        this._renderTasksList(tasks);
      }
    } catch (err) {
      const errHtml = `<div class="tasks-empty"><div class="tasks-empty-desc">Failed to load tasks</div></div>`;
      if (this._tasksLayout === 'board' && this.els.kanbanBoard) {
        this.els.kanbanBoard.innerHTML = errHtml;
      } else if (this.els.tasksList) {
        this.els.tasksList.innerHTML = errHtml;
      }
    }
  }

  /** Render tasks in the list layout (original vertical grouped view) */
  _renderTasksList(tasks) {
    if (!this.els.tasksList) return;

    // Group by status
    const groups = { running: [], review: [], completed: [], rejected: [] };
    tasks.forEach(t => {
      const key = (t.status === 'running' || t.status === 'active') ? 'running' : (groups[t.status] ? t.status : 'running');
      groups[key].push(t);
    });

    let html = '';
    if (groups.running.length > 0) html += this._renderTaskGroup('Active', groups.running, 'running');
    if (groups.review.length > 0) html += this._renderTaskGroup('Review', groups.review, 'review');
    if (groups.completed.length > 0) html += this._renderTaskGroup('Completed', groups.completed, 'completed');

    this.els.tasksList.innerHTML = html;
    this._wireTaskListEvents(this.els.tasksList);
  }

  /** Wire up click handlers on task list items and action buttons */
  _wireTaskListEvents(container) {
    // Task item click -> navigate to session detail
    container.querySelectorAll('.task-item').forEach(el => {
      el.addEventListener('click', () => {
        const sessionId = el.dataset.sessionId;
        if (sessionId) {
          const session = (this.state.allSessions || []).find(s => s.id === sessionId);
          if (session) {
            this.state.selectedSession = session;
            this.setViewMode('workspace');
            this.renderSessionDetail();
          }
        }
      });
    });

    // Quick action buttons (merge, diff, push, open)
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const taskId = btn.dataset.taskId;
        const action = btn.dataset.action;
        if (action === 'merge') this.mergeWorktreeTask(taskId);
        else if (action === 'diff') this.showWorktreeTaskDiff(taskId);
        else if (action === 'push') {
          try {
            const res = await this.api('POST', `/api/worktree-tasks/${taskId}/push`);
            this.showToast(res.message || 'Pushed to remote', 'success');
          } catch (err) {
            this.showToast(err.message || 'Push failed', 'error');
          }
        } else if (action === 'create-pr') {
          this.openPRDialog(taskId);
        } else if (action === 'open') {
          const task = (this._worktreeTaskCache || []).find(t => t.id === taskId);
          if (task && task.sessionId) {
            const emptySlot = this.terminalPanes.findIndex(p => p === null);
            if (emptySlot !== -1) {
              this.setViewMode('terminal');
              this.openTerminalInPane(emptySlot, task.sessionId, task.branch, { cwd: task.worktreePath });
            }
          }
        }
      });
    });
  }

  /** Render a group of tasks (Active/Review/Completed) for list view */
  _renderTaskGroup(label, tasks, groupType) {
    const items = tasks.map(t => {
      // Determine dot state
      let dotClass = 'completed';
      if (groupType === 'running') {
        const tp = this.terminalPanes.find(p => p && p.sessionId === t.sessionId);
        const isActive = tp && (Date.now() - tp._lastOutputTime) < 3000;
        dotClass = isActive ? 'busy' : 'waiting';
      } else if (groupType === 'review') {
        dotClass = 'review';
      }

      const timeStr = t.createdAt ? this.relativeTime(t.createdAt) : '';
      const changes = (t.changedFiles > 0) ? `<span class="task-item-changes"><span class="added">+${t.branchAhead || 0}</span> commits, ${t.changedFiles} files</span>` : '';

      const actions = groupType === 'review' ? `
        <div class="task-item-actions">
          <button class="btn btn-primary btn-sm" data-action="merge" data-task-id="${t.id}">Merge</button>
          <button class="btn btn-ghost btn-sm" data-action="diff" data-task-id="${t.id}">Diff</button>
          <button class="btn btn-ghost btn-sm" data-action="push" data-task-id="${t.id}" style="color:var(--teal)">Push</button>
        </div>` : '';

      const openBtn = groupType === 'running' ? `<button class="btn btn-ghost btn-sm" data-action="open" data-task-id="${t.id}" style="font-size:10px;padding:1px 6px;margin-left:auto;">Open</button>` : '';

      const listTagBadges = (t.tags || []).slice(0, 3).map(tag => {
        const color = this._tagColor(tag);
        return `<span class="session-badge session-badge-tag" style="background:color-mix(in srgb, var(--${color}) 15%, transparent);color:var(--${color});">${this.escapeHtml(tag)}</span>`;
      }).join('');

      return `<div class="task-item" data-session-id="${t.sessionId || ''}" data-task-id="${t.id}">
        <span class="task-item-dot ${dotClass}"></span>
        <span class="task-item-branch">${this.escapeHtml(t.branch || t.description || t.id)}</span>
        ${openBtn}
        <div class="task-item-meta">
          ${t.model ? `<span class="session-badge session-badge-model">${this.escapeHtml(t.model.includes('opus') ? 'opus' : t.model.includes('sonnet') ? 'sonnet' : t.model.includes('haiku') ? 'haiku' : t.model)}</span>` : ''}
          ${listTagBadges}
          ${timeStr ? `<span>${timeStr}</span>` : ''}
          ${changes}
        </div>
        ${actions}
      </div>`;
    }).join('');

    return `<div class="tasks-group ${groupType === 'completed' ? 'tasks-group-completed' : ''}">
      <div class="tasks-group-header">${label} <span class="tasks-group-count">(${tasks.length})</span></div>
      ${items}
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     KANBAN BOARD
     Horizontal column layout: Backlog | Running | Review | Done
     Cards are draggable between columns to change task status.
     ═══════════════════════════════════════════════════════════ */

  /** Render the kanban board with tasks in columns by status */
  _renderKanbanBoard(tasks) {
    if (!this.els.kanbanBoard) return;

    // Categorize tasks into 5 kanban columns: Backlog | Planning | Running | Review | Done
    const columns = { backlog: [], planning: [], running: [], review: [], completed: [] };
    tasks.forEach(t => {
      if (t.status === 'backlog' || t.status === 'pending') {
        columns.backlog.push(t);
      } else if (t.status === 'planning' || t.status === 'exploring') {
        columns.planning.push(t);
      } else if (t.status === 'running' || t.status === 'active') {
        columns.running.push(t);
      } else if (t.status === 'review') {
        columns.review.push(t);
      } else if (t.status === 'completed' || t.status === 'merged') {
        columns.completed.push(t);
      } else if (t.status === 'rejected') {
        columns.completed.push(t); // rejected goes to done column
      } else {
        columns.backlog.push(t); // unknown status defaults to backlog
      }
    });

    // Render each column's cards
    Object.entries(columns).forEach(([status, statusTasks]) => {
      const body = this.els.kanbanBoard.querySelector(`.kanban-column-body[data-status="${status}"]`);
      const count = this.els.kanbanBoard.querySelector(`.kanban-column[data-status="${status}"] .kanban-column-count`);
      if (!body) return;

      if (count) count.textContent = statusTasks.length;

      if (statusTasks.length === 0) {
        body.innerHTML = '<div class="kanban-column-empty">No tasks</div>';
      } else {
        body.innerHTML = statusTasks.map(t => this._renderKanbanCard(t, status)).join('');
      }
    });

    // Wire up events on all cards
    this._wireKanbanEvents();
  }

  /** Map a tag name to a consistent Catppuccin color variable */
  _tagColor(tag) {
    const palette = ['teal', 'pink', 'sky', 'peach', 'lavender', 'flamingo', 'sapphire', 'rosewater'];
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }

  /** Render a single kanban card */
  _renderKanbanCard(task, columnStatus) {
    const timeStr = task.createdAt ? this.relativeTime(task.createdAt) : '';
    const modelShort = task.model ? (task.model.includes('opus') ? 'opus' : task.model.includes('sonnet') ? 'sonnet' : task.model.includes('haiku') ? 'haiku' : task.model) : '';

    // Changes info for review/completed
    const changesHtml = (task.changedFiles > 0) ? `
      <div class="kanban-card-changes">
        <span class="added">+${task.branchAhead || 0}</span> commits -- ${task.changedFiles} files changed
      </div>` : '';

    // Show agent count badge for running tasks (from cached subagent data)
    let agentBadge = '';
    if (columnStatus === 'running' && task.sessionId && this._subagentCache) {
      const cached = this._subagentCache[task.sessionId];
      if (cached && cached.running > 0) {
        agentBadge = `<span class="session-badge" style="background:var(--teal);color:var(--base);font-size:9px;">${cached.running} agent${cached.running > 1 ? 's' : ''}</span>`;
      }
    }

    // Live session preview -- show last terminal line for running tasks
    let previewHtml = '';
    if (columnStatus === 'running' && task.sessionId) {
      const pane = this.terminalPanes.find(p => p && p.sessionId === task.sessionId);
      if (pane && pane.term) {
        const lastLine = this._getTerminalLastLine(pane.term);
        if (lastLine) {
          previewHtml = `<div class="kanban-card-preview">${this.escapeHtml(lastLine)}</div>`;
        }
      }
    }

    // Actions vary by column
    let actionsHtml = '';
    if (columnStatus === 'running') {
      actionsHtml = `<div class="kanban-card-actions">
        <button class="btn btn-ghost btn-sm" data-action="open" data-task-id="${task.id}">Open Terminal</button>
      </div>`;
    } else if (columnStatus === 'review') {
      const prBtn = (task.pr && task.pr.url)
        ? `<a href="${this.escapeHtml(task.pr.url)}" target="_blank" class="btn btn-ghost btn-sm" style="color:var(--green);text-decoration:none;">View PR</a>`
        : `<button class="btn btn-ghost btn-sm" data-action="create-pr" data-task-id="${task.id}" style="color:var(--green)">Create PR</button>`;
      actionsHtml = `<div class="kanban-card-actions">
        <button class="btn btn-primary btn-sm" data-action="merge" data-task-id="${task.id}">Merge</button>
        <button class="btn btn-ghost btn-sm" data-action="diff" data-task-id="${task.id}">Diff</button>
        ${prBtn}
      </div>`;
    }

    // Rejected badge for tasks in done column that were rejected
    const rejectedBadge = task.status === 'rejected' ? '<span class="session-badge" style="background:var(--red);color:var(--base);">rejected</span>' : '';

    // PR badge
    let prBadge = '';
    if (task.pr && task.pr.url) {
      const prColors = { open: 'var(--green)', draft: 'var(--overlay1)', merged: 'var(--mauve)', closed: 'var(--red)' };
      const prColor = prColors[task.pr.state] || 'var(--overlay1)';
      prBadge = `<a href="${this.escapeHtml(task.pr.url)}" target="_blank" class="session-badge session-badge-pr" style="background:color-mix(in srgb, ${prColor} 15%, transparent);color:${prColor};text-decoration:none;cursor:pointer;" title="PR #${task.pr.number} (${task.pr.state})">#${task.pr.number}</a>`;
    }

    // Blocked-by indicator
    let blockedHtml = '';
    if (task.blockedBy && task.blockedBy.length > 0) {
      const blockerNames = task.blockedBy.map(bid => {
        const blocker = (this._worktreeTaskCache || []).find(t => t.id === bid);
        return blocker ? (blocker.branch || blocker.description || bid) : bid;
      });
      blockedHtml = `<div class="kanban-card-blocked" title="Blocked by: ${blockerNames.map(n => this.escapeHtml(n)).join(', ')}">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M4 12L12 4"/></svg>
        Blocked by ${task.blockedBy.length} task${task.blockedBy.length > 1 ? 's' : ''}
      </div>`;
    }

    // Stage transition indicator -- show how many stages this task has progressed through
    let stageProgressHtml = '';
    if (task.history && task.history.length > 1) {
      const stages = task.history.map(h => h.status);
      const uniqueStages = [...new Set(stages)];
      if (uniqueStages.length > 1) {
        const stageIcons = { backlog: '\u25CB', planning: '\u25D4', running: '\u25D1', review: '\u25D5', completed: '\u25CF' };
        const dots = uniqueStages.map(s => `<span title="${s}" style="color:var(--overlay1)">${stageIcons[s] || '\u25CB'}</span>`).join(' ');
        stageProgressHtml = `<div class="kanban-card-stages">${dots}</div>`;
      }
    }

    // Compact timeline for completed tasks
    let timelineHtml = '';
    if (task.history && task.history.length > 1 && (columnStatus === 'completed' || columnStatus === 'review')) {
      const first = task.history[0];
      const last = task.history[task.history.length - 1];
      const durationMs = new Date(last.at) - new Date(first.at);
      const hours = Math.floor(durationMs / 3600000);
      const mins = Math.floor((durationMs % 3600000) / 60000);
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      timelineHtml = `<div class="kanban-card-timeline">${task.history.length} transitions -- ${durationStr} total</div>`;
    }

    // Tag badges
    const tagBadges = (task.tags || []).map(tag => {
      const color = this._tagColor(tag);
      return `<span class="session-badge session-badge-tag" style="background:color-mix(in srgb, var(--${color}) 15%, transparent);color:var(--${color});">${this.escapeHtml(tag)}</span>`;
    }).join('');

    return `<div class="kanban-card${task.blockedBy && task.blockedBy.length > 0 ? ' kanban-card-blocked-state' : ''}" draggable="true" data-task-id="${task.id}" data-session-id="${task.sessionId || ''}">
      <div class="kanban-card-title">${this.escapeHtml(task.branch || task.description || task.id)}</div>
      <div class="kanban-card-meta">
        ${modelShort ? `<span class="session-badge session-badge-model">${this.escapeHtml(modelShort)}</span>` : ''}
        ${agentBadge}
        ${prBadge}
        ${rejectedBadge}
        ${tagBadges}
        ${timeStr ? `<span>${timeStr}</span>` : ''}
      </div>
      ${blockedHtml}
      ${stageProgressHtml}
      ${previewHtml}
      ${changesHtml}
      ${timelineHtml}
      ${actionsHtml}
    </div>`;
  }

  /** Wire up drag-and-drop and click events on kanban cards */
  /** Get the last non-empty line from a terminal buffer for live preview */
  _getTerminalLastLine(term) {
    try {
      const buffer = term.buffer.active;
      // Walk backwards from the cursor to find the last non-empty line
      for (let i = buffer.cursorY + buffer.baseY; i >= 0; i--) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true).trim();
        if (text.length > 0) {
          // Truncate to 80 chars for card preview
          return text.length > 80 ? text.slice(0, 77) + '...' : text;
        }
      }
    } catch (_) { /* buffer not ready */ }
    return '';
  }

  /** Filter tasks by the current search query, matching branch, description, model, status, and tags */
  _filterTasks(tasks) {
    const q = this._tasksSearchQuery;
    if (!q) return tasks;
    return tasks.filter(t => {
      const haystack = [t.branch, t.description, t.model, t.status, t.id, ...(t.tags || [])].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }

  _wireKanbanEvents() {
    if (!this.els.kanbanBoard) return;

    // Card click -> navigate to session detail
    this.els.kanbanBoard.querySelectorAll('.kanban-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Don't navigate if clicking an action button
        if (e.target.closest('[data-action]')) return;
        const sessionId = card.dataset.sessionId;
        if (sessionId) {
          const session = (this.state.allSessions || []).find(s => s.id === sessionId);
          if (session) {
            this.state.selectedSession = session;
            this.setViewMode('workspace');
            this.renderSessionDetail();
          }
        }
      });

      // Right-click context menu for kanban card
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const taskId = card.dataset.taskId;
        this._showKanbanCardContextMenu(taskId, e.clientX, e.clientY);
      });

      // Drag start
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.taskId);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
        // Highlight all drop zones
        this.els.kanbanBoard.querySelectorAll('.kanban-column-body').forEach(col => {
          col.classList.add('kanban-drop-target');
        });
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        this.els.kanbanBoard.querySelectorAll('.kanban-column-body').forEach(col => {
          col.classList.remove('kanban-drop-target', 'drag-over');
        });
      });
    });

    // Column body drop zones
    this.els.kanbanBoard.querySelectorAll('.kanban-column-body').forEach(colBody => {
      colBody.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        colBody.classList.add('drag-over');
      });

      colBody.addEventListener('dragleave', (e) => {
        // Only remove if leaving the column body itself (not entering a child)
        if (!colBody.contains(e.relatedTarget)) {
          colBody.classList.remove('drag-over');
        }
      });

      colBody.addEventListener('drop', async (e) => {
        e.preventDefault();
        colBody.classList.remove('drag-over');
        const taskId = e.dataTransfer.getData('text/plain');
        const newStatus = colBody.dataset.status;
        if (!taskId || !newStatus) return;

        // Find the task to check current status
        const task = (this._worktreeTaskCache || []).find(t => t.id === taskId);
        if (!task) return;

        // Map kanban column to API status
        const statusMap = { backlog: 'backlog', planning: 'planning', running: 'running', review: 'review', completed: 'completed' };
        const apiStatus = statusMap[newStatus];
        if (!apiStatus) return;

        // Don't update if same column
        const currentColumn = (task.status === 'active') ? 'running' : (task.status === 'pending' ? 'backlog' : task.status);
        if (currentColumn === newStatus) return;

        // Enforce concurrent limit when moving to running
        if (newStatus === 'running') {
          const maxConcurrent = this.state.settings.maxConcurrentTasks || 4;
          const runningCount = (this._worktreeTaskCache || []).filter(t =>
            (t.status === 'running' || t.status === 'active') && t.id !== taskId
          ).length;
          if (runningCount >= maxConcurrent) {
            this.showToast(`Concurrent task limit reached (${maxConcurrent}). Increase in Settings.`, 'warning');
            return;
          }
        }

        try {
          // Build update payload -- auto-assign model if configured for this stage
          const updatePayload = { status: apiStatus };
          const stageModelKey = newStatus === 'planning' ? 'defaultModelPlanning' : newStatus === 'running' ? 'defaultModelRunning' : null;
          if (stageModelKey) {
            const stageModel = this.state.settings[stageModelKey];
            if (stageModel && !task.model) {
              updatePayload.model = stageModel;
            }
          }
          await this.api('PUT', `/api/worktree-tasks/${taskId}`, updatePayload);
          this.showToast(`Task moved to ${newStatus}`, 'success');
          this.renderTasksView(); // Re-fetch and render
        } catch (err) {
          this.showToast(err.message || 'Failed to move task', 'error');
        }
      });
    });

    // Wire up action buttons (same as list view)
    this._wireTaskListEvents(this.els.kanbanBoard);
  }

  /** Show context menu for a kanban card with dependency management and actions */
  _showKanbanCardContextMenu(taskId, x, y) {
    const task = (this._worktreeTaskCache || []).find(t => t.id === taskId);
    if (!task) return;

    const allTasks = this._worktreeTaskCache || [];
    const otherTasks = allTasks.filter(t => t.id !== taskId);
    const currentBlockers = task.blockedBy || [];

    const items = [];

    // Set blocker submenu
    if (otherTasks.length > 0) {
      items.push({ label: 'Set Blocked By...', icon: '&#128683;', disabled: true });
      otherTasks.forEach(other => {
        const isBlocker = currentBlockers.includes(other.id);
        items.push({
          label: `${isBlocker ? '\u2713 ' : ''}${other.branch || other.description || other.id}`,
          icon: isBlocker ? '&#9745;' : '&#9744;',
          action: async () => {
            const newBlockers = isBlocker
              ? currentBlockers.filter(bid => bid !== other.id)
              : [...currentBlockers, other.id];
            try {
              await this.api('PUT', `/api/worktree-tasks/${taskId}`, { blockedBy: newBlockers });
              this.showToast(isBlocker ? 'Dependency removed' : 'Dependency added', 'success');
              this.renderTasksView();
            } catch (err) {
              this.showToast(err.message || 'Failed to update', 'error');
            }
          }
        });
      });
      items.push({ type: 'sep' });
    }

    // Clear all dependencies
    if (currentBlockers.length > 0) {
      items.push({
        label: 'Clear All Dependencies',
        icon: '&#10005;',
        action: async () => {
          try {
            await this.api('PUT', `/api/worktree-tasks/${taskId}`, { blockedBy: [] });
            this.showToast('Dependencies cleared', 'success');
            this.renderTasksView();
          } catch (err) {
            this.showToast(err.message || 'Failed to clear', 'error');
          }
        }
      });
      items.push({ type: 'sep' });
    }

    // View history
    if (task.history && task.history.length > 0) {
      items.push({
        label: `View Timeline (${task.history.length} events)`,
        icon: '&#128340;',
        action: () => {
          const rows = task.history.map(h => {
            const d = new Date(h.at);
            return `${d.toLocaleTimeString()} -- ${h.status}`;
          }).join('\n');
          alert(`Task Timeline\n\n${rows}`);
        }
      });
    }

    // Model selection submenu
    const modelOptions = [
      { id: '',           label: 'Default' },
      { id: 'opus',       label: 'Opus' },
      { id: 'sonnet',     label: 'Sonnet' },
      { id: 'haiku',      label: 'Haiku' },
      { id: 'sonnet[1m]', label: 'Sonnet 1M' },
      { id: 'opusplan',   label: 'OpusPlan' },
    ];
    const currentTaskModel = task.model || '';
    const currentModelLabel = currentTaskModel ? (modelOptions.find(m => m.id === currentTaskModel)?.label || 'Custom') : 'Default';
    items.push({
      label: 'Model', icon: '&#9881;', hint: currentModelLabel,
      submenu: modelOptions.map(m => ({
        label: m.label,
        check: currentTaskModel === m.id,
        action: async () => {
          try {
            await this.api('PUT', `/api/worktree-tasks/${taskId}`, { model: m.id || null });
            this.showToast(`Model set to ${m.label}`, 'success');
            this.renderTasksView();
          } catch (err) {
            this.showToast(err.message || 'Failed to update model', 'error');
          }
        }
      }))
    });

    // Edit tags
    items.push({
      label: 'Edit Tags...',
      icon: '&#127991;',
      hint: (task.tags || []).length > 0 ? (task.tags || []).join(', ') : 'none',
      action: async () => {
        const current = (task.tags || []).join(', ');
        const result = prompt('Tags (comma-separated):', current);
        if (result === null) return;
        const newTags = result.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        try {
          await this.api('PUT', `/api/worktree-tasks/${taskId}`, { tags: newTags });
          this.showToast('Tags updated', 'success');
          this.renderTasksView();
        } catch (err) {
          this.showToast(err.message || 'Failed to update tags', 'error');
        }
      }
    });

    // PR actions
    if (task.pr && task.pr.url) {
      items.push({
        label: `View PR #${task.pr.number}`,
        icon: '&#128279;',
        action: () => window.open(task.pr.url, '_blank'),
      });
      items.push({
        label: 'Refresh PR Status',
        icon: '&#8635;',
        action: async () => {
          const pr = await this.refreshPRStatus(taskId);
          if (pr) this.showToast(`PR #${pr.number}: ${pr.state}`, 'info');
          this.renderTasksView();
        }
      });
    } else {
      items.push({
        label: 'Create PR...',
        icon: '&#128279;',
        action: () => this.openPRDialog(taskId),
      });
    }

    // Delete task
    items.push({ type: 'sep' });
    items.push({
      label: 'Delete Task',
      icon: '&#128465;',
      danger: true,
      action: async () => {
        if (!confirm(`Delete task "${task.branch || task.description}"?`)) return;
        try {
          await this.api('DELETE', `/api/worktree-tasks/${taskId}`);
          this.showToast('Task deleted', 'success');
          this.renderTasksView();
        } catch (err) {
          this.showToast(err.message || 'Failed to delete', 'error');
        }
      }
    });

    const title = task.branch || task.description || task.id;
    this._renderContextItems(title, items, x, y);
  }

  /* ═══════════════════════════════════════════════════════════
     NEW TASK DIALOG
     Dedicated dialog for creating worktree tasks with project
     directory auto-detection, branch preview, and flag selection.
     ═══════════════════════════════════════════════════════════ */

  /** Open the New Task dialog and populate project directory dropdown */
  openNewTaskDialog(preselectedWorkspaceId) {
    if (!this.els.newTaskOverlay) return;

    // Reset form
    this.els.newTaskName.value = '';
    if (this.els.newTaskDescription) this.els.newTaskDescription.value = '';
    this.els.newTaskPrompt.value = '';
    this.els.newTaskModel.value = '';
    if (this.els.newTaskTags) this.els.newTaskTags.value = '';
    this.els.newTaskDirCustom.value = '';
    this.els.newTaskDirCustom.hidden = true;
    this.els.newTaskBranchPreview.textContent = '';
    if (this.els.newTaskStartNow) this.els.newTaskStartNow.checked = true;
    this.els.newTaskFlags.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);

    // Populate project directory dropdown from all sessions' working dirs
    const dirs = new Map(); // path → count
    (this.state.allSessions || []).forEach(s => {
      if (s.workingDir) {
        const d = s.workingDir.replace(/\\/g, '/');
        dirs.set(d, (dirs.get(d) || 0) + 1);
      }
    });
    // Sort by frequency (most sessions = top)
    const sortedDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]);

    this.els.newTaskDir.innerHTML = '<option value="">Select a project...</option>';
    sortedDirs.forEach(([dir, count]) => {
      const parts = dir.split('/');
      const short = parts.slice(-2).join('/');
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = `${short} (${count} sessions)`;
      this.els.newTaskDir.appendChild(opt);
    });
    // Add custom option
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Enter custom path...';
    this.els.newTaskDir.appendChild(customOpt);

    // Pre-select if we have an active workspace with sessions
    if (preselectedWorkspaceId || (this.state.activeWorkspace && this.state.activeWorkspace.id)) {
      const wsId = preselectedWorkspaceId || this.state.activeWorkspace.id;
      const wsSessions = (this.state.allSessions || []).filter(s => s.workspaceId === wsId);
      if (wsSessions.length > 0 && wsSessions[0].workingDir) {
        this.els.newTaskDir.value = wsSessions[0].workingDir.replace(/\\/g, '/');
      }
    }

    this.els.newTaskOverlay.hidden = false;
    this.els.newTaskName.focus();
  }

  /** Close the New Task dialog */
  closeNewTaskDialog() {
    if (this.els.newTaskOverlay) this.els.newTaskOverlay.hidden = true;
  }

  /** Update the branch name preview as user types task name */
  updateBranchPreview() {
    const name = (this.els.newTaskName.value || '').trim();
    if (!name) {
      this.els.newTaskBranchPreview.textContent = '';
      return;
    }
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40);
    this.els.newTaskBranchPreview.textContent = `Branch: feat/${slug}`;
  }

  /** Submit the new task form and create the worktree task */
  async submitNewTask() {
    const name = (this.els.newTaskName.value || '').trim();
    if (!name) {
      this.showToast('Task name is required', 'error');
      return;
    }

    let repoDir = this.els.newTaskDir.value;
    if (repoDir === '__custom__') {
      repoDir = (this.els.newTaskDirCustom.value || '').trim();
    }
    if (!repoDir) {
      this.showToast('Project directory is required', 'error');
      return;
    }

    const branch = 'feat/' + name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40);

    const model = this.els.newTaskModel.value || undefined;
    const prompt = (this.els.newTaskPrompt.value || '').trim() || undefined;
    const description = (this.els.newTaskDescription ? this.els.newTaskDescription.value : '').trim() || name;
    const startNow = this.els.newTaskStartNow ? this.els.newTaskStartNow.checked : true;
    const tags = this.els.newTaskTags ? this.els.newTaskTags.value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];

    // Collect flags
    const flags = [];
    this.els.newTaskFlags.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      flags.push(cb.value);
    });

    // Find workspace for this directory (best match)
    let workspaceId = this.state.activeWorkspace ? this.state.activeWorkspace.id : null;
    if (!workspaceId && this.state.workspaces.length > 0) {
      workspaceId = this.state.workspaces[0].id;
    }
    if (!workspaceId) {
      this.showToast('No project available', 'error');
      return;
    }

    // Enforce concurrent task limit when starting immediately
    if (startNow) {
      const maxConcurrent = this.state.settings.maxConcurrentTasks || 4;
      const runningCount = (this._worktreeTaskCache || []).filter(t => t.status === 'running' || t.status === 'active').length;
      if (runningCount >= maxConcurrent) {
        this.showToast(`Concurrent task limit reached (${maxConcurrent}). Add to backlog or increase the limit in Settings.`, 'warning');
        return;
      }
    }

    this.els.newTaskCreate.disabled = true;
    this.els.newTaskCreate.textContent = 'Creating...';

    try {
      if (startNow) {
        // Create and immediately start the worktree task (existing behavior)
        const data = await this.api('POST', '/api/worktree-tasks', {
          workspaceId,
          repoDir,
          branch,
          description,
          baseBranch: 'main',
          model,
          tags,
          prompt,
          flags,
        });

        this.closeNewTaskDialog();
        await this.loadSessions();

        // Open session in terminal pane
        if (data.session) {
          const emptySlot = this.terminalPanes.findIndex(p => p === null);
          if (emptySlot !== -1) {
            this.setViewMode('terminal');
            this.openTerminalInPane(emptySlot, data.session.id, branch, {
              cwd: data.task.worktreePath,
              ...(model ? { model } : {}),
              ...(flags.length > 0 ? { flags } : {}),
            });
          }
        }

        this.showToast(`Task started on ${branch}`, 'success');

        // If this task was promoted from a td issue, mark that issue in_progress
        this._maybeMarkTdIssueStarted();
      } else {
        // Create task in backlog (no session, no worktree yet)
        const data = await this.api('POST', '/api/worktree-tasks', {
          workspaceId,
          repoDir,
          branch,
          description,
          baseBranch: 'main',
          model,
          tags,
          flags,
          startNow: false,
        });

        this.closeNewTaskDialog();

        // If this task was promoted from a td issue, mark that issue in_progress
        this._maybeMarkTdIssueStarted();

        // Switch to tasks view to see the backlog
        this.setViewMode('tasks');
        this.showToast(`Task added to backlog: ${branch}`, 'success');
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to create task', 'error');
    } finally {
      this.els.newTaskCreate.disabled = false;
      this.els.newTaskCreate.textContent = 'Create Task';
    }
  }

  /**
   * If the current worktree task was promoted from a td issue (via _promoteTdIssueToWorktree),
   * tell the server to mark that td issue as in_progress, then clear the pending state.
   * Fire-and-forget: failures are logged but do not block the user.
   */
  _maybeMarkTdIssueStarted() {
    const issueId = this._pendingTdIssueId;
    const wsId = this._pendingTdWorkspaceId;
    this._pendingTdIssueId = null;
    this._pendingTdWorkspaceId = null;
    if (!issueId || !wsId) return;
    this.api('POST', `/api/workspaces/${wsId}/td/issues/${issueId}/start`, {})
      .catch(err => console.warn('td start failed for', issueId, err));
  }


  /* ═══════════════════════════════════════════════════════════
     PULL REQUEST DIALOG
     Create, track, and manage GitHub pull requests from tasks.
     ═══════════════════════════════════════════════════════════ */

  /** Open the PR creation dialog for a worktree task */
  openPRDialog(taskId) {
    if (!this.els.prDialogOverlay) return;
    this._prDialogTaskId = taskId;
    const task = (this._worktreeTaskCache || []).find(t => t.id === taskId);

    // Pre-fill form
    this.els.prTitle.value = task ? (task.description || task.branch || '') : '';
    this.els.prBody.value = '';
    this.els.prBaseBranch.value = task ? (task.baseBranch || 'main') : 'main';
    this.els.prLabels.value = (task && task.tags) ? task.tags.join(', ') : '';
    this.els.prDraft.checked = false;
    this.els.prDialogSubmit.disabled = false;
    this.els.prDialogSubmit.textContent = 'Create PR';

    this.els.prDialogOverlay.hidden = false;
  }

  /** Close the PR dialog */
  closePRDialog() {
    if (this.els.prDialogOverlay) this.els.prDialogOverlay.hidden = true;
    this._prDialogTaskId = null;
  }

  /** Generate a PR description using AI */
  async generatePRDescription() {
    const taskId = this._prDialogTaskId;
    if (!taskId) return;

    this.els.prGenerateDesc.disabled = true;
    this.els.prGenerateDesc.textContent = 'Generating...';

    try {
      const data = await this.api('POST', `/api/worktree-tasks/${taskId}/pr/generate-description`);
      if (data.description) {
        this.els.prBody.value = data.description;
        this.showToast('Description generated', 'success');
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to generate description', 'error');
    } finally {
      this.els.prGenerateDesc.disabled = false;
      this.els.prGenerateDesc.textContent = 'Generate with AI';
    }
  }

  /** Submit the PR creation form */
  async submitPR() {
    const taskId = this._prDialogTaskId;
    if (!taskId) return;

    const title = (this.els.prTitle.value || '').trim();
    if (!title) {
      this.showToast('PR title is required', 'error');
      return;
    }

    this.els.prDialogSubmit.disabled = true;
    this.els.prDialogSubmit.textContent = 'Creating...';

    try {
      const labels = this.els.prLabels.value
        .split(',').map(l => l.trim()).filter(Boolean);

      const data = await this.api('POST', `/api/worktree-tasks/${taskId}/pr`, {
        title,
        body: this.els.prBody.value || '',
        baseBranch: this.els.prBaseBranch.value || 'main',
        draft: this.els.prDraft.checked,
        labels,
      });

      this.closePRDialog();
      if (data.pr && data.pr.url) {
        this.showToast(`PR created: #${data.pr.number}`, 'success');
        // Open the PR URL in a new tab
        window.open(data.pr.url, '_blank');
      } else {
        this.showToast('PR created', 'success');
      }
      this.renderTasksView();
    } catch (err) {
      this.showToast(err.message || 'Failed to create PR', 'error');
    } finally {
      this.els.prDialogSubmit.disabled = false;
      this.els.prDialogSubmit.textContent = 'Create PR';
    }
  }

  /** Refresh PR status for a task and update the cache */
  async refreshPRStatus(taskId) {
    try {
      const data = await this.api('GET', `/api/worktree-tasks/${taskId}/pr`);
      return data.pr;
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  //  TASK SPINOFF DIALOG
  // ──────────────────────────────────────────────────────────

  /**
   * Open the spinoff dialog for a session. Calls the backend to
   * AI-extract tasks from the session conversation, then renders
   * editable task cards for review before batch creation.
   * @param {string} sessionId - The session to extract tasks from
   */
  async openSpinoffDialog(sessionId) {
    this._spinoffSessionId = sessionId;
    this._spinoffTasks = [];

    // Get session info for display
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    const sessionName = session ? session.name : sessionId;

    // Show dialog in loading state
    this.els.spinoffOverlay.hidden = false;
    this.els.spinoffTitle.textContent = 'Spinoff Tasks';
    this.els.spinoffSubtitle.textContent = `Analyzing: ${sessionName}`;
    this.els.spinoffLoading.hidden = false;
    this.els.spinoffTasks.hidden = true;
    this.els.spinoffError.hidden = true;
    this.els.spinoffFooter.hidden = true;

    try {
      const data = await this.api('POST', `/api/sessions/${sessionId}/extract-tasks`);

      if (!data.tasks || data.tasks.length === 0) {
        this.els.spinoffLoading.hidden = true;
        this.els.spinoffError.hidden = false;
        this.els.spinoffError.innerHTML = `
          <div style="font-size: 14px; margin-bottom: 6px;">No actionable tasks found</div>
          <div style="font-size: 12px; color: var(--overlay0);">The AI could not identify independent tasks from this session's conversation.</div>
        `;
        return;
      }

      this._spinoffTasks = data.tasks.map((t, i) => ({ ...t, selected: true, index: i }));
      this._spinoffFilesTouched = data.filesTouched || [];
      this.els.spinoffLoading.hidden = true;
      this._renderSpinoffTasks();
      this.els.spinoffTasks.hidden = false;
      this.els.spinoffFooter.hidden = false;
      this._updateSpinoffSelectedCount();
    } catch (err) {
      this.els.spinoffLoading.hidden = true;
      this.els.spinoffError.hidden = false;
      this.els.spinoffError.innerHTML = `
        <div style="font-size: 14px; margin-bottom: 6px;">Task extraction failed</div>
        <div style="font-size: 12px; color: var(--overlay0);">${this.escapeHtml(err.message || 'Unknown error')}</div>
      `;
    }
  }

  /** Close the spinoff dialog and clean up state */
  closeSpinoffDialog() {
    this.els.spinoffOverlay.hidden = true;
    this._spinoffSessionId = null;
    this._spinoffTasks = [];
    this._spinoffFilesTouched = [];
  }

  /** Render the extracted task cards in the spinoff dialog */
  _renderSpinoffTasks() {
    const container = this.els.spinoffTasks;
    const tasks = this._spinoffTasks;

    // Select all row
    const allSelected = tasks.every(t => t.selected);
    let html = `
      <div class="spinoff-select-all">
        <input type="checkbox" id="spinoff-select-all-cb" ${allSelected ? 'checked' : ''} />
        <label for="spinoff-select-all-cb">Select all (${tasks.length} tasks)</label>
      </div>
    `;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const selectedClass = t.selected ? '' : ' spinoff-deselected';

      // File badges (max 5)
      const fileBadges = (t.relevantFiles || []).slice(0, 5).map(f => {
        const shortName = f.split('/').pop();
        return `<span class="spinoff-task-file" title="${this.escapeHtml(f)}">${this.escapeHtml(shortName)}</span>`;
      }).join('');

      // Acceptance criteria list
      const criteriaHtml = (t.acceptanceCriteria || []).map(c =>
        `<li>${this.escapeHtml(c)}</li>`
      ).join('');

      html += `
        <div class="spinoff-task-card${selectedClass}" data-spinoff-index="${i}">
          <div class="spinoff-task-card-header">
            <input type="checkbox" class="spinoff-task-cb" data-index="${i}" ${t.selected ? 'checked' : ''} />
            <div class="spinoff-task-title">
              <input type="text" class="spinoff-task-title-input" data-index="${i}" value="${this.escapeHtml(t.title)}" />
            </div>
            <span class="spinoff-task-branch">feat/${this.escapeHtml(t.branch)}</span>
          </div>
          <div class="spinoff-task-desc">
            <textarea class="spinoff-task-desc-input" data-index="${i}" rows="2">${this.escapeHtml(t.description)}</textarea>
          </div>
          ${fileBadges ? `<div class="spinoff-task-files">${fileBadges}</div>` : ''}
          ${criteriaHtml ? `<ul class="spinoff-task-criteria">${criteriaHtml}</ul>` : ''}
        </div>
      `;
    }

    container.innerHTML = html;

    // Wire up event listeners
    const selectAllCb = container.querySelector('#spinoff-select-all-cb');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', (e) => {
        this._spinoffTasks.forEach(t => t.selected = e.target.checked);
        this._renderSpinoffTasks();
        this._updateSpinoffSelectedCount();
      });
    }

    container.querySelectorAll('.spinoff-task-cb').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        if (this._spinoffTasks[idx]) {
          this._spinoffTasks[idx].selected = e.target.checked;
          const card = e.target.closest('.spinoff-task-card');
          if (card) card.classList.toggle('spinoff-deselected', !e.target.checked);
          this._updateSpinoffSelectedCount();
        }
      });
    });

    // Sync edits back to task data
    container.querySelectorAll('.spinoff-task-title-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        if (this._spinoffTasks[idx]) this._spinoffTasks[idx].title = e.target.value;
      });
    });

    container.querySelectorAll('.spinoff-task-desc-input').forEach(textarea => {
      textarea.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        if (this._spinoffTasks[idx]) this._spinoffTasks[idx].description = e.target.value;
      });
    });
  }

  /** Update the selected count display in the footer */
  _updateSpinoffSelectedCount() {
    const selected = (this._spinoffTasks || []).filter(t => t.selected).length;
    const total = (this._spinoffTasks || []).length;
    this.els.spinoffSelectedCount.textContent = `${selected} of ${total} selected`;
    this.els.spinoffCreate.disabled = selected === 0;
  }

  /**
   * Submit the selected spinoff tasks for batch creation.
   * Creates worktree tasks via the spinoff-batch endpoint.
   */
  async submitSpinoffTasks() {
    const selected = (this._spinoffTasks || []).filter(t => t.selected);
    if (selected.length === 0) {
      this.showToast('No tasks selected', 'warning');
      return;
    }

    const sessionId = this._spinoffSessionId;
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
    const repoDir = session ? session.workingDir : '';
    const workspaceId = (session && session.workspaceId) || (this.state.activeWorkspace && this.state.activeWorkspace.id);

    if (!workspaceId) {
      this.showToast('No workspace available to create tasks in', 'error');
      return;
    }

    const startImmediately = this.els.spinoffStartNow.checked;

    // Enforce concurrent limit if starting immediately
    if (startImmediately) {
      const maxConcurrent = this.state.settings.maxConcurrentTasks || 4;
      const runningCount = (this._worktreeTaskCache || []).filter(t =>
        t.status === 'running' || t.status === 'active'
      ).length;
      if (runningCount + selected.length > maxConcurrent) {
        this.showToast(`Would exceed concurrent task limit (${maxConcurrent}). Reduce selection or add to backlog.`, 'warning');
        return;
      }
    }

    this.els.spinoffCreate.disabled = true;
    this.els.spinoffCreate.textContent = 'Creating...';

    try {
      const data = await this.api('POST', `/api/sessions/${sessionId}/spinoff-batch`, {
        tasks: selected.map(t => ({
          title: t.title,
          description: t.description,
          relevantFiles: t.relevantFiles,
          acceptanceCriteria: t.acceptanceCriteria,
          branch: t.branch,
          tags: ['spinoff'],
        })),
        repoDir,
        workspaceId,
        startImmediately,
      });

      this.closeSpinoffDialog();

      const createdCount = data.created ? data.created.length : 0;
      const errorCount = data.errors ? data.errors.length : 0;

      if (createdCount > 0) {
        this.showToast(`${createdCount} task${createdCount > 1 ? 's' : ''} created${errorCount > 0 ? ` (${errorCount} failed)` : ''}`, 'success');

        // If tasks were started immediately, open them in terminal panes
        if (startImmediately && data.created) {
          for (const item of data.created) {
            if (item.session) {
              const emptySlot = this.terminalPanes.findIndex(p => p === null);
              if (emptySlot !== -1) {
                this.openTerminalInPane(emptySlot, item.session.id, item.task.branch || item.session.name, {
                  cwd: item.task.worktreePath,
                });
              }
            }
          }
          this.setViewMode('terminal');
        } else {
          // Switch to tasks view to see the backlog
          this.setViewMode('tasks');
        }

        await this.loadSessions();
        this.renderTasksView();
      } else if (errorCount > 0) {
        this.showToast(`Failed to create tasks: ${data.errors[0].error}`, 'error');
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to create spinoff tasks', 'error');
    } finally {
      this.els.spinoffCreate.disabled = false;
      this.els.spinoffCreate.textContent = 'Create Selected Tasks';
    }
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
            <div style="font-size:11px;text-transform:uppercase;color:var(--overlay0);font-weight:600;margin-bottom:8px;">Send to Project</div>
            <div style="display:flex;gap:8px;">
              <select id="summary-ws-select" style="flex:1;padding:8px;border-radius:6px;background:var(--surface0);color:var(--text-primary);border:1px solid var(--surface1);font-size:13px;">
                ${wsOptions}
              </select>
              <button class="btn btn-primary btn-sm" id="summary-send-btn" style="white-space:nowrap;">Add to Project</button>
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
              command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
              resumeSessionId: cId,
            });
            await this.loadSessions();
            await this.loadStats();
            this.renderWorkspaces();
            this.closeModal(null);
            this.showToast(`Added to ${ws ? ws.name : 'project'}`, 'success');
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
      // Immediately update local state
      const session = this.state.sessions.find(s => s.id === sessionId)
        || (this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId));
      if (session) session.model = model || null;
      const otherSession = (this.state.allSessions || []).find(s => s.id === sessionId && s !== session);
      if (otherSession) otherSession.model = model || null;
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

  /**
   * Start a new Claude session with project context pre-injected.
   * Creates a new session in the same workspace/directory, then sends an
   * initial orientation prompt when the terminal connects.
   */
  async startSessionWithContext(sessionId) {
    const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId)
      || this._findProjectSession(sessionId);

    const dir = session ? (session.workingDir || '') : '';
    const wsId = session ? session.workspaceId : (this.state.activeWorkspace ? this.state.activeWorkspace.id : null);

    if (!dir) {
      this.showToast('No working directory found for this session', 'warning');
      return;
    }

    await this._launchContextSession(dir, wsId);
  }

  /**
   * Start a new Claude session with project context from a project directory path.
   * Used by the project-level and project-session context menus.
   */
  async startProjectWithContext(projectPath) {
    if (!projectPath) {
      this.showToast('No project path available', 'warning');
      return;
    }

    const wsId = this.state.activeWorkspace ? this.state.activeWorkspace.id : null;
    await this._launchContextSession(projectPath, wsId);
  }

  /**
   * Shared implementation: create a new session in a directory and inject a
   * context-orientation prompt once the terminal WebSocket connects.
   */
  async _launchContextSession(dir, wsId) {
    const dirParts = dir.replace(/\\/g, '/').split('/');
    const projectName = dirParts[dirParts.length - 1] || 'project';

    try {
      // Create a new session in the workspace (or unassigned if no workspace)
      const payload = {
        name: `${projectName} - context`,
        workspaceId: wsId,
        workingDir: dir,
        command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
      };
      const data = await this.api('POST', '/api/sessions', payload);
      const newSession = data.session || data;
      await this.loadSessions();

      // Open in first empty terminal pane
      const emptySlot = this.terminalPanes.findIndex(p => p === null);
      if (emptySlot === -1) {
        this.showToast('All terminal panes full. Session created but not opened.', 'warning');
        return;
      }

      this.setViewMode('terminal');

      // Build the context prompt that orients Claude on the project
      const contextPrompt = `Read and analyze this project directory. Look at the file structure, any README, CLAUDE.md, PLANNING.md, TODO.md, package.json, or similar files. Understand the tech stack, architecture, and current state of the project. Then give me a brief summary of what you found and ask what I'd like to work on.`;

      // Open the terminal with the session's working directory
      this.openTerminalInPane(emptySlot, newSession.id, newSession.name, { cwd: dir });

      // Wait for the terminal to connect, then send the context prompt
      const tp = this.terminalPanes[emptySlot];
      if (tp) {
        const checkReady = setInterval(() => {
          if (tp.ws && tp.ws.readyState === WebSocket.OPEN && tp.connected) {
            clearInterval(checkReady);
            // Wait for Claude to finish initializing before sending the prompt
            setTimeout(() => {
              tp.ws.send(JSON.stringify({ type: 'input', data: contextPrompt + '\n' }));
            }, 3000);
          }
        }, 500);
        // Timeout after 30 seconds to avoid leaking intervals
        setTimeout(() => clearInterval(checkReady), 30000);
      }

      this.showToast(`Starting ${projectName} with project context...`, 'info');
    } catch (err) {
      this.showToast(err.message || 'Failed to start context session', 'error');
    }
  }

  /**
   * Try to find a project session by sessionId (Claude UUID).
   * Used when starting a context session from a project-panel session.
   */
  _findProjectSession(sessionId) {
    for (const project of (this.state.projects || [])) {
      for (const s of (project.sessions || [])) {
        if (s.claudeSessionId === sessionId) {
          return { workingDir: project.realPath || '', workspaceId: this.state.activeWorkspace ? this.state.activeWorkspace.id : null };
        }
      }
    }
    return null;
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
      // Phase 18-04: native v1.2 shape (Phase 15 back-compat shim retired).
      // /api/discover returns { projects: { claude: [...], codex: [...] } };
      // merge across providers into a flat sorted-by-mtime list so the
      // launcher's modal continues to receive a plain array.
      const data = await this.api('GET', '/api/discover');
      const projects = this._mergeProjectsByProvider(data.projects || {});

      if (projects.length === 0) {
        this.showToast('No projects found on this PC', 'info');
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

        const latestSession = p.sessions && p.sessions.length > 0 ? p.sessions[0] : null;
        const latestSessionId = latestSession ? latestSession.claudeSessionId : '';
        const latestSessionTitle = latestSession ? (latestSession.title || '') : '';
        return `<div class="discover-row" data-path="${this.escapeHtml(p.realPath)}" data-name="${this.escapeHtml(name)}" data-session-id="${this.escapeHtml(latestSessionId)}" data-session-title="${this.escapeHtml(latestSessionTitle)}">
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
          Found <strong>${projects.length}</strong> Claude projects on this PC. Select which ones to import as sessions into the current project.
        </p>
        <div class="discover-actions" style="display: flex; gap: 8px; margin-bottom: 12px;">
          <button class="btn btn-ghost btn-sm" id="discover-select-all">Select All</button>
          <button class="btn btn-ghost btn-sm" id="discover-select-none">Select None</button>
        </div>
        <div class="discover-list" style="max-height: 400px; overflow-y: auto;">${projectRows}</div>
      `;
      this.els.modalConfirmBtn.textContent = 'Import Selected';
      this.els.modalConfirmBtn.className = 'btn btn-primary';
      this.els.modalConfirmBtn.disabled = false;
      this.els.modalCancelBtn.textContent = 'Cancel';
      this.els.modalOverlay.hidden = false;

      // Select all / none
      document.getElementById('discover-select-all').addEventListener('click', () => {
        this.els.modalBody.querySelectorAll('.discover-cb:not(:disabled)').forEach(cb => cb.checked = true);
      });
      document.getElementById('discover-select-none').addEventListener('click', () => {
        this.els.modalBody.querySelectorAll('.discover-cb').forEach(cb => cb.checked = false);
      });

      // Wire confirm button to resolve the promise
      const confirmHandler = () => {
        this.els.modalConfirmBtn.disabled = true;
        this.els.modalConfirmBtn.removeEventListener('click', confirmHandler);
        this.closeModal(true);
      };
      this.els.modalConfirmBtn.addEventListener('click', confirmHandler);

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
            name: row.dataset.sessionTitle || row.dataset.name,
            path: row.dataset.path,
            sessionId: row.dataset.sessionId || '',
          });
        }
      });

      if (selected.length === 0) {
        this.showToast('No projects selected', 'info');
        return;
      }

      // Need an active workspace to import into
      if (!this.state.activeWorkspace) {
        this.showToast('Select or create a project first', 'warning');
        return;
      }

      // Create sessions for each selected project
      let created = 0;
      for (const proj of selected) {
        try {
          const sessionData = {
            name: proj.name,
            workspaceId: this.state.activeWorkspace.id,
            workingDir: proj.path,
            topic: '',
            command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
          };
          // Pass the Claude CLI session UUID so cost tracking works immediately
          if (proj.sessionId) {
            sessionData.resumeSessionId = proj.sessionId;
          }
          await this.api('POST', '/api/sessions', sessionData);
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
    // Migrate legacy "all" mode to "workspace" for existing users
    if (mode === 'all') mode = 'workspace';

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

    // Toggle terminal grid vs session panels vs docs vs resources vs costs vs tasks
    const isTerminal = mode === 'terminal';
    const isDocs = mode === 'docs';
    const isResources = mode === 'resources';
    const isCosts = mode === 'costs';
    const isTasks = mode === 'tasks';
    this.els.sessionListPanel.hidden = isTerminal || isDocs || isResources || isCosts || isTasks;
    this.els.detailPanel.hidden = isTerminal || isDocs || isResources || isCosts || isTasks || !this.state.selectedSession;
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
    if (this.els.costsPanel) {
      this.els.costsPanel.hidden = !isCosts;
    }
    if (this.els.tasksPanel) {
      this.els.tasksPanel.hidden = !isTasks;
    }

    if (isTasks) {
      this._initTasksTabs();
      if (!this._activeTasksTab || this._activeTasksTab === 'worktree') {
        this.renderTasksView();
      }
    } else if (isDocs) {
      this.loadDocs();
      this.loadTdIssues();
    } else if (isResources) {
      this.loadResources();
    } else if (isCosts) {
      this.loadCosts();
    } else if (isTerminal) {
      if (this._tabGroups) this.renderTerminalGroupTabs();
      // Update mobile terminal tab strip when switching to terminal view
      if (this.isMobile) {
        this.updateTerminalTabs();
      }
      // Refit all terminal panes after view switch (viewport size may differ)
      requestAnimationFrame(() => {
        this.terminalPanes.forEach(tp => {
          if (tp) tp.safeFit();
        });
      });
    } else {
      // Update panel title
      const titles = { workspace: 'Sessions', recent: 'Recent Sessions' };
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
        if (tp) tp.safeFit();
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

    const onMove = (clientX) => {
      if (!isResizing) return;
      const dx = clientX - startX;
      const newWidth = Math.max(180, Math.min(600, startWidth + dx));
      sidebar.style.width = newWidth + 'px';
      sidebar.style.transition = 'none'; // disable transition during drag
    };

    const onEnd = () => {
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
        if (tp) tp.safeFit();
      });

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };

    const onMouseMove = (e) => onMove(e.clientX);
    const onTouchMove = (e) => { e.preventDefault(); onMove(e.touches[0].clientX); };

    const startResize = (clientX) => {
      if (sidebar.classList.contains('collapsed')) return;
      isResizing = true;
      startX = clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      document.addEventListener('touchcancel', onEnd);
    };

    handle.addEventListener('mousedown', (e) => { e.preventDefault(); startResize(e.clientX); });
    handle.addEventListener('touchstart', (e) => { e.preventDefault(); startResize(e.touches[0].clientX); }, { passive: false });
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
      projList.style.minHeight = '0';
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
      projList.style.minHeight = '0';
    }
  }


  /* ═══════════════════════════════════════════════════════════
     QUICK SWITCHER
     ═══════════════════════════════════════════════════════════ */

  /**
   * Open the command palette / quick switcher.
   * @param {string} [mode] - Optional mode: 'help' shows feature catalog first
   */
  openQuickSwitcher(mode) {
    this.els.qsOverlay.hidden = false;
    this.els.qsInput.value = '';
    this.qsHighlightIndex = mode === 'help' ? 0 : -1;
    this.qsMode = mode || 'default';
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

  /**
   * Render command palette results with mixed-type search.
   * Searches sessions, workspaces, feature catalog, and settings.
   * Supports '>' prefix for command mode and 'help' mode for feature browsing.
   * @param {string} query - Search query (lowercase trimmed by caller)
   */
  renderQuickSwitcherResults(query) {
    this.qsResults = [];
    const container = this.els.qsResultsContainer;
    const mode = this.qsMode || 'default';
    const catalog = this.getFeatureCatalog().filter(e => !e.isAvailable || e.isAvailable());

    // Command mode: '>' prefix filters to actions only
    if (query.startsWith('>')) {
      const actionQuery = query.slice(1).trim();
      const actions = catalog.filter(e => e.category === 'action');
      if (actionQuery) {
        this.qsResults = actions
          .map(e => ({ type: 'action', item: e, score: this.scoreFeatureMatch(e, actionQuery) }))
          .filter(r => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
      } else {
        this.qsResults = actions.map(e => ({ type: 'action', item: e, score: 50 }));
      }
    }
    // Help mode with no query: show feature catalog grouped by category
    else if (!query && mode === 'help') {
      const actions = catalog.filter(e => e.category === 'action').slice(0, 5);
      const features = catalog.filter(e => e.category === 'feature');
      const shortcuts = catalog.filter(e => e.category === 'shortcut');
      this.qsResults = [
        ...actions.map(e => ({ type: 'action', item: e, score: 50 })),
        ...features.map(e => ({ type: 'feature', item: e, score: 40 })),
        ...shortcuts.map(e => ({ type: 'shortcut', item: e, score: 30 })),
      ];
    }
    // Default mode, empty query: recent sessions + workspaces (original behavior)
    else if (!query) {
      const recentWorkspaces = [...this.state.workspaces].sort((a, b) =>
        new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)
      ).slice(0, 3);
      const recentSessions = [...this.state.sessions].sort((a, b) =>
        new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)
      ).slice(0, 5);
      this.qsResults = [
        ...recentWorkspaces.map(w => ({ type: 'workspace', item: w, score: 50 })),
        ...recentSessions.map(s => ({ type: 'session', item: s, score: 40 })),
      ];
    }
    // Search mode: search everything
    else {
      const q = query.toLowerCase();

      // Match sessions
      const sessionResults = this.state.sessions
        .filter(s =>
          s.name.toLowerCase().includes(q) ||
          (s.topic && s.topic.toLowerCase().includes(q)) ||
          (s.workingDir && s.workingDir.toLowerCase().includes(q))
        )
        .map(s => {
          let score = 0;
          if (s.name.toLowerCase().startsWith(q)) score = 50;
          else if (s.name.toLowerCase().includes(q)) score = 30;
          if (s.topic && s.topic.toLowerCase().includes(q)) score += 10;
          if (s.workingDir && s.workingDir.toLowerCase().includes(q)) score += 5;
          return { type: 'session', item: s, score };
        });

      // Match workspaces
      const workspaceResults = this.state.workspaces
        .filter(w =>
          w.name.toLowerCase().includes(q) ||
          (w.description && w.description.toLowerCase().includes(q))
        )
        .map(w => {
          let score = 0;
          if (w.name.toLowerCase().startsWith(q)) score = 50;
          else if (w.name.toLowerCase().includes(q)) score = 30;
          if (w.description && w.description.toLowerCase().includes(q)) score += 10;
          return { type: 'workspace', item: w, score };
        });

      // Match feature catalog entries
      const featureResults = catalog
        .map(e => ({ type: e.category, item: e, score: this.scoreFeatureMatch(e, q) }))
        .filter(r => r.score > 0);

      // Match settings entries (auto-generated from registry)
      const settingResults = this.getSettingsRegistry()
        .filter(s =>
          s.label.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q)
        )
        .map(s => {
          let score = 0;
          if (s.label.toLowerCase().startsWith(q)) score = 40;
          else if (s.label.toLowerCase().includes(q)) score = 25;
          if (s.description.toLowerCase().includes(q)) score += 10;
          return { type: 'setting', item: s, score };
        });

      // Merge, sort by score, cap at 15
      this.qsResults = [
        ...sessionResults,
        ...workspaceResults,
        ...featureResults,
        ...settingResults,
      ].sort((a, b) => b.score - a.score).slice(0, 15);
    }

    if (this.qsResults.length === 0) {
      container.innerHTML = '<div class="qs-empty">No results found</div>';
      return;
    }

    // Group labels for display
    const groupLabels = {
      workspace: 'Projects', session: 'Sessions', action: 'Actions',
      feature: 'Features', shortcut: 'Shortcuts', setting: 'Settings',
    };

    let html = '';
    let lastType = '';
    this.qsResults.forEach((r, i) => {
      if (r.type !== lastType) {
        html += `<div class="qs-result-group">${groupLabels[r.type] || r.type}</div>`;
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
            <span class="qs-result-type qs-result-type-workspace">project</span>
          </div>`;
      } else if (r.type === 'session') {
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
            <span class="qs-result-type qs-result-type-session">${r.item.status || 'session'}</span>
          </div>`;
      } else {
        // Feature catalog entry (action, feature, shortcut, setting)
        const item = r.item;
        const shortcutHtml = item.shortcut ? `<kbd class="qs-result-shortcut">${this.escapeHtml(item.shortcut)}</kbd>` : '';
        const typeClass = `qs-result-type-${r.type}`;
        const iconHtml = item.icon || '';
        const name = item.name || item.label || '';
        const desc = item.description || '';

        html += `
          <div class="qs-result${highlighted}" data-index="${i}">
            <div class="qs-result-icon qs-result-icon-${r.type}">${iconHtml}</div>
            <div class="qs-result-info">
              <div class="qs-result-name">${this.escapeHtml(name)}</div>
              <div class="qs-result-detail">${this.escapeHtml(desc)}</div>
            </div>
            ${shortcutHtml}
            <span class="qs-result-type ${typeClass}">${r.type}</span>
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

  /**
   * Handle selection of a command palette result.
   * Routes to the appropriate action based on result type.
   * @param {Object} result - The selected result { type, item, score }
   */
  onQuickSwitcherSelect(result) {
    this.closeQuickSwitcher();

    if (result.type === 'workspace') {
      this.setViewMode('workspace');
      this.selectWorkspace(result.item.id);
    } else if (result.type === 'session') {
      this.selectSession(result.item.id);
    } else if (result.type === 'setting') {
      // Navigate to settings panel, scroll to specific setting
      this.scrollToSetting(result.item.key);
    } else {
      // Catalog entry (action, feature, shortcut)
      const entry = result.item;
      if (typeof entry.action === 'function') {
        entry.action();
      } else if (entry.navigateTo) {
        this.setViewMode(entry.navigateTo);
      }
      // Info-only entries with detail text: show toast with detail
      else if (entry.detail) {
        this.showToast(entry.detail, 'info', 5000);
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════
     MODALS
     ═══════════════════════════════════════════════════════════ */

  showConfirmModal({ title, message, confirmText = 'Confirm', confirmClass = 'btn-primary' }) {
    return new Promise((resolve) => {
      this._modalOpen = true;
      this.modalResolve = resolve;
      this.els.modalTitle.textContent = title;
      this.els.modalBody.innerHTML = `<p>${message}</p>`;
      this.els.modalConfirmBtn.textContent = confirmText;
      this.els.modalConfirmBtn.className = `btn ${confirmClass}`;
      this.els.modalCancelBtn.textContent = 'Cancel';

      // Re-enable confirm button (may have been disabled by previous modal interaction)
      this.els.modalConfirmBtn.disabled = false;

      // Rebind confirm - disable button immediately to prevent double-click
      const confirmHandler = () => {
        this.els.modalConfirmBtn.disabled = true;
        this.els.modalConfirmBtn.removeEventListener('click', confirmHandler);
        this.closeModal(true);
      };
      this.els.modalConfirmBtn.addEventListener('click', confirmHandler);

      this.els.modalOverlay.hidden = false;
    });
  }

  showPromptModal({ title, fields, confirmText = 'Confirm', confirmClass = 'btn-primary', headerHtml = '', onHeaderClick = null }) {
    return new Promise((resolve) => {
      this._modalOpen = true;
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
        if (f.type === 'icon') {
          // Merge Lucide icons (bare name) and Material icons (mi/ prefix)
          const lucideIcons = window.__lucideIcons || {};
          const lucideCats  = window.__lucideIconCategories || {};
          const materialIcons = window.__materialIcons || {};
          const materialCats  = window.__materialIconCategories || {};

          const selectedIcon = f.value || '';
          let gridHtml = `<div class="icon-swatch icon-swatch-none${!selectedIcon ? ' selected' : ''}" data-icon="" title="No icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" stroke-dasharray="3 2"/></svg>
          </div>`;

          // Lucide section
          if (Object.keys(lucideCats).length > 0) {
            gridHtml += `<span class="icon-picker-set-sep" data-set="lucide">Lucide</span>`;
            for (const [cat, names] of Object.entries(lucideCats)) {
              gridHtml += `<span class="icon-picker-cat-sep" data-cat="${this.escapeHtml(cat)}">${this.escapeHtml(cat)}</span>`;
              for (const name of names) {
                if (!lucideIcons[name]) continue;
                gridHtml += `<div class="icon-swatch${selectedIcon === name ? ' selected' : ''}" data-icon="${this.escapeHtml(name)}" title="${this.escapeHtml(name)}">${lucideIcons[name]}</div>`;
              }
            }
          }

          // Material section
          if (Object.keys(materialCats).length > 0) {
            gridHtml += `<span class="icon-picker-set-sep" data-set="material">Material</span>`;
            for (const [cat, names] of Object.entries(materialCats)) {
              gridHtml += `<span class="icon-picker-cat-sep" data-cat="${this.escapeHtml('Material — ' + cat)}">${this.escapeHtml(cat)}</span>`;
              for (const name of names) {
                if (!materialIcons[name]) continue;
                const storedName = 'mi/' + name;
                gridHtml += `<div class="icon-swatch${selectedIcon === storedName ? ' selected' : ''}" data-icon="${this.escapeHtml(storedName)}" title="${this.escapeHtml(name)}">${materialIcons[name]}</div>`;
              }
            }
          }

          bodyHtml += `
            <div class="input-group">
              <label class="input-label">${f.label} <span class="field-optional">optional</span></label>
              <div class="icon-picker" id="modal-field-${f.key}">
                <input type="text" class="input icon-picker-search" placeholder="Search icons..." autocomplete="off" spellcheck="false">
                <div class="icon-picker-grid">${gridHtml}</div>
              </div>
            </div>`;
          return;
        }
        if (f.type === 'checkbox') {
          const checked = f.value ? 'checked' : '';
          bodyHtml += `
            <div class="input-group" style="flex-direction:row;align-items:center;gap:8px">
              <input type="checkbox" id="modal-field-${f.key}" ${checked} style="width:16px;height:16px;accent-color:var(--mauve);cursor:pointer">
              <label class="input-label" for="modal-field-${f.key}" style="margin:0;cursor:pointer">${f.label}</label>
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

      this.els.modalBody.innerHTML = (headerHtml || '') + bodyHtml;
      this.els.modalConfirmBtn.textContent = confirmText;
      this.els.modalConfirmBtn.className = `btn ${confirmClass}`;
      this.els.modalCancelBtn.textContent = 'Cancel';

      // Header click handler (for template chips, etc.)
      if (onHeaderClick) {
        this.els.modalBody.addEventListener('click', onHeaderClick);
      }

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

      // Icon picker behavior
      const iconPickers = this.els.modalBody.querySelectorAll('.icon-picker');
      iconPickers.forEach(picker => {
        const grid = picker.querySelector('.icon-picker-grid');
        const search = picker.querySelector('.icon-picker-search');
        // Selection
        grid.addEventListener('click', (e) => {
          const swatch = e.target.closest('.icon-swatch');
          if (!swatch) return;
          grid.querySelectorAll('.icon-swatch').forEach(s => s.classList.remove('selected'));
          swatch.classList.add('selected');
        });
        // Search filter
        if (search) {
          search.addEventListener('input', () => {
            const q = search.value.toLowerCase().trim();
            grid.querySelectorAll('.icon-swatch').forEach(swatch => {
              if (!swatch.dataset.icon) return; // "none" always visible
              // Match against stored name (mi/folder → "folder" for search)
              const searchable = swatch.dataset.icon.replace(/^mi\//, '').replace(/_/g, ' ');
              swatch.hidden = !!q && !searchable.includes(q);
            });
            // Hide category separators when their section is empty
            grid.querySelectorAll('.icon-picker-cat-sep, .icon-picker-set-sep').forEach(sep => {
              if (!q) { sep.hidden = false; return; }
              let next = sep.nextElementSibling;
              let hasVisible = false;
              while (next && !next.classList.contains('icon-picker-cat-sep') && !next.classList.contains('icon-picker-set-sep')) {
                if (!next.hidden) { hasVisible = true; break; }
                next = next.nextElementSibling;
              }
              sep.hidden = !hasVisible;
            });
          });
          search.addEventListener('keydown', e => e.stopPropagation());
        }
      });

      // Re-enable confirm button (may have been disabled by previous modal interaction)
      this.els.modalConfirmBtn.disabled = false;

      // Confirm handler - disable button immediately to prevent double-click
      const confirmHandler = () => {
        this.els.modalConfirmBtn.disabled = true;
        this.els.modalConfirmBtn.removeEventListener('click', confirmHandler);
        const result = {};
        fields.forEach(f => {
          if (f.type === 'color') {
            const selected = this.els.modalBody.querySelector(`#modal-field-${f.key} .color-swatch.selected`);
            result[f.key] = selected ? selected.dataset.color : 'mauve';
          } else if (f.type === 'icon') {
            const selected = this.els.modalBody.querySelector(`#modal-field-${f.key} .icon-swatch.selected`);
            result[f.key] = (selected && selected.dataset.icon) ? selected.dataset.icon : null;
          } else if (f.type === 'checkbox') {
            const el = document.getElementById(`modal-field-${f.key}`);
            if (el) result[f.key] = el.checked;
          } else {
            const el = document.getElementById(`modal-field-${f.key}`);
            if (el) result[f.key] = el.value;
          }
        });
        // Validate required - re-enable button if validation fails so user can try again
        for (const f of fields) {
          if (f.required && !result[f.key]) {
            const el = document.getElementById(`modal-field-${f.key}`);
            if (el && el.focus) el.focus();
            this.els.modalConfirmBtn.disabled = false;
            this.els.modalConfirmBtn.addEventListener('click', confirmHandler);
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

  /**
   * Show a modal with multiple action buttons (beyond simple confirm/cancel).
   * @param {object} opts - Modal options
   * @param {string} opts.title - Modal title
   * @param {string} opts.message - Modal body message (HTML allowed)
   * @param {Array<{label: string, value: string, class: string}>} opts.actions - Action buttons
   * @returns {Promise<string|null>} The chosen action value, or null if cancelled
   */
  showChoiceModal({ title, message, actions = [] }) {
    return new Promise((resolve) => {
      this.modalResolve = resolve;
      this.els.modalTitle.textContent = title;
      this.els.modalBody.innerHTML = `<p>${message}</p>`;

      // Hide default confirm/cancel, render custom action buttons
      this.els.modalConfirmBtn.hidden = true;
      this.els.modalCancelBtn.hidden = true;

      const btnContainer = document.createElement('div');
      btnContainer.className = 'modal-choice-actions';
      btnContainer.style.cssText = 'display:flex;gap:8px;width:100%;justify-content:flex-end;';

      // Cancel button first (leftmost)
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => this.closeModal(null));
      btnContainer.appendChild(cancelBtn);

      // Action buttons
      actions.forEach(a => {
        const btn = document.createElement('button');
        btn.className = `btn ${a.class || 'btn-primary'}`;
        btn.textContent = a.label;
        btn.addEventListener('click', () => this.closeModal(a.value));
        btnContainer.appendChild(btn);
      });

      this.els.modalFooter.appendChild(btnContainer);
      this.els.modalOverlay.hidden = false;
    });
  }

  closeModal(result) {
    this._modalOpen = false;
    this.els.modalOverlay.hidden = true;

    // Clean up any choice modal action buttons
    const choiceActions = this.els.modalFooter.querySelector('.modal-choice-actions');
    if (choiceActions) {
      choiceActions.remove();
      this.els.modalConfirmBtn.hidden = false;
      this.els.modalCancelBtn.hidden = false;
    }

    if (this.modalResolve) {
      this.modalResolve(result);
      this.modalResolve = null;
    }

    // Flush queued SSE events that arrived while modal was open
    if (this._sseQueue && this._sseQueue.length > 0) {
      const queued = this._sseQueue;
      this._sseQueue = [];
      // Deduplicate: only process the latest event per type
      const latest = new Map();
      queued.forEach(evt => latest.set(evt.type, evt));
      latest.forEach(evt => this.handleSSEEvent(evt));
    }
  }


  /* ═══════════════════════════════════════════════════════════
     FOLDER BROWSER
     ═══════════════════════════════════════════════════════════ */

  /**
   * Show a folder browser modal for selecting a directory path.
   * Stacks on top of the generic modal (z-index 10003 vs 10002).
   * @param {string} [initialPath=''] - Starting directory path
   * @returns {Promise<string|null>} Selected directory path or null
   */
  showFolderBrowser(initialPath = '') {
    return new Promise((resolve) => {
      const overlay = document.getElementById('folder-browser-overlay');
      const list = document.getElementById('folder-browser-list');
      const breadcrumb = document.getElementById('folder-browser-breadcrumb');
      const pathDisplay = document.getElementById('folder-browser-path');
      const selectBtn = document.getElementById('folder-browser-select');
      const cancelBtn = document.getElementById('folder-browser-cancel');
      const closeBtn = document.getElementById('folder-browser-close');

      let currentPath = initialPath || '';
      let resolved = false;

      const close = (result) => {
        if (resolved) return;
        resolved = true;
        overlay.hidden = true;
        selectBtn.removeEventListener('click', onSelect);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKeyDown);
        resolve(result);
      };

      const onSelect = () => close(currentPath);
      const onCancel = () => close(null);
      const onOverlayClick = (e) => { if (e.target === overlay) close(null); };
      const onKeyDown = (e) => { if (e.key === 'Escape') close(null); };

      /**
       * Navigate to a directory path - fetches contents and renders.
       * @param {string} dirPath - Directory path to navigate to
       */
      const navigateTo = async (dirPath) => {
        currentPath = dirPath;
        pathDisplay.textContent = dirPath || 'Loading...';
        list.innerHTML = '<div class="folder-browser-loading">Loading...</div>';

        try {
          const data = await this.api('GET', '/api/browse?path=' + encodeURIComponent(dirPath));
          currentPath = data.currentPath;
          pathDisplay.textContent = currentPath;

          // Render breadcrumb - each path segment is clickable
          const normalized = currentPath.replace(/\\/g, '/');
          const segments = normalized.split('/').filter(Boolean);
          let crumbHtml = '';
          for (let i = 0; i < segments.length; i++) {
            const partialPath = segments.slice(0, i + 1).join('/');
            // On Windows, first segment is drive letter - needs trailing backslash
            const clickPath = i === 0 && partialPath.endsWith(':') ? partialPath + '\\' : partialPath;
            const isLast = i === segments.length - 1;
            if (i > 0) crumbHtml += '<span class="folder-browser-sep">&#9656;</span>';
            crumbHtml += `<span class="folder-browser-crumb${isLast ? ' active' : ''}" data-path="${this.escapeHtml(clickPath)}">${this.escapeHtml(segments[i])}</span>`;
          }
          breadcrumb.innerHTML = crumbHtml;
          breadcrumb.querySelectorAll('.folder-browser-crumb').forEach(crumb => {
            crumb.addEventListener('click', () => navigateTo(crumb.dataset.path));
          });

          // Render directory list
          let listHtml = '';
          if (data.parent) {
            listHtml += `<div class="folder-browser-item folder-browser-item-parent" data-path="${this.escapeHtml(data.parent)}">
              <span class="folder-browser-item-icon">&#11168;</span>
              <span class="folder-browser-item-name">..</span>
            </div>`;
          }
          if (data.entries.length === 0) {
            listHtml += '<div class="folder-browser-empty">No subdirectories</div>';
          }
          for (const entry of data.entries) {
            listHtml += `<div class="folder-browser-item" data-path="${this.escapeHtml(entry.path)}">
              <span class="folder-browser-item-icon">&#128193;</span>
              <span class="folder-browser-item-name">${this.escapeHtml(entry.name)}</span>
            </div>`;
          }
          list.innerHTML = listHtml;

          // Single click navigates into the directory
          list.querySelectorAll('.folder-browser-item').forEach(item => {
            item.addEventListener('click', () => navigateTo(item.dataset.path));
          });
        } catch (err) {
          list.innerHTML = `<div class="folder-browser-empty" style="color:var(--red)">Error: ${this.escapeHtml(err.message || 'Failed to browse')}</div>`;
        }
      };

      // Wire up event listeners
      selectBtn.addEventListener('click', onSelect);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeyDown);

      // Show overlay and navigate to initial path
      overlay.hidden = false;
      navigateTo(currentPath);
    });
  }

  /**
   * Inject a "Browse" button next to a workingDir input in the current modal.
   * Call via requestAnimationFrame after showPromptModal() to ensure DOM is ready.
   * @param {string} [fieldId='modal-field-workingDir'] - Input element ID
   */
  _injectBrowseButton(fieldId = 'modal-field-workingDir') {
    const dirInput = document.getElementById(fieldId);
    if (!dirInput) return;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;gap:8px;align-items:stretch';
    dirInput.parentNode.insertBefore(wrapper, dirInput);
    wrapper.appendChild(dirInput);
    dirInput.style.flex = '1';

    const browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'btn btn-ghost btn-sm';
    browseBtn.textContent = 'Browse';
    browseBtn.style.cssText = 'white-space:nowrap;flex-shrink:0;height:auto';
    browseBtn.addEventListener('click', async () => {
      const selected = await this.showFolderBrowser(dirInput.value || '');
      if (selected) {
        dirInput.value = selected;
        dirInput.focus();
      }
    });
    wrapper.appendChild(browseBtn);
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

    // Swipe-to-dismiss: drag right to remove
    let startX = 0, currentX = 0, dragging = false;
    const closeBtn = toast.querySelector('.toast-close');
    const onPointerDown = (e) => {
      // Don't start drag from the close button - let click handle it
      if (closeBtn && closeBtn.contains(e.target)) return;
      startX = e.clientX;
      currentX = 0;
      dragging = true;
      toast.classList.add('toast-dragging');
      toast.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!dragging) return;
      currentX = e.clientX - startX;
      // Only allow dragging to the right
      const offset = Math.max(0, currentX);
      toast.style.transform = `translateX(${offset}px)`;
      toast.style.opacity = Math.max(0, 1 - offset / 200);
    };
    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      toast.classList.remove('toast-dragging');
      if (currentX > 80) {
        // Swiped far enough - dismiss
        toast.classList.add('toast-swipe-exit');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        // Fallback removal if transitionend doesn't fire
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
      } else {
        // Snap back
        toast.style.transform = '';
        toast.style.opacity = '';
      }
    };
    toast.addEventListener('pointerdown', onPointerDown);
    toast.addEventListener('pointermove', onPointerMove);
    toast.addEventListener('pointerup', onPointerUp);

    this.els.toastContainer.appendChild(toast);

    // Auto-dismiss after 60 seconds
    setTimeout(() => this.dismissToast(toast), 60000);
  }

  dismissToast(toast) {
    if (!toast.parentNode) return;
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    // Fallback removal if animationend doesn't fire
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
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

  /**
   * Throttled versions of loadSessions and loadStats to prevent
   * rapid-fire SSE events from triggering dozens of API calls.
   * At most one call per 500ms for sessions, 2000ms for stats.
   */
  _throttledLoadSessions() {
    if (this._loadSessionsTimer) return;
    this._loadSessionsTimer = setTimeout(() => {
      this._loadSessionsTimer = null;
      this.loadSessions().then(() => { if (this._smOpen) this.renderSessionManager(); });
    }, 500);
  }

  _throttledLoadStats() {
    if (this._loadStatsTimer) return;
    this._loadStatsTimer = setTimeout(() => {
      this._loadStatsTimer = null;
      this.loadStats();
    }, 2000);
  }

  handleSSEEvent(data) {
    // Queue events while a modal is open to prevent UI glitches and race conditions
    if (this._modalOpen) {
      if (!this._sseQueue) this._sseQueue = [];
      this._sseQueue.push(data);
      return;
    }

    switch (data.type) {
      case 'session:started':
        this.showToast(`Session "${data.name || 'unknown'}" started`, 'success');
        this._throttledLoadSessions();
        this._throttledLoadStats();
        // Phase 18-02: SSE-driven badge patch. Non-destructive; updates only
        // the .sidebar-tab-badge textContent so scroll position and focus
        // are preserved.
        this._patchProviderTabBadges();
        break;
      case 'session:stopped':
        this.showToast(`Session "${data.name || 'unknown'}" stopped`, 'info');
        this._throttledLoadSessions();
        this._throttledLoadStats();
        this._patchProviderTabBadges();
        break;
      case 'session:error':
        this.showToast(`Session "${data.name || 'unknown'}" encountered an error`, 'error');
        this._throttledLoadSessions();
        this._throttledLoadStats();
        this._patchProviderTabBadges();
        break;
      case 'session:created':
      case 'session:deleted':
      case 'session:updated':
      case 'session:moved':
        this._throttledLoadSessions();
        this._throttledLoadStats();
        this._patchProviderTabBadges();
        break;
      case 'workspace:created':
      case 'workspace:deleted':
      case 'workspace:updated':
        this.loadWorkspaces();
        this._throttledLoadStats();
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
      case 'discover:refreshed':
        // Plan 22-03: a provider's filesystem watcher (or fallback poll)
        // detected a change. Re-fetch /api/discover so the sidebar
        // Discovered Projects panel shows new Codex Desktop / CLI
        // sessions without the user clicking Refresh. The throttled
        // variant avoids burst rebuilds when multiple events fire in
        // rapid succession.
        if (typeof this.loadProjects === 'function') {
          this.loadProjects();
        }
        break;
      case 'tunnel:opened':
      case 'tunnel:closed':
        if (this.state.viewMode === 'resources') this.fetchResources();
        break;
      case 'namedTunnel:status': {
        // Update status display if the settings panel is currently open
        const ntEl = document.getElementById('named-tunnel-status');
        if (ntEl) {
          const dot = data.running ? (data.status === 'connected' ? '🟢' : '🟡') : '⚫';
          ntEl.textContent = dot + ' ' + (data.running ? data.status : 'stopped');
          const startBtn = document.getElementById('named-tunnel-start-btn');
          const stopBtn = document.getElementById('named-tunnel-stop-btn');
          if (startBtn) startBtn.disabled = data.running;
          if (stopBtn) stopBtn.disabled = !data.running;
        }
        break;
      }
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
          <p style="font-size: 12px; color: var(--overlay0); margin-bottom: 8px;">No projects</p>
          <button class="btn btn-ghost btn-sm" id="sidebar-create-ws">Create one</button>
        </div>`;
      const btn = document.getElementById('sidebar-create-ws');
      if (btn) btn.addEventListener('click', () => this.createWorkspace());
      this.els.workspaceCount.textContent = '0 projects';
      return;
    }

    const colorMap = {
      mauve: '#cba6f7', blue: '#89b4fa', green: '#a6e3a1', red: '#f38ba8',
      peach: '#fab387', teal: '#94e2d5', pink: '#f5c2e7', yellow: '#f9e2af',
      lavender: '#b4befe', sapphire: '#74c7ec', sky: '#89dceb', flamingo: '#f2cdcd',
      rosewater: '#f5e0dc',
    };

    // Phase 18-02: render-time provider filter. 'all' lets every session
    // through; any other value filters to sessions matching that provider.
    // The filter is applied to allWsSessions BEFORE the hidden-set filter
    // so hidden counts reflect the visible (per-tab) subset.
    const activeTab = this.state.activeProviderTab || 'all';
    const matchesActiveProvider = (s) => activeTab === 'all'
      || (s && (s.provider || 'claude')) === activeTab; /* gsd:provider-literal-allowed */

    const renderWorkspaceItem = (ws) => {
      const isActive = this.state.activeWorkspace && this.state.activeWorkspace.id === ws.id;
      const color = colorMap[ws.color] || colorMap.mauve;
      // Plan 22-05: detect group membership so the workspace row shows a
      // left-edge stripe in the group's color and a chip with the group
      // name + × remove affordance. group.color can be a token name
      // ('blue', 'mauve', ...) that maps through colorMap, or a raw color.
      const groupForWs = Object.values(this.state.workspaceGroups || {})
        .find(g => Array.isArray(g.workspaceIds) && g.workspaceIds.includes(ws.id)) || null;
      const groupColor = groupForWs
        ? (colorMap[groupForWs.color] || groupForWs.color || colorMap.blue)
        : '';
      const groupAttrs = groupForWs
        ? ` data-group-id="${this.escapeHtml(groupForWs.id)}" data-group-color="${this.escapeHtml(groupColor)}"`
        : '';
      const groupChipHtml = groupForWs
        ? `<span class="ws-group-chip" title="In group: ${this.escapeHtml(groupForWs.name)}">
             <span class="ws-group-chip-name">${this.escapeHtml(groupForWs.name)}</span>
             <button class="ws-group-chip-remove" data-action="remove-from-group" data-workspace-id="${this.escapeHtml(ws.id)}" title="Remove from group" aria-label="Remove from group">&times;</button>
           </span>`
        : '';
      const rawWsSessions = (this.state.allSessions || this.state.sessions).filter(s => s.workspaceId === ws.id);
      const allWsSessions = rawWsSessions.filter(matchesActiveProvider);
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

      // Build a lookup map for session sizes from projects data
      const sessionSizeMap = {};
      (this.state.projects || []).forEach(p => {
        (p.sessions || []).forEach(ps => {
          if (ps.size) sessionSizeMap[ps.claudeSessionId] = ps.size;
        });
      });

      const renderSessionItem = (s) => {
        const isHidden = this.state.hiddenSessions.has(s.id);
        const name = s.name || s.id.substring(0, 12);

        // Tri-state dot for worktree task sessions, simple dot for regular sessions
        let statusDot, tristateAttr = '';
        const wtTask = s.worktreeTask ? (this._worktreeTaskCache || []).find(t => t.sessionId === s.id) : null;
        if (wtTask) {
          // Check if terminal pane is actively producing output
          const tp = this.terminalPanes.find(p => p && p.sessionId === s.id);
          const isOutputActive = tp && (Date.now() - tp._lastOutputTime) < 3000;
          if (s.status === 'running' && isOutputActive) {
            statusDot = 'var(--green)'; tristateAttr = ' data-tristate="busy"';
          } else if (s.status === 'running') {
            statusDot = 'var(--peach)'; tristateAttr = ' data-tristate="waiting"';
          } else if (wtTask.branchAhead > 0) {
            statusDot = 'var(--blue)'; tristateAttr = ' data-tristate="ready"';
          } else {
            statusDot = 'var(--overlay0)'; tristateAttr = '';
          }
        } else {
          statusDot = s.status === 'running' ? 'var(--green)' : 'var(--overlay0)';
        }
        const timeStr = s.lastActive ? this.relativeTime(s.lastActive) : '';
        // Look up JSONL file size via resumeSessionId
        const sizeBytes = s.resumeSessionId ? sessionSizeMap[s.resumeSessionId] : null;
        const sizeStr = sizeBytes ? this.formatSize(sizeBytes) : '';

        // Build inline badges for extra session metadata
        let badges = '';
        // Port badge - show first discovered port
        if (s.ports && s.ports.length > 0) {
          badges += `<span class="session-badge session-badge-port">:${s.ports[0]}</span>`;
        }
        // Bypass permissions warning badge
        if (s.bypassPermissions) {
          badges += `<span class="session-badge session-badge-warn">bypass</span>`;
        }
        // Non-default model badge (show short label)
        if (s.model) {
          const modelShort = s.model.includes('opus') ? 'opus'
            : s.model.includes('sonnet') ? 'sonnet'
            : s.model.includes('haiku') ? 'haiku'
            : s.model.split('-').pop();
          badges += `<span class="session-badge session-badge-model">${this.escapeHtml(modelShort)}</span>`;
        }
        // Cost badge (best-effort from cache).
        // Phase 18-04 (COST-02): if the session's provider does NOT support
        // cost tracking (Codex today), render an em-dash with a tooltip
        // instead of a misleading '$0.00'. The provider lookup falls back
        // to true (Claude semantics) when state.providers has not loaded yet.
        const costProvider = this._getProviderById(s.provider || 'claude'); /* gsd:provider-literal-allowed */
        const supportsCost = costProvider ? (costProvider.supportsCost !== false) : true;
        if (supportsCost) {
          const cachedCost = this._getSessionCostCached(s.id);
          if (cachedCost !== null && cachedCost !== undefined) {
            badges += `<span class="session-badge session-badge-cost">$${Number(cachedCost).toFixed(2)}</span>`;
          }
        } else {
          badges += `<span class="session-badge session-badge-cost-na" title="Cost not tracked for this provider">&mdash;</span>`;
        }
        // Subagent badge (from cached data)
        const cachedSubagents = this._getSubagentsCached(s.id);
        if (cachedSubagents !== null && cachedSubagents > 0) {
          badges += `<span class="session-badge session-badge-agents">${cachedSubagents}</span>`;
        }
        // Tag badges (from session)
        if (s.tags && s.tags.length > 0) {
          for (const tag of s.tags.slice(0, 3)) {
            const color = this._tagColor(tag);
            badges += `<span class="session-badge session-badge-tag" style="background:color-mix(in srgb, var(--${color}) 15%, transparent);color:var(--${color});">${this.escapeHtml(tag)}</span>`;
          }
        }

        // Three-layer indicator — one per place this session is open across all tab groups
        const pip = this.renderInstanceIndicatorRow(s.id);

        // Build meta row (badges + size + time) — only if there's something to show
        const metaParts = [badges, sizeStr ? `<span class="ws-session-size">${sizeStr}</span>` : ''].filter(Boolean).join('');
        const metaRow = metaParts ? `<div class="ws-session-meta-row">${metaParts}</div>` : '';
        const timeEl = timeStr ? `<span class="ws-session-time">${timeStr}</span>` : '';

        // Phase 18 data-provider default for sessions from pre-v1.2 servers lacking the field.
        const sessProvider = this.escapeHtml(s.provider || 'claude'); /* gsd:provider-literal-allowed */
        return `<div class="ws-session-item${isHidden ? ' ws-session-hidden' : ''}" data-session-id="${s.id}" data-provider="${sessProvider}" draggable="true" title="${this.escapeHtml(s.workingDir || '')}">
          <span class="ws-session-dot${tristateAttr}" style="background: ${statusDot}"></span>
          <span class="ws-session-name">${this.escapeHtml(name)}</span>${pip}${timeEl}
          ${metaRow}
        </div>`;
      };

      const dirKeys = Object.keys(sessionsByDir);
      let sessionItems;
      if (dirKeys.length === 0) {
        sessionItems = '';
      } else if (dirKeys.length === 1 && dirKeys[0] === '(no directory)') {
        // Only sessions without a directory - flat list
        sessionItems = wsSessions.map(renderSessionItem).join('');
      } else {
        // Always show project directory headers (even for single directory)
        // This enables right-click → new session on the directory
        sessionItems = dirKeys.map(dir => {
          const dirSessions = sessionsByDir[dir];
          const groupKey = ws.id + ':' + dir;
          // Default: expanded (true or missing). Explicitly false = collapsed.
          const isExpanded = projectGroupState[groupKey] !== false;
          // Show last 2 path segments for readability
          const parts = dir.replace(/\\/g, '/').split('/');
          const shortDir = parts.slice(-2).join('/');
          return `<div class="ws-project-group" data-group-key="${this.escapeHtml(groupKey)}">
            <div class="ws-project-group-header" data-dir="${this.escapeHtml(dir)}" data-ws-id="${ws.id}" title="${this.escapeHtml(dir)}">
              <span class="ws-project-group-chevron${isExpanded ? ' open' : ''}">&#9654;</span>
              <span class="ws-project-group-path">${this.escapeHtml(shortDir)}</span>
              <span class="ws-project-group-count">${dirSessions.length}</span>
            </div>
            <div class="ws-project-group-body"${isExpanded ? '' : ' hidden'}>
              ${dirSessions.map(renderSessionItem).join('')}
            </div>
          </div>`;
        }).join('');
      }

      // Respect persisted collapse state: active workspace stays open unless user manually collapsed it
      const isManuallyCollapsed = this._wsCollapseState && this._wsCollapseState[ws.id] === true;
      const showBody = isActive && !isManuallyCollapsed;
      const isWsHidden = this.state.hiddenWorkspaces.has(ws.id);

      return `
        <div class="workspace-accordion${isWsHidden ? ' hidden-item' : ''}" data-id="${ws.id}">
          <div class="workspace-item${isActive ? ' active' : ''}" data-id="${ws.id}"${groupAttrs} draggable="true" style="--ws-color: ${color};${groupColor ? ' --ws-group-color: ' + groupColor + ';' : ''}">
            <span class="ws-chevron${showBody ? ' open' : ''}">&#9654;</span>
            ${(() => {
              const iconSvg = ws.icon
                ? (ws.icon.startsWith('mi/')
                    ? window.__materialIcons?.[ws.icon.slice(3)]
                    : window.__lucideIcons?.[ws.icon])
                : null;
              return iconSvg
                ? `<span class="workspace-icon" style="color: ${color}">${iconSvg}</span>`
                : `<div class="workspace-color-dot" style="background: ${color}"></div>`;
            })()}
            <div class="workspace-info">
              <div class="workspace-name">${this.escapeHtml(ws.name)}<span class="ws-count-badge">${sessionCount}</span></div>
            </div>
            ${groupChipHtml}
            <div class="workspace-actions">
              ${this.state.settings.enableWorktreeTasks ? `<button class="btn btn-ghost btn-icon btn-sm ws-new-task-btn" data-ws-id="${ws.id}" title="New Task">+</button>` : ''}
              <button class="btn btn-ghost btn-icon btn-sm ws-more-btn" data-id="${ws.id}" title="More actions">&#8230;</button>
            </div>
          </div>
          <div class="workspace-accordion-body"${showBody ? '' : ' hidden'}>
            ${sessionItems || '<div class="ws-session-empty">No sessions</div>'}
          </div>
        </div>`;
    };

    // Split workspaces into grouped and ungrouped
    const allGroups = this.state.groups || [];
    // Filter hidden groups (unless showHidden is on)
    const groups = allGroups.filter(g => this.state.showHidden || !this.state.hiddenGroups.has(g.id));
    const groupedIds = new Set();
    allGroups.forEach(g => (g.workspaceIds || []).forEach(id => groupedIds.add(id)));
    const ungrouped = workspaces
      .filter(ws => !groupedIds.has(ws.id))
      .filter(ws => this.state.showHidden || !this.state.hiddenWorkspaces.has(ws.id));

    let html = '';

    // Render categories (groups) at the top
    groups.forEach(group => {
      const groupColor = colorMap[group.color] || colorMap.mauve;
      const groupWorkspaces = (group.workspaceIds || [])
        .map(id => workspaces.find(ws => ws.id === id))
        .filter(Boolean)
        .filter(ws => this.state.showHidden || !this.state.hiddenWorkspaces.has(ws.id));

      // Show empty groups too so user can drag workspaces into them
      const groupCount = groupWorkspaces.length;
      const isCollapsed = this._groupCollapseState && this._groupCollapseState[group.id] === true;
      const isGroupHidden = this.state.hiddenGroups.has(group.id);
      const groupItemsHtml = groupCount > 0
        ? groupWorkspaces.map(ws => renderWorkspaceItem(ws)).join('')
        : '<div class="workspace-group-empty">Drag projects here</div>';

      html += `
        <div class="workspace-group${isGroupHidden ? ' hidden-item' : ''}" data-group-id="${group.id}">
          <div class="workspace-group-header" data-group-id="${group.id}" style="--group-color: ${groupColor}">
            <span class="group-chevron${isCollapsed ? '' : ' open'}">&#9662;</span>
            <span class="group-color-dot" style="background: ${groupColor}"></span>
            <span class="group-name">${this.escapeHtml(group.name)}</span>
            <span class="group-count">${groupCount}</span>
          </div>
          <div class="workspace-group-items"${isCollapsed ? ' hidden' : ''}>
            ${groupItemsHtml}
          </div>
        </div>`;
    });

    // Visual divider between categories and uncategorized projects
    if (groups.length > 0 && ungrouped.length > 0) {
      html += `<div class="sidebar-section-divider"><span class="sidebar-section-divider-label">Uncategorized</span></div>`;
    }

    // Render ungrouped projects
    html += ungrouped.map(ws => renderWorkspaceItem(ws)).join('');

    list.innerHTML = html;

    // Fetch all session costs in a single batch request (non-blocking)
    this._fetchSessionCostsAsync();

    // Re-apply schedule indicators since renderWorkspaces() rewrote the tree.
    if (this._scheduleCounts) this.applyScheduleIndicators();

    this.els.workspaceCount.textContent = `${workspaces.length} project${workspaces.length !== 1 ? 's' : ''}`;
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
      { label: 'Open All in Tab', icon: '&#128448;', action: () => this.openWorkspaceInTabGroup(workspaceId) },
      { label: 'New Feature Session', icon: '&#9733;', action: () => this.startFeatureSession(workspaceId) },
      { label: 'Create Worktree', icon: '&#128268;', action: () => this.createWorktree(workspaceId) },
      ...(this.getSetting('enableWorktreeTasks') ? [
        { label: 'New Worktree Task', icon: '&#128736;', action: () => this.startWorktreeTask(workspaceId) },
      ] : []),
      { type: 'sep' },
      { label: 'Edit', icon: '&#9998;', action: () => this.renameWorkspace(workspaceId) },
      { label: ws.autoSummary !== false ? 'Auto-Docs \u2713' : 'Auto-Docs',
        icon: '&#128221;',
        action: async () => {
          const newVal = ws.autoSummary === false ? true : false;
          await this.api('PUT', `/api/workspaces/${workspaceId}`, { autoSummary: newVal });
          await this.loadWorkspaces();
          this.showToast(`Auto-docs ${newVal ? 'enabled' : 'disabled'}`, 'info');
        }
      },
      { type: 'sep' },
      ...(groupItems.length > 0 ? [
        { label: 'Move to Category', icon: '&#8594;', disabled: true },
        ...groupItems,
        { type: 'sep' },
      ] : []),
      // If workspace is already in a group, offer to ungroup it
      ...(() => {
        const currentGroup = groups.find(g => (g.workspaceIds || []).includes(workspaceId));
        if (currentGroup) {
          return [{ label: `Remove from "${currentGroup.name}"`, icon: '&#8592;', action: () => this.removeWorkspaceFromGroup(workspaceId) }, { type: 'sep' }];
        }
        return [];
      })(),
      { label: 'New Category...', icon: '&#43;', action: () => this.createGroup() },
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
    items.push({ label: 'Hide Project', icon: '&#128065;', action: () => this.hideWorkspace(workspaceId) });
    items.push({ label: 'Delete Project', icon: '&#10005;', action: () => this.deleteWorkspace(workspaceId), danger: true });

    this._renderContextItems(ws.name, items, x, y);
  }

  async createGroup() {
    const result = await this.showPromptModal({
      title: 'New Category',
      fields: [
        { key: 'name', label: 'Category Name', placeholder: 'My Category', required: true },
        { key: 'color', label: 'Color', type: 'color' },
      ],
      confirmText: 'Create',
      confirmClass: 'btn-primary',
    });

    if (!result) return;

    try {
      await this.api('POST', '/api/groups', { name: result.name, color: result.color || 'mauve' });
      this.showToast('Category created', 'success');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to create category', 'error');
    }
  }

  async moveWorkspaceToGroup(workspaceId, groupId) {
    try {
      await this.api('POST', `/api/groups/${groupId}/add`, { workspaceId });
      this.showToast('Project added to category', 'success');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to move project', 'error');
    }
  }

  async removeWorkspaceFromGroup(workspaceId) {
    // Find which group it's in and remove it
    const groups = this.state.groups || [];
    const group = groups.find(g => (g.workspaceIds || []).includes(workspaceId));
    if (!group) return;

    const newIds = (group.workspaceIds || []).filter(id => id !== workspaceId);
    try {
      await this.api('PUT', `/api/groups/${group.id}`, { workspaceIds: newIds });
      this.showToast('Project removed from category', 'info');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to remove project', 'error');
    }
  }

  /**
   * Summarize a session and add the summary to its workspace docs.
   * Unlike summarizeSession() which shows a modal, this directly adds to docs.
   */
  async summarizeSessionToDocs(sessionId) {
    try {
      this.showToast('Summarizing session...', 'info');
      const data = await this.api('POST', `/api/sessions/${sessionId}/summarize`);
      if (data && data.summary) {
        this.showToast('Summary added to project docs', 'success');
        // Refresh docs if currently in docs view
        if (this.state.viewMode === 'docs') {
          this.loadDocs();
        }
      } else {
        this.showToast('No summary data available', 'info');
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to summarize', 'error');
    }
  }

  async deleteGroup(groupId) {
    const groups = this.state.groups || [];
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const confirmed = await this.showConfirmModal({
      title: 'Delete Category',
      message: `Delete "${group.name}"? Projects inside will become uncategorized.`,
      confirmText: 'Delete',
      confirmClass: 'btn-danger',
    });
    if (!confirmed) return;

    try {
      await this.api('DELETE', `/api/groups/${groupId}`);
      this.showToast('Category deleted', 'info');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to delete category', 'error');
    }
  }

  async renameGroup(groupId) {
    const groups = this.state.groups || [];
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const result = await this.showPromptModal({
      title: 'Edit Category',
      fields: [
        { key: 'name', label: 'Category Name', value: group.name, required: true },
        { key: 'color', label: 'Color', type: 'color', value: group.color },
      ],
      confirmText: 'Save',
      confirmClass: 'btn-primary',
    });
    if (!result) return;

    try {
      await this.api('PUT', `/api/groups/${groupId}`, { name: result.name, color: result.color || group.color });
      this.showToast('Category updated', 'success');
      await this.loadGroups();
      this.renderWorkspaces();
    } catch (err) {
      this.showToast(err.message || 'Failed to update category', 'error');
    }
  }

  showGroupContextMenu(groupId, x, y) {
    const groups = this.state.groups || [];
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const items = [
      { label: 'Edit Category', icon: '&#9998;', action: () => this.renameGroup(groupId) },
      { type: 'sep' },
      { label: 'Hide Category', icon: '&#128065;', action: () => this.hideGroup(groupId) },
      { label: 'Delete Category', icon: '&#10005;', danger: true, action: () => this.deleteGroup(groupId) },
    ];

    this._renderContextItems(group.name, items, x, y);
  }

  /**
   * Poll /api/schedules/summary every 10 s and apply active-schedule
   * indicators to pane badges, pane titles, and sidebar session items.
   * Refreshes on the same cadence as the existing per-pane git poller.
   */
  startSchedulePolling() {
    if (this._scheduleSummaryInterval) return;
    this._scheduleCounts = {};
    this.refreshScheduleIndicators();
    this._scheduleSummaryInterval = setInterval(() => this.refreshScheduleIndicators(), 10_000);
  }

  async refreshScheduleIndicators() {
    if (!this.state || !this.state.token) return;
    try {
      const r = await fetch('/api/schedules/summary', {
        headers: { Authorization: 'Bearer ' + this.state.token },
        credentials: 'same-origin',
      });
      if (!r.ok) return;
      const data = await r.json();
      this._scheduleCounts = (data && data.counts) || {};
      this.applyScheduleIndicators();
    } catch (_) { /* network blip — try again next tick */ }
  }

  applyScheduleIndicators() {
    const counts = this._scheduleCounts || {};

    // Pane badge + title-bar clock for each terminal pane
    for (let i = 0; i < 6; i++) {
      const paneEl = document.getElementById(`term-pane-${i}`);
      if (!paneEl) continue;
      const tp = this.terminalPanes[i];
      const sid = tp ? tp.sessionId : null;
      const n = sid ? (counts[sid] || 0) : 0;

      // Floating clock button badge (number)
      const btn = paneEl.querySelector('.terminal-pane-schedule');
      if (btn) {
        const badge = btn.querySelector('.pane-schedule-count');
        if (badge) {
          badge.textContent = n > 0 ? String(n) : '';
          badge.hidden = !(n > 0);
        }
      }

      // Inline clock icon inside the title span (right after the text) so it
      // sits flush against the title without being pushed by header flex gap.
      const titleEl = paneEl.querySelector('.terminal-pane-title');
      if (titleEl) {
        let titleClock = titleEl.querySelector('.pane-title-clock');
        if (n > 0) {
          if (!titleClock) {
            titleClock = document.createElement('span');
            titleClock.className = 'pane-title-clock';
            titleClock.title = 'Has scheduled messages';
            titleClock.innerHTML = '<svg width="13" height="13"><use href="#icon-clock"/></svg>';
            titleEl.appendChild(titleClock);
          }
        } else if (titleClock) {
          titleClock.remove();
        }
      }
    }

    // Sidebar items live in two lists with different DOM shapes:
    //   .session-item[data-id]            (all-sessions list, .session-name child)
    //   .ws-session-item[data-session-id] (per-workspace tree, .ws-session-name child)
    // Names use ellipsis overflow, so the icon gets prepended (not appended).
    const sidebarTargets = [
      { itemSel: '.session-item[data-id]',           idAttr: 'id',        nameSel: '.session-name' },
      { itemSel: '.ws-session-item[data-session-id]', idAttr: 'sessionId', nameSel: '.ws-session-name' },
    ];
    for (const { itemSel, idAttr, nameSel } of sidebarTargets) {
      document.querySelectorAll(itemSel).forEach(item => {
        const sid = item.dataset[idAttr];
        if (!sid) return;
        const n = counts[sid] || 0;
        const nameEl = item.querySelector(nameSel);
        if (!nameEl) return;
        let icon = nameEl.querySelector('.session-schedule-clock');
        if (n > 0) {
          if (!icon) {
            icon = document.createElement('span');
            icon.className = 'session-schedule-clock';
            icon.title = `${n} scheduled message${n === 1 ? '' : 's'}`;
            icon.innerHTML = '<svg width="11" height="11"><use href="#icon-clock"/></svg>';
            nameEl.prepend(icon);
          } else {
            icon.title = `${n} scheduled message${n === 1 ? '' : 's'}`;
          }
        } else if (icon) {
          icon.remove();
        }
      });
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


    // Re-apply schedule indicators since renderSessions() rewrites the list
    if (this._scheduleCounts) this.applyScheduleIndicators();

    // Async: patch in git branch badges
    const sessionItems = list.querySelectorAll('.session-item[data-id]');
    sessionItems.forEach(el => {
      const sid = el.dataset.id;
      const session = sessions.find(s => s.id === sid);
      if (!session || !session.workingDir) return;
      this.fetchGitStatus(session.workingDir).then(gitInfo => {
        if (!gitInfo || !gitInfo.isGitRepo) return;
        const nameEl = el.querySelector('.session-name');
        if (!nameEl || nameEl.querySelector('.git-branch-badge')) return;
        const badge = document.createElement('span');
        badge.className = 'git-branch-badge' + (gitInfo.dirty ? ' dirty' : '');
        badge.title = gitInfo.dirty ? 'Uncommitted changes' : 'Clean';
        badge.textContent = gitInfo.branch + (gitInfo.dirty ? '*' : '');
        nameEl.appendChild(badge);
      });
    });
  }

  renderSessionDetail() {
    const session = this.state.selectedSession;
    // Never show detail panel in terminal, docs, or resources view
    if (!session || this.state.viewMode === 'terminal' || this.state.viewMode === 'docs' || this.state.viewMode === 'resources') {
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
    let cmdDisplay = session.command || 'claude'; // gsd:provider-literal-allowed (v1.1 frontend display fallback; refactor deferred to Phase 18)
    if (session.model) {
      const modelShort = session.model.includes('opus') ? 'opus' : session.model.includes('sonnet') ? 'sonnet' : session.model.includes('haiku') ? 'haiku' : session.model;
      cmdDisplay += ' --model ' + modelShort;
    }
    if (session.bypassPermissions) cmdDisplay += ' --dangerously-skip-permissions';
    if (session.verbose) cmdDisplay += ' --verbose';
    this.els.detailCommand.textContent = cmdDisplay;
    this.els.detailPid.textContent = session.pid || '--';

    // Show ports from cached resource data
    if (this.els.detailPorts) {
      const resourceSession = (this.state.resourceData?.claudeSessions || []).find(rs => rs.sessionId === session.id);
      const ports = resourceSession?.ports || [];
      this.els.detailPorts.innerHTML = ports.length > 0
        ? ports.map(p => '<a href="http://localhost:' + p + '" target="_blank" class="port-link">' + p + '</a>').join(', ')
        : '--';
    }

    // Show git branch (async)
    if (this.els.detailBranch) {
      this.els.detailBranch.textContent = '--';
      if (session.workingDir) {
        this.fetchGitStatus(session.workingDir).then(gitInfo => {
          if (!this.els.detailBranch) return;
          if (!gitInfo || !gitInfo.isGitRepo) { this.els.detailBranch.textContent = '--'; return; }
          let text = gitInfo.branch + (gitInfo.dirty ? ' (dirty)' : ' (clean)');
          if (gitInfo.ahead > 0 || gitInfo.behind > 0) text += ' [+' + gitInfo.ahead + '/-' + gitInfo.behind + ']';
          this.els.detailBranch.textContent = text;
        });
      }
    }

    this.els.detailCreated.textContent = session.createdAt ? this.formatDateTime(session.createdAt) : '--';
    this.els.detailLastActive.textContent = session.lastActive ? this.relativeTime(session.lastActive) : '--';

    // Control buttons - enable/disable based on status
    const isRunning = status === 'running' || status === 'idle';
    this.els.detailStartBtn.disabled = isRunning;
    this.els.detailStopBtn.disabled = !isRunning;
    this.els.detailRestartBtn.disabled = !isRunning;

    // Logs
    this.renderLogs(session.logs || []);

    // Cost tracking - fetch async
    this.loadSessionCost(session.id);

    // Subagent tracking - fetch async
    this.loadSessionSubagents(session.id);

    // Worktree task review banner (only when feature is enabled)
    this.renderWorktreeTaskBanner(session);

    // Workspace analytics - show when session belongs to a workspace
    if (session.workspaceId) {
      this.loadWorkspaceAnalytics(session.workspaceId);
    } else if (this.els.detailAnalytics) {
      this.els.detailAnalytics.hidden = true;
    }
  }

  async loadSessionCost(sessionId) {
    if (!this.els.detailCost) return;
    try {
      const data = await this.api('GET', `/api/sessions/${sessionId}/cost`);
      if (!data || !data.cost || data.cost.total === 0) {
        this.els.detailCost.hidden = true;
        return;
      }
      this.els.detailCost.hidden = false;
      this.els.detailCostTotal.textContent = '$' + data.cost.total.toFixed(2);

      // Breakdown grid
      const items = [
        { label: 'Input', value: '$' + data.cost.input.toFixed(3) },
        { label: 'Output', value: '$' + data.cost.output.toFixed(3) },
        { label: 'Cache Write', value: '$' + data.cost.cacheWrite.toFixed(3) },
        { label: 'Cache Read', value: '$' + data.cost.cacheRead.toFixed(3) },
      ];
      this.els.detailCostBreakdown.innerHTML = items.map(i =>
        `<div class="cost-item"><span>${i.label}</span><span class="cost-item-value">${i.value}</span></div>`
      ).join('');

      // Token bar (proportional widths)
      const total = (data.tokens.input || 0) + (data.tokens.output || 0) + (data.tokens.cacheRead || 0) + (data.tokens.cacheWrite || 0);
      if (total > 0) {
        const inputPct = ((data.tokens.input + data.tokens.cacheWrite) / total * 100).toFixed(1);
        const outputPct = (data.tokens.output / total * 100).toFixed(1);
        this.els.detailTokenBar.innerHTML = `
          <div class="token-bar-fill token-bar-input" style="width:${inputPct}%;display:inline-block"></div>
          <div class="token-bar-fill token-bar-output" style="width:${outputPct}%;display:inline-block"></div>
          <div class="token-bar-fill token-bar-cache" style="width:${(100 - parseFloat(inputPct) - parseFloat(outputPct)).toFixed(1)}%;display:inline-block"></div>
        `;
      }

      // Add message count + model info below cost
      let infoHtml = '';
      if (data.messageCount) {
        const modelInfo = data.modelBreakdown ? Object.keys(data.modelBreakdown).map(m => {
          const short = m.includes('opus') ? 'Opus' : m.includes('sonnet') ? 'Sonnet' : m.includes('haiku') ? 'Haiku' : m;
          return short;
        }).join(', ') : '';
        infoHtml += `<div style="font-size:11px;color:var(--subtext0);margin-top:6px">${data.messageCount} messages${modelInfo ? ' · ' + modelInfo : ''}</div>`;
      }

      // Context window usage bar (quota)
      if (data.quota && data.quota.latestInputTokens > 0) {
        const latest = data.quota.latestInputTokens;
        const peak = data.quota.peakInputTokens;
        const maxWindow = 200000; // 200K context window
        const pct = Math.min(100, (latest / maxWindow * 100)).toFixed(0);
        const peakPct = Math.min(100, (peak / maxWindow * 100)).toFixed(0);
        const urgency = pct >= 80 ? 'critical' : pct >= 50 ? 'warning' : 'ok';
        const urgencyColor = urgency === 'critical' ? 'var(--red)' : urgency === 'warning' ? 'var(--yellow)' : 'var(--green)';
        const latestK = (latest / 1000).toFixed(0);
        const peakK = (peak / 1000).toFixed(0);

        infoHtml += `
          <div style="margin-top:8px;font-size:11px;color:var(--subtext0)">
            <div style="display:flex;justify-content:space-between;margin-bottom:3px">
              <span>Context: <strong style="color:${urgencyColor}">${latestK}K</strong> / 200K tokens (${pct}%)</span>
              <span>Peak: ${peakK}K</span>
            </div>
            <div style="height:6px;background:var(--surface0);border-radius:3px;overflow:hidden;position:relative">
              <div style="height:100%;width:${pct}%;background:${urgencyColor};border-radius:3px;transition:width 0.3s"></div>
            </div>
            ${urgency !== 'ok' ? `<div style="color:${urgencyColor};margin-top:3px;font-size:10px">${urgency === 'critical' ? '⚠ Heavy context - consider compacting' : '● Moderate context usage'}</div>` : ''}
          </div>`;
      }

      if (infoHtml) {
        this.els.detailCostBreakdown.insertAdjacentHTML('afterend', infoHtml);
      }
    } catch (err) {
      // Cost tracking is best-effort - don't show errors
      this.els.detailCost.hidden = true;
    }
  }

  async loadSessionSubagents(sessionId) {
    if (!this.els.detailSubagents) return;
    try {
      const data = await this.api('GET', `/api/sessions/${sessionId}/subagents`);
      if (!data || !data.subagents || data.subagents.length === 0) {
        this.els.detailSubagents.hidden = true;
        return;
      }
      this.els.detailSubagents.hidden = false;
      this.els.detailSubagentCount.textContent = `${data.summary.running} running / ${data.summary.total} total`;

      // Cache for badge display in session list
      if (!this._subagentCache) this._subagentCache = {};
      this._subagentCache[sessionId] = { running: data.summary.running, ts: Date.now() };

      // Render subagent list (show last 10 max, most recent first)
      const agents = data.subagents.slice(-10).reverse();
      this.els.detailSubagentList.innerHTML = agents.map(a => {
        const dotClass = a.status === 'running' ? 'subagent-dot-running' : 'subagent-dot-completed';
        const desc = this.escapeHtml(a.description || 'Unnamed subagent');
        const type = this.escapeHtml(a.subagentType || 'unknown');
        return `<div class="subagent-item">
          <span class="subagent-dot ${dotClass}"></span>
          <span class="subagent-name" title="${desc}">${desc}</span>
          <span class="subagent-type">${type}</span>
        </div>`;
      }).join('');
    } catch (_) {
      // Subagent tracking is best-effort - hide section if API unavailable
      this.els.detailSubagents.hidden = true;
    }
  }

  /**
   * Load and display workspace-level analytics in the detail panel.
   * Only shown when a session belonging to a workspace is selected,
   * giving contextual workspace metrics alongside session details.
   */
  async loadWorkspaceAnalytics(workspaceId) {
    if (!this.els.detailAnalytics) return;
    try {
      const data = await this.api('GET', `/api/workspaces/${workspaceId}/analytics`);
      this.renderWorkspaceAnalytics(data);
      this.els.detailAnalytics.hidden = false;
    } catch (_) {
      this.els.detailAnalytics.hidden = true;
    }
  }

  /**
   * Render workspace analytics cards (session counts, cost, tokens,
   * last activity) and a top-sessions-by-cost list.
   */
  renderWorkspaceAnalytics(data) {
    if (!this.els.analyticsGrid) return;

    const formatCost = (c) => c < 0.01 ? '<$0.01' : '$' + c.toFixed(2);
    const formatTokens = (t) => {
      if (t >= 1000000) return (t / 1000000).toFixed(1) + 'M';
      if (t >= 1000) return (t / 1000).toFixed(0) + 'K';
      return t.toString();
    };
    const formatTime = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    };

    let gridHtml = `
      <div class="analytics-card">
        <div class="analytics-card-label">Sessions</div>
        <div class="analytics-card-value">${data.totalSessions}</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-label">Running</div>
        <div class="analytics-card-value" style="color:var(--green)">${data.runningSessions}</div>
      </div>`;

    if (data.costAvailable) {
      gridHtml += `
      <div class="analytics-card">
        <div class="analytics-card-label">Total Cost</div>
        <div class="analytics-card-value cost-value">${formatCost(data.totalCost)}</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-label">Tokens Used</div>
        <div class="analytics-card-value">${formatTokens(data.totalInputTokens + data.totalOutputTokens)}</div>
      </div>`;
    }

    gridHtml += `
      <div class="analytics-card">
        <div class="analytics-card-label">Last Active</div>
        <div class="analytics-card-value" style="font-size:14px">${formatTime(data.lastActivity)}</div>
      </div>`;

    this.els.analyticsGrid.innerHTML = gridHtml;

    // Top sessions by cost
    if (data.topSessions && data.topSessions.length > 0 && data.costAvailable) {
      let topHtml = '<div class="analytics-top-title">Top Sessions by Cost</div>';
      data.topSessions.forEach(s => {
        topHtml += `<div class="analytics-top-item">
          <span class="analytics-top-name">${this.escapeHtml(s.name)}</span>
          <span class="analytics-top-cost">${formatCost(s.cost)}</span>
        </div>`;
      });
      this.els.analyticsTopSessions.innerHTML = topHtml;
    } else {
      this.els.analyticsTopSessions.innerHTML = '';
    }
  }

  _getSubagentsCached(sessionId) {
    if (!this._subagentCache) this._subagentCache = {};
    const entry = this._subagentCache[sessionId];
    if (entry && (Date.now() - entry.ts < 300000)) return entry.running;
    return null;
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
     PROVIDER TABS (Phase 18-02)
     ─── Tab strip at the top of the sidebar that filters the
     ─── visible workspace and project list by provider. Pure
     ─── render-time filter; state.allSessions and state.projects
     ─── remain unfiltered so the filter is reversible.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Fetch the provider registry from the server and populate the sidebar
   * tab strip. Called once at app init (after auth succeeds) and again
   * whenever the Settings Providers section toggles a provider on/off.
   *
   * On error, logs a warning and renders an "All" only fallback so the UI
   * degrades gracefully when the server lags behind the client.
   * @returns {Promise<void>}
   */
  async loadProviders() {
    try {
      const data = await this.api('GET', '/api/providers');
      // GET /api/providers returns either a bare array or { providers: [...] }
      // depending on phase; defensive normalisation here keeps the tab strip
      // robust against shape drift.
      this.state.providers = Array.isArray(data) ? data : (data.providers || []);
    } catch (err) {
      console.warn('[provider-tabs] loadProviders failed', err);
      // Keep whatever providers we already had; never blank the strip on a
      // transient fetch error.
    }
    this.renderProviderTabs();
  }

  /**
   * Plan 19-02 (PTY-04, PTY-05): build the runtime per-provider spec map
   * that terminal.js consults at pane mount time.
   *
   * Merges server-side metadata (id, displayName, cliBinary, accentToken)
   * from GET /api/providers with the frontend-only runtime data
   * (idleRegexes, shiftEnter) defined in provider-specs.js. The result is
   * exposed as window.CWMProviderSpecs so the vanilla TerminalPane class
   * can read it without an import dance.
   *
   * Defensive fallbacks (in priority order):
   *   1. /api/providers reachable: build full map from server + locals.
   *   2. Server unreachable: synthesize a Claude-only map from locals so
   *      the existing Claude flow keeps working.
   *   3. Local specs missing entirely: leave CWMProviderSpecs undefined;
   *      terminal.js falls back to its baked-in Claude regex/keybindings.
   *
   * Called from _initializeApp BEFORE initTerminalGroups so restored panes
   * have specs available when they mount.
   *
   * @returns {Promise<void>}
   */
  async fetchProviderSpecs() {
    const locals = (typeof window !== 'undefined' && window.CWMProviderSpecLocals) || null;
    if (!locals) {
      // provider-specs.js failed to load; leave CWMProviderSpecs undefined
      // so terminal.js uses its defensive baked-in defaults. Log once for
      // visibility; do not block app init.
      console.warn('[provider-specs] CWMProviderSpecLocals missing; using terminal.js defaults');
      return;
    }
    try {
      const data = await this.api('GET', '/api/providers');
      const providers = Array.isArray(data) ? data : (data.providers || []);
      const specs = {};
      for (const p of providers) {
        if (!p || !p.id) continue;
        const local = locals[p.id] || {};
        specs[p.id] = {
          id: p.id,
          displayName: p.displayName,
          accentToken: p.accentToken,
          cliBinary: p.cliBinary,
          // Frontend runtime data carried over from provider-specs.js.
          // Missing locals -> spec has no idleRegexes/shiftEnter; the
          // helpers in terminal.js fall back to Claude-shaped defaults.
          idleRegexes: local.idleRegexes,
          shiftEnter: local.shiftEnter,
        };
      }
      window.CWMProviderSpecs = specs;
    } catch (err) {
      // /api/providers unreachable (server stale, auth race). Synthesize a
      // Claude-only map from the frontend locals so existing Claude flows
      // keep working. Codex panes restored from layout in this state will
      // gracefully default to Claude regex / shiftEnter, which is the same
      // behavior we had before Plan 19-02.
      console.warn('[provider-specs] /api/providers fetch failed; falling back to Claude-only locals', err);
      const claudeLocal = locals.claude || {};
      window.CWMProviderSpecs = {
        // gsd:provider-literal-allowed (Phase 19 fallback when server is unreachable)
        claude: {
          id: 'claude', // gsd:provider-literal-allowed
          displayName: 'Claude Code',
          cliBinary: 'claude', // gsd:provider-literal-allowed
          idleRegexes: claudeLocal.idleRegexes,
          shiftEnter: claudeLocal.shiftEnter,
        },
      };
    }
  }

  /**
   * Render the tab strip into #sidebar-provider-tabs. Always emits an "All"
   * tab as the first child; each enabled provider follows in registration
   * order. The active tab carries the .active class; click handlers route
   * through setActiveProviderTab so scroll preservation is centralised.
   * @returns {void}
   */
  renderProviderTabs() {
    const host = this.els.sidebarProviderTabs || document.getElementById('sidebar-provider-tabs');
    if (!host) return;
    const enabled = (this.state.providers || []).filter(p => p && p.enabled);
    const active = this.state.activeProviderTab || 'all';

    // Edge case: if active tab refers to a now-disabled provider, fall back
    // to 'all' so the user is never stranded on an empty filter.
    const enabledIds = new Set(enabled.map(p => p.id));
    const resolvedActive = (active === 'all' || enabledIds.has(active)) ? active : 'all';
    if (resolvedActive !== active) {
      this.state.activeProviderTab = 'all';
      try { localStorage.setItem('cwm_activeProviderTab', 'all'); } catch (_) {}
    }

    let html = `<button class="sidebar-tab${resolvedActive === 'all' ? ' active' : ''}" role="tab" data-provider="all" type="button">All<span class="sidebar-tab-badge">${this._countAllSessions()}</span></button>`;
    for (const p of enabled) {
      const isActive = resolvedActive === p.id;
      const count = this._countSessionsByProvider(p.id);
      html += `<button class="sidebar-tab${isActive ? ' active' : ''}" role="tab" data-provider="${this.escapeHtml(p.id)}" type="button">${this.escapeHtml(p.displayName || p.id)}<span class="sidebar-tab-badge">${count}</span></button>`;
    }
    host.innerHTML = html;

    // Bind once per render; innerHTML replacement discarded the old listeners.
    host.querySelectorAll('.sidebar-tab').forEach(btn => {
      btn.addEventListener('click', () => this.setActiveProviderTab(btn.dataset.provider));
    });
  }

  /**
   * Switch the active provider tab. Captures scroll position of the current
   * tab into _tabScrollPositions, mutates state, persists to localStorage,
   * re-renders the sidebar, and restores the new tab's scroll position via
   * requestAnimationFrame so the restore lands after layout settles.
   *
   * @param {string} id Provider id ('all' or any id from state.providers).
   * @returns {void}
   */
  setActiveProviderTab(id) {
    if (id == null) return;
    // Lazy-init the per-tab scroll position cache. Shape:
    //   { [tabId]: { ws: number, proj: number } }
    if (!this._tabScrollPositions) this._tabScrollPositions = {};
    const wsList = this.els.workspaceList;
    const projList = this.els.projectsList;
    const oldTab = this.state.activeProviderTab || 'all';

    // Capture BEFORE the state mutation so the right slot gets the old scroll.
    this._tabScrollPositions[oldTab] = {
      ws: wsList ? wsList.scrollTop : 0,
      proj: projList ? projList.scrollTop : 0,
    };

    this.state.activeProviderTab = id;
    try { localStorage.setItem('cwm_activeProviderTab', id); } catch (_) {}

    this.renderProviderTabs();
    if (typeof this.renderWorkspaces === 'function') this.renderWorkspaces();
    if (typeof this.renderProjects === 'function') this.renderProjects();

    // Restore scroll AFTER the new render's layout settles. innerHTML
    // assignment silently resets scrollTop to 0; rAF places the restore
    // on the frame the new DOM is painted.
    requestAnimationFrame(() => {
      const saved = this._tabScrollPositions[id];
      if (!saved) return;
      if (wsList && typeof saved.ws === 'number') wsList.scrollTop = saved.ws;
      if (projList && typeof saved.proj === 'number') projList.scrollTop = saved.proj;
    });
  }

  /**
   * Total session count across every provider. Reads state.allSessions
   * (the canonical full list) with state.sessions as fallback. Returns 0
   * when neither is populated yet (pre-load).
   * @returns {number}
   */
  _countAllSessions() {
    const all = this.state.allSessions || this.state.sessions || [];
    return Array.isArray(all) ? all.length : 0;
  }

  /**
   * Session count for a single provider id. Defaults sessions missing the
   * provider field to the v1.1 back-compat default (Claude) per the rule
   * documented in RESEARCH.md. The bare literal below carries the
   * allowlist marker because it is a back-compat default, not a UI
   * assumption.
   * @param {string} id Provider id.
   * @returns {number}
   */
  _countSessionsByProvider(id) {
    const all = this.state.allSessions || this.state.sessions || [];
    if (!Array.isArray(all)) return 0;
    let n = 0;
    for (const s of all) {
      const p = s && (s.provider || 'claude'); /* gsd:provider-literal-allowed */
      if (p === id) n++;
    }
    return n;
  }

  /**
   * Patch the .sidebar-tab-badge text on existing tab buttons in-place.
   * Mirrors _patchCostBadges (app.js:16742): SSE-driven updates must NOT
   * trigger a full renderProviderTabs (which would rebind click handlers
   * and lose focus/animations). Safe to call on every SSE session event.
   * @returns {void}
   */
  _patchProviderTabBadges() {
    const host = this.els.sidebarProviderTabs || document.getElementById('sidebar-provider-tabs');
    if (!host) return;
    const buttons = host.querySelectorAll('.sidebar-tab');
    buttons.forEach(btn => {
      const id = btn.dataset.provider;
      const badge = btn.querySelector('.sidebar-tab-badge');
      if (!badge) return;
      const count = id === 'all' ? this._countAllSessions() : this._countSessionsByProvider(id);
      const text = String(count);
      if (badge.textContent !== text) badge.textContent = text;
    });
  }

  /* ═══════════════════════════════════════════════════════════
     PHASE 18-03: SETTINGS PROVIDERS SECTION
     ─── One tile per provider in the Settings overlay, with
     ─── toggle, availability indicator, and install hint.
     ─── Toggling OFF with running PTYs surfaces a confirmation
     ─── modal; running PTYs are NEVER killed by a toggle.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Look up the provider id for a session. Defaults to the v1.1 back-compat
   * default for sessions missing the field.
   * @param {string} sessionId Session id to look up.
   * @returns {string} Provider id. gsd:provider-literal-allowed
   */
  _sessionProviderId(sessionId) {
    const all = this.state.allSessions || this.state.sessions || [];
    const sess = Array.isArray(all) ? all.find(s => s && s.id === sessionId) : null;
    return (sess && sess.provider) || 'claude'; /* gsd:provider-literal-allowed (Phase 18 helper default) */
  }

  /**
   * Return the install hint text for a provider id.
   * @param {string} providerId Provider id from state.providers.
   * @returns {string} Install hint string.
   */
  _installHintFor(providerId) {
    const hints = {
      claude: 'Install: npm install -g @anthropic-ai/claude-code', // gsd:provider-literal-allowed
      codex: 'Install: npm install -g @openai/codex', // gsd:provider-literal-allowed
    };
    return hints[providerId] || 'See provider documentation for installation instructions';
  }

  /**
   * Render the Settings -> Providers section HTML.
   * @param {string} filter Lowercased filter from the Settings search input.
   * @returns {Promise<string>} HTML string for the Providers category block.
   */
  async _renderProvidersSection(filter) {
    const lower = (filter || '').toLowerCase();
    if (lower) {
      const keywords = ['provider', 'providers', 'codex', 'claude', 'chatgpt', 'enable', 'enabled', 'cli']; // gsd:provider-literal-allowed
      if (!keywords.some(k => k.includes(lower) || lower.includes(k))) {
        return '';
      }
    }
    let providers = this.state.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
      try {
        await this.loadProviders();
        providers = this.state.providers || [];
      } catch (_) {
        providers = [];
      }
    }
    if (!providers || providers.length === 0) return '';

    let html = `<div class="settings-category" data-section="providers">`;
    html += `<div class="settings-category-label">Providers</div>`;
    for (const p of providers) {
      const id = p && p.id;
      if (!id) continue;
      const displayName = p.displayName || id;
      const enabled = !!p.enabled;
      const available = !!p.available;
      let statusText;
      if (enabled && available) statusText = 'Enabled &middot; CLI on PATH';
      else if (!enabled && available) statusText = 'Disabled &middot; CLI on PATH';
      else if (!enabled && !available) statusText = 'CLI not found in PATH';
      else statusText = 'Enabled but CLI not found in PATH';
      const installHint = available
        ? ''
        : `<div class="settings-providers-install-hint">${this.escapeHtml(this._installHintFor(id))}</div>`;
      html += `
        <div class="settings-providers-tile" data-provider="${this.escapeHtml(id)}">
          <div class="settings-providers-swatch" aria-hidden="true"></div>
          <div class="settings-providers-info">
            <div class="settings-providers-name">${this.escapeHtml(displayName)}</div>
            <div class="settings-providers-status" data-available="${available}">${statusText}</div>
            ${installHint}
          </div>
          <label class="settings-toggle" title="Toggle ${this.escapeHtml(displayName)}">
            <input type="checkbox" data-provider-toggle="${this.escapeHtml(id)}" ${enabled ? 'checked' : ''} />
            <span class="settings-toggle-track"></span>
            <span class="settings-toggle-thumb"></span>
          </label>
        </div>`;
    }
    html += `</div>`;
    return html;
  }

  /**
   * Handle a change event on a provider toggle checkbox.
   * @param {Event} event The change event from the toggle checkbox.
   * @returns {Promise<void>}
   */
  async _handleProviderToggleChange(event) {
    const target = event.target;
    if (!target || !target.dataset || !target.dataset.providerToggle) return;
    const id = target.dataset.providerToggle;
    const desired = !!target.checked;
    const provider = (this.state.providers || []).find(p => p && p.id === id);
    const displayName = (provider && provider.displayName) || id;
    const prior = provider ? !!provider.enabled : !desired;
    if (provider && provider.enabled === desired) return;
    const revert = () => { target.checked = prior; };
    if (!desired) {
      const running = (this.terminalPanes || []).filter(
        tp => tp && tp.sessionId && this._sessionProviderId(tp.sessionId) === id
      ).length;
      if (running > 0) {
        const plural = running !== 1 ? 's' : '';
        const confirmed = await this.showConfirmModal({
          title: `Disable ${displayName}?`,
          message: `${running} ${this.escapeHtml(displayName)} session${plural} ${running !== 1 ? 'are' : 'is'} running. They will continue but cannot be restarted while ${this.escapeHtml(displayName)} is disabled.`,
          confirmText: 'Disable',
          confirmClass: 'btn-danger',
        });
        if (!confirmed) { revert(); return; }
      }
    }
    try {
      const updated = await this.api('PUT', `/api/providers/${encodeURIComponent(id)}/enabled`, { enabled: desired });
      if (updated && typeof updated === 'object' && updated.id) {
        const idx = (this.state.providers || []).findIndex(p => p && p.id === updated.id);
        if (idx >= 0) this.state.providers[idx] = updated;
        else this.state.providers.push(updated);
      } else {
        await this.loadProviders();
      }
      if (typeof this.renderProviderTabs === 'function') this.renderProviderTabs();
      if (typeof this.renderWorkspaces === 'function') this.renderWorkspaces();
      if (typeof this.renderProjects === 'function') this.renderProjects();
      const filterVal = (this.els && this.els.settingsSearchInput) ? this.els.settingsSearchInput.value : '';
      this.renderSettingsBody(filterVal);
      this.showToast(`${displayName} ${desired ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      revert();
      this.showToast(`Failed to toggle ${displayName}: ${err && err.message ? err.message : 'unknown error'}`, 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     PROJECTS PANEL
     ═══════════════════════════════════════════════════════════ */

  /**
   * Load projects from server. Uses dual caching (browser + server) unless forceRefresh.
   * @param {boolean} [forceRefresh=false] - Bypass both browser and server caches
   */
  async loadProjects(forceRefresh = false) {
    try {
      // Try sessionStorage cache first (skip if force refreshing)
      if (!forceRefresh) {
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
      }

      // Phase 18-04: native v1.2 shape (Phase 15 back-compat shim retired).
      // /api/discover returns { projects: { claude: [...], codex: [...] } }.
      const url = forceRefresh ? '/api/discover?refresh=true' : '/api/discover';
      const data = await this.api('GET', url);
      const byProvider = (data && typeof data.projects === 'object' && !Array.isArray(data.projects))
        ? data.projects
        : {};
      this.state.projectsByProvider = byProvider;
      this.state.projects = this._mergeProjectsByProvider(byProvider);
      // Plan 22-01: hydrate ad-hoc provider-settings cache from the
      // discover response so the Codex bottom status strip can render
      // saved settings for upstream sessions that have no Myrlin store
      // record. Shape: { codex: { <uuid>: {...} }, ... }.
      this.state.adHocProviderSettings = (data && data.adHocProviderSettings && typeof data.adHocProviderSettings === 'object')
        ? data.adHocProviderSettings
        : {};
      sessionStorage.setItem('cwm_projects', JSON.stringify({ ts: Date.now(), data: this.state.projects }));
      this.renderProjects();
      // Refresh any open Codex strips with the newly hydrated cache.
      if (typeof this._renderCodexStatusStrip === 'function' && Array.isArray(this.terminalPanes)) {
        this.terminalPanes.forEach((tp, idx) => { if (tp) this._renderCodexStatusStrip(idx); });
      }
    } catch {
      // Non-critical - projects panel just stays empty
    }
  }

  /**
   * Flatten the per-provider /api/discover response object into a single
   * array sorted by lastActive (newest first). Tolerates the legacy array
   * shape and an empty/missing object. Used by every callsite that retired
   * the Phase 15 back-compat shim in Phase 18-04.
   *
   * @param {Object|Array} projectsByProvider Either the v1.2 object map of
   *   {providerId: ProjectObject[]} OR (defensively) the v1.1 flat array
   *   from a stale cache or unexpected server response.
   * @returns {Array} Flat merged array of project objects.
   */
  _mergeProjectsByProvider(projectsByProvider) {
    if (Array.isArray(projectsByProvider)) {
      return projectsByProvider.slice();
    }
    if (!projectsByProvider || typeof projectsByProvider !== 'object') return [];
    const merged = [];
    // Defense in depth: stamp each project with its provider id from the
    // outer object key if the server bucket did not carry one. The server
    // now sets bucket.provider in groupProviderSessionsForUI, but this loop
    // also handles older server responses and any future provider whose
    // route skips the helper.
    for (const [providerId, arr] of Object.entries(projectsByProvider)) {
      if (Array.isArray(arr)) {
        for (const p of arr) {
          merged.push(p && p.provider ? p : { ...p, provider: providerId });
        }
      }
    }
    merged.sort((a, b) => {
      const ta = (a && (a.lastActive || a.modified)) ? new Date(a.lastActive || a.modified).getTime() : 0;
      const tb = (b && (b.lastActive || b.modified)) ? new Date(b.lastActive || b.modified).getTime() : 0;
      return tb - ta;
    });
    return merged;
  }

  renderProjects() {
    const list = this.els.projectsList;
    if (!list) return;

    let projects = this.state.projects;
    if (projects.length === 0) {
      list.innerHTML = '<div style="padding: 12px; text-align: center; font-size: 12px; color: var(--overlay0);">No projects found</div>';
      return;
    }

    // Phase 18-02: render-time provider filter. Projects from pre-v1.2
    // servers lack p.provider; the v1.1 default is the Claude provider id
    // (a back-compat value, not a UI assumption), so the marker stays.
    const activeTab = this.state.activeProviderTab || 'all';
    if (activeTab !== 'all') {
      projects = projects.filter(p => (p && (p.provider || 'claude')) === activeTab); /* gsd:provider-literal-allowed */
    }

    // Filter out hidden projects (unless showHidden is on)
    projects = projects.filter(p => {
      const encoded = p.encodedName || '';
      return this.state.showHidden || !this.state.hiddenProjects.has(encoded);
    });

    // Apply search filter
    const query = this.state.projectSearchQuery;
    if (query) {
      projects = projects.filter(p => {
        const name = p.realPath ? (p.realPath.split('\\').pop() || p.encodedName) : p.encodedName;
        const encoded = p.encodedName || '';
        const path = p.realPath || '';
        // Match against project name, encoded name, or path
        if (name.toLowerCase().includes(query) || encoded.toLowerCase().includes(query) || path.toLowerCase().includes(query)) return true;
        // Match against any session ID, title, or Claude custom-title within this project
        const allSessions = p.sessions || [];
        return allSessions.some(s => (s.claudeSessionId || '').toLowerCase().includes(query) || (s.title || '').toLowerCase().includes(query));
      });
    }

    if (projects.length === 0) {
      list.innerHTML = '<div style="padding: 12px; text-align: center; font-size: 12px; color: var(--overlay0);">' +
        (query ? 'No matching projects' : 'All projects hidden') + '</div>';
      return;
    }

    list.innerHTML = projects.map(p => {
      const name = p.realPath ? (p.realPath.split('\\').pop() || p.encodedName) : p.encodedName;
      const encoded = p.encodedName || '';
      const isProjectHidden = this.state.hiddenProjects.has(encoded);
      const missingClass = !p.dirExists ? ' missing' : '';
      const hiddenClass = isProjectHidden ? ' project-hidden' : '';
      const sizeStr = p.totalSize ? this.formatSize(p.totalSize) : '';
      const allSessions = p.sessions || [];
      // Filter out hidden project sessions (unless showHidden is on)
      let sessions = allSessions.filter(s => this.state.showHidden || !this.state.hiddenProjectSessions.has(s.claudeSessionId));

      // When search is active, also filter individual sessions by query
      if (query) {
        const projectNameLower = name.toLowerCase();
        const encodedLower = encoded.toLowerCase();
        const pathLower = (p.realPath || '').toLowerCase();
        const projectMatches = projectNameLower.includes(query) || encodedLower.includes(query) || pathLower.includes(query);
        // If the project itself doesn't match, only show sessions that match
        if (!projectMatches) {
          sessions = sessions.filter(s => {
            const sName = (s.claudeSessionId || '').toLowerCase();
            const sClaudeTitle = (s.title || '').toLowerCase();
            const sTitle = (this.getProjectSessionTitle(s.claudeSessionId) || '').toLowerCase();
            return sName.includes(query) || sClaudeTitle.includes(query) || sTitle.includes(query);
          });
        }
      }

      // Phase 18 data-provider default for projects from pre-v1.2 servers lacking the field.
      const projProvider = this.escapeHtml(p.provider || 'claude'); /* gsd:provider-literal-allowed */

      // Build session sub-items
      const sessionItems = sessions.map(s => {
        const sessName = s.claudeSessionId || 'unnamed';
        const claudeTitle = s.title || null;
        if (claudeTitle && !this.getProjectSessionTitle(sessName)) {
          const titles = JSON.parse(localStorage.getItem('cwm_projectSessionTitles') || '{}');
          titles[sessName] = claudeTitle;
          localStorage.setItem('cwm_projectSessionTitles', JSON.stringify(titles));
        }
        const storedTitle = this.getProjectSessionTitle(sessName);
        const displayName = storedTitle || claudeTitle || (sessName.length > 24 ? sessName.substring(0, 24) + '...' : sessName);
        const sessSize = s.size ? this.formatSize(s.size) : '';
        const sessTime = s.modified ? this.relativeTime(s.modified) : '';
        const effectiveTitle = storedTitle || claudeTitle;
        const tooltip = effectiveTitle
          ? `${effectiveTitle}\n\nSession: ${sessName}`
          : sessName;
        return `<div class="project-session-item" draggable="true" data-session-name="${this.escapeHtml(sessName)}" data-project-path="${this.escapeHtml(p.realPath || '')}" data-project-encoded="${this.escapeHtml(encoded)}" data-provider="${projProvider}" title="${this.escapeHtml(tooltip)}">
          <span class="project-session-name">${this.escapeHtml(displayName)}</span>
          ${sessSize ? `<span class="project-session-size">${sessSize}</span>` : ''}
          ${sessTime ? `<span class="project-session-time">${sessTime}</span>` : ''}
        </div>`;
      }).join('');

      return `<div class="project-accordion${missingClass}${hiddenClass}" data-encoded="${this.escapeHtml(encoded)}" data-path="${this.escapeHtml(p.realPath || '')}" data-provider="${projProvider}">
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
     FIND A SESSION (AI-POWERED)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Open the AI-powered session finder overlay.
   * Uses Claude Haiku to semantically match a natural language description
   * against all known projects and sessions. Falls back to keyword matching
   * when no Anthropic API key is configured.
   */
  openFindConversation() {
    const overlay = document.getElementById('find-convo-overlay');
    const input = document.getElementById('find-convo-input');
    const results = document.getElementById('find-convo-results');
    const closeBtn = document.getElementById('find-convo-close');
    const searchBtn = document.getElementById('find-convo-search-btn');
    const modeIndicator = document.getElementById('find-convo-mode');

    if (!overlay || !input || !results) return;

    overlay.hidden = false;
    input.value = '';
    results.innerHTML = '<div class="find-convo-empty">Describe the session or project you\'re looking for</div>';
    setTimeout(() => input.focus(), 50);

    // Check if AI mode is available (API key configured)
    this.api('GET', '/api/keys/anthropic')
      .then(data => {
        if (modeIndicator) {
          if (data.configured) {
            modeIndicator.innerHTML = '<span class="find-convo-mode-ai">&#10024; AI search</span>';
          } else {
            modeIndicator.innerHTML = '<span class="find-convo-mode-keyword">Keyword search <a href="#" class="find-convo-setup-link">(add API key for AI)</a></span>';
          }
          // Wire up the "add API key" link to open settings
          const setupLink = modeIndicator.querySelector('.find-convo-setup-link');
          if (setupLink) {
            setupLink.addEventListener('click', (e) => {
              e.preventDefault();
              this.closeFindConversation();
              this.openSettings();
            });
          }
        }
      })
      .catch(() => {});

    /** Execute the AI find search */
    const doSearch = () => {
      const query = input.value.trim();
      if (query.length < 3) {
        results.innerHTML = '<div class="find-convo-empty">Enter at least 3 characters to search</div>';
        return;
      }

      // Show skeleton loading cards
      results.innerHTML = Array.from({ length: 3 }, () => `
        <div class="ai-find-card ai-find-card-skeleton">
          <div class="ai-find-card-header">
            <span class="skeleton-line" style="width: 60%"></span>
            <span class="skeleton-line" style="width: 30px"></span>
          </div>
          <div class="ai-find-card-summary">
            <span class="skeleton-line" style="width: 90%"></span>
            <span class="skeleton-line" style="width: 70%"></span>
          </div>
          <div class="ai-find-card-meta">
            <span class="skeleton-line" style="width: 50%"></span>
          </div>
        </div>
      `).join('');

      if (searchBtn) {
        searchBtn.disabled = true;
        searchBtn.textContent = 'Searching...';
      }

      this.api('POST', '/api/ai/find-session', { query })
        .then(data => {
          const items = data.results || [];

          if (items.length === 0) {
            results.innerHTML = '<div class="find-convo-empty">No matching sessions or projects found</div>';
            return;
          }

          // Show fallback hint when AI is not configured
          const fallbackHint = data.fallback
            ? '<div class="find-convo-fallback-hint">Showing keyword matches. Add an Anthropic API key in Settings for smarter AI-powered search.</div>'
            : '';

          results.innerHTML = fallbackHint + items.map(r => {
            const confidence = Math.round((r.confidence || 0) * 100);
            const lastActive = r.lastActive ? this.relativeTime(r.lastActive) : 'unknown';
            const statusBadge = r.status === 'running'
              ? '<span class="ai-find-card-status ai-find-card-status-running">running</span>'
              : '';
            const sessionCount = r.sessionCount != null ? `${r.sessionCount} sessions` : '';
            const typeBadge = r.type === 'workspace' ? 'project' : r.type === 'project' ? 'discovered' : 'session';

            return `
              <div class="ai-find-card" data-type="${this.escapeHtml(r.type)}" data-id="${this.escapeHtml(r.id)}" data-path="${this.escapeHtml(r.path || '')}" data-workspace-id="${this.escapeHtml(r.workspaceId || '')}">
                <div class="ai-find-card-header">
                  <span class="ai-find-card-name">${this.escapeHtml(r.name || r.id)}</span>
                  <span class="ai-find-card-badge">${typeBadge}</span>
                  <span class="ai-find-card-confidence">${confidence}%</span>
                </div>
                <div class="ai-find-card-summary">${this.escapeHtml(r.summary || '')}</div>
                <div class="ai-find-card-meta">
                  ${r.path ? `<span class="ai-find-card-path">${this.escapeHtml(r.path)}</span>` : ''}
                  <span class="ai-find-card-time">${lastActive}</span>
                  ${sessionCount ? `<span class="ai-find-card-sessions">${sessionCount}</span>` : ''}
                  ${statusBadge}
                </div>
                <button class="ai-find-card-open" title="Open in terminal pane">Open &#8594;</button>
              </div>
            `;
          }).join('');

          // Bind click handlers on cards (open button only, not the whole card)
          results.querySelectorAll('.ai-find-card-open').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const card = btn.closest('.ai-find-card');
              if (!card) return;
              this._openFindResult(card);
            });
          });

          // Also allow clicking the whole card
          results.querySelectorAll('.ai-find-card').forEach(card => {
            card.addEventListener('click', () => this._openFindResult(card));
          });
        })
        .catch(err => {
          results.innerHTML = `<div class="find-convo-empty" style="color: var(--red);">Search failed: ${this.escapeHtml(err.message || 'Unknown error')}</div>`;
        })
        .finally(() => {
          if (searchBtn) {
            searchBtn.disabled = false;
            searchBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>`;
          }
        });
    };

    // Remove old listeners
    if (this._findConvoKeyHandler) {
      input.removeEventListener('keydown', this._findConvoKeyHandler);
    }
    this._findConvoKeyHandler = (e) => {
      if (e.key === 'Enter') doSearch();
      else if (e.key === 'Escape') this.closeFindConversation();
    };
    input.addEventListener('keydown', this._findConvoKeyHandler);

    // Search button click
    if (this._findConvoSearchHandler && searchBtn) {
      searchBtn.removeEventListener('click', this._findConvoSearchHandler);
    }
    this._findConvoSearchHandler = doSearch;
    if (searchBtn) searchBtn.addEventListener('click', this._findConvoSearchHandler);

    // Close handlers
    if (this._findConvoCloseHandler) {
      if (closeBtn) closeBtn.removeEventListener('click', this._findConvoCloseHandler);
      overlay.removeEventListener('click', this._findConvoCloseHandler);
    }
    this._findConvoCloseHandler = (e) => {
      if (e.target === overlay || e.target === closeBtn || e.target.closest('#find-convo-close')) {
        this.closeFindConversation();
      }
    };
    if (closeBtn) closeBtn.addEventListener('click', this._findConvoCloseHandler);
    overlay.addEventListener('click', this._findConvoCloseHandler);
  }

  /**
   * Open a find result in a terminal pane.
   * Does NOT close the overlay so the user can open multiple results.
   */
  _openFindResult(card) {
    const type = card.dataset.type;
    const id = card.dataset.id;
    const cardPath = card.dataset.path;
    const wsId = card.dataset.workspaceId;

    // Mark this card as opened
    card.classList.add('ai-find-card-opened');

    const emptySlot = this.terminalPanes.findIndex(p => p === null);
    if (emptySlot === -1) {
      this.showToast('All terminal panes full. Close one first.', 'warning');
      return;
    }

    this.setViewMode('terminal');

    if (type === 'session') {
      // Resume existing session.
      // Plan 19-02: AI find-session cards currently only surface Claude
      // sessions (multi-provider find is deferred to v1.3). Resolve cliBinary
      // through the helper anyway so the back-compat default lives in one
      // place and a future find-session payload that includes a provider id
      // lights up without further frontend edits.
      this.openTerminalInPane(emptySlot, id, id, {
        cwd: cardPath,
        resumeSessionId: id,
        command: this.getProviderCliBinary(null),
      });
      this.showToast('Opening session in terminal', 'info');
    } else {
      // Workspace or discovered project: open a new session in the project directory.
      // Plan 19-02: same v1.1 back-compat default routed through the helper.
      const name = card.querySelector('.ai-find-card-name')?.textContent || 'new-session';
      this.openTerminalInPane(emptySlot, null, name, {
        cwd: cardPath,
        command: this.getProviderCliBinary(null),
      });
      this.showToast(`Opening ${name} in terminal`, 'info');
    }
  }

  /** Close the find conversation overlay and clean up listeners. */
  closeFindConversation() {
    const overlay = document.getElementById('find-convo-overlay');
    if (overlay) overlay.hidden = true;
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
          const isTerminalSwap = hasType(e.dataTransfer.types, 'cwm/terminal-swap');
          if (isSession || isProject || isProjectSession || isWorkspace || isTerminalSwap) {
            e.preventDefault();
            e.dataTransfer.dropEffect = (isProject || isProjectSession) ? 'copy' : 'move';
            pane.classList.add('drag-over');
          }
          // Image file drag (check AFTER cwm/* types to avoid conflicts)
          else if (e.dataTransfer.types.includes('Files') && this.terminalPanes[slotIdx]) {
            const items = [...(e.dataTransfer.items || [])];
            const hasImage = items.some(item => item.kind === 'file' && item.type.startsWith('image/'));
            if (hasImage) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              pane.classList.add('image-drag-over');
            }
          }
        });
        pane.addEventListener('dragleave', () => {
          pane.classList.remove('drag-over');
          pane.classList.remove('image-drag-over');
        });
        pane.addEventListener('drop', async (e) => {
          e.preventDefault();
          pane.classList.remove('drag-over');
          console.log('[DnD] Drop on pane', slotIdx, 'types:', Array.from(e.dataTransfer.types));

          // Terminal pane swap/reposition - drag a pane header onto another pane.
          // Use truthy check: native DataTransfer.getData returns '' for missing
          // keys, but the touch polyfill returns undefined — both must skip.
          const swapSource = e.dataTransfer.getData('cwm/terminal-swap');
          if (swapSource) {
            const srcSlot = parseInt(swapSource, 10);
            if (srcSlot !== slotIdx) {
              this.swapTerminalPanes(srcSlot, slotIdx);
            }
            return;
          }

          // Drop an app session into terminal pane
          const sessionId = e.dataTransfer.getData('cwm/session');
          if (sessionId) {
            console.log('[DnD] Session drop:', sessionId);
            const session = this.state.sessions.find(s => s.id === sessionId)
              || (this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId));
            if (session && !session.resumeSessionId) {
              this.showToast('Starting new Claude session (no previous conversation to resume)', 'info');
            }
            // Build spawnOpts from session flags so bypass/model/verbose carry through
            const spawnOpts = {};
            if (session) {
              if (session.resumeSessionId) spawnOpts.resumeSessionId = session.resumeSessionId;
              if (session.workingDir) spawnOpts.cwd = session.workingDir;
              if (session.command) spawnOpts.command = session.command;
              if (session.bypassPermissions) spawnOpts.bypassPermissions = true;
              if (session.verbose) spawnOpts.verbose = true;
              if (session.model) spawnOpts.model = session.model;
              if (session.agentTeams) spawnOpts.agentTeams = true;
            }
            this.openTerminalInPane(slotIdx, sessionId, session ? session.name : 'Terminal', spawnOpts);
            return;
          }

          // Drop a project-session (individual .jsonl from project accordion) into terminal pane
          // Opens directly in terminal WITHOUT adding to any workspace
          const projSessJson = e.dataTransfer.getData('cwm/project-session');
          if (projSessJson) {
            try {
              const ps = JSON.parse(projSessJson);
              const claudeSessionId = ps.sessionName; // This IS the Claude session UUID
              const displayName = ps.displayName || this.getProjectSessionTitle(claudeSessionId) || claudeSessionId;
              // Phase 18-04 (UI-10): forward provider from drag payload so
              // the new pane carries the correct identity.
              const psProvider = ps.provider || 'claude'; // gsd:provider-literal-allowed (Phase 18 drag-drop default; v1.1-shaped data lacks provider)
              console.log('[DnD] Project-session drop - resumeSessionId:', claudeSessionId, 'cwd:', ps.projectPath, 'provider:', psProvider);
              // Open terminal directly - use the Claude session UUID as the PTY session ID
              // so the PTY manager can reuse it on subsequent drops
              // Plan 19-02: resolve cliBinary from the dragged session's
              // provider so a dropped Codex session spawns `codex resume`
              // instead of `claude --resume`. Phase 18-04 already plumbed
              // psProvider through; this commit closes the loop on `command`.
              this.openTerminalInPane(slotIdx, claudeSessionId, displayName, {
                cwd: ps.projectPath,
                resumeSessionId: claudeSessionId,
                command: this.getProviderCliBinary(psProvider),
                provider: psProvider,
              });
              this.showToast('Opening session - drag to a project to save it', 'info');
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
              // Phase 18-04 (UI-10): forward provider from drag payload.
              const projProvider = project.provider || 'claude'; // gsd:provider-literal-allowed (Phase 18 drag-drop default; v1.1-shaped data lacks provider)
              // Plan 19-02: resolve cliBinary from the dragged project's
              // provider so a Codex-tagged project drop spawns `codex`.
              this.openTerminalInPane(slotIdx, tempId, project.name, {
                cwd: project.path,
                command: this.getProviderCliBinary(projProvider),
                provider: projProvider,
              });
              this.showToast('Opening project - drag to a project to save it', 'info');
            } catch (err) {
              this.showToast(err.message || 'Failed to open project', 'error');
            }
            return;
          }

          // Image file drop - upload and send to Claude
          if (e.dataTransfer.files.length > 0 && this.terminalPanes[slotIdx]) {
            pane.classList.remove('image-drag-over');
            const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
            if (file) {
              this.handleImageUpload(file, slotIdx);
              return;
            }
          }

          // Drop a workspace into terminal pane - start a new Claude session
          const workspaceId = e.dataTransfer.getData('cwm/workspace');
          if (workspaceId) {
            console.log('[DnD] Workspace drop:', workspaceId);
            try {
              const ws = this.state.workspaces.find(w => w.id === workspaceId);
              const wsName = ws ? ws.name : 'Project';
              // Plan 19-02: workspace drops do not yet carry a provider tag
              // on the workspace itself (workspaces are provider-agnostic
              // containers); use the back-compat default through the helper
              // so the literal lives in one place.
              const data = await this.api('POST', '/api/sessions', {
                name: `${wsName} terminal`,
                workspaceId: workspaceId,
                topic: '',
                command: this.getProviderCliBinary(null),
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

        // Expand button: normal → stage1 (fills grid), stage1 → stage2 (fills viewport)
        const expandBtn = pane.querySelector('.terminal-pane-expand');
        if (expandBtn) {
          expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._cycleExpandPane(slotIdx);
          });
        }

        // Collapse button: always collapses back to normal from any expanded state
        const collapseBtn = pane.querySelector('.terminal-pane-collapse');
        if (collapseBtn) {
          collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._collapseExpandPane(slotIdx);
            const tp = this.terminalPanes[slotIdx];
            if (tp) requestAnimationFrame(() => tp.safeFit());
          });
        }

        // Mic (voice input) button - only show if SpeechRecognition API is available
        const micBtn = pane.querySelector('.terminal-pane-mic');
        if (micBtn && this._speechRecognitionAvailable) {
          micBtn.hidden = false;
          micBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleVoiceInput(slotIdx);
          });
        }

        // Upload image button
        const uploadBtn = pane.querySelector('.terminal-pane-upload');
        if (uploadBtn) {
          uploadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tp = this.terminalPanes[slotIdx];
            if (!tp) return;
            this._uploadTargetSlot = slotIdx;
            if (this.els.imageUploadInput) this.els.imageUploadInput.click();
          });
        }

        // Pinned notes (bookmark) button — shows modal of all pinned notes for this pane's session
        const pinDocBtn = pane.querySelector('.terminal-pane-pinnedoc');
        if (pinDocBtn) {
          pinDocBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showPinnedNotesModal(slotIdx);
          });
        }

        // Schedule clock button — opens the schedule popover for this pane's session
        const scheduleBtn = pane.querySelector('.terminal-pane-schedule');
        if (scheduleBtn) {
          scheduleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tp = this.terminalPanes[slotIdx];
            if (!tp || !tp.sessionId) return;
            if (window.SchedulePopover) window.SchedulePopover.toggle(scheduleBtn, tp.sessionId);
          });
        }

        // Pane view back button — restores terminal after a non-terminal view (E003)
        const backBtn = pane.querySelector('.pane-view-back');
        if (backBtn) {
          backBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.restoreTerminalInPane) this.restoreTerminalInPane(slotIdx);
          });
        }

        // Drag-to-reposition: make pane header draggable to swap panes
        const header = pane.querySelector('.terminal-pane-header');
        if (header) {
          header.setAttribute('draggable', 'true');
          header.addEventListener('dragstart', (e) => {
            const tp = this.terminalPanes[slotIdx];
            if (!tp) { e.preventDefault(); return; } // empty pane - not draggable
            e.dataTransfer.setData('cwm/terminal-swap', String(slotIdx));
            e.dataTransfer.effectAllowed = 'move';
            pane.classList.add('terminal-pane-dragging');
          });
          header.addEventListener('dragend', () => {
            pane.classList.remove('terminal-pane-dragging');
            // Clean up any lingering drag-over styles
            document.querySelectorAll('.terminal-pane').forEach(p => p.classList.remove('drag-over'));
          });
        }

        // Click-to-focus: clicking/tapping anywhere in a pane focuses its terminal
        const focusPane = () => {
          if (this.terminalPanes[slotIdx]) {
            this.setActiveTerminalPane(slotIdx);
          }
        };
        pane.addEventListener('mousedown', focusPane, true); // capture phase
        pane.addEventListener('touchstart', focusPane, { passive: true, capture: true });

        // focusin: when any child element (like xterm's textarea) gains focus,
        // switch the active pane. This catches focus from click, tab, or programmatic focus.
        pane.addEventListener('focusin', () => {
          if (this._activeTerminalSlot !== slotIdx && this.terminalPanes[slotIdx]) {
            this.setActiveTerminalPane(slotIdx);
          }
        });

        // Right-click context menu on terminal pane
        pane.addEventListener('contextmenu', (e) => {
          const tp = this.terminalPanes[slotIdx];
          if (!tp) { e.preventDefault(); e.stopPropagation(); this._showEmptyPaneContextMenu(slotIdx, e.clientX, e.clientY); return; }
          e.preventDefault();
          e.stopPropagation();
          this.showTerminalContextMenu(slotIdx, e.clientX, e.clientY);
        });

        // Long-press for mobile terminal context menu
        let termLongPress = null;
        pane.addEventListener('touchstart', (e) => {
          termLongPress = setTimeout(() => {
            const tp = this.terminalPanes[slotIdx];
            if (!tp) return;
            const touch = e.touches[0];
            this.showTerminalContextMenu(slotIdx, touch.clientX, touch.clientY);
          }, 600);
        }, { passive: true });
        pane.addEventListener('touchend', () => clearTimeout(termLongPress));
        pane.addEventListener('touchmove', () => clearTimeout(termLongPress));

      // Double-click on pane title for inline rename
      const paneTitleEl = pane.querySelector('.terminal-pane-title');
      if (paneTitleEl) {
        paneTitleEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const tp = this.terminalPanes[slotIdx];
          if (!tp) return; // Empty pane - no rename

          const sessionId = tp.sessionId;
          const allSessions = [
            ...(this.state.sessions || []),
            ...(this.state.allSessions || []),
          ];
          const storeSession = allSessions.find(s => s.id === sessionId);
          this.startTerminalPaneRename(paneTitleEl, slotIdx, sessionId, !!storeSession);
        });
      }
      });
    }
  }


  /* ═══════════════════════════════════════════════════════════
     TERMINAL GRID VIEW
     ═══════════════════════════════════════════════════════════ */

  /**
   * Show a disconnected placeholder in a terminal pane slot.
   * Preserves session info in terminalPanes[] for layout saves.
   * Click reconnects via openTerminalInPane().
   */
  // _showDisconnectedPlaceholder removed in v0.9.23 - caused more issues than it solved
  // (wrong pane on reconnect, unclosable panes, broken layout). Panes now connect
  // directly on restore and close cleanly on fatal error.

  openTerminalInPane(slotIdx, sessionId, sessionName, spawnOpts) {
    // Check localStorage for a previously saved name for this session
    const savedTitle = this.getProjectSessionTitle(sessionId);
    if (savedTitle && (!sessionName || sessionName === sessionId)) {
      sessionName = savedTitle;
    }
    console.log('[DnD] openTerminalInPane slot:', slotIdx, 'session:', sessionId, 'name:', sessionName);
    // If the target slot already has an active terminal, find the next empty slot
    if (this.terminalPanes[slotIdx]) {
      const emptySlot = this.terminalPanes.findIndex(p => p === null);
      if (emptySlot !== -1) {
        slotIdx = emptySlot;
      } else {
        // All slots full, replace the target slot
        this.terminalPanes[slotIdx].dispose();
        this.terminalPanes[slotIdx] = null;
      }
    }

    const containerId = `term-container-${slotIdx}`;
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;

    // Ensure pane is visible before mounting terminal
    paneEl.hidden = false;

    // Tag the pane with its provider so CSS selectors (terminal-pane[data-provider="..."])
    // can render the per-provider accent. Resolution order (Plan 19-01 PTY-07):
    //   1. spawnOpts.provider (explicit caller signal; layout restore + drag-drop)
    //   2. allSessions / live sessions lookup (best-effort by id)
    //   3. default (v1.1 back-compat for sessions lacking the field)
    // The explicit caller signal wins so a restored Codex pane stays tagged
    // even when discovery is empty at restore time (e.g., Codex toggled off
    // between save and restore). Without this, the layout would drift back
    // to the default tag and the next attach would visually mis-render.
    const _sessForProvider = (this.state.allSessions || [])
      .concat(Object.values(this.state.sessions || {}))
      .find(_s => _s && _s.id === sessionId);
    const _explicitProvider = spawnOpts && spawnOpts.provider;
    paneEl.dataset.provider = _explicitProvider
      || (_sessForProvider && _sessForProvider.provider)
      || 'claude'; /* gsd:provider-literal-allowed (Phase 18 default) */

    // Update pane state
    paneEl.classList.remove('terminal-pane-empty');
    const titleEl = paneEl.querySelector('.terminal-pane-title');
    if (titleEl) titleEl.textContent = sessionName || sessionId;
    // Plan 22-02: light up the provider pill in the pane header so the
    // provider is identifiable at a glance. Pill text mirrors the
    // registered provider's displayName when available; otherwise the
    // raw provider id is shown title-cased. Dot color is driven by CSS
    // selector on data-provider, no inline color needed.
    const pillEl = paneEl.querySelector('.pane-provider-pill');
    if (pillEl) {
      const pid = paneEl.dataset.provider;
      pillEl.dataset.provider = pid;
      const reg = this._getProviderById ? this._getProviderById(pid) : null;
      const labelFromRegistry = reg && reg.displayName;
      pillEl.textContent = labelFromRegistry || (pid ? pid.charAt(0).toUpperCase() + pid.slice(1) : '');
      pillEl.hidden = !pid;
    }
    // Plan 22-01: render the Codex bottom status strip on Codex panes.
    // No-op on Claude panes. Idempotent — re-render on subsequent attach.
    if (typeof this._renderCodexStatusStrip === 'function') {
      this._renderCodexStatusStrip(slotIdx);
    }
    const closeBtn = paneEl.querySelector('.terminal-pane-close');
    if (closeBtn) closeBtn.hidden = false;
    const uploadBtn2 = paneEl.querySelector('.terminal-pane-upload');
    if (uploadBtn2) uploadBtn2.hidden = false;
    const scheduleBtn2 = paneEl.querySelector('.terminal-pane-schedule');
    if (scheduleBtn2) {
      scheduleBtn2.hidden = false;
      // The 10 s schedule poller drives the badge; kick off an immediate
      // refresh so a freshly-attached pane reflects current state right away.
      if (this.refreshScheduleIndicators) this.refreshScheduleIndicators();
    }
    // Show mic button if SpeechRecognition is supported
    const micBtn2 = paneEl.querySelector('.terminal-pane-mic');
    if (micBtn2 && this._speechRecognitionAvailable) micBtn2.hidden = false;
    const expandBtn2 = paneEl.querySelector('.terminal-pane-expand');
    if (expandBtn2) expandBtn2.hidden = false;

    // Create and mount TerminalPane
    const tp = new TerminalPane(containerId, sessionId, sessionName, spawnOpts);
    this.terminalPanes[slotIdx] = tp;

    // Wire up mobile mode change callback to sync keyboard toggle button
    tp.onMobileModeChange = (mode) => {
      document.querySelectorAll('.toolbar-keyboard').forEach(kb => {
        kb.classList.toggle('toolbar-active', mode === 'type');
        kb.textContent = mode === 'type' ? '\u2328 Typing' : '\u2328 Type';
      });
    };

    // On fatal connection error, close the pane cleanly.
    tp.onFatalError = (failedSessionId) => {
      const idx = this.terminalPanes.indexOf(tp);
      if (idx === -1) return;
      tp.dispose();
      this.terminalPanes[idx] = null;
      const deadPane = document.getElementById(`term-pane-${idx}`);
      if (deadPane) {
        // Close the schedule popover if it was anchored to this pane.
        if (window.SchedulePopover && window.SchedulePopover.anchor && deadPane.contains(window.SchedulePopover.anchor)) {
          window.SchedulePopover.close();
        }
        deadPane.classList.add('terminal-pane-empty');
        deadPane.removeAttribute('data-provider');
        const header = deadPane.querySelector('.terminal-pane-title');
        if (header) header.textContent = 'Drop a session here';
        const closeBtn2 = deadPane.querySelector('.terminal-pane-close');
        if (closeBtn2) closeBtn2.hidden = true;
        const scheduleBtn3 = deadPane.querySelector('.terminal-pane-schedule');
        if (scheduleBtn3) scheduleBtn3.hidden = true;
        // Plan 22-02: hide the provider pill when the pane goes empty.
        const pillElDead = deadPane.querySelector('.pane-provider-pill');
        if (pillElDead) { pillElDead.hidden = true; pillElDead.textContent = ''; pillElDead.removeAttribute('data-provider'); }
      }
      this.updateTerminalGridLayout();
    };

    // Enable auto-trust if the setting is on
    tp._autoTrustEnabled = !!this.state.settings.autoTrustDialogs;

    // Apply grid layout FIRST so container dimensions are established,
    // then mount the terminal so fitAddon.fit() gets real dimensions.
    this.updateTerminalGridLayout();

    // Use rAF to let the browser paint the grid before mounting terminal
    requestAnimationFrame(() => {
      tp.mount();
      this.setActiveTerminalPane(slotIdx);
    });

    // Clear activity indicator for the new pane
    const activityEl = document.getElementById(`term-activity-${slotIdx}`);
    if (activityEl) activityEl.innerHTML = '';

    // Update mobile terminal tab strip
    if (this.isMobile) {
      this.updateTerminalTabs();
      this.switchTerminalTab(slotIdx);
    }

    // Refresh pinned-notes badge for this pane now that a session is loaded
    this._refreshPanePin(slotIdx);

    // Route through the centralised chokepoint so the sidebar indicator and
    // server-persisted layout reflect the new pane.
    this.saveTerminalLayout();
  }

  /**
   * Replace the terminal in a pane with a structured view (tasks, doc, etc.).
   * The terminal is hidden but not disposed; restoreTerminalInPane() brings it back.
   * @param {number} slotIdx - The pane slot index
   * @param {string} viewType - One of: 'tasks-git', 'tasks-td', 'tasks-worktree', 'tasks-files', 'doc'
   * @param {Object} [viewData={}] - Optional view-specific data (e.g. { docId } for doc views)
   */
  async openViewInPane(slotIdx, viewType, viewData = {}) {
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;
    const termContainer = document.getElementById(`term-container-${slotIdx}`);
    const viewContainer = document.getElementById(`pane-view-${slotIdx}`);
    if (!termContainer || !viewContainer) return;

    termContainer.hidden = true;
    viewContainer.hidden = false;
    viewContainer.replaceChildren();

    const labels = {
      'tasks-git': 'Git',
      'tasks-td': 'Tasks',
      'tasks-worktree': 'Worktree',
      'tasks-files': 'Files',
      'doc': 'Doc'
    };
    const badge = paneEl.querySelector('.pane-view-badge');
    const backBtn = paneEl.querySelector('.pane-view-back');
    if (badge) { badge.textContent = labels[viewType] || viewType; badge.hidden = false; }
    if (backBtn) backBtn.hidden = false;

    paneEl.dataset.viewType = viewType;
    paneEl.dataset.viewData = JSON.stringify(viewData);

    await this._renderPaneView(slotIdx, viewType, viewData, viewContainer);
    this.saveTerminalLayout();
  }

  /**
   * Restore a pane from a structured view back to its terminal.
   * Clears the view container, stops any refresh timers, and refits the terminal.
   * @param {number} slotIdx - The pane slot index
   */
  restoreTerminalInPane(slotIdx) {
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;
    const termContainer = document.getElementById(`term-container-${slotIdx}`);
    const viewContainer = document.getElementById(`pane-view-${slotIdx}`);

    if (viewContainer) { viewContainer.hidden = true; viewContainer.replaceChildren(); }
    if (termContainer) termContainer.hidden = false;

    const badge = paneEl.querySelector('.pane-view-badge');
    const backBtn = paneEl.querySelector('.pane-view-back');
    if (badge) badge.hidden = true;
    if (backBtn) backBtn.hidden = true;

    delete paneEl.dataset.viewType;
    delete paneEl.dataset.viewData;

    if (this._paneRefreshTimers[slotIdx]) {
      clearInterval(this._paneRefreshTimers[slotIdx]);
      delete this._paneRefreshTimers[slotIdx];
    }

    const tp = this.terminalPanes[slotIdx];
    if (tp && tp.safeFit) tp.safeFit();
    this.saveTerminalLayout();
  }

  /**
   * Render the appropriate view into the pane view container.
   * Clears any existing refresh timer for this slot before rendering.
   * Git panels auto-refresh every 10 seconds.
   * @param {number} slotIdx - The pane slot index (used for refresh timer key)
   * @param {string} viewType - The view type identifier
   * @param {Object} viewData - View-specific data
   * @param {HTMLElement} container - The container element to render into
   */
  async _renderPaneView(slotIdx, viewType, viewData, container) {
    if (this._paneRefreshTimers[slotIdx]) {
      clearInterval(this._paneRefreshTimers[slotIdx]);
      delete this._paneRefreshTimers[slotIdx];
    }
    switch (viewType) {
      case 'tasks-git':
        await this.renderTasksGitPanel(container);
        this._paneRefreshTimers[slotIdx] = setInterval(() => this.renderTasksGitPanel(container), 10000);
        break;
      case 'tasks-td':
        await this.renderTasksTdPanel(container);
        break;
      case 'tasks-worktree':
        await this.renderTasksView(container);
        break;
      case 'tasks-files':
        await this.renderTasksFilesPanel(container);
        break;
      case 'doc':
        await this._renderDocInPane(container, viewData);
        break;
    }
  }

  /**
   * Render a workspace docs textarea into the given pane container.
   * Saves content on blur via the workspace docs API.
   * @param {HTMLElement} container - The container element to render into
   * @param {Object} viewData - Optional view data (currently unused for doc type)
   */
  async _renderDocInPane(container, viewData) {
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    const docs = await this.api('GET', `/api/workspaces/${ws.id}/docs`);
    const textarea = document.createElement('textarea');
    textarea.style.cssText = 'width:100%;height:100%;resize:none;background:var(--base);color:var(--text);border:none;padding:12px;font-family:var(--mono);flex:1;min-height:0;';
    textarea.value = docs.raw || '';
    textarea.addEventListener('blur', async () => {
      await this.api('POST', `/api/workspaces/${ws.id}/docs`, { content: textarea.value });
    });
    container.appendChild(textarea);
  }

  /**
   * Update the activity indicator on a terminal pane header.
   * Called when 'terminal-activity' events fire from TerminalPane.
   */
  updatePaneActivity(slotIdx, activity) {
    const el = document.getElementById(`term-activity-${slotIdx}`);
    if (!el) return;

    if (!activity) {
      if (el.dataset.activityKey) {
        el.dataset.activityKey = '';
        el.innerHTML = '';
      }
      return;
    }

    const labels = {
      thinking: 'Thinking',
      reading: 'Reading',
      writing: 'Writing',
      running: 'Running',
      searching: 'Searching',
      delegating: 'Delegating',
      idle: 'Idle',
    };

    const label = labels[activity.type] || activity.type;
    const detail = activity.detail ? ': ' + this.escapeHtml(activity.detail) : '';
    const dotClass = 'activity-dot-' + activity.type;

    // Deduplicate - skip innerHTML write if content hasn't changed
    const key = activity.type + '|' + (activity.detail || '');
    if (el.dataset.activityKey === key) return;
    el.dataset.activityKey = key;

    el.innerHTML = `<span class="activity-dot ${dotClass}"></span>${label}${detail}`;
  }

  /**
   * Show a modal listing all pinned notes for the session currently open in the given pane slot.
   * Fetches notes from the backend and displays them with timestamps.
   * If there are no pinned notes, shows an info toast instead.
   * @param {number} slotIdx - The terminal pane slot index
   */
  async _showPinnedNotesModal(slotIdx) {
    const tp = this.terminalPanes[slotIdx];
    if (!tp || !tp.sessionId) return;
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    const data = await this.api('GET', `/api/workspaces/${ws.id}/pinned-notes/${tp.sessionId}`);
    const notes = data.notes || [];
    if (notes.length === 0) {
      this.showToast('No pinned notes for this session', 'info');
      return;
    }
    const body = notes.map(n => `[${n.timestamp}]\n${n.text}`).join('\n\n---\n\n');
    await this.showPromptModal({
      title: 'Pinned Notes',
      fields: [{ key: 'body', type: 'textarea', value: body }],
      confirmText: 'Close',
    });
  }

  /**
   * Context menu shown when right-clicking an empty (no terminal) pane slot.
   * Offers quick access to all pane view types.
   */
  _showEmptyPaneContextMenu(slotIdx, x, y) {
    const items = [
      { label: 'Worktree Tasks', action: () => this.openViewInPane(slotIdx, 'tasks-worktree') },
      { label: 'td Issues', action: () => this.openViewInPane(slotIdx, 'tasks-td') },
      { label: 'Git Status', action: () => this.openViewInPane(slotIdx, 'tasks-git') },
      { label: 'Files', action: () => this.openViewInPane(slotIdx, 'tasks-files') },
      { type: 'sep' },
      { label: 'Workspace Doc', action: () => this.openViewInPane(slotIdx, 'doc') },
    ];
    this._renderContextItems('Open View', items, x, y);
  }

  /**
   * Build the "Codex settings" submenu (Plan 21-01).
   *
   * Pure factory: returns an array of menu items suitable for the existing
   * _renderContextItems renderer (label/submenu/check/hint/action/danger
   * shape). Reads the session's current providerSettings from
   * this.state.allSessions (or this.state.sessions) and uses the values to
   * mark the active option with a check in each submenu.
   *
   * Each leaf action PUTs the new bundle to the server and shows a toast
   * hinting the user to restart the pane for the change to take effect
   * (pty-manager only reads providerSettings on spawn). The bypass toggle
   * routes through showConfirmModal first because it weakens the sandbox.
   *
   * Dispatched from showTerminalContextMenu when the pane's
   * dataset.provider matches the Codex provider id. Pane menus for other
   * providers skip this branch so a Claude pane never shows a Codex submenu.
   *
   * @param {number} slotIdx - Terminal pane slot index.
   * @param {Object} tp - The TerminalPane instance for this slot.
   * @returns {Array<Object>} Menu items to splice into the pane context menu.
   */
  _buildCodexPaneMenu(slotIdx, tp) { // gsd:provider-literal-allowed (Codex pane menu factory)
    const sessionId = tp.sessionId;
    // Look up the session record to read providerSettings.codex. Defensive
    // because some panes (Codex Desktop project sessions) may not exist in
    // the live sessions list yet; in that case we render with empty
    // settings and let the user dial them in.
    const allSessions = [
      ...(this.state.sessions || []),
      ...(this.state.allSessions || []),
    ];
    const sess = allSessions.find(s => s && s.id === sessionId) || {};
    const codexSettings = (sess.providerSettings && sess.providerSettings.codex) /* gsd:provider-literal-allowed */ || {};

    // alpha.6: include `provider` in the body so the server's ad-hoc
    // fallback can persist settings for Codex Desktop panes that were
    // right-click-opened (no Myrlin store record yet). When a store record
    // exists the server ignores body.provider and uses session.provider.
    // Read the provider id from the pane's data-provider attribute (set by
    // openTerminalInPane / restored layout); fall back to the Codex id
    // because this factory only fires on Codex panes via the dispatcher.
    const paneElForMenu = document.getElementById(`term-pane-${slotIdx}`);
    const codexProviderId = (paneElForMenu && paneElForMenu.dataset && paneElForMenu.dataset.provider) || 'codex'; /* gsd:provider-literal-allowed (Codex pane default for this menu factory) */
    const putSettings = async (partial) => {
      const next = { ...codexSettings, ...partial };
      try {
        await this.api('PUT', '/api/sessions/' + encodeURIComponent(sessionId) + '/provider-settings', {
          settings: next,
          provider: codexProviderId,
        });
        if (!sess.providerSettings) sess.providerSettings = {};
        sess.providerSettings.codex = next; // gsd:provider-literal-allowed
        // Also mirror into the ad-hoc cache so the strip render path
        // (which falls back to adHocProviderSettings) sees the change
        // even when the session has no Myrlin store record.
        if (!this.state.adHocProviderSettings) this.state.adHocProviderSettings = {};
        if (!this.state.adHocProviderSettings.codex /* gsd:provider-literal-allowed */) this.state.adHocProviderSettings.codex = {}; // gsd:provider-literal-allowed
        this.state.adHocProviderSettings.codex[sessionId] = next; // gsd:provider-literal-allowed
        if (typeof this._renderCodexStatusStrip === 'function') {
          this._renderCodexStatusStrip(slotIdx);
        }
        this.showToast('Codex settings updated — restart pane to apply', 'info');
      } catch (err) {
        this.showToast(err.message || 'Failed to update Codex settings', 'error');
      }
    };

    // Catalog of accepted values per setting. Mirrors backend allow-lists.
    const MODEL_OPTIONS = [
      { id: 'gpt-5-codex', label: 'gpt-5-codex' },
      { id: 'gpt-5', label: 'gpt-5' },
      { id: 'o3', label: 'o3' },
    ];
    const SANDBOX_OPTIONS = [
      { id: 'read-only', label: 'read-only' },
      { id: 'workspace-write', label: 'workspace-write' },
      { id: 'danger-full-access', label: 'danger-full-access (risky)' },
    ];
    const APPROVAL_OPTIONS = [
      { id: 'untrusted', label: 'untrusted (prompt for unknown commands)' },
      { id: 'on-failure', label: 'on-failure' },
      { id: 'on-request', label: 'on-request' },
      { id: 'never', label: 'never (auto-approve everything)' },
    ];
    const EFFORT_OPTIONS = [
      { id: 'minimal', label: 'minimal' },
      { id: 'low', label: 'low' },
      { id: 'medium', label: 'medium' },
      { id: 'high', label: 'high' },
    ];
    const FEATURE_OPTIONS = [
      { id: 'web_search', label: 'Web search' },
      { id: 'view_image', label: 'View images' },
      { id: 'plan_tool', label: 'Plan tool' },
      { id: 'apply_patch_tool', label: 'Apply patch tool' },
    ];

    const codexItems = [];

    // 1. Model submenu
    codexItems.push({
      label: 'Model',
      icon: '&#129504;',
      hint: codexSettings.model || 'default',
      submenu: MODEL_OPTIONS.map(opt => ({
        label: opt.label,
        action: () => putSettings({ model: opt.id }),
        check: codexSettings.model === opt.id,
      })),
    });

    // 2. Sandbox submenu
    codexItems.push({
      label: 'Sandbox',
      icon: '&#128274;',
      hint: codexSettings.sandbox || 'default',
      submenu: SANDBOX_OPTIONS.map(opt => ({
        label: opt.label,
        action: () => putSettings({ sandbox: opt.id }),
        check: codexSettings.sandbox === opt.id,
        danger: opt.id === 'danger-full-access',
      })),
    });

    // 3. Approval Policy submenu
    codexItems.push({
      label: 'Approval Policy',
      icon: '&#9989;',
      hint: codexSettings.approvalPolicy || 'default',
      submenu: APPROVAL_OPTIONS.map(opt => ({
        label: opt.label,
        action: () => putSettings({ approvalPolicy: opt.id }),
        check: codexSettings.approvalPolicy === opt.id,
        danger: opt.id === 'never',
      })),
    });

    // 4. Reasoning Effort submenu
    codexItems.push({
      label: 'Reasoning Effort',
      icon: '&#128173;',
      hint: codexSettings.reasoningEffort || 'default',
      submenu: EFFORT_OPTIONS.map(opt => ({
        label: opt.label,
        action: () => putSettings({ reasoningEffort: opt.id }),
        check: codexSettings.reasoningEffort === opt.id,
      })),
    });

    // 5. Bypass toggle with confirmation modal
    const isBypassOn = codexSettings.bypassApprovalsAndSandbox === true;
    codexItems.push({
      label: isBypassOn ? 'Bypass: ON (click to disable)' : 'Bypass Approvals & Sandbox',
      icon: '&#9888;',
      danger: true,
      check: isBypassOn,
      action: async () => {
        if (isBypassOn) {
          // Turning OFF a dangerous flag is safe; no confirmation needed.
          await putSettings({ bypassApprovalsAndSandbox: false });
          return;
        }
        // Turning ON: require explicit confirmation. The bypass flag
        // disables BOTH the approval workflow AND the sandbox, so the
        // session can read/write/exec anything the user can. Worth a
        // second click before flipping.
        const confirmed = await this.showConfirmModal({
          title: 'Enable Bypass for Codex?',
          message: 'This disables BOTH the approval workflow AND the sandbox for this Codex session. The session can read/write/execute anything you can. Continue?',
          confirmText: 'Enable Bypass',
          confirmClass: 'btn-danger',
        });
        if (confirmed) {
          await putSettings({ bypassApprovalsAndSandbox: true });
        }
      },
    });

    // 6. Features submenu (multi-select via per-item toggle)
    const activeFeatures = Array.isArray(codexSettings.features) ? codexSettings.features : [];
    codexItems.push({
      label: 'Features',
      icon: '&#9881;',
      hint: activeFeatures.length ? activeFeatures.join(', ') : 'none',
      submenu: FEATURE_OPTIONS.map(opt => ({
        label: opt.label,
        action: () => {
          const next = activeFeatures.includes(opt.id)
            ? activeFeatures.filter(f => f !== opt.id)
            : [...activeFeatures, opt.id];
          putSettings({ features: next });
        },
        check: activeFeatures.includes(opt.id),
      })),
    });

    return codexItems;
  }

  /**
   * Render the Codex bottom status strip on a pane (Plan 22-01).
   *
   * Mirrors Codex Desktop's bottom bar: a single row of clickable chips
   * showing model / sandbox / approval / effort / [BYPASS] / [features].
   * Each chip click opens the corresponding submenu from
   * _buildCodexPaneMenu anchored to the chip's screen rect, so settings
   * are discoverable + changeable without right-clicking.
   *
   * Idempotent: safe to call multiple times on the same pane; the
   * function replaces innerHTML on the existing strip if one exists.
   * Bails (and removes any existing strip) on empty panes or non-Codex
   * panes — the CSS selector restricts visibility too, but cleaning the
   * DOM avoids leftover nodes after pane provider swaps.
   *
   * @param {number} slotIdx
   */
  _renderCodexStatusStrip(slotIdx) {
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;
    const isCodex = paneEl.dataset.provider === 'codex'; // gsd:provider-literal-allowed (CSS attribute selector match)
    const isEmpty = paneEl.classList.contains('terminal-pane-empty');
    let strip = paneEl.querySelector(':scope > .codex-pane-status');
    if (!isCodex || isEmpty) {
      if (strip) strip.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'codex-pane-status';
      paneEl.appendChild(strip);
      strip.addEventListener('click', (e) => this._onCodexStatusChipClick(e, slotIdx));
    }
    const tp = this.terminalPanes[slotIdx];
    if (!tp) { strip.innerHTML = ''; return; }
    const sessionId = tp.sessionId;
    const allSessions = [
      ...(this.state.sessions || []),
      ...(this.state.allSessions || []),
    ];
    const sess = allSessions.find(s => s && s.id === sessionId) || {};
    const adHoc = (this.state.adHocProviderSettings && this.state.adHocProviderSettings.codex /* gsd:provider-literal-allowed */) || {};
    const settings = (sess.providerSettings && sess.providerSettings.codex) /* gsd:provider-literal-allowed */ || adHoc[sessionId] || {};

    const esc = (s) => this.escapeHtml(String(s));
    const chip = (key, label, value, isDefault, extraClass = '') => {
      const cls = 'codex-status-chip' + (extraClass ? ' ' + extraClass : '');
      const valCls = 'codex-status-chip-value' + (isDefault ? ' is-default' : '');
      return `<span class="${cls}" data-chip="${esc(key)}">
        <span class="codex-status-chip-label">${esc(label)}:</span>
        <span class="${valCls}">${esc(value)}</span>
      </span>`;
    };

    const chips = [];
    chips.push(chip('model', 'model', settings.model || 'gpt-5-codex', !settings.model));
    chips.push(chip('sandbox', 'sandbox', settings.sandbox || 'workspace-write', !settings.sandbox));
    chips.push(chip('approval', 'approval', settings.approvalPolicy || 'on-request', !settings.approvalPolicy));
    chips.push(chip('effort', 'effort', settings.reasoningEffort || 'medium', !settings.reasoningEffort));
    if (settings.bypassApprovalsAndSandbox === true) {
      chips.push(`<span class="codex-status-chip codex-status-chip-bypass" data-chip="bypass">BYPASS</span>`);
    }
    const activeFeatures = Array.isArray(settings.features) ? settings.features : [];
    if (activeFeatures.length > 0) {
      chips.push(chip('features', 'features', String(activeFeatures.length), false));
    }
    strip.innerHTML = chips.join('');
  }

  /**
   * Click handler for chip clicks on the Codex status strip.
   * Maps the chip's data-chip key to the matching submenu label produced
   * by _buildCodexPaneMenu, then renders that submenu's items anchored to
   * the chip's rect via the existing _renderContextItems renderer.
   *
   * @param {Event} e
   * @param {number} slotIdx
   */
  _onCodexStatusChipClick(e, slotIdx) {
    const chipEl = e.target.closest('.codex-status-chip');
    if (!chipEl) return;
    e.stopPropagation();
    const key = chipEl.dataset.chip;
    const tp = this.terminalPanes[slotIdx];
    if (!tp) return;
    const items = this._buildCodexPaneMenu(slotIdx, tp);
    const labelMap = {
      model: 'Model',
      sandbox: 'Sandbox',
      approval: 'Approval Policy',
      effort: 'Reasoning Effort',
      bypass: null, // bypass chip click triggers the same action as the menu item
      features: 'Features',
    };
    const rect = chipEl.getBoundingClientRect();
    if (key === 'bypass') {
      // The bypass chip is only visible when bypass is ON. Clicking it
      // toggles OFF (no confirmation required for disabling). Find the
      // bypass item and fire its action directly.
      const bypassItem = items.find(it => /Bypass/.test(it.label));
      if (bypassItem && typeof bypassItem.action === 'function') bypassItem.action();
      return;
    }
    const matchLabel = labelMap[key];
    if (!matchLabel) return;
    const item = items.find(it => it.label === matchLabel);
    if (!item || !Array.isArray(item.submenu)) return;
    // Render the submenu's items as a top-level menu anchored to the
    // chip rect. Uses the existing _renderContextItems renderer that
    // owns positioning + dismiss.
    this._renderContextItems(matchLabel, item.submenu, rect.left, rect.bottom);
  }

  showTerminalContextMenu(slotIdx, x, y) {
    const tp = this.terminalPanes[slotIdx];
    if (!tp) return;

    const items = [];

    // ── Terminal-specific actions ──────────────────────────────

    // Copy selected text (only show when there's a selection)
    if (tp.term && tp.term.hasSelection()) {
      items.push({
        label: 'Copy', icon: '&#128203;', action: () => {
          const selected = tp.term.getSelection();
          if (selected) {
            navigator.clipboard.writeText(selected);
            this.showToast('Copied to clipboard', 'success');
          }
        },
      });
    }

    // Save to Notes (only show when there's a selection)
    if (tp.term && tp.term.hasSelection()) {
      items.push({
        label: 'Save to Notes', icon: '&#128221;', action: async () => {
          const selected = tp.term.getSelection();
          const ws = this.state.activeWorkspace;
          if (!ws) { this.showToast('No active workspace', 'error'); return; }
          const result = await this.showPromptModal({
            title: 'Save to Notes',
            fields: [{ key: 'text', type: 'textarea', value: selected }],
            confirmText: 'Save Note'
          });
          if (!result) return;
          await this.api('POST', '/api/workspaces/' + ws.id + '/docs/notes', { text: result.text.trim() });
          this.loadDocs();
          this.showToast('Saved to Notes', 'success');
        },
      });
    }

    // Paste from clipboard
    items.push({
      label: 'Paste', icon: '&#128203;', action: () => {
        tp.pasteFromClipboard();
      },
    });

    items.push({ type: 'sep' });

    // Fix Terminal - sends reset command
    items.push({
      label: 'Fix Terminal (reset)', icon: '&#8635;', action: () => {
        tp.sendCommand('reset\r');
        this.showToast('Sent reset to terminal', 'info');
      },
    });

    // Restart Session - kills and relaunches the Claude session in-place
    items.push({
      label: 'Restart Session', icon: '&#8635;', action: async () => {
        const sid = tp.sessionId;
        const sName = tp.sessionName;
        const oldOpts = { ...(tp.spawnOpts || {}) };
        try {
          await this.api('POST', `/api/pty/${encodeURIComponent(sid)}/kill`);
        } catch (_) {
          // Session may already be dead, continue with relaunch
        }
        this.closeTerminalPane(slotIdx);
        // Reopen in the same slot with the same options (resumes the session)
        this.openTerminalInPane(slotIdx, sid, sName, oldOpts);
        this.showToast('Session restarted', 'success');
      },
    });

    // Kill & Restart - kills the PTY process so claude can be restarted
    items.push({
      label: 'Kill Session', icon: '&#9747;', danger: true, action: async () => {
        try {
          await this.api('POST', `/api/pty/${encodeURIComponent(tp.sessionId)}/kill`);
          this.showToast('Session killed - drop again to restart', 'warning');
          // Close the terminal pane since the process is dead
          this.closeTerminalPane(slotIdx);
        } catch (err) {
          this.showToast(err.message || 'Failed to kill session', 'error');
        }
      },
    });

    // ── Change Environment (shell switcher) ─────────────────
    // Let users relaunch the terminal in a different shell
    const currentShell = (tp.spawnOpts && tp.spawnOpts.shell) || (navigator.platform.startsWith('Win') ? 'cmd.exe' : 'bash');
    const isWin = navigator.platform.startsWith('Win');
    const shellOptions = isWin ? [
      { id: 'cmd.exe', label: 'CMD' },
      { id: 'powershell.exe', label: 'PowerShell' },
      { id: 'pwsh.exe', label: 'PowerShell 7' },
      { id: 'git-bash', label: 'Git Bash' },
    ] : [
      { id: 'bash', label: 'Bash' },
      { id: 'zsh', label: 'Zsh' },
      { id: 'fish', label: 'Fish' },
    ];
    items.push({ type: 'sep', label: 'Environment' });
    for (const opt of shellOptions) {
      const isCurrent = opt.id === currentShell;
      items.push({
        label: (isCurrent ? '\u2713 ' : '  ') + opt.label,
        className: isCurrent ? 'context-item-current' : '',
        action: isCurrent ? null : async () => {
          // Kill existing PTY, then relaunch in the new shell
          const sid = tp.sessionId;
          const sName = tp.sessionName;
          const oldOpts = { ...(tp.spawnOpts || {}) };
          try {
            await this.api('POST', `/api/pty/${encodeURIComponent(sid)}/kill`);
          } catch (_) {
            // Session may already be dead, continue with relaunch
          }
          this.closeTerminalPane(slotIdx);
          // Reopen in the same slot with the new shell
          const newOpts = { ...oldOpts, shell: opt.id };
          this.openTerminalInPane(slotIdx, sid, sName, newOpts);
          this.showToast(`Switched to ${opt.label}`, 'success');
        },
      });
    }

    // ── Shared session management items ───────────────────────
    // Plan 22-04: pass tp so the function can build an ad-hoc subset when
    // no store record exists for tp.sessionId (Codex Desktop right-click,
    // drag-dropped sessions, etc.).
    const sessionItems = this._buildSessionContextItems(tp.sessionId, tp);
    if (sessionItems) {
      items.push({ type: 'sep' });
      items.push(...sessionItems);
    }

    // ── File Conflicts (JSONL-based) ─────────────────────────
    const sessionConflicts = this.getSessionConflicts(tp.sessionId);
    if (sessionConflicts.length > 0) {
      items.push({ type: 'sep' });
      items.push({
        label: `Conflicts (${sessionConflicts.length})`, icon: '&#9888;', className: 'conflict-warning', action: () => {
          // Build a readable list of conflicting files and other sessions
          const lines = sessionConflicts.map(c => {
            const fileName = (c.file || 'unknown').split('/').pop();
            const otherSessions = (c.sessions || [])
              .filter(s => s.id !== tp.sessionId)
              .map(s => s.name || s.id.substring(0, 12));
            return `${fileName} -- also edited by: ${otherSessions.join(', ')}`;
          });
          this.showToast(lines.join('\n'), 'warning');
          // Also open the conflict center if available
          if (this.els.conflictCenterOverlay) {
            this.openConflictCenter();
          }
        },
      });
    }

    // ── Provider-specific submenu (Plan 21-01) ────────────────
    // Dispatch by data-provider on the pane element. The Codex pane gets
    // a "Codex settings" submenu with model/sandbox/approval/effort/bypass/
    // features; Claude panes get nothing here and fall through unchanged.
    const paneElForProvider = document.getElementById(`term-pane-${slotIdx}`);
    const paneProvider = paneElForProvider && paneElForProvider.dataset && paneElForProvider.dataset.provider;
    if (paneProvider === 'codex') { // gsd:provider-literal-allowed (per-provider dispatch)
      items.push({ type: 'sep' });
      items.push({
        label: 'Codex settings',
        icon: '&#129504;',
        submenu: this._buildCodexPaneMenu(slotIdx, tp),
      });
    }

    // ── Pane management ───────────────────────────────────────
    items.push({ type: 'sep' });

    // Close pane
    items.push({
      label: 'Close Pane', icon: '&#10005;', action: () => {
        this.closeTerminalPane(slotIdx);
      },
    });

    // Inspect Element - select element in DevTools or log to console
    items.push({
      label: 'Inspect Element', icon: '&#128269;', action: () => {
        const paneEl = document.getElementById(`term-pane-${slotIdx}`);
        if (typeof inspect === 'function') {
          inspect(paneEl);
        } else {
          console.log('%c[Inspect]', 'color:#cba6f7;font-weight:bold', paneEl);
          this.showToast('Element logged to console (F12)', 'info');
        }
      },
    });

    // ── Switch to view ────────────────────────────────────────
    items.push({ type: 'sep' });
    items.push({
      label: 'Switch to view',
      submenu: [
        { label: 'Worktree Tasks', action: () => this.openViewInPane(slotIdx, 'tasks-worktree') },
        { label: 'td Issues', action: () => this.openViewInPane(slotIdx, 'tasks-td') },
        { label: 'Git Status', action: () => this.openViewInPane(slotIdx, 'tasks-git') },
        { label: 'Files', action: () => this.openViewInPane(slotIdx, 'tasks-files') },
        { label: 'Workspace Doc', action: () => this.openViewInPane(slotIdx, 'doc') },
      ],
    });

    this._renderContextItems(tp.sessionName || 'Terminal', items, x, y);
  }

  closeTerminalPane(slotIdx) {
    // If our schedule popover is anchored on this pane's clock, close it.
    if (window.SchedulePopover && window.SchedulePopover.anchor) {
      const paneElForPopover = document.getElementById(`term-pane-${slotIdx}`);
      if (paneElForPopover && paneElForPopover.contains(window.SchedulePopover.anchor)) {
        window.SchedulePopover.close();
      }
    }
    if (this._paneRefreshTimers[slotIdx]) {
      clearInterval(this._paneRefreshTimers[slotIdx]);
      delete this._paneRefreshTimers[slotIdx];
    }

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
    paneEl.removeAttribute('data-provider');
    const titleEl = paneEl.querySelector('.terminal-pane-title');
    if (titleEl) titleEl.textContent = 'Drop a session here';
    // Plan 22-02: hide and clear the provider pill when the pane empties.
    const pillElClose = paneEl.querySelector('.pane-provider-pill');
    if (pillElClose) { pillElClose.hidden = true; pillElClose.textContent = ''; pillElClose.removeAttribute('data-provider'); }
    const closeBtn = paneEl.querySelector('.terminal-pane-close');
    if (closeBtn) closeBtn.hidden = true;
    const uploadBtn3 = paneEl.querySelector('.terminal-pane-upload');
    if (uploadBtn3) uploadBtn3.hidden = true;
    const scheduleBtn3 = paneEl.querySelector('.terminal-pane-schedule');
    if (scheduleBtn3) {
      scheduleBtn3.hidden = true;
      const badge = scheduleBtn3.querySelector('.pane-schedule-count');
      if (badge) { badge.textContent = ''; badge.hidden = true; }
    }
    // Collapse any active expansion before closing
    this._collapseExpandPane(slotIdx);
    const expandBtn3 = paneEl.querySelector('.terminal-pane-expand');
    if (expandBtn3) expandBtn3.hidden = true;
    const collapseBtn3 = paneEl.querySelector('.terminal-pane-collapse');
    if (collapseBtn3) collapseBtn3.hidden = true;
    // Stop any active voice recognition and hide mic button on pane close
    this._stopVoiceRecognition(slotIdx);
    const micBtn3 = paneEl.querySelector('.terminal-pane-mic');
    if (micBtn3) { micBtn3.hidden = true; micBtn3.classList.remove('mic-active'); }
    // Remove any interim transcript overlay
    const interimOverlay = paneEl.querySelector('.voice-interim-overlay');
    if (interimOverlay) interimOverlay.remove();
    const activityEl = document.getElementById(`term-activity-${slotIdx}`);
    if (activityEl) activityEl.innerHTML = '';
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
      this.showToast(`"${sessionName}" moved to background - drag it back to reconnect`, 'info');
    }

    // Route through the centralised chokepoint so the sidebar indicator and
    // server-persisted layout reflect the closed pane.
    this.saveTerminalLayout();
  }

  /**
   * Cycle expand state: normal → stage1 (fills grid) → stage2 (fills full viewport).
   * Expand button (outward arrows): visible at normal + stage1 (green at stage1), hidden at stage2.
   * Collapse button (inward arrows, red): hidden at normal, visible at stage1 + stage2.
   * @param {number} slotIdx - The terminal pane slot index
   */
  _cycleExpandPane(slotIdx) {
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;
    const expandBtn = paneEl.querySelector('.terminal-pane-expand');
    const collapseBtn = paneEl.querySelector('.terminal-pane-collapse');

    if (paneEl.classList.contains('pane-expanded-stage1')) {
      // Stage1 → stage2: hide expand, keep collapse visible
      paneEl.classList.remove('pane-expanded-stage1');
      paneEl.classList.add('pane-expanded-stage2');
      if (expandBtn) {
        expandBtn.classList.remove('terminal-pane-expand-stage1');
        expandBtn.classList.add('terminal-pane-expand-stage2');
        expandBtn.title = 'Expand pane';
      }
    } else {
      // Normal → stage1: expand turns green, collapse appears
      paneEl.classList.add('pane-expanded-stage1');
      if (expandBtn) {
        expandBtn.classList.add('terminal-pane-expand-stage1');
        expandBtn.title = 'Expand to full screen';
      }
      if (collapseBtn) collapseBtn.hidden = false;
    }

    const tp = this.terminalPanes[slotIdx];
    if (tp) requestAnimationFrame(() => tp.safeFit());
  }

  /**
   * Collapse an expanded pane back to normal state.
   * @param {number} slotIdx - The terminal pane slot index
   */
  _collapseExpandPane(slotIdx) {
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;
    paneEl.classList.remove('pane-expanded-stage1', 'pane-expanded-stage2');
    const expandBtn = paneEl.querySelector('.terminal-pane-expand');
    if (expandBtn) {
      expandBtn.classList.remove('terminal-pane-expand-stage1', 'terminal-pane-expand-stage2');
      expandBtn.title = 'Expand pane';
    }
    const collapseBtn = paneEl.querySelector('.terminal-pane-collapse');
    if (collapseBtn) collapseBtn.hidden = true;
  }

  /**
   * Collapse all expanded terminal panes back to normal state.
   * Used by the Escape key cascade as lowest-priority action.
   */
  _collapseAllExpandedPanes() {
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      const paneEl = document.getElementById(`term-pane-${i}`);
      if (paneEl && (paneEl.classList.contains('pane-expanded-stage1') || paneEl.classList.contains('pane-expanded-stage2'))) {
        this._collapseExpandPane(i);
        const tp = this.terminalPanes[i];
        if (tp) requestAnimationFrame(() => tp.safeFit());
      }
    }
  }

  /**
   * Toggle voice input (speech-to-text) for a terminal pane.
   * Uses the Web Speech API (SpeechRecognition) to capture a single utterance,
   * transcribe it, and send it to the terminal's WebSocket as input.
   * @param {number} slotIdx - The terminal pane slot index
   */
  toggleVoiceInput(slotIdx) {
    // If already recording for this slot, stop, send accumulated text, and return
    if (this._voiceRecognitions[slotIdx]) {
      this._stopVoiceRecognition(slotIdx);
      return;
    }

    const tp = this.terminalPanes[slotIdx];
    if (!tp) {
      this.showToast('No active terminal in this pane', 'warning');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.showToast('Speech recognition not supported in this browser', 'warning');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;    // Keep listening until user clicks stop
    recognition.interimResults = true; // Show partial results while speaking
    recognition.lang = 'en-US';

    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    const micBtn = paneEl ? paneEl.querySelector('.terminal-pane-mic') : null;

    // Accumulated final transcript segments (sent when user clicks stop)
    let accumulatedTranscript = '';

    // Create interim overlay element for showing live transcription
    let interimOverlay = null;
    if (paneEl) {
      interimOverlay = document.createElement('div');
      interimOverlay.className = 'voice-interim-overlay';
      interimOverlay.textContent = 'Listening... (click mic to send)';
      paneEl.appendChild(interimOverlay);
    }

    // Update the overlay with accumulated + interim text
    const updateOverlay = (interim) => {
      if (!interimOverlay) return;
      const display = accumulatedTranscript + (interim ? interim : '');
      interimOverlay.textContent = display || 'Listening... (click mic to send)';
    };

    // Handle speech recognition results (both interim and final)
    recognition.onresult = (event) => {
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          // Accumulate finalized segments (browser commits these on natural pauses)
          accumulatedTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      updateOverlay(interimTranscript);
    };

    // Handle recognition start
    recognition.onstart = () => {
      if (micBtn) micBtn.classList.add('mic-active');
      this.showToast('Listening... click mic again to send', 'info');
    };

    // Handle recognition end. In continuous mode the browser may auto-disconnect
    // (silence timeout, network drop, etc.). If the user didn't explicitly stop,
    // restart automatically so listening continues until the button is pressed.
    recognition.onend = () => {
      if (recognition._cwmUserStopped) {
        // User clicked stop: send accumulated transcript and clean up
        if (micBtn) micBtn.classList.remove('mic-active');
        if (interimOverlay && interimOverlay.parentNode) interimOverlay.remove();
        delete this._voiceRecognitions[slotIdx];

        const text = accumulatedTranscript.trim();
        if (text) {
          const currentTp = this.terminalPanes[slotIdx];
          if (!currentTp || !currentTp.ws || currentTp.ws.readyState !== WebSocket.OPEN) {
            this.showToast('Terminal not connected, voice input discarded', 'warning');
          } else {
            // Clean up punctuation and grammar before sending
            this._punctuateVoiceText(text).then(cleaned => {
              currentTp.ws.send(JSON.stringify({ type: 'input', data: cleaned + '\n' }));
              this.showToast('Voice input sent', 'success');
            });
          }
        }
      } else {
        // Browser auto-stopped (silence timeout, network). Restart to keep listening.
        try {
          recognition.start();
        } catch (_) {
          // If restart fails, clean up gracefully
          if (micBtn) micBtn.classList.remove('mic-active');
          if (interimOverlay && interimOverlay.parentNode) interimOverlay.remove();
          delete this._voiceRecognitions[slotIdx];
        }
      }
    };

    // Handle recognition errors
    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are expected during continuous listening,
      // they happen on silence timeouts and restarts. Don't show errors for these.
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      const errorMessages = {
        'audio-capture': 'Microphone not available',
        'not-allowed': 'Microphone access denied, check browser permissions',
        'network': 'Network error during speech recognition',
      };
      const msg = errorMessages[event.error] || `Speech recognition error: ${event.error}`;
      this.showToast(msg, 'error');
      recognition._cwmUserStopped = true; // Prevent auto-restart on fatal errors
      if (micBtn) micBtn.classList.remove('mic-active');
      if (interimOverlay && interimOverlay.parentNode) interimOverlay.remove();
      delete this._voiceRecognitions[slotIdx];
    };

    // Store the recognition instance and start listening
    this._voiceRecognitions[slotIdx] = recognition;
    recognition.start();
  }

  /**
   * Stop an active voice recognition session for a given terminal pane slot.
   * Sets the userStopped flag so onend sends accumulated text instead of restarting.
   * Safe to call even if no recognition is active for the slot.
   * @param {number} slotIdx - The terminal pane slot index
   */
  _stopVoiceRecognition(slotIdx) {
    const recognition = this._voiceRecognitions[slotIdx];
    if (recognition) {
      // Mark as user-stopped so onend sends accumulated text instead of restarting.
      // We use stop() (not abort()) so any pending results still fire before onend.
      recognition._cwmUserStopped = true;
      try {
        recognition.stop();
      } catch (_) {
        // Fallback: clean up directly if stop() throws
        delete this._voiceRecognitions[slotIdx];
      }
    }
  }

  /**
   * Add punctuation and grammar to raw voice transcription text.
   * Tries the server-side AI punctuation endpoint (uses Anthropic API key if configured).
   * Falls back to basic rule-based cleanup if the API is unavailable.
   * @param {string} rawText - Raw speech-to-text output without punctuation
   * @returns {Promise<string>} Cleaned text with punctuation and capitalization
   */
  async _punctuateVoiceText(rawText) {
    if (!rawText || !rawText.trim()) return rawText;

    // Try AI-powered punctuation via the server
    try {
      const data = await this.api('POST', '/api/ai/punctuate', { text: rawText });
      if (data && data.text) return data.text;
    } catch (_) {
      // API unavailable or no key configured, fall through to rule-based
    }

    // Rule-based fallback: capitalize first letter, add period at end
    let text = rawText.trim();
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (!/[.!?]$/.test(text)) text += '.';
    return text;
  }

  /**
   * Swap two terminal panes in the grid.
   * Swaps the xterm DOM nodes and the terminalPanes array entries.
   * If one slot is empty, it becomes a move instead of a swap.
   */
  swapTerminalPanes(srcSlot, dstSlot) {
    console.log(`[DnD] Swapping panes: slot ${srcSlot} <-> slot ${dstSlot}`);
    const srcTp = this.terminalPanes[srcSlot];
    const dstTp = this.terminalPanes[dstSlot];

    // Swap in the array
    this.terminalPanes[srcSlot] = dstTp;
    this.terminalPanes[dstSlot] = srcTp;

    // Update DOM for both panes
    [srcSlot, dstSlot].forEach(slot => {
      const tp = this.terminalPanes[slot];
      const paneEl = document.getElementById(`term-pane-${slot}`);
      const container = document.getElementById(`term-container-${slot}`);
      const titleEl = paneEl ? paneEl.querySelector('.terminal-pane-title') : null;
      const closeBtn = paneEl ? paneEl.querySelector('.terminal-pane-close') : null;
      const uploadBtnEl = paneEl ? paneEl.querySelector('.terminal-pane-upload') : null;
      const scheduleBtnEl = paneEl ? paneEl.querySelector('.terminal-pane-schedule') : null;
      const micBtnEl = paneEl ? paneEl.querySelector('.terminal-pane-mic') : null;
      if (!paneEl) return;

      if (tp) {
        // Occupied pane - move the terminal DOM
        paneEl.hidden = false;
        paneEl.classList.remove('terminal-pane-empty');
        if (titleEl) titleEl.textContent = tp.sessionName || tp.sessionId;
        if (closeBtn) closeBtn.hidden = false;
        if (uploadBtnEl) uploadBtnEl.hidden = false;
        if (scheduleBtnEl) scheduleBtnEl.hidden = false;
        if (micBtnEl && this._speechRecognitionAvailable) micBtnEl.hidden = false;
        // Move the xterm element into the new container
        if (container && tp.term) {
          container.innerHTML = '';
          const xtermEl = tp.term.element;
          if (xtermEl) {
            container.appendChild(xtermEl);
          }
        }
      } else {
        // Empty pane - reset to drop target
        paneEl.classList.remove('terminal-pane-active');
        paneEl.classList.add('terminal-pane-empty');
        if (titleEl) titleEl.textContent = 'Drop a session here';
        if (closeBtn) closeBtn.hidden = true;
        if (uploadBtnEl) uploadBtnEl.hidden = true;
        if (scheduleBtnEl) {
          scheduleBtnEl.hidden = true;
          const badge = scheduleBtnEl.querySelector('.pane-schedule-count');
          if (badge) { badge.textContent = ''; badge.hidden = true; }
        }
        if (micBtnEl) { micBtnEl.hidden = true; micBtnEl.classList.remove('mic-active'); }
        if (container) container.innerHTML = '';
      }
    });

    // Update active pane tracking
    if (this._activeTerminalSlot === srcSlot) {
      this._activeTerminalSlot = dstSlot;
    } else if (this._activeTerminalSlot === dstSlot) {
      this._activeTerminalSlot = srcSlot;
    }

    // Update grid layout and refit terminals
    this.updateTerminalGridLayout();

    // Refit after the swap so terminals size correctly
    requestAnimationFrame(() => {
      [srcSlot, dstSlot].forEach(slot => {
        const tp = this.terminalPanes[slot];
        if (tp) tp.safeFit();
      });
    });

    // Route through the centralised chokepoint so the sidebar indicator and
    // server-persisted layout reflect the swapped panes.
    this.saveTerminalLayout();
  }

  updateTerminalGridLayout() {
    const grid = this.els.terminalGrid;
    if (!grid) return;

    const filledCount = this.terminalPanes.filter(p => p !== null).length;
    // Only show empty drop target when no terminals are open
    const visibleCount = filledCount > 0 ? filledCount : 1;

    grid.setAttribute('data-panes', visibleCount.toString());

    let emptyShown = false;
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      const paneEl = document.getElementById(`term-pane-${i}`);
      if (!paneEl) continue;

      if (this.terminalPanes[i]) {
        // Filled pane - always show
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

    // Smart spanning: for layouts that don't fill a perfect grid,
    // make the last visible pane span remaining columns.
    // Reset any previous span for all panes first.
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      const paneEl = document.getElementById(`term-pane-${i}`);
      if (paneEl) paneEl.style.gridColumn = '';
    }
    if (filledCount === 3) {
      // 2-col grid, 3 panes: last pane spans 2 columns (fills bottom row)
      for (let i = CWMApp.MAX_PANES - 1; i >= 0; i--) {
        if (this.terminalPanes[i]) {
          const paneEl = document.getElementById(`term-pane-${i}`);
          if (paneEl) paneEl.style.gridColumn = 'span 2';
          break;
        }
      }
    } else if (filledCount === 5) {
      // 3-col grid, 5 panes: last pane on bottom row spans remaining space
      // Find the last filled pane and make it span to fill the row
      let bottomRowPanes = 0;
      let lastFilledIdx = -1;
      let count = 0;
      for (let i = 0; i < CWMApp.MAX_PANES; i++) {
        if (this.terminalPanes[i]) {
          count++;
          if (count > 3) bottomRowPanes++;
          lastFilledIdx = i;
        }
      }
      // If bottom row has only 2 panes in a 3-col grid, span the last one
      if (bottomRowPanes === 2 && lastFilledIdx >= 0) {
        const paneEl = document.getElementById(`term-pane-${lastFilledIdx}`);
        if (paneEl) paneEl.style.gridColumn = 'span 2';
      }
    }

    // Apply dynamic grid sizes and position resize handles
    this._applyGridSizes();

    // Refit visible terminal panes after layout change.
    // Double-rAF ensures browser has fully laid out the grid before fitting.
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      this.terminalPanes.forEach(tp => {
        if (tp) tp.safeFit();
      });
    }); });
  }


  /* ═══════════════════════════════════════════════════════════
     TERMINAL COMPLETION NOTIFICATIONS
     When Claude finishes working in a terminal pane, the TerminalPane
     class dispatches a 'terminal-idle' CustomEvent. These methods
     handle the notification: flash the pane border green, play a
     subtle chime, show a toast, and highlight the tab group if the
     pane is in a non-active group.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Handle terminal-idle event from a TerminalPane.
   * Only notifies for non-active panes so the user isn't spammed
   * when they're already looking at the terminal that finished.
   */
  onTerminalIdle({ sessionId, sessionName }) {
    // Respect completion notifications setting
    if (!this.getSetting('completionNotifications')) return;

    // Don't notify for the currently focused/active pane
    const activeIdx = this.terminalPanes.findIndex(tp => tp && tp.sessionId === sessionId);
    if (activeIdx === this._activeTerminalSlot) return;

    // Flash the pane border green
    const paneEls = document.querySelectorAll('.terminal-pane');
    if (paneEls[activeIdx]) {
      paneEls[activeIdx].classList.add('terminal-pane-done');
      setTimeout(() => paneEls[activeIdx].classList.remove('terminal-pane-done'), 4000);
    }

    // Play a subtle notification sound using Web Audio API
    this._playNotificationSound();

    // Show toast
    const name = sessionName || sessionId.substring(0, 12);
    this.showToast(`${name} is ready for input`, 'success');

    // If the pane is in a non-active tab group, highlight the tab
    this._highlightTabGroupForSession(sessionId);

    // Flash the browser tab title when the window isn't focused
    // so users know which window needs attention
    this._flashBrowserTitle(name);
  }

  /**
   * Flash the browser tab title when a session completes and the window
   * isn't focused. Alternates between the notification and original title.
   * Stops when the window regains focus.
   */
  _flashBrowserTitle(sessionName) {
    // Only flash if window is not focused
    if (document.hasFocus()) return;

    const originalTitle = this._originalTitle || document.title;
    this._originalTitle = originalTitle;
    const alertTitle = `🎩 ${sessionName} finished!`;

    // Don't stack multiple flashers
    if (this._titleFlashInterval) clearInterval(this._titleFlashInterval);

    let showAlert = true;
    this._titleFlashInterval = setInterval(() => {
      document.title = showAlert ? alertTitle : originalTitle;
      showAlert = !showAlert;
    }, 1200);

    // Also increment a counter badge
    this._pendingNotifications = (this._pendingNotifications || 0) + 1;

    // Stop flashing when window gets focus
    const stopFlash = () => {
      clearInterval(this._titleFlashInterval);
      this._titleFlashInterval = null;
      this._pendingNotifications = 0;
      document.title = originalTitle;
      window.removeEventListener('focus', stopFlash);
    };
    window.addEventListener('focus', stopFlash);
  }

  /**
   * Play a short two-tone chime via the Web Audio API.
   * Volume is kept low (0.08) to be noticeable but not jarring.
   */
  _playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.setValueAtTime(1000, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) {
      // Web Audio not available - silent fallback
    }
  }

  /**
   * When a session finishes in a non-active tab group, highlight
   * that group's tab button with a pulsing green dot so the user
   * knows something needs attention in another group.
   */
  _highlightTabGroupForSession(sessionId) {
    if (!this._tabGroups || !this._activeGroupId) return;
    // Find which group this session's pane belongs to
    for (const group of this._tabGroups) {
      if (group.id === this._activeGroupId) continue;
      const panes = group.panes || [];
      if (panes.some(p => p && p.sessionId === sessionId)) {
        // Highlight the tab button
        const tabBtn = document.querySelector(`.terminal-group-tab[data-group-id="${group.id}"]`);
        if (tabBtn && !tabBtn.classList.contains('tab-notify')) {
          tabBtn.classList.add('tab-notify');
          // Stays until the tab group is clicked (removed in switchTerminalGroup)
        }
        break;
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════
     TERMINAL FOCUS & RESIZE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Set the active terminal pane - blurs all others, focuses target, highlights it.
   */
  setActiveTerminalPane(slotIdx) {
    // Set slot early to prevent focusin recursion
    this._activeTerminalSlot = slotIdx;

    // Blur all other terminals and mark them as background (throttled rendering)
    this.terminalPanes.forEach((tp, i) => {
      if (tp && i !== slotIdx) {
        tp.blur();
        tp.setFocused(false);
      }
      const pane = document.getElementById(`term-pane-${i}`);
      if (pane) pane.classList.remove('terminal-pane-active');
    });

    // Activate target and mark as focused (full frame-rate rendering)
    const pane = document.getElementById(`term-pane-${slotIdx}`);
    if (pane) pane.classList.add('terminal-pane-active');

    const tp = this.terminalPanes[slotIdx];
    if (tp) {
      tp.setFocused(true);
      tp.focus();
    }

    // If Tasks > td tab is visible and not manually pinned, update to this pane's project
    if (this._activeTasksTab === 'td' && !this._tdPanelDirPinned) {
      const newDir = tp && tp.spawnOpts && tp.spawnOpts.cwd ? tp.spawnOpts.cwd : null;
      if (newDir && newDir !== this._tdPanelDir) {
        this._tdPanelDir = newDir;
        this.renderTasksTdPanel();
      }
    }
  }

  /**
   * Open the full-screen terminal reader overlay.
   * Extracts the entire scrollback buffer from the active terminal pane
   * and displays it as plain text with native touch scrolling.
   * @param {TerminalPane} pane - The terminal pane to read from
   */
  openTerminalReader(pane) {
    if (!pane || !pane.term) return;

    const overlay = document.getElementById('terminal-reader-overlay');
    const content = document.getElementById('terminal-reader-content');
    const title = document.getElementById('terminal-reader-title');
    const closeBtn = document.getElementById('terminal-reader-close');
    if (!overlay || !content) return;

    // Extract full buffer content
    const buffer = pane.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    title.textContent = pane.sessionName || 'Terminal Output';
    content.textContent = lines.join('\n');
    overlay.hidden = false;

    // Scroll to the bottom (most recent output) by default
    requestAnimationFrame(() => {
      content.scrollTop = content.scrollHeight;
    });

    // Close handler
    const close = () => {
      overlay.hidden = true;
      content.textContent = '';
      closeBtn.removeEventListener('click', close);
    };
    closeBtn.addEventListener('click', close);
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
      // Scope this to the xterm viewport only — otherwise we eat touchmoves on
      // pane headers / resize handles and break things like the
      // DragDropTouch polyfill (which listens on document in bubble phase).
      // We don't stop propagation here anymore to allow index.html's hack 
      // preventing the polyfill from breaking xterm's native scroll on desktop touch.
      // (The polyfill needs to be suppressed, index.html does it on document level).
    }, { passive: true });
  }

  /**
   * Initialize horizontal swipe gesture to switch between terminal panes.
   * Only active on mobile. Scoped to terminal-grid to avoid sidebar conflicts.
   */
  initTerminalPaneSwipe() {
    // Enable touch pane swipe on any touch-capable device, not just phones.
    if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;

    const grid = this.els.terminalGrid;
    if (!grid) return;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let swiping = false;

    grid.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      // Don't capture swipe in type mode (user is interacting with terminal)
      const activeTP = this._activeTerminalSlot !== null
        ? this.terminalPanes[this._activeTerminalSlot] : null;
      if (activeTP && activeTP._mobileTypeMode) return;

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
      swiping = true;
    }, { passive: true });

    grid.addEventListener('touchend', (e) => {
      if (!swiping) return;
      swiping = false;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const elapsed = Date.now() - startTime;

      // Must be: fast (<300ms), predominantly horizontal, >80px travel
      if (elapsed > 300 || Math.abs(dy) > Math.abs(dx) * 0.7 || Math.abs(dx) < 80) return;

      // Don't trigger if started near left edge (sidebar swipe zone)
      if (startX < 30) return;

      // Get ordered list of active pane indices
      const activePanes = this.terminalPanes
        .map((tp, i) => tp ? i : -1)
        .filter(i => i !== -1);
      if (activePanes.length <= 1) return;

      const currentIdx = activePanes.indexOf(this._activeTerminalSlot);
      if (currentIdx === -1) return;

      if (dx < 0 && currentIdx < activePanes.length - 1) {
        // Swipe left -> next pane
        this.switchTerminalTab(activePanes[currentIdx + 1]);
      } else if (dx > 0 && currentIdx > 0) {
        // Swipe right -> previous pane
        this.switchTerminalTab(activePanes[currentIdx - 1]);
      }
    }, { passive: true });
  }

  _setupResizeDrag(handle, direction) {
    const start = (clientX, clientY, isTouch) => {
      const grid = this.els.terminalGrid;
      const gridRect = grid.getBoundingClientRect();

      // Mouse drags use a full-screen overlay to keep the resize cursor and
      // capture stray mouse events. Touch drags don't need it (no cursor;
      // touch tracking persists outside the handle naturally).
      let overlay = null;
      if (!isTouch) {
        overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:${direction === 'col' ? 'col-resize' : 'row-resize'};`;
        document.body.appendChild(overlay);
      }

      handle.classList.add('active');

      const move = (cx, cy) => {
        if (direction === 'col') {
          const ratio = (cx - gridRect.left) / gridRect.width;
          const clamped = Math.max(0.15, Math.min(0.85, ratio));
          this._gridColSizes = [clamped, 1 - clamped];
        } else {
          const ratio = (cy - gridRect.top) / gridRect.height;
          const clamped = Math.max(0.15, Math.min(0.85, ratio));
          this._gridRowSizes = [clamped, 1 - clamped];
        }
        this._applyGridSizes();
      };

      const onMouseMove = (e) => move(e.clientX, e.clientY);
      const onTouchMove = (e) => {
        e.preventDefault();
        move(e.touches[0].clientX, e.touches[0].clientY);
      };
      // Capture phase, because the terminal-grid has a bubble-phase touchmove
      // listener that calls stopPropagation() — would otherwise eat our event.
      const touchOpts = { passive: false, capture: true };
      const onEnd = () => {
        handle.classList.remove('active');
        if (overlay) overlay.remove();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onTouchMove, touchOpts);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
        this.terminalPanes.forEach(tp => { if (tp) tp.safeFit(); });
        this.saveTerminalLayout();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onTouchMove, touchOpts);
      document.addEventListener('touchend', onEnd);
      document.addEventListener('touchcancel', onEnd);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      start(e.clientX, e.clientY, false);
    });
    handle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      start(t.clientX, t.clientY, true);
    }, { passive: false });
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
    } else if (filledCount <= 4) {
      // 3-4 panes: 2-column grid
      grid.style.gridTemplateColumns = `${this._gridColSizes[0]}fr ${this._gridColSizes[1]}fr`;
      grid.style.gridTemplateRows = `${this._gridRowSizes[0]}fr ${this._gridRowSizes[1]}fr`;
    } else {
      // 5-6 panes: 3-column grid (use equal columns, resize handles not applicable for 3-col)
      grid.style.gridTemplateColumns = '1fr 1fr 1fr';
      grid.style.gridTemplateRows = `${this._gridRowSizes[0]}fr ${this._gridRowSizes[1]}fr`;
    }

    // Position and show/hide resize handles
    // Column resize only works for 2-col layouts (2-4 panes); 5-6 panes use equal 3-col grid
    if (this._colResizeHandle) {
      const showCol = filledCount >= 2 && filledCount <= 4;
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

    // Flatten submenu items inline for mobile action sheets
    const flatItems = [];
    items.forEach(item => {
      if (item.submenu) {
        flatItems.push({ label: item.label + ':', icon: item.icon, disabled: true });
        item.submenu.forEach(sub => {
          flatItems.push({ ...sub, label: '  ' + sub.label, icon: '&#183;' });
        });
      } else {
        flatItems.push(item);
      }
    });

    // Build items HTML
    const container = this.els.actionSheetItems;
    container.innerHTML = flatItems.map((item, i) => {
      if (item.type === 'sep') return '<div class="action-sheet-sep"></div>';
      const cls = ['action-sheet-item'];
      if (item.danger) cls.push('as-danger');
      if (item.check) cls.push('as-checked');
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
      const item = flatItems[idx];
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
   * "More" tab menu - shows action sheet with utility actions.
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
    container.innerHTML = items.map((item, idx) => {
      if (item.type === 'sep') {
        if (item.label) return `<div class="context-menu-sep"><span class="ctx-sep-label">${item.label}</span></div>`;
        return '<div class="context-menu-sep"></div>';
      }
      const cls = ['context-menu-item'];
      if (item.danger) cls.push('ctx-danger');
      if (item.className) cls.push(item.className);
      if (item.check) cls.push('ctx-checked');
      if (item.submenu) cls.push('ctx-has-submenu');
      const disabledAttr = item.disabled ? ' disabled' : '';
      const checkMark = item.check !== undefined ? `<span class="ctx-check">${item.check ? '&#10003;' : ''}</span>` : '';
      const hint = item.hint ? `<span class="ctx-hint">${item.hint}</span>` : '';
      const arrow = item.submenu ? '<span class="ctx-arrow">&#9656;</span>' : '';
      // Build submenu HTML if present
      let submenuHtml = '';
      if (item.submenu) {
        submenuHtml = `<div class="ctx-submenu" data-parent-idx="${idx}">` +
          item.submenu.map((sub, si) => {
            const sCls = ['context-menu-item'];
            if (sub.check) sCls.push('ctx-checked');
            if (sub.danger) sCls.push('ctx-danger');
            const sCheck = sub.check !== undefined ? `<span class="ctx-check">${sub.check ? '&#10003;' : ''}</span>` : '';
            return `<button class="${sCls.join(' ')}" data-sub-idx="${si}">
              ${sub.label}${sCheck}
            </button>`;
          }).join('') + '</div>';
      }
      return `<div class="ctx-item-wrapper" data-idx="${idx}"><button class="${cls.join(' ')}"${disabledAttr} data-action="${item.label}">
        <span class="ctx-icon">${item.icon || ''}</span>${item.label}${hint}${checkMark}${arrow}
      </button>${submenuHtml}</div>`;
    }).join('');

    // Helper: position a submenu (position: fixed) next to its parent wrapper
    const positionSubmenu = (wrapper, subEl) => {
      const wrapperRect = wrapper.getBoundingClientRect();
      // Try right side first
      let left = wrapperRect.right + 2;
      let top = wrapperRect.top;
      // Show briefly to measure
      subEl.style.left = '-9999px';
      subEl.style.top = '0';
      subEl.classList.add('ctx-submenu-visible');
      const subRect = subEl.getBoundingClientRect();
      // Flip left if overflows right edge
      if (left + subRect.width > window.innerWidth - 8) {
        left = wrapperRect.left - subRect.width - 2;
      }
      // Clamp vertically
      if (top + subRect.height > window.innerHeight - 8) {
        top = window.innerHeight - subRect.height - 8;
      }
      top = Math.max(4, top);
      left = Math.max(4, left);
      subEl.style.left = left + 'px';
      subEl.style.top = top + 'px';
    };

    // Helper: hide all submenus
    const hideAllSubmenus = () => {
      container.querySelectorAll('.ctx-submenu').forEach(s => {
        s.classList.remove('ctx-submenu-visible');
      });
    };

    // Shared close-delay timer - gives the mouse time to cross the gap
    // between the parent wrapper and the fixed-position submenu
    let submenuCloseTimer = null;
    const cancelClose = () => { clearTimeout(submenuCloseTimer); submenuCloseTimer = null; };
    const scheduleClose = (subEl) => {
      cancelClose();
      submenuCloseTimer = setTimeout(() => {
        subEl.classList.remove('ctx-submenu-visible');
      }, 120); // 120ms grace period to cross the gap
    };

    // Bind click handlers for regular items
    container.querySelectorAll('.ctx-item-wrapper').forEach(wrapper => {
      const idx = parseInt(wrapper.dataset.idx);
      const item = items[idx];
      if (!item || item.type === 'sep') return;

      if (item.submenu) {
        const subEl = wrapper.querySelector('.ctx-submenu');
        const parentBtn = wrapper.querySelector(':scope > .context-menu-item');

        // Show submenu on hover (desktop) - uses fixed positioning to escape overflow
        wrapper.addEventListener('mouseenter', () => {
          cancelClose(); // cancel any pending close from a prior submenu
          hideAllSubmenus();
          if (subEl) positionSubmenu(wrapper, subEl);
        });
        wrapper.addEventListener('mouseleave', () => {
          if (subEl) scheduleClose(subEl);
        });

        // Keep submenu open while mouse is inside it
        if (subEl) {
          subEl.addEventListener('mouseenter', cancelClose);
          subEl.addEventListener('mouseleave', () => scheduleClose(subEl));
        }

        // Click on parent toggles submenu (for touch / accessibility)
        if (parentBtn) {
          parentBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (subEl) {
              const isVisible = subEl.classList.contains('ctx-submenu-visible');
              hideAllSubmenus();
              if (!isVisible) positionSubmenu(wrapper, subEl);
            }
          });
        }

        // Bind submenu item clicks
        wrapper.querySelectorAll('.ctx-submenu .context-menu-item').forEach(btn => {
          const si = parseInt(btn.dataset.subIdx);
          const sub = item.submenu[si];
          if (sub && sub.action) {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              this.hideContextMenu();
              sub.action();
            });
          }
        });
      } else if (item.action && !item.disabled) {
        const btn = wrapper.querySelector('.context-menu-item');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hideContextMenu();
          item.action();
        });
        // When hovering a non-submenu item, hide any open submenus
        wrapper.addEventListener('mouseenter', () => { cancelClose(); hideAllSubmenus(); });
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

    // Add pane indicator dots (mobile)
    if (window.innerWidth <= 768 && strip) {
      const activePaneIndices = activePanes.map(p => p.idx);
      if (activePaneIndices.length > 1) {
        let activeSlot = this._activeTerminalSlot;
        // Find mobile-active pane if activeSlot not set
        if (activeSlot === null || activeSlot === undefined) {
          for (let i = 0; i < CWMApp.MAX_PANES; i++) {
            const el = document.getElementById(`term-pane-${i}`);
            if (el && el.classList.contains('mobile-active')) { activeSlot = i; break; }
          }
        }
        let dotsHtml = '<div class="terminal-pane-indicator">';
        activePaneIndices.forEach(idx => {
          dotsHtml += `<span class="indicator-dot${idx === activeSlot ? ' active' : ''}"></span>`;
        });
        dotsHtml += '</div>';
        strip.insertAdjacentHTML('beforeend', dotsHtml);
      }
    }

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
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
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

    // Refit the terminal after switching (safeFit guards against hidden panes)
    const tp = this.terminalPanes[slotIdx];
    if (tp) {
      requestAnimationFrame(() => {
        tp.safeFit();
      });
    }

    // Reset keyboard toggle button to match new pane's input mode
    if (tp && tp._isMobile && tp._isMobile()) {
      const isTypeMode = !!tp._mobileTypeMode;
      document.querySelectorAll('.toolbar-keyboard').forEach(kb => {
        kb.classList.toggle('toolbar-active', isTypeMode);
        kb.textContent = isTypeMode ? '\u2328 Typing' : '\u2328 Type';
      });
    }

    // Update pane indicator dots
    if (this.els.terminalTabStrip) {
      const activePanes = this.terminalPanes.map((tp, i) => tp ? i : -1).filter(i => i !== -1);
      const dots = this.els.terminalTabStrip.querySelectorAll('.indicator-dot');
      dots.forEach((dot, i) => {
        dot.classList.toggle('active', activePanes[i] === slotIdx);
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
      this.els.docsWorkspaceName.textContent = ws ? ws.name : 'No project selected';
    }

    if (!docs || docs.raw === null) {
      // Empty state
      if (this.els.docsNotesList) this.els.docsNotesList.innerHTML = '<div class="docs-empty">No notes yet. Click + to add one.</div>';
      if (this.els.docsGoalsList) this.els.docsGoalsList.innerHTML = '<div class="docs-empty">No goals yet. Click + to add one.</div>';
      if (this.els.docsTasksList) this.els.docsTasksList.innerHTML = '<div class="docs-empty">No tasks yet. Click + to add one.</div>';
      if (this.els.docsRoadmapList) this.els.docsRoadmapList.innerHTML = '<div class="docs-empty">No milestones yet. Click + to add one.</div>';
      if (this.els.docsRulesList) this.els.docsRulesList.innerHTML = '<div class="docs-empty">No rules yet. Click + to add one.</div>';
      if (this.els.docsNotesCount) this.els.docsNotesCount.textContent = '0';
      if (this.els.docsGoalsCount) this.els.docsGoalsCount.textContent = '0';
      if (this.els.docsTasksCount) this.els.docsTasksCount.textContent = '0';
      if (this.els.docsRoadmapCount) this.els.docsRoadmapCount.textContent = '0';
      if (this.els.docsRulesCount) this.els.docsRulesCount.textContent = '0';
      if (this.els.docsRawEditor) this.els.docsRawEditor.value = '';
      return;
    }

    // Counts
    if (this.els.docsNotesCount) this.els.docsNotesCount.textContent = (docs.notes || []).length;
    if (this.els.docsGoalsCount) this.els.docsGoalsCount.textContent = (docs.goals || []).length;
    if (this.els.docsTasksCount) this.els.docsTasksCount.textContent = (docs.tasks || []).length;
    if (this.els.docsRoadmapCount) this.els.docsRoadmapCount.textContent = (docs.roadmap || []).length;
    if (this.els.docsRulesCount) this.els.docsRulesCount.textContent = (docs.rules || []).length;

    // Notes — built with DOM APIs to support pin buttons safely (no user HTML injected)
    if (this.els.docsNotesList) {
      const notes = docs.notes || [];
      while (this.els.docsNotesList.firstChild) {
        this.els.docsNotesList.removeChild(this.els.docsNotesList.firstChild);
      }
      if (notes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'docs-empty';
        empty.textContent = 'No notes yet. Click + to add one.';
        this.els.docsNotesList.appendChild(empty);
      } else {
        notes.forEach((n, noteIndex) => {
          const noteRow = document.createElement('div');
          noteRow.className = 'docs-item';
          noteRow.dataset.index = noteIndex;

          const timeSpan = document.createElement('span');
          timeSpan.className = 'docs-note-time';
          timeSpan.textContent = n.timestamp || '';
          noteRow.appendChild(timeSpan);

          const textSpan = document.createElement('span');
          textSpan.className = 'docs-note-text';
          textSpan.textContent = n.text;
          noteRow.appendChild(textSpan);

          const pinBtn = document.createElement('button');
          pinBtn.className = 'doc-pin-btn btn btn-ghost btn-icon btn-sm';
          pinBtn.textContent = '📌';
          pinBtn.title = 'Pin to focused terminal session';
          pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleNotePin(noteIndex, pinBtn);
          });
          noteRow.appendChild(pinBtn);

          const delBtn = document.createElement('button');
          delBtn.className = 'docs-item-delete btn btn-ghost btn-icon btn-sm';
          delBtn.dataset.section = 'notes';
          delBtn.dataset.index = noteIndex;
          delBtn.title = 'Remove';
          delBtn.textContent = '×';
          noteRow.appendChild(delBtn);

          this.els.docsNotesList.appendChild(noteRow);
        });
      }
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

    // Roadmap
    if (this.els.docsRoadmapList) {
      const statusLabel = { planned: 'Planned', active: 'Active', done: 'Done' };
      const statusClass = { planned: 'roadmap-planned', active: 'roadmap-active', done: 'roadmap-done' };
      this.els.docsRoadmapList.innerHTML = (docs.roadmap || []).length > 0
        ? (docs.roadmap || []).map((r, i) => `
          <div class="docs-item docs-roadmap-item ${statusClass[r.status] || 'roadmap-planned'}" data-index="${i}">
            <button class="roadmap-status-dot" data-section="roadmap" data-index="${i}" title="Click to cycle: Planned > Active > Done">
              <span class="roadmap-dot"></span>
            </button>
            <span class="docs-item-text">${this.escapeHtml(r.text)}</span>
            <span class="roadmap-status-label">${statusLabel[r.status] || 'Planned'}</span>
            <button class="docs-item-delete btn btn-ghost btn-icon btn-sm" data-section="roadmap" data-index="${i}" title="Remove">&times;</button>
          </div>`).join('')
        : '<div class="docs-empty">No milestones yet. Click + to add one.</div>';
    }

    // Rules
    if (this.els.docsRulesList) {
      const rules = docs.rules || [];
      this.els.docsRulesList.innerHTML = rules.length > 0
        ? rules.map((r, i) => `
          <div class="docs-item docs-rule-item" data-index="${i}">
            <span class="docs-rule-icon">&#9888;</span>
            <span class="docs-item-text">${this.escapeHtml(r.text)}</span>
            <button class="docs-item-delete btn btn-ghost btn-icon btn-sm" data-section="rules" data-index="${i}" title="Remove">&times;</button>
          </div>`).join('')
        : '<div class="docs-empty">No rules yet. Click + to add one.</div>';
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

      // Bind roadmap status dot clicks (cycle planned > active > done)
      this.els.docsPanel.querySelectorAll('.roadmap-status-dot').forEach(dot => {
        dot.addEventListener('click', () => this.toggleDocsItem(dot.dataset.section, parseInt(dot.dataset.index)));
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
            else if (parent.id.includes('rules')) section = 'rules';
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
      this.showToast('Select a project first', 'warning');
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

  /**
   * Toggle a pinned note on the currently focused terminal pane session.
   * @param {number} noteIndex - 0-based index of the note in the workspace docs.notes array
   * @param {HTMLButtonElement} buttonEl - The pin button element to update visually
   */
  async _toggleNotePin(noteIndex, buttonEl) {
    const slot = this._activeTerminalSlot;
    const tp = (slot !== null && slot !== undefined) ? this.terminalPanes[slot] : null;
    if (!tp || !tp.sessionId) {
      this.showToast('Focus a terminal pane first', 'error');
      return;
    }
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    const isPinned = buttonEl.classList.contains('pinned');
    const action = isPinned ? 'unpin' : 'pin';
    await this.api('POST', `/api/workspaces/${ws.id}/pinned-notes`, {
      sessionId: tp.sessionId,
      noteIndex,
      action
    });
    buttonEl.classList.toggle('pinned', !isPinned);
    await this._refreshPanePin(slot);
  }

  /**
   * Refresh the pinned-notes badge on a terminal pane header.
   * Shows/hides the badge button and updates the count label.
   * @param {number} slotIdx - Terminal pane slot index (0-based)
   */
  async _refreshPanePin(slotIdx) {
    const tp = this.terminalPanes[slotIdx];
    if (!tp || !tp.sessionId) return;
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    const data = await this.api('GET', `/api/workspaces/${ws.id}/pinned-notes`);
    const pins = data[tp.sessionId] || [];
    const paneEl = document.getElementById(`term-pane-${slotIdx}`);
    if (!paneEl) return;
    const pinDocBtn = paneEl.querySelector('.terminal-pane-pinnedoc');
    if (!pinDocBtn) return;
    pinDocBtn.hidden = pins.length === 0;
    const countEl = pinDocBtn.querySelector('.pane-pin-count');
    if (countEl) countEl.textContent = pins.length > 0 ? pins.length : '';
  }


  /* ═══════════════════════════════════════════════════════════
     TD ISSUES — docs panel integration
     github.com/marcus/td
     ═══════════════════════════════════════════════════════════ */

  /**
   * Load td status and issues for the active workspace.
   * Shows/hides the td section and renders issues or setup prompt.
   */
  async loadTdIssues() {
    if (!this.els.docsTdSection) return;

    // Respect global td toggle
    if (!this.getSetting('enableTd')) {
      this.els.docsTdSection.hidden = true;
      return;
    }

    const ws = this.state.activeWorkspace;
    if (!ws) {
      this.els.docsTdSection.hidden = true;
      return;
    }

    // Show the section now that we have a workspace
    this.els.docsTdSection.hidden = false;

    try {
      const status = await this.api('GET', `/api/workspaces/${ws.id}/td/status`);

      if (!status.available) {
        this._renderTdSetup('td is not installed. Install it from github.com/marcus/td', { showSetdir: false, showInit: false });
        return;
      }

      if (!status.repoDir) {
        this._renderTdSetup('No project directory configured for this workspace.', { showSetdir: true, showInit: false });
        return;
      }

      if (!status.initialized) {
        this._renderTdSetup('td not initialized in ' + status.repoDir, { showSetdir: true, showInit: true });
        return;
      }

      // td is ready — hide setup bar and load issues
      if (this.els.docsTdSetupBar) this.els.docsTdSetupBar.hidden = true;
      await this._fetchAndRenderTdIssues(ws.id);

    } catch (err) {
      if (this.els.docsTdList) this.els.docsTdList.textContent = 'Error loading td status: ' + (err.message || err);
    }

    this._wireTdEvents();
  }

  /** Show the td setup bar with a message. */
  _renderTdSetup(msg, { showSetdir = true, showInit = false } = {}) {
    if (this.els.docsTdList) this.els.docsTdList.textContent = 'td not configured for this project.';
    if (this.els.docsTdCount) this.els.docsTdCount.textContent = '0';
    if (this.els.docsTdSetupBar) this.els.docsTdSetupBar.hidden = false;
    if (this.els.docsTdSetupMsg) this.els.docsTdSetupMsg.textContent = msg;
    if (this.els.docsTdInitBtn) this.els.docsTdInitBtn.hidden = !showInit;
    if (this.els.docsTdSetdirBtn) this.els.docsTdSetdirBtn.hidden = !showSetdir;
  }

  /** Fetch and render td issues for the workspace. */
  async _fetchAndRenderTdIssues(workspaceId) {
    if (this.els.docsTdList) this.els.docsTdList.textContent = 'Loading...';
    try {
      const data = await this.api('GET', `/api/workspaces/${workspaceId}/td/issues`);
      const issues = data.issues || [];
      this._tdIssuesCache = issues;
      this._renderTdIssues(issues);
    } catch (err) {
      if (this.els.docsTdList) this.els.docsTdList.textContent = 'Failed to load issues: ' + (err.message || err);
    }
  }

  /** Render td issues list using DOM (not innerHTML) for XSS safety. */
  _renderTdIssues(issues) {
    if (this.els.docsTdCount) this.els.docsTdCount.textContent = issues.length;
    if (!this.els.docsTdList) return;

    // Clear existing content safely
    while (this.els.docsTdList.firstChild) {
      this.els.docsTdList.removeChild(this.els.docsTdList.firstChild);
    }

    if (issues.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'docs-empty';
      empty.textContent = 'No open issues. Click + to create one.';
      this.els.docsTdList.appendChild(empty);
      return;
    }

    const statusLabel = { open: 'Open', in_progress: 'In Progress', in_review: 'In Review', blocked: 'Blocked', closed: 'Closed' };

    for (const issue of issues) {
      const status = issue.status || 'open';
      const title = issue.title || issue.id;
      const id = issue.id;

      // Row container
      const row = document.createElement('div');
      row.className = 'td-issue-item';
      row.dataset.tdId = id;
      row.style.cursor = 'pointer';
      row.title = 'Click to view details';
      row.addEventListener('click', () => this.openTdIssueModal(id));

      // Status dot
      const dot = document.createElement('span');
      dot.className = 'td-status-dot ' + status;
      dot.title = statusLabel[status] || status;
      row.appendChild(dot);

      // ID label
      const idLabel = document.createElement('span');
      idLabel.className = 'td-issue-id';
      idLabel.textContent = id;
      row.appendChild(idLabel);

      // Title
      const titleEl = document.createElement('span');
      titleEl.className = 'td-issue-title';
      titleEl.textContent = title;
      titleEl.title = title;
      row.appendChild(titleEl);

      // Actions container
      const actions = document.createElement('div');
      actions.className = 'td-issue-actions';

      // Start Worktree button
      const startBtn = document.createElement('button');
      startBtn.className = 'td-start-worktree-btn';
      startBtn.textContent = '→ Worktree';
      startBtn.title = 'Promote to worktree task';
      startBtn.dataset.tdId = id;
      startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._promoteTdIssueToWorktree(id, title);
      });
      actions.appendChild(startBtn);

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'docs-item-delete btn btn-ghost btn-icon btn-sm td-delete-btn';
      deleteBtn.title = 'Delete issue';
      deleteBtn.textContent = '×';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteTdIssue(id);
      });
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      this.els.docsTdList.appendChild(row);
    }
  }

  /**
   * Wire one-time click events for the td section header buttons.
   * Safe to call multiple times — guards with a flag.
   */
  _wireTdEvents() {
    if (this._tdEventsWired) return;
    this._tdEventsWired = true;

    if (this.els.docsTdAddBtn) {
      this.els.docsTdAddBtn.addEventListener('click', () => this._addTdIssue());
    }
    if (this.els.docsTdRefreshBtn) {
      this.els.docsTdRefreshBtn.addEventListener('click', () => {
        const ws = this.state.activeWorkspace;
        if (ws) this._fetchAndRenderTdIssues(ws.id);
      });
    }
    if (this.els.docsTdInitBtn) {
      this.els.docsTdInitBtn.addEventListener('click', () => this._initTd());
    }
    if (this.els.docsTdSetdirBtn) {
      this.els.docsTdSetdirBtn.addEventListener('click', () => this._setTdRepoDir());
    }
  }

  /** Prompt for a new td issue title and create it. */
  async _addTdIssue() {
    const ws = this.state.activeWorkspace;
    if (!ws) { this.showToast('Select a project first', 'warning'); return; }

    const title = prompt('New td issue title:');
    if (!title || !title.trim()) return;

    try {
      await this.api('POST', `/api/workspaces/${ws.id}/td/issues`, { title: title.trim() });
      this.showToast('td issue created', 'success');
      await this._fetchAndRenderTdIssues(ws.id);
    } catch (err) {
      this.showToast(err.message || 'Failed to create td issue', 'error');
    }
  }

  /** Delete a td issue after confirmation. */
  async _deleteTdIssue(issueId) {
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    if (!confirm('Delete td issue ' + issueId + '?')) return;
    try {
      await this.api('DELETE', `/api/workspaces/${ws.id}/td/issues/${issueId}`);
      this.showToast(issueId + ' deleted', 'success');
      await this._fetchAndRenderTdIssues(ws.id);
    } catch (err) {
      this.showToast(err.message || 'Failed to delete issue', 'error');
    }
  }

  /** Run `td init` in the workspace repo directory. */
  async _initTd() {
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    try {
      const result = await this.api('POST', `/api/workspaces/${ws.id}/td/init`, {});
      this.showToast('td initialized in ' + result.repoDir, 'success');
      await this.loadTdIssues();
    } catch (err) {
      this.showToast(err.message || 'Failed to initialize td', 'error');
    }
  }

  /** Prompt the user to set/override the repo directory for td. */
  async _setTdRepoDir() {
    const ws = this.state.activeWorkspace;
    if (!ws) return;
    const dir = prompt('Enter the absolute path to the project directory (where .todos/ should live):');
    if (!dir || !dir.trim()) return;
    try {
      await this.api('PUT', `/api/workspaces/${ws.id}/td/repodir`, { repoDir: dir.trim() });
      this.showToast('Project directory saved', 'success');
      await this.loadTdIssues();
    } catch (err) {
      this.showToast(err.message || 'Failed to set directory', 'error');
    }
  }

  /**
   * Phase 2: Promote a td issue to a worktree task.
   * Fetches full context, pre-populates the New Task dialog, and after
   * the task is created marks the td issue as in_progress.
   */
  async _promoteTdIssueToWorktree(issueId, issueTitle) {
    const ws = this.state.activeWorkspace;
    if (!ws) { this.showToast('Select a project first', 'warning'); return; }

    this.showToast('Loading context for ' + issueId + '...', 'info');

    let context = '';
    let repoDir = null;
    try {
      const data = await this.api('GET', `/api/workspaces/${ws.id}/td/issues/${issueId}/context`);
      context = data.context || '';
      repoDir = data.repoDir || null;
    } catch (_err) {
      this.showToast('Could not load td context, opening dialog anyway', 'warning');
    }

    // Open the existing New Task dialog pre-populated with td issue data
    this.openNewTaskDialog(ws.id);

    // Pre-populate after a tick so the dialog has rendered
    setTimeout(() => {
      if (this.els.newTaskName) {
        this.els.newTaskName.value = issueTitle || issueId;
        this.updateBranchPreview();
      }
      if (this.els.newTaskDescription) {
        const desc = context
          ? 'td:' + issueId + '\n\n' + context
          : 'td:' + issueId + '\n\n' + issueTitle;
        this.els.newTaskDescription.value = desc;
      }
      if (repoDir && this.els.newTaskDir) {
        const opts = Array.from(this.els.newTaskDir.options);
        const match = opts.find(o => o.value === repoDir);
        if (match) {
          this.els.newTaskDir.value = repoDir;
        } else {
          this.els.newTaskDir.value = '__custom__';
          if (this.els.newTaskDirCustom) {
            this.els.newTaskDirCustom.value = repoDir;
            this.els.newTaskDirCustom.hidden = false;
          }
        }
      }
    }, 50);

    // Store so submitNewTask() can mark the td issue in_progress after creation
    this._pendingTdIssueId = issueId;
    this._pendingTdWorkspaceId = ws.id;
  }

  /* ═══════════════════════════════════════════════════════════
     TD ISSUE DETAIL MODAL
     ═══════════════════════════════════════════════════════════ */

  /**
   * Open the td issue detail modal for a given issue ID.
   * Fetches context (which includes show details) from the server.
   * @param {string} issueId
   */
  async openTdIssueModal(issueId) {
    const ws = this.state.activeWorkspace;
    if (!ws || !this.els.tdIssueModalOverlay) return;

    // Reset and show modal immediately
    if (this.els.tdIssueModalId) this.els.tdIssueModalId.textContent = issueId;
    if (this.els.tdIssueModalTitle) this.els.tdIssueModalTitle.textContent = issueId;
    if (this.els.tdIssueModalBody) {
      while (this.els.tdIssueModalBody.firstChild) {
        this.els.tdIssueModalBody.removeChild(this.els.tdIssueModalBody.firstChild);
      }
      const loading = document.createElement('div');
      loading.className = 'td-issue-modal-loading';
      loading.textContent = 'Loading issue details…';
      this.els.tdIssueModalBody.appendChild(loading);
    }
    this.els.tdIssueModalOverlay.hidden = false;

    // Remember which issue is open (for promote button)
    this._tdModalIssueId = issueId;
    this._tdModalWorkspaceId = ws.id;

    // Wire modal buttons once
    if (!this._tdModalEventsWired) {
      this._tdModalEventsWired = true;

      if (this.els.tdIssueModalClose) {
        this.els.tdIssueModalClose.addEventListener('click', () => this.closeTdIssueModal());
      }
      if (this.els.tdIssueModalCloseBtn) {
        this.els.tdIssueModalCloseBtn.addEventListener('click', () => this.closeTdIssueModal());
      }
      if (this.els.tdIssueModalOverlay) {
        this.els.tdIssueModalOverlay.addEventListener('click', (e) => {
          if (e.target === this.els.tdIssueModalOverlay) this.closeTdIssueModal();
        });
      }
      if (this.els.tdIssueModalPromoteBtn) {
        this.els.tdIssueModalPromoteBtn.addEventListener('click', () => {
          const id = this._tdModalIssueId;
          const title = (this.els.tdIssueModalTitle && this.els.tdIssueModalTitle.textContent !== id)
            ? this.els.tdIssueModalTitle.textContent
            : id;
          this.closeTdIssueModal();
          if (id) this._promoteTdIssueToWorktree(id, title);
        });
      }
    }

    // Fetch combined show + context from the context endpoint
    try {
      const data = await this.api('GET', `/api/workspaces/${ws.id}/td/issues/${issueId}/context`);
      this._renderTdIssueModal(issueId, data.details, data.context || '');
    } catch (err) {
      if (this.els.tdIssueModalBody) {
        while (this.els.tdIssueModalBody.firstChild) {
          this.els.tdIssueModalBody.removeChild(this.els.tdIssueModalBody.firstChild);
        }
        const errEl = document.createElement('div');
        errEl.className = 'td-issue-modal-loading';
        errEl.textContent = 'Failed to load details: ' + (err.message || err);
        this.els.tdIssueModalBody.appendChild(errEl);
      }
    }
  }

  /**
   * Render the td issue modal body with parsed details + context.
   * @param {string} issueId
   * @param {Object|null} details  - result of td show --json (or { raw: string })
   * @param {string} contextText   - result of td context
   */
  _renderTdIssueModal(issueId, details, contextText) {
    const body = this.els.tdIssueModalBody;
    if (!body) return;

    // Clear
    while (body.firstChild) body.removeChild(body.firstChild);

    // Update title from details
    const title = details?.title || issueId;
    if (this.els.tdIssueModalTitle) this.els.tdIssueModalTitle.textContent = title;

    // Meta row (status / type / priority)
    if (details) {
      const metaData = [
        ['Status', details.status],
        ['Type', details.type],
        ['Priority', details.priority],
      ].filter(([, v]) => v);

      if (metaData.length > 0) {
        const meta = document.createElement('div');
        meta.className = 'td-issue-modal-meta';
        for (const [label, val] of metaData) {
          const item = document.createElement('div');
          item.className = 'td-issue-modal-meta-item';
          const strong = document.createElement('strong');
          strong.textContent = label;
          item.appendChild(strong);
          item.appendChild(document.createTextNode(val));
          meta.appendChild(item);
        }
        body.appendChild(meta);
      }

      // Description / body / raw show output
      const showText = details.raw || details.description || details.body || '';
      if (showText) {
        body.appendChild(this._makeTdModalSection('Details', showText));
      }

      // Log entries (progress, decisions, blockers)
      if (Array.isArray(details.logs) && details.logs.length > 0) {
        const logLines = details.logs.map(l => {
          const ts = l.timestamp ? new Date(l.timestamp).toLocaleString() : '';
          const tag = l.type && l.type !== 'progress' ? `[${l.type}] ` : '';
          return ts ? `${ts}  ${tag}${l.message}` : `${tag}${l.message}`;
        }).join('\n\n');
        body.appendChild(this._makeTdModalSection('Log', logLines));
      }
    }

    // Context (handoffs, decisions, log)
    if (contextText) {
      body.appendChild(this._makeTdModalSection('Context & History', contextText));
    }

    if (!body.firstChild) {
      const empty = document.createElement('div');
      empty.className = 'td-issue-modal-loading';
      empty.textContent = 'No details available.';
      body.appendChild(empty);
    }
  }

  /** Build a labelled pre-formatted content section for the modal. */
  _makeTdModalSection(title, content) {
    const section = document.createElement('div');
    section.className = 'td-issue-modal-section';

    const titleEl = document.createElement('div');
    titleEl.className = 'td-issue-modal-section-title';
    titleEl.textContent = title;
    section.appendChild(titleEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'td-issue-modal-content';
    contentEl.textContent = content;
    section.appendChild(contentEl);

    return section;
  }

  /** Close and reset the td issue detail modal. */
  closeTdIssueModal() {
    if (this.els.tdIssueModalOverlay) this.els.tdIssueModalOverlay.hidden = true;
    this._tdModalIssueId = null;
    this._tdModalWorkspaceId = null;
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

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
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
            // Sync to project sessions via Claude UUID
            const claudeId = (s && s.resumeSessionId) || (as && as.resumeSessionId);
            if (claudeId) this.syncSessionTitle(claudeId, newName);
          } else {
            // Project session - sync everywhere (localStorage + any linked workspace sessions)
            this.syncSessionTitle(sessionId, newName);
          }
          // Sync terminal pane titles if this session is open in a terminal
          for (let i = 0; i < this.terminalPanes.length; i++) {
            const tp = this.terminalPanes[i];
            if (tp && tp.sessionId === sessionId) {
              tp.sessionName = newName;
              const paneEl = document.getElementById(`term-pane-${i}`);
              const titleEl = paneEl && paneEl.querySelector('.terminal-pane-title');
              if (titleEl) titleEl.textContent = newName;
            }
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

    // Track mousedown inside input - if user started a click/drag inside,
    // don't close on blur when they release outside the input
    let mouseDownInside = false;
    input.addEventListener('mousedown', () => { mouseDownInside = true; });
    document.addEventListener('mouseup', () => {
      if (mouseDownInside) {
        mouseDownInside = false;
        setTimeout(() => { if (!committed) input.focus(); }, 0);
      }
    }, { once: false, capture: true });

    input.addEventListener('blur', () => {
      if (mouseDownInside) return;
      setTimeout(() => {
        if (!committed && document.activeElement !== input) {
          commit();
        }
      }, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = currentName; commit(); }
    });
  }

  /**
   * Inline rename for terminal pane headers.
   * Same UX pattern as startInlineRename but also updates the
   * TerminalPane instance and syncs globally.
   */
  startTerminalPaneRename(nameEl, slotIdx, sessionId, isStoreSession) {
    const currentName = nameEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = currentName;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          if (isStoreSession) {
            await this.api('PUT', `/api/sessions/${sessionId}`, { name: newName });
            // Update local state
            const s = this.state.sessions && this.state.sessions.find(s => s.id === sessionId);
            if (s) s.name = newName;
            const as = this.state.allSessions && this.state.allSessions.find(s => s.id === sessionId);
            if (as && as !== s) as.name = newName;
            // Sync globally via Claude UUID
            const claudeId = (s && s.resumeSessionId) || (as && as.resumeSessionId);
            if (claudeId) this.syncSessionTitle(claudeId, newName);
          } else {
            // Project session - sessionId IS the Claude UUID
            this.syncSessionTitle(sessionId, newName);
          }

          // Always persist to localStorage keyed by the terminal's sessionId
          // so ad-hoc sessions (not in store, not in projects) keep their names
          this.syncSessionTitle(sessionId, newName);

          // Update TerminalPane instance
          const tp = this.terminalPanes[slotIdx];
          if (tp) tp.sessionName = newName;

          nameEl.textContent = newName;
          nameEl.classList.add('rename-flash');
          setTimeout(() => nameEl.classList.remove('rename-flash'), 600);

          // Refresh sidebar and project sessions view
          this.renderWorkspaces();
          this.renderProjects();
        } catch (err) {
          nameEl.textContent = currentName;
          this.showToast('Rename failed: ' + (err.message || ''), 'error');
        }
      } else {
        nameEl.textContent = currentName;
      }
    };

    // Track mousedown inside input - if user started a click/drag inside,
    // don't close on blur when they release outside the input
    let mouseDownInside = false;
    input.addEventListener('mousedown', () => { mouseDownInside = true; });
    document.addEventListener('mouseup', () => {
      if (mouseDownInside) {
        mouseDownInside = false;
        setTimeout(() => { if (!committed) input.focus(); }, 0);
      }
    }, { once: false, capture: true });

    input.addEventListener('blur', () => {
      if (mouseDownInside) return;
      setTimeout(() => {
        if (!committed && document.activeElement !== input) {
          commit();
        }
      }, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = currentName; commit(); }
    });
  }


  /* ═══════════════════════════════════════════════════════════
     PHASE 4: TERMINAL TAB GROUPS
     ═══════════════════════════════════════════════════════════ */

  async initTerminalGroups() {
    // Load layout from server
    this._tabGroups = [];
    this._tabFolders = []; // Tab group folders: { id, name, color, collapsed }
    this._activeGroupId = null;
    this._layoutSaveTimer = null;
    this._layoutRestored = false;

    // Load saved layout (must complete before SSE or other init touches panes)
    await this.loadTerminalLayout();
  }

  async loadTerminalLayout() {
    try {
      const layout = await this.api('GET', '/api/layout');
      if (layout && layout.tabGroups && layout.tabGroups.length > 0) {
        this._tabGroups = layout.tabGroups;
        this._tabFolders = layout.tabFolders || [];
        this._activeGroupId = layout.activeGroupId || this._tabGroups[0].id;
      } else {
        // Create default group
        this._tabGroups = [{ id: 'tg_default', name: 'Main', panes: [] }];
        this._tabFolders = [];
        this._activeGroupId = 'tg_default';
      }
    } catch (_) {
      this._tabGroups = [{ id: 'tg_default', name: 'Main', panes: [] }];
      this._tabFolders = [];
      this._activeGroupId = 'tg_default';
    }
    this.renderTerminalGroupTabs();

    // Restore panes for the active group on initial load
    // Without this, the layout loads but panes show "Drop a session here"
    const group = this._tabGroups.find(g => g.id === this._activeGroupId);
    if (group && group.panes && group.panes.length > 0) {
      group.panes.forEach(p => {
        if (p.sessionId && !this.terminalPanes[p.slot]) {
          // Plan 19-01 PTY-07: merge the persisted provider into spawnOpts so
          // openTerminalInPane's explicit-provider branch sets paneEl.dataset.provider
          // correctly even when state.allSessions is still empty. Layouts saved
          // before this plan landed lack p.provider; the defensive default
          // inside openTerminalInPane handles that case (lookup-then-claude).
          const opts = { ...(p.spawnOpts || {}) };
          if (p.provider && !opts.provider) opts.provider = p.provider;
          this.openTerminalInPane(p.slot, p.sessionId, p.sessionName || 'Terminal', opts);
          if (p.viewType) {
            setTimeout(() => this.openViewInPane(p.slot, p.viewType, p.viewData || {}), 100);
          }
        }
      });
    }

    // Restore split ratios for the active tab group
    if (group && group.gridColSizes) {
      this._gridColSizes = [...group.gridColSizes];
    }
    if (group && group.gridRowSizes) {
      this._gridRowSizes = [...group.gridRowSizes];
    }
    this._layoutRestored = true;
  }

  /**
   * Render a single tab button HTML string for a tab group.
   * @param {Object} g - Tab group object { id, name, panes, folderId }
   * @returns {string} HTML string for the tab button
   */
  _renderTabButtonHtml(g) {
    const isActive = g.id === this._activeGroupId;
    const paneCount = g.panes ? g.panes.length : 0;
    const hasActive = g.panes && g.panes.some(p => {
      const tp = this.terminalPanes.find((_, i) => p.slot === i);
      return tp !== null;
    });
    const tabColor = this.getTabColor(g.id);
    return `<button class="terminal-group-tab${isActive ? ' active' : ''}"
      data-group-id="${g.id}"
      style="--tab-color:var(--${tabColor})">
      <span class="terminal-group-tab-dot${hasActive ? '' : ' inactive'}"></span>
      <span class="terminal-group-tab-name">${this.escapeHtml(g.name)}</span>
      ${paneCount > 0 ? `<span class="terminal-group-tab-count">${paneCount}</span>` : ''}
      <span class="terminal-group-tab-close" data-group-id="${g.id}" title="Close tab">&times;</span>
    </button>`;
  }

  renderTerminalGroupTabs() {
    if (!this.els.terminalGroupsTabs) return;

    // Available folder colors - maps to Catppuccin CSS vars
    const FOLDER_COLORS = ['mauve', 'blue', 'green', 'peach', 'red', 'pink', 'teal', 'yellow'];

    // Build HTML: folders first (with their tabs), then ungrouped tabs
    let html = '';

    // Render each folder and its tabs
    for (const folder of this._tabFolders) {
      const folderTabs = this._tabGroups.filter(g => g.folderId === folder.id);
      const totalPanes = folderTabs.reduce((sum, g) => sum + (g.panes ? g.panes.length : 0), 0);
      const color = folder.color || 'mauve';

      html += `<div class="tab-folder${folder.collapsed ? ' collapsed' : ''}" data-folder-id="${folder.id}">`;
      html += `<button class="tab-folder-header" data-folder-id="${folder.id}" style="--folder-color: var(--${color})">`;
      html += `<span class="tab-folder-chevron">${folder.collapsed ? '&#9656;' : '&#9662;'}</span>`;
      html += `<span class="tab-folder-name">${this.escapeHtml(folder.name)}</span>`;
      if (totalPanes > 0) html += `<span class="tab-folder-count">${totalPanes}</span>`;
      html += `</button>`;

      if (!folder.collapsed) {
        for (const g of folderTabs) {
          html += this._renderTabButtonHtml(g);
        }
      }
      html += `</div>`;
    }

    // Render ungrouped tabs (no folderId)
    const ungrouped = this._tabGroups.filter(g => !g.folderId);
    for (const g of ungrouped) {
      html += this._renderTabButtonHtml(g);
    }

    // Sticky "+" button at the end - stays pinned when tabs overflow
    html += `<button class="terminal-groups-add" id="terminal-groups-add" title="New tab group">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>`;

    this.els.terminalGroupsTabs.innerHTML = html;

    // Bind the "+" button
    const addBtn = this.els.terminalGroupsTabs.querySelector('.terminal-groups-add');
    if (addBtn) addBtn.addEventListener('click', () => this.createTerminalGroup());

    // Bind folder header events
    this.els.terminalGroupsTabs.querySelectorAll('.tab-folder-header').forEach(hdr => {
      const folderId = hdr.dataset.folderId;

      // Click to toggle collapse
      hdr.addEventListener('click', (e) => {
        e.stopPropagation();
        const folder = this._tabFolders.find(f => f.id === folderId);
        if (folder) {
          folder.collapsed = !folder.collapsed;
          this.renderTerminalGroupTabs();
          this.saveTerminalLayout();
        }
      });

      // Right-click context menu on folder header
      hdr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const folder = this._tabFolders.find(f => f.id === folderId);
        if (!folder) return;

        const colorItems = FOLDER_COLORS.map(c => ({
          label: c.charAt(0).toUpperCase() + c.slice(1),
          icon: `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--${c})"></span>`,
          action: () => { folder.color = c; this.renderTerminalGroupTabs(); this.saveTerminalLayout(); },
        }));

        this.showContextMenu([
          { label: 'Rename Group', action: () => {
            const nameEl = hdr.querySelector('.tab-folder-name');
            if (nameEl) this._startInlineFolderRename(nameEl, folderId);
          }},
          { label: 'Color', submenu: colorItems },
          { type: 'sep' },
          { label: 'Ungroup All', action: () => this._ungroupFolder(folderId) },
          { label: 'Delete Group + Tabs', danger: true, action: () => this._deleteFolder(folderId) },
        ], e.clientX, e.clientY);
      });

      // Accept terminal pane drops on folder header - adds to first tab in folder
      hdr.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        const hasTerminal = (types.includes ? types.includes('cwm/terminal-swap') : types.contains && types.contains('cwm/terminal-swap'));
        if (hasTerminal) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          hdr.classList.add('tab-drag-over');
        }
      });
      hdr.addEventListener('dragleave', () => hdr.classList.remove('tab-drag-over'));
      hdr.addEventListener('drop', (e) => {
        e.preventDefault();
        hdr.classList.remove('tab-drag-over');
        const swapSource = e.dataTransfer.getData('cwm/terminal-swap');
        if (swapSource) {
          const srcSlot = parseInt(swapSource, 10);
          const folderTabs = this._tabGroups.filter(g => g.folderId === folderId);
          if (folderTabs.length > 0 && folderTabs[0].id !== this._activeGroupId) {
            this.moveTerminalToGroup(srcSlot, folderTabs[0].id);
          }
        }
      });
    });

    // Bind tab click + drag events
    this.els.terminalGroupsTabs.querySelectorAll('.terminal-group-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTerminalGroup(tab.dataset.groupId));

      // ── Drag-to-reorder tabs ──
      tab.draggable = true;
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/tab-group-id', tab.dataset.groupId);
        e.dataTransfer.effectAllowed = 'move';
        tab.classList.add('tab-dragging');
        // Store dragged tab ID for drag-hold merge (dataTransfer not readable in dragover)
        this._draggedTabGroupId = tab.dataset.groupId;
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('tab-dragging');
        this.els.terminalGroupsTabs.querySelectorAll('.tab-drag-over, .tab-drag-merge').forEach(el => {
          el.classList.remove('tab-drag-over');
          el.classList.remove('tab-drag-merge');
        });
        // Clear drag-hold timer
        clearTimeout(this._dragHoldTimer);
        this._dragHoldTarget = null;
      });
      tab.addEventListener('dragover', (e) => {
        // Accept tab reorder drags and terminal pane move drags
        const types = e.dataTransfer.types;
        const hasTabGroup = (types.includes ? types.includes('text/tab-group-id') : types.contains && types.contains('text/tab-group-id'));
        const hasTerminal = (types.includes ? types.includes('cwm/terminal-swap') : types.contains && types.contains('cwm/terminal-swap'));
        if (hasTabGroup || hasTerminal) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          tab.classList.add('tab-drag-over');

          // Drag-hold timer for tab grouping: hold over another tab for 1s to create a folder
          if (hasTabGroup) {
            const targetId = tab.dataset.groupId;
            if (this._dragHoldTarget !== targetId) {
              // Target changed - reset timer
              clearTimeout(this._dragHoldTimer);
              this._dragHoldTarget = targetId;
              // Show merge indicator after 500ms, complete merge after 1200ms
              this._dragHoldTimer = setTimeout(() => {
                tab.classList.add('tab-drag-merge');
              }, 500);
              this._dragMergeTimer = setTimeout(() => {
                // Merge the tabs into a folder
                // We can't access draggedId from dragover (dataTransfer restricted),
                // so we store it on dragstart and read it here
                const draggedId = this._draggedTabGroupId;
                if (draggedId && draggedId !== targetId) {
                  this._mergeTabsIntoFolder(draggedId, targetId);
                }
                tab.classList.remove('tab-drag-merge');
                this._dragHoldTarget = null;
              }, 1200);
            }
          }
        }
      });
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('tab-drag-over');
        tab.classList.remove('tab-drag-merge');
        // Clear hold timer when leaving the target
        if (this._dragHoldTarget === tab.dataset.groupId) {
          clearTimeout(this._dragHoldTimer);
          clearTimeout(this._dragMergeTimer);
          this._dragHoldTarget = null;
        }
      });
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('tab-drag-over');
        tab.classList.remove('tab-drag-merge');
        // Clear hold timer on drop - normal drop/reorder takes precedence
        clearTimeout(this._dragHoldTimer);
        clearTimeout(this._dragMergeTimer);
        this._dragHoldTarget = null;

        // Handle terminal pane drop - move terminal to this tab group
        const swapSource = e.dataTransfer.getData('cwm/terminal-swap');
        if (swapSource) {
          const srcSlot = parseInt(swapSource, 10);
          const targetGroupId = tab.dataset.groupId;
          if (targetGroupId !== this._activeGroupId) {
            this.moveTerminalToGroup(srcSlot, targetGroupId);
          }
          return;
        }

        // Handle tab reorder
        const draggedId = e.dataTransfer.getData('text/tab-group-id');
        const targetId = tab.dataset.groupId;
        if (draggedId && draggedId !== targetId) {
          this._reorderTabGroup(draggedId, targetId);
        }
      });

      // Double-click to rename
      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const nameEl = tab.querySelector('.terminal-group-tab-name');
        if (nameEl) this.startInlineRenameGroup(nameEl, tab.dataset.groupId);
      });

      // Right-click context menu - includes folder management
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const groupId = tab.dataset.groupId;
        const group = this._tabGroups.find(g => g.id === groupId);
        const groupIdx = this._tabGroups.findIndex(g => g.id === groupId);
        const ctxItems = [
          { label: 'Rename', action: () => {
            const nameEl = tab.querySelector('.terminal-group-tab-name');
            if (nameEl) this.startInlineRenameGroup(nameEl, groupId);
          }},
        ];
        if (groupIdx > 0) {
          ctxItems.push({ label: 'Move Left', icon: '&#9664;', action: () => {
            this._swapTabGroups(groupIdx, groupIdx - 1);
          }});
        }
        if (groupIdx < this._tabGroups.length - 1) {
          ctxItems.push({ label: 'Move Right', icon: '&#9654;', action: () => {
            this._swapTabGroups(groupIdx, groupIdx + 1);
          }});
        }

        // Folder assignment submenu
        ctxItems.push({ type: 'sep' });
        if (group && group.folderId) {
          ctxItems.push({ label: 'Remove from Group', action: () => {
            group.folderId = null;
            this.renderTerminalGroupTabs();
            this.saveTerminalLayout();
          }});
        }
        if (this._tabFolders.length > 0) {
          const folderItems = this._tabFolders
            .filter(f => !group || group.folderId !== f.id)
            .map(f => ({
              label: f.name,
              icon: `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--${f.color || 'mauve'})"></span>`,
              action: () => {
                if (group) group.folderId = f.id;
                this.renderTerminalGroupTabs();
                this.saveTerminalLayout();
              },
            }));
          if (folderItems.length > 0) {
            ctxItems.push({ label: 'Add to Group', submenu: folderItems });
          }
        }
        ctxItems.push({ label: 'New Group from Tab', action: () => {
          this._createFolderFromTab(groupId);
        }});

        ctxItems.push({ type: 'sep' });
        ctxItems.push(
          { label: 'Delete', danger: true, action: () => this.deleteTerminalGroup(groupId) },
        );
        this.showContextMenu(ctxItems, e.clientX, e.clientY);
      });
    });

    // Bind close buttons on tab group tabs
    this.els.terminalGroupsTabs.querySelectorAll('.terminal-group-tab-close').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // Don't switch to the tab
        const groupId = btn.dataset.groupId;
        await this.closeTabGroupWithConfirmation(groupId);
      });
    });
  }

  switchTerminalGroup(groupId) {
    if (groupId === this._activeGroupId) return;

    // Clear any notification badge on the target tab
    const tabBtn = document.querySelector(`.terminal-group-tab[data-group-id="${groupId}"]`);
    if (tabBtn) tabBtn.classList.remove('tab-notify');

    // Save current group's pane state to layout JSON
    this.saveCurrentGroupPanes();

    // ── Cache current group's live TerminalPane instances + DOM ──
    // Instead of disposing, detach the xterm DOM into DocumentFragments
    // so we can reattach instantly when switching back.
    const prevGroupId = this._activeGroupId;
    if (prevGroupId) {
      const cached = { panes: new Array(CWMApp.MAX_PANES).fill(null), domFragments: new Array(CWMApp.MAX_PANES).fill(null) };
      for (let i = 0; i < CWMApp.MAX_PANES; i++) {
        if (this.terminalPanes[i]) {
          cached.panes[i] = this.terminalPanes[i];
          // Detach xterm DOM into a fragment (preserves WebSocket + state)
          const termContainer = document.getElementById(`term-container-${i}`);
          if (termContainer && termContainer.childNodes.length > 0) {
            const frag = document.createDocumentFragment();
            while (termContainer.firstChild) frag.appendChild(termContainer.firstChild);
            cached.domFragments[i] = frag;
          }
        }
        this.terminalPanes[i] = null;
        // Reset pane DOM to empty visual state
        const paneEl = document.getElementById(`term-pane-${i}`);
        if (paneEl) {
          paneEl.classList.add('terminal-pane-empty');
          const header = paneEl.querySelector('.terminal-pane-title');
          if (header) header.textContent = 'Drop a session here';
          const closeBtn = paneEl.querySelector('.terminal-pane-close');
          if (closeBtn) closeBtn.hidden = true;
          const uploadBtnG = paneEl.querySelector('.terminal-pane-upload');
          if (uploadBtnG) uploadBtnG.hidden = true;
        }
      }
      this._groupPaneCache[prevGroupId] = cached;
    }

    this._activeGroupId = groupId;

    // ── Restore this tab group's split ratios (or reset to equal) ──
    const targetGroup = this._tabGroups.find(g => g.id === groupId);
    if (targetGroup && targetGroup.gridColSizes) {
      this._gridColSizes = [...targetGroup.gridColSizes];
    } else {
      this._gridColSizes = [1, 1];
    }
    if (targetGroup && targetGroup.gridRowSizes) {
      this._gridRowSizes = [...targetGroup.gridRowSizes];
    } else {
      this._gridRowSizes = [1, 1];
    }

    // ── Restore target group: try cache first, fall back to fresh connections ──
    const cached = this._groupPaneCache[groupId];
    if (cached) {
      // Reattach cached panes instantly (no reconnection needed)
      for (let i = 0; i < CWMApp.MAX_PANES; i++) {
        if (cached.panes[i]) {
          this.terminalPanes[i] = cached.panes[i];
          const paneEl = document.getElementById(`term-pane-${i}`);
          if (paneEl) {
            // Explicitly unhide -- belt-and-suspenders with updateTerminalGridLayout()
            paneEl.hidden = false;
            paneEl.classList.remove('terminal-pane-empty');
            const titleEl = paneEl.querySelector('.terminal-pane-title');
            if (titleEl) titleEl.textContent = cached.panes[i].sessionName || cached.panes[i].sessionId;
            const closeBtn = paneEl.querySelector('.terminal-pane-close');
            if (closeBtn) closeBtn.hidden = false;
            const uploadBtn = paneEl.querySelector('.terminal-pane-upload');
            if (uploadBtn) uploadBtn.hidden = false;
          }
          // Reattach xterm DOM, or re-render placeholder for disconnected panes
          if (cached.domFragments[i]) {
            const termContainer = document.getElementById(`term-container-${i}`);
            if (termContainer) termContainer.appendChild(cached.domFragments[i]);
          } else if (cached.panes[i].sessionId) {
            // Cached pane had no DOM fragment (was disconnected), reconnect directly
            this.openTerminalInPane(i, cached.panes[i].sessionId, cached.panes[i].sessionName, cached.panes[i].spawnOpts);
          }
        }
      }
      delete this._groupPaneCache[groupId];
      // Recalculate grid layout for restored pane count, then refit.
      // After reattaching cached DOM fragments, force xterm.js to repaint
      // all rows. Moving a <canvas> to a DocumentFragment clears its pixel
      // buffer; xterm's fit() only re-renders when dimensions change, so
      // same-size restores produce blank canvases without an explicit refresh.
      this.updateTerminalGridLayout();
      requestAnimationFrame(() => {
        for (let j = 0; j < CWMApp.MAX_PANES; j++) {
          const tp = this.terminalPanes[j];
          if (tp && tp.term) {
            tp.term.refresh(0, tp.term.rows - 1);
          }
        }
      });
    } else {
      // No cache, create fresh connections (first time opening this group)
      const group = this._tabGroups.find(g => g.id === groupId);
      if (group && group.panes) {
        group.panes.forEach(p => {
          if (p.sessionId && !this.terminalPanes[p.slot]) {
            this.openTerminalInPane(p.slot, p.sessionId, p.sessionName || 'Terminal', p.spawnOpts || {});
          }
        });
      }
    }

    // Always reset grid layout for the new group's pane count.
    // Without this, switching to an empty tab group keeps the
    // previous group's data-panes attribute and pane visibility.
    this.updateTerminalGridLayout();

    this.renderTerminalGroupTabs();

    // Clear notification dot on the now-active tab AFTER render, since
    // renderTerminalGroupTabs() replaces all tab button DOM elements.
    // Without this, the dot could reappear if a stale terminal-idle event
    // fires during the switch and targets the freshly-rendered button.
    const newTabBtn = document.querySelector(`.terminal-group-tab[data-group-id="${groupId}"]`);
    if (newTabBtn) newTabBtn.classList.remove('tab-notify');

    this.saveTerminalLayout();
  }

  saveCurrentGroupPanes() {
    const group = this._tabGroups.find(g => g.id === this._activeGroupId);
    if (!group) return;

    group.panes = [];
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      const tp = this.terminalPanes[i];
      // Save live TerminalPanes for layout restore.
      if (tp && tp.sessionId) {
        const paneEl = document.getElementById('term-pane-' + i);
        const viewType = paneEl?.dataset?.viewType || null;
        const viewData = viewType ? JSON.parse(paneEl?.dataset?.viewData || '{}') : {};
        // Plan 19-01 PTY-07: persist the pane's provider tag explicitly so
        // layout restore is deterministic even when discovery is empty at
        // restore time (e.g., Codex toggled off between save and restore).
        // Without this, openTerminalInPane would fall back to the allSessions
        // lookup which is empty, and the pane would be re-tagged with the
        // v1.1 default — visually mis-rendering Codex panes as Claude.
        const paneProvider = (paneEl && paneEl.dataset && paneEl.dataset.provider) || 'claude'; // gsd:provider-literal-allowed (Phase 18 default)
        group.panes.push({
          slot: i,
          sessionId: tp.sessionId,
          sessionName: tp.sessionName,
          provider: paneProvider,
          spawnOpts: tp.spawnOpts || {},
          viewType,
          viewData,
        });
      }
    }

    // Persist this tab group's split ratios so switching tabs restores layout
    group.gridColSizes = [...this._gridColSizes];
    group.gridRowSizes = [...this._gridRowSizes];
  }

  /**
   * Open all sessions from a workspace/focus in a new tab group.
   * Creates a new tab group named after the workspace, switches to terminal view,
   * and opens as many sessions as possible (up to MAX_PANES terminal panes).
   * @param {string} workspaceId - The workspace to open
   */
  openWorkspaceInTabGroup(workspaceId) {
    const ws = this.state.workspaces.find(w => w.id === workspaceId);
    if (!ws) return;

    // Get all sessions for this workspace
    const wsSessions = (this.state.allSessions || this.state.sessions || [])
      .filter(s => s.workspaceId === workspaceId);

    if (wsSessions.length === 0) {
      this.showToast('No sessions in this project to open', 'warning');
      return;
    }

    // Create a new tab group with the workspace name
    const groupId = 'tg_' + Date.now().toString(36);
    this._tabGroups.push({ id: groupId, name: ws.name, panes: [] });

    // Switch to the new group
    this._activeGroupId = groupId;
    this.setViewMode('terminal');

    // Clear current panes first (they belong to the new group now)
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      if (this.terminalPanes[i]) {
        this.terminalPanes[i].dispose();
        this.terminalPanes[i] = null;
      }
    }

    // Open up to MAX_PANES sessions in panes
    const maxPanes = Math.min(wsSessions.length, CWMApp.MAX_PANES);
    for (let i = 0; i < maxPanes; i++) {
      const session = wsSessions[i];
      const spawnOpts = {};
      if (session.workingDir) spawnOpts.cwd = session.workingDir;
      if (session.flags) spawnOpts.flags = session.flags;
      if (session.model) spawnOpts.model = session.model;
      this.openTerminalInPane(i, session.id, session.name || session.id, spawnOpts);
    }

    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
    this.updateTerminalGridLayout();

    const extra = wsSessions.length > CWMApp.MAX_PANES ? ` (${wsSessions.length - CWMApp.MAX_PANES} more sessions available)` : '';
    this.showToast(`Opened ${maxPanes} sessions from "${ws.name}"${extra}`, 'success');
  }

  createTerminalGroup() {
    const id = 'tg_' + Date.now().toString(36);
    const name = 'Tab ' + (this._tabGroups.length + 1);
    this._tabGroups.push({ id, name, panes: [] });
    this.saveTerminalLayout();
    this.renderTerminalGroupTabs();
    this.showToast(`Created tab group "${name}"`, 'success');
  }

  /**
   * Create a new tab folder from a single tab - the tab becomes the first member.
   * @param {string} tabGroupId - Tab group to seed the folder with
   */
  _createFolderFromTab(tabGroupId) {
    const group = this._tabGroups.find(g => g.id === tabGroupId);
    if (!group) return;

    const folderId = 'tf_' + Date.now().toString(36);
    const colors = ['mauve', 'blue', 'green', 'peach', 'red', 'pink', 'teal', 'yellow'];
    const color = colors[this._tabFolders.length % colors.length];

    this._tabFolders.push({ id: folderId, name: group.name, color, collapsed: false });
    group.folderId = folderId;

    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
    this.showToast(`Created group "${group.name}"`, 'success');
  }

  /**
   * Merge two tab groups into a folder via drag-and-hold.
   * If the target is already in a folder, the dragged tab joins that folder.
   * Otherwise, a new folder is created containing both tabs.
   * @param {string} draggedGroupId - Tab being dragged
   * @param {string} targetGroupId - Tab being held over
   */
  _mergeTabsIntoFolder(draggedGroupId, targetGroupId) {
    const draggedGroup = this._tabGroups.find(g => g.id === draggedGroupId);
    const targetGroup = this._tabGroups.find(g => g.id === targetGroupId);
    if (!draggedGroup || !targetGroup) return;

    // If dragged tab is already in the same folder as target, nothing to do
    if (draggedGroup.folderId && draggedGroup.folderId === targetGroup.folderId) return;

    if (targetGroup.folderId) {
      // Target is already in a folder - add dragged tab to that folder
      draggedGroup.folderId = targetGroup.folderId;
      const folder = this._tabFolders.find(f => f.id === targetGroup.folderId);
      const folderName = folder ? folder.name : 'Group';
      this.showToast(`Added "${draggedGroup.name}" to group "${folderName}"`, 'success');
    } else {
      // Neither in a folder - create a new folder containing both
      const folderId = 'tf_' + Date.now().toString(36);
      const colors = ['mauve', 'blue', 'green', 'peach', 'red', 'pink', 'teal', 'yellow'];
      const color = colors[this._tabFolders.length % colors.length];
      const folderName = 'Group ' + (this._tabFolders.length + 1);

      this._tabFolders.push({ id: folderId, name: folderName, color, collapsed: false });
      draggedGroup.folderId = folderId;
      targetGroup.folderId = folderId;
      this.showToast(`Created group "${folderName}" - double-click header to rename`, 'success');
    }

    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
  }

  /**
   * Ungroup all tabs in a folder - removes the folder, tabs become ungrouped.
   * @param {string} folderId - Folder to ungroup
   */
  _ungroupFolder(folderId) {
    this._tabGroups.forEach(g => {
      if (g.folderId === folderId) g.folderId = null;
    });
    this._tabFolders = this._tabFolders.filter(f => f.id !== folderId);
    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
  }

  /**
   * Delete a folder and all its tab groups.
   * @param {string} folderId - Folder to delete
   */
  _deleteFolder(folderId) {
    const folderTabs = this._tabGroups.filter(g => g.folderId === folderId);

    // Don't delete if it would remove the last tab group
    const remainingCount = this._tabGroups.length - folderTabs.length;
    if (remainingCount < 1) {
      this.showToast('Cannot delete - would remove all tabs', 'warning');
      return;
    }

    // Delete each tab in the folder
    for (const tab of folderTabs) {
      if (this._activeGroupId === tab.id) {
        // Switch to the first non-folder tab before deleting
        const other = this._tabGroups.find(g => g.folderId !== folderId);
        if (other) {
          this._activeGroupId = '__switching__';
          this.switchTerminalGroup(other.id);
        }
      }
    }

    this._tabGroups = this._tabGroups.filter(g => g.folderId !== folderId);
    this._tabFolders = this._tabFolders.filter(f => f.id !== folderId);

    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
  }

  /**
   * Inline rename for a folder header name element.
   * @param {HTMLElement} nameEl - The span element containing the folder name
   * @param {string} folderId - Folder to rename
   */
  _startInlineFolderRename(nameEl, folderId) {
    const folder = this._tabFolders.find(f => f.id === folderId);
    if (!folder) return;

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

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim() || currentName;
      folder.name = newName;
      nameEl.textContent = newName;
      this.saveTerminalLayout();
    };

    let mouseDownInside = false;
    input.addEventListener('mousedown', () => { mouseDownInside = true; });
    document.addEventListener('mouseup', () => {
      if (mouseDownInside) {
        mouseDownInside = false;
        setTimeout(() => { if (!committed) input.focus(); }, 0);
      }
    }, { once: false, capture: true });

    input.addEventListener('blur', () => {
      if (mouseDownInside) return;
      setTimeout(() => {
        if (!committed && document.activeElement !== input) commit();
      }, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = currentName; commit(); }
    });
  }

  deleteTerminalGroup(groupId) {
    if (this._tabGroups.length <= 1) {
      this.showToast('Cannot delete the last tab group', 'warning');
      return;
    }

    const wasDeletingActive = (this._activeGroupId === groupId);

    // If deleting the active group, save current pane state first so we
    // can cleanly tear down, then switch. If deleting a non-active group,
    // save active panes BEFORE filtering so the active group's pane data
    // isn't lost when saveTerminalLayout runs.
    this.saveCurrentGroupPanes();

    // Dispose any cached panes for the deleted group to free WebSocket connections
    this._disposeGroupCache(groupId);

    this._tabGroups = this._tabGroups.filter(g => g.id !== groupId);

    if (wasDeletingActive) {
      // Must switch to another group - this will dispose current panes and restore the new group's
      this._activeGroupId = this._tabGroups[0].id;
      // Bypass the early-return guard in switchTerminalGroup by setting a temp value
      const targetId = this._activeGroupId;
      this._activeGroupId = '__switching__';
      this.switchTerminalGroup(targetId);
      // Clean up the temp cache entry created by switchTerminalGroup for '__switching__'
      this._disposeGroupCache('__switching__');
    }

    this.saveTerminalLayout();
    this.renderTerminalGroupTabs();
  }

  /**
   * Dispose cached TerminalPane instances for a group, freeing WebSocket connections.
   * @param {string} groupId - Group whose cache to dispose
   */
  _disposeGroupCache(groupId) {
    const cached = this._groupPaneCache[groupId];
    if (!cached) return;
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      if (cached.panes[i]) {
        cached.panes[i].dispose();
        cached.panes[i] = null;
      }
    }
    delete this._groupPaneCache[groupId];
  }

  /**
   * Close a tab group with confirmation if it has live sessions.
   * Offers choice to kill sessions or move them to background.
   * @param {string} groupId - Tab group to close
   */
  async closeTabGroupWithConfirmation(groupId) {
    // Guard: can't delete last tab
    if (this._tabGroups.length <= 1) {
      this.showToast('Cannot delete the last tab group', 'warning');
      return;
    }

    const group = this._tabGroups.find(g => g.id === groupId);
    if (!group) return;

    // Check if this group has live terminal sessions
    const isActive = groupId === this._activeGroupId;
    const liveSessions = [];

    if (isActive && group.panes) {
      // For the active group, check actual terminalPanes
      for (const p of group.panes) {
        const tp = this.terminalPanes[p.slot];
        if (tp) liveSessions.push({ slot: p.slot, sessionId: tp.sessionId });
      }
    } else if (group.panes) {
      // For inactive groups, all saved panes are potentially live PTYs
      for (const p of group.panes) {
        if (p.sessionId) liveSessions.push({ slot: p.slot, sessionId: p.sessionId });
      }
    }

    if (liveSessions.length > 0) {
      const sessionWord = liveSessions.length > 1 ? 'sessions' : 'session';
      const choice = await this.showChoiceModal({
        title: 'Close Tab',
        message: `This tab has ${liveSessions.length} live ${sessionWord}. What would you like to do?`,
        actions: [
          { label: 'Close to Background', value: 'background', class: 'btn-primary' },
          { label: 'Close & Kill', value: 'kill', class: 'btn-danger' },
        ],
      });
      if (!choice) return;

      if (choice === 'kill') {
        // Kill all PTY sessions
        await Promise.allSettled(
          liveSessions.map(s =>
            this.api('POST', `/api/pty/${encodeURIComponent(s.sessionId)}/kill`).catch(() => {})
          )
        );
      }

      // Close/dispose active terminal panes if this is the active group
      if (isActive) {
        for (const s of liveSessions) {
          if (this.terminalPanes[s.slot]) {
            this.terminalPanes[s.slot].dispose();
            this.terminalPanes[s.slot] = null;
          }
        }
      }

      if (choice === 'kill') {
        this.showToast(`Killed ${liveSessions.length} ${sessionWord} and closed tab`, 'success');
      } else {
        this.showToast(`Moved ${liveSessions.length} ${sessionWord} to background — drag to reconnect`, 'info');
      }
    }

    this.deleteTerminalGroup(groupId);
  }

  /**
   * Reorder a tab group by moving it before the target group.
   */
  _reorderTabGroup(draggedId, targetId) {
    const draggedIdx = this._tabGroups.findIndex(g => g.id === draggedId);
    const targetIdx = this._tabGroups.findIndex(g => g.id === targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    const [dragged] = this._tabGroups.splice(draggedIdx, 1);
    this._tabGroups.splice(targetIdx, 0, dragged);
    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
  }

  /**
   * Swap two adjacent tab groups by index.
   */
  _swapTabGroups(idxA, idxB) {
    if (idxA < 0 || idxB < 0 || idxA >= this._tabGroups.length || idxB >= this._tabGroups.length) return;
    const temp = this._tabGroups[idxA];
    this._tabGroups[idxA] = this._tabGroups[idxB];
    this._tabGroups[idxB] = temp;
    this.renderTerminalGroupTabs();
    this.saveTerminalLayout();
  }

  /**
   * Move a terminal pane from the active tab group to a different tab group.
   * Disposes the terminal in the current tab and records it in the target group's
   * pane list. When the user switches to the target tab, the terminal reconnects.
   * @param {number} srcSlot - Source pane slot index (0-3)
   * @param {string} targetGroupId - Target tab group ID
   */
  moveTerminalToGroup(srcSlot, targetGroupId) {
    const tp = this.terminalPanes[srcSlot];
    if (!tp) return;

    const targetGroup = this._tabGroups.find(g => g.id === targetGroupId);
    if (!targetGroup) return;

    // Capture session info before disposing
    const sessionInfo = {
      sessionId: tp.sessionId,
      sessionName: tp.sessionName,
      spawnOpts: tp.spawnOpts || {},
    };

    // Dispose the terminal in the current tab (WebSocket disconnects, PTY stays alive)
    tp.dispose();
    this.terminalPanes[srcSlot] = null;

    // Reset the pane DOM to empty drop-target state
    const paneEl = document.getElementById(`term-pane-${srcSlot}`);
    if (paneEl) {
      paneEl.classList.add('terminal-pane-empty');
      paneEl.classList.remove('terminal-pane-active');
      const header = paneEl.querySelector('.terminal-pane-title');
      if (header) header.textContent = 'Drop a session here';
      const closeBtn = paneEl.querySelector('.terminal-pane-close');
      if (closeBtn) closeBtn.hidden = true;
      const uploadBtn = paneEl.querySelector('.terminal-pane-upload');
      if (uploadBtn) uploadBtn.hidden = true;
      const termContainer = paneEl.querySelector('.terminal-container');
      if (termContainer) termContainer.innerHTML = '';
    }

    // Update grid layout for current tab
    this.updateTerminalGridLayout();

    // Save current group panes (now minus the moved terminal)
    this.saveCurrentGroupPanes();

    // Find first available slot in target group (slots 0 to MAX_PANES-1, pick one not used)
    const usedSlots = new Set((targetGroup.panes || []).map(p => p.slot));
    let newSlot = 0;
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      if (!usedSlots.has(i)) { newSlot = i; break; }
    }

    // Add to target group's pane list
    if (!targetGroup.panes) targetGroup.panes = [];
    targetGroup.panes.push({
      slot: newSlot,
      sessionId: sessionInfo.sessionId,
      sessionName: sessionInfo.sessionName,
      spawnOpts: sessionInfo.spawnOpts,
    });

    // Persist and update UI
    this.saveTerminalLayout();
    this.renderTerminalGroupTabs();
    this.showToast(`Moved "${sessionInfo.sessionName}" to "${targetGroup.name}"`, 'info');
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

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim() || currentName;
      nameEl.textContent = newName;
      const group = this._tabGroups.find(g => g.id === groupId);
      if (group) group.name = newName;
      this.saveTerminalLayout();
    };

    // Track mousedown inside input - if user started a click/drag inside,
    // don't close on blur when they release outside the input
    let mouseDownInside = false;
    input.addEventListener('mousedown', () => { mouseDownInside = true; });
    document.addEventListener('mouseup', () => {
      if (mouseDownInside) {
        mouseDownInside = false;
        setTimeout(() => { if (!committed) input.focus(); }, 0);
      }
    }, { once: false, capture: true });

    input.addEventListener('blur', () => {
      if (mouseDownInside) return;
      setTimeout(() => {
        if (!committed && document.activeElement !== input) {
          commit();
        }
      }, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = currentName; commit(); }
    });
  }

  /**
   * Central chokepoint for tab/pane mutations. Performs three things in order:
   *   1. Synchronously flushes live pane state via `saveCurrentGroupPanes()`.
   *   2. Synchronously re-renders the sidebar via `renderWorkspaces()`.
   *   3. Schedules a debounced (500ms) PUT to /api/layout for server persistence.
   * Callers that mutate `terminalPanes` or `_tabGroups` should route through
   * this method rather than calling `renderWorkspaces()` themselves. Note:
   * `renderWorkspaces()` does not feed back into `saveTerminalLayout()`, so
   * there is no recursion.
   */
  saveTerminalLayout() {
    // Flush live pane state into _tabGroups[*].panes synchronously so the
    // sidebar indicator (which reads from _tabGroups) is fresh — the
    // server PUT below stays debounced.
    this.saveCurrentGroupPanes();
    if (typeof this.renderWorkspaces === 'function') {
      this.renderWorkspaces();
    }
    clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = setTimeout(async () => {
      this.saveCurrentGroupPanes();
      try {
        await this.api('PUT', '/api/layout', {
          tabGroups: this._tabGroups,
          tabFolders: this._tabFolders,
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
        // Edit existing - remove old, add new
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
      container.innerHTML = '<div class="ai-insights-empty">No sessions in this project</div>';
      return;
    }

    // Show loading state - spinning refresh button + header + skeletons
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
     COST DASHBOARD
     ═══════════════════════════════════════════════════════════ */

  /**
   * Load cost dashboard data from the API.
   * @param {string} [period='week'] - Time period: day, week, month, all
   */
  async loadCosts(period) {
    if (!period) {
      period = this._costsPeriod || 'week';
    }
    this._costsPeriod = period;

    // Update period selector active state
    if (this.els.costsPeriodSelector) {
      this.els.costsPeriodSelector.querySelectorAll('.costs-period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
      });
    }

    const body = this.els.costsBody;
    if (!body) return;

    try {
      const data = await this.api('GET', `/api/cost/dashboard?period=${period}`);
      this.renderCostsDashboard(data);
    } catch (err) {
      body.innerHTML = `<div class="costs-loading">Failed to load cost data: ${err.message}</div>`;
    }
  }

  /**
   * Render the full costs dashboard into the costs body element.
   * @param {object} data - Dashboard data from /api/cost/dashboard
   */
  renderCostsDashboard(data) {
    const body = this.els.costsBody;
    if (!body) return;

    const { summary, timeline, byModel, byWorkspace, sessions } = data;

    // Phase 18-04 (COST-03): when any enabled provider is cost-unsupported
    // (Codex today), the aggregate cards / breakdowns disclose "(Claude only)"
    // so users understand the totals exclude Codex traffic rather than
    // assuming Codex usage was zero. Computed once from state.providers.
    const providers = this.state.providers || [];
    const claudeOnly = Array.isArray(providers)
      && providers.some(p => p && p.enabled && p.supportsCost === false);
    const claudeOnlySuffix = claudeOnly ? ' (Claude only)' : '';

    // Format currency helper
    const fmtCost = (v) => {
      if (v >= 100) return '$' + v.toFixed(0);
      if (v >= 10) return '$' + v.toFixed(1);
      if (v >= 1) return '$' + v.toFixed(2);
      return '$' + v.toFixed(3);
    };

    // Format token count helper
    const fmtTokens = (v) => {
      if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
      if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
      return v.toString();
    };

    // Friendly model name helper
    const fmtModel = (m) => {
      if (m.includes('opus-4-6')) return 'Opus 4.6';
      if (m.includes('opus-4-5')) return 'Opus 4.5';
      if (m.includes('opus-4-1')) return 'Opus 4.1';
      if (m.includes('opus-4-0') || m.includes('opus-4-2')) return 'Opus 4';
      if (m.includes('sonnet-4-5')) return 'Sonnet 4.5';
      if (m.includes('sonnet-4-0') || m.includes('sonnet-4-2')) return 'Sonnet 4';
      if (m.includes('3-7-sonnet')) return 'Sonnet 3.7';
      if (m.includes('haiku-4-5')) return 'Haiku 4.5';
      if (m.includes('3-5-haiku')) return 'Haiku 3.5';
      if (m.includes('3-haiku')) return 'Haiku 3';
      return m.replace('claude-', '');
    };

    // Color palette for breakdown bars (Catppuccin accent colors)
    const barColors = ['var(--green)', 'var(--blue)', 'var(--mauve)', 'var(--peach)', 'var(--red)', 'var(--yellow)', 'var(--teal)', 'var(--pink)'];

    let html = '';

    // ── Summary Cards ──
    const totalTokenCount = (summary.totalTokens.input || 0) + (summary.totalTokens.output || 0) +
      (summary.totalTokens.cacheWrite || 0) + (summary.totalTokens.cacheRead || 0);
    html += `<div class="costs-summary">
      <div class="costs-card">
        <div class="costs-card-label">Total Cost${claudeOnlySuffix}</div>
        <div class="costs-card-value green">${fmtCost(summary.totalCost)}</div>
        <div class="costs-card-sub">${fmtTokens(totalTokenCount)} tokens</div>
      </div>
      <div class="costs-card">
        <div class="costs-card-label">${this.escapeHtml(summary.periodLabel)}${claudeOnlySuffix}</div>
        <div class="costs-card-value blue">${fmtCost(summary.periodCost)}</div>
        <div class="costs-card-sub">${summary.messageCount} messages</div>
      </div>
      <div class="costs-card">
        <div class="costs-card-label">Avg / Message</div>
        <div class="costs-card-value mauve">${fmtCost(summary.avgCostPerMessage)}</div>
        <div class="costs-card-sub">across all sessions</div>
      </div>
      <div class="costs-card">
        <div class="costs-card-label">Cache Savings</div>
        <div class="costs-card-value peach">${fmtCost(summary.cacheSavings)}</div>
        <div class="costs-card-sub">${fmtTokens(summary.totalTokens.cacheRead || 0)} read hits</div>
      </div>
    </div>`;

    // ── Timeline Chart ──
    html += `<div class="costs-chart-section">
      <h3 class="costs-chart-title">Cost Over Time</h3>
      <div class="costs-chart-container" id="costs-chart-container">
        ${timeline.length > 1
          ? '<div class="costs-chart-tooltip" id="costs-chart-tooltip"><div class="costs-chart-tooltip-date"></div><div class="costs-chart-tooltip-value"></div></div>'
          : '<div class="costs-chart-empty">Not enough data for timeline</div>'}
      </div>
    </div>`;

    // ── Breakdown: By Model + By Workspace ──
    html += '<div class="costs-breakdown">';

    // Phase 18-04 (COST-03): inline disclosure note above the breakdowns so
    // the "(Claude only)" suffix on the summary cards is not the only signal.
    // The byModel and byWorkspace data is Claude-only by nature today (the
    // cost worker walks Claude JSONL transcripts) so a one-line note is
    // sufficient; full Codex cost tracking is v1.3 scope.
    if (claudeOnly) {
      html += '<div class="costs-note" style="grid-column: 1 / -1; font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px;">Codex cost tracking not yet supported; aggregates reflect Claude usage only.</div>';
    }

    // By Model
    html += '<div class="costs-breakdown-card"><h3 class="costs-breakdown-title">By Model</h3>';
    if (byModel.length === 0) {
      html += '<div class="costs-breakdown-empty">No model data</div>';
    } else {
      const maxModelPct = Math.max(...byModel.map(m => m.pct), 1);
      byModel.forEach((m, i) => {
        const barW = Math.max(2, (m.pct / maxModelPct) * 100);
        html += `<div class="costs-breakdown-item">
          <span class="costs-breakdown-label">${fmtModel(m.model)}</span>
          <div class="costs-breakdown-bar-track">
            <div class="costs-breakdown-bar" style="width:${barW}%;background:${barColors[i % barColors.length]}"></div>
          </div>
          <span class="costs-breakdown-value">${fmtCost(m.cost)}</span>
        </div>`;
      });
    }
    html += '</div>';

    // By Workspace
    html += '<div class="costs-breakdown-card"><h3 class="costs-breakdown-title">By Project</h3>';
    if (byWorkspace.length === 0) {
      html += '<div class="costs-breakdown-empty">No project data</div>';
    } else {
      const maxWsPct = Math.max(...byWorkspace.map(w => w.pct), 1);
      byWorkspace.forEach((w, i) => {
        const barW = Math.max(2, (w.pct / maxWsPct) * 100);
        html += `<div class="costs-breakdown-item">
          <span class="costs-breakdown-label" title="${this.escapeHtml(w.name)}">${this.escapeHtml(w.name)}</span>
          <div class="costs-breakdown-bar-track">
            <div class="costs-breakdown-bar" style="width:${barW}%;background:${barColors[i % barColors.length]}"></div>
          </div>
          <span class="costs-breakdown-value">${fmtCost(w.cost)}</span>
        </div>`;
      });
    }
    html += '</div></div>';

    // ── Session Cost Table ──
    html += `<div class="costs-sessions-section">
      <div class="costs-sessions-header">
        <h3 class="costs-sessions-title">Sessions</h3>
        <input type="text" class="costs-sessions-search" id="costs-sessions-search" placeholder="Filter sessions..." />
      </div>`;

    if (sessions.length === 0) {
      html += '<div class="costs-sessions-empty">No session cost data available</div>';
    } else {
      html += `<table class="costs-sessions-table">
        <thead><tr>
          <th data-sort="name">Name</th>
          <th data-sort="workspace">Project</th>
          <th data-sort="cost" class="sort-active">Cost</th>
          <th data-sort="messages">Msgs</th>
          <th data-sort="model">Model</th>
        </tr></thead>
        <tbody id="costs-sessions-tbody">`;
      for (const s of sessions.slice(0, 50)) {
        // Phase 18-04 (COST-02/03): per-row em-dash for cost-unsupported
        // providers. data-provider rides the row so per-provider styling
        // can be added without re-render. The provider field is populated
        // server-side by /api/cost/dashboard (Phase 18-04 server change).
        const rowLacksCost = this._sessionProviderLacksCost(s);
        const rowProvider = this.escapeHtml(s.provider || 'claude'); /* gsd:provider-literal-allowed */
        const costCell = rowLacksCost
          ? `<td class="cost-cell cost-cell-na" title="Cost not tracked for this provider">&mdash;</td>`
          : `<td class="cost-cell">${fmtCost(s.cost)}</td>`;
        html += `<tr data-session-id="${s.id}" data-provider="${rowProvider}" class="costs-session-row">
          <td class="name-cell" title="${this.escapeHtml(s.name)}">${this.escapeHtml(s.name)}</td>
          <td class="workspace-cell" title="${this.escapeHtml(s.workspaceName)}">${this.escapeHtml(s.workspaceName)}</td>
          ${costCell}
          <td>${s.messageCount}</td>
          <td class="model-cell">${fmtModel(s.model)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    body.innerHTML = html;

    // ── Render SVG chart if we have timeline data ──
    if (timeline.length > 1) {
      this.renderCostChart(timeline);
    }

    // ── Wire up session search filter ──
    const searchInput = document.getElementById('costs-sessions-search');
    const tbody = document.getElementById('costs-sessions-tbody');
    if (searchInput && tbody) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        tbody.querySelectorAll('.costs-session-row').forEach(row => {
          const name = (row.querySelector('.name-cell')?.textContent || '').toLowerCase();
          const ws = (row.querySelector('.workspace-cell')?.textContent || '').toLowerCase();
          row.hidden = q && !name.includes(q) && !ws.includes(q);
        });
      });
    }

    // ── Wire up table sorting ──
    const table = body.querySelector('.costs-sessions-table');
    if (table && tbody) {
      this._costsSortCol = 'cost';
      this._costsSortAsc = false;
      this._costsSessionsData = sessions;

      table.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (this._costsSortCol === col) {
            this._costsSortAsc = !this._costsSortAsc;
          } else {
            this._costsSortCol = col;
            this._costsSortAsc = col === 'name' || col === 'workspace'; // alpha default asc
          }
          // Update header styling
          table.querySelectorAll('th').forEach(h => {
            h.classList.remove('sort-active', 'sort-asc');
          });
          th.classList.add('sort-active');
          if (this._costsSortAsc) th.classList.add('sort-asc');

          // Sort and re-render rows
          this._sortCostsTable(tbody);
        });
      });
    }

    // ── Wire up row click to navigate to session ──
    if (tbody) {
      tbody.querySelectorAll('.costs-session-row').forEach(row => {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          const sid = row.dataset.sessionId;
          if (sid) {
            this.state.selectedSession = sid;
            this.setViewMode('workspace');
            this.selectSession(sid);
          }
        });
      });
    }
  }

  /**
   * Sort the costs session table body by current sort column/direction.
   * @param {HTMLElement} tbody - Table body element
   */
  _sortCostsTable(tbody) {
    const data = this._costsSessionsData;
    if (!data) return;

    const col = this._costsSortCol;
    const asc = this._costsSortAsc;

    const sorted = [...data].sort((a, b) => {
      let va, vb;
      switch (col) {
        case 'name': va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'workspace': va = (a.workspaceName || '').toLowerCase(); vb = (b.workspaceName || '').toLowerCase(); break;
        case 'cost': va = a.cost; vb = b.cost; break;
        case 'messages': va = a.messageCount; vb = b.messageCount; break;
        case 'model': va = a.model || ''; vb = b.model || ''; break;
        default: return 0;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });

    const fmtCost = (v) => {
      if (v >= 100) return '$' + v.toFixed(0);
      if (v >= 10) return '$' + v.toFixed(1);
      if (v >= 1) return '$' + v.toFixed(2);
      return '$' + v.toFixed(3);
    };
    const fmtModel = (m) => {
      if (m.includes('opus-4-6')) return 'Opus 4.6';
      if (m.includes('opus-4-5')) return 'Opus 4.5';
      if (m.includes('opus-4-1')) return 'Opus 4.1';
      if (m.includes('opus-4-0') || m.includes('opus-4-2')) return 'Opus 4';
      if (m.includes('sonnet-4-5')) return 'Sonnet 4.5';
      if (m.includes('sonnet-4-0') || m.includes('sonnet-4-2')) return 'Sonnet 4';
      if (m.includes('3-7-sonnet')) return 'Sonnet 3.7';
      if (m.includes('haiku-4-5')) return 'Haiku 4.5';
      if (m.includes('3-5-haiku')) return 'Haiku 3.5';
      if (m.includes('3-haiku')) return 'Haiku 3';
      return m.replace('claude-', '');
    };

    let rowsHtml = '';
    for (const s of sorted.slice(0, 50)) {
      // Phase 18-04 (COST-02/03): mirror the initial-render's em-dash
      // logic on every sort re-render so the disclosure does not drop
      // when the user clicks a column header.
      const rowLacksCost = this._sessionProviderLacksCost(s);
      const rowProvider = this.escapeHtml(s.provider || 'claude'); /* gsd:provider-literal-allowed */
      const costCell = rowLacksCost
        ? `<td class="cost-cell cost-cell-na" title="Cost not tracked for this provider">&mdash;</td>`
        : `<td class="cost-cell">${fmtCost(s.cost)}</td>`;
      rowsHtml += `<tr data-session-id="${s.id}" data-provider="${rowProvider}" class="costs-session-row" style="cursor:pointer">
        <td class="name-cell" title="${this.escapeHtml(s.name)}">${this.escapeHtml(s.name)}</td>
        <td class="workspace-cell" title="${this.escapeHtml(s.workspaceName)}">${this.escapeHtml(s.workspaceName)}</td>
        ${costCell}
        <td>${s.messageCount}</td>
        <td class="model-cell">${fmtModel(s.model)}</td>
      </tr>`;
    }
    tbody.innerHTML = rowsHtml;

    // Re-wire row clicks
    tbody.querySelectorAll('.costs-session-row').forEach(row => {
      row.addEventListener('click', () => {
        const sid = row.dataset.sessionId;
        if (sid) {
          this.state.selectedSession = sid;
          this.setViewMode('workspace');
          this.selectSession(sid);
        }
      });
    });
  }

  /**
   * Render an SVG line chart for cost timeline data.
   * Pure SVG - no chart library needed.
   * @param {Array<{date, cost, tokens, messages}>} timeline - Daily cost data
   */
  renderCostChart(timeline) {
    const container = document.getElementById('costs-chart-container');
    if (!container || timeline.length < 2) return;

    const tooltip = document.getElementById('costs-chart-tooltip');

    // Chart dimensions (SVG viewBox coordinates)
    const W = 600, H = 180;
    const padL = 50, padR = 15, padT = 15, padB = 30;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    const maxCost = Math.max(...timeline.map(d => d.cost), 0.01);
    const n = timeline.length;

    // Map data to SVG coordinates
    const points = timeline.map((d, i) => ({
      x: padL + (i / (n - 1)) * chartW,
      y: padT + chartH - (d.cost / maxCost) * chartH,
      date: d.date,
      cost: d.cost,
      messages: d.messages || 0,
    }));

    // Build SVG
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;

    // Y-axis grid lines + labels (4 lines)
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * chartH;
      const val = maxCost * (1 - i / 4);
      svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="chart-grid"/>`;
      svg += `<text x="${padL - 6}" y="${y + 3}" class="chart-label chart-label-y">$${val >= 1 ? val.toFixed(1) : val.toFixed(2)}</text>`;
    }

    // Area fill polygon
    const areaPoints = points.map(p => `${p.x},${p.y}`).join(' ');
    svg += `<polygon class="chart-area" points="${points[0].x},${padT + chartH} ${areaPoints} ${points[n - 1].x},${padT + chartH}"/>`;

    // Line
    svg += `<polyline class="chart-line" points="${areaPoints}"/>`;

    // Data dots
    points.forEach((p, i) => {
      svg += `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="3" data-idx="${i}"/>`;
    });

    // X-axis labels (show up to 7 labels, evenly spaced)
    const labelCount = Math.min(7, n);
    const labelStep = Math.max(1, Math.floor((n - 1) / (labelCount - 1)));
    for (let i = 0; i < n; i += labelStep) {
      const p = points[i];
      // Format date as Mon DD
      const dateObj = new Date(p.date + 'T00:00:00');
      const label = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      svg += `<text x="${p.x}" y="${H - 5}" class="chart-label" text-anchor="middle">${label}</text>`;
    }
    // Always show last label if not already shown
    if ((n - 1) % labelStep !== 0) {
      const p = points[n - 1];
      const dateObj = new Date(p.date + 'T00:00:00');
      const label = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      svg += `<text x="${p.x}" y="${H - 5}" class="chart-label" text-anchor="middle">${label}</text>`;
    }

    svg += '</svg>';

    // Insert SVG before tooltip
    if (tooltip) {
      const svgWrapper = document.createElement('div');
      svgWrapper.innerHTML = svg;
      container.insertBefore(svgWrapper.firstChild, tooltip);
    } else {
      container.innerHTML = svg;
    }

    // Tooltip hover interaction
    if (tooltip) {
      container.querySelectorAll('.chart-dot').forEach(dot => {
        dot.addEventListener('mouseenter', (e) => {
          const idx = parseInt(e.target.dataset.idx);
          const p = points[idx];
          if (!p) return;

          const dateObj = new Date(p.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

          tooltip.querySelector('.costs-chart-tooltip-date').textContent = dateStr;
          tooltip.querySelector('.costs-chart-tooltip-value').textContent =
            `$${p.cost >= 1 ? p.cost.toFixed(2) : p.cost.toFixed(3)} · ${p.messages} msgs`;

          // Position tooltip near the dot
          const rect = container.getBoundingClientRect();
          const dotRect = e.target.getBoundingClientRect();
          tooltip.style.left = (dotRect.left - rect.left - 40) + 'px';
          tooltip.style.top = (dotRect.top - rect.top - 45) + 'px';
          tooltip.classList.add('visible');
        });

        dot.addEventListener('mouseleave', () => {
          tooltip.classList.remove('visible');
        });
      });
    }
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

  async refreshResources() {
    const btn = this.els.resourcesRefreshBtn;
    if (btn) btn.classList.add('refreshing');
    await this.fetchResources();
    if (btn) {
      setTimeout(() => btn.classList.remove('refreshing'), 600);
    }
  }

  async fetchGitStatus(dir) {
    if (!dir) return null;
    const cached = this.state.gitStatusCache[dir];
    if (cached && Date.now() - cached.timestamp < 30000) return cached.data;
    try {
      const data = await this.api('GET', '/api/git/status?dir=' + encodeURIComponent(dir));
      this.state.gitStatusCache[dir] = { data, timestamp: Date.now() };
      return data;
    } catch {
      return null;
    }
  }

  async fetchResources() {
    const body = this.els.resourcesBody;
    if (!body) return;

    try {
      const data = await this.api('GET', '/api/resources');
      this.state.resourceData = data;
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
        <thead><tr><th>Session</th><th>PID</th><th>CPU</th><th>Memory</th><th>Ports</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>`;
      claudeSessions.forEach(s => {
        const cpuVal = s.cpuPercent != null ? s.cpuPercent : null;
        const cpuClass = cpuVal == null ? '' : cpuVal > 75 ? 'cpu-high' : cpuVal > 25 ? 'cpu-medium' : 'cpu-low';
        const cpuText = cpuVal != null ? cpuVal.toFixed(1) + '%' : '--';

        html += `<tr>
          <td class="session-name-cell">
            ${this.escapeHtml(s.sessionName || s.sessionId)}
            ${s.workspaceName ? '<span class="resource-workspace-label">' + this.escapeHtml(s.workspaceName) + '</span>' : ''}
          </td>
          <td class="pid-cell">${s.pid || '--'}</td>
          <td class="cpu-cell ${cpuClass}">${cpuText}</td>
          <td class="mem-cell">${s.memoryMB ? Math.round(s.memoryMB) + ' MB' : '--'}</td>
          <td class="ports-cell">${(s.ports && s.ports.length > 0) ? s.ports.map(p => '<a href="http://localhost:' + p + '" target="_blank" rel="noopener" class="port-link">' + p + '</a><button class="btn btn-ghost btn-sm expose-port-btn" data-port="' + p + '" title="Expose via tunnel">&#8599;</button>').join(' ') : '<span style="color:var(--overlay0)">--</span>'}</td>
          <td>
            <div class="resource-actions">
              <button class="resource-action-btn action-restart" data-session-id="${s.sessionId}" data-action="restart" title="Restart session">Restart</button>
              <button class="resource-action-btn action-stop" data-session-id="${s.sessionId}" data-action="stop" title="Stop session">Stop</button>
              <button class="resource-action-btn action-kill" data-pid="${s.pid}" data-action="kill" title="Force kill process">Kill</button>
            </div>
          </td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    html += '</div>';

    // Background PTY sessions section - shows PTYs with no connected terminal pane
    html += '<div id="resources-pty-bg" class="resources-pty-bg-section"></div>';

    // Stopped sessions section (collapsible)
    const allSessions = [...(this.state.sessions || []), ...(this.state.allSessions || [])];
    const stoppedSessions = allSessions.filter(s => s.status === 'stopped' || s.status === 'crashed' || s.status === 'error');
    // Deduplicate by ID
    const seenIds = new Set(claudeSessions.map(s => s.sessionId));
    const uniqueStopped = stoppedSessions.filter(s => !seenIds.has(s.id) && !seenIds.add(s.id));

    if (uniqueStopped.length > 0) {
      html += `<div class="resources-stopped-section">
        <button class="resources-stopped-toggle" id="stopped-sessions-toggle">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Stopped Sessions (${uniqueStopped.length})
        </button>
        <div id="stopped-sessions-list" hidden>
          <table class="claude-session-table" style="margin-top:8px">
            <thead><tr><th>Session</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>`;
      uniqueStopped.slice(0, 20).forEach(s => {
        const statusColor = s.status === 'error' || s.status === 'crashed' ? 'var(--red)' : 'var(--overlay0)';
        html += `<tr>
          <td class="session-name-cell">${this.escapeHtml(s.name || s.id.substring(0, 12))}</td>
          <td style="color:${statusColor}">${s.status || 'stopped'}</td>
          <td>
            <div class="resource-actions">
              <button class="resource-action-btn action-start" data-session-id="${s.id}" data-action="start" title="Start session">Start</button>
            </div>
          </td>
        </tr>`;
      });
      html += '</tbody></table></div></div>';
    }

    // Token quota section (populated async)
    html += '<div id="resources-quota" class="resources-quota-section"></div>';

    // Tunnels section (populated async)
    html += '<div id="resources-tunnels" class="resources-tunnel-section"></div>';

    body.innerHTML = html;

    // Bind session action buttons (stop/restart/kill/start)
    body.querySelectorAll('.resource-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const sessionId = btn.dataset.sessionId;
        const pid = btn.dataset.pid ? parseInt(btn.dataset.pid, 10) : null;

        if (action === 'kill' && pid) {
          // Show confirmation for kill
          const confirmed = await this.showConfirmModal({
            title: 'Kill Process',
            message: `Force kill PID ${pid}? This will terminate the process immediately without cleanup.`,
            confirmText: 'Kill',
            confirmClass: 'btn-danger',
          });
          if (!confirmed) return;
          try {
            await this.api('POST', '/api/resources/kill-process', { pid });
            this.showToast(`Killed PID ${pid}`, 'success');
            setTimeout(() => this.fetchResources(), 1000);
          } catch (err) {
            this.showToast(err.message || 'Failed to kill process', 'error');
          }
        } else if (action === 'stop' && sessionId) {
          try {
            await this.api('POST', `/api/sessions/${sessionId}/stop`);
            this.showToast('Session stopped', 'success');
            setTimeout(() => this.fetchResources(), 1000);
          } catch (err) {
            this.showToast(err.message || 'Failed to stop session', 'error');
          }
        } else if (action === 'restart' && sessionId) {
          try {
            await this.api('POST', `/api/sessions/${sessionId}/restart`);
            this.showToast('Session restarting...', 'success');
            setTimeout(() => this.fetchResources(), 2000);
          } catch (err) {
            this.showToast(err.message || 'Failed to restart session', 'error');
          }
        } else if (action === 'start' && sessionId) {
          try {
            await this.api('POST', `/api/sessions/${sessionId}/start`);
            this.showToast('Session starting...', 'success');
            setTimeout(() => this.fetchResources(), 2000);
          } catch (err) {
            this.showToast(err.message || 'Failed to start session', 'error');
          }
        }
      });
    });

    // Bind stopped sessions toggle
    const stoppedToggle = document.getElementById('stopped-sessions-toggle');
    const stoppedList = document.getElementById('stopped-sessions-list');
    if (stoppedToggle && stoppedList) {
      stoppedToggle.addEventListener('click', () => {
        stoppedList.hidden = !stoppedList.hidden;
        stoppedToggle.classList.toggle('expanded');
      });
    }

    // Bind expose port buttons
    body.querySelectorAll('.expose-port-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const port = parseInt(btn.dataset.port, 10);
        try {
          const data = await this.api('POST', '/api/tunnels', { port });
          this.showToast(data.url ? 'Tunnel: ' + data.url : 'Tunnel starting...', 'success');
          this.fetchResources();
        } catch (err) {
          this.showToast(err.message || 'Failed to create tunnel', 'error');
        }
      });
    });

    // Load token quota section
    this.api('GET', '/api/quota-overview').then(quotaData => {
      const quotaContainer = document.getElementById('resources-quota');
      if (quotaContainer) this.renderQuotaOverview(quotaData, quotaContainer);
    }).catch(() => {});

    // Load tunnels section
    this.api('GET', '/api/tunnels').then(tunnelData => {
      const tunnelContainer = document.getElementById('resources-tunnels');
      if (tunnelContainer) this.renderTunnels(tunnelData, tunnelContainer);
    }).catch(() => {});

    // Load background PTY sessions
    this.api('GET', '/api/pty').then(ptyData => {
      const container = document.getElementById('resources-pty-bg');
      if (container) this.renderBackgroundPtySessions(ptyData, container);
    }).catch(() => {});
  }

  /**
   * Render background PTY sessions (those with zero connected clients).
   * Shows a cleanup button to kill all orphaned sessions.
   * @param {Object} data - Response from GET /api/pty
   * @param {HTMLElement} container - DOM element to render into
   */
  renderBackgroundPtySessions(data, container) {
    const sessions = (data.sessions || []);
    const orphaned = sessions.filter(s => s.clientCount === 0);
    const connected = sessions.filter(s => s.clientCount > 0);

    let html = `<div class="resources-section-title">
      Terminal Sessions
      <span class="total-badge">${connected.length} connected / ${orphaned.length} background</span>
    </div>`;

    if (orphaned.length === 0) {
      html += '<div class="resources-empty">No background terminal sessions</div>';
    } else {
      html += `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button class="btn btn-ghost btn-sm" id="kill-orphaned-pty-btn" style="color:var(--red)">
          Close all background (${orphaned.length})
        </button>
      </div>`;
      html += `<table class="claude-session-table">
        <thead><tr><th>Session</th><th>PID</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>`;
      for (const s of orphaned) {
        const statusColor = s.alive ? 'var(--green)' : 'var(--overlay0)';
        html += `<tr>
          <td class="session-name-cell">${this.escapeHtml(s.sessionId.substring(0, 20))}${s.sessionId.length > 20 ? '...' : ''}</td>
          <td class="pid-cell">${s.pid || '--'}</td>
          <td style="color:${statusColor}">${s.alive ? 'running' : 'exited'}</td>
          <td>
            <div class="resource-actions">
              <button class="resource-action-btn action-stop" data-pty-id="${this.escapeHtml(s.sessionId)}" title="Close this PTY">Close</button>
            </div>
          </td>
        </tr>`;
      }
      html += '</tbody></table>';
    }

    container.innerHTML = html;

    // Bind "Close all background" button
    const killAllBtn = container.querySelector('#kill-orphaned-pty-btn');
    if (killAllBtn) {
      killAllBtn.addEventListener('click', async () => {
        try {
          const result = await this.api('POST', '/api/pty/kill-orphaned');
          this.showToast(`Closed ${result.killed} background session${result.killed !== 1 ? 's' : ''}`, 'success');
          setTimeout(() => this.fetchResources(), 500);
        } catch (err) {
          this.showToast(err.message || 'Failed to close sessions', 'error');
        }
      });
    }

    // Bind individual close buttons
    container.querySelectorAll('.resource-action-btn[data-pty-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ptyId = btn.dataset.ptyId;
        try {
          await this.api('POST', `/api/pty/${encodeURIComponent(ptyId)}/kill`);
          this.showToast('Session closed', 'success');
          setTimeout(() => this.fetchResources(), 500);
        } catch (err) {
          this.showToast(err.message || 'Failed to close session', 'error');
        }
      });
    });
  }

  renderTunnels(data, container) {
    const tunnels = data.tunnels || [];
    const available = data.cloudflaredAvailable;
    let html = '<div class="resources-section-title">Tunnels <span class="total-badge">' + (available ? tunnels.length + ' active' : 'cloudflared not installed') + '</span></div>';
    if (!available) {
      html += '<div class="resources-empty"><p>cloudflared is not installed.</p><a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/" target="_blank" class="port-link" style="font-size:13px;">Install cloudflared</a></div>';
    } else if (tunnels.length === 0) {
      html += '<div class="resources-empty">No active tunnels. Click "Expose" on a port above to start one.</div>';
    } else {
      html += '<table class="claude-session-table"><thead><tr><th>Label</th><th>Port</th><th>Public URL</th><th></th></tr></thead><tbody>';
      tunnels.forEach(t => {
        html += '<tr><td>' + this.escapeHtml(t.label) + '</td><td class="pid-cell">' + t.port + '</td><td>';
        if (t.url) {
          html += '<a href="' + this.escapeHtml(t.url) + '" target="_blank" class="port-link">' + this.escapeHtml(t.url) + '</a>';
          html += ' <button class="btn btn-ghost btn-sm copy-tunnel-url" data-url="' + this.escapeHtml(t.url) + '" title="Copy URL" style="padding:2px 6px;font-size:11px;">Copy</button>';
        } else {
          html += '<span style="color:var(--overlay0)">Connecting...</span>';
        }
        html += '</td><td><button class="btn btn-ghost btn-sm close-tunnel-btn" data-tunnel-id="' + t.id + '" style="color:var(--red);">Close</button></td></tr>';
      });
      html += '</tbody></table>';
    }
    container.innerHTML = html;

    // Bind close buttons
    container.querySelectorAll('.close-tunnel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await this.api('DELETE', '/api/tunnels/' + btn.dataset.tunnelId);
          this.showToast('Tunnel closed', 'success');
          this.fetchResources();
        } catch (err) {
          this.showToast(err.message || 'Failed to close tunnel', 'error');
        }
      });
    });

    // Bind copy buttons
    container.querySelectorAll('.copy-tunnel-url').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.url);
        this.showToast('URL copied', 'success');
      });
    });
  }

  /**
   * Render the token quota overview section in the Resources panel.
   * Shows all sessions ranked by context window heaviness with urgency indicators.
   */
  renderQuotaOverview(data, container) {
    if (!data || !data.sessions || data.sessions.length === 0) {
      container.innerHTML = '';
      return;
    }

    const summary = data.summary || {};
    const formatTokens = (t) => {
      if (t >= 1000000) return (t / 1000000).toFixed(1) + 'M';
      if (t >= 1000) return (t / 1000).toFixed(0) + 'K';
      return t.toString();
    };
    const formatCost = (c) => c < 0.01 ? '<$0.01' : '$' + c.toFixed(2);

    let html = `<div class="resources-section-title">
      Token Quota
      <span class="total-badge">${summary.totalSessions} sessions · ${formatTokens(summary.totalTokens)} tokens · ${formatCost(summary.totalCost)}</span>
    </div>`;

    // Summary alert cards for critical/warning sessions
    if (summary.criticalCount > 0 || summary.warningCount > 0) {
      html += '<div style="display:flex;gap:8px;margin-bottom:10px">';
      if (summary.criticalCount > 0) {
        html += `<div style="flex:1;padding:8px 12px;background:rgba(243,139,168,0.1);border:1px solid var(--red);border-radius:6px;font-size:12px;color:var(--red)">
          <strong>${summary.criticalCount}</strong> session${summary.criticalCount > 1 ? 's' : ''} over 80% context - consider compacting
        </div>`;
      }
      if (summary.warningCount > 0) {
        html += `<div style="flex:1;padding:8px 12px;background:rgba(249,226,175,0.1);border:1px solid var(--yellow);border-radius:6px;font-size:12px;color:var(--yellow)">
          <strong>${summary.warningCount}</strong> session${summary.warningCount > 1 ? 's' : ''} over 50% context
        </div>`;
      }
      html += '</div>';
    }

    // Session table sorted by heaviness
    html += `<table class="claude-session-table">
      <thead><tr>
        <th>Session</th>
        <th>Project</th>
        <th>Context</th>
        <th>Cost</th>
        <th>Messages</th>
      </tr></thead><tbody>`;

    // Show top 20 sessions
    data.sessions.slice(0, 20).forEach(s => {
      const urgencyColor = s.urgency === 'critical' ? 'var(--red)' : s.urgency === 'warning' ? 'var(--yellow)' : 'var(--green)';
      const urgencyIcon = s.urgency === 'critical' ? '&#9888;' : s.urgency === 'warning' ? '&#9679;' : '&#10003;';
      const barWidth = Math.min(100, s.contextPct);

      html += `<tr>
        <td class="session-name-cell">${this.escapeHtml(s.sessionName)}</td>
        <td style="font-size:11px;color:var(--subtext0)">${this.escapeHtml(s.workspaceName)}</td>
        <td style="min-width:140px">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="color:${urgencyColor};font-size:11px" title="${s.urgency}">${urgencyIcon}</span>
            <div style="flex:1">
              <div style="height:5px;background:var(--surface0);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${barWidth}%;background:${urgencyColor};border-radius:3px"></div>
              </div>
            </div>
            <span style="font-size:11px;color:var(--text);min-width:40px;text-align:right">${formatTokens(s.latestInputTokens)}</span>
          </div>
        </td>
        <td class="cost-cell" style="font-size:12px">${formatCost(s.totalCost)}</td>
        <td style="font-size:12px;color:var(--subtext0)">${s.messageCount}</td>
      </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async showWorktreeList(dir) {
    try {
      const data = await this.api('GET', '/api/git/worktrees?dir=' + encodeURIComponent(dir));
      if (!data.worktrees || data.worktrees.length === 0) {
        this.showToast('No worktrees found', 'info');
        return;
      }
      let msg = data.worktrees.map(wt =>
        (wt.branch || 'detached') + '  →  ' + wt.path
      ).join('\n');
      await this.showConfirmModal({
        title: 'Git Worktrees (' + data.worktrees.length + ')',
        message: msg,
        confirmText: 'OK',
      });
    } catch (err) {
      this.showToast(err.message || 'Failed to list worktrees', 'error');
    }
  }

  async createWorktree(workspaceId) {
    const result = await this.showPromptModal({
      title: 'Create Git Worktree',
      fields: [
        { key: 'repoDir', label: 'Repository Path', placeholder: '~/repos/my-project', required: true },
        { key: 'branch', label: 'Branch Name', placeholder: 'feat/my-feature', required: true },
        { key: 'path', label: 'Worktree Path (optional)', placeholder: 'Leave blank for default' },
      ],
      confirmText: 'Create Worktree',
    });
    if (!result) return;
    try {
      const data = await this.api('POST', '/api/git/worktrees', {
        repoDir: result.repoDir,
        branch: result.branch,
        path: result.path || undefined,
      });
      this.showToast('Worktree created at ' + data.path, 'success');
      const createSession = await this.showConfirmModal({
        title: 'Create Session?',
        message: 'Create a session in the new worktree at ' + data.path + '?',
        confirmText: 'Create Session',
      });
      if (createSession) {
        await this.api('POST', '/api/sessions', {
          name: result.branch + ' worktree',
          workspaceId,
          workingDir: data.path,
          command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
        });
        await this.loadSessions();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to create worktree', 'error');
    }
  }

  async startFeatureSession(workspaceId) {
    const ws = this.state.workspaces.find(w => w.id === workspaceId);
    if (!ws) return;

    // Get the working directory from the first session in this workspace, or ask
    const wsSessions = (this.state.allSessions || this.state.sessions).filter(s => s.workspaceId === workspaceId);
    const defaultDir = wsSessions.length > 0 ? wsSessions[0].workingDir : '';

    const result = await this.showPromptModal({
      title: 'New Feature Session',
      fields: [
        { key: 'featureName', label: 'Feature Name', placeholder: 'auth-flow, dark-mode, etc.', required: true },
        { key: 'repoDir', label: 'Repository Path', value: defaultDir, required: true },
        { key: 'baseBranch', label: 'Base Branch', value: 'main', required: true },
        { key: 'useWorktree', label: 'Create Worktree (recommended)', type: 'checkbox', value: true },
      ],
      confirmText: 'Create Feature Session',
    });

    if (!result) return;

    // Sanitize feature name for branch
    const branchName = 'feat/' + result.featureName.replace(/[^a-zA-Z0-9_/-]/g, '-').toLowerCase();

    try {
      let sessionDir = result.repoDir;

      if (result.useWorktree) {
        // Create worktree with the new branch (the API creates the branch automatically)
        const wtData = await this.api('POST', '/api/git/worktrees', {
          repoDir: result.repoDir,
          branch: branchName,
        });
        sessionDir = wtData.path;
        this.showToast('Created worktree: ' + branchName, 'success');
      }
      // If useWorktree is unchecked, just create the session in the existing repo dir

      // Create session in the workspace
      const sessionData = await this.api('POST', '/api/sessions', {
        name: result.featureName,
        workspaceId,
        workingDir: sessionDir,
        command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
        topic: 'Feature: ' + result.featureName,
      });

      await this.loadSessions();

      // Open in terminal
      const emptySlot = this.terminalPanes.findIndex(p => p === null);
      if (emptySlot !== -1) {
        this.setViewMode('terminal');
        this.openTerminalInPane(emptySlot, sessionData.session.id, result.featureName, { cwd: sessionDir });
      }

      this.showToast('Feature session started: ' + result.featureName, 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to create feature session', 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     WORKTREE TASKS
     ═══════════════════════════════════════════════════════════ */

  /**
   * Launch the "New Worktree Task" creation flow.
   * Creates a worktree branch, spawns a session, and tracks the task.
   * @param {string} workspaceId - Workspace to create the task in
   */
  async startWorktreeTask(workspaceId) {
    const ws = this.state.workspaces.find(w => w.id === workspaceId);
    if (!ws) return;

    // Pre-fill repo dir from the first session in workspace
    const wsSessions = (this.state.allSessions || this.state.sessions).filter(s => s.workspaceId === workspaceId);
    const defaultDir = wsSessions.length > 0 ? wsSessions[0].workingDir : '';

    // Get feature board items for linking
    const features = (this.state.features || []).filter(f => f.workspaceId === workspaceId && f.status !== 'done');
    const featureOptions = features.length > 0
      ? [{ value: '', label: 'None' }, ...features.map(f => ({ value: f.id, label: f.name }))]
      : [];

    const fields = [
      { key: 'description', label: 'What should Claude build?', type: 'textarea', placeholder: 'Implement OAuth login flow with Google provider...', required: true },
      { key: 'repoDir', label: 'Repository Path', value: defaultDir, required: true },
      { key: 'baseBranch', label: 'Base Branch', value: 'main', required: true },
      { key: 'branch', label: 'Branch Name', placeholder: 'Auto-generated from description' },
    ];

    // Add feature board link if features exist
    if (featureOptions.length > 0) {
      fields.push({ key: 'featureId', label: 'Link to Feature', type: 'select', options: featureOptions });
    }

    // Add model selector
    fields.push({ key: 'model', label: 'Model', type: 'select', options: [
      { value: '',           label: 'Default' },
      { value: 'opus',       label: 'Opus' },
      { value: 'sonnet',     label: 'Sonnet' },
      { value: 'haiku',      label: 'Haiku' },
      { value: 'sonnet[1m]', label: 'Sonnet 1M' },
      { value: 'opusplan',   label: 'OpusPlan' },
    ]});

    const result = await this.showPromptModal({
      title: 'New Worktree Task',
      fields,
      confirmText: 'Start Task',
    });
    if (!result) return;

    // Auto-generate branch name from description if not provided
    const branch = result.branch || ('wt/' + result.description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40));

    try {
      const data = await this.api('POST', '/api/worktree-tasks', {
        workspaceId,
        repoDir: result.repoDir,
        branch,
        description: result.description,
        baseBranch: result.baseBranch || 'main',
        featureId: result.featureId || undefined,
        model: result.model || undefined,
      });

      await this.loadSessions();

      // Open session in terminal pane if available
      if (data.session) {
        const emptySlot = this.terminalPanes.findIndex(p => p === null);
        if (emptySlot !== -1) {
          this.setViewMode('terminal');
          this.openTerminalInPane(emptySlot, data.session.id, branch, { cwd: data.task.worktreePath });
        }
      }

      this.showToast(`Worktree task started on ${branch}`, 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to create worktree task', 'error');
    }
  }

  /**
   * Render the worktree task review banner in session detail panel.
   * Shows when the selected session is linked to a worktree task in "review" status.
   * @param {Object} session - The selected session
   */
  async renderWorktreeTaskBanner(session) {
    // Find or create the banner container
    let banner = document.getElementById('wt-review-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'wt-review-banner';
      banner.className = 'wt-review-banner';
      // Insert at the top of the detail body
      const detailBody = this.els.detailPanel?.querySelector('.detail-body');
      if (detailBody) detailBody.prepend(banner);
    }

    // Check if worktree tasks are enabled
    const changedFilesEl = document.getElementById('wt-changed-files');
    if (!this.getSetting('enableWorktreeTasks')) {
      banner.hidden = true;
      if (changedFilesEl) changedFilesEl.hidden = true;
      return;
    }

    // Fetch worktree tasks for this session's workspace
    try {
      const data = await this.api('GET', `/api/worktree-tasks?workspaceId=${session.workspaceId}`);
      const task = (data.tasks || []).find(t => t.sessionId === session.id);

      if (!task) {
        banner.hidden = true;
        if (changedFilesEl) changedFilesEl.hidden = true;
        return;
      }

      banner.hidden = false;

      const statusColors = {
        running: 'var(--blue)',
        review: 'var(--yellow)',
        merged: 'var(--green)',
        rejected: 'var(--red)',
      };
      const statusColor = statusColors[task.status] || 'var(--overlay0)';

      let actionsHtml = '';
      if (task.status === 'review') {
        const prAction = (task.pr && task.pr.url)
          ? `<a href="${this.escapeHtml(task.pr.url)}" target="_blank" class="wt-review-btn" style="text-decoration:none;color:var(--green);" title="View PR #${task.pr.number}">PR #${task.pr.number}</a>`
          : `<button class="wt-review-btn wt-review-btn-create-pr" data-task-id="${task.id}" title="Create a pull request">Create PR</button>`;
        actionsHtml = `
          <div class="wt-review-actions">
            <button class="wt-review-btn wt-review-btn-diff" data-task-id="${task.id}" title="View changes">View Diff</button>
            <button class="wt-review-btn wt-review-btn-merge" data-task-id="${task.id}" title="Merge branch and cleanup">Merge</button>
            ${prAction}
            <button class="wt-review-btn wt-review-btn-reject" data-task-id="${task.id}" title="Reject and delete worktree">Reject</button>
            <button class="wt-review-btn wt-review-btn-resume" data-task-id="${task.id}" title="Resume working">Resume</button>
          </div>`;
      } else if (task.status === 'running') {
        actionsHtml = `<div class="wt-review-status" style="color:${statusColor}">Task running on ${this.escapeHtml(task.branch)}</div>`;
      } else {
        actionsHtml = `<div class="wt-review-status" style="color:${statusColor}">${task.status.charAt(0).toUpperCase() + task.status.slice(1)}</div>`;
      }

      banner.innerHTML = `
        <div class="wt-review-header">
          <span class="wt-review-icon" style="color:${statusColor}">&#128268;</span>
          <span class="wt-review-title">Worktree Task: ${this.escapeHtml(task.description.slice(0, 60))}</span>
          <span class="wt-review-branch">${this.escapeHtml(task.branch)}</span>
        </div>
        ${actionsHtml}`;

      // Render changed files section below the banner
      this._renderWorktreeChangedFiles(task);

      // Bind review action buttons
      banner.querySelectorAll('.wt-review-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const taskId = btn.dataset.taskId;
          if (btn.classList.contains('wt-review-btn-diff')) {
            await this.showWorktreeTaskDiff(taskId);
          } else if (btn.classList.contains('wt-review-btn-merge')) {
            await this.openMergeDialog(task);
          } else if (btn.classList.contains('wt-review-btn-reject')) {
            const ok = await this.showConfirmModal({
              title: 'Reject Worktree Task',
              message: `Delete the worktree and branch "${task.branch}"? This cannot be undone.`,
              confirmText: 'Reject',
              confirmClass: 'btn-danger',
            });
            if (ok) {
              try {
                await this.api('POST', `/api/worktree-tasks/${taskId}/reject`);
                this.showToast(`Rejected and cleaned up ${task.branch}`, 'info');
                this.renderSessionDetail();
              } catch (err) {
                this.showToast(err.message || 'Reject failed', 'error');
              }
            }
          } else if (btn.classList.contains('wt-review-btn-push')) {
            try {
              const res = await this.api('POST', `/api/worktree-tasks/${taskId}/push`);
              this.showToast(res.message || `Pushed ${task.branch} to origin`, 'success');
            } catch (err) {
              this.showToast(err.message || 'Push failed', 'error');
            }
          } else if (btn.classList.contains('wt-review-btn-create-pr')) {
            this.openPRDialog(taskId);
          } else if (btn.classList.contains('wt-review-btn-resume')) {
            try {
              await this.api('PUT', `/api/worktree-tasks/${taskId}`, { status: 'running', completedAt: null });
              await this.api('POST', `/api/sessions/${session.id}/restart`);
              this.showToast('Resumed worktree task', 'success');
              this.renderSessionDetail();
            } catch (err) {
              this.showToast(err.message || 'Resume failed', 'error');
            }
          }
        });
      });
    } catch {
      banner.hidden = true;
    }
  }

  /**
   * Open the diff viewer for a worktree task.
   * Fetches changed files, renders file list sidebar and diff content.
   * @param {string} taskId - Worktree task ID
   * @param {string} [preselectedFile] - Optional file path to auto-select
   */
  async showWorktreeTaskDiff(taskId, preselectedFile) {
    if (!this.els.diffViewerOverlay) return;
    this._diffViewerTaskId = taskId;
    this._diffViewerFiles = [];
    this.els.diffViewerOverlay.hidden = false;
    this.els.diffViewerTitle.textContent = 'Loading changes...';
    this.els.diffViewerStats.textContent = '';
    this.els.diffViewerFiles.innerHTML = '';
    this.els.diffViewerContent.innerHTML = '<div class="diff-viewer-loading">Loading...</div>';

    try {
      const data = await this.api('GET', `/api/worktree-tasks/${taskId}/changes`);
      const files = data.files || [];
      this._diffViewerFiles = files;

      if (files.length === 0) {
        this.els.diffViewerTitle.textContent = 'No changes';
        this.els.diffViewerFiles.innerHTML = '<div class="diff-viewer-empty" style="height:auto;padding:20px">No changed files</div>';
        this.els.diffViewerContent.innerHTML = '<div class="diff-viewer-empty">No changes to display</div>';
        return;
      }

      // Compute totals
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      this.els.diffViewerTitle.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed`;
      this.els.diffViewerStats.innerHTML = `<span class="added">+${totalAdd}</span> <span class="removed">-${totalDel}</span>`;

      // Render file list
      this.els.diffViewerFiles.innerHTML = files.map((f, i) => {
        const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/') + 1) : '';
        const name = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
        return `<div class="diff-file-item" data-index="${i}" data-path="${this.escapeHtml(f.path)}">
          <span class="diff-file-status status-${f.status}">${f.status}</span>
          <span class="diff-file-name">${dir ? `<span class="diff-file-dir">${this.escapeHtml(dir)}</span>` : ''}${this.escapeHtml(name)}</span>
          <span class="diff-file-counts">${f.additions ? `<span class="added">+${f.additions}</span>` : ''}${f.deletions ? `<span class="removed">-${f.deletions}</span>` : ''}</span>
        </div>`;
      }).join('');

      // Bind file click handlers
      this.els.diffViewerFiles.querySelectorAll('.diff-file-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.index, 10);
          this._selectDiffFile(idx);
        });
      });

      // Auto-select first file or preselected file
      const preIdx = preselectedFile ? files.findIndex(f => f.path === preselectedFile) : 0;
      this._selectDiffFile(preIdx >= 0 ? preIdx : 0);
    } catch (err) {
      this.els.diffViewerTitle.textContent = 'Error';
      this.els.diffViewerContent.innerHTML = `<div class="diff-viewer-empty">${this.escapeHtml(err.message || 'Failed to load changes')}</div>`;
    }
  }

  /**
   * Select and display a file's diff in the diff viewer.
   * @param {number} index - Index in _diffViewerFiles array
   */
  async _selectDiffFile(index) {
    if (!this._diffViewerFiles || !this._diffViewerFiles[index]) return;
    const file = this._diffViewerFiles[index];

    // Update active state in file list
    this.els.diffViewerFiles.querySelectorAll('.diff-file-item').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });

    this.els.diffViewerContent.innerHTML = '<div class="diff-viewer-loading">Loading diff...</div>';

    try {
      const data = await this.api('POST', `/api/worktree-tasks/${this._diffViewerTaskId}/diff`, { file: file.path });
      const diffText = data.diff || '';

      if (!diffText) {
        this.els.diffViewerContent.innerHTML = '<div class="diff-viewer-empty">No diff content (binary file or empty change)</div>';
        return;
      }

      this.els.diffViewerContent.innerHTML = this._renderDiffContent(diffText);
    } catch (err) {
      this.els.diffViewerContent.innerHTML = `<div class="diff-viewer-empty">${this.escapeHtml(err.message || 'Failed to load diff')}</div>`;
    }
  }

  /**
   * Parse unified diff text and render it as HTML with line numbers and colors.
   * @param {string} diffText - Raw unified diff output from git
   * @returns {string} HTML string for the diff content
   */
  _renderDiffContent(diffText) {
    const lines = diffText.split('\n');
    let html = '';
    let inHunk = false;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      // Skip diff header lines (diff --git, index, ---, +++)
      if (line.startsWith('diff --git') || line.startsWith('index ') ||
          line.startsWith('---') || line.startsWith('+++') ||
          line.startsWith('new file') || line.startsWith('deleted file') ||
          line.startsWith('similarity') || line.startsWith('rename') ||
          line.startsWith('old mode') || line.startsWith('new mode')) {
        continue;
      }

      // Hunk header: @@ -old,count +new,count @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (hunkMatch) {
        if (inHunk) html += '</div>'; // close previous hunk
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[2], 10);
        const context = hunkMatch[3] || '';
        html += `<div class="diff-hunk"><div class="diff-hunk-header">@@ -${hunkMatch[1]} +${hunkMatch[2]} @@${this.escapeHtml(context)}</div>`;
        inHunk = true;
        continue;
      }

      if (!inHunk) continue;

      const escaped = this.escapeHtml(line.substring(1));
      if (line.startsWith('+')) {
        html += `<div class="diff-line diff-add"><span class="diff-line-num">${newLine}</span><span class="diff-line-content">+${escaped}</span></div>`;
        newLine++;
      } else if (line.startsWith('-')) {
        html += `<div class="diff-line diff-del"><span class="diff-line-num">${oldLine}</span><span class="diff-line-content">-${escaped}</span></div>`;
        oldLine++;
      } else if (line.startsWith(' ') || line === '') {
        html += `<div class="diff-line diff-ctx"><span class="diff-line-num">${newLine}</span><span class="diff-line-content"> ${this.escapeHtml(line.substring(1))}</span></div>`;
        oldLine++;
        newLine++;
      }
    }

    if (inHunk) html += '</div>'; // close last hunk
    return html || '<div class="diff-viewer-empty">No displayable diff content</div>';
  }

  /**
   * Close the diff viewer overlay.
   */
  closeDiffViewer() {
    if (this.els.diffViewerOverlay) {
      this.els.diffViewerOverlay.hidden = true;
    }
    this._diffViewerTaskId = null;
    this._diffViewerFiles = [];
  }

  /**
   * Open the merge dialog for a worktree task (by task ID lookup from cache).
   * Used by the Tasks view quick-action buttons.
   * @param {string} taskId - Worktree task ID
   */
  async mergeWorktreeTask(taskId) {
    const task = (this._worktreeTaskCache || []).find(t => t.id === taskId);
    if (!task) {
      this.showToast('Task not found', 'error');
      return;
    }
    await this.openMergeDialog(task);
  }

  /**
   * Open a merge dialog with squash toggle, commit message, and push option.
   * Replaces the simple confirm modal with a full merge configuration form.
   * @param {Object} task - Worktree task object
   */
  async openMergeDialog(task) {
    const baseBranch = task.baseBranch || 'main';
    const defaultMsg = `Merge worktree task: ${task.description}`;

    const result = await this.showPromptModal({
      title: `Merge ${task.branch}`,
      fields: [
        { key: 'commitMessage', label: 'Commit Message', value: defaultMsg, type: 'textarea' },
        { key: 'squash', label: 'Squash commits into one', type: 'checkbox', value: false },
        { key: 'pushToRemote', label: 'Push to remote after merge', type: 'checkbox', value: false },
      ],
      confirmText: 'Merge',
      confirmClass: 'btn-primary',
    });

    if (!result) return; // cancelled

    try {
      const res = await this.api('POST', `/api/worktree-tasks/${task.id}/merge`, {
        squash: !!result.squash,
        commitMessage: result.commitMessage || defaultMsg,
        pushToRemote: !!result.pushToRemote,
      });
      this.showToast(res.message || `Merged ${task.branch} into ${baseBranch}`, 'success');
      // Refresh views
      if (this.state.viewMode === 'tasks') {
        this.renderTasksView();
      } else {
        this.renderSessionDetail();
      }
    } catch (err) {
      this.showToast(err.message || 'Merge failed', 'error');
    }
  }

  /**
   * Render a collapsible "Changed Files" section in the detail panel for worktree tasks.
   * Shows the list of files changed on the branch with click-to-diff functionality.
   * @param {Object} task - Worktree task object with id, branch, etc.
   */
  async _renderWorktreeChangedFiles(task) {
    const detailBody = this.els.detailPanel?.querySelector('.detail-body');
    if (!detailBody) return;

    // Find or create the changes container
    let section = document.getElementById('wt-changed-files');
    if (!section) {
      section = document.createElement('div');
      section.id = 'wt-changed-files';
      section.className = 'detail-changes';
      // Insert after the banner
      const banner = document.getElementById('wt-review-banner');
      if (banner && banner.nextSibling) {
        detailBody.insertBefore(section, banner.nextSibling);
      } else if (banner) {
        detailBody.appendChild(section);
      } else {
        detailBody.prepend(section);
      }
    }

    // Don't show for completed/rejected tasks
    if (task.status === 'merged' || task.status === 'rejected') {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    section.innerHTML = '<div class="detail-changes-header" aria-expanded="false"><span class="detail-changes-title">Changed Files <span style="font-weight:400;color:var(--overlay0)">loading...</span></span><span class="detail-changes-toggle">&#9654;</span></div>';

    try {
      const data = await this.api('GET', `/api/worktree-tasks/${task.id}/changes`);
      const files = data.files || [];

      if (files.length === 0) {
        section.innerHTML = '<div class="detail-changes-header" aria-expanded="false"><span class="detail-changes-title">Changed Files <span style="font-weight:400;color:var(--overlay0)">(0)</span></span><span class="detail-changes-toggle">&#9654;</span></div>';
        return;
      }

      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);

      section.innerHTML = `
        <div class="detail-changes-header" aria-expanded="true">
          <span class="detail-changes-title">Changed Files <span style="font-weight:400;color:var(--overlay0)">(${files.length})</span></span>
          <span class="detail-changes-toggle">&#9654;</span>
        </div>
        <div class="detail-changes-list">
          ${files.map(f => {
            const name = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
            return `<div class="detail-change-item" data-task-id="${task.id}" data-path="${this.escapeHtml(f.path)}">
              <span class="detail-change-status status-${f.status}">${f.status}</span>
              <span class="detail-change-path" title="${this.escapeHtml(f.path)}">${this.escapeHtml(name)}</span>
              <span class="detail-change-counts">${f.additions ? `<span class="added">+${f.additions}</span>` : ''}${f.deletions ? `<span class="removed">-${f.deletions}</span>` : ''}</span>
            </div>`;
          }).join('')}
        </div>`;

      // Bind toggle
      const header = section.querySelector('.detail-changes-header');
      const list = section.querySelector('.detail-changes-list');
      header.addEventListener('click', () => {
        const expanded = header.getAttribute('aria-expanded') === 'true';
        header.setAttribute('aria-expanded', !expanded);
        list.style.display = expanded ? 'none' : '';
      });

      // Bind file click → open diff viewer at that file
      section.querySelectorAll('.detail-change-item').forEach(el => {
        el.addEventListener('click', () => {
          this.showWorktreeTaskDiff(el.dataset.taskId, el.dataset.path);
        });
      });
    } catch {
      section.querySelector('.detail-changes-title').innerHTML = 'Changed Files <span style="font-weight:400;color:var(--overlay0)">(error)</span>';
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SELF-UPDATE
     ═══════════════════════════════════════════════════════════ */

  async checkForUpdates() {
    try {
      const data = await this.api('GET', '/api/version');
      this._versionInfo = data;

      if (data.updateAvailable && this.els.updateBtn) {
        this.els.updateBtn.hidden = false;
        this.els.updateBadge.hidden = false;
        this.els.updateBadge.textContent = data.commitsBehind;
      }
    } catch (_) {
      // Version check is best-effort
    }
  }

  showUpdateModal() {
    if (!this.els.updateOverlay) return;
    this.els.updateOverlay.hidden = false;

    const info = this._versionInfo || {};

    if (info.updateAvailable) {
      this.els.updateStatus.innerHTML = `
        <div>Current version: <span class="update-version">v${this.escapeHtml(info.version)}</span></div>
        <div style="margin-top:4px;color:var(--green)">${info.commitsBehind} commit${info.commitsBehind > 1 ? 's' : ''} behind</div>
      `;
      this.els.updateStartBtn.hidden = false;
    } else {
      this.els.updateStatus.innerHTML = `
        <div>Current version: <span class="update-version">v${this.escapeHtml(info.version || '?')}</span></div>
        <div style="margin-top:4px;color:var(--green)">You're up to date!</div>
      `;
      this.els.updateStartBtn.hidden = true;
    }

    this.els.updateSteps.innerHTML = '';
  }

  hideUpdateModal() {
    if (this.els.updateOverlay) this.els.updateOverlay.hidden = true;
  }

  async performUpdate() {
    this.els.updateStartBtn.hidden = true;
    this.els.updateDismissBtn.hidden = true;
    this.els.updateSteps.innerHTML = '';

    const steps = {
      pull: { label: 'Pulling latest changes', icon: '&#8595;' },
      install: { label: 'Installing dependencies', icon: '&#128230;' },
      version: { label: 'Checking new version', icon: '&#9989;' },
      restart: { label: 'Restarting server', icon: '&#128260;' },
    };

    // Initialize all steps as pending
    Object.entries(steps).forEach(([key, step]) => {
      const div = document.createElement('div');
      div.className = 'update-step update-step-pending';
      div.id = `update-step-${key}`;
      div.innerHTML = `
        <span class="update-step-icon">${step.icon}</span>
        <span class="update-step-label">${step.label}</span>
        <span class="update-step-detail"></span>
      `;
      this.els.updateSteps.appendChild(div);
    });

    try {
      const response = await fetch('/api/update', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + this.state.token,
          'Content-Type': 'application/json',
        },
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.updateStepUI(msg.step, msg.status, msg.detail);
          } catch (_) {}
        }
      }

      // After stream ends, show restart message
      this.els.updateStatus.innerHTML = '<div style="color:var(--green);font-weight:600">Update complete! Refresh the page in a few seconds.</div>';
      this.els.updateFooter.innerHTML = '<button class="btn btn-primary" onclick="location.reload()">Refresh Now</button>';

    } catch (err) {
      this.els.updateStatus.innerHTML = `<div style="color:var(--red)">Update failed: ${this.escapeHtml(err.message)}</div>`;
      this.els.updateDismissBtn.hidden = false;
    }
  }

  updateStepUI(stepKey, status, detail) {
    const el = document.getElementById(`update-step-${stepKey}`);
    if (!el) return;

    el.className = `update-step update-step-${status}`;

    const iconEl = el.querySelector('.update-step-icon');
    const detailEl = el.querySelector('.update-step-detail');

    if (status === 'running') {
      iconEl.innerHTML = ''; // CSS spinner via ::after
    } else if (status === 'done') {
      iconEl.innerHTML = '&#10003;';
    } else if (status === 'error') {
      iconEl.innerHTML = '&#10007;';
    }

    if (detail && detailEl) {
      detailEl.textContent = detail;
      detailEl.title = detail;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     GLOBAL SEARCH (Ctrl+Shift+F / Cmd+Shift+F)
     ═══════════════════════════════════════════════════════════ */

  openGlobalSearch() {
    if (!this.els.searchOverlay) return;
    this.els.searchOverlay.hidden = false;
    this.els.searchInput.value = '';
    this.els.searchResults.innerHTML = '<div class="qs-empty">Type to search across all session history</div>';
    // Small delay so animation plays before focus
    requestAnimationFrame(() => this.els.searchInput.focus());

    // Bind input handler (debounced)
    if (this._searchInputHandler) {
      this.els.searchInput.removeEventListener('input', this._searchInputHandler);
    }
    this._searchInputHandler = () => {
      clearTimeout(this._searchDebounceTimer);
      const query = this.els.searchInput.value.trim();
      if (query.length < 2) {
        this.els.searchResults.innerHTML = '<div class="qs-empty">Enter at least 2 characters to search</div>';
        return;
      }
      this.els.searchResults.innerHTML = '<div class="qs-empty">Searching...</div>';
      this._searchDebounceTimer = setTimeout(() => {
        this.performGlobalSearch(query);
      }, 300);
    };
    this.els.searchInput.addEventListener('input', this._searchInputHandler);

    // Bind keydown handler for Enter and Escape
    if (this._searchKeyHandler) {
      this.els.searchInput.removeEventListener('keydown', this._searchKeyHandler);
    }
    this._searchKeyHandler = (e) => {
      if (e.key === 'Enter') {
        clearTimeout(this._searchDebounceTimer);
        const query = this.els.searchInput.value.trim();
        if (query.length >= 2) {
          this.els.searchResults.innerHTML = '<div class="qs-empty">Searching...</div>';
          this.performGlobalSearch(query);
        }
      } else if (e.key === 'Escape') {
        this.closeGlobalSearch();
      }
    };
    this.els.searchInput.addEventListener('keydown', this._searchKeyHandler);

    // Click overlay background to close
    if (this._searchOverlayClickHandler) {
      this.els.searchOverlay.removeEventListener('click', this._searchOverlayClickHandler);
    }
    this._searchOverlayClickHandler = (e) => {
      if (e.target === this.els.searchOverlay) {
        this.closeGlobalSearch();
      }
    };
    this.els.searchOverlay.addEventListener('click', this._searchOverlayClickHandler);
  }

  closeGlobalSearch() {
    if (!this.els.searchOverlay) return;
    this.els.searchOverlay.hidden = true;
    this.els.searchInput.value = '';
    clearTimeout(this._searchDebounceTimer);
  }

  async performGlobalSearch(query) {
    try {
      const data = await this.api('GET', `/api/search?q=${encodeURIComponent(query)}&limit=30`);
      const results = data.results || [];

      if (results.length === 0) {
        this.els.searchResults.innerHTML = '<div class="qs-empty">No results found</div>';
        return;
      }

      const html = results.map(r => {
        const projectName = this.escapeHtml(r.projectName || r.project || 'Unknown');
        const timeStr = r.timestamp ? this.relativeTime(r.timestamp) : (r.modified ? this.relativeTime(r.modified) : '');
        const snippet = this.highlightSearchQuery(this.escapeHtml(r.snippet || r.preview || ''), query);
        const sessionId = this.escapeHtml(r.sessionId || '');
        const role = this.escapeHtml(r.role || r.type || '');
        // Phase 18-04 (SRCH-05): each search result carries the provider id
        // on data-provider so a CSS selector can color the
        // .search-result-provider chip via var(--provider-{id}-accent).
        // The chip text is the provider id uppercased; the default below
        // is the v1.1 back-compat value for results from pre-v1.2 servers.
        const providerId = r.provider || 'claude'; /* gsd:provider-literal-allowed */
        const providerAttr = this.escapeHtml(providerId);
        const providerLabel = this.escapeHtml(providerId.toUpperCase());

        return `
          <div class="search-result" data-session-id="${sessionId}" data-project-path="${this.escapeHtml(r.projectPath || '')}" data-provider="${providerAttr}">
            <div class="search-result-header">
              <span class="search-result-provider">${providerLabel}</span>
              <span class="search-result-project">${projectName}</span>
              <span class="search-result-time">${timeStr}</span>
            </div>
            <div class="search-result-snippet">${snippet}</div>
            <div class="search-result-meta">${sessionId}${role ? ' &middot; ' + role : ''}</div>
          </div>`;
      }).join('');

      this.els.searchResults.innerHTML = html;

      // Bind click events on results to navigate to the session
      this.els.searchResults.querySelectorAll('.search-result').forEach(el => {
        el.addEventListener('click', () => {
          const sessionId = el.dataset.sessionId;
          const projectPath = el.dataset.projectPath;
          if (sessionId) {
            this.openConversationResult(sessionId, projectPath);
            this.closeGlobalSearch();
          }
        });
      });
    } catch (err) {
      this.els.searchResults.innerHTML = `<div class="qs-empty" style="color: var(--red);">Search failed: ${this.escapeHtml(err.message || 'Unknown error')}</div>`;
    }
  }

  /**
   * Highlight matching portions of text with <mark> tags.
   * The text should already be HTML-escaped before calling this method.
   */
  highlightSearchQuery(escapedText, query) {
    if (!query || !escapedText) return escapedText;
    // Escape regex special characters in the query
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Escape the query for HTML (in case it contains & < > etc.) to match against escaped text
    const escapedQuery = this.escapeHtml(query);
    const safeEscapedQuery = escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const regex = new RegExp(`(${safeEscapedQuery})`, 'gi');
      return escapedText.replace(regex, '<mark>$1</mark>');
    } catch {
      return escapedText;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     CONFLICT DETECTION
     ═══════════════════════════════════════════════════════════ */

  /**
   * Start periodic conflict checks. Runs every 60 seconds.
   * Only actually checks if there are 2+ running sessions in the active workspace.
   */
  startConflictChecks() {
    // Clear any existing interval
    if (this._conflictCheckInterval) {
      clearInterval(this._conflictCheckInterval);
    }
    // Run an initial check after a short delay (let sessions load first)
    setTimeout(() => this.checkForConflicts(), 5000);
    // Then check every 60 seconds
    this._conflictCheckInterval = setInterval(() => this.checkForConflicts(), 60000);
  }

  /* ─── Export Session Context (Handoff) ──────────────────────── */

  async exportSessionContext(sessionId) {
    try {
      const data = await this.api('GET', `/api/sessions/${sessionId}/export-context`);
      if (!data || !data.export) {
        this.showToast('No context data available', 'warning');
        return;
      }

      const markdown = data.export.markdown;
      const fileCount = (data.export.filesTouched || []).length;
      const msgCount = data.export.messageCount || 0;

      // Show in a modal with copy + continue options
      const result = await this.showPromptModal({
        title: 'Session Context Export',
        fields: [
          { key: 'context', label: `${msgCount} messages \u00b7 ${fileCount} files`, type: 'textarea', value: markdown },
        ],
        confirmText: 'Copy & Continue',
        confirmClass: 'btn-primary',
      });

      if (result) {
        // Copy to clipboard
        try {
          await navigator.clipboard.writeText(markdown);
          this.showToast('Context copied to clipboard', 'success');
        } catch (_) {
          this.showToast('Could not copy to clipboard', 'warning');
        }

        // Continue in new session - create a new session in the same workspace/dir and open in terminal
        const session = (this.state.allSessions || this.state.sessions).find(s => s.id === sessionId);
        if (session && session.workspaceId) {
          try {
            const dirParts = (session.workingDir || '').replace(/\\/g, '/').split('/');
            const dirName = dirParts[dirParts.length - 1] || 'handoff';
            const payload = {
              name: `${dirName} - continued`,
              workspaceId: session.workspaceId,
              workingDir: session.workingDir || '',
              command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
              topic: `Continued from: ${session.name || session.id}`,
            };
            if (session.model) payload.model = session.model;
            if (session.bypassPermissions) payload.bypassPermissions = true;

            const newData = await this.api('POST', '/api/sessions', payload);
            const newSession = newData.session || newData;
            await this.loadSessions();

            // Open in first empty terminal pane and send context as first message
            const emptySlot = this.terminalPanes.findIndex(p => p === null);
            if (emptySlot !== -1) {
              this.setViewMode('terminal');
              const spawnOpts = { cwd: session.workingDir || '' };
              if (session.model) spawnOpts.model = session.model;
              if (session.bypassPermissions) spawnOpts.bypassPermissions = true;
              this.openTerminalInPane(emptySlot, newSession.id, newSession.name, spawnOpts);

              // After a short delay, send the context markdown as the first message
              setTimeout(() => {
                const pane = this.terminalPanes[emptySlot];
                if (pane && pane.sendInput) {
                  pane.sendInput(markdown + '\n');
                }
              }, 2000);
            }
          } catch (contErr) {
            // Copy succeeded even if continue fails
            this.showToast('Context copied but could not create new session: ' + (contErr.message || ''), 'warning');
          }
        }
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to export context', 'error');
    }
  }

  /**
   * Refocus a session by distilling the conversation into a structured context
   * document, then sending /clear (reset) or /compact to the terminal and
   * injecting the document back in for Claude to ingest.
   *
   * @param {string} sessionId - The session ID to refocus
   * @param {'reset'|'compact'} mode - Whether to clear or compact the conversation
   */
  async refocusSession(sessionId, mode) {
    // Find the terminal pane for this session
    const tp = this.terminalPanes.find(p => p && p.sessionId === sessionId);
    if (!tp || !tp.ws || tp.ws.readyState !== WebSocket.OPEN) {
      this.showToast('Session must be open in a terminal pane to refocus', 'warning');
      return;
    }

    this.showToast('Generating refocus document...', 'info');

    try {
      // Generate the refocus document on the server
      const data = await this.api('POST', `/api/sessions/${sessionId}/refocus`, { mode });

      if (!data || !data.success) {
        this.showToast(data?.error || 'Failed to generate refocus document', 'error');
        return;
      }

      const filePath = data.filePath;

      // Send /clear or /compact to the terminal
      const command = mode === 'reset' ? '/clear' : '/compact';
      tp.sendCommand(command + '\r');

      // Wait for Claude to process the command, then inject the refocus prompt
      setTimeout(() => {
        const refocusPrompt = 'Read the file .refocus-context.md in this directory. It contains a comprehensive summary of our previous conversation including what was accomplished, key decisions, open issues, and next steps. Use this to fully orient yourself on the project state. After reading, briefly confirm what you understand and ask what I\'d like to work on next.';
        tp.sendCommand(refocusPrompt + '\r');

        this.showToast(`Session refocused (${mode}) — context document injected`, 'success');
      }, 3000);

      // Clean up the refocus file after a delay
      const cleanupDelay = mode === 'reset' ? 60000 : 120000;
      setTimeout(async () => {
        try {
          await this.api('DELETE', `/api/refocus-cleanup?filePath=${encodeURIComponent(filePath)}`);
        } catch (_) {
          // Non-critical — file may already be gone
        }
      }, cleanupDelay);

    } catch (err) {
      this.showToast(err.message || 'Failed to refocus session', 'error');
    }
  }

  /* ─── Image Upload for Terminal Sessions ──────────────────── */

  /**
   * Upload an image file and send its path to a terminal session.
   * Shows a preview + optional message prompt before injecting.
   * @param {File} file - Image file from file input or drag-and-drop
   * @param {number} slotIdx - Terminal pane slot index
   */
  async handleImageUpload(file, slotIdx) {
    const tp = this.terminalPanes[slotIdx];
    if (!tp || !tp.sessionId) {
      this.showToast('No active session in this pane', 'warning');
      return;
    }

    // Validate file type and size
    if (!file.type.startsWith('image/')) {
      this.showToast('Only image files are supported', 'warning');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.showToast('Image must be under 10MB', 'warning');
      return;
    }

    // Upload to server
    this.showToast('Uploading image...', 'info');
    let uploadResult;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const resp = await fetch(`/api/pty/${tp.sessionId}/upload-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.state.token}`,
          'Content-Type': file.type,
          'X-Filename': encodeURIComponent(file.name),
        },
        body: arrayBuffer,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || 'Upload failed');
      }
      uploadResult = await resp.json();
    } catch (err) {
      this.showToast('Upload failed: ' + err.message, 'error');
      return;
    }

    // Show prompt modal with image thumbnail preview
    const thumbUrl = URL.createObjectURL(file);
    const sizeStr = file.size < 1024 * 1024
      ? (file.size / 1024).toFixed(0) + ' KB'
      : (file.size / (1024 * 1024)).toFixed(1) + ' MB';
    const result = await this.showPromptModal({
      title: 'Send Image to Session',
      headerHtml: `<div style="text-align:center;margin-bottom:12px;">
        <img src="${thumbUrl}" style="max-width:100%;max-height:200px;border-radius:8px;border:1px solid var(--surface1);" alt="Preview">
        <div style="font-size:12px;color:var(--subtext0);margin-top:6px;">${this.escapeHtml(file.name)} (${sizeStr})</div>
      </div>`,
      fields: [
        { key: 'message', label: 'Message (optional)', type: 'text', placeholder: 'e.g. "What does this screenshot show?"', value: '' }
      ],
      confirmText: 'Send to Claude',
      confirmClass: 'btn-primary',
    });
    URL.revokeObjectURL(thumbUrl);

    if (!result) return; // User cancelled

    // Inject into PTY via WebSocket
    if (!tp.ws || tp.ws.readyState !== WebSocket.OPEN) {
      this.showToast('Terminal not connected', 'warning');
      return;
    }

    const message = result.message
      ? `${result.message} ${uploadResult.path}`
      : `Please analyze this image: ${uploadResult.path}`;
    tp.ws.send(JSON.stringify({ type: 'input', data: message + '\r' }));

    this.showToast('Image sent to session', 'success');
  }

  /**
   * Look up a provider entry in state.providers by id. Returns the bare
   * provider tile object loaded from GET /api/providers (shape:
   * {id, displayName, accentToken, enabled, available, supportsCost}) or
   * null when the registry has not loaded yet OR the id is unknown.
   * Phase 18-04 (COST-02/03): callers consult this before deciding whether
   * to render a cost badge or to disclose "(Claude only)" on aggregates.
   * @param {string} id Provider id to resolve.
   * @returns {Object|null} The provider tile object, or null if not loaded.
   */
  _getProviderById(id) {
    if (!id) return null;
    const providers = this.state.providers || [];
    if (!Array.isArray(providers)) return null;
    return providers.find(p => p && p.id === id) || null;
  }

  /**
   * Plan 19-02: resolve the CLI binary name for a provider id, used at the
   * 5 spawn sites that previously hardcoded the default Claude literal
   * (AI find-session card, project drops, workspace drops). Reads from the
   * fetched spec map first (window.CWMProviderSpecs, populated by
   * fetchProviderSpecs) so new providers light up without frontend edits.
   * Falls back to the state.providers list if specs are not yet available,
   * then to the v1.1 back-compat default (see marker line below).
   *
   * Marker rationale: the literal on the final fallback line is the
   * back-compat default (v1.1 callers passed no provider id at all; the
   * literal preserves their behavior). Marked per the grep gate's
   * exemption mechanism (see test/grep-gate.test.js).
   *
   * @param {string} providerId Provider id from session/project/UI context.
   * @returns {string} The cliBinary string for the resolved provider.
   */
  getProviderCliBinary(providerId) {
    const specs = (typeof window !== 'undefined' && window.CWMProviderSpecs) || null;
    const spec = (specs && providerId && specs[providerId]) ||
      (specs && specs.claude) || // gsd:provider-literal-allowed (Phase 19 fallback to Claude spec)
      null;
    if (spec && typeof spec.cliBinary === 'string' && spec.cliBinary.length > 0) {
      return spec.cliBinary;
    }
    // Spec map not yet fetched: try state.providers (loaded by loadProviders).
    const entry = this._getProviderById(providerId);
    if (entry && typeof entry.cliBinary === 'string' && entry.cliBinary.length > 0) {
      return entry.cliBinary;
    }
    // v1.1 back-compat default. Existing un-tagged callers expect Claude.
    return 'claude'; // gsd:provider-literal-allowed (v1.1 back-compat default)
  }

  /**
   * Convenience check for the cost-display branch. Returns true when the
   * session's provider is known AND explicitly reports supportsCost:false.
   * Returns false (i.e., do show cost) when the provider is unknown, has
   * not loaded yet, or is anything other than an explicit "no" so the
   * Claude/cost-tracked path remains the default for new providers.
   * @param {Object} session Session object with optional .provider field.
   * @returns {boolean} true if the session's provider is cost-unsupported.
   */
  _sessionProviderLacksCost(session) {
    if (!session) return false;
    const id = session.provider || 'claude'; /* gsd:provider-literal-allowed */
    const entry = this._getProviderById(id);
    if (!entry) return false;
    return entry.supportsCost === false;
  }

  /* ─── Session Cost Cache (best-effort, non-blocking) ──────── */

  _getSessionCostCached(sessionId) {
    if (!this._costCache) this._costCache = {};
    const entry = this._costCache[sessionId];
    if (entry && (Date.now() - entry.ts < 300000)) {
      // Valid cache entry (< 5 minutes old)
      return entry.cost;
    }
    return null;
  }

  /**
   * Fetch costs for all sessions in a single batch request instead of N+1
   * individual requests. Results are cached for 5 minutes. Only re-renders
   * the sidebar once after all costs are received.
   */
  _fetchSessionCostsAsync() {
    if (!this._costCache) this._costCache = {};
    // Skip if a batch fetch is already in flight or cache is fresh
    if (this._costBatchInFlight) return;
    if (this._costBatchTs && (Date.now() - this._costBatchTs < 300000)) return;

    this._costBatchInFlight = true;
    this.api('GET', '/api/cost/batch').then(data => {
      this._costBatchInFlight = false;
      this._costBatchTs = Date.now();
      if (data && data.costs) {
        for (const [sid, entry] of Object.entries(data.costs)) {
          this._costCache[sid] = { cost: entry.cost, ts: Date.now() };
        }
        // Patch cost badges in-place instead of full renderWorkspaces() rebuild.
        // Full re-renders freeze the UI for hundreds of ms with many sessions.
        this._patchCostBadges(data.costs);
      }
    }).catch(() => {
      this._costBatchInFlight = false;
      this._costBatchTs = Date.now();
    });
  }

  /**
   * Patch cost badge text in the sidebar DOM without a full renderWorkspaces() rebuild.
   * Finds existing cost badges by session ID and updates their text, or inserts
   * a new badge if one doesn't exist yet. Avoids the multi-hundred-ms DOM rebuild
   * that was causing input freezes.
   * @param {Object} costs - Map of sessionId -> { cost, lastActive }
   */
  _patchCostBadges(costs) {
    const list = this.els.workspaceList;
    if (!list) return;

    for (const [sid, entry] of Object.entries(costs)) {
      if (!entry.cost && entry.cost !== 0) continue;
      const costText = '$' + Number(entry.cost).toFixed(2);

      // Find the session element in the sidebar
      const sessionEl = list.querySelector(`[data-session-id="${sid}"]`);
      if (!sessionEl) continue;

      // Phase 18-04 (COST-02): if the row already displays the em-dash
      // "not tracked" badge, LEAVE IT ALONE. A stale cost arriving from a
      // batch fetch (e.g., during a provider toggle race) must not silently
      // replace the disclosure with a dollar amount. The render-side
      // branch in renderSessionItem already decided the row's provider
      // lacks cost support; trust that decision until next full re-render.
      if (sessionEl.querySelector('.session-badge-cost-na')) continue;

      // Try to find an existing cost badge
      let badge = sessionEl.querySelector('.session-badge-cost');
      if (badge) {
        if (badge.textContent !== costText) badge.textContent = costText;
      } else if (entry.cost > 0) {
        // Insert a new cost badge into the meta row
        const metaRow = sessionEl.querySelector('.ws-session-meta-row');
        if (metaRow) {
          badge = document.createElement('span');
          badge.className = 'session-badge session-badge-cost';
          badge.textContent = costText;
          metaRow.prepend(badge);
        }
      }
    }
  }

  async checkForConflicts() {
    try {
      const ws = this.state.activeWorkspace;
      if (!ws) {
        this._updateConflictBadge(0);
        return;
      }

      // Count running sessions in the active workspace
      const runningSessions = (this.state.allSessions || this.state.sessions || []).filter(s =>
        s.workspaceId === ws.id && s.status === 'running'
      );
      if (runningSessions.length < 2) {
        this._currentConflicts = [];
        this._updateConflictBadge(0);
        return;
      }

      const data = await this.api('GET', `/api/workspaces/${ws.id}/conflicts`);
      const conflicts = data.conflicts || [];

      // Store conflicts for the conflict center UI
      this._currentConflicts = conflicts;
      this._updateConflictBadge(conflicts.length);

      if (conflicts.length === 0) {
        this._lastConflictKeys.clear();
        return;
      }

      // Build a set of current conflict keys for deduplication
      const currentKeys = new Set(conflicts.map(c => c.file || c.path || 'unknown'));

      // Only show toasts for NEW conflicts (not already shown in a previous poll)
      const newConflicts = conflicts.filter(c => {
        const key = c.file || c.path || 'unknown';
        return !this._lastConflictKeys.has(key);
      });

      // Update the tracked set to match current conflicts
      this._lastConflictKeys = currentKeys;

      // Nothing new to show - all current conflicts were already toasted
      if (newConflicts.length === 0) return;

      // Show a single toast pointing to the conflict center
      if (newConflicts.length === 1) {
        const c = newConflicts[0];
        const fileName = c.file || c.path || 'unknown file';
        const sessionCount = c.sessions ? c.sessions.length : c.count || 2;
        this.showToast(`Conflict: ${fileName} edited by ${sessionCount} sessions - click ⚠ to view`, 'warning');
      } else {
        this.showToast(`${newConflicts.length} new file conflicts detected - click ⚠ to view`, 'warning');
      }

      // Auto-render conflict center if it's open
      if (this._conflictCenterOpen) this.renderConflictCenter();
    } catch {
      // Silently ignore conflict check failures
    }

    // Also run the global JSONL-based conflict check for per-pane badges
    this._checkJsonlConflicts();
  }

  /**
   * Global JSONL-based conflict detection across all active sessions.
   * Calls GET /api/conflicts to find files edited by multiple sessions
   * (based on Write/Edit tool_use blocks in JSONL data), then updates
   * per-pane conflict badges and shows toasts for new conflicts.
   */
  async _checkJsonlConflicts() {
    try {
      // Only check when terminal panes are in use
      const hasActivePanes = this.terminalPanes.some(p => p !== null);
      if (!hasActivePanes) {
        this._jsonlConflicts = [];
        this._paneConflictMap.clear();
        this._updatePaneConflictBadges();
        return;
      }

      const data = await this.api('GET', '/api/conflicts');
      const conflicts = data.conflicts || [];
      this._jsonlConflicts = conflicts;

      // Build per-session conflict map for pane badges
      this._paneConflictMap.clear();
      for (const conflict of conflicts) {
        for (const sess of (conflict.sessions || [])) {
          if (!this._paneConflictMap.has(sess.id)) {
            this._paneConflictMap.set(sess.id, []);
          }
          this._paneConflictMap.get(sess.id).push({
            file: conflict.file,
            sessions: conflict.sessions,
          });
        }
      }

      // Update per-pane conflict badges in the terminal grid
      this._updatePaneConflictBadges();

      // Show toasts for NEW JSONL-based conflicts only
      if (conflicts.length > 0) {
        const currentKeys = new Set(conflicts.map(c => c.file || 'unknown'));
        const newConflicts = conflicts.filter(c => {
          const key = c.file || 'unknown';
          return !this._lastJsonlConflictKeys.has(key);
        });
        this._lastJsonlConflictKeys = currentKeys;

        if (newConflicts.length > 0) {
          // Only toast if the workspace-level check didn't already toast these
          const wsKeys = this._lastConflictKeys || new Set();
          const uniqueNew = newConflicts.filter(c => !wsKeys.has(c.file || 'unknown'));
          if (uniqueNew.length === 1) {
            const c = uniqueNew[0];
            const fileName = (c.file || 'unknown').split('/').pop();
            this.showToast(`${c.sessions.length} sessions editing ${fileName}`, 'warning');
          } else if (uniqueNew.length > 1) {
            this.showToast(`${uniqueNew.length} file conflicts detected across sessions`, 'warning');
          }
        }
      } else {
        this._lastJsonlConflictKeys.clear();
      }
    } catch {
      // Silently ignore JSONL conflict check failures
    }
  }

  /**
   * Update amber conflict badges on terminal pane headers.
   * Shows a small amber dot/count next to the pane title when the session
   * has files that are also being edited by other sessions.
   */
  _updatePaneConflictBadges() {
    for (let i = 0; i < CWMApp.MAX_PANES; i++) {
      const tp = this.terminalPanes[i];
      const paneEl = document.getElementById(`term-pane-${i}`);
      if (!paneEl) continue;

      const header = paneEl.querySelector('.terminal-pane-header');
      if (!header) continue;

      // Remove existing conflict badge if any
      const existingBadge = header.querySelector('.pane-conflict-badge');

      if (tp && this._paneConflictMap.has(tp.sessionId)) {
        const conflicts = this._paneConflictMap.get(tp.sessionId);
        if (existingBadge) {
          existingBadge.textContent = conflicts.length;
          existingBadge.title = `${conflicts.length} file${conflicts.length > 1 ? 's' : ''} also edited by other sessions`;
        } else {
          const badge = document.createElement('span');
          badge.className = 'pane-conflict-badge';
          badge.textContent = conflicts.length;
          badge.title = `${conflicts.length} file${conflicts.length > 1 ? 's' : ''} also edited by other sessions`;
          const titleEl = header.querySelector('.terminal-pane-title');
          if (titleEl && titleEl.nextSibling) {
            header.insertBefore(badge, titleEl.nextSibling);
          } else {
            header.appendChild(badge);
          }
        }
      } else if (existingBadge) {
        existingBadge.remove();
      }
    }
  }

  /**
   * Get JSONL-based conflict data for a specific session.
   * Used by the terminal context menu to show per-session conflict details.
   * @param {string} sessionId - The session ID to look up
   * @returns {Array<{file: string, sessions: Array<{id: string, name: string}>}>}
   */
  getSessionConflicts(sessionId) {
    return this._paneConflictMap.get(sessionId) || [];
  }

  /**
   * Update the conflict indicator badge in the header.
   * @param {number} count - Number of active conflicts
   */
  _updateConflictBadge(count) {
    if (this.els.conflictIndicatorBtn) {
      this.els.conflictIndicatorBtn.hidden = count === 0;
    }
    if (this.els.conflictBadge) {
      this.els.conflictBadge.textContent = count;
    }
  }

  /**
   * Toggle the conflict center overlay open/closed.
   */
  toggleConflictCenter() {
    if (this._conflictCenterOpen) {
      this.closeConflictCenter();
    } else {
      this.openConflictCenter();
    }
  }

  /**
   * Open the conflict center overlay and render its content.
   */
  openConflictCenter() {
    this._conflictCenterOpen = true;
    if (this.els.conflictCenterOverlay) {
      this.els.conflictCenterOverlay.hidden = false;
    }
    // Refresh data and render
    this.checkForConflicts().then(() => this.renderConflictCenter());

    // Close on outside click
    this._conflictOutsideHandler = (e) => {
      if (this.els.conflictCenterOverlay && !this.els.conflictCenterOverlay.hidden &&
          !this.els.conflictCenterOverlay.contains(e.target) &&
          !e.target.closest('.conflict-indicator')) {
        this.closeConflictCenter();
      }
    };
    setTimeout(() => document.addEventListener('click', this._conflictOutsideHandler), 0);
  }

  /**
   * Close the conflict center overlay.
   */
  closeConflictCenter() {
    this._conflictCenterOpen = false;
    if (this.els.conflictCenterOverlay) {
      this.els.conflictCenterOverlay.hidden = true;
    }
    document.removeEventListener('click', this._conflictOutsideHandler);
  }

  /**
   * Render the conflict center list with current conflict data.
   */
  renderConflictCenter() {
    const list = this.els.conflictCenterList;
    if (!list) return;

    const conflicts = this._currentConflicts || [];

    // Update summary
    if (this.els.conflictCenterSummary) {
      if (conflicts.length === 0) {
        this.els.conflictCenterSummary.textContent = 'No conflicts detected';
      } else {
        const ws = this.state.activeWorkspace;
        this.els.conflictCenterSummary.textContent =
          `${conflicts.length} file${conflicts.length > 1 ? 's' : ''} edited by multiple sessions${ws ? ' in ' + ws.name : ''}`;
      }
    }

    if (conflicts.length === 0) {
      list.innerHTML = '<div class="conflict-empty">No file conflicts detected</div>';
      return;
    }

    // Collect session IDs currently open in terminal panes to protect them
    const activePaneSessionIds = new Set(
      this.terminalPanes.filter(p => p !== null).map(p => p.sessionId)
    );

    list.innerHTML = conflicts.map(c => {
      const filePath = c.file || c.path || 'unknown';
      const sessions = c.sessions || [];
      // Sessions that can be killed: not in any active terminal pane
      const killableSessions = sessions.filter(s => !activePaneSessionIds.has(s.id));
      const killableIds = killableSessions.map(s => s.id).join(',');

      return `
        <div class="conflict-file-card">
          <div class="conflict-file-header">
            <div class="conflict-file-path">${this.escapeHtml(filePath)}</div>
            ${killableSessions.length > 0 ? `
              <button class="conflict-auto-resolve-btn" data-kill-ids="${killableIds}" title="Stop ${killableSessions.length} session${killableSessions.length > 1 ? 's' : ''} not in active panes">
                Auto-resolve
              </button>
            ` : `
              <span class="conflict-auto-resolve-protected" title="All conflicting sessions are in active panes">Protected</span>
            `}
          </div>
          <div class="conflict-sessions">
            ${sessions.map(s => `
              <button class="conflict-session-chip${activePaneSessionIds.has(s.id) ? ' conflict-session-protected' : ''}" data-session-id="${s.id}" title="${activePaneSessionIds.has(s.id) ? 'Active pane (protected)' : 'Open in terminal'}">
                <span class="conflict-session-dot"></span>
                ${this.escapeHtml(s.name || s.id)}
                ${activePaneSessionIds.has(s.id) ? '<span class="conflict-protected-icon" title="In active pane">&#128274;</span>' : ''}
              </button>
            `).join('')}
          </div>
        </div>`;
    }).join('');

    // Wire up session chip clicks - jump to terminal
    list.querySelectorAll('.conflict-session-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = chip.dataset.sessionId;
        if (sessionId) {
          this._smFindOrOpenTerminal(sessionId);
          this.closeConflictCenter();
        }
      });
    });

    // Wire up auto-resolve buttons - stop sessions not in active panes
    list.querySelectorAll('.conflict-auto-resolve-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const killIds = (btn.dataset.killIds || '').split(',').filter(Boolean);
        if (killIds.length === 0) return;

        btn.disabled = true;
        btn.textContent = 'Stopping...';

        let stopped = 0;
        for (const id of killIds) {
          try {
            await this.api('POST', `/api/sessions/${id}/stop`);
            stopped++;
          } catch (_) {
            // Continue stopping others even if one fails
          }
        }

        this.showToast(`Auto-resolved: stopped ${stopped} session${stopped > 1 ? 's' : ''}`, 'success');
        await this.loadSessions();
        await this.loadStats();
        await this.checkForConflicts();
        this.renderConflictCenter();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     FEATURE TRACKING BOARD
     ═══════════════════════════════════════════════════════════ */

  async loadFeatureBoard() {
    const ws = this.state.activeWorkspace;
    if (!ws) return;

    try {
      const data = await this.api('GET', `/api/workspaces/${ws.id}/features`);
      this._features = data.features || [];
      this.renderFeatureBoard();
    } catch (err) {
      this.showToast(err.message || 'Failed to load features', 'error');
    }
  }

  renderFeatureBoard() {
    const features = this._features || [];
    const statuses = ['planned', 'active', 'review', 'done'];

    statuses.forEach(status => {
      const columnBody = document.querySelector(`.board-column-body[data-status="${status}"]`);
      const countEl = document.querySelector(`.board-column-count[data-count="${status}"]`);
      if (!columnBody) return;

      const statusFeatures = features.filter(f => f.status === status);
      if (countEl) countEl.textContent = statusFeatures.length;

      columnBody.innerHTML = statusFeatures.map(f => {
        const priorityClass = f.priority ? `board-card-priority-${f.priority}` : 'board-card-priority-normal';
        const sessionCount = (f.sessionIds || []).length;
        const desc = f.description ? `<div class="board-card-desc">${this.escapeHtml(f.description)}</div>` : '';

        return `<div class="board-card" draggable="true" data-feature-id="${f.id}">
          <div class="board-card-name">${this.escapeHtml(f.name)}</div>
          ${desc}
          <div class="board-card-meta">
            <span class="board-card-priority ${priorityClass}">${f.priority || 'normal'}</span>
            ${sessionCount > 0 ? `<span class="board-card-sessions">${sessionCount} session${sessionCount > 1 ? 's' : ''}</span>` : ''}
          </div>
        </div>`;
      }).join('') || '<div style="padding:12px;text-align:center;color:var(--surface2);font-size:11px">No features</div>';

      // Drag-and-drop handlers for column
      columnBody.addEventListener('dragover', (e) => {
        e.preventDefault();
        columnBody.classList.add('drag-over');
      });
      columnBody.addEventListener('dragleave', () => {
        columnBody.classList.remove('drag-over');
      });
      columnBody.addEventListener('drop', (e) => {
        e.preventDefault();
        columnBody.classList.remove('drag-over');
        const featureId = e.dataTransfer.getData('cwm/feature-id');
        if (featureId) this.moveFeature(featureId, status);
      });
    });

    // Card drag handlers
    document.querySelectorAll('.board-card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('cwm/feature-id', card.dataset.featureId);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
      });
      // Right-click for feature context menu
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showFeatureContextMenu(card.dataset.featureId, e.clientX, e.clientY);
      });
    });
  }

  async moveFeature(featureId, newStatus) {
    try {
      await this.api('PUT', `/api/features/${featureId}`, { status: newStatus });
      await this.loadFeatureBoard();
    } catch (err) {
      this.showToast(err.message || 'Failed to move feature', 'error');
    }
  }

  async createFeature() {
    const ws = this.state.activeWorkspace;
    if (!ws) return;

    const result = await this.showPromptModal({
      title: 'New Feature',
      fields: [
        { key: 'name', label: 'Feature Name', placeholder: 'User authentication', required: true },
        { key: 'description', label: 'Description', type: 'textarea', placeholder: 'Details about the feature...' },
        { key: 'priority', label: 'Priority', type: 'select', options: [
          { value: 'low', label: 'Low' },
          { value: 'normal', label: 'Normal' },
          { value: 'high', label: 'High' },
          { value: 'urgent', label: 'Urgent' },
        ]},
        { key: 'status', label: 'Status', type: 'select', options: [
          { value: 'planned', label: 'Planned' },
          { value: 'active', label: 'Active' },
          { value: 'review', label: 'Review' },
          { value: 'done', label: 'Done' },
        ]},
      ],
      confirmText: 'Create Feature',
    });

    if (!result) return;

    try {
      await this.api('POST', `/api/workspaces/${ws.id}/features`, {
        name: result.name,
        description: result.description || '',
        priority: result.priority || 'normal',
        status: result.status || 'planned',
      });
      await this.loadFeatureBoard();
      this.showToast('Feature created', 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to create feature', 'error');
    }
  }

  showFeatureContextMenu(featureId, x, y) {
    const feature = (this._features || []).find(f => f.id === featureId);
    if (!feature) return;

    const ws = this.state.activeWorkspace;
    const wsSessions = (this.state.allSessions || this.state.sessions).filter(s => s.workspaceId === ws?.id);

    const items = [
      { label: 'Edit', icon: '&#9998;', action: () => this.editFeature(featureId) },
      { type: 'sep' },
      { label: 'Move to Planned', icon: '&#128203;', action: () => this.moveFeature(featureId, 'planned'), disabled: feature.status === 'planned' },
      { label: 'Move to Active', icon: '&#9889;', action: () => this.moveFeature(featureId, 'active'), disabled: feature.status === 'active' },
      { label: 'Move to Review', icon: '&#128269;', action: () => this.moveFeature(featureId, 'review'), disabled: feature.status === 'review' },
      { label: 'Move to Done', icon: '&#10004;', action: () => this.moveFeature(featureId, 'done'), disabled: feature.status === 'done' },
      { type: 'sep' },
    ];

    // Link session option
    if (wsSessions.length > 0) {
      items.push({ label: 'Link Session...', icon: '&#128279;', action: () => this.linkSessionToFeature(featureId, wsSessions) });
    }

    // Show linked sessions
    if (feature.sessionIds && feature.sessionIds.length > 0) {
      items.push({ type: 'sep' });
      feature.sessionIds.forEach(sid => {
        const sess = wsSessions.find(s => s.id === sid);
        if (sess) {
          items.push({ label: `Unlink: ${sess.name}`, icon: '&#10005;', action: () => this.unlinkSessionFromFeature(featureId, sid) });
        }
      });
    }

    items.push({ type: 'sep' });
    items.push({ label: 'Delete Feature', icon: '&#10005;', action: () => this.deleteFeature(featureId), danger: true });

    this._renderContextItems(feature.name, items, x, y);
  }

  async editFeature(featureId) {
    const feature = (this._features || []).find(f => f.id === featureId);
    if (!feature) return;

    const result = await this.showPromptModal({
      title: 'Edit Feature',
      fields: [
        { key: 'name', label: 'Feature Name', value: feature.name, required: true },
        { key: 'description', label: 'Description', type: 'textarea', value: feature.description || '' },
        { key: 'priority', label: 'Priority', type: 'select', value: feature.priority, options: [
          { value: 'low', label: 'Low' },
          { value: 'normal', label: 'Normal' },
          { value: 'high', label: 'High' },
          { value: 'urgent', label: 'Urgent' },
        ]},
      ],
      confirmText: 'Save Changes',
    });

    if (!result) return;

    try {
      await this.api('PUT', `/api/features/${featureId}`, {
        name: result.name,
        description: result.description || '',
        priority: result.priority || feature.priority,
      });
      await this.loadFeatureBoard();
      this.showToast('Feature updated', 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to update feature', 'error');
    }
  }

  async linkSessionToFeature(featureId, wsSessions) {
    // Filter out already-linked sessions
    const feature = (this._features || []).find(f => f.id === featureId);
    if (!feature) return;
    const linkedIds = new Set(feature.sessionIds || []);
    const available = wsSessions.filter(s => !linkedIds.has(s.id));

    if (available.length === 0) {
      this.showToast('All sessions already linked', 'info');
      return;
    }

    const options = available.map(s => ({ value: s.id, label: s.name }));
    const result = await this.showPromptModal({
      title: 'Link Session to Feature',
      fields: [
        { key: 'sessionId', label: 'Session', type: 'select', options, required: true },
      ],
      confirmText: 'Link',
    });

    if (result && result.sessionId) {
      try {
        await this.api('POST', `/api/features/${featureId}/sessions/${result.sessionId}`);
        await this.loadFeatureBoard();
        this.showToast('Session linked', 'success');
      } catch (err) {
        this.showToast(err.message || 'Failed to link session', 'error');
      }
    }
  }

  async unlinkSessionFromFeature(featureId, sessionId) {
    try {
      await this.api('DELETE', `/api/features/${featureId}/sessions/${sessionId}`);
      await this.loadFeatureBoard();
      this.showToast('Session unlinked', 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to unlink session', 'error');
    }
  }

  async deleteFeature(featureId) {
    const confirmed = await this.showConfirmModal({
      title: 'Delete Feature',
      message: 'This feature will be permanently deleted. Continue?',
      confirmText: 'Delete',
    });

    if (!confirmed) return;

    try {
      await this.api('DELETE', `/api/features/${featureId}`);
      await this.loadFeatureBoard();
      this.showToast('Feature deleted', 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to delete feature', 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     SESSION MANAGER OVERLAY
     Click stat chips (running/total) to open a session management panel
     ═══════════════════════════════════════════════════════════ */

  /**
   * Toggle the session manager overlay. Opens with the given filter or closes if already open with same filter.
   * @param {string} filter - 'all', 'running', or 'stopped'
   */
  toggleSessionManager(filter = 'all') {
    if (this._smOpen && this._smFilter === filter) {
      this.closeSessionManager();
      return;
    }
    this._smFilter = filter;
    this._smOpen = true;
    this._smSelectedIds = new Set();

    // Set active filter button
    if (this.els.sessionManagerOverlay) {
      this.els.sessionManagerOverlay.querySelectorAll('.sm-filter').forEach(f => {
        f.classList.toggle('active', f.dataset.filter === filter);
      });
      this.els.sessionManagerOverlay.hidden = false;
    }

    // Attach outside-click listener
    setTimeout(() => document.addEventListener('click', this._smOutsideClickHandler), 0);

    this.renderSessionManager();
  }

  /**
   * Close the session manager overlay and clean up listeners.
   */
  closeSessionManager() {
    this._smOpen = false;
    this._smSelectedIds = new Set();
    if (this.els.sessionManagerOverlay) {
      this.els.sessionManagerOverlay.hidden = true;
    }
    document.removeEventListener('click', this._smOutsideClickHandler);
  }

  /**
   * Render the session list inside the session manager overlay based on current filter.
   */
  renderSessionManager() {
    const list = this.els.sessionManagerList;
    if (!list) return;

    const allSessions = this.state.allSessions || [];
    let filtered = allSessions;

    // Apply filter
    if (this._smFilter === 'running') {
      filtered = allSessions.filter(s => s.status === 'running');
    } else if (this._smFilter === 'stopped') {
      filtered = allSessions.filter(s => s.status !== 'running');
    }

    // Build workspace name lookup
    const wsMap = {};
    (this.state.workspaces || []).forEach(w => { wsMap[w.id] = w.name; });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="sm-empty">No sessions found</div>';
      this._updateSmButtons();
      return;
    }

    // Sort: running first, then by name
    filtered.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    list.innerHTML = filtered.map(s => {
      const statusClass = s.status === 'running' ? 'running' : (s.status === 'error' ? 'error' : 'stopped');
      const wsName = wsMap[s.workspaceId] || '';
      const checked = this._smSelectedIds && this._smSelectedIds.has(s.id) ? 'checked' : '';
      const selectedClass = checked ? ' selected' : '';
      const isRunning = s.status === 'running';

      return `
        <div class="sm-session-row${selectedClass}" data-session-id="${s.id}">
          <input type="checkbox" class="sm-session-checkbox" data-id="${s.id}" ${checked}>
          <span class="sm-status-dot ${statusClass}"></span>
          <div class="sm-session-info">
            <span class="sm-session-name">${this.escapeHtml(s.name || s.id)}</span>
            <span class="sm-session-meta">${this.escapeHtml(s.workingDir || '')}</span>
          </div>
          ${wsName ? `<span class="sm-workspace-badge">${this.escapeHtml(wsName)}</span>` : ''}
          <div class="sm-session-actions">
            <button class="sm-action-btn terminal-btn" data-action="terminal" data-id="${s.id}" title="Open in terminal">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4.5l3 2.5-3 2.5M7.5 10H11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            ${isRunning
              ? `<button class="sm-action-btn stop-btn" data-action="stop" data-id="${s.id}" title="Stop session">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
                </button>`
              : `<button class="sm-action-btn start-btn" data-action="start" data-id="${s.id}" title="Start session">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 2.5l8 4.5-8 4.5V2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                </button>`
            }
          </div>
        </div>`;
    }).join('');

    // Wire up event listeners on the rendered rows
    list.querySelectorAll('.sm-session-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = cb.dataset.id;
        if (cb.checked) {
          this._smSelectedIds.add(id);
        } else {
          this._smSelectedIds.delete(id);
        }
        cb.closest('.sm-session-row').classList.toggle('selected', cb.checked);
        this._updateSmButtons();
      });
    });

    list.querySelectorAll('.sm-action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'terminal') {
          this._smFindOrOpenTerminal(id);
        } else if (action === 'stop') {
          this.stopSession(id);
        } else if (action === 'start') {
          this.startSession(id);
        }
      });
    });

    // Click row to open in terminal
    list.querySelectorAll('.sm-session-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't trigger on checkbox or action button clicks
        if (e.target.closest('.sm-session-checkbox') || e.target.closest('.sm-action-btn')) return;
        this._smFindOrOpenTerminal(row.dataset.sessionId);
      });
    });

    this._updateSmButtons();
  }

  /**
   * Update the state of the "Select All" and "Stop Selected" buttons.
   */
  _updateSmButtons() {
    if (!this.els.smStopSelectedBtn || !this.els.smSelectAllBtn) return;

    const selectedCount = this._smSelectedIds ? this._smSelectedIds.size : 0;
    const allSessions = this.state.allSessions || [];

    // Check if any selected sessions are running
    const hasRunningSelected = selectedCount > 0 && allSessions.some(s =>
      this._smSelectedIds.has(s.id) && s.status === 'running'
    );

    this.els.smStopSelectedBtn.disabled = !hasRunningSelected;
    this.els.smStopSelectedBtn.textContent = selectedCount > 0
      ? `Stop Selected (${selectedCount})`
      : 'Stop Selected';

    // Update "Select All" text
    const list = this.els.sessionManagerList;
    const visibleCount = list ? list.querySelectorAll('.sm-session-row').length : 0;
    this.els.smSelectAllBtn.textContent = selectedCount >= visibleCount && visibleCount > 0
      ? 'Deselect All'
      : 'Select All';
  }

  /**
   * Toggle select all / deselect all visible sessions.
   */
  smToggleSelectAll() {
    const list = this.els.sessionManagerList;
    if (!list) return;

    const checkboxes = list.querySelectorAll('.sm-session-checkbox');
    const allChecked = this._smSelectedIds && this._smSelectedIds.size >= checkboxes.length && checkboxes.length > 0;

    if (allChecked) {
      // Deselect all
      this._smSelectedIds = new Set();
      checkboxes.forEach(cb => {
        cb.checked = false;
        cb.closest('.sm-session-row').classList.remove('selected');
      });
    } else {
      // Select all visible
      this._smSelectedIds = new Set();
      checkboxes.forEach(cb => {
        cb.checked = true;
        this._smSelectedIds.add(cb.dataset.id);
        cb.closest('.sm-session-row').classList.add('selected');
      });
    }
    this._updateSmButtons();
  }

  /**
   * Stop all selected running sessions.
   */
  async smStopSelected() {
    if (!this._smSelectedIds || this._smSelectedIds.size === 0) return;

    const allSessions = this.state.allSessions || [];
    const toStop = allSessions.filter(s => this._smSelectedIds.has(s.id) && s.status === 'running');

    if (toStop.length === 0) {
      this.showToast('No running sessions selected', 'info');
      return;
    }

    // Stop all selected running sessions in parallel
    const results = await Promise.allSettled(
      toStop.map(s => this.api('POST', `/api/sessions/${s.id}/stop`))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      this.showToast(`Stopped ${succeeded}, failed ${failed}`, 'warning');
    } else {
      this.showToast(`Stopped ${succeeded} session${succeeded !== 1 ? 's' : ''}`, 'success');
    }

    // Clear selection and refresh
    this._smSelectedIds = new Set();
    await this.loadSessions();
    await this.loadStats();
    this.renderSessionManager();
  }

  /**
   * Find an existing terminal pane with this session or open a new one.
   * @param {string} sessionId - The session ID to open
   */
  _smFindOrOpenTerminal(sessionId) {
    // Check if session is already open in a terminal pane
    for (let i = 0; i < this.terminalPanes.length; i++) {
      const pane = this.terminalPanes[i];
      if (pane && pane.sessionId === sessionId) {
        // Already open - switch to terminal view and activate that pane
        this.setViewMode('terminal');
        this._activeTerminalSlot = i;
        this._syncTerminalTabHighlight();
        this.closeSessionManager();
        this.showToast('Switched to existing terminal pane', 'info');
        return;
      }
    }

    // Not open yet - find an empty slot
    const emptySlot = this.terminalPanes.findIndex(p => p === null);
    if (emptySlot === -1) {
      this.showToast('No empty terminal pane - close one first', 'warning');
      return;
    }

    // Find session data
    const session = (this.state.allSessions || []).find(s => s.id === sessionId);
    if (!session) {
      this.showToast('Session not found', 'error');
      return;
    }

    // Open terminal
    const spawnOpts = {};
    if (session.workingDir) spawnOpts.cwd = session.workingDir;
    if (session.bypassPermissions) spawnOpts.bypassPermissions = true;
    if (session.agentTeams) spawnOpts.agentTeams = true;

    this.setViewMode('terminal');
    this.openTerminalInPane(emptySlot, session.id, session.name, spawnOpts);
    this.closeSessionManager();
  }

  /* ═══════════════════════════════════════════════════════════
     SESSION LAUNCHER
     ═══════════════════════════════════════════════════════════ */

  /**
   * Open the session launcher modal.
   * Fetches discovered projects, merges with workspace sessions, and renders
   * a frecency-ranked list with fuzzy search and pin support.
   */
  async openLauncher() {
    if (!this.els.launcherOverlay) return;

    // Reset state
    this._launcherProjects = [];
    this._launcherSelectedDir = null;
    this._launcherPinnedDirs = JSON.parse(localStorage.getItem('cwm_pinnedDirs') || '[]');
    this.els.launcherSearch.value = '';
    this.els.launcherForm.hidden = true;
    this.els.launcherSessionName.value = '';
    this.els.launcherModel.value = '';
    this.els.launcherList.innerHTML = '<div class="launcher-empty">Loading projects...</div>';
    this.els.launcherOverlay.hidden = false;

    // Focus search input after animation
    requestAnimationFrame(() => this.els.launcherSearch.focus());

    // Keyboard handler for Escape
    this._launcherKeyHandler = (e) => {
      if (e.key === 'Escape') this.closeLauncher();
    };
    document.addEventListener('keydown', this._launcherKeyHandler);

    try {
      // Fetch discovered projects
      // Phase 18-04: native v1.2 shape (Phase 15 back-compat shim retired).
      // Same merge helper as loadProjects/discoverSessions so the launcher
      // sees the sorted-by-mtime flat list it expects.
      const data = await this.api('GET', '/api/discover');
      const discovered = this._mergeProjectsByProvider(data.projects || {});

      // Build session count map from current sessions for frecency ranking
      const sessionsByDir = {};
      const allSessions = this.state.allSessions || this.state.sessions || [];
      for (const s of allSessions) {
        if (!s.workingDir) continue;
        const dir = s.workingDir.replace(/\\/g, '/').toLowerCase();
        if (!sessionsByDir[dir]) sessionsByDir[dir] = { count: 0, lastActive: null };
        sessionsByDir[dir].count++;
        if (s.lastActive && (!sessionsByDir[dir].lastActive || new Date(s.lastActive) > new Date(sessionsByDir[dir].lastActive))) {
          sessionsByDir[dir].lastActive = s.lastActive;
        }
      }

      // Merge discovered projects with session frequency data
      const projects = discovered.map(p => {
        const dirKey = (p.realPath || '').replace(/\\/g, '/').toLowerCase();
        const sessionData = sessionsByDir[dirKey] || { count: 0, lastActive: null };
        // Extract a readable project name from the path
        const pathParts = (p.realPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
        const name = pathParts[pathParts.length - 1] || p.encodedName;

        return {
          name,
          path: p.realPath || '',
          encodedName: p.encodedName,
          sessionCount: p.sessionCount || 0,
          localSessionCount: sessionData.count,
          lastActive: p.lastActive || sessionData.lastActive,
          hasClaudeMd: p.hasClaudeMd,
          dirExists: p.dirExists !== false,
          pinned: this._launcherPinnedDirs.includes(p.realPath),
        };
      });

      // Also add workspace directories not found in discovered projects
      for (const ws of (this.state.workspaces || [])) {
        const wsSessions = allSessions.filter(s => s.workspaceId === ws.id);
        const dirs = new Set(wsSessions.map(s => s.workingDir).filter(Boolean));
        for (const dir of dirs) {
          const dirKey = dir.replace(/\\/g, '/').toLowerCase();
          const alreadyListed = projects.some(p => (p.path || '').replace(/\\/g, '/').toLowerCase() === dirKey);
          if (!alreadyListed) {
            const pathParts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
            const name = pathParts[pathParts.length - 1] || dir;
            const sessionData = sessionsByDir[dirKey] || { count: 0, lastActive: null };
            projects.push({
              name,
              path: dir,
              encodedName: '',
              sessionCount: sessionData.count,
              localSessionCount: sessionData.count,
              lastActive: sessionData.lastActive,
              hasClaudeMd: false,
              dirExists: true,
              pinned: this._launcherPinnedDirs.includes(dir),
            });
          }
        }
      }

      // Sort by frecency: pinned first, then by lastActive (most recent first), then by session count
      projects.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.lastActive && b.lastActive) return new Date(b.lastActive) - new Date(a.lastActive);
        if (a.lastActive) return -1;
        if (b.lastActive) return 1;
        return b.sessionCount - a.sessionCount;
      });

      this._launcherProjects = projects;
      this.renderLauncherProjects();

    } catch (err) {
      this.els.launcherList.innerHTML = `<div class="launcher-empty">Failed to load projects: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  /**
   * Close the session launcher modal and clean up event listeners.
   */
  closeLauncher() {
    if (this.els.launcherOverlay) this.els.launcherOverlay.hidden = true;
    if (this._launcherKeyHandler) {
      document.removeEventListener('keydown', this._launcherKeyHandler);
      this._launcherKeyHandler = null;
    }
    this._launcherSelectedDir = null;
  }

  /**
   * Render the project rows in the launcher list.
   * Groups projects into Pinned, Recent, and All sections.
   * @param {string} [filterQuery] - Optional lowercase search query for fuzzy filtering
   */
  renderLauncherProjects(filterQuery) {
    const projects = this._launcherProjects || [];
    if (projects.length === 0) {
      this.els.launcherList.innerHTML = '<div class="launcher-empty">No projects discovered. Run Claude Code in a project first.</div>';
      return;
    }

    // Apply fuzzy filter if query is provided
    let filtered = projects;
    if (filterQuery) {
      filtered = projects.filter(p => {
        const haystack = (p.name + ' ' + p.path).toLowerCase();
        return haystack.includes(filterQuery);
      });
    }

    if (filtered.length === 0) {
      this.els.launcherList.innerHTML = '<div class="launcher-empty">No matching projects</div>';
      return;
    }

    // Group into sections
    const pinned = filtered.filter(p => p.pinned);
    const recent = filtered.filter(p => !p.pinned && p.lastActive);
    const rest = filtered.filter(p => !p.pinned && !p.lastActive);

    let html = '';

    // Pinned section
    if (pinned.length > 0) {
      html += '<div class="launcher-section-label">Pinned</div>';
      html += pinned.map(p => this._renderLauncherRow(p)).join('');
    }

    // Recent section
    if (recent.length > 0) {
      html += '<div class="launcher-section-label">Recent</div>';
      html += recent.map(p => this._renderLauncherRow(p)).join('');
    }

    // All section (no activity)
    if (rest.length > 0) {
      html += '<div class="launcher-section-label">All Projects</div>';
      html += rest.map(p => this._renderLauncherRow(p)).join('');
    }

    this.els.launcherList.innerHTML = html;

    // Bind click handlers for project rows
    this.els.launcherList.querySelectorAll('.launcher-project-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't trigger row select when clicking pin button
        if (e.target.closest('.launcher-pin-btn')) return;
        this.selectLauncherProject(row.dataset.path, row.dataset.name);
      });
    });

    // Bind pin button handlers
    this.els.launcherList.querySelectorAll('.launcher-pin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleLauncherPin(btn.dataset.path);
      });
    });
  }

  /**
   * Render a single project row in the launcher list.
   * @param {Object} p - Project data object
   * @returns {string} HTML string for the row
   */
  _renderLauncherRow(p) {
    const isSelected = this._launcherSelectedDir === p.path;
    const timeStr = p.lastActive ? this.relativeTime(p.lastActive) : '';
    const pinClass = p.pinned ? ' pinned' : '';
    const pinLabel = p.pinned ? '&#9733;' : '&#9734;';
    const badges = [];
    if (p.hasClaudeMd) badges.push('<span class="launcher-project-badge">CLAUDE.md</span>');
    if (!p.dirExists) badges.push('<span class="launcher-project-badge" style="background:color-mix(in srgb, var(--red) 15%, transparent);color:var(--red);">missing</span>');

    return `<div class="launcher-project-row${isSelected ? ' selected' : ''}" data-path="${this.escapeHtml(p.path)}" data-name="${this.escapeHtml(p.name)}">
      <div class="launcher-project-info">
        <div class="launcher-project-name">${this.escapeHtml(p.name)} ${badges.join(' ')}</div>
        <div class="launcher-project-path">${this.escapeHtml(p.path)}</div>
      </div>
      <div class="launcher-project-meta">
        ${timeStr ? `<span class="launcher-project-time">${timeStr}</span>` : ''}
        <button class="launcher-pin-btn${pinClass}" data-path="${this.escapeHtml(p.path)}" title="${p.pinned ? 'Unpin' : 'Pin'}">${pinLabel}</button>
      </div>
    </div>`;
  }

  /**
   * Filter the launcher project list based on the search input value.
   */
  filterLauncherProjects() {
    const query = (this.els.launcherSearch.value || '').trim().toLowerCase();
    this.renderLauncherProjects(query || undefined);
  }

  /**
   * Select a project in the launcher, populating the bottom form.
   * @param {string} dirPath - The full directory path of the selected project
   * @param {string} name - The display name of the project
   */
  selectLauncherProject(dirPath, name) {
    this._launcherSelectedDir = dirPath;

    // Highlight the selected row
    this.els.launcherList.querySelectorAll('.launcher-project-row').forEach(row => {
      row.classList.toggle('selected', row.dataset.path === dirPath);
    });

    // Show and populate the form
    this.els.launcherForm.hidden = false;
    this.els.launcherFormSelected.innerHTML = `<strong>${this.escapeHtml(name)}</strong> - ${this.escapeHtml(dirPath)}`;

    // Auto-generate a session name from the project directory name
    if (!this.els.launcherSessionName.value) {
      this.els.launcherSessionName.value = name + ' - new';
    }

    // Scroll form into view
    this.els.launcherForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * Toggle the pinned state of a project directory in the launcher.
   * Pinned dirs are persisted to localStorage under key 'cwm_pinnedDirs'.
   * @param {string} dirPath - The directory path to pin/unpin
   */
  toggleLauncherPin(dirPath) {
    const idx = this._launcherPinnedDirs.indexOf(dirPath);
    if (idx !== -1) {
      this._launcherPinnedDirs.splice(idx, 1);
    } else {
      this._launcherPinnedDirs.push(dirPath);
    }
    localStorage.setItem('cwm_pinnedDirs', JSON.stringify(this._launcherPinnedDirs));

    // Update the project data and re-render
    for (const p of (this._launcherProjects || [])) {
      p.pinned = this._launcherPinnedDirs.includes(p.path);
    }

    // Re-sort: pinned first
    this._launcherProjects.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.lastActive && b.lastActive) return new Date(b.lastActive) - new Date(a.lastActive);
      if (a.lastActive) return -1;
      if (b.lastActive) return 1;
      return b.sessionCount - a.sessionCount;
    });

    const query = (this.els.launcherSearch.value || '').trim().toLowerCase();
    this.renderLauncherProjects(query || undefined);
  }

  /**
   * Launch a new Claude Code session in the selected project directory.
   * Creates the session via API, opens a terminal pane, and switches to terminal view.
   */
  async launchSelectedProject() {
    const dir = this._launcherSelectedDir;
    if (!dir) {
      this.showToast('Select a project first', 'warning');
      return;
    }

    const name = this.els.launcherSessionName.value.trim() || 'new-session';
    const model = this.els.launcherModel.value || undefined;

    // Disable submit button to prevent double-click
    this.els.launcherSubmit.disabled = true;
    this.els.launcherSubmit.textContent = 'Launching...';

    try {
      // Find or create a workspace for this project
      const dirParts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
      const projectName = dirParts[dirParts.length - 1] || 'project';

      // Check if a workspace already exists for this directory
      let workspaceId = null;
      for (const ws of (this.state.workspaces || [])) {
        const wsSessions = (this.state.allSessions || []).filter(s => s.workspaceId === ws.id);
        if (wsSessions.some(s => s.workingDir && s.workingDir.replace(/\\/g, '/').toLowerCase() === dir.replace(/\\/g, '/').toLowerCase())) {
          workspaceId = ws.id;
          break;
        }
      }

      // If no workspace matched by directory, try matching by project folder name
      if (!workspaceId) {
        const matchByName = (this.state.workspaces || []).find(
          ws => ws.name.toLowerCase() === projectName.toLowerCase()
        );
        if (matchByName) workspaceId = matchByName.id;
      }

      // If still no workspace found, auto-create one for this project
      if (!workspaceId) {
        const wsData = await this.api('POST', '/api/workspaces', { name: projectName });
        const newWs = wsData.workspace || wsData;
        workspaceId = newWs.id;
        await this.loadWorkspaces();
      }

      const payload = {
        name,
        workingDir: dir,
        workspaceId,
        command: 'claude', // gsd:provider-literal-allowed (v1.1 frontend default; refactor deferred to Phase 18)
      };
      if (model) payload.model = model;

      const data = await this.api('POST', '/api/sessions', payload);
      const session = data.session || data;

      this.showToast(`Session "${session.name}" created`, 'success');
      await this.loadSessions();
      await this.loadStats();

      // Open in a terminal pane
      const emptySlot = this.terminalPanes.findIndex(p => p === null);
      if (emptySlot !== -1) {
        const spawnOpts = { cwd: dir };
        if (model) spawnOpts.model = model;
        this.setViewMode('terminal');
        this.openTerminalInPane(emptySlot, session.id, session.name, spawnOpts);
      } else {
        this.showToast('All terminal panes full. Close one first.', 'warning');
      }

      this.closeLauncher();

    } catch (err) {
      this.showToast(err.message || 'Failed to create session', 'error');
    } finally {
      // Re-enable submit button
      if (this.els.launcherSubmit) {
        this.els.launcherSubmit.disabled = false;
        this.els.launcherSubmit.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg> Launch`;
      }
    }
  }

  /**
   * Sync the terminal tab strip highlight to the active slot.
   */
  _syncTerminalTabHighlight() {
    if (!this.els.terminalTabStrip) return;
    const tabs = this.els.terminalTabStrip.querySelectorAll('.terminal-tab');
    tabs.forEach((tab, i) => {
      tab.classList.toggle('active', i === this._activeTerminalSlot);
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     PAIR MOBILE
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Initialize pair mobile button click, modal close, tab switching, and badge.
   * Called during app initialization after auth is established.
   */
  initPairMobile() {
    const btn = document.getElementById('pair-mobile-btn');
    const overlay = document.getElementById('pair-mobile-overlay');
    const closeBtn = document.getElementById('pair-mobile-close-btn');
    if (!btn || !overlay) return;

    // Open modal on button click
    btn.addEventListener('click', () => this.showPairMobileModal());

    // Close modal
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closePairMobileModal());
    }

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closePairMobileModal();
    });

    // Tab switching
    overlay.querySelectorAll('.pair-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.pair-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        const qrTab = document.getElementById('pair-qr-tab');
        const devicesTab = document.getElementById('pair-devices-tab');
        if (qrTab) qrTab.hidden = (tabName !== 'qr');
        if (devicesTab) devicesTab.hidden = (tabName !== 'devices');

        // Refresh devices when switching to that tab
        if (tabName === 'devices') this.loadPairedDevices();
      });
    });

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) {
        this.closePairMobileModal();
      }
    });

    // Event delegation for device action buttons
    const devicesList = document.getElementById('pair-devices-list');
    if (devicesList) {
      devicesList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const deviceId = btn.dataset.deviceId;
        if (action && deviceId) this.handleDeviceAction(action, deviceId, btn);
      });
    }

    // Update badge on load
    this.updatePairBadge();
  }

  /**
   * Show the pair mobile modal, fetch QR code and start auto-refresh timer.
   * Loads pairing code for QR tab and devices for the devices tab.
   */
  async showPairMobileModal() {
    const overlay = document.getElementById('pair-mobile-overlay');
    if (!overlay) return;
    overlay.hidden = false;

    // Reset to QR tab
    overlay.querySelectorAll('.pair-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === 'qr');
    });
    const qrTab = document.getElementById('pair-qr-tab');
    const devicesTab = document.getElementById('pair-devices-tab');
    if (qrTab) qrTab.hidden = false;
    if (devicesTab) devicesTab.hidden = true;

    // Load QR code
    await this.loadPairingCode();

    // Load devices in background
    this.loadPairedDevices();

    // Auto-refresh QR every 4 minutes (token expires at 5 min)
    this._pairRefreshTimer = setInterval(() => this.loadPairingCode(), 4 * 60 * 1000);

    // Start countdown display
    this._startPairCountdown();
  }

  /**
   * Close the pair mobile modal and clean up timers.
   */
  closePairMobileModal() {
    const overlay = document.getElementById('pair-mobile-overlay');
    if (overlay) overlay.hidden = true;

    // Clear auto-refresh timer
    if (this._pairRefreshTimer) {
      clearInterval(this._pairRefreshTimer);
      this._pairRefreshTimer = null;
    }

    // Clear countdown timer
    if (this._pairCountdownTimer) {
      clearInterval(this._pairCountdownTimer);
      this._pairCountdownTimer = null;
    }
  }

  /**
   * Fetch a pairing code from the server and render the QR code SVG.
   * Also displays detected connection URLs below the QR code.
   */
  async loadPairingCode() {
    const container = document.getElementById('pair-qr-container');
    const urlsEl = document.getElementById('pair-urls');
    if (!container) return;

    try {
      const res = await this.api('GET', '/api/auth/pairing-code');

      // Generate QR SVG using the bundled qrcode library
      const textColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--text').trim() || '#cdd6f4';

      const svg = await QRCode.toString(res.qrPayload, {
        type: 'svg',
        width: 256,
        margin: 2,
        color: {
          dark: textColor,
          light: '#00000000'
        }
      });

      container.innerHTML = svg;

      // Parse URLs from qrPayload
      let payload;
      try {
        payload = JSON.parse(res.qrPayload);
      } catch (_) {
        payload = {};
      }

      // Render detected connection URLs
      if (urlsEl && payload.urls) {
        const urlEntries = Object.entries(payload.urls)
          .filter(([, v]) => v != null && v !== '');

        if (urlEntries.length > 0) {
          urlsEl.innerHTML = urlEntries.map(([label, url]) => `
            <div class="pair-url-row">
              <span class="pair-url-label">${this.escapeHtml(label)}</span>
              <span class="pair-url-value" title="${this.escapeHtml(url)}">${this.escapeHtml(url)}</span>
              <button class="pair-url-copy" data-url="${this.escapeHtml(url)}" title="Copy URL">Copy</button>
            </div>
          `).join('');

          // Bind copy buttons
          urlsEl.querySelectorAll('.pair-url-copy').forEach(btn => {
            btn.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(btn.dataset.url);
                btn.textContent = 'Copied';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
              } catch (_) {
                this.showToast('Failed to copy URL', 'error');
              }
            });
          });
        } else {
          urlsEl.innerHTML = '';
        }
      }

      // Store expiry for countdown
      this._pairExpiresAt = res.expiresAt ? new Date(res.expiresAt) : null;
      this._startPairCountdown();

    } catch (err) {
      container.innerHTML = `<div class="pair-qr-placeholder" style="color: var(--red);">
        Failed to load pairing code: ${this.escapeHtml(err.message)}
      </div>`;
    }
  }

  /**
   * Start or restart the countdown timer showing time until QR auto-refresh.
   * Updates the pair-timer element every second.
   */
  _startPairCountdown() {
    const timerEl = document.getElementById('pair-timer');
    if (!timerEl) return;

    // Clear previous countdown
    if (this._pairCountdownTimer) {
      clearInterval(this._pairCountdownTimer);
    }

    const update = () => {
      if (!this._pairExpiresAt) {
        timerEl.textContent = '';
        return;
      }
      const remaining = Math.max(0, Math.floor((this._pairExpiresAt.getTime() - Date.now()) / 1000));
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      timerEl.textContent = remaining > 0
        ? `Refreshes in ${mins}:${String(secs).padStart(2, '0')}`
        : 'Refreshing...';
    };

    update();
    this._pairCountdownTimer = setInterval(update, 1000);
  }

  /**
   * Load paired devices from the server and render the device list.
   * Each device shows name, platform, online status, push status, and action buttons.
   */
  async loadPairedDevices() {
    const listEl = document.getElementById('pair-devices-list');
    if (!listEl) return;

    try {
      const res = await this.api('GET', '/api/devices');
      const devices = res.devices || [];

      if (devices.length === 0) {
        listEl.innerHTML = '<div class="pair-devices-empty">No paired devices</div>';
        return;
      }

      listEl.innerHTML = devices.map(d => {
        const platformIcon = d.platform === 'ios' ? '\uD83D\uDCF1' : '\uD83E\uDD16';
        const onlineClass = d.isOnline ? 'online' : '';
        const pairedTime = d.pairedAt ? this.relativeTime(d.pairedAt) : 'unknown';
        const lastSeen = d.isOnline ? 'Online' : (d.lastSeenAt ? this.relativeTime(d.lastSeenAt) : 'never');
        const pushStatus = d.pushToken
          ? '<span class="push-registered">Registered</span>'
          : '<span class="push-none">Not registered</span>';
        const testDisabled = d.pushToken ? '' : 'disabled';

        return `
          <div class="pair-device-card" data-device-id="${this.escapeHtml(d.deviceId)}">
            <div class="device-icon">${platformIcon}</div>
            <div class="device-info">
              <div class="device-name">
                <span class="device-online-dot ${onlineClass}"></span>
                ${this.escapeHtml(d.deviceName || 'Unknown Device')}
              </div>
              <div class="device-meta">
                ${this.escapeHtml(d.platform || 'unknown')} \u00B7 Paired ${pairedTime} \u00B7 ${lastSeen}
              </div>
              <div class="device-push-status">
                Push: ${pushStatus}
              </div>
            </div>
            <div class="device-actions">
              <button class="btn btn-ghost btn-sm" data-action="test-push" data-device-id="${this.escapeHtml(d.deviceId)}" ${testDisabled}>Test Push</button>
              <button class="btn btn-ghost btn-sm btn-danger" data-action="revoke" data-device-id="${this.escapeHtml(d.deviceId)}">Revoke</button>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="pair-devices-empty" style="color: var(--red);">
        Failed to load devices: ${this.escapeHtml(err.message)}
      </div>`;
    }
  }

  /**
   * Handle device action button clicks (test-push or revoke).
   * @param {string} action - 'test-push' or 'revoke'
   * @param {string} deviceId - The device UUID
   * @param {HTMLElement} btn - The button that was clicked
   */
  async handleDeviceAction(action, deviceId, btn) {
    if (action === 'test-push') {
      try {
        btn.disabled = true;
        btn.textContent = 'Sending...';
        await this.api('POST', `/api/devices/${deviceId}/test-push`);
        this.showToast('Test push sent', 'success');
        btn.textContent = 'Test Push';
        btn.disabled = false;
      } catch (err) {
        this.showToast(`Push failed: ${err.message}`, 'error');
        btn.textContent = 'Test Push';
        btn.disabled = false;
      }
    } else if (action === 'revoke') {
      // Find device name from the card
      const card = btn.closest('.pair-device-card');
      const nameEl = card ? card.querySelector('.device-name') : null;
      const deviceName = nameEl ? nameEl.textContent.trim() : 'this device';

      const confirmed = await this.showConfirmModal({
        title: 'Revoke Device',
        message: `Revoke <strong>${this.escapeHtml(deviceName)}</strong>? This will disconnect the device immediately.`,
        confirmText: 'Revoke',
        confirmClass: 'btn-danger'
      });

      if (confirmed) {
        try {
          await this.api('DELETE', `/api/devices/${deviceId}`);
          this.showToast('Device revoked', 'success');
          await this.loadPairedDevices();
          this.updatePairBadge();
        } catch (err) {
          this.showToast(`Revoke failed: ${err.message}`, 'error');
        }
      }
    }
  }

  /**
   * Update the pair badge on the header button showing the count of paired devices.
   * Hides badge if no devices are paired.
   */
  async updatePairBadge() {
    const badge = document.getElementById('pair-badge');
    if (!badge) return;

    try {
      const res = await this.api('GET', '/api/devices');
      const count = (res.devices || []).length;
      if (count > 0) {
        badge.textContent = String(count);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch (_) {
      // Silently ignore badge update failures (endpoint may not exist yet)
      badge.hidden = true;
    }
  }
}


/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  window.cwm = new CWMApp();
});
