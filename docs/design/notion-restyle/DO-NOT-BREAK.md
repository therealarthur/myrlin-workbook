# DO-NOT-BREAK: the JS/DOM contract of Myrlin Workbook

**Purpose.** This file is the functionality-preservation contract for the Notion design-language
refactor. The user requirement is imperative: **every interaction, process, and option must keep
working.** The restyle may change classes and markup **only where JS does not depend on them**.
Where JS does depend on a hook, the restyle must keep the hook verbatim, or migrate it in the same
commit that changes the JS.

**Scope of the audit.** Every DOM coupling was mined mechanically from the five frontend scripts
named in the brief plus the two supporting modules they load, all under
`C:/Users/Arthur/Desktop/cwm-restyle/src/web/public/`:

| File | Lines | Role |
| --- | --- | --- |
| `app.js` | 25,695 | The `CWMApp` class. Owns nearly the entire DOM contract. |
| `terminal.js` | 5,275 | `TerminalPane` (xterm.js host, select mode, copy view). |
| `mirror-view.js` | 502 | Read-only session mirror pane. |
| `theme-registry.js` | 141 | Theme metadata only. **No DOM access.** |
| `instance-colors.js` | 49 | Pure functions over tab data. **No DOM access.** |
| `experience-model.js` | 199 | Density/attention model. No element queries. |
| `schedules.js` | 427 | Scheduled-message popover. Small independent DOM surface. |

Static markup lives in `src/web/public/index.html` (132 KB). Styles live in `styles.css`
(303 KB), `styles-mobile.css`, `focused-shell.css`, `semantic-theme.css`.

**Headline numbers.**

| Contract surface | Count |
| --- | --- |
| Verbatim element IDs JS resolves | **336** |
| Dynamic ID families (template or concatenated) | **8** |
| Distinct classes JS queries or toggles (set B) | **278** |
| Classes defined in CSS but never referenced by JS (set C) | **~950** |
| Total classes across all four stylesheets | **1,205** |
| Set-B classes with **no** CSS rule at all (pure behavior hooks) | **23** |
| `dataset.*` keys read or written | **93** distinct, **331** call sites |
| Distinct `querySelector` / `querySelectorAll` literal selectors | **215** |
| `closest(...)` selectors (delegation matching) | **58** |
| Event-delegation roots that match by selector | **42** |
| `classList` add/remove/toggle/contains | **~90 distinct** names, **263** call sites |
| Layout reads (`offsetHeight`, `getBoundingClientRect`, ...) | **48 call sites** |
| `localStorage` keys | **29** (+ 2 `sessionStorage`) |
| `.hidden = ` property writes | **264** (252 app, 9 terminal, 2 schedules, 1 mirror) |
| Test files that read production frontend source | **15** |
| Literal source anchors asserted by tests | **302** |

---

## 0. The five rules that cover 90 percent of the risk

1. **Never rename or delete an ID in section A.** IDs are the single densest coupling: 336 of them,
   and 344 of `app.js`'s `getElementById` calls are unguarded (`cacheElements()` stores the result
   and later code dereferences it). A missing ID is usually a silent `null` that kills a whole
   feature branch of the app at first click.
2. **Never rename a class in section B.** Restyle it freely: change every declaration inside the
   rule, add new classes alongside it, restructure the visual design. Just keep the token present in
   the element's `class` attribute.
3. **`[hidden]` must always win.** JS toggles visibility through the `hidden` **property** 264
   times, not through a class. Any new rule that sets `display:` on an element JS hides must be
   paired with a `[hidden] { display: none !important; }` guard. `styles.css` already carries 12
   such guards (line 17 global, plus `.terminal-pane[hidden]`, `.account-panel[hidden]`,
   `.usage-meter[hidden]`, `.account-machines[hidden]`, `.account-pending[hidden]`,
   `.tasks-tab-panel[hidden]`, `.context-menu[hidden]`, `.sidebar-backdrop[hidden]`,
   `.terminal-reader-overlay[hidden]`, `.modal-overlay[hidden]`, `.qs-overlay[hidden]`,
   `#notes-editor-overlay[hidden]`, `.folder-browser-overlay[hidden]`). Losing one of these
   makes a modal or a panel permanently visible.
4. **Never drop a `data-*` attribute from section B.2.** Delegation and CSS both key off them, and
   several are the app's only source of truth for which session or provider a row represents.
5. **Run the section-E test list before declaring the restyle done.** Fifteen test files read the
   production HTML, CSS and JS as **text** and assert on 302 literal anchors. They will catch a
   large share of accidental breakage, but only if you actually run them.

---

## A. IDs that must survive verbatim

### A.1 Why these are the hardest constraint

`app.js` builds a single element cache in `cacheElements()` at
`src/web/public/app.js:361-707`. That one object literal makes **266** `getElementById` calls (plus
one `querySelectorAll('.view-tab')`) in a single pass, with no null checks at resolution time. The
file makes **431** `getElementById` calls in total, so roughly 165 more IDs are resolved on demand
elsewhere. A renamed ID does not throw at load; it stores `null`, and the failure surfaces later as
`Cannot read properties of null` at the moment the user clicks the feature.

`terminal.js` resolves exactly one ID, `document.getElementById(this.containerId)`, where
`containerId` is `term-container-<slot>`. Everything else it needs it finds by walking up with
`container.closest('.terminal-pane')` (see `terminal.js:1148`, `:1265`, `:1640`, `:1656`, `:1752`,
`:1905`, `:2036`). That walk is a hard structural requirement: **`#term-container-N` must remain a
descendant of `#term-pane-N`.**

### A.2 Dynamic ID families (8) - these are patterns, not literals

| Pattern | Range / source | Consumers |
| --- | --- | --- |
| `term-pane-${slot}` | slots `0`..`5` (`CWMApp.MAX_PANES`) | **48 call sites** in `app.js`; the single most-referenced element family in the app |
| `term-container-${slot}` | `0`..`5` | `app.js` (mount target), `terminal.js` (`this.containerId`) |
| `term-activity-${slot}` | `0`..`5` | `app.js` activity dot |
| `pane-view-${slot}` | `0`..`5` | `app.js` `openViewInPane` (mirror / docs / files rendered inside a pane) |
| `settings-cat-${slug}` | slug from settings registry `category` | `app.js:5640` writes, `:6126` and `:6181` read (nav-rail scroll + scroll-spy) |
| `server-text-status-${key}` | settings key | `app.js` server-text settings rows |
| `modal-field-${key}` | modal field key; `command`, `name`, `workingDir` also used as literals | `app.js` modal builder; also queried as `#modal-field-${f.key} .color-swatch.selected` and `... .icon-swatch.selected` |
| `update-step-${stepKey}` / `slider-val-${key}` | updater step key / slider setting key | `app.js` updater + settings sliders |

The pane families are authored **statically** in `index.html:694-1039` as six sibling
`.terminal-pane` blocks. They are not generated at runtime. If the restyle regenerates the grid, it
must emit the same six IDs with the same nesting.

### A.3 The verbatim ID list (336)

`account-cancel-btn`, `account-capture-btn`, `account-capture-provider-btn`, `account-chip`,
`account-chip-avatar`, `account-chip-label`, `account-chip-meta`, `account-mac-config-btn`,
`account-machines`, `account-panel`, `account-panel-list`, `account-panel-meter`,
`account-panel-title`, `account-pending`, `account-refresh-btn`, `account-save-btn`,
`account-switcher`, `account-tabs`, `action-sheet`, `action-sheet-cancel`,
`action-sheet-header`, `action-sheet-items`, `action-sheet-overlay`, `analytics-grid`,
`analytics-top-sessions`, `app`, `appearance-close`, `appearance-dialog`,
`appearance-overlay`, `attention-queue-badge`, `attention-queue-btn`, `board-add-btn`,
`board-columns`, `conflict-badge`, `conflict-center-list`, `conflict-center-overlay`,
`conflict-center-summary`, `conflict-close-btn`, `conflict-indicator-btn`, `conflict-refresh-btn`,
`context-menu`, `context-menu-items`, `costs-body`, `costs-chart-container`,
`costs-chart-tooltip`, `costs-panel`, `costs-period-selector`, `costs-refresh-btn`,
`costs-sessions-search`, `costs-sessions-tbody`, `create-session-btn`, `create-workspace-btn`,
`density-choices`, `detail-analytics`, `detail-back-btn`, `detail-branch`,
`detail-command`, `detail-cost`, `detail-cost-breakdown`, `detail-cost-total`,
`detail-created`, `detail-delete-btn`, `detail-dir`, `detail-last-active`,
`detail-logs`, `detail-pid`, `detail-ports`, `detail-rename-btn`,
`detail-restart-btn`, `detail-start-btn`, `detail-status-badge`, `detail-status-dot`,
`detail-stop-btn`, `detail-subagent-count`, `detail-subagent-list`, `detail-subagents`,
`detail-title`, `detail-token-bar`, `detail-topic`, `detail-workspace`,
`diff-viewer-close`, `diff-viewer-content`, `diff-viewer-files`, `diff-viewer-overlay`,
`diff-viewer-stats`, `diff-viewer-title`, `discover-btn`, `discover-select-all`,
`discover-select-none`, `docs-ai-insights`, `docs-ai-refresh`, `docs-goals-count`,
`docs-goals-list`, `docs-notes-count`, `docs-notes-list`, `docs-panel`,
`docs-project-empty`, `docs-raw`, `docs-raw-editor`, `docs-roadmap-count`,
`docs-roadmap-list`, `docs-rules-count`, `docs-rules-list`, `docs-save-btn`,
`docs-structured`, `docs-tasks-count`, `docs-tasks-list`, `docs-td-add-btn`,
`docs-td-count`, `docs-td-init-btn`, `docs-td-list`, `docs-td-refresh-btn`,
`docs-td-section`, `docs-td-setdir-btn`, `docs-td-setup-bar`, `docs-td-setup-msg`,
`docs-toggle-raw`, `docs-workspace-name`, `docs-workspace-select`, `feature-board`,
`files-editor-pane`, `find-conversation-btn`, `find-convo-close`, `find-convo-input`,
`find-convo-mode`, `find-convo-overlay`, `find-convo-results`, `find-convo-search-btn`,
`focused-more-btn`, `folder-browser-breadcrumb`, `folder-browser-cancel`, `folder-browser-close`,
`folder-browser-list`, `folder-browser-overlay`, `folder-browser-path`, `folder-browser-select`,
`git-diff-viewer`, `header-stats`, `image-upload-input`, `kanban-board`,
`kill-orphaned-pty-btn`, `launcher-close`, `launcher-form`, `launcher-form-selected`,
`launcher-list`, `launcher-model`, `launcher-overlay`, `launcher-search`,
`launcher-session-name`, `launcher-submit`, `login-btn`, `login-error`,
`login-form`, `login-password`, `login-screen`, `logout-btn`,
`mobile-tab-bar`, `modal`, `modal-body`, `modal-cancel-btn`,
`modal-close-btn`, `modal-confirm-btn`, `modal-field-command`, `modal-field-name`,
`modal-field-workingDir`, `modal-footer`, `modal-overlay`, `modal-title`,
`named-tunnel-autostart`, `named-tunnel-save-btn`, `named-tunnel-start-btn`, `named-tunnel-status`,
`named-tunnel-stop-btn`, `named-tunnel-token-input`, `new-task-branch-preview`, `new-task-btn`,
`new-task-cancel`, `new-task-close`, `new-task-create`, `new-task-description`,
`new-task-dir`, `new-task-dir-custom`, `new-task-flags`, `new-task-model`,
`new-task-name`, `new-task-overlay`, `new-task-prompt`, `new-task-start-now`,
`new-task-tags`, `notes-editor-cancel`, `notes-editor-close`, `notes-editor-overlay`,
`notes-editor-save`, `notes-editor-textarea`, `notes-editor-title`, `open-switcher-btn`,
`pair-badge`, `pair-devices-list`, `pair-devices-tab`, `pair-mobile-btn`,
`pair-mobile-close-btn`, `pair-mobile-overlay`, `pair-qr-container`, `pair-qr-tab`,
`pair-timer`, `pair-urls`, `password-toggle-btn`, `pr-base-branch`,
`pr-body`, `pr-dialog-cancel`, `pr-dialog-close`, `pr-dialog-overlay`,
`pr-dialog-submit`, `pr-draft`, `pr-generate-desc`, `pr-labels`,
`pr-title`, `projects-list`, `projects-refresh`, `projects-search-bar`,
`projects-search-input`, `projects-toggle`, `qs-input`, `qs-results`,
`quick-switcher-overlay`, `resources-body`, `resources-panel`, `resources-refresh-btn`,
`restart-all-btn`, `scale-down-btn`, `scale-up-btn`, `search-input`,
`search-overlay`, `search-results`, `session-detail-panel`, `session-empty`,
`session-list`, `session-list-panel`, `session-manager-list`, `session-manager-overlay`,
`session-panel-title`, `settings-body`, `settings-btn`, `settings-close-btn`,
`settings-empty-fallback`, `settings-nav`, `settings-overlay`, `settings-providers-placeholder`,
`settings-search-input`, `sidebar`, `sidebar-collapse-btn`, `sidebar-create-ws`,
`sidebar-launch-btn`, `sidebar-meta`, `sidebar-projects-header`, `sidebar-provider-tabs`,
`sidebar-resize-handle`, `sidebar-section-resize`, `sidebar-tasks-header`, `sidebar-tasks-list`,
`sidebar-tasks-mode-toggle`, `sidebar-toggle`, `sidebar-view-toggle`, `sm-close-btn`,
`sm-select-all-btn`, `sm-stop-selected-btn`, `spinoff-body`, `spinoff-cancel`,
`spinoff-close`, `spinoff-create`, `spinoff-error`, `spinoff-footer`,
`spinoff-loading`, `spinoff-overlay`, `spinoff-select-all-cb`, `spinoff-selected-count`,
`spinoff-start-now`, `spinoff-subtitle`, `spinoff-tasks`, `spinoff-title`,
`stat-running`, `stat-total`, `stopped-sessions-list`, `stopped-sessions-toggle`,
`summary-send-btn`, `summary-ws-select`, `tasks-files-panel`, `tasks-git-panel`,
`tasks-layout-toggle`, `tasks-list`, `tasks-panel`, `tasks-search`,
`tasks-tab-strip`, `tasks-tab-td`, `tasks-td-panel`, `td-issue-modal-body`,
`td-issue-modal-close`, `td-issue-modal-close-btn`, `td-issue-modal-id`, `td-issue-modal-overlay`,
`td-issue-modal-promote-btn`, `td-issue-modal-title`, `terminal-grid`, `terminal-groups-bar`,
`terminal-groups-tabs`, `terminal-reader-close`, `terminal-reader-content`, `terminal-reader-overlay`,
`terminal-reader-title`, `terminal-tab-strip`, `theme-dropdown`, `theme-gallery`,
`theme-toggle-btn`, `toast-container`, `toggle-hidden-btn`, `toggle-hidden-label`,
`update-badge`, `update-body`, `update-btn`, `update-close-btn`,
`update-dismiss-btn`, `update-footer`, `update-overlay`, `update-start-btn`,
`update-status`, `update-steps`, `usage-meter`, `usage-meter-bars`,
`vkb-toggle-btn`, `workbench-projects-btn`, `workbench-start-btn`, `workspace-count`,
`workspace-list`, `workspaces-refresh`, `wt-changed-files`, `wt-review-banner`

Plus these IDs referenced in `index.html` markup and by `focused-shell.test.js`:
`workbook-view-tabs`, `workbench-empty-state`, `workbench-empty-title`, `icon-clock` (SVG sprite
symbol, referenced as `<use href="#icon-clock"/>` from the pane schedule button and elsewhere).

### A.4 IDs used through selector strings, not `getElementById`

These four are only ever found through `querySelector('#...')` or `closest('#...')`, so a
naive "which IDs does JS use" grep on `getElementById` misses them:

| ID | Access |
| --- | --- |
| `kill-orphaned-pty-btn` | `document.querySelector('#kill-orphaned-pty-btn')` |
| `spinoff-select-all-cb` | `querySelector('#spinoff-select-all-cb')` |
| `account-capture-btn` | `e.target.closest('#account-capture-btn')` in the account-panel delegation |
| `account-capture-provider-btn` | `e.target.closest('#account-capture-provider-btn')` in the same handler |

Also note `app.js` uses `el.closest('[id]')` in the docs-item handler: any restyle that inserts a
new ID-bearing wrapper **between** a docs item and its section will silently retarget that lookup.

---

## B. Classes and attributes JS toggles or queries

**Rule: RESTYLE freely, NEVER rename, NEVER remove from the element.**

Everything in this section may have every one of its CSS declarations replaced. What must not
change is the presence of the token in the DOM.

### B.1 The 278 JS-coupled classes

Legend for the "how" column: `Q` queried via `querySelector`/`querySelectorAll`, `C` matched via
`closest()` (delegation), `L` written or read via `classList`, `M` via `matches()`.

#### B.1.a State classes - written by `classList`, mostly never authored in markup (~78)

These are the app's state machine. They are toggled at runtime and are the classes a designer is
most likely to "clean up" because they never appear in `index.html`. Removing the CSS rule for one
of them silently deletes a visual state; renaming one breaks the JS.

`account-sheet-open`, `active`, `activity-indicators-disabled`, `ai-find-card-opened`, `ai-loading`,
`appearance-open`, `attention-state`, `collapsed`, `ctx-submenu-visible`, `cwm-dragging`,
`detail-active`, `dirty`, `drag-over`, `dragging`, `expanded`, `group-drop-target`,
`has-actionable`, `highlighted`, `image-drag-over`, `is-active`, `is-applying`, `is-degraded`,
`is-stale`, `is-unavailable`, `kanban-drop-target`, `keyboard-open`, `loading`, `mic-active`,
`mobile-active`, `mobile-visible`, `open`, `pane-colors-enabled`, `pane-expanded-stage1`,
`pane-expanded-stage2`, `pane-nav-pulse`, `pinned`, `qr`, `refreshing`, `rename-flash`,
`select-mode-on`, `selected`, `sheet-open`, `sort-active`, `sort-asc`, `spinoff-deselected`,
`tab-drag-merge`, `tab-drag-over`, `tab-dragging`, `tab-notify`, `terminal-active`,
`terminal-pane-active`, `terminal-pane-done`, `terminal-pane-dragging`, `terminal-pane-empty`,
`terminal-pane-expand-stage1`, `terminal-pane-expand-stage2`, `terminal-pane-loading`,
`toast-dragging`, `toast-exit`, `toast-swipe-exit`, `toolbar-active`, `visible`,
`workspace-drop-target`, `workspace-list-drop-target`, `ws-drop-after`, `ws-drop-before`

Notes with teeth:

- `.active` is the single busiest token: 41 `classList` operations across `app.js`, `terminal.js`
  and `schedules.js`, plus `querySelector('.docs-tab.active')`,
  `querySelector('.terminal-group-tab.active')`, `querySelector('.account-tab.is-active')`.
  It is reused by view tabs, docs tabs, terminal group tabs, mobile tabs, period buttons, resize
  handles and more. Do **not** replace it with a Notion-style `data-state="active"`.
- `.is-active` is a *different*, newer token used by the settings nav rail
  (`app.js:6183`, `btn.classList.toggle('is-active', ...)`) and the account tabs. Both `.active` and
  `.is-active` must survive; they are not interchangeable.
- Two-stage pane expansion (`pane-expanded-stage1`/`stage2`, `terminal-pane-expand-stage1`/`stage2`)
  is a CSS-transition choreography that JS drives and then reads back with `classList.contains`.
  Keep both stages even if the new design animates differently.
- `document.documentElement` and `document.body` both receive `terminal-active`
  (`app.js:11404-11408`) and `body` alone receives `cwm-dragging`, `keyboard-open`, `sheet-open`,
  `account-sheet-open`, `appearance-open`. Root-level classes are easy to miss in a component-scoped
  restyle.

#### B.1.b Structural / delegation classes - queried or matched (~200)

`account-delete-btn`, `account-retry-btn`, `account-row`, `account-row-edit`, `account-seg`,
`account-seg-mac`, `account-tab`, `action-sheet-item`, `ai-find-card`, `ai-find-card-name`,
`ai-find-card-open`, `ai-insights-empty`, `board-card`, `board-column-body`, `board-column-count`,
`chart-dot`, `codex-pane-status`, `codex-status-chip`, `color-picker`, `color-swatch`,
`conflict-auto-resolve-btn`, `conflict-indicator`, `conflict-session-chip`, `context-menu-item`,
`costs-chart-tooltip-date`, `costs-chart-tooltip-value`, `costs-period-btn`, `costs-session-row`,
`costs-sessions-table`, `ctx-item-wrapper`, `ctx-submenu`, `detail-body`, `detail-change-item`,
`detail-changes-header`, `detail-changes-list`, `detail-changes-title`, `device-name`,
`diff-file-item`, `discover-cb`, `discover-row`, `docs-add-btn`, `docs-checkbox`, `docs-item`,
`docs-item-delete`, `docs-item-text`, `docs-note-text`, `docs-section`, `docs-section-chevron`,
`docs-section-header`, `docs-section-heading`, `docs-section-toggle`, `docs-tab`, `docs-tabs`,
`expose-port-btn`, `fallback-dismiss`, `files-container`, `files-tree-row`,
`find-convo-setup-link`, `folder-browser-crumb`, `folder-browser-item`, `git-branch-badge`,
`git-commit-row`, `git-file-row`, `group-chevron`, `icon-picker`, `icon-picker-cat-sep`,
`icon-picker-grid`, `icon-picker-search`, `icon-picker-set-sep`, `icon-swatch`, `indicator-dot`,
`instance-indicator`, `kanban-card`, `kanban-column`, `kanban-column-body`, `kanban-column-count`,
`launcher-pin-btn`, `launcher-project-row`, `mirror-live-dot`, `mirror-load-earlier`,
`mirror-messages`, `mirror-pane-header`, `mobile-send-btn`, `mobile-tab`, `mobile-type-input`,
`modal-choice-actions`, `name-cell`, `notes-toolbar-btn`, `pair-device-card`, `pair-tab`,
`pair-url-copy`, `pane-conflict-badge`, `pane-pin-count`, `pane-provider-pill`,
`pane-schedule-count`, `pane-title-clock`, `pane-view-back`, `pane-view-badge`,
`project-accordion`, `project-accordion-body`, `project-accordion-chevron`,
`project-accordion-header`, `project-name`, `project-session-item`, `project-session-name`,
`pw-icon-hide`, `pw-icon-show`, `qs-result`, `resource-row-menu-btn`, `roadmap-status-dot`,
`schedule-popover-tab`, `schedule-row`, `search-result`, `session-badge-cost`,
`session-badge-cost-na`, `session-item`, `session-manager-filters`, `session-name`,
`session-schedule-clock`, `settings-category`, `settings-nav-item`, `settings-scale-btn`,
`settings-server-text-input`, `settings-server-text-save`, `settings-unhide-all-btn`,
`settings-unhide-btn`, `sidebar-backdrop`, `sidebar-tab`, `sidebar-tab-badge`,
`sidebar-tasks-mode-btn`, `sidebar-view-btn`, `sm-action-btn`, `sm-filter`, `sm-session-checkbox`,
`sm-session-row`, `spinoff-task-card`, `spinoff-task-cb`, `spinoff-task-desc-input`,
`spinoff-task-title-input`, `stat-chip`, `tab-folder-header`, `tab-folder-name`,
`tasks-header-actions`, `tasks-layout-btn`, `tasks-placeholder`, `tasks-tab`, `tasks-tab-panel`,
`tasks-td-toolbar`, `task-item`, `template-chip`, `terminal-copy-hint-x`, `terminal-group-tab`,
`terminal-group-tab-close`, `terminal-group-tab-name`, `terminal-groups-add`,
`terminal-mobile-input-row`, `terminal-mobile-toolbar`, `terminal-pane`, `terminal-pane-close`,
`terminal-pane-collapse`, `terminal-pane-copyview`, `terminal-pane-expand`, `terminal-pane-header`,
`terminal-pane-mic`, `terminal-pane-pinnedoc`, `terminal-pane-schedule`, `terminal-pane-selectmode`,
`terminal-pane-title`, `terminal-pane-upload`, `terminal-pty-unavailable`, `terminal-tab`,
`terminal-tab-add`, `terminal-tab-close`, `terminal-tab-item`, `theme-gallery-more`,
`theme-option`, `theme-swatch`, `toast-close`, `toolbar-keyboard`, `trash`, `update-step-detail`,
`update-step-icon`, `view-tab`, `voice-interim-overlay`, `workspace-accordion`,
`workspace-accordion-body`, `workspace-cell`, `workspace-group`, `workspace-group-header`,
`workspace-group-items`, `workspace-item`, `ws-chevron`, `ws-more-btn`, `ws-new-task-btn`,
`ws-project-group`, `ws-project-group-body`, `ws-project-group-chevron`, `ws-project-group-header`,
`ws-session-item`, `ws-session-meta-row`, `ws-session-name`, `wt-review-btn`,
`wt-review-btn-create-pr`, `wt-review-btn-diff`, `wt-review-btn-merge`, `wt-review-btn-push`,
`wt-review-btn-reject`, `wt-review-btn-resume`, `xterm`, `xterm-helper-textarea`, `xterm-screen`,
`xterm-viewport`

#### B.1.c The 23 behavior-only classes with no CSS rule anywhere

These are invisible to a CSS-first restyle. Nothing in `styles.css`, `styles-mobile.css`,
`focused-shell.css` or `semantic-theme.css` mentions them, so a "delete unused classes from the
markup" pass would remove them and break behavior with zero visual signal.

`account-seg-mac`, `costs-session-row`, `docs-section-toggle`, `is-degraded`, `kanban-drop-target`,
`mobile-type-input`, `modal-choice-actions`, `pw-icon-hide`, `pw-icon-show`, `qr`, `select-mode-on`,
`settings-server-text-input`, `settings-server-text-save`, `settings-unhide-all-btn`,
`spinoff-task-cb`, `spinoff-task-desc-input`, `spinoff-task-title-input`, `terminal-copy-hint-x`,
`terminal-pane-copyview`, `terminal-pane-pinnedoc`, `ws-more-btn`, `wt-review-btn-create-pr`,
`xterm-helper-textarea`

`.mobile-type-input` is the mobile send box; `.pw-icon-show`/`.pw-icon-hide` are the login password
toggle; `.spinoff-task-*` are the task-spinoff form fields; `.ws-more-btn` opens the workspace
context menu. All user-visible features whose hook is invisible to CSS tooling.

#### B.1.d Classes owned by xterm.js - never author, never rename, never restyle away

`.xterm`, `.xterm-viewport`, `.xterm-screen`, `.xterm-helper-textarea` are emitted by the vendored
xterm.js and queried by both files:

- `terminal.js` queries `.xterm-helper-textarea` (4x, focus management), `.xterm-viewport` and
  `.xterm-screen` (scroll engine).
- `app.js` uses `e.target.closest('.xterm')` for terminal-surface hit testing and
  `el.matches('.xterm-helper-textarea')` for focus checks.
- `app.js:15218` defines `const TERMINAL_SURFACE_SELECTOR = '.terminal-container, .xterm, .terminal-copyview'`
  and matches against it at `:15221` with `e.target.closest(TERMINAL_SURFACE_SELECTOR)`. All three
  tokens in that string must keep existing. `.terminal-container` is authored in `index.html`;
  `.terminal-copyview` is created by `terminal.js`.

Restyle these with descendant rules (`.terminal-pane .xterm-viewport { ... }`). Do not touch their
structure; xterm re-creates them on `term.open()`.

### B.2 The `data-*` attribute contract (93 dataset keys)

`dataset` is read and written at 331 call sites across 93 distinct keys. These are as load-bearing as
the classes, and several are the only carrier of identity for a row. Attribute form is shown, since that is what appears in
markup.

**Identity carriers - losing one detaches a row from its record:**

| Attribute | `dataset` key | Reads | Where |
| --- | --- | --- | --- |
| `data-provider` | `provider` | 25 | Session rows, project accordions, terminal panes, mirror panes, search results, settings rows. Drives CSS accents *and* spawn behavior. |
| `data-id` | `id` | 18 | Workspace rows, task rows, schedule rows |
| `data-session-id` | `sessionId` | 15 | Session items, pane records; also used in the template selector `[data-session-id="${sid}"]` |
| `data-group-id` | `groupId` | 15 | Terminal group tabs; template selector `.terminal-group-tab[data-group-id="${id}"]`; also `.workspace-item[data-group-id]` in CSS |
| `data-path` | `path` | 12 | Project rows, file tree rows |
| `data-index` | `index` | 11 | Generic list positions |
| `data-profile-id` | `profileId` | 10 | Credential account rows; template selector `.account-row[data-profile-id="${id}"]` |
| `data-account-id` | `accountId` | 5 | `closest('.account-row[data-account-id]')` |
| `data-slot` | `slot` | 9 | `.terminal-pane` slot index (authored in `index.html`) |
| `data-provider-tab` | `providerTab` | 9 | Sidebar provider tabs; `.account-tab[data-provider-tab="${id}"]` |
| `data-task-id` | `taskId` | 5 | Task cards |
| `data-td-id` | `tdId` | 2 | td issue rows |
| `data-project-path` / `data-project-encoded` / `data-encoded` | `projectPath`, `projectEncoded`, `encoded` | 8 | Project identity |
| `data-workspace-id` / `data-ws-id` | `workspaceId`, `wsId` | 4 | Workspace identity |
| `data-pid`, `data-pty-id`, `data-device-id`, `data-tunnel-id`, `data-port` | | 6 | Process / device / tunnel identity |

**Behavior selectors - queried directly by attribute:**

`[data-action]` (`querySelectorAll('[data-action]')` and `closest('[data-action]')` in two
delegation roots), `[data-key]` (66 occurrences in `index.html`; the mobile toolbar dispatch reads
`btn.dataset.key` at `app.js:1624` and queries `[data-key="copy"]`, `[data-key="select"]`,
`[data-key="copyview"]` by name), `[data-setting]`, `[data-setting-num]`, `[data-setting-slider]`,
`[data-setting-select]`, `[data-setting-key="${key}"]`, `[data-provider-toggle]`,
`[data-theme-choice]`, `[data-density-choice]`, `[data-reset-at]`, `[data-when]`, `[data-sort]`
(on `th`), `[data-body]`, `[data-cancel]`, `[data-form]`, `[data-form-error]`, `[data-history]`,
`[data-list]` (the last six are `schedules.js`).

**Root-element attributes set by JS and consumed by CSS:**

| Attribute on `<html>` | Set at | Consumed by |
| --- | --- | --- |
| `data-ui-shell` (`focused` \| `classic`) | `index.html:27` pre-paint, `app.js` reads at `:176`, `:734`, `:1457`, `:5057`, `:6453`, `:18985` | `focused-shell.css` gates **every** rule on `:root[data-ui-shell="focused"]` |
| `data-theme` | `app.js:4725`, pre-paint `index.html:57` | Palette blocks in `styles.css`; `terminal.js:631` reads it to pick the xterm palette |
| `data-theme-choice` | `app.js:4726` | Theme picker active state |
| `data-theme-appearance` (`light`\|`dark`) | `app.js:4753` | Appearance-sensitive rules |
| `data-density` (`quiet`\|`informative`) | `app.js:4776`, pre-paint `index.html:66` | Density rules |
| `data-view-mode` | `app.js:11353` | View-scoped rules |

`<div id="terminal-grid" data-panes="N">` is set at `app.js:17486`
(`grid.setAttribute('data-panes', visibleCount)`) and consumed by six rules at
`styles.css:5092-5097` plus the adaptive overrides in `focused-shell.css:291-324`. See section D.3.

**ARIA attributes JS writes and sometimes reads back** (a restyle that rebuilds these controls must
preserve them, and `focused-shell.test.js` asserts several): `aria-expanded` (13 writes, 2 reads),
`aria-pressed` (10), `aria-label` (11), `aria-selected` (3), `aria-current` (2 set, 2 remove),
`aria-hidden`, `role`, plus reads of `aria-controls` and `aria-disabled`.

### B.3 Event-delegation roots and the selectors they match

42 listeners delegate by selector. Each root is a **container that must remain an ancestor of its
targets**. Restructuring the DOM so a target escapes its root silently kills every interaction
underneath it. Line numbers are `app.js` unless noted.

| Root element | Events | `closest()` selectors matched |
| --- | --- | --- |
| `#workspace-list` (`wsList`, :2023-2300) | click, contextmenu, touchstart/end/move, dblclick, dragstart/end/over/leave/drop | `#sidebar-create-ws`, `.ws-new-task-btn`, `.ws-more-btn`, `.instance-indicator`, `.ws-session-item`, `.ws-session-name`, `.ws-project-group`, `.ws-project-group-header`, `.workspace-item`, `.workspace-group`, `.workspace-group-header`, `.workspace-accordion`, `.ws-session-item, .workspace-item` |
| `#session-list` (`sessList`, :2397-2431) | click, contextmenu, touchstart/end/move, dragstart/end | `.session-item` |
| `#projects-list` (`projList`, :2441-2545) | click, contextmenu, dragstart/end, touchstart/end/move | `.project-accordion`, `.project-accordion-header`, `.project-session-item`, `.project-session-item, .project-accordion-header` |
| `document` (:954) | click (global dismiss) | `.docs-section-heading`, `.docs-tab`, `.costs-period-btn`, `.sm-filter`, `.stat-chip`, `button`; `matches('button')` |
| `#account-panel-list` (:9042) | click | `.account-row[data-account-id]`, `.account-delete-btn`, `.account-row-edit`, `.account-retry-btn`, `.account-row`, `.account-seg`, `#account-capture-btn`, `#account-capture-provider-btn` |
| `#account-tabs` (:9131) / `#account-panel` (:9140) | click / keydown | `.account-tab` / `.account-row` |
| `#costs-period-selector` (:1085) | click | `.costs-period-btn` |
| docs tab bar (:1054) | click | `.docs-tab` |
| tasks tab strip (:6455) | click | `.tasks-tab` |
| terminal tab strip (:2559) | touchstart | `.terminal-group-tab` |
| session-manager rows (:24751, :24781) | change, click | `.sm-session-row`, `.sm-session-checkbox`, `.sm-action-btn` |
| launcher rows (:25110) | click | `.launcher-pin-btn` |
| pair devices list (:25383) | click | `[data-action]` |
| feature-board cards (:7859) | click | `[data-action]` |
| icon picker grid (:12118) | click | `.icon-swatch` |
| files tree rows (:6885) | click | `.files-container` |
| spinoff checkboxes (:8591) | change | `.spinoff-task-card` |
| docs item rows (:19259) | click | `.docs-item`, `[id]` |
| AI find cards (:14704) | click | `.ai-find-card` |
| codex status strip (:16359) | click | `.codex-status-chip` |
| `schedules.js:67` popover root | click | `.schedule-popover-tab` |
| `schedules.js:256` | click | `.schedule-row` |
| terminal panes (`app.js:1623`, `:1753`) | click / global | `.terminal-pane` |

`terminal.js` registers **zero** selector-delegating listeners. It resolves its pane once via
`container.closest('.terminal-pane')` and caches it as `this.paneEl`, re-resolving on
`rebindHost()`. That single `closest` is the entire structural dependency, and it is used 7 times.

### B.4 Markup JS generates and then re-queries

These are the sites where JS writes `innerHTML` and immediately (or later) finds elements inside it.
If a restyle rewrites the template but not the query, the feature dies.

| Producer | Emits | Re-found by |
| --- | --- | --- |
| `mirror-view.js:288-310` `_renderShell()` | `<div class="mirror-pane" data-provider data-mirror-key>` containing `.mirror-pane-header`, `.mirror-provider-pill`, `.mirror-live-dot[data-live]`, `.mirror-title`, `.mirror-readonly-tag`, `.mirror-load-earlier`, `.mirror-messages` | `root.querySelector` for `.mirror-pane-header`, `.mirror-live-dot`, `.mirror-messages`, `.mirror-load-earlier` on the next four lines; `_elLiveDot.dataset.live` written later at `:428` |
| `terminal.js:3912 _injectCopyControls()` | `.terminal-pane-selectmode` and `.terminal-pane-copyview` buttons appended into `.terminal-pane-header` | `header.querySelector('.terminal-pane-copyview')`; `this._selectModeBtn` / `this._copyViewBtn` cached and `.remove()`d in `dispose()` |
| `terminal.js:4032 _showSelectModeStrip()` | `.terminal-selectmode-strip` appended to `this.paneEl`, styled entirely via `style.cssText` | re-measured by `_applySelectStripPlacement()` |
| `terminal.js:1157 (PTY-unavailable banner)` | `.terminal-pty-unavailable` with `role="alert"` | `paneEl.querySelector('.terminal-pty-unavailable')` for de-dup |
| `app.js:17939-17948` | `.terminal-resize-handle.terminal-resize-col` and `.terminal-resize-handle.terminal-resize-row` appended to `#terminal-grid` | cached on `this._colResizeHandle` / `this._rowResizeHandle`, positioned by inline `left` / `top` |
| `app.js` context-menu builder (`_renderContextItems`) | `.ctx-item-wrapper[data-idx]`, `.context-menu-item`, `.ctx-submenu[data-parent-idx]` | `querySelector(':scope > .context-menu-item')`, `.ctx-item-wrapper[data-idx="${...}"] > .context-menu-item`, `.ctx-submenu-visible` |
| `app.js:5519-5520` instance pip | `style="--c-outer:var(--x); --c-inner:var(--y)"` | consumed by `styles.css:5451/5463/5472` |
| `app.js` settings renderer `:5640` | `<div class="settings-category" id="settings-cat-${slug}" data-category="...">` | `#settings-cat-${slug}` + `.settings-category` scroll-spy |
| `app.js:1878-1909` mobile toolbar injection | buttons with `data-key` appended after `[data-key="copy"]` inside every `.terminal-mobile-toolbar` | `toolbar.querySelector('[data-key="'+spec.key+'"]')` idempotency check |

---

## C. Classes safe to restyle freely

### C.1 The heuristic (you cannot enumerate C by hand)

Set C is approximately **950 classes**: the 1,205 classes defined across the four stylesheets minus
the 255 that are also in set B. It is not enumerated here because it is both large and unstable
(any new CSS rule adds to it). Use this decision procedure instead, in order:

1. **Is the token in the section B list?** If yes, it is B. Restyle only.
2. **Run the grep gate.** From `src/web/public/`, for a candidate class `foo-bar`:

   ```sh
   grep -nE "(['\"\`])[^'\"\`]*\.foo-bar\b|classList\.[a-z]+\([^)]*['\"\`]foo-bar['\"\`]" \
     app.js terminal.js mirror-view.js schedules.js experience-model.js \
     theme-registry.js instance-colors.js
   ```

   Zero hits in all seven files means the class is style-only (set C). Any hit means set B.
   Re-run this and not a memorised list, because B is a snapshot of today's `app.js`.
3. **Check the class is not a state class applied by another state class's rule.** Some C classes
   only render because a B state class is present on an ancestor
   (for example `.pane-expanded-stage2 .some-child`). Restyling the child is safe; deleting the
   ancestor selector is not.
4. **Check section E.** Fifteen test files assert on literal selector text in the stylesheets. A
   class can be absent from JS and still be pinned by a test.

### C.2 What set C looks like in practice

The overwhelming majority of C is presentation leaf classes: card interiors, label spans, badge
text, icon wrappers, empty-state copy, footers, hints. Representative slice from the account
switcher alone: `.account-active-pill`, `.account-chip-chevron`, `.account-empty`,
`.account-empty-hint`, `.account-modal-hint`, `.account-panel-actions`, `.account-panel-backdrop`,
`.account-panel-footer`, `.account-panel-header`, `.account-panel-header-actions`,
`.account-panel-meter-note`.

**Important trap.** Many C-looking classes belong to elements that are ID-pinned. `.account-chip`,
`.account-panel`, `.account-panel-list`, `.account-machines`, `.usage-meter` are all style-only as
*classes*, but the element carrying each one is `#account-chip`, `#account-panel`, and so on. The
**class** is free; the **ID on that element** is section A. Same for `.mobile-tab-bar`
(`#mobile-tab-bar`), `.context-menu` (`#context-menu`), `.login-screen` (`#login-screen`), and
dozens of others where the pattern `id="x" class="x"` is used.

### C.3 What is definitively safe

- Every declaration inside any rule, B or C. Colors, spacing, radii, shadows, typography,
  transitions, borders, backgrounds.
- Adding new classes alongside existing ones (`class="terminal-pane notion-surface"`).
- Adding wrapper elements, **except** where they would break a `closest()` root/target relationship
  from B.3, an `offsetParent` chain from D, or the `#term-container-N` inside `#term-pane-N`
  invariant from A.1.
- Adding new CSS custom properties, subject to the phantom-token gate in E.2.
- Restructuring purely visual subtrees that contain no B token, no A ID, and no `data-*` from B.2.

---

## D. Inline-style and layout-read couplings

These are the places where a CSS change alone, with no markup or JS change, can break behavior.
They are ranked by blast radius.

### D.1 Terminal fit - the highest-consequence measurement

`terminal.js:2141` inside `safeFit()`:

```js
const rect = container.getBoundingClientRect();
if (rect.width === 0 || rect.height === 0) return;
try { this.fitAddon.fit(); } catch (_) { return; }
```

`fitAddon.fit()` converts pixel dimensions of `#term-container-N` into terminal rows and columns and
sends a resize to the PTY. Consequences of getting this wrong:

- **Zero height or width** (a collapsed flex/grid track, `display:none` on an ancestor, a missing
  `min-height: 0` on a flex column) causes an early return: the terminal never sizes, the PTY keeps
  its default 80x24, and output wraps wrongly forever.
- **The container must have a definite size at fit time.** Any layout that sizes the pane from its
  content instead of from the grid track will feed back into itself.

`safeFit()` is re-run after: sidebar collapse (250 ms delay, `app.js:11492`), sidebar resize drag
end, UI-scale change (100 ms delay, `app.js:5012`), visual-viewport resize on mobile, and pane grid
relayout. If the new design animates any of these with a longer duration than the existing delay,
the fit will measure mid-animation.

### D.2 Header-height measurements in `terminal.js` (three of them)

| Site | Measures | Consequence of a CSS change |
| --- | --- | --- |
| `terminal.js:1160-1164` | `.terminal-pane-header` `offsetHeight`, used as `banner.style.top` for the PTY-unavailable alert | A taller header pushes the banner down correctly; a header that becomes `position: fixed` or leaves the pane's flow makes the banner overlap the terminal |
| `terminal.js:4493-4509` `_copyOverlayTopPx()` | `.terminal-pane-header` `offsetHeight`; **`0` is meaningful** | The code distinguishes three states: measurable header (sit below it), header present measuring `0` (mobile hides it, so cover from `top: 0`), and no header element (fall back to `COPY_VIEW_DEFAULT_TOP_PX = 34`). **If the restyle hides the mobile pane header with `visibility: hidden` or `opacity: 0` instead of `display: none`, `offsetHeight` stops being `0` and the Copy view leaves a live repainting band of terminal above the snapshot.** This is a previously-fixed bug; do not regress it. |
| `terminal.js:4081-4100` `_selectStripBottomPx()` | `.terminal-mobile-toolbar` + `.terminal-mobile-input-row` `offsetHeight`, summed | The Select-mode strip is positioned above the mobile chrome. Both must be the pane's **last flex children** and must collapse to `offsetHeight === 0` when hidden. If they are moved out of the pane, taken out of flow, or hidden by `opacity`, the strip covers the toolbar (it is `pointer-events: none`, so the toolbar stays tappable but invisible - the exact reported defect this code fixes). Fallback when unmeasurable is `SELECT_STRIP_MOBILE_CHROME_FALLBACK_PX`. |

Related constants in `terminal.js`: `COPY_VIEW_DEFAULT_TOP_PX = 34` (line 54),
`SELECT_STRIP_Z_INDEX = 4` (line 121), `SELECT_STRIP_BASE_BOTTOM_PX`,
`SELECT_STRIP_MOBILE_CHROME_FALLBACK_PX`, `COPY_VIEW_TOUCH_TARGET_PX`,
`COPY_VIEW_TOUCH_MAX_WIDTH_PX`. The Select strip is styled entirely by `style.cssText`
(`terminal.js:4047-4053`) including `font: 11px/1.4 'Plus Jakarta Sans'` and
`color: var(--text, #cdd6f4)` / `background: var(--surface0, ...)` / `border: 1px solid var(--mauve, ...)`.
**A Notion palette must either keep `--text`, `--surface0` and `--mauve` defined or this JS string
must be updated in the same commit.** Same for the fallback hexes baked into it.

### D.3 Pane grid sizing - inline styles vs `!important` CSS

`app.js:18109-18125` writes `grid.style.gridTemplateColumns` and `gridTemplateRows` directly on
`#terminal-grid` from `this._gridColSizes` / `this._gridRowSizes` (the drag-resizable fr ratios).
`app.js:17512-17539` writes `paneEl.style.gridColumn = 'span 2'` on the last pane in 3-pane and
odd bottom-row layouts.

Three layers now compete, and the resolution is deliberate:

1. `styles.css:5092-5097` gives a default track template per `[data-panes="N"]`.
2. JS inline styles override those (inline beats author).
3. `focused-shell.css:291-306` and `:313-324` override the inline styles **with `!important`**, for
   `[data-panes="5"]` and `[data-panes="6"]` at `769px-1559px` and inside
   `@container workbook-main (max-width: 1399px)`, forcing `1fr 1fr` columns and `1fr 1fr 1fr` rows
   and hiding `.terminal-resize-row` with `display: none !important`.

The comment at `focused-shell.css:294` states the intent: "Workbook writes a resizable grid inline,
so these adaptive tracks must win while the media query is active." **Dropping the `!important`
silently reverts 5- and 6-pane layouts to three columns on laptop widths.**
`experience-ux-contract.test.js` asserts all of this literally (see E.3), including
`container-name: workbook-main` and `container-type: inline-size` on the main content element.

Resize handle positions are inline percentages: `this._colResizeHandle.style.left = 'calc(N% - 3px)'`
and `this._rowResizeHandle.style.top = 'calc(N% - 3px)'` (`app.js:18135`, `:18144`). The `- 3px`
assumes a 6px-wide handle. Changing the handle width in CSS without changing this constant
mis-centres it.

### D.4 Sidebar width - JS writes and reads back its own inline style

`app.js:11499-11549`:

```js
this.els.sidebar.style.width = width + 'px';        // restore, clamped 180..600
sidebar.style.width = newWidth + 'px';              // during drag
sidebar.style.transition = 'none';                  // during drag
const finalWidth = parseInt(sidebar.style.width, 10); // READ BACK
localStorage.setItem('cwm_sidebarWidth', finalWidth.toString());
```

`startWidth = sidebar.getBoundingClientRect().width` at `:11564` seeds the drag.

Constraints this places on the restyle:

- `#sidebar` must remain an element whose **`width`** property controls its size. Moving the sidebar
  into a CSS grid track sized by `grid-template-columns` makes `style.width` inert, so the drag
  appears to do nothing and `parseInt(sidebar.style.width)` returns `NaN`, so the width stops
  persisting.
- `styles.css:88` `--sidebar-width: 280px` and `styles.css:964` `width: var(--sidebar-width)` are the
  default; the inline style overrides it. `styles.css:2979` resets `--sidebar-width: 100%` on mobile.
- `sidebar.style.transition = 'none'` during drag and `= ''` on release: if the restyle moves the
  sidebar transition onto a different property or an ancestor, the drag will lag.
- `.collapsed` on `#sidebar` is read by `startResize` at `:11561` to refuse resizing while collapsed.

### D.5 Sidebar section split (workspaces vs projects)

`app.js:11591-11647`. Reads `sidebar.getBoundingClientRect().height`, subtracts a hard-coded
`200` ("Reserve space for headers/footer"), then writes on the two lists:

```js
wsList.style.flex = 'none'; wsList.style.height = newWsHeight + 'px';
projList.style.flex = '1';  projList.style.minHeight = '0';
```

Rehydrated on load from `cwm_wsSectionHeight`. This requires `#workspace-list` and `#projects-list`
to be **flex children of a column flex container**. Converting the sidebar interior to grid breaks
the split silently (the elements get a `height` that the grid ignores). The magic `200` is calibrated
to the current header and footer heights; a taller Notion-style sidebar header makes the maximum
drag position wrong.

### D.6 Settings nav rail - `offsetTop` and a 60px scroll-spy threshold

- `app.js:6126-6132`: `this.els.settingsBody.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' })`
  where `target` is `#settings-cat-<slug>`. **`offsetTop` is relative to the nearest positioned
  ancestor.** `.settings-body` (`styles.css:2085`) is `overflow-y: auto` with no `position`
  declared, so today the offset parent resolves to a further ancestor and the arithmetic happens to
  work. Adding or removing `position: relative` anywhere between `#settings-body` and
  `.settings-category` changes the origin and makes every nav click scroll to the wrong place.
- `app.js:6165-6184` `_updateSettingsActiveNavItem()`: compares each `.settings-category`'s
  `getBoundingClientRect().top` against `#settings-body`'s, with a fixed **60px** activation
  threshold and an early `break`. The `break` means **categories must be in DOM order matching
  visual order.** A masonry or multi-column settings layout breaks the scroll-spy.
- `.settings-content` at `styles.css:2096` is `display: grid; grid-template-columns: 152px 1fr`.
  `settings-nav-rail.test.js` asserts that literal rule shape (E.3).

### D.7 Context menu and submenu positioning

`app.js:18568-18574`: `menu.hidden = false` then `menu.getBoundingClientRect()` to clamp against the
viewport. The menu must be measurable **immediately** after `hidden = false`; a CSS entry animation
that starts it at `scale(0.95)` or `height: 0` returns a wrong rect and the menu will be misplaced
or clipped. If the restyle adds an entry transition, measure before the transform is applied or
switch to `transform`-only animation (which does not change the layout rect).

`app.js:18444-18455` `positionSubmenu()` uses the measure-offscreen trick:

```js
subEl.style.left = '-9999px'; subEl.style.top = '0';
subEl.classList.add('ctx-submenu-visible');
const subRect = subEl.getBoundingClientRect();
```

`.ctx-submenu-visible` must be the class that makes a submenu **measurable** (not `visibility:
hidden`, not `display: none`), and `.ctx-submenu` must be `position: fixed` so the `left`/`top`
writes land in viewport coordinates.

### D.8 Forced reflow for animation restart

`app.js:5557-5562`:

```js
paneEl.classList.remove('pane-nav-pulse');
void paneEl.offsetWidth;          // force reflow so the animation restarts
paneEl.classList.add('pane-nav-pulse');
setTimeout(() => paneEl.classList.remove('pane-nav-pulse'), 800);
```

The `800` must stay >= the CSS animation duration on `.pane-nav-pulse`, or the class is stripped
mid-animation.

### D.9 Focus-trap visibility test

`app.js:1528-1532` collects focusables inside `#appearance-dialog` with
`'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'`
then filters with `!el.hidden && el.getClientRects().length > 0`. Any control the restyle hides with
`opacity: 0` or `visibility: hidden` still returns client rects and **stays in the focus trap** as an
invisible tab stop. Use `display: none` or the `hidden` attribute.

### D.10 Mobile viewport compensation

`app.js:1556-1586`, on `visualViewport` resize/scroll:

- `document.documentElement.style.setProperty('--vh', vh + 'px')`, consumed by
  `styles.css:3096-3097` and `styles-mobile.css:571-572` as `height: var(--vh, 100vh)` /
  `height: var(--vh, 100dvh)`. **Keep both fallbacks; keep the token name.**
- `document.body.classList.toggle('keyboard-open', vh < screen.height * 0.75)`.
- `#app` gets `style.transform = translateY(offset)` at `:1584` to compensate iOS Safari scroll.
  **`#app` must not be `position: fixed` with its own transform, and must not have a CSS `transform`
  the JS would clobber** (the JS sets it to `''` when the offset is 0, restoring the stylesheet
  value only if none was inline).

### D.11 Other JS-owned inline properties

`app.js` and `terminal.js` write these properties inline; a CSS rule for the same property on the
same element will lose unless it is `!important`, and an `!important` rule will make the JS inert:

`background`, `borderColor`, `borderRadius`, `bottom`, `boxShadow`, `color`, `colorScheme`,
`cssText` (23 sites), `cursor`, `display`, `flex`, `fontWeight`, `gridColumn`,
`gridTemplateColumns`, `gridTemplateRows`, `height`, `left`, `minHeight`, `minWidth`, `opacity`,
`outline`, `padding`, `pointerEvents`, `position`, `top`, `transform`, `transition`, `userSelect`,
`width`, `zIndex`.

Notable: `document.body.style.cursor = 'col-resize' | 'row-resize' | ''` and
`document.body.style.userSelect` during drags (`app.js:11566`, `:11629`, `:11535-11536`);
`document.documentElement.style.colorScheme` at `app.js:4755`;
`document.documentElement.style.setProperty('--ui-scale', s)` consumed by `styles.css:8217`
as `zoom: var(--ui-scale, 1)` (default declared at `styles.css:85`), and by the pre-paint script at
`index.html:72`. **`zoom` scales layout; if the Notion restyle replaces it with `transform: scale()`,
every `getBoundingClientRect()` in this document becomes scaled and the terminal fit breaks.**

### D.12 Dynamic CSS custom properties set from markup

Five tokens are written inline per element by render code and are **intentionally not defined in any
stylesheet**. `phantom-tokens.test.js` allow-lists them by name; adding a sixth requires editing that
test (deliberate friction).

| Token | Set by | Consumed at |
| --- | --- | --- |
| `--ws-color` | `app.js` `renderWorkspaces` | workspace row accent |
| `--ws-group-color` | `app.js` `renderWorkspaces` | `styles.css:11650`, `:11659`, `:11660` (`.workspace-item[data-group-id]` stripe + chip) |
| `--group-color` | `app.js` workspace-group-header | group header |
| `--tab-color` | `app.js` terminal group tab | tab tint |
| `--folder-color` | `app.js` `.tab-folder-header` | folder tint |
| `--c-outer` / `--c-inner` | `app.js:5519-5520` instance pip | `styles.css:5451`, `:5463`, `:5472` |
| `--vh` | `app.js:1561` | see D.10 |

---

## E. Test-suite hooks

Fifteen test files read the production frontend **as text** and assert on literal anchors. They are
plain Node scripts, run via `npm test` (`test/run.js`). They are the cheapest guardrail available for
this refactor: **run them after every batch of changes.**

### E.1 How the extraction works

Three shared idioms recur. Understanding them tells you exactly what will break.

1. **Balanced-brace block extraction.** `extractBlock(src, anchor)` /
   `balancedBlock(source, header)` / `methodBody(src, name)` / `ruleBody(css, selector)`: find a
   literal anchor with `indexOf`, find the next `{`, walk to the matching `}`. Used so an assertion
   is scoped to one function or one CSS rule instead of matching a lookalike elsewhere.
   **Consequence: renaming a method or a CSS selector fails the test with "Anchor not found".**
2. **Sandbox compilation.** `terminal-select-v2.test.js:154-176` and
   `terminal-select-mode.test.js` compile the entire `terminal.js` source with
   `new Function('window','document','Terminal','FitAddon','WebSocket','localStorage','navigator',
   'requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','MouseEvent', termSrc + 'return {...}')`
   and pull out the class plus these **module-level constants by name**: `SELECT_FREEZE_MAX_HOLD_CHARS`,
   `TERMINAL_REPORT_MAX_CHARS`, `SELECT_FREEZE_WHEEL_LINES`, `SELECT_NOTICE_MS`,
   `COPY_VIEW_DIVIDER`, `COPY_VIEW_BLANK_RUN_LIMIT`, `ACTIVATE_DEBOUNCE_MS`,
   `ACTIVATE_REASSERT_MS`, `ACTIVATE_CONNECT_GUARD_MS`, `ACTIVATE_VISIBILITY_RATIO`.
   **Renaming or removing any of those consts fails the whole file at load.**
3. **CRLF normalization.** `terminal-select-v2.test.js:50`:
   `fs.readFileSync(APP_JS_PATH,'utf8').replace(/\r\n/g,'\n')`. The public JS is stored with CRLF.
   Every anchor is deliberately **single-line**. If you reformat `app.js` or `terminal.js` so a
   signature wraps across lines, single-line anchors stop matching.

### E.2 Gate tests - these encode restyle-wide invariants

| Test | File | Invariant |
| --- | --- | --- |
| **Phantom-token gate** | `test/phantom-tokens.test.js` | Every `var(--x)` consumed in `styles.css` + `styles-mobile.css` must be **defined** in one of those two files, or be in the `DYNAMIC_TOKENS` allow-list (`--ws-color`, `--ws-group-color`, `--group-color`, `--tab-color`, `--folder-color`, `--c-outer`, `--c-inner`, `--vh`). Also asserts allow-list hygiene: every allow-listed token must actually be consumed. **This is the single most valuable test for a palette swap.** Note it does **not** scan `focused-shell.css` or `semantic-theme.css`. |
| **CSS token gate** | `test/css-tokens.test.js` | Requires these exact rules and shapes: `.terminal-pane[data-provider="claude"]:not(.terminal-pane-empty)`, `.terminal-pane[data-provider="codex"]:not(.terminal-pane-empty)`, and `--provider-{claude,codex,gemini}-accent: var(--{mauve,green,blue})` plus matching `--provider-*-tint: color-mix(in srgb, var(--x) N%, transparent)`. |
| **Grep gate** | `test/grep-gate.test.js` | Repo-wide forbidden-pattern scan. |

### E.3 CSS and HTML selector anchors asserted by tests

Any of these strings disappearing from the stylesheets or `index.html` turns a test red.

**`test/settings-nav-rail.test.js`** - `class="settings-content"` and `id="settings-nav"` in
`index.html`; in CSS: `.settings-content` followed within 300 chars by `grid-template-columns`,
`.settings-nav-item`, `.settings-nav-item.is-active`, and `.settings-nav-item.is-active` within
400 chars of `--mauve`.

**`test/provider-label-pill.test.js`** - `.pane-provider-pill` (CSS and `index.html`);
`.pane-provider-pill[data-provider="claude"]::before` -> `--provider-claude-accent` (same for
codex); `.terminal-pane[data-provider="claude"]` -> `border-top: 4px solid var(--provider-claude-accent)`
(same for codex); `.ws-session-item[data-provider="claude"]` -> `--provider-claude-accent` (same for
codex); `color-mix(in srgb, var(--mauve) 8%, var(--bg-primary))` and the `--green` equivalent.

**`test/codex-status-strip.test.js`** - `.codex-pane-status`, `.codex-status-chip`,
`.codex-status-chip-bypass`, and `codex-status-chip-bypass` within 400 chars of `var(--red)`.

**`test/workspace-group-ux.test.js`** - `.ws-group-chip`, `.ws-group-chip-remove`;
`.workspace-item[data-group-id]` within 200 chars of `--ws-group-color`;
`.ws-group-chip:hover .ws-group-chip-remove` within 80 chars of `opacity: 1`.

**`test/search-render.test.js`** - `.search-result-provider {`;
`.search-result[data-provider="claude"] ... search-result-provider {` within 120 chars of
`var(--provider-claude-accent)` (same for codex); in `app.js`: `search-result-header"`,
`search-result-project"`, `search-result-provider"`.

**`test/mobile-ux-fixes.test.js`** - `ruleBody(styles, ...)` on `.terminal-group-tab`,
`.terminal-groups-tabs` (needs `touch-action: pan-x`), `.tab-folder-header` (needs
`touch-action: pan-x`); `focusedCss` must contain `.context-menu-sep-labeled` with `height: auto`.
Also `methodBody(appJs, ...)` on `showMoreMenu`, `showActionSheet`, `setViewMode`,
`_renderTabButtonHtml`, `showTerminalContextMenu`, `updateTerminalTabs`, `switchTerminalTab`,
`_ensureActiveTabVisible`, `_buildTerminalTabContextItems`, and `methodBody(terminalJs, '_isMobile')`.

**`test/focused-shell.test.js`** - `<html data-ui-shell="focused">`; `#focused-more-btn` must be a
`button` carrying class `focused-more-btn` and **not** `view-tab`, and must sit **outside** the
tablist; `#workbench-start-btn` and `#workbench-projects-btn` exist as buttons; the empty state
contains "browse sessions already on this machine" and `>Browse sessions</button>`;
`#context-menu` and `#action-sheet` exist as `div`s; docs-section headers are `button`s with
`aria-expanded="true"` and there are **zero** `div.docs-section-header`; the controlled regions
`docs-goals-list`, `docs-tasks-list`, `docs-td-list`, `docs-roadmap-list`, `docs-rules-list`,
`docs-ai-insights` exist as `div`s; `--text-tertiary: var(--subtext1)` inside the latte block;
`focusedCss` contains `.attention-queue-btn:focus-visible`; and
`balancedBlock(focusedCss, '@media (max-width: 768px)')` and
`balancedBlock(focusedCss, '@media (pointer: coarse)')` must both exist, with slot-zero
`display: flex !important;` inside the mobile block.

**`test/experience-ux-contract.test.js`** - `index.html` must link, in this order:
`semantic-theme.css`, `focused-shell.css`, then load `theme-registry.js`, `experience-model.js`,
then the inline pre-paint `<script>`. Asserts `.terminal-grid[data-panes="5"]` and `="6"` with
`grid-template-columns: 1fr 1fr !important;` and `grid-template-rows: 1fr 1fr 1fr !important;`,
plus `.terminal-resize-row { display: none !important; }`, in **both** the desktop media query and
the `@container workbook-main` query; and that the main content element declares
`container-name: workbook-main;` and `container-type: inline-size;`. Also
`placeholder="Filter agent tasks..."`, `>New agent task</button>`, `<h3>New Agent Task</h3>`,
`.docs-workspace-select` with `aria-label="Project for notes"`, and the attention-queue button with
`aria-haspopup="menu"`, `aria-expanded="false"`, `aria-controls="context-menu"`,
`aria-label="Session attention queue"`, plus `#attention-queue-badge` as a `span`.

**`test/settings-providers.test.js`** - `index.html` / rendered HTML must contain
`data-provider="claude"`, `data-provider="codex"`, `settings-providers-install-hint`,
`@openai/codex`, and the literal status strings `Enabled &middot; CLI on PATH`,
`Disabled &middot; CLI on PATH`, `CLI not found in PATH`, `Enabled but CLI not found in PATH`.

**`test/provider-account-tabs.test.js`** - `var(--transition-fast)` must remain a defined token;
event names `provider-accounts:changed` and `provider-accounts:usage`.

**`test/usage-meter.test.js`** - reads `app.js`, `index.html`, `styles.css`, `styles-mobile.css`;
anchors on `this.renderUsageMeter()`, `usageMeter`, `accountPanelMeter`.

**`test/cost-display.test.js`** - the rendered badge markup:
`session-badge-cost">$${Number(cachedCost).toFixed(2)}` and
`session-badge-cost-na" title="Cost not tracked for this provider">&mdash;<`, plus
`cost-cell cost-cell-na" title="Cost not tracked for this provider">&mdash;<`.

**`test/terminal-select-mode.test.js`** - among 34 anchors: `terminal-pane-selectmode`,
`terminal-pane-header`, `terminal-selectmode-strip`, `cwm_copyhint_v1`, `SELECT_MODE_STORAGE_PREFIX`,
and the cache-busting query strings **`terminal.js?v=20260806-selectv3`** and
**`app.js?v=20260805-mobile-select1`** in `index.html`. `test/copy-secure-context-fallback.test.js`
asserts the same two version strings. **Do not change those `?v=` values without updating both tests.**

**`test/terminal-select-v2.test.js`** - 82 anchors, the largest set. Method-signature anchors that
must keep their exact single-line form include: `_copyAllFromCopyView() {`, `_openCopyView() {`,
`_refreshCopyView() {`, `_ensureCopyOverlay() {`, `initMobileInputMode() {`,
`_injectCopyControls() {`, `dispose() {`, `_destroyCopyView() {`, `detachHostBindings() {`,
`_showSelectModeStrip() {`, `_showSelectModeNotice(text, ms) {`, `  safeFit() {`,
`_applySelectStripPlacement() {`, `_updateCopyViewUI() {`, `_maybeShowCopyHint() {`,
`_updateSelectModeUI() {`, `_applyCopyOverlayMetrics() {`, `rebindHost(containerId) {`, `mount() {`,
`sendCommand(cmd) {`, `async pasteFromClipboard() {`, `async _copyViewApi(method, path, body) {`,
`async _loadTranscriptSnapshot() {`, and in `app.js`: `  switchTerminalTab(slotIdx) {` and
`  showTerminalContextMenu(slotIdx, x, y, copySelection, terminalPane) {`.
DOM-literal anchors: `header.querySelector('.terminal-pane-copyview')`, `terminal-pane-copyview`,
`document.querySelectorAll('.terminal-mobile-toolbar button').forEach(btn => {`,
`this._injectMobileSelectControls();`, `document.addEventListener('cwm:select-chrome'`,
and the regex `TERMINAL_SURFACE_SELECTOR = '\.terminal-container, \.xterm, \.terminal-copyview'`
plus `closest(TERMINAL_SURFACE_SELECTOR)`. **Ordering assertions** also exist, for example
`_applyCopyOverlayMetrics` must appear before `_refreshCopyView` inside `_openCopyView`, and
`_installSelectModeWheelGuard()` before `this.connect()` inside `mount()`.

**Other source-anchored suites** (`app.js` / `terminal.js` only, no CSS):
`adhoc-pane-menu.test.js` (3), `bracketed-paste-isolation.test.js` (8),
`data-provider-attr.test.js` (10, includes `paneEl.dataset.provider =`),
`dragdrop-provider.test.js` (4, includes the drag MIME types `cwm/project`, `cwm/terminal-swap`),
`idle-notification-gating.test.js` (21), `layout-provider-persist.test.js` (4),
`pane-context-menu.test.js` (5), `paste-secure-context-fallback.test.js` (12),
`project-session-resume-provider.test.js` (4, includes `cwm/project-session`),
`provider-tabs.test.js` (18, includes
`sidebarProviderTabs: document.getElementById('sidebar-provider-tabs')` and both
`localStorage.getItem('cwm_activeProviderTab')` and `setItem`), `smooth-scroll.test.js` (17),
`workspace-race.test.js` (2), `terminal-host-ownership.test.js`, `mirror-view-state.test.js`,
`instance-colors.test.js`, `theme-registry.test.js`, `experience-model.test.js`.

### E.4 Drag-and-drop MIME types (not DOM, but equally load-bearing)

`dataTransfer` type strings the app sets and reads: `cwm/project`, `cwm/project-session`,
`cwm/workspace`, `cwm/terminal-swap`, plus a session type. Two tests assert them. Preserve verbatim.

---

## F. localStorage and sessionStorage: keys and the DOM they rehydrate

29 `localStorage` keys and 2 `sessionStorage` keys. Every one of them restores UI state on load;
changing a key name silently resets that state for every existing user, and changing what the value
means without a migration corrupts it.

| Key | Written at | Rehydrates |
| --- | --- | --- |
| `cwm_token` | login/logout | auth bearer token; also read by `terminal.js` (2x) for the WebSocket query param. Removed on logout (4 sites). |
| `cwm_theme` | `app.js` theme apply | `document.documentElement.dataset.theme`. **Read by the pre-paint script at `index.html:32`.** Theme IDs are persistence IDs; `theme-registry.js` header says do not rename them (`mocha`, `macchiato`, `frappe`, `nord`, `dracula`, `tokyo-night`, `cherry`, `ocean`, `amber`, `mint`, `latte`, `rose-pine-dawn`, `gruvbox-light`). |
| `cwm_theme_choice` | `app.js:4726` area | `dataset.themeChoice`; pre-paint `index.html:31`. Values include the aliases `system`, `myrlin-dark`, `myrlin-light`. |
| `cwm_density` | appearance dialog | `dataset.density` (`quiet` \| `informative`); pre-paint `index.html:65`; `#density-choices` active state via `[data-density-choice]` |
| `cwm_ui_scale` | `app.js:5008` | `--ui-scale` on `<html>` (`styles.css:8217` `zoom`); pre-paint `index.html:70`, clamped `0.85..1.2` |
| `cwm_sidebarWidth` | `app.js:11542` | `#sidebar` inline `style.width`, clamped `180..600` |
| `cwm_sidebarCollapsed` | `app.js:11489` | `.collapsed` on `#sidebar` |
| `cwm_wsSectionHeight` | sidebar section drag end | inline `flex`/`height` on `#workspace-list` + `#projects-list` |
| `cwm_viewMode` | `setViewMode` | `dataset.viewMode` on `<html>`, active `.view-tab` / `.mobile-tab` |
| `cwm_activeWorkspace` | workspace select | selected `.workspace-item`; removed on delete |
| `cwm_activeProviderTab` | `app.js` provider tabs | active `.account-tab` / sidebar provider tab; default `'all'` (asserted by `provider-tabs.test.js`) |
| `cwm_wsCollapseState` | accordion toggles | `.collapsed` on `.workspace-accordion` bodies |
| `cwm_groupCollapseState` | group toggles | `.collapsed` on `.workspace-group` bodies |
| `cwm_projectGroupState` | project group toggles | `.ws-project-group-body` expansion |
| `cwm_projectsCollapsed` | `setProjectsCollapsed` | `#projects-list` collapsed state |
| `cwm_hiddenWorkspaces` / `cwm_hiddenGroups` / `cwm_hiddenSessions` / `cwm_hiddenProjects` / `cwm_hiddenProjectSessions` | hide/unhide actions | which rows render at all; surfaced by `#toggle-hidden-btn` + `.settings-unhide-btn` / `.settings-unhide-all-btn` |
| `cwm_pinnedDirs` | launcher pin | `.launcher-pin-btn` pinned state, `.pinned` class |
| `cwm_projectSessionTitles` | rename | `.project-session-name` text |
| `cwm_tasksLayout` | `#tasks-layout-toggle` | `.tasks-layout-btn` active, list vs kanban |
| `cwm_tasksTab` | `#tasks-tab-strip` | active `.tasks-tab` + `.tasks-tab-panel` |
| `cwm_settings` | settings save | the whole settings object; drives `applySettings()` which sets `--header-height`, `.pane-colors-enabled`, `.activity-indicators-disabled`. **Also read by `terminal.js`.** |
| `cwm_vkb_disabled` | `#vkb-toggle-btn` | virtual-keyboard toggle state |
| `cwm_fallback_active` | fallback banner | `.fallback-dismiss` banner visibility |
| `cwm_copyhint_v1` | `terminal.js` (2 writes) | the one-time copy hint; `.terminal-copy-hint-x` dismiss |
| `cwm_credMirrorMac` | removed only | legacy credential-mirror flag cleanup |
| `sessionStorage cwm_deviceId` | pairing | device identity |
| `sessionStorage cwm_projects` | project cache | project list cache; removed on refresh |

`terminal.js` additionally has a generic `localStorage.getItem(key)/setItem(key)/removeItem(key)`
helper driven by `SELECT_MODE_STORAGE_PREFIX` + session id, for per-session select-mode preference.
`terminal-select-mode.test.js` asserts `SELECT_MODE_STORAGE_PREFIX` and
`TerminalPane._loadSelectModePreference(this.sessionId)` / `_saveSelectModePreference(...)` exist.

---

## G. Pre-flight checklist for every restyle PR

1. `grep` the candidate class through the seven JS files (section C.1 step 2) before renaming it.
2. Confirm no ID in section A changed: diff `id="` occurrences in `index.html` against A.3.
3. Confirm `#term-container-N` is still a descendant of `#term-pane-N` for N in 0..5, and that
   `data-slot` is still on the pane.
4. Confirm every element that JS hides via `.hidden` still resolves to `display: none` under the new
   rules; add a `[hidden]` guard whenever you introduce a `display:` rule on such an element.
5. Confirm the `!important` grid overrides in `focused-shell.css` survived (D.3).
6. Confirm `--vh`, `--ui-scale`, `--header-height`, `--sidebar-width`, `--ws-color`,
   `--ws-group-color`, `--group-color`, `--tab-color`, `--folder-color`, `--c-outer`, `--c-inner`,
   `--transition-fast`, and every `--provider-*-accent`/`--provider-*-tint` still resolve.
7. Confirm the hard-coded token names inside `terminal.js`'s `style.cssText` strings (`--text`,
   `--surface0`, `--mauve`) still exist, or update that JS in the same commit (D.2).
8. Run `npm test`. Any "Anchor not found in source" failure names the exact string you removed.
9. Manually exercise, at minimum: open a session into a pane, drag a project into a second pane,
   resize the pane split, resize the sidebar, collapse the sidebar, open the context menu on a
   workspace row and on a pane, open a submenu, open Settings and click a nav-rail category, switch
   theme, switch density, open the account switcher, and on a phone width: open the mobile toolbar,
   toggle Select mode, open Copy view.
