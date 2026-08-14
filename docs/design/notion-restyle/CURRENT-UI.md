# CURRENT-UI: Myrlin Workbook frontend inventory (pre-Notion restyle)

Status: reference document. Describes the frontend exactly as it exists on disk at
`C:/Users/Arthur/Desktop/cwm-restyle/src/web/public/`. Nothing here is a proposal.
Every claim below was read out of the listed file at the listed line.

Audience: implementation agents who have never opened this codebase. Read section 0
for the load order, then jump to whichever surface you own.

Repository root used throughout: `C:/Users/Arthur/Desktop/cwm-restyle/`.
All paths in this document are relative to `src/web/public/` unless written in full.

---

## 0. Load order, file sizes, and the boot sequence

### 0.1 Files that make up the frontend

| File | Lines | Bytes | Role |
|---|---:|---:|---|
| `index.html` | 2006 | 132 KB | Static shell. Every region, overlay, modal and menu container is declared here. |
| `styles.css` | 12202 | 304 KB | The whole desktop design system: `:root` palette, 13 theme blocks, ~1928 rules. |
| `styles-mobile.css` | 1315 | 33 KB | Mobile overrides, all inside `@media` queries. |
| `semantic-theme.css` | 93 | 3 KB | Semantic role layer built on top of the palette. Loaded 3rd. |
| `focused-shell.css` | 1391 | 37 KB | The "focused" shell re-skin. Loaded last, wins the cascade. |
| `theme-registry.js` | 141 | 5 KB | Theme metadata only (ids, labels, appearance, xterm palette id). |
| `experience-model.js` | 199 | 6 KB | Density choices and the attention-state (status chip) model. |
| `provider-specs.js` | 69 | 4 KB | Frontend mirror of provider runtime behavior (idle regexes, key bindings). |
| `instance-colors.js` | 49 | 2 KB | Tab and pane instance colour helpers. Palette is token NAMES, not values. |
| `terminal.js` | 5275 | 254 KB | `TerminalPane` class. Owns xterm.js, the xterm theme objects, and several JS injected style surfaces. |
| `app.js` | 25695 | 1.14 MB | `CWMApp` class. Everything else: rendering, routing, theme switching, settings, modals. |
| `mirror-view.js` | 502 | 21 KB | `MirrorPaneView`, the read-only session mirror rendered into a pane. |
| `schedules.js` | 427 | 17 KB | Scheduled-message popover, created dynamically on `document.body`. |

Vendor (untouched by the restyle unless explicitly decided): `vendor/xterm/xterm.css`
(285 lines), `vendor/lucide.bundle.js`, `vendor/material-icons.bundle.js`,
`vendor/codemirror.bundle.js`, `vendor/qrcode.min.js`, `vendor/drag-drop-touch.esm.min.js`.

### 0.2 Stylesheet order (`index.html:16-20`)

```
1. vendor/xterm/xterm.css
2. styles.css
3. styles-mobile.css
4. semantic-theme.css?v=20260725-5
5. focused-shell.css?v=20260725-5
```

This order is load bearing. `focused-shell.css` is written as an override layer and
its comment at `focused-shell.css:1-8` says so explicitly: "This layer deliberately
sits after the legacy desktop and mobile sheets."

### 0.3 Script order (`index.html:21-22`, `index.html:1946-1999`)

Head, blocking: `theme-registry.js`, `experience-model.js`, then an inline IIFE
(`index.html:23-78`) that resolves and stamps the theme before first paint.

Body, in order: `vendor/lucide.bundle.js`, `vendor/material-icons.bundle.js`, an
inline xterm touch guard, the DragDropTouch polyfill module, `vendor/qrcode.min.js`,
xterm + fit + web-links addons, `provider-specs.js`, `terminal.js`, `instance-colors.js`,
`mirror-view.js`, `app.js`, `schedules.js`, then a service-worker registration.

### 0.4 Root attributes stamped before paint (`index.html:23-78`)

| Attribute on `<html>` | Values | Set by | Consumed by |
|---|---|---|---|
| `data-ui-shell` | `focused` (default) or `classic` (`?ui=classic`) | inline IIFE `index.html:26-28`; also literal in `index.html:2` | `focused-shell.css` (168 selector occurrences), `semantic-theme.css:49,54,58` |
| `data-theme` | one of 13 theme ids | inline IIFE `index.html:57`; later `app.js:4725` | `styles.css` theme blocks, `terminal.js:631` |
| `data-theme-choice` | `system` / `myrlin-dark` / `myrlin-light` / legacy id | `index.html:58`, `app.js:4726` | theme gallery active state |
| `data-theme-appearance` | `light` / `dark` | `index.html:60-61`, `app.js:4753` | JS only, plus `style.colorScheme` at `app.js:4755` |
| `data-density` | `quiet` (default) / `informative` | `index.html:66`, `app.js:4776` | `focused-shell.css:369,575,579,583,588,593,597,601,1111` |
| `data-view-mode` | active view id | `app.js` `setViewMode()` | available for CSS, currently mostly used by JS |
| `--ui-scale` inline style | 0.85 to 1.2 | `index.html:70-73`, `app.js:5008` | `styles.css:8218` `html { zoom: var(--ui-scale, 1) }` |

Also `<meta name="theme-color" content="#1e1e2e">` at `index.html:6`, rewritten at
runtime from `--bg-secondary` in `app.js:4757-4762`.

### 0.5 Fonts

Loaded from Google Fonts at `index.html:13-15`: **Plus Jakarta Sans** (300..800 plus
italics) and **JetBrains Mono** (400, 500). Exposed as `--font-sans` and `--font-mono`
in `styles.css:110-111`. Note the Notion import ships iA Writer Mono webfonts in
`docs/design/notion-import/_ds/assets/fonts/`, so the font swap is a real change, not
a token rename.

---

## 1. Screens, regions and overlays

Legend for "styles live in": `S` = `styles.css`, `M` = `styles-mobile.css`,
`F` = `focused-shell.css`, `T` = `semantic-theme.css`, `JS` = injected inline styles.

### 1.1 Top-level document children (`index.html`)

| # | Region | Container | Declared at | Styles live in |
|---|---|---|---|---|
| 1 | SVG icon sprite (`#icon-clock`) | inline `<svg>` | `index.html:82-89` | none |
| 2 | Login screen | `#login-screen.login-screen` | `index.html:94-140` | S:637-765 |
| 3 | Main application | `#app.app` (starts `hidden`) | `index.html:145-1435` | S:770-775 |
| 4 | Quick switcher modal | `#quick-switcher-overlay.modal-overlay` | `index.html:1440-1467` | S:2398-2615 |
| 5 | Global search overlay | `#search-overlay.qs-overlay` + `#search-panel.qs-panel` | `index.html:1472-1477` | S:2002-2021, S:2448+ |
| 6 | Find Conversation modal | `#find-convo-overlay` | `index.html:1482-1503` | S:3924-4153 |
| 7 | Generic modal (confirm/prompt) | `#modal-overlay` > `#modal.modal` | `index.html:1507-1525` | S:2336-2396 |
| 8 | Folder browser modal | `#folder-browser-overlay.folder-browser-overlay` | `index.html:1530-1548` | S:9778-9864 |
| 9 | Update modal | `#update-overlay` > `.modal.update-modal` | `index.html:1553-1568` | S:9684-9777 |
| 10 | New Agent Task dialog | `#new-task-overlay` > `.modal-panel` | `index.html:1571-1640` | S:6864-6925 (form bits), S:2336+ (shell) |
| 11 | PR creation dialog | `#pr-dialog-overlay` > `.modal-dialog` | `index.html:1645-1685` | S:2336+ |
| 12 | Task spinoff dialog | `#spinoff-overlay` > `.modal-panel` | `index.html:1690-1725` | S:515-636 |
| 13 | Session launcher | `#launcher-overlay` > `.launcher-panel` | `index.html:1730-1776` | S:10580-10858 |
| 14 | Diff viewer | `#diff-viewer-overlay` > `.diff-viewer` | `index.html:1781-1799` | S:6962-7270 |
| 15 | td issue detail modal | `#td-issue-modal-overlay` > `.modal.td-issue-modal` | `index.html:1806-1828` | S:4736-4822 |
| 16 | Settings overlay | `#settings-overlay` > `.settings-panel` | `index.html:1831-1848` | S:2022-2335, M:1033-1083 |
| 17 | Toast container | `#toast-container.toast-container` | `index.html:1853` | S:2739-2832 |
| 18 | Context menu | `#context-menu.context-menu` | `index.html:1858-1860` | S:3562-3749, F:context-menu rules |
| 19 | Action sheet (mobile menu) | `#action-sheet-overlay` > `#action-sheet` | `index.html:1865-1873` | M:261-445 |
| 20 | Appearance dialog | `#appearance-overlay` > `#appearance-dialog` | `index.html:1876-1902` | F:778-978 |
| 21 | Terminal reader overlay (mobile) | `#terminal-reader-overlay` | `index.html:1905-1911` | S:3260-3325 |
| 22 | Pair mobile dialog | `#pair-mobile-overlay` > `.modal.pair-mobile-modal` | `index.html:1916-1941` | S:10859-11126 |
| 23 | Hidden image upload input | `#image-upload-input` | `index.html:1944` | none |

### 1.2 Inside `#app` (`index.html:145-1435`)

**Header** `header.app-header` (`index.html:148-424`), styles S:777-951, F:33-146.

| Cluster | Contents | Ids |
|---|---|---|
| `.header-left` | sidebar toggle, brand (logo + title), account switcher | `#sidebar-toggle`, `#account-switcher` > `#account-chip` + `#account-panel` (`#account-tabs`, `#account-panel-meter`, `#account-machines`, `#account-panel-list`, `#account-pending`) |
| `.header-center` | `.view-nav-cluster` wrapping `nav.view-tabs#workbook-view-tabs` + `#focused-more-btn` | 7 `.view-tab` buttons: `terminal` (Workbench), `workspace` (Sessions), `tasks`, `costs`, `recent`, `docs`, `resources`. Each carries `data-shell-tier` = `primary` / `secondary` / `contextual` |
| `.header-right` | attention queue, usage meter, update, theme picker, virtual-keyboard toggle, pair mobile, settings, header stats, conflict indicator, quick switcher, restart all, logout | `#attention-queue-btn`, `#usage-meter` > `#usage-meter-bars`, `#update-btn`, `#theme-picker` > `#theme-toggle-btn` + `#theme-dropdown`, `#vkb-toggle-btn`, `#pair-mobile-btn`, `#settings-btn`, `#header-stats`, `#conflict-indicator-btn`, `#open-switcher-btn`, `#restart-all-btn`, `#logout-btn` |

Two panels live inside `.header-right` even though they render as floating overlays:
`#session-manager-overlay` (`index.html:365-380`, S:9865-10105) and
`#conflict-center-overlay` (`index.html:392-404`, S:10106-10342).

**Body** `div.app-body` (`index.html:427`), S:952-960.

**Sidebar** `aside.sidebar#sidebar` (`index.html:430-511`), S:961-1421, F:147-284, M:various.

Ordered children: `#sidebar-launch-btn`, `#sidebar-view-toggle` (Projects / Agent Tasks),
`#sidebar-provider-tabs` (rendered by JS), `#sidebar-projects-header`, `#workspace-list`,
`#sidebar-tasks-header` + `#sidebar-tasks-list`, `.sidebar-footer` > `#sidebar-meta`
(`#workspace-count`, `#toggle-hidden-btn`), `#sidebar-section-resize`, `#projects-header`
("Discovered"), `#projects-search-bar` (`#projects-search-input`, `#find-conversation-btn`),
`#projects-list`, `.sidebar-collapse-bar` > `#sidebar-collapse-btn`.
Then a sibling `#sidebar-resize-handle` (`index.html:514`, S:1027-1046).

**Main content** `main.main-content#main-content` (`index.html:517`), S:1422-1431.
It holds six mutually exclusive panels, toggled by `setViewMode()` in `app.js`:

| Panel | Container | Declared | Styles |
|---|---|---|---|
| Sessions list | `#session-list-panel.session-list-panel` (`.panel-header`, `#session-list`, `#session-empty`) | `index.html:520-550` | S:1432-1558 |
| Session detail | `#session-detail-panel.session-detail-panel` | `index.html:553-682` | S:1559-1959, M:211-260 |
| Terminal tab groups bar | `#terminal-groups-bar` > `#terminal-groups-tabs` | `index.html:685-689` | S:5703-5963 |
| Terminal grid | `#terminal-grid.terminal-grid[data-panes]` + `#terminal-tab-strip` + 6 panes | `index.html:692-1039` | S:5079-5590, M:446-706, F:398-496 |
| Docs panel (Project Notes) | `#docs-panel.docs-panel` | `index.html:1042-1231` | S:4326-4913, F:696-777 |
| Tasks panel | `#tasks-panel.tasks-panel` | `index.html:1234-1324` | S:6219-6961 |
| Costs panel | `#costs-panel.costs-panel` | `index.html:1327-1345` | S:7271-7701 |
| Resources panel | `#resources-panel.resources-panel` | `index.html:1348-1362` | S:7702-7999, F:979-1029 |

Session detail sub-blocks: `.detail-meta` rows (`#detail-status-badge`, `#detail-workspace`,
`#detail-dir`, `#detail-topic`, `#detail-command`, `#detail-pid`, `#detail-ports`,
`#detail-branch`, `#detail-created`, `#detail-last-active`), `#detail-cost` cost summary
with `#detail-token-bar`, `#detail-subagents`, `#detail-analytics`, `.detail-control-bar`
(start/stop/restart), `.detail-logs` > `#detail-logs`.

Terminal grid: exactly six static panes, `#term-pane-0` through `#term-pane-5`, each
with `data-slot`. Pane 0 additionally hosts `#workbench-empty-state` (`index.html:723-737`,
styled only in `focused-shell.css:398-496`). Every pane has the identical child set:
`.terminal-pane-header` (`.pane-provider-pill`, `.terminal-pane-title`,
`.terminal-pane-activity`, mic / expand / collapse / pinned-doc / close buttons,
`.pane-view-badge`, `.pane-view-back`), `.terminal-container#term-container-N`,
`.pane-view-container#pane-view-N`, `.terminal-pane-upload`, `.terminal-pane-schedule`,
`.terminal-mobile-input-row`, `.terminal-mobile-toolbar` (11 `data-key` buttons:
reader, keyboard, enter, tab, ctrlc, copy, ctrld, escape, up, down, upload).

Docs panel sub-blocks: `.docs-header` (`#docs-workspace-select`, `#docs-toggle-raw`,
`#docs-save-btn`), `.docs-tabs` (Notes / Plan), `#docs-project-empty`,
`#feature-board` (4 `.board-column` with `data-status` planned/active/review/done),
`#docs-structured` with 7 `.docs-section` blocks (notes, goals, tasks, td-issues,
roadmap, rules, ai-insights), and `#docs-raw` > `#docs-raw-editor`.
A separate Notes editor modal `#notes-editor-overlay` sits at `index.html:1370-1396`
(S:5964-6061).

Tasks panel sub-blocks: `#tasks-tab-strip` (Agent Tasks / Issues / Git / Files, the
last two `hidden` and marked `data-shell-maturity="retired"`), `.tasks-header-actions`
(`#tasks-search`, `#tasks-layout-toggle`, `#new-task-btn`), `#tasks-list`, and
`#kanban-board` with 5 `.kanban-column` (`backlog`, `planning`, `running`, `review`,
`completed`).

**Mobile bottom tab bar** `nav.mobile-tab-bar#mobile-tab-bar` (`index.html:1401-1434`),
4 `.mobile-tab` buttons: `workspace`, `terminal`, `tasks`, `more`. Styles M:156-210.

### 1.3 Surfaces created at runtime by JS (no HTML declaration)

| Surface | Class | Created at | Styles |
|---|---|---|---|
| Boot failure screen | inline HTML | `app.js:30-95` | inline hex, no tokens (see 4.4) |
| Fallback banner | `.fallback-banner` | `app.js:342` | S:2833-2868 |
| Sidebar backdrop (mobile) | `.sidebar-backdrop` | `app.js:11472` | S:3400-3415 |
| Account panel backdrop (mobile) | `.account-panel-backdrop` | `app.js:10547` | S:9160-9166, M:1153-1253 |
| Worktree review banner | `.wt-review-banner` | `app.js:22904` | S:2616-2738 |
| Grid resize drag shield | inline `position:fixed` overlay | `app.js:18043` | inline only |
| Schedule popover | `.schedule-popover` | `schedules.js:59`, appended to `document.body` | S:11378-11499 |
| Mirror pane | `.mirror-pane` | `mirror-view.js:291-305` | S:11906-12201 |
| Select mode strip | `.terminal-selectmode-strip` | `terminal.js:4044-4057` | inline `cssText` only |
| Copy view overlay | `.terminal-copyview` and children | `terminal.js:4285-4436` | inline `cssText` only |
| One-time copy hint | `.terminal-copy-hint` | `terminal.js:5166-5185` | inline `cssText` only |
| PTY unavailable banner | `.terminal-pty-unavailable` | `terminal.js:1157-1193` | S:5139-5186 |
| Mobile paste textarea | bare `<textarea>` | `terminal.js:798-823` | inline only |

Settings body is fully JS generated from a registry (`app.js:5037-5055` for the item
list, `renderSettingsBody()` at `app.js:5584`). Row markup is
`.settings-row > .settings-row-info > .settings-row-label + .settings-row-desc`
(`app.js:5648-5760`). Categories in use: `Interface`, `Terminal`, `Advanced`,
`Notifications`, `Automation`, `AI`, `Remote Access`.

---

## 2. The token system as it exists today

### 2.1 Where tokens are defined

| Definition site | File:line | What it defines |
|---|---|---|
| Base `:root` | `styles.css:21-135` | Catppuccin Mocha palette (24 colours), semantic aliases, compatibility aliases, dimensions, radii, transitions, shadows, fonts, provider accents |
| 12 theme blocks | `styles.css` (see 3.2 for the line map) | Re-declare the 24 palette colours plus `--border-subtle` and the 4 shadows |
| Semantic role layer | `semantic-theme.css:9-42` | 27 role tokens derived from the palette with `color-mix` |
| Focused shell overrides | `focused-shell.css:18-32` | 4 shell dimension tokens plus `--text-muted` and `--border-subtle` re-derivations, and a Latte-only `--text-tertiary` fix |

Total across the four stylesheets: **104 distinct custom properties**, **2011 `var()`
consumption sites**.

### 2.2 Palette tokens (Catppuccin naming, redefined by all 13 themes)

Every row below is defined 13 times (once per theme). Counts are `var()` consumption
sites across the four stylesheets.

| Token | Mocha value | Uses | Notes on how it is used |
|---|---|---:|---|
| `--surface0` | `#313244` | **183** | The single most consumed token. Hover backgrounds, chips, panel fills, input backgrounds. |
| `--overlay0` | `#6c7086` | **131** | Muted/placeholder text, disabled states, empty-state copy. |
| `--text` | `#cdd6f4` | **126** | Primary text at the raw-palette level. |
| `--surface1` | `#45475a` | **118** | Borders, dividers, scrollbar thumbs, second elevation. |
| `--mauve` | `#cba6f7` | **116** | The brand accent. Primary button fill, focus rings, active tabs, Claude provider accent. |
| `--green` | `#a6e3a1` | **111** | Running / success / Codex provider accent / mobile active tab. |
| `--subtext0` | `#a6adc8` | **96** | Secondary label text. |
| `--red` | `#f38ba8` | 66 | Error, danger, destructive actions. |
| `--blue` | `#89b4fa` | 62 | Info, ports, diff renames, image drag. |
| `--base` | `#1e1e2e` | 46 | Canvas background. |
| `--mantle` | `#181825` | 44 | Sidebar / header / pane header background. |
| `--yellow` | `#f9e2af` | 43 | Attention, idle, dirty git state, conflicts. |
| `--surface2` | `#585b70` | 36 | Third elevation, hover borders. |
| `--overlay1` | `#7f849c` | 34 | `--text-muted` source. |
| `--subtext1` | `#bac2de` | 19 | `--text-secondary` source. |
| `--crust` | `#11111b` | 18 | Terminal grid gutter, primary-button text, deepest background. |
| `--peach` | `#fab387` | 17 | Output tokens in cost bars, running activity dot. |
| `--teal` | `#94e2d5` | 10 | Push actions, settings result type. |
| `--lavender` | `#b4befe` | 8 | Spinoff loading dots, tag palette. |
| `--sapphire` | `#74c7ec` | 2 | Tag palette only. |
| `--pink` | `#f5c2e7` | 1 | Tag palette / pane slot colour. |
| `--sky` | `#89dceb` | **0** | Declared 13 times, never consumed in CSS. Used only via `_tagColor` in `app.js:7697`. |
| `--flamingo` | `#f2cdcd` | **0** | Same. |
| `--rosewater` | `#f5e0dc` | **0** in CSS | Read in JS as the xterm cursor colour (`terminal.js:616`). |

### 2.3 Semantic aliases (defined once, in `styles.css:47-58`)

| Token | Resolves to | Uses |
|---|---|---:|
| `--text-primary` | `var(--text)` | 72 |
| `--border-subtle` | `rgba(69, 71, 90, 0.5)` in Mocha, re-declared per theme, re-derived in `focused-shell.css:27` as `color-mix(in srgb, var(--surface1) 44%, transparent)` | 59 |
| `--text-muted` | `var(--overlay1)`, re-derived in `focused-shell.css:26` | 36 |
| `--accent` | `var(--mauve)` | 30 |
| `--text-secondary` | `var(--subtext1)` | 30 |
| `--text-tertiary` | `var(--subtext0)`, Latte override at `focused-shell.css:30` | 25 |
| `--bg-primary` | `var(--base)` | 17 |
| `--bg-secondary` | `var(--mantle)` | 10 |
| `--border-default` | `var(--surface1)` | 7 |
| `--bg-tertiary` | `var(--crust)` | **0** |
| `--bg-elevated` | `var(--surface0)` | **0** |

### 2.4 Compatibility aliases (`styles.css:60-79`)

Added retroactively because the stylesheet referenced tokens that were never defined.
The comment block explains each. All five are live.

| Token | Alias of | Uses |
|---|---|---:|
| `--bg-hover` | `--surface0` | 3 |
| `--border` | `--border-default` | 7 |
| `--surface-1` | `--surface0` | 15 |
| `--surface-2` | `--surface1` | 8 |
| `--text-base` | `--text` | 3 |

Note the near-collision between `--surface-1` (compat alias, hyphenated) and `--surface1`
(palette). A restyle must not conflate them.

### 2.5 Dimensions, radii, motion, shadows, fonts (`styles.css:82-111`)

| Token | Value | Uses | Notes |
|---|---|---:|---|
| `--ui-scale` | `1` | 1 | Consumed by `html { zoom: var(--ui-scale, 1) }` at `styles.css:8218`. |
| `--sidebar-width` | `280px` | 1 | Overridden in the focused shell by `--focused-sidebar-width: 264px`. |
| `--header-height` | `80px` | 3 | Focused shell replaces the applied height with `--focused-header-height: 58px`. |
| `--radius-xs` | `4px` | 3 | |
| `--radius-sm` | `6px` | 46 | |
| `--radius-md` | `10px` | 25 | |
| `--radius-lg` | `14px` | 7 | |
| `--radius-xl` | `18px` | 1 | |
| `--transition-fast` | `150ms cubic-bezier(0.16, 1, 0.3, 1)` | **93** | The dominant motion token. |
| `--transition-normal` | `200ms cubic-bezier(0.16, 1, 0.3, 1)` | 2 | |
| `--transition-slow` | `300ms cubic-bezier(0.16, 1, 0.3, 1)` | **0** | |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.2), 0 1px 3px rgba(0,0,0,.15)` | 3 | Re-declared per theme. |
| `--shadow-md` | see `styles.css:102` | **0** | Re-declared 13 times, never consumed. |
| `--shadow-lg` | see `styles.css:103` | 4 | |
| `--shadow-xl` | see `styles.css:104` | 7 | Modal shell shadow. |
| `--font-sans` | Plus Jakarta Sans stack | 14 | |
| `--font-mono` | JetBrains Mono stack | 56 | |

### 2.6 Provider accent tokens (`styles.css:113-129`)

Defined once. They inherit the theme automatically because they point at palette tokens.

| Token | Value | Uses |
|---|---|---:|
| `--provider-claude-accent` | `var(--mauve)` | 11 |
| `--provider-codex-accent` | `var(--green)` | 13 |
| `--provider-gemini-accent` | `var(--blue)` | 5 |
| `--provider-claude-tint` | `color-mix(in srgb, var(--mauve) 10%, transparent)` | 1 |
| `--provider-codex-tint` | `color-mix(in srgb, var(--green) 10%, transparent)` | 1 |
| `--provider-gemini-tint` | `color-mix(in srgb, var(--blue) 10%, transparent)` | **0** |

Consumed by attribute selectors on `[data-provider]`: `styles.css:11516`, `11523`,
`11536`, `11540`, `11549`, `11628-11639`, `11737-11745`, `11787-11796`, `11837-11840`,
plus `[data-provider-tab]` at `styles.css:8539-8542`.

### 2.7 Semantic role layer (`semantic-theme.css:9-42`)

This is the newest and cleanest layer. It is where a Notion restyle should hook, because
it already expresses roles rather than palette names. Current definitions:

```
--surface-canvas      : var(--base)                                    uses 5
--surface-sidebar     : var(--mantle)                                  uses 0
--surface-raised      : var(--surface0)                                uses 4
--surface-interactive : color-mix(in srgb, var(--surface1) 42%, transparent)  uses 5
--surface-selected    : color-mix(in srgb, var(--accent) 12%, var(--base))    uses 2

--color-focus     : var(--accent)     uses 10
--color-info      : var(--blue)       uses 1
--color-attention : var(--yellow)     uses 2
--color-success   : var(--green)      uses 3
--color-danger    : var(--red)        uses 2
--color-stale     : var(--overlay1)   uses 1

--status-needs-input : var(--color-attention)  uses 4
--status-running     : var(--color-info)       uses 9
--status-complete    : var(--color-success)    uses 2
--status-failed      : var(--color-danger)     uses 3
--status-stale       : var(--color-stale)      uses 3
--status-*-surface   : 12% / 10% color-mix variants   uses 1 (needs-input) and 0 (others)

--action-warning / --action-success / --action-danger   uses 0 each
--selection-bg        : color-mix(in srgb, var(--color-focus) 25%, transparent)   uses 1
--drop-target-bg      : color-mix(in srgb, var(--color-focus) 6%, var(--surface-canvas))  uses 1
--resize-handle-hover : color-mix(in srgb, var(--color-focus) 44%, transparent)   uses 1
--focus-ring          : 0 0 0 2px var(--surface-canvas), 0 0 0 4px var(--color-focus)  uses 0
```

Nine of these 27 role tokens have zero consumers today. The layer is half wired.
`--attention-color` is set (not defined at `:root`) by five
`.attention-state[data-attention-state="..."]` rules at `semantic-theme.css:62-80`.

### 2.8 Focused-shell tokens (`focused-shell.css:18-32`)

| Token | Value | Uses |
|---|---|---:|
| `--focused-header-height` | `58px` | 5 |
| `--focused-sidebar-width` | `264px` | 1 |
| `--focused-control-height` | `34px` | 3 |
| `--focused-content-max` | `1120px` | **0** |

### 2.9 Tokens set by JS at runtime (never defined in CSS)

These have zero `:root` definitions and are written per element. Any restyle that greps
for definitions will miss them.

| Token | Uses in CSS | Written by |
|---|---:|---|
| `--group-color` | 12 | `app.js:13217` on `.workspace-group-header` |
| `--folder-color` | 7 | `app.js` tab-folder render, values from `FOLDER_COLORS` at `app.js:20200` |
| `--vh` | 4 | `app.js:1561`, the mobile viewport-height fix |
| `--tab-color` | 3 | instance indicator / tab strip |
| `--ws-group-color` | 3 | `app.js:13160` |
| `--ws-color` | 1 | `app.js:13160` |
| `--c-outer` / `--c-inner` | 2 / 1 | `app.js` `renderInstanceIndicator()` around line 5525, values are `var(--<palette-token>)` |

---

## 3. Theme switching, end to end

### 3.1 The 13 themes (`theme-registry.js:44-58`)

| id | Label | Appearance | Tier | xterm palette source |
|---|---|---|---|---|
| `mocha` | Mocha | dark | featured | static object `THEME_MOCHA` |
| `macchiato` | Macchiato | dark | more | static `THEME_MACCHIATO` |
| `frappe` | Frappe | dark | more | static `THEME_FRAPPE` |
| `nord` | Nord | dark | more | CSS-derived at runtime |
| `dracula` | Dracula | dark | more | CSS-derived |
| `tokyo-night` | Tokyo Night | dark | more | CSS-derived |
| `cherry` | Cherry | dark | more | static `THEME_CHERRY` |
| `ocean` | Ocean | dark | more | static `THEME_OCEAN` |
| `amber` | Amber | dark | more | static `THEME_AMBER` |
| `mint` | Mint | dark | more | static `THEME_MINT` |
| `latte` | Latte | light | featured | static `THEME_LATTE` |
| `rose-pine-dawn` | Rose Pine Dawn | light | more | CSS-derived |
| `gruvbox-light` | Gruvbox Light | light | more | CSS-derived |

Three "featured choices" sit on top as aliases (`theme-registry.js:79-102`):
`system` (adaptive, resolves to `mocha` or `latte` from `prefers-color-scheme`),
`myrlin-dark` (alias of `mocha`), `myrlin-light` (alias of `latte`).
`theme-registry.js:1-12` states explicitly that palette VALUES still live in
`styles.css` and `terminal.js`; the registry is metadata only.

### 3.2 Where each theme's palette block lives in `styles.css`

| Theme | Palette block | Extra per-theme rules |
|---|---|---|
| Mocha (default `:root`) | 21-135 | `::selection` 148-151 |
| latte | 8171-8207 | 4585, 4589, 4593, 4620, 8209, 8210, 9300, 9305, 9310, 9314 (11 selectors total) |
| frappe | 9323-9359 | 9361, 9362, 9365, 9370, 9375, 9379 |
| macchiato | 9388-9424 | 9426, 9427, 9430, 9435, 9440, 9444 |
| cherry | 9452-9484 | 9485, 9486, 9488, 9493, 9498, 9502 |
| ocean | 9511-9543 | 9544, 9545, 9547, 9552, 9557, 9561 |
| amber | 9570-9602 | 9603, 9604, 9606, 9611, 9616, 9620 |
| mint | 9629-9661 | 9662, 9663, 9665, 9670, 9675, 9679 |
| nord | 10374-10404 | 10405-10410 |
| dracula | 10416-10448 | 10449-10452 |
| tokyo-night | 10458-10490 | 10491-10494 |
| rose-pine-dawn | 10500-10532 | 10533-10536 |
| gruvbox-light | 10542-10574 | 10575-10578 |

Every non-Mocha theme carries the same six-selector tail:
`.theme-icon-moon`, `.theme-icon-sun`, `::selection`, `.stat-dot-running`,
`.terminal-pane-empty.drag-over .terminal-container`, `.terminal-resize-handle:hover`.
Those exist only because the four latter rules were written with hardcoded `rgba()`
in the Mocha layer, so each theme has to restate them. `semantic-theme.css:44-60`
already provides token-driven replacements for all four; the per-theme copies are dead
weight that a restyle should delete.

### 3.3 The switching path

1. **Pre-paint bootstrap.** `index.html:23-78` reads `localStorage.cwm_theme_choice`
   then `localStorage.cwm_theme`, resolves through `MyrlinThemeRegistry`, and stamps
   `data-theme`, `data-theme-choice`, `data-theme-appearance`, `data-density`,
   `data-ui-shell` and `--ui-scale` on `<html>` before any stylesheet paints.
2. **UI controls.** Three entry points:
   - Legacy dropdown `#theme-dropdown` with 13 `.theme-option[data-theme]` buttons
     (`index.html:312-328`). Wired at `app.js:742-748`.
   - Focused shell intercept: clicking `#theme-toggle-btn` while
     `data-ui-shell === "focused"` opens the Appearance dialog instead
     (`app.js:734-737`), which renders `#theme-gallery` and `#density-choices`
     (`app.js:4815-4900`).
   - Context menu theme submenu (`app.js:18258-18300`).
3. **`setTheme(themeName)`** at `app.js:4703-4763`:
   maps `mocha` to `myrlin-dark` and `latte` to `myrlin-light`, resolves through the
   registry, writes `dataset.theme` and `dataset.themeChoice`, persists both
   localStorage keys, updates dropdown active states, re-applies the xterm theme to
   every live pane and every cached group pane, sets `dataset.themeAppearance` and
   `documentElement.style.colorScheme`, and rewrites the `theme-color` meta from the
   computed `--bg-secondary`.
4. **CSS cascade.** `:root[data-theme="<id>"]` blocks redefine the palette. Everything
   downstream that used `var()` follows automatically. Everything that used a literal
   does not (section 4).
5. **System sync.** A `matchMedia('(prefers-color-scheme: light)')` listener at
   `app.js:756-768` re-runs `setTheme('system')` whenever the OS appearance flips and
   the stored choice is `system`.

### 3.4 localStorage keys touched by the appearance system

| Key | Written at | Values |
|---|---|---|
| `cwm_theme` | `app.js:4727` | resolved theme id |
| `cwm_theme_choice` | `app.js:4728` | `system` / `myrlin-dark` / `myrlin-light` / legacy id |
| `cwm_density` | `app.js:4777` | `quiet` / `informative` |
| `cwm_ui_scale` | `app.js:5008` | float 0.85 to 1.2 |
| `cwm_viewMode` | `setViewMode()` | active view id |
| `cwm_copyhint_v1` | `terminal.js:5194` | one-time copy-hint dismissal |

`theme-registry.js:3-7` warns that theme ids are persistence ids already in users'
localStorage and must not be renamed.

---

## 4. Hardcoded-colour hotspots (these will NOT follow a token swap)

Machine census over the four stylesheets: **179 lines carry a colour literal outside
a `:root` palette block**, spanning **124 distinct literal values**. Palette blocks
themselves account for 378 further literal lines, which is expected and correct.

### 4.1 The Mocha bleed: literals that encode Catppuccin Mocha RGB

These are the highest-risk sites. The value is Mocha's hex expressed as `rgba()`, so
every non-Mocha theme is already slightly wrong today, and a Notion palette swap will
leave visible purple, green and pink.

| Literal | Palette equivalent | Count | Sites |
|---|---|---:|---|
| `rgba(203,166,247,*)` | `--mauve` | 26 across alphas .03/.05/.1/.12/.15/.2/.25/.3/.4/.45/.5 | `styles.css` 149, 236, 351, 482, 493, 656, 657, 691, 698, 707, 708, 837, 843, 1903, 2561, 2567, 3830, 3921, 4315, 5075, 5354, 5580, 5686, 7820, 8076, 8079 |
| `rgba(166,227,161,*)` | `--green` | 15 | 407, 437, 487, 941, 1925, 1956, 1957, 2559, 2684, 2690, 2924, 2925, 5695, 7065, 7945, 8030, 8116 |
| `rgba(243,139,168,*)` | `--red` | 14 | 246, 285, 417, 447, 753, 754, 2694, 2700, 3663, 3673, 3835, 5856, 7066, 7169, 7937, 11119 |
| `rgba(249,226,175,*)` | `--yellow` | 13 | 422, 452, 477, 2564, 2714, 2720, 2844, 2865, 4547, 4576, 4604, 5534, 7064, 7921, 8038 |
| `rgba(137,180,250,*)` | `--blue` | 10 | 472, 1189, 2560, 2704, 2710, 7067, 7128, 7929, 8011, 8015, 8077 |
| `rgba(148,226,213,*)` | `--teal` | 5 | 2563, 2569, 2724, 2730, 8078 |
| `rgba(250,179,135,*)` | `--peach` | 3 | 2562, 2568 |
| `rgba(108,112,134,0.15)` | `--overlay0` | 1 | 442 |
| `rgba(69,71,90,0.4)` | `--surface1` | 1 | 382 |
| `rgba(17,17,27,*)` | `--crust` | 4 | 2011, 3406, 9784, `styles-mobile.css:267` |
| `rgba(205,214,244,*)` | `--text` | 2 | 5482 |

Concentrated component families: status dots and badges (`styles.css:395-514`),
session inline badges (456-514), login screen glow (656-754), quick-switcher result
type chips (2559-2572), worktree review buttons (2684-2736), diff file status and
line backgrounds (7064-7175), resource action buttons (7921-7948), port/git badges
(8011-8040), the RGB border glow keyframes (8075-8082).

### 4.2 Latte-family literals

`styles.css:4586, 4590, 4594, 4621` are `:root[data-theme="latte"]` overrides written
with Latte's own hex expressed as `rgba()` (`rgba(223,142,29,*)` = Latte yellow,
`rgba(64,160,43,0.1)` = Latte green). They exist purely to patch the Mocha literals
above. `styles.css:5062-5065` (`.board-card-priority-*`) uses Latte hex values
(`rgba(210,15,57,.15)`, `rgba(254,100,11,.15)`, `rgba(30,102,245,.15)`,
`rgba(172,176,190,.15)`) as the DARK-theme backgrounds, which is a pre-existing bug.

### 4.3 The per-theme tail (48 literals, 12 themes x 4 rules)

Each non-Mocha theme restates `::selection`, `.stat-dot-running`,
`.terminal-pane-empty.drag-over .terminal-container`, and
`.terminal-resize-handle:hover` with its own literal rgba. See 3.2 for line numbers.
`semantic-theme.css:44-60` already replaces all four with token-driven rules scoped to
`:root[data-ui-shell]`, so the tail is redundant in the focused shell but still active
in classic.

### 4.4 Neutral / black literals

- Shadow alphas `rgba(0,0,0,0.15 .. 0.45)` appear in 15 non-palette sites:
  `styles.css` 3575, 3741, 5168, 5342, 5978, 6567, 6975, 9794, 9876, 10142, 11409,
  plus the four `--shadow-*` token definitions. Deliberate for depth, but the Notion
  system uses different elevation values.
- `rgba(255,255,255,0.025 .. 0.04)` hover washes at `styles.css:887` (`.view-tab:hover`),
  `1179` (`.workspace-item:hover`), `1474` (`.session-item:hover`). These break in light
  themes because white-on-light is invisible.
- `#000` at `styles.css:5473` (`.instance-indicator-inner` divider) and
  `styles-mobile.css:1116-1117` (mask gradients, harmless).

### 4.5 Literals inside JavaScript

| Location | What | Risk |
|---|---|---|
| `app.js:30-95` | Two full boot-failure screens ("UI Failed to Load", "Server Unreachable") with `#1e1e2e`, `#cdd6f4`, `#f38ba8`, `#a6adc8`, `#585b70`, `#a6e3a1`, `#313244`, `#45475a` | Intentional: these render when `styles.css` may not have loaded. Keep literals, restyle to Notion neutrals. |
| `app.js:2000-2002` | `var(--mauve, #cba6f7)` / `var(--crust, #11111b)` fallbacks on a toolbar toggle | Fallback only. |
| `app.js:4130`, `16768` | `console.log` styling | Harmless. |
| `app.js:25461` | `getPropertyValue('--text') \|\| '#cdd6f4'` for the pairing QR code | Fallback only. |
| `terminal.js:223-421` | **8 complete static xterm palettes, 264 hex literals.** See section 6. | High: a Notion terminal palette must be authored here, not derived. |
| `terminal.js` inline `cssText` (14 sites) | Every declaration uses `var(--token, #mochaHex)` form | Fallbacks are Mocha-specific but only fire if the stylesheet is missing. |

`app.js` also carries **182 `style="` inline attributes** in template strings. Most use
`var(--token)`; the notable value-computing ones are `app.js:13787` and `22658`
(`urgencyColor` picks `var(--red)`/`var(--yellow)`/`var(--green)`), `app.js:21691`
(`barColors` array of 8 `var()` strings), `app.js:22937` (`statusColors`), and
`app.js:7759` (`prColors`). These are token names, so they survive a palette swap but
NOT a token rename.

### 4.6 JS colour maps that are token NAMES, not values

A rename of the palette tokens breaks these silently. All of them build
`var(--<name>)` strings by concatenation.

| Source | Palette |
|---|---|
| `instance-colors.js:17` `TAB_COLORS` | `red, yellow, green, teal, blue, mauve` |
| `app.js:247` `PANE_SLOT_COLORS` | `mauve, blue, green, peach, red, pink` |
| `app.js:7697` `_tagColor` palette | `teal, pink, sky, peach, lavender, flamingo, sapphire, rosewater` |
| `app.js:20200` `FOLDER_COLORS` | `mauve, blue, green, peach, red, pink, teal, yellow` |
| `app.js:12989` `colorMap[ws.color]` | workspace colour picker, see `styles.css:3423-3462` |

### 4.7 Hardcoded swatches in markup

`index.html:314-327`: all 13 `.theme-swatch` spans carry an inline
`style="background:#..."` (or a `linear-gradient`). These are literal theme previews and
must be regenerated if the theme set changes. `index.html:6` hardcodes
`<meta name="theme-color" content="#1e1e2e">`.

---

## 5. The mobile layout system

### 5.1 Breakpoints in use

| Query | Files | Purpose |
|---|---|---|
| `max-width: 768px` | `styles.css` (6 blocks: 2977, 3127, 3207, 3331, 5327, 6054, 7690), `styles-mobile.css` (10 blocks), `focused-shell.css:1116` | The phone breakpoint. Matches `app.js:711` `get isMobile()`. |
| `max-width: 480px` | `styles-mobile.css:121, 1254`, `styles.css:3370` | Small phone. |
| `max-width: 600px` | `styles.css:10098, 10302` | Session manager and conflict center full-width. |
| `max-width: 1024px` | `styles.css:2970` | Tablet. |
| `max-width: 1120px` and `min-width: 769px` | `focused-shell.css:1096` | Narrow desktop. |
| `min-width: 769px` ladders | `styles.css:8384, 8392, 8400` (account chip), `9259, 9265` (usage meter), `focused-shell.css:291` | Progressive header degradation, documented at `styles.css:8371-8420`. |
| `pointer: coarse` | `focused-shell.css:1050` | Touch laptops and tablets wider than 768. |
| `hover: hover` and `pointer: fine` | `focused-shell.css:373` | Desktop-only hover reveals. |
| `prefers-reduced-motion: reduce` | 11 blocks across all four files | |
| `forced-colors: active` | `semantic-theme.css:82` | |

### 5.2 What changes at 768px

From `styles-mobile.css:211-259`:
- `.mobile-tab-bar` becomes `display: flex`, fixed to the bottom,
  `height: calc(56px + env(safe-area-inset-bottom))`, `z-index: 50`.
- `.header-center .view-tabs` is hidden. `.header-right` is hidden entirely; its
  actions move into the "More" tab (an action sheet).
- `.app-body` gains `padding-bottom: calc(56px + safe-area-inset-bottom)`.
- `.session-detail-panel` becomes a fixed full-screen slide-in
  (`transform: translateX(100%)`, `.mobile-visible` slides it to 0), `z-index: 15`.
- `.toast-container` bottom moves to `calc(72px + safe-area-inset-bottom)`.

From `styles-mobile.css:9-119` (Phase 1 foundation):
- 44px minimum tap targets forced on `.btn-icon`, `.workspace-actions .btn`,
  `.docs-add-btn`, `.view-tab`, `.terminal-pane-close`.
- All `input, textarea, select, .qs-search-input, .input` forced to `font-size: 16px
  !important` to defeat iOS zoom-on-focus.
- Hover-only affordances (`.workspace-actions`, `.docs-item-delete`) forced visible.

From `styles.css:3331-3367`: the app becomes `position: fixed; inset: 0; overflow: hidden`
so the page itself never scrolls under the terminal; `.xterm` gets
`touch-action: pan-y` and `overscroll-behavior: contain`.

### 5.3 Mobile-specific surfaces

| Surface | Container | Styles |
|---|---|---|
| Bottom tab bar | `#mobile-tab-bar` (4 tabs) | M:156-210 |
| Action sheet | `#action-sheet-overlay` > `#action-sheet` (`.action-sheet-handle`, `-header`, `-items`, `-cancel`) | M:261-445, `@keyframes sheet-up` at M:440 |
| Mobile terminal tab strip | `#terminal-tab-strip` | S:3107-3200, M:446-706, M:1105-1138 |
| Mobile terminal toolbar | `.terminal-mobile-toolbar` per pane | S:3201-3259, M:707-846 |
| Mobile type-and-send row | `.terminal-mobile-input-row` per pane | S:5106 (hidden on desktop), M:452+ |
| Terminal reader overlay | `#terminal-reader-overlay` | S:3260-3325 |
| Settings full-screen sheet | `.settings-panel` under M:1033-1083 | |
| Account switcher bottom sheet | `.account-panel` + `.account-panel-backdrop` | M:1139-1265, desktop guard at S:9160-9166 |
| Usage meter sheet mirror | `#account-panel-meter` | M:1266-1308, S:9271-9277 |
| Swipe actions on session rows | `.session-item-wrapper`, `.session-item-swipe-actions` | M:847-900 |

### 5.4 JS side of mobile

- `app.js:710-712`: `get isMobile() { return window.matchMedia('(max-width: 768px)').matches }`.
  Referenced at 20+ sites to branch between context menu and action sheet, board and
  list layouts, sidebar behavior, and terminal mounting.
- `app.js:1561`: sets `--vh` on `documentElement` from the real viewport height.
- `app.js:1596`: a `matchMedia('(max-width: 768px)')` change listener re-runs layout so
  rotating a tablet re-evaluates every `isMobile` branch.
- `terminal.js:2366` `_isMobile()`: a separate, touch-capability-based check used by the
  pane touch scroll and selection engine, deliberately different from the width check.
- `index.html:1948-1980`: two touch shims. First an inline capture-phase guard that stops
  the DragDropTouch polyfill from observing touches inside `.xterm-viewport` /
  `.xterm-screen`. Then `enableDragDropTouch` with `isPressHoldMode: true` and a 350ms
  hold so swipes still scroll.

---

## 6. The terminal surface styling path

There are two independent colour systems on the terminal, and they meet only through
`getComputedStyle`.

### 6.1 CSS side (chrome around the terminal)

| Element | Rule | Colour source |
|---|---|---|
| `.terminal-grid` | `styles.css:5083-5091` | `background: var(--crust)`, `gap: 2px`. Layout is `data-panes="1..6"` driving `grid-template-*` (`styles.css:5092-5097`). |
| `.terminal-pane` | `styles.css:5098-5103` | `background: var(--base)` |
| `.terminal-pane-header` | `styles.css:5107-5113` | `background: var(--mantle)`, border `var(--surface0)`, text `var(--subtext0)` |
| `.terminal-container` | `styles.css:5344` | `flex: 1; overflow: hidden` |
| `.terminal-pane-empty .terminal-container` | `styles.css:5345-5351` | dashed `var(--surface1)`, `::after` content "Drop a session here" |
| `.terminal-pane-empty.drag-over` | `styles.css:5352-5356` | `rgba(203,166,247,0.05)` literal, plus token version at `semantic-theme.css:54-56` |
| `.terminal-resize-handle` | `styles.css:5548-5590` | hover uses `rgba(203,166,247,0.4)` literal, token version at `semantic-theme.css:58-60` |
| Activity dots | `styles.css:5188-5203` | 7 classes, each `var(--mauve/blue/green/peach/yellow/teal/overlay0)` |
| Provider stripes | `styles.css:11500-11642` | `--provider-*-accent` tokens on `[data-provider]` |
| Pane expand stages | `styles.css:5244-5268` | `z-index: 10` (stage 1) and `900` (stage 2) |
| xterm viewport scrollbar | `styles.css:3333-3350` (mobile only), `styles-mobile.css:630-655` | `var(--surface1)`, `var(--overlay0)` |
| Vendor base | `vendor/xterm/xterm.css` | Only structural. It hardcodes `#000`/`#FFF` for the decoration layer at lines 81-95, overridden by the theme object. |

### 6.2 JS side (the xterm cell colours)

`terminal.js` owns the whole ANSI palette. Nothing in CSS can change it.

**Constructor** (`terminal.js:1229-1242`):
```
new Terminal({
  cursorBlink: true, cursorStyle: 'bar',
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  lineHeight: 1.2, scrollback: 5000,
  smoothScrollDuration: TerminalPane.getSmoothScrollDuration(),
  rightClickSelectsWord: false,
  theme: TerminalPane.getCurrentTheme(),
})
```
Font family and size are hardcoded here, NOT read from `--font-mono`.

**Eight static palettes**, each a full 22-key xterm theme object:

| Static | Lines |
|---|---|
| `THEME_MOCHA` | `terminal.js:223-246` |
| `THEME_LATTE` | `terminal.js:248-271` |
| `THEME_FRAPPE` | `terminal.js:273-296` |
| `THEME_MACCHIATO` | `terminal.js:298-321` |
| `THEME_CHERRY` | `terminal.js:323-346` |
| `THEME_OCEAN` | `terminal.js:348-371` |
| `THEME_AMBER` | `terminal.js:373-396` |
| `THEME_MINT` | `terminal.js:398-421` |

**Derived palettes.** `_buildThemePalette(tokens, isLight)` at `terminal.js:428-457`
maps 13 semantic slots onto the 22 xterm keys:
```
background   = base            foreground  = text
cursor       = rosewater       cursorAccent = base
black        = isLight ? subtext1 : surface1
white        = isLight ? surface2 : subtext1
brightBlack  = isLight ? subtext0 : surface2
brightWhite  = isLight ? surface1 : text
red/green/yellow/blue = same tokens
magenta = mauve   cyan = teal   (bright variants identical)
selectionBackground = mauve at 0.25 alpha (0.20 for light)
```
`_colorWithAlpha` (`terminal.js:464-472`) only accepts 6-digit hex, and returns the
supplied fallback for any other format. **This means a Notion palette using `oklch()`,
`hsl()` or `color-mix()` for `--mauve` will silently fall back to the Mocha selection
colour.**

`_getThemeFallback(themeId)` at `terminal.js:478-571` returns the static object for the
8 baked themes, and for `nord`, `dracula`, `tokyo-night`, `rose-pine-dawn`,
`gruvbox-light` it calls `_buildThemePalette` with a hardcoded 13-token literal map
(`terminal.js:488-567`).

`_getCssVariableTheme(fallback, isLight)` at `terminal.js:578-628` reads 13 custom
properties off `document.documentElement` via `getComputedStyle`: `--base`, `--surface1`,
`--surface2`, `--text`, `--subtext0`, `--subtext1`, `--mauve`, `--blue`, `--green`,
`--yellow`, `--red`, `--teal`, `--rosewater`.

`getCurrentTheme()` at `terminal.js:630-643` is the entry point. It reads
`document.documentElement.dataset.theme`, and **only the five CSS-derived themes take
the `getComputedStyle` path**. The other eight return their frozen static object, so
editing `styles.css` alone will not change the terminal for Mocha, Latte, Frappe,
Macchiato, Cherry, Ocean, Amber or Mint.

**Re-application on theme change:** `app.js:4740-4750` walks `this.terminalPanes` and
`this._groupPaneCache` and assigns `tp.term.options.theme = TerminalPane.getCurrentTheme()`.

### 6.3 JS injected styles on the terminal surface

All of these are `element.style.cssText` strings with the `var(--token, #mochaFallback)`
idiom. They have no CSS file and will not be found by a stylesheet-only restyle.

| Surface | Line | Notable declarations |
|---|---|---|
| Select mode strip `.terminal-selectmode-strip` | `terminal.js:4044-4057` | `font: 11px/1.4 'Plus Jakarta Sans'`, `color: var(--text,#cdd6f4)`, `background: var(--surface0, rgba(24,24,37,0.94))`, `border: 1px solid var(--mauve,#cba6f7)`, `border-radius: 8px`, `box-shadow: 0 6px 18px rgba(0,0,0,0.35)`. Bottom offset re-measured per show by `_applySelectStripPlacement`. |
| Select mode toggle button state | `terminal.js:4003-4004` | sets `.style.color` / `.style.background` directly |
| Copy view root `.terminal-copyview` | `terminal.js:4299-4302` | `z-index: 40`, `background: var(--mantle,#181825)`, `border-top: 1px solid var(--surface1,#45475a)` |
| Copy view bar | `terminal.js:4306-4309` | `background: var(--surface0,#313244)`, `font: 600 12px/1.4 'Plus Jakarta Sans'` |
| Copy view action buttons | `terminal.js:4369-4377` | `btnCss` and close-button css, `border-radius: 6px`, `border: 1px solid var(--surface2,#585b70)` |
| Copy view source toggle | `terminal.js:4390-4395`, re-styled per state at `4947-4949` | active state writes `background`, `color`, `borderColor` inline |
| Copy view `<pre>` | `terminal.js:4382-4386` | `font: 12px/1.5 'JetBrains Mono', 'Cascadia Code', Consolas, monospace` |
| Load-earlier button | `terminal.js:4407-4410` | |
| Inline notice | `terminal.js:4423-4426` | |
| One-time copy hint `.terminal-copy-hint` | `terminal.js:5168-5184` | `border-radius: 10px`, `box-shadow: 0 8px 24px rgba(0,0,0,0.42)`, plus an inline-styled `×` button inside `innerHTML` |
| Copy view toggle button state | `terminal.js:5121-5122` | |
| Mobile paste textarea | `terminal.js:798-823` | `border: none`, `background: transparent`, appended to `document.body` |

The PTY unavailable banner is the one exception: it is built without inline styles
(`terminal.js:1157-1193`) and fully styled in `styles.css:5144-5186` using tokens.

---

## 7. Appendix

### 7.1 z-index ladder (as authored)

| Layer | z | Selector : file:line |
|---:|---|---|
| 0-1 | `0`, `1` | `.session-item-swipe-actions` M:869, `.password-toggle-btn` S:377, `.header-brand` S:825, `.diff-hunk-header` S:7132, `.account-panel-header` S:8490, `.session-item-wrapper .session-item` M:858 |
| 2 | `2` | focused-shell workbench empty state F:423, `.appearance-header` F:803 |
| 5 | `5` | `.terminal-pty-unavailable` S:5150, `.terminal-pane-upload` S:5316, `.terminal-pane-schedule` S:11381, `.codex-pane-status` S:11567 |
| 10 | `10` | `.sidebar-resize-handle` S:1034, `.terminal-pane.pane-expanded-stage1` S:5248, `.voice-interim-overlay` S:5310, `.terminal-resize-handle` S:5554, `.costs-chart-tooltip` S:7478 |
| 15 | `15` | `.session-detail-panel` (mobile) M:238 |
| 20 | `20` | `.app-header` S:788 |
| 25 | `25` | `.sidebar-backdrop` S:3405 |
| 30 | `30` | `.sidebar` S:2998; copy hint (inline) `terminal.js:5168` |
| 40 | `40` | Copy view overlay (inline) `terminal.js:4299` |
| 50 | `50` | `.mobile-tab-bar` M:164 |
| 100 | `100` | `.theme-dropdown` S:8236, `.account-panel` S:8445 |
| 200 | `200` | `.toast-container` S:2747 |
| 900 | `900` | `.terminal-pane.pane-expanded-stage2` S:5258 (deliberately below 1000, see comment S:5254) |
| 1000 | `1000` | `.session-manager-overlay` S:9877, `.conflict-center-overlay` S:10143 |
| 9999 | `9999` | `.terminal-reader-overlay` S:3264, `.pane-nav-pulse::after` S:5490, grid drag shield `app.js:18043` |
| 10000 | `10000` | `.context-menu` S:3566, `.fallback-banner` S:2842, `.account-panel-backdrop` M:1162 |
| 10001 | `10001` | `.ctx-submenu` S:3742, `.action-sheet-overlay` M:266, mobile `.account-panel` M:1191, `body.account-sheet-open .app-header` M:1174 |
| 10002 | `10002` | `.modal-overlay`, `.qs-overlay` S:2006 (comment: must beat `.context-menu`) |
| 10003 | `10003` | `.folder-browser-overlay` S:9781 |
| 10004 | `10004` | `.schedule-popover` S:11404 |

`SELECT_STRIP_Z_INDEX` is a constant in `terminal.js` used by the select strip.

### 7.2 Shared primitives to re-author first

| Primitive | File:line | Current recipe |
|---|---|---|
| `.btn` | `styles.css:193-212` | `inline-flex`, gap 6, padding `8px 16px`, `border-radius: var(--radius-md)`, 13px/500 sans, `transition: all var(--transition-fast)`, `:active { transform: scale(0.97) }` |
| `.btn-primary` | `styles.css:226-238` | `background: var(--mauve)`, `color: var(--crust)`, hover `color-mix(... 85%, white)` plus a literal mauve glow |
| `.btn-danger` / `.btn-ghost` / `.btn-icon` / `.btn-sm` / `.btn-full` / `.btn-danger-hover` | `styles.css:240-287` | |
| `.btn-loader` | `styles.css:289-306` | spinner, contradicts the "skeletons over spinners" house rule |
| `.input` | `styles.css:330-352` | `background: var(--surface0)`, `border: 1px solid var(--border-subtle)`, focus ring is a literal mauve rgba |
| `.status-dot` / `.status-badge-*` | `styles.css:395-455` | 8px dots with literal glow shadows |
| `.session-badge-*` | `styles.css:456-514` | port, warn, model, cost, agents, tag, pr |
| `.modal` / `.modal-panel` / `.modal-dialog` | `styles.css:2341-2357` | max-width 440, `var(--radius-lg)`, `var(--shadow-xl)`, `modal-in` 200ms |
| `.modal-overlay` / `.qs-overlay` | `styles.css:2002-2020` | `rgba(17,17,27,0.65)` + `backdrop-filter: blur(8px)`, `padding-top: 15vh` |
| `.context-menu` | `styles.css:3562-3600` | |
| `.toast-*` | `styles.css:2739-2832` | |
| `.skeleton` / `.skeleton-line` | `styles.css:2938-2951` | the shared shimmer used by several loading states. Note `.skeleton-line` is declared twice, at 2944 and again at 4141 (the AI find-card variant), so the later block silently wins for every consumer. |

### 7.3 Size and complexity metrics

| File | `{` count (approx rule count) | `!important` | `color-mix()` |
|---|---:|---:|---:|
| `styles.css` | 1928 | 43 | 45 |
| `styles-mobile.css` | 186 | 31 | 1 |
| `focused-shell.css` | 212 | 15 | 24 |
| `semantic-theme.css` | 13 | 0 | 11 |

Class inventory across the four files: **1205 distinct class selectors** in
**491 naming families**. Largest families by rule count:
`.terminal-pane-*` 105, `.account-row-*` 32, `.terminal-tab-*` 28,
`.terminal-mobile-*` 27, `.terminal-group-*` 26, `.account-panel-*` 25,
`.kanban-column-*` 24, `.theme-icon-*` 24, `.action-sheet-*` 23,
`.terminal-resize-*` 22, `.context-menu-*` 21, `.folder-browser-*` 21,
`.qs-result-*` 20, `.costs-sessions-*` 20, `.wt-review-*` 19,
`.account-chip-*` 19, `.sidebar-*` 18, `.ai-find-*` 18, `.claude-session-*` 18.

### 7.4 Keyframes inventory (all in `styles.css` unless noted)

`spinoff-dot` 517, `logo-float` 701, `logo-glow` 706, `subagent-pulse` 1955,
`login-enter` 2873, `fade-in` 2884, `overlay-in` 2889, `modal-in` 2894,
`toast-in` 2905, `toast-out` 2916, `pulse-green` 2923, `spin` 2928 and 9774,
`skeleton-pulse` 2932 and 6214, `ctx-in` 3599, `skeleton-shimmer` 4149,
`dropPulse` 4323, `activityPulse` 5204, `mic-pulse` 5282, `pane-nav-pulse` 5481,
`tristate-pulse` 5518, `pulse-needs-input` 5538, `rename-flash` 5694, `ai-spin` 6192,
`rgb-border-glow` 8075, `loading-dot-pulse` 8098, `pane-done-flash` 8115,
`drag-merge-pulse` 8162, `account-chip-pulse` 8426, `account-panel-in` 8465,
`machinePillPulse` 8646, `sm-slide-in` 9884, `conflict-pulse` 10333,
`session-live-pulse` 11890, `mirror-msg-in` 12062, `mirror-skeleton-pulse` 12189,
`sheet-up` `styles-mobile.css:440`.

### 7.5 Known pre-existing defects worth fixing during the restyle

1. **Nine unused semantic role tokens** in `semantic-theme.css` (`--surface-sidebar`,
   four `--status-*-surface`, three `--action-*`, `--focus-ring`) and five unused base
   tokens (`--bg-tertiary`, `--bg-elevated`, `--transition-slow`, `--shadow-md`,
   `--provider-gemini-tint`, `--focused-content-max`).
2. **Three palette colours defined 13 times and never used in CSS**: `--sky`,
   `--flamingo`, `--rosewater` (the last is read by JS only).
3. **`styles.css:5062-5065`** uses Latte hex for the dark-theme
   `.board-card-priority-*` chip backgrounds.
4. **White-alpha hover washes** at `styles.css:887`, `1179`, `1474` are invisible on
   the three light themes.
5. **48 redundant per-theme rules** (section 4.3) already superseded by
   `semantic-theme.css:44-60` in the focused shell.
6. **`_colorWithAlpha` only parses 6-digit hex** (`terminal.js:464-472`), so any
   non-hex palette value silently loses the terminal selection colour.
7. **xterm font is hardcoded** at `terminal.js:1233` rather than reading `--font-mono`.
8. **`.btn-loader`** is a spinner; the house style calls for skeletons.
9. **`.skeleton-line` is declared twice** (`styles.css:2944` and `styles.css:4141`),
   so the AI find-card sizing leaks into every other skeleton consumer.

---

## 8. Files an implementation agent will need to touch

Ordered by likely blast radius.

| File | Why |
|---|---|
| `src/web/public/styles.css` | The whole design system, all 13 theme blocks, and 179 hardcoded-colour leak sites. |
| `src/web/public/semantic-theme.css` | The correct hook point for a role-based Notion token layer. |
| `src/web/public/focused-shell.css` | 168 `data-ui-shell` selectors; wins the cascade over everything. |
| `src/web/public/styles-mobile.css` | Phone layout, 44px targets, action sheet, bottom bar. |
| `src/web/public/terminal.js` | 8 static xterm palettes plus 14 inline `cssText` surfaces. |
| `src/web/public/index.html` | 13 hardcoded theme swatches, `theme-color` meta, font links. |
| `src/web/public/app.js` | Boot-failure screens, 182 inline `style=` attributes, 5 token-name colour maps, `setTheme()`. |
| `src/web/public/theme-registry.js` | Only if the theme SET changes. Ids are persisted; do not rename. |
| `src/web/public/mirror-view.js` | 13 `.mirror-*` classes, styled in `styles.css:11906-12201`. |
| `src/web/public/schedules.js` | `.schedule-popover`, styled in `styles.css:11378-11499`. |
| `src/web/public/instance-colors.js` | 6-entry token-name palette. |

Reference material for the target system already in the repo (read-only, not authored
by this inventory): `docs/design/notion-import/_ds/tokens/` (colors, typography,
spacing, effects, motion, `tokens.json`), `docs/design/notion-import/_ds/components/components.css`,
`docs/design/notion-import/_ds/styles.css`, the two `.dc.html` reference screens, and
`docs/design/notion-import/Feature Inventory.md`.
