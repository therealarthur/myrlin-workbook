# TEST-CONSTRAINTS.md

Map of every CI assertion that pins the Myrlin Workbook frontend, written for the Notion
design-language refactor. Implementation agents who have never seen the sources should be
able to work from this file alone when deciding what a restyle may touch.

- Suite entry point: `C:/Users/Arthur/Desktop/cwm-restyle/test/run.js` (`npm test`)
- Baseline on this branch: 1142 assertions, all green
- Frontend-touching subtotal measured file by file: **596 assertions across 35 standalone test files**
- Every one of those 596 is a **source-text scan or a sandboxed execution of extracted source**.
  There is no jsdom, no headless browser, no rendered-pixel check anywhere in `npm test`.
  Nothing in CI looks at how the app *appears*; it looks at whether specific literal strings,
  selectors, class names, attribute orders, method names, and single-line anchors are still
  present in the files.

## Files under test

All paths below are relative to `C:/Users/Arthur/Desktop/cwm-restyle/`.

| Asset | Size | Read by |
|---|---|---|
| `src/web/public/index.html` | 1999+ lines | focused-shell, experience-ux-contract, terminal-select-mode, copy-secure-context-fallback, provider-label-pill, provider-account-tabs, settings-nav-rail, usage-meter |
| `src/web/public/styles.css` | 12202 lines | css-tokens, phantom-tokens, mobile-ux-fixes, search-render, settings-nav-rail, provider-label-pill, workspace-group-ux, codex-status-strip, usage-meter, provider-account-tabs, credential-delete-ui, credential-expiry-ui |
| `src/web/public/styles-mobile.css` | 1315 lines | phantom-tokens, mobile-ux-fixes, usage-meter |
| `src/web/public/focused-shell.css` | 1391 lines | focused-shell, experience-ux-contract, mobile-ux-fixes |
| `src/web/public/semantic-theme.css` | 93 lines | experience-ux-contract |
| `src/web/public/app.js` | 25695 lines | 22 test files |
| `src/web/public/terminal.js` | 5275 lines | 11 test files |
| `src/web/public/theme-registry.js` | 141 lines | theme-registry, focused-shell |
| `src/web/public/experience-model.js` | 199 lines | experience-model, experience-ux-contract |
| `src/web/public/instance-colors.js` | 49 lines | instance-colors |
| `src/web/public/mirror-view.js` | 502 lines | mirror-view-state |
| `src/web/public/provider-specs.js` | 69 lines | idle-signal-dispatch, idle-signal-parity, keybindings-dispatch, idle-notification-gating |

## Classification key

- **FUNCTIONAL** the assertion protects behavior, accessibility, security, or a shipped bug fix.
  The restyle must keep it green unchanged. Renaming the artifact it pins is a regression, not
  a redesign.
- **VISUAL** the assertion pins a specific colour, pixel value, gradient, spacing, or a
  presentation-only class name. Legitimate to update in lockstep with the restyle, but the
  update must be a deliberate edit to the test alongside the source change, never a deletion.
- **HYBRID** the assertion pins a visual value that carries functional meaning (touch-target
  minimums, focus rings, forced-colors support, hidden-attribute honouring). Values may move,
  the guarantee may not.

---

# 1. `test/css-tokens.test.js` (10 assertions)

Reads `src/web/public/styles.css` only. Pure string match.

| # | Pinned artifact | Class | Risk | Action |
|---|---|---|---|---|
| 1 | `--provider-claude-accent: var(--mauve)` at `:root` (regex `--provider-claude-accent:\s*var\(--mauve\)`) | VISUAL | HIGH | Update expectation if Notion palette renames `--mauve`. Keep the token name `--provider-claude-accent`. |
| 2 | `--provider-codex-accent: var(--green)` | VISUAL | HIGH | Same |
| 3 | `--provider-gemini-accent: var(--blue)` | VISUAL | HIGH | Same. Gemini token is reserved and unused; must still exist. |
| 4 | `--provider-claude-tint: color-mix(in srgb, var(--mauve) <1-2 digits>%, transparent)` | VISUAL | HIGH | Percentage may drift in `[0..99]`. The `color-mix(in srgb, var(--X) N%, transparent)` shape is mandatory. |
| 5 | `--provider-codex-tint` same shape with `var(--green)` | VISUAL | HIGH | Same |
| 6 | `--provider-gemini-tint` same shape with `var(--blue)` | VISUAL | HIGH | Same |
| 7 | Zero hex literals in any `--provider-*-{accent,tint}` value (regex `--provider-[a-z]+-(accent\|tint):\s*[^;]*#[0-9a-fA-F]+`) | FUNCTIONAL | MEDIUM | Keep green. This is the theme-cascade guard. A Notion palette must be expressed as tokens, never inlined hex at the provider layer. |
| 8 | Literal substring `.terminal-pane[data-provider="claude"]:not(.terminal-pane-empty)` | FUNCTIONAL | HIGH | Keep green. Exact selector text including `:not()`. |
| 9 | Literal substring `.terminal-pane[data-provider="codex"]:not(.terminal-pane-empty)` | FUNCTIONAL | HIGH | Keep green |
| 10 | `linear-gradient(180deg, var(--provider-claude-tint) 0, transparent <N>px)` with `16 <= N <= 128` | VISUAL | HIGH | Notion's flat aesthetic will want to drop this gradient. Doing so needs an explicit test edit. |

---

# 2. `test/phantom-tokens.test.js` (8 assertions)

Reads `styles.css` and `styles-mobile.css`, strips `/* */` comments, then diffs defined vs
consumed custom properties. This is the single most important gate for a token-system swap.

| # | Pinned artifact | Class | Risk | Action |
|---|---|---|---|---|
| 1 | Every `var(--x)` consumed in `styles.css` or `styles-mobile.css` is defined in one of those two files, or is on the dynamic allow list | FUNCTIONAL | CRITICAL | Keep green. Note `focused-shell.css` and `semantic-theme.css` are NOT scanned as definition sources, so a token defined only there and consumed in `styles.css` fails this gate. |
| 2 | `DYNAMIC_TOKENS` allow list has no stale entries: `--ws-color`, `--ws-group-color`, `--group-color`, `--tab-color`, `--folder-color`, `--c-outer`, `--c-inner`, `--vh` must each still be consumed somewhere | FUNCTIONAL | HIGH | If a restyle deletes the rule that consumes one of these, delete the allow-list entry too. |
| 3-7 | `--bg-hover`, `--border`, `--surface-1`, `--surface-2`, `--text-base` each defined as `NAME: var(--something)` and NOT as `NAME: #hex` | FUNCTIONAL | HIGH | Keep green. These five were phantom tokens that shipped broken; they must stay var() aliases. |
| 8 | No `var(--radius-sm, 4px)` and no `var(--radius-xs, 3px)` contradictory fallbacks | FUNCTIONAL | MEDIUM | If Notion radii change, do not reintroduce fallback values that disagree with the token. |

Practical rule: **new tokens are free; removing an existing token is only safe if every
`var()` reference to it in both `styles.css` and `styles-mobile.css` goes at the same time.**

---

# 3. `test/experience-ux-contract.test.js` (9 assertions)

Reads `index.html`, `app.js`, `focused-shell.css`, `semantic-theme.css`, `experience-model.js`.
Uses `methodBody()` with regex `\n\s{2}(?:async\s+)?NAME\s*\([^)]*\)\s*\{`, so every app.js
method it names must stay at exactly two-space class indentation.

| Pinned artifact | Class | Risk | Action |
|---|---|---|---|
| Asset load ORDER in `index.html`: `semantic-theme.css` before `focused-shell.css`; `theme-registry.js` before `experience-model.js` before the first inline `<script>` | FUNCTIONAL | HIGH | Keep green. Any new Notion stylesheet must be inserted without reordering these four. |
| Cachebuster `?v=20260725-5` on ALL FOUR of `semantic-theme.css`, `focused-shell.css`, `theme-registry.js`, `experience-model.js` | VISUAL/OPS | CRITICAL | The restyle MUST bump this token for browsers to pick up new CSS, and MUST update the literal `20260725-5` in this test at the same time. |
| Tasks tab vocabulary: `data-tasks-tab="worktree"` labelled `Agent Tasks`; `data-tasks-tab="td"` labelled `Issues`; the strings `Worktree Tasks` and bare `td` must NOT appear between `id="tasks-tab-strip"` and `id="tasks-layout-toggle"` | FUNCTIONAL | MEDIUM | Keep green. Copy is pinned. |
| `<span class="docs-section-title"> Checklist </span>`, `placeholder="Filter agent tasks..."`, `>New agent task</button>`, `<h3>New Agent Task</h3>` | FUNCTIONAL | MEDIUM | Keep green. Exact user-facing strings. |
| `<select id="docs-workspace-select" class="docs-workspace-select" aria-label="Project for notes">`, wired via `docsWorkspaceSelect: document.getElementById('docs-workspace-select')`, change handler routing to `selectWorkspace(workspaceId || null)`, and populated with options | FUNCTIONAL | HIGH | Keep green |
| `focused-shell.css` must contain `@media (max-width: 768px)` ... `.docs-workspace-select { ... min-height: 44px` | HYBRID | HIGH | 44px touch floor. Value may change only upward. |
| `#attention-queue-btn` with `aria-haspopup="menu"`, `aria-expanded="false"`, `aria-controls="context-menu"`, `aria-label="Session attention queue"`, plus `#attention-queue-badge` | FUNCTIONAL | HIGH | Keep green |
| `semantic-theme.css` rule `.attention-state[data-attention-state="needs-input"]` referencing `--status-needs-input` | FUNCTIONAL | HIGH | Keep green |
| `focused-shell.css` `.attention-queue-btn:focus-visible` | HYBRID | HIGH | Focus ring must survive any restyle |
| Density pre-paint: `savedDensity = localStorage.getItem('cwm_density')` and `dataset.density = experienceModel...normalizeDensity(savedDensity)` inline in `index.html` | FUNCTIONAL | HIGH | Keep green. This is FOUC prevention. |
| `setDensity()` body contains `normalizeDensity`, `this.state.density =`, `document.documentElement.dataset.density =`, `localStorage.setItem('cwm_density'`, `persist`, and does NOT contain `new TerminalPane`, `.dispose(`, `closeTerminal`, `.connect(`, `new WebSocket` | FUNCTIONAL | HIGH | Keep green. Density changes must never rebuild terminals. |
| `focused-shell.css` contains `data-density="informative"` ... `#header-stats` | VISUAL | HIGH | Update expectation if the header stats block is redesigned; keep the density hook. |
| Appearance modal: `#appearance-overlay`, `#appearance-dialog` with `role="dialog" aria-modal="true" aria-labelledby="appearance-title" tabindex="-1"`, `#appearance-close` with `aria-label="Close appearance"`, `#density-choices`, `#theme-gallery` | FUNCTIONAL | HIGH | Keep green |
| `renderAppearance()` body mentions `DENSITY_CHOICES`, `FEATURED_THEME_CHOICES`, `groupThemes`, `theme-gallery-card`, `aria-pressed` | FUNCTIONAL/VISUAL | HIGH | `theme-gallery-card` is a class name; renaming it needs a test edit. |
| `label: 'Appearance'` followed within 160 chars by `action: () => this.showAppearance(` or `openAppearance(`, and NOT followed within 100 chars by `submenu:` | FUNCTIONAL | MEDIUM | Keep green |
| `focused-shell.css`: `.appearance-dialog ... max-height`, and `@media (max-width: 768px) ... .theme-gallery-grid ... repeat(2` | VISUAL | HIGH | Update expectation if the gallery grid changes column count. |
| `semantic-theme.css` defines all 15 tokens: `--surface-canvas`, `--surface-raised`, `--surface-interactive`, `--surface-selected`, `--color-focus`, `--color-attention`, `--color-success`, `--color-danger`, `--status-needs-input`, `--status-running`, `--status-complete`, `--status-failed`, `--status-stale`, `--selection-bg`, `--focus-ring` | FUNCTIONAL | CRITICAL | Keep green. These are the semantic role names the Notion palette must map INTO, not replace. |
| `semantic-theme.css` has selectors for `data-attention-state="needs-input"\|"running"\|"complete"\|"failed"\|"stale"` | FUNCTIONAL | HIGH | Keep green |
| `semantic-theme.css` contains ZERO raw colours: regex `#[0-9a-f]{3,8}\b\|rgba?\s*\(\|hsla?\s*\(` must not match | FUNCTIONAL | CRITICAL | Keep green. This file must remain 100 percent `var()` references. Notion hex values go in `styles.css` `:root`, never here. |
| `semantic-theme.css` contains `@media (forced-colors: active)` and `outline: 2px solid Highlight` | FUNCTIONAL | HIGH | Keep green. Windows High Contrast support. |
| Git and Files tabs: `data-tasks-tab="git"` and `="files"` each with `data-shell-maturity="retired"` and a bare `hidden` attribute; `focused-shell.css` rule `.tasks-tab[data-shell-maturity="retired"] { ... display: none` | FUNCTIONAL | MEDIUM | Keep green |
| `_initTasksTabs()` contains `savedTab.hidden` and `savedIsAvailable ? saved : 'worktree'`; `_switchTasksTab()` contains `requestedTab.hidden` and `name = 'worktree'` | FUNCTIONAL | MEDIUM | Keep green |
| `renderResources()` emits `resource-row-menu-btn`, `aria-haspopup="menu"`, `aria-expanded="false"`, an Actions accessible name, `data-label="Actions"`; the flow reaches `showContextMenu`/`_renderContextItems`, the actions `restart`/`stop`/`kill`/`start`, and `showConfirmModal` ... `Kill Process` | FUNCTIONAL | HIGH | Keep green |
| `focused-shell.css` `.resource-row-menu-btn:focus-visible`; `@media (max-width: 768px) ... .claude-session-table ... display: block`; `semantic-theme.css` `@media (forced-colors: active) ... .resource-row-menu-btn` | HYBRID | HIGH | The mobile table-to-block collapse is the responsive contract for the sessions table. Keep the mechanism; the exact rule text is pinned. |

---

# 4. `test/focused-shell.test.js` (28 assertions)

Reads `index.html`, `app.js`, `focused-shell.css`, `theme-registry.js`. Uses `balancedBlock()`
which does `source.indexOf(header)` then walks braces, so the **first literal occurrence of the
selector string must be the rule you intend**.

## HTML structure pins (all FUNCTIONAL, HIGH risk)

| Artifact | Detail |
|---|---|
| `<html data-ui-shell="focused">` | Root attribute value must be exactly `focused` |
| Inline shell bootstrap | `new URLSearchParams(location.search).get('ui')` and `shellOverride === 'classic' ? 'classic' : 'focused'` and a `catch (_) {` that sets `dataset.uiShell = 'focused'` |
| Primary view tabs | `.view-tab` buttons with `data-shell-tier="primary"` in EXACT order `['terminal', 'workspace', 'tasks']` |
| Secondary view tabs | `data-shell-tier="secondary"` in EXACT order `['costs', 'recent', 'resources']` |
| Contextual view tabs | `data-shell-tier="contextual"` equals exactly `['docs']` |
| `#focused-more-btn` | Class `focused-more-btn`, must NOT carry class `view-tab`, must have no `data-mode`, must have `aria-haspopup="menu"`, `aria-expanded="false"`, `aria-controls="context-menu"`, and must sit OUTSIDE `<nav id="workbook-view-tabs">` |
| `#mobile-tab-bar` | `.mobile-tab` buttons with `data-view` in EXACT order `['workspace', 'terminal', 'tasks', 'more']` |
| `<section id="workbench-empty-state">` | Contains copy matching `/browse sessions already on this machine/i` and `>Browse sessions</button>`; `#workbench-start-btn` and `#workbench-projects-btn` both exist and are bound in `app.js` `els` |
| `#context-menu` | `role="menu"` |
| `#action-sheet` | `role="dialog"`, `aria-modal="true"`, `tabindex="-1"` |
| Docs disclosures | `.docs-section-header` must be `<button type="button" aria-expanded="true">` elements whose `aria-controls` values are EXACTLY, in order: `docs-notes-list`, `docs-goals-list`, `docs-tasks-list`, `docs-td-list`, `docs-roadmap-list`, `docs-rules-list`, `docs-ai-insights`; ZERO `<div class="docs-section-header">` may exist |
| Theme script tag | `<script src="theme-registry.js...">` present; inline `savedChoice = 'system'` |

## CSS block pins in `focused-shell.css`

| Selector header that must exist verbatim | Required contents | Class | Risk |
|---|---|---|---|
| `:root[data-ui-shell="focused"] .focused-more-btn:focus-visible` | `outline: 2px solid var(--accent);` then `outline-offset: 2px;` in that order | HYBRID | HIGH |
| `@media (max-width: 768px)` then nested `:root[data-ui-shell="focused"] #term-pane-0.terminal-pane-empty:not([hidden])` | `display: flex !important;`; and the bare `#term-pane-0.terminal-pane-empty { display: flex !important` form must NOT exist | FUNCTIONAL | HIGH |
| `@media (min-width: 769px) and (max-width: 1559px)` | `.terminal-grid[data-panes="5"]`, `[data-panes="6"]`, `grid-template-columns: 1fr 1fr !important;`, `grid-template-rows: 1fr 1fr 1fr !important;`, `.terminal-resize-row`, `display: none !important;` | VISUAL | HIGH |
| `:root[data-ui-shell="focused"] .main-content` | `container-name: workbook-main;` and `container-type: inline-size;` | FUNCTIONAL | HIGH |
| `@container workbook-main (max-width: 1399px)` | same five-pane and six-pane grid overrides as above | VISUAL | HIGH |
| `:root[data-ui-shell="focused"][data-theme="latte"]` | `--text-tertiary: var(--subtext1);` | VISUAL | HIGH |
| `.docs-section[data-empty="true"]` | `margin-bottom: 2px;` | VISUAL | MEDIUM |
| `.docs-section-heading > .docs-section-header` | `appearance: none;`, `border: 0;`, `background: transparent;`, `text-align: left;` | FUNCTIONAL | HIGH |
| `.docs-section-actions` | `display: inline-flex;` | VISUAL | MEDIUM |
| Sidebar tertiary text rule | one `.sidebar :is(...)` rule listing `.sidebar-meta`, `.workspace-group-empty`, `.ws-session-empty`, `.project-session-time`, `.sidebar-section-divider-label` ending `color: var(--text-tertiary) !important;` | VISUAL | HIGH |
| Sidebar inline-style override | `.sidebar-list [style*="color: var(--overlay0)"] ... color: var(--text-tertiary) !important;` | VISUAL | HIGH |
| First-run scaffolding | `@supports selector(.sidebar:has(#sidebar-create-ws))` plus `.sidebar:has(#sidebar-create-ws):not(:has(#projects-list .project-accordion))` and mentions of `#sidebar-provider-tabs`, `.sidebar-footer`, `#sidebar-section-resize`, `#projects-header`, `#projects-search-bar`, `#projects-list` and `display: none;` | VISUAL | HIGH |
| `@media (pointer: coarse)` | must mention `#sidebar-toggle`, `#account-chip`, `.terminal-group-tab`, `.terminal-groups-add`, `.docs-section-header`, `.docs-section-actions > button`, `#appearance-close`, `#resources-refresh-btn`, `.terminal-pane-header > button` and contain `min-height: 44px;`; nested `:root[data-ui-shell="focused"] .terminal-group-tab-close` needs `min-width: 44px;` and `min-height: 44px;` | HYBRID | CRITICAL |
| `.resource-row-menu-btn {` | rule must exist | VISUAL | MEDIUM |
| `:root[data-ui-shell="focused"] .terminal-pane[data-provider="claude"]:not(.terminal-pane-empty),` (trailing comma is part of the anchor) | `border-top: 1px solid`, `border-bottom: 0;`, `background: var(--base);` | VISUAL | HIGH |
| `@media (hover: hover) and (pointer: fine)` | must mention `.terminal-pane-header > button`, `.terminal-pane-header:hover > button`, `.terminal-pane-header:focus-within > button`, `.terminal-pane-mic.mic-active`, `.terminal-pane-expand-stage1`, `.terminal-pane-collapse:not([hidden])`, and `opacity: 1;` | FUNCTIONAL | HIGH |
| `:root[data-ui-shell="focused"] .tasks-tab[data-shell-maturity="retired"]` | `display: none;` | FUNCTIONAL | MEDIUM |

## app.js method pins (all FUNCTIONAL)

`_handleContextMenuKeydown` (ArrowDown/Up/Right/Left, `e.key === 'Tab'`), `hideContextMenu`
(`restoreFocus`), `_renderContextItems` (`hideContextMenu({ restoreFocus: true })`),
`showActionSheet` (`_actionSheetReturnFocus`), `hideActionSheet` (`returnFocus.focus`),
`init` (`params.delete('token')`, `remainingQuery = params.toString()`, `window.location.hash`,
`replaceState({}, '', sanitizedUrl)`, and must NOT contain `replaceState({}, '', window.location.pathname)`),
`setViewMode` (`['costs', 'recent', 'docs', 'resources'].includes(mode)`,
`tab.dataset.view === 'more' && isMoreDestination`, `setAttribute('aria-current', 'page')`),
`_syncDocsSectionDensity`, `_setDocsSectionExpanded`, `bindEvents`, `getSettingsRegistry`
(compiled and executed: `sessionCountInHeader` and `headerHeight` must be absent for
`uiShell: 'focused'` and present for `'classic'`; `uiScale` must be present for focused),
`loadAll` (`['...','tasks',...].includes(savedViewMode)`), `_initTasksTabs`, `_switchTasksTab`,
`setProjectsCollapsed`, `toggleProjectsPanel`, `_buildThemeMenuItems`, plus
`class="resource-row-menu-btn"`, `aria-haspopup="menu" aria-expanded="false"` (exactly one space),
`showResourceRowMenu(btn)`, and the negative `class="resource-action-btn` must NOT appear.

---

# 5. `test/theme-registry.test.js` (12 assertions)

Reads `theme-registry.js` (as CommonJS and as text) and executes `terminal.js` in a `vm`.
**This is the hardest ceiling on a theme redesign.**

| Pinned artifact | Class | Risk | Action |
|---|---|---|---|
| `THEME_REGISTRY.length === 13` and `LEGACY_THEME_IDS` deep-equals `['mocha','macchiato','frappe','nord','dracula','tokyo-night','cherry','ocean','amber','mint','latte','rose-pine-dawn','gruvbox-light']` | FUNCTIONAL | CRITICAL | Adding a Notion theme requires editing this array literal in the test. Removing any of the 13 breaks persisted user preferences. |
| Theme ids and labels are unique | FUNCTIONAL | LOW | Keep green |
| `getTheme('frappe').label === 'Frappé'` AND registry SOURCE contains the escape `'Frapp\u00e9'` AND does NOT contain the literal accented character | FUNCTIONAL | MEDIUM | Keep green. ASCII-safe source rule. |
| Every theme has `appearance` in `{dark, light}`, `tier` in `{featured, more}`, string `xterm.paletteId`, boolean `xterm.fallback`, and both objects `Object.isFrozen` | FUNCTIONAL | HIGH | Keep green |
| `resolveXtermPaletteId(id) === id` for all 13; `resolveXtermPaletteId('unknown-theme') === 'mocha'` | FUNCTIONAL | HIGH | Keep green |
| **Exact xterm fallback background hex per theme**: mocha `#1e1e2e`, macchiato `#24273a`, frappe `#303446`, nord `#2e3440`, dracula `#282a36`, tokyo-night `#1a1b26`, cherry `#221a22`, ocean `#1a1e28`, amber `#211e1a`, mint `#1a2120`, latte `#eff1f5`, rose-pine-dawn `#faf4ed`, gruvbox-light `#fbf1c7` | VISUAL | CRITICAL | Recolouring any of the 13 themes requires editing this hex table in the test. |
| `TerminalPane.getCurrentTheme()` derives from CSS vars `--base --surface1 --surface2 --text --subtext0 --subtext1 --mauve --blue --green --yellow --red --teal --rosewater` with the exact mapping background=base, foreground=text, cursor=rosewater, black=surface1, red=red, blue=blue, magenta=mauve, cyan=teal, and `selectionBackground: 'rgba(R, G, B, 0.25)'` derived from `--mauve` | FUNCTIONAL | CRITICAL | The Catppuccin variable NAMES are load bearing for the terminal palette. A Notion palette must alias into these exact names, not replace them. |
| Unknown theme id returns the literal `TerminalPane.THEME_MOCHA` object with background `#1e1e2e` | FUNCTIONAL | HIGH | Keep green |
| `FEATURED_THEME_CHOICES` ids deep-equal `['system','myrlin-dark','myrlin-light']`; labels `System`, `Myrlin Dark`, `Myrlin Light`; `resolveFeaturedChoice('myrlin-dark') === 'mocha'`, `('myrlin-light') === 'latte'`, `('system','dark') === 'mocha'`, `('system','light') === 'latte'`, `('missing') === null`; `system.persistedThemeId === null` | FUNCTIONAL | CRITICAL | A Notion default theme would naturally want `myrlin-dark -> notion-dark`. That is a test edit plus a migration story for persisted `cwm_theme` values. |
| `THEME_REGISTRY.filter(tier === 'featured')` deep-equals `['mocha','latte']` | FUNCTIONAL | HIGH | Keep green or edit together with the alias targets |
| No `global.MyrlinThemeRegistry` leak on CommonJS require; browser eval exposes one frozen `MyrlinThemeRegistry` with 13 entries | FUNCTIONAL | LOW | Keep green |
| Registry source contains `kind: 'alias'` (asserted from `focused-shell.test.js`) | FUNCTIONAL | LOW | Keep green |

---

# 6. `test/mobile-ux-fixes.test.js` (26 assertions)

Reads `styles.css`, `styles-mobile.css`, `focused-shell.css`, `app.js`, `terminal.js`.
Uses `ruleBody(css, selector)` which searches for the literal `selector + ' {'` and slices to
the **first `}`**. Consequences the restyle must respect:

1. The selector must appear as a standalone rule with exactly one space before `{`.
   Merging it into a grouped selector list (`.terminal-group-tab, .foo {`) makes `ruleBody`
   return empty and the test fails.
2. The rule body may not contain nested braces (no nested at-rule, no nested block).
3. The FIRST occurrence in the file wins.

| Pinned artifact | Class | Risk | Action |
|---|---|---|---|
| `styles.css` `.terminal-group-tab {` body has `touch-action: pan-x` and NOT `touch-action: none` | FUNCTIONAL | HIGH | Keep green |
| `styles.css` `.terminal-groups-tabs {` body has `touch-action: pan-x` and `-webkit-overflow-scrolling: touch` | FUNCTIONAL | HIGH | Keep green |
| `styles.css` `.tab-folder-header {` body has `touch-action: pan-x` | FUNCTIONAL | HIGH | Keep green |
| `styles.css` `.terminal-group-tab-close:focus-visible {` contains `outline: 2px solid var(--accent)` | HYBRID | HIGH | Keep the ring; token may change with a test edit |
| `styles-mobile.css` `.terminal-group-tab-close {` has `min-width: 44px`, `min-height: 44px`, `opacity: 0.5` in that order within one brace-free body | HYBRID | HIGH | Keep green |
| `styles-mobile.css` `.terminal-group-tab {` has `min-height: 44px` | HYBRID | HIGH | Keep green |
| `styles-mobile.css` `#settings-overlay .settings-panel {` has `height: 100dvh` and `border-radius: 0` | VISUAL | HIGH | Update expectation only with an explicit design decision |
| `styles-mobile.css` `#settings-overlay .settings-content {` has `grid-template-columns: 1fr` | VISUAL | HIGH | Same |
| `styles-mobile.css` `#settings-overlay .settings-nav {` has `display: flex` | VISUAL | HIGH | Same |
| `styles-mobile.css` `.terminal-grid[hidden] {` has `display: none !important` | FUNCTIONAL | CRITICAL | Keep green. Without it the terminal leaks into every other mobile view. |
| `styles-mobile.css` has `mask-image: linear-gradient(90deg`, `scroll-snap-type: x proximity`, `scroll-snap-align: start` | VISUAL | HIGH | Update expectation if the tab strip is redesigned |
| `styles-mobile.css` `.terminal-tab-close::before {` has `inset: -13px`; `.terminal-tab-close:focus-visible {` has `opacity: 1` | HYBRID | HIGH | The `-13px` extends an 18px control to a 44px tap target. If the control size changes, the inset must change to preserve 44px and the test must be updated together. |
| `styles-mobile.css` `.account-panel-meter:not([hidden])` inside a `max-width: 768px` media query (asserted from usage-meter) | VISUAL | MEDIUM | See section 12 |
| `focused-shell.css` `.context-menu-sep-labeled ... height: auto` | VISUAL | MEDIUM | Keep green |
| `styles-mobile.css` `.action-sheet-sep-labeled ... .as-sep-label` | VISUAL | MEDIUM | Keep green |

app.js pins (FUNCTIONAL): `const prevScrollLeft = this.els.terminalGroupsTabs.scrollLeft;` and
`this.els.terminalGroupsTabs.scrollLeft = prevScrollLeft;`; `_ensureActiveTabVisible() {`;
`scrollIntoView({ inline: 'nearest', block: 'nearest' })`; `showMoreMenu()` must contain
`label: 'Settings'`+`this.openSettings()`, `label: 'Appearance'`+`this.openAppearance()`,
`label: 'Pair device'`+`showPairMobileModal()`, `label: 'All sessions'`+`toggleSessionManager(`,
`label: 'Recent activity'`+`setViewMode('recent')`, `label: 'Costs'`+`setViewMode('costs')`,
`label: 'System resources'`+`setViewMode('resources')`, `Project notes`+`setViewMode('docs')`,
group separators `type: 'sep', label: '<Views|Session tools|Preferences|Operations|Account>'`,
`Conflicts (${conflictCount})`, and must contain no `icon:` key at all;
`showActionSheet()` nesting behavior and `class="action-sheet-sep action-sheet-sep-labeled"` +
`class="as-sep-label"`; `class="context-menu-sep context-menu-sep-labeled"` + `class="ctx-sep-label"`;
`TERMINAL_SURFACE_SELECTOR = '.terminal-container, .xterm, .terminal-copyview'` (exact literal);
`_buildTerminalTabContextItems(groupId, tabEl) {`; the two-line sequence
`const items = this._buildTerminalTabContextItems(groupId, tab);` immediately followed by
`this._renderContextItems(`; `tabStrip.addEventListener('touchstart'`;
`tabStrip.addEventListener('dragstart', () => clearTimeout(tabLPTimer))`;
`_renderTabButtonHtml()` emitting `<div class="terminal-group-tab-item ...><button type="button" class="terminal-group-tab ...></button> <button type="button" class="terminal-group-tab-close"` with
`aria-label="Close ${escapedName} tab"` and NO `<span class="terminal-group-tab-close"`;
`showTerminalContextMenu()` containing `label: 'Move to Tab...'`;
`matchMedia('(max-width: 768px)')` + `addEventListener('change', onBreakpointChange)`;
`updateTerminalTabs()` emitting `<div class="terminal-tab-item ...><button type="button" class="terminal-tab ...></button> <button type="button" class="terminal-tab-close"` with
`aria-label="Close ${paneName} pane"`; `switchTerminalTab()` containing
`querySelectorAll('.terminal-tab-item')` ... `classList.toggle('active'`;
`wsList/sessList/projList .addEventListener('dragstart'` each followed within 400 chars by
`clearTimeout(wsLPTimer|sessLPTimer|projLPTimer)`.

terminal.js pins (FUNCTIONAL): `_isMobile()` must use `matchMedia('(pointer: coarse)')`,
`maxTouchPoints > 0`, `coarsePrimary && hasTouchPoints`, and must NOT use
`'ontouchstart' in window` in executable code.

**Restyle warning:** the tab markup assertions pin exact tag order, exact
`type="button"` attributes, exact class names, and a single whitespace between the two sibling
buttons. Any template rewrite of the tab strip will break these.

---

# 7. `test/terminal-select-mode.test.js` (23 assertions)

Reads `terminal.js`, `app.js`, `index.html`. Mix of source scan and `vm` execution.

| Pinned artifact | Class | Risk | Action |
|---|---|---|---|
| `index.html` contains `terminal.js?v=20260806-selectv3` | OPS | CRITICAL | Restyle must bump and update the literal here AND in `copy-secure-context-fallback.test.js:381` |
| `index.html` contains `app.js?v=20260805-mobile-select1` | OPS | CRITICAL | Same, and `copy-secure-context-fallback.test.js:382` |
| terminal.js: `SELECT_MODE_STORAGE_PREFIX`, `this._selectMode = TerminalPane._loadSelectModePreference(this.sessionId)`, `_saveSelectModePreference(this.sessionId, this._selectMode)`, `setSelectMode (on)`, `toggleSelectMode ()`, `_installSelectModeInterceptor`, `shiftKey: true`, `__cwmSelSynthetic`, `stopImmediatePropagation`, `e.button !== 0`, `getCopySelection().hasSelection`, `selectedHover`, `selectedRightEdge` | FUNCTIONAL | HIGH | Keep green |
| terminal.js: `_injectCopyControls`, class name `terminal-pane-selectmode`, class name `terminal-pane-header`, class name `terminal-selectmode-strip`, wording matching `/paused/i` | FUNCTIONAL/VISUAL | HIGH | `terminal-pane-selectmode` and `terminal-selectmode-strip` are class names created in JS. Renaming needs a test edit. |
| terminal.js: `cwm_copyhint_v1` localStorage gate, hint text mentions `Shift`, and `_maybeShowCopyHint()` calls `localStorage.setItem('cwm_copyhint_v1', '1')` | FUNCTIONAL | MEDIUM | Keep green |
| terminal.js Ctrl+C branch (anchor `if (mod && shortcutKey === 'c')` to `// Ctrl+V / Cmd+V`) uses `getCopySelection()`, has `copySelection.hasSelection) return false`, and contains NO `preventDefault` and NO `copyTextToClipboard` | FUNCTIONAL | CRITICAL | Keep green. Security/behavior fix. |
| terminal.js `dispose()` has `removeEventListener('mousedown', this._selMouseHandler` and `this._selectModeBtn.remove()` | FUNCTIONAL | HIGH | Keep green |
| app.js anchor `  _focusTerminalPaneFromPointer(slotIdx, event) {` (exactly two leading spaces) | FUNCTIONAL | CRITICAL | Anchor. Must survive verbatim. |
| app.js end anchor `\n  setActiveTerminalPane(slotIdx) {` (used for the scoped body slice) | FUNCTIONAL | CRITICAL | The method `setActiveTerminalPane` must remain the NEXT method after `_focusTerminalPaneFromPointer`. |
| app.js end anchor `\n  /**\n   * Set the active terminal pane` (used by `loadFocusHelper()` after CRLF normalization) | FUNCTIONAL | CRITICAL | The JSDoc block above `setActiveTerminalPane` must literally begin `Set the active terminal pane`. |
| `_focusTerminalPaneFromPointer` body: `getCopySelection()`, `selectedRightPress` ... `stopPropagation` ... `return false`, ordering `if (selectedRightPress)` before `this.setActiveTerminalPane(focusSlot)`, `this._activeTerminalSlot === focusSlot` | FUNCTIONAL | CRITICAL | Keep green |
| `.xterm` used as the terminal-surface `closest()` selector in the executed focus test | FUNCTIONAL | HIGH | xterm vendor class; do not restyle away |

---

# 8. `test/terminal-select-v2.test.js` (134 assertions)

Largest single file. Reads `terminal.js` and a CRLF-normalized copy of `app.js`.
Uses `extractBlock(src, anchor)` with **single-line anchors**, then walks braces.

## Anchors that must survive verbatim in `terminal.js`

`const isReconnect = this._gotFirstData;`, `this.ws.onopen = () => {`,
`this.term.onData((data) => {`, `if (e.inputType === 'insertFromPaste') {`,
`if (e.inputType === 'insertReplacementText') {`, `if (mod && shortcutKey === 'v') {`,
`if (e.key === 'Enter' && e.shiftKey) {`, `sendCommand(cmd) {`,
`async pasteFromClipboard() {`, `this.ws = new WebSocket(wsUrl);`,
`this._installInputUnfreezeHook(this.ws);`,
`this.term.attachCustomKeyEventHandler((e) => {`, `if (mod && shortcutKey === 'c') {`,
`} else if (msg.type === 'reset') {`, `if (isReconnect && this.term) {`,
`rebindHost(containerId) {`, `mount() {`, `dispose() {`, `detachHostBindings() {`,
`_openCopyView() {`, `_refreshCopyView() {`, `_ensureCopyOverlay() {`,
`const onKey = (e) => {`, `_copyAllFromCopyView() {`, `initMobileInputMode() {`,
`const onTouchStart = (e) => {`, `const onTouchMove = (e) => {`, `const onTouchEnd = (e) => {`,
`_injectCopyControls() {`, `btn.addEventListener('click', (e) => {`, `_destroyCopyView() {`,
`_showSelectModeStrip() {`, `_showSelectModeNotice(text, ms) {`,
`_applySelectStripPlacement() {`, `  safeFit() {` (two-space indent),
`_updateCopyViewUI() {`, `_updateSelectModeUI() {`, `_maybeShowCopyHint() {`,
`_applyCopyOverlayMetrics() {`, `async _copyViewApi(method, path, body) {`,
`async _loadTranscriptSnapshot() {`.

## Anchors that must survive verbatim in `app.js`

`document.querySelectorAll('.terminal-mobile-toolbar button').forEach(btn => {`,
`  switchTerminalTab(slotIdx) {`,
`  showTerminalContextMenu(slotIdx, x, y, copySelection, terminalPane) {`,
plus the exact substring `this._injectMobileSelectControls();` positioned BEFORE the toolbar
querySelectorAll, and `document.addEventListener('cwm:select-chrome'`.

## Inline-style pins inside `_ensureCopyOverlay()` (VISUAL, HIGH risk)

The Copy view overlay is styled with an inline style string built in `terminal.js`, not in CSS.
Assertions require the literals `user-select:text`, `-webkit-user-select:text`, `overflow:auto`,
`white-space:pre-wrap`, `tabIndex`, `JetBrains Mono`, `var(--mantle` or `var(--surface0`,
`var(--text`, `var(--surface1`, and specifically `var(--mantle, #181825)` (a token with a
literal hex fallback). **A Notion restyle that changes the mono font family or the overlay
background token must edit this test.** The `#181825` fallback is a deliberate exception to
the no-hex rule and must remain a var-with-fallback pair.

## Other notable pins

| Artifact | Class | Risk |
|---|---|---|
| `_injectCopyControls` emits `btn btn-ghost btn-icon btn-sm` classes and class `terminal-pane-copyview` | VISUAL | HIGH. `btn btn-ghost btn-icon btn-sm` is the shared header icon-button recipe; renaming the button system breaks this. |
| `header.querySelector('.terminal-pane-copyview')` dedupe lookup | FUNCTIONAL | HIGH |
| `this._selectModeBtn = btn;` must appear BEFORE `terminal-pane-copyview` in the method | FUNCTIONAL | HIGH |
| `_applyCopyOverlayMetrics` sets `minHeight/minWidth = '40px'` and `alignItems = 'center'` on phone | HYBRID | HIGH |
| `_copyOverlayTopPx()` returns the measured `.terminal-pane-header` `offsetHeight`, 0 when hidden, a >0 fallback when absent | FUNCTIONAL | CRITICAL. Depends on `styles-mobile.css` hiding `.terminal-pane-header` at phone widths. |
| `_applySelectStripPlacement` must reference a z-index above 5 with a comment that FABs sit at z-index 5 in `styles.css` | VISUAL | MEDIUM |
| `TerminalPane.SELECT_STRIP_TEXT` must match `/scroll/i`, `/pause/i`, `/drag/i`, `/Ctrl\+C/`, `/Copy view/i`, `/type\|typing/i` and must contain no U+2014 | FUNCTIONAL | MEDIUM |
| `paneEl.classList` toggling of `mobile-active`; `.terminal-mobile-toolbar` presence; `keyboardBtn.classList.toggle('toolbar-active', isTyping)` | FUNCTIONAL | HIGH |
| `TERMINAL_SURFACE_SELECTOR = '.terminal-container, .xterm, .terminal-copyview'` | FUNCTIONAL | HIGH |

---

# 9. `test/terminal-host-ownership.test.js` (15 assertions)

Builds a **fake DOM that mirrors the real pane markup** and runs production `app.js` methods
against it. This makes the pane DOM contract executable, not just textual.

Required per-slot structure (ids are template-literal driven by slot index `N`):

```
<section id="term-pane-N" class="terminal-pane">
  <header class="terminal-pane-header">
    <span class="terminal-pane-title">
    <span class="pane-provider-pill">
    <span id="term-activity-N" class="terminal-pane-activity">
    <button class="terminal-pane-mic">
    <button class="terminal-pane-expand">
    <button class="terminal-pane-collapse">
    <button class="terminal-pane-pinnedoc"><span class="pane-pin-count"></button>
    <button class="terminal-pane-close">
    <span class="pane-view-badge">
    <button class="pane-view-back">
  </header>
  <div id="term-container-N" class="terminal-container">
  <div id="pane-view-N" class="pane-view-container" hidden>
  <button class="terminal-pane-upload">
  <button class="terminal-pane-schedule"><span class="pane-schedule-count"></button>
  <div class="terminal-mobile-input-row">
    <input class="mobile-type-input"><button class="mobile-send-btn">
  </div>
  <div class="terminal-mobile-toolbar"><button class="toolbar-keyboard"></div>
</section>
```

| Pinned artifact | Class | Risk | Action |
|---|---|---|---|
| Every id and class above | FUNCTIONAL | CRITICAL | Keep green. `app.js` resolves these by `getElementById` and `querySelector`; the fake DOM only answers those exact strings. |
| `_resetTerminalPaneHost` clears these state classes: `terminal-pane-active`, `terminal-pane-dragging`, `terminal-pane-loading`, `terminal-pane-done`, restores `terminal-pane-empty`, clears `attention-state` on the header, clears `terminal-pane-expand-stage1`/`stage2`, clears `mic-active`, clears `active` on `.terminal-mobile-input-row`, clears `toolbar-active` on `.toolbar-keyboard` | FUNCTIONAL | CRITICAL | Keep green. These class names are the pane state machine. |
| `mobile-active` class on the pane element | FUNCTIONAL | HIGH | Keep green |

**Rule for the restyle: pane state classes may gain new visual rules but may not be renamed
or replaced by data attributes.**

---

# 10. `test/copy-secure-context-fallback.test.js` (23 assertions)

Reads `terminal.js`, `app.js`, `index.html`. All FUNCTIONAL. This is a security and
correctness gate; the restyle should touch nothing here except the two cachebuster literals.

Anchors: `if (mod && shortcutKey === 'c'` ... `return false;`; `static copyTextToClipboard`;
`static _copyViaExecCommand`; `_copyWithToast(text, successMessage, failureMessage)` with the
end boundary `\n  showToast(` (so `showToast` must remain the method immediately after);
`label: 'Copy', icon: '&#128203;'` in the terminal context menu (**exact literal including the
HTML entity for the clipboard emoji**); the boundary comment `// Save to Notes`;
`if (key === 'copy') {` with the boundary comment `// Full-screen reader overlay`.

| Notable pin | Risk | Action |
|---|---|---|
| `label: 'Copy', icon: '&#128203;'` | HIGH | A Notion restyle that swaps emoji icons for an icon system WILL break this. Update the anchor in the test in the same commit. |
| The comment `// Save to Notes` and `// Full-screen reader overlay` | HIGH | These are load-bearing comments. Do not tidy them away. |
| `app.js` contains ZERO `navigator.clipboard.writeText(` call sites | FUNCTIONAL | CRITICAL. Never add one. |
| `terminal.js?v=20260806-selectv3` and `app.js?v=20260805-mobile-select1` in `index.html` | CRITICAL | See top-10 item 1 |

---

# 11. `test/paste-secure-context-fallback.test.js` (9) and `test/bracketed-paste-isolation.test.js` (7)

Reads `terminal.js` and `app.js`. All FUNCTIONAL, LOW restyle risk. No CSS, no HTML, no class
names. Pins the Ctrl+V branch, the `xtermTextarea.addEventListener('beforeinput'` and
`('paste'` capture listeners (exactly two `xtermTextarea.addEventListener` calls), the
bracketed-paste escape pair `\x1b[200~` / `\x1b[201~`, `.xterm-helper-textarea` resolved via
`container.querySelector`, and the context-menu Paste fallback toast mentioning `Ctrl+V`.

**Action: keep green untouched. The only restyle interaction is the `Ctrl+V` string inside a
toast message, which is user-facing copy that should not change.**

---

# 12. Remaining frontend gates

## `test/instance-colors.test.js` (13, FUNCTIONAL, LOW risk)

Requires `instance-colors.js` to export `TAB_COLORS` with exactly 6 distinct entries whose
values are the strings `red`, `yellow`, `green`, `teal`, `blue` at indexes 0 to 4, plus
`getSessionInstances` and `getTabColor` with modulo-6 wraparound. These are palette token
NAMES used as `--tab-color` values. **A Notion palette must keep tokens by these names or the
6-colour tab wheel must be re-specified in this test.**

## `test/data-provider-attr.test.js` (11, FUNCTIONAL, HIGH risk)

Pins template shapes in `app.js`:
- `<div class="ws-session-item${...} ... data-provider="${...}" ...>`
- `<div class="project-session-item" ... data-provider="${...}" ...>`
- `<div class="project-accordion${...} ... data-provider="${...}" ...>`
- `s.provider || 'claude'`, `p.provider || 'claude'`, `.provider) || 'claude'`
- `paneEl.dataset.provider =` and `paneEl.removeAttribute('data-provider')`
- at least 3 occurrences of `data-provider="${`
- anchors `  _handleTerminalPaneFatal(`, `\n  openTerminalInPane(`, `  _resetTerminalPaneHost(`, `\n  _syncTerminalPaneHost(`

**Note the class names must remain the FIRST thing in the class attribute** and the opening
`<div class="X"` form is regex-pinned. Adding Notion utility classes is safe only if appended
after the existing class token inside the same `class="..."`.

## `test/idle-notification-gating.test.js` (19, FUNCTIONAL, MEDIUM risk)

Pins `terminal.js` constants and `app.js` literals: `static SESSION_NOTIFY_DEDUPE_MS = 60000`,
`static CHIME_COOLDOWN_MS = 5000`, `this._sessionNotifyState = new Map()`, `this._lastChimeAt = 0`,
`this._audioCtx = null`, `const paneVisibleAndSeen = activeIdx !== -1 && document.hasFocus();`,
`tp._idleNotified = true;`, `tp._lastIdleFiredAt = Date.now();`,
`this._attentionState.get(tp.sessionId) === 'complete'`, and the negatives
`tp._needsInput = false` and `dataset.needsInput = 'false'` must NOT appear inside
`setActiveTerminalPane`. Anchors: `  setActiveTerminalPane(slotIdx) {` and
`  openTerminalReader(pane) {` (so `openTerminalReader` must remain the next method).
Also: `getElementById(\`terminal-pane-${i}\`)` must NEVER reappear (the correct id is `term-pane-N`).

## `test/experience-model.test.js` (14, FUNCTIONAL, MEDIUM risk)

`experience-model.js` must export a frozen API with exactly two density choices (Quiet,
Informative), exactly five attention states with stable priority and actionability, and
`groupThemes` returning frozen dark/light groups in registry order. **A Notion density scale
with three levels breaks this.**

## `test/mirror-view-state.test.js` (3, FUNCTIONAL, LOW risk)

`mirror-view.js` scroll-position descriptor. No visual surface.

## `test/smooth-scroll.test.js` (20, FUNCTIONAL, LOW-MEDIUM risk)

Pins `smoothScrolling: true,` in the app.js settings defaults block and a registry entry with
`key: 'smoothScrolling'` ... `category: 'Terminal'`. **Settings category names are pinned.**
Also asserts a live `prefers-reduced-motion` change listener exists.

## `test/provider-tabs.test.js` (24, FUNCTIONAL, CRITICAL risk)

Executes `renderProviderTabs` against a fake DOM and asserts the produced HTML matches:
- `class="sidebar-tab"` or `class="sidebar-tab active"` (regex `class="sidebar-tab(?:\s+active)?"`)
- `class="sidebar-tab active"[^>]*data-provider="codex"`
- `class="sidebar-tab"\s+role="tab"\s+data-provider="all"` (**attribute ORDER pinned: class, role, data-provider**)
- exactly 2 tab buttons for 1 provider, All first, registration order after
- `#sidebar-provider-tabs` mount, `cwm_activeProviderTab` localStorage key
- badge patching in place without a full re-render

**This is the strictest markup pin in the suite. Any restyle of the sidebar tab strip that
adds a class, reorders attributes, or wraps the button will break 3 to 5 assertions.**

## `test/settings-providers.test.js` (15, FUNCTIONAL, HIGH risk)

Executes `_renderProvidersSection` and asserts the literal opening tag
`<div class="settings-providers-tile" data-provider="` (exact class, exact attribute order),
the class `settings-providers-install-hint`, and exact status strings
`Enabled &middot; CLI on PATH`, `Disabled &middot; CLI on PATH`, `CLI not found in PATH`,
`Enabled but CLI not found in PATH`. Also `_installHintFor` returning `@anthropic-ai/claude-code`
and `@openai/codex`.

## `test/cost-display.test.js` (13, FUNCTIONAL, HIGH risk)

Pins in `app.js`: `session-badge-cost">$${Number(cachedCost).toFixed(2)}` and
`session-badge-cost-na" title="Cost not tracked for this provider">&ndash;<` (exact class,
exact title text, exact `&ndash;` entity, exact single-space attribute separation), the marker
comment `Phase 18-04 (COST-02)`, `_getProviderById(id) {`, `_sessionProviderLacksCost`,
`${claudeOnlySuffix}` in two card labels, the literal `" (Claude only)"`, and
`Codex cost tracking not yet supported`.

## `test/search-render.test.js` (8, HYBRID, HIGH risk)

`app.js`: the exact opening tag
`<div class="search-result" data-session-id="${sessionId}" data-project-path="${...}" data-provider="${providerAttr}"`
with **exact attribute order and single-space separation**; `<span class="search-result-provider">${providerLabel}</span>`;
`providerLabel = this.escapeHtml(providerId.toUpperCase())`; `providerId = r.provider || 'claude'`;
`providerAttr = this.escapeHtml(providerId)`; source ordering
`search-result-header"` < `search-result-provider"` < `search-result-project"`.
`styles.css`: `.search-result-provider {` rule exists; and per-provider rules
`.search-result[data-provider="claude"] ... search-result-provider { ... var(--provider-claude-accent)`
and the codex equivalent, each within a 120-character window.

## `test/settings-nav-rail.test.js` (11, VISUAL/FUNCTIONAL mix, HIGH risk)

`index.html`: `class="settings-content"` and `id="settings-nav"`.
`styles.css`: `.settings-content` block containing `grid-template-columns` within 300 chars;
`.settings-nav-item` and `.settings-nav-item.is-active` selectors; `.settings-nav-item.is-active`
block referencing `--mauve` within 400 chars.
`app.js`: `_settingsCategorySlug(`, `_buildSettingsNav(`, `_updateSettingsActiveNavItem(`,
`id="settings-cat-` template, `settings-cat-providers`, and
`scrollTo({ ... behavior: 'smooth' ...})`.

**`--mauve` in the active rail item is the most likely single-token casualty of a Notion
palette swap. Plan the edit.**

## `test/provider-label-pill.test.js` (8, VISUAL, HIGH risk)

`styles.css` must contain `.pane-provider-pill`;
`.pane-provider-pill[data-provider="claude"]::before` referencing `--provider-claude-accent`
and the codex equivalent;
`.terminal-pane[data-provider="claude"] ... border-top: 4px solid var(--provider-claude-accent)`
and the codex equivalent (**exactly 4px**);
`color-mix(in srgb, var(--mauve) 8%, var(--bg-primary))` and
`color-mix(in srgb, var(--green) 8%, var(--bg-primary))` (**exactly 8 percent**);
`.ws-session-item[data-provider="claude"]` referencing `--provider-claude-accent` and the
codex equivalent.
`index.html` must contain the string `pane-provider-pill`.
`app.js` must contain `pillEl.textContent` and `pillEl.hidden =`.

**Note the internal tension: `css-tokens.test.js` allows the tint percentage to drift; this
file pins it at exactly 8 percent for the whole-pane tint. Change both or neither.**

## `test/workspace-group-ux.test.js` (9, VISUAL/FUNCTIONAL, MEDIUM risk)

`styles.css`: `.workspace-item[data-group-id]` block referencing `--ws-group-color` within
200 chars; `.ws-group-chip`; `.ws-group-chip-remove`; `.ws-group-chip:hover .ws-group-chip-remove`
with `opacity: 1` within 80 chars.
`app.js`: `Object.values(this.state.workspaceGroups`, `data-group-id="${`, `--ws-group-color`,
`ws-group-chip`, `data-action="remove-from-group"`, and the remove interceptor must appear in
source order BEFORE `e.target.closest('.workspace-item')`.

## `test/codex-status-strip.test.js` (11, VISUAL/FUNCTIONAL, MEDIUM risk)

`styles.css`: `.codex-pane-status`, `.codex-status-chip`, `.codex-status-chip-bypass`, and the
bypass chip referencing `var(--red)` within 400 chars.
`app.js`: `_renderCodexStatusStrip(`, `_onCodexStatusChipClick(`, `_renderCodexStatusStrip(slotIdx)`,
chip factory calls `chip('model'`, `chip('sandbox'`, `chip('approval'`, `chip('effort'`,
`chip('features'`, plus `data-chip="bypass"` and `bypassApprovalsAndSandbox === true`.

## `test/usage-meter.test.js` (20, VISUAL/FUNCTIONAL, HIGH risk)

`index.html`: `id="usage-meter"` (hidden by default), `id="usage-meter-bars"`,
`id="account-panel-meter"` positioned between `id="account-panel"` and `id="account-panel-list"`.
`styles.css` **exact-string** assertions:
- `.usage-meter-fill.u-low { background: var(--green); }`
- `.usage-meter-fill.u-mid { background: var(--yellow); }`
- `.usage-meter-fill.u-high { background: var(--red); }`
- `.account-panel-meter {\s*display: none;\s*}`
- `.usage-meter-fill { transition: none; }` inside a reduced-motion block
- ZERO hardcoded hex between `.usage-meter {` and `.account-panel-meter {`
`styles-mobile.css`: `.account-panel-meter:not([hidden])` inside a `max-width: 768px` media query.

**These are whitespace-exact single-line rule bodies. A CSS formatter run over `styles.css`
will break four of them.**

## `test/provider-account-tabs.test.js` (16, VISUAL/FUNCTIONAL, HIGH risk)

`index.html`: `id="account-tabs"`, `role="tablist"`, `data-kind="legacy"`, `data-kind="provider"`,
`data-provider-tab="claude"`, `data-provider-tab="codex"`, `id="account-tab-claude"`,
`id="account-tab-codex"`, `id="account-panel-title"`, Claude tab starts active.
`styles.css`: `.account-tabs {` rule; `.account-tab.is-active[data-provider-tab="claude"]` and
codex equivalent; `--provider-claude-accent`/`--provider-codex-accent` present; ZERO hardcoded
hex between `.account-tabs {` and `.account-empty-hint`.

## `test/credential-delete-ui.test.js` (12) and `test/credential-expiry-ui.test.js` (16)

`styles.css` rule bodies sliced from the selector to the **first `}`**:
- `.account-row-edit.account-delete-btn:hover` must contain `var(--red)` and no hex
- `.account-retry-btn {` must contain `var(--` and no hex
- `.account-warn-note {` must contain `var(--yellow)` and no hex

Plus `.account-delete-btn` markup with an inline SVG icon and no emoji, and copy strings for
dead/suspect rows. Class: HYBRID. Risk: MEDIUM. Action: keep green; these rules must stay
brace-free single blocks.

## `test/pane-context-menu.test.js` (9), `test/adhoc-pane-menu.test.js` (8), `test/project-session-resume-provider.test.js` (11), `test/dragdrop-provider.test.js` (14), `test/layout-provider-persist.test.js` (7)

All read `app.js` only, all FUNCTIONAL, all LOW-to-MEDIUM restyle risk. They pin method names
(`_buildCodexPaneMenu`, `_buildAdHocSessionContextItems`, `_buildSessionContextItems`,
`showProjectSessionContextMenu`, `saveCurrentGroupPanes`, `loadTerminalLayout`), context-menu
label regexes, `data-provider` propagation through drag payloads, `getProviderCliBinary(...)`
usage, and `dataset.provider` reads. The only restyle interaction is that context-menu **item
label strings** are pinned; do not reword menu items.

## `test/grep-gate.test.js` (source gate over all of `src/`)

Any quoted literal `'claude'` or `'codex'` outside `src/providers/` fails unless the line
carries the marker `gsd:provider-literal-allowed`. **Applies to `app.js` and `terminal.js`.**
Adding a new provider-named CSS class in JS (for example `'notion-claude-chip'`) is fine, but
a bare `'claude'` string is not. Note CSS files are not scanned, so selectors like
`[data-provider="claude"]` in `styles.css` are unaffected.

---

# Top 10 CI breakages the Notion restyle is most likely to cause

### 1. Bumping asset cachebusters without updating the pinned literals
The restyle MUST change `?v=` tokens so browsers refetch CSS, but four literals are asserted:
`?v=20260725-5` on `semantic-theme.css`, `focused-shell.css`, `theme-registry.js`,
`experience-model.js` (`test/experience-ux-contract.test.js:135`); `terminal.js?v=20260806-selectv3`
(`test/terminal-select-mode.test.js:169`, `test/copy-secure-context-fallback.test.js:381`);
`app.js?v=20260805-mobile-select1` (`test/terminal-select-mode.test.js:177`,
`test/copy-secure-context-fallback.test.js:382`).
**Avoid:** treat the cachebuster bump as a five-file atomic change (index.html plus three test
files). Grep `test/ -e '?v='` before pushing. Note `styles.css` and `styles-mobile.css` carry
NO cachebuster today; adding one to them is free.

### 2. Running a CSS formatter or minifier over `styles.css`
Roughly 20 assertions slice rule bodies with `indexOf(selector + ' {')` and cut at the first
`}`, or match single-line rules verbatim (`.usage-meter-fill.u-low { background: var(--green); }`).
Reformatting, re-indenting, or collapsing rules silently breaks `mobile-ux-fixes`,
`usage-meter`, `credential-delete-ui`, `credential-expiry-ui`, and `search-render`.
**Avoid:** no repo-wide Prettier/Stylelint pass on `src/web/public/*.css` during the restyle.
Edit rules in place, preserve the `selector {` spacing, and never introduce nested braces into
a pinned rule.

### 3. Merging a pinned selector into a grouped selector list
`ruleBody()` in `test/mobile-ux-fixes.test.js` and `balancedBlock()` in `focused-shell.test.js`
both need the selector as the exact text immediately before `{`. A refactor to
`.terminal-group-tab, .sidebar-tab { ... }` returns an empty body and fails.
**Avoid:** put shared Notion properties in a new grouped rule and keep the pinned single
selector as its own rule underneath, even if it only carries one declaration.

### 4. Renaming or removing Catppuccin palette variables
`theme-registry.test.js` executes `TerminalPane.getCurrentTheme()` and requires
`--base --surface1 --surface2 --text --subtext0 --subtext1 --mauve --blue --green --yellow
--red --teal --rosewater` to resolve. `css-tokens.test.js` requires provider accents to be
`var(--mauve)`, `var(--green)`, `var(--blue)`. `settings-nav-rail` needs `--mauve`.
`instance-colors` needs the names `red yellow green teal blue`. `usage-meter` needs
`var(--green)/(--yellow)/(--red)`.
**Avoid:** introduce Notion colours as a NEW layer (`--notion-*`) and redefine the existing
Catppuccin variable names as aliases of them. Do not delete a single legacy token name.

### 5. Rewriting the sidebar tab strip or the provider tiles markup
`provider-tabs.test.js` pins `class="sidebar-tab"\s+role="tab"\s+data-provider="all"`, so the
attribute ORDER is fixed. `settings-providers.test.js` pins
`<div class="settings-providers-tile" data-provider="`. `search-render.test.js` pins
`<div class="search-result" data-session-id="..." data-project-path="..." data-provider="...`.
**Avoid:** when adding Notion classes, append them inside the existing `class="..."` value
(`class="sidebar-tab notion-chip"` fails the `class="sidebar-tab"` regex, so prefer a wrapping
data attribute or a CSS-only restyle of the existing class). Never reorder attributes on these
three templates.

### 6. Replacing emoji and entity icons with an icon system
`copy-secure-context-fallback.test.js` anchors on `label: 'Copy', icon: '&#128203;'`.
`cost-display.test.js` requires `&ndash;` and `&middot;` in
`settings-providers.test.js` status strings. `credential-delete-ui.test.js` requires the delete
button to use an inline SVG and NOT an emoji. `mobile-ux-fixes.test.js` requires
`showMoreMenu()` to contain no `icon:` key at all.
**Avoid:** keep the `icon:` property on the terminal Copy item exactly as it is (or update the
anchor in the test in the same commit), keep `showMoreMenu` icon-free, and keep the HTML
entities in status/badge strings.

### 7. Redesigning the pane header or pane state classes
`terminal-host-ownership.test.js` executes production code against a fake DOM that only knows
`term-pane-N`, `term-container-N`, `term-activity-N`, `pane-view-N`, and the eighteen pane
class names listed in section 9. `terminal-select-v2.test.js` requires the injected buttons to
carry `btn btn-ghost btn-icon btn-sm` and `terminal-pane-copyview`. `focused-shell.test.js`
requires `@media (hover: hover) and (pointer: fine)` rules naming six pane-header selectors.
**Avoid:** restyle the pane header purely through CSS on the existing class names. If a
structural change is unavoidable, update `createSlot()` in `terminal-host-ownership.test.js`
in the same commit and rerun that file first, since it executes rather than greps.

### 8. Putting Notion hex values in `semantic-theme.css` or in a hex-free CSS block
`experience-ux-contract.test.js` fails if `semantic-theme.css` contains ANY `#hex`, `rgb()`,
`rgba()`, `hsl()`, or `hsla()`. Four other blocks are hex-free zones: `.usage-meter {` through
`.account-panel-meter {`, `.account-tabs {` through `.account-empty-hint`, the
`.account-row-edit.account-delete-btn:hover` rule, and the `.account-retry-btn`/`.account-warn-note`
rules. `css-tokens.test.js` forbids hex inside any `--provider-*` token value.
**Avoid:** all raw colour values go in one `:root` block in `styles.css`. Every other file and
every one of those five blocks consumes `var()` only.

### 9. Dropping the accessibility and touch-target guarantees while simplifying chrome
Pinned: `@media (pointer: coarse)` with `min-height: 44px` naming nine selectors;
`.terminal-group-tab-close` at 44 by 44; `.terminal-tab-close::before { inset: -13px }`;
`.docs-workspace-select` at 44px on mobile; `:focus-visible` rules on `.focused-more-btn`,
`.attention-queue-btn`, `.resource-row-menu-btn`, `.terminal-group-tab-close`,
`.terminal-tab-close`; `@media (forced-colors: active)` with `outline: 2px solid Highlight`;
`@media (max-width: 768px) ... .claude-session-table ... display: block`;
`.terminal-grid[hidden] { display: none !important }`; ARIA on `#context-menu`, `#action-sheet`,
`#appearance-dialog`, `#attention-queue-btn`, and the seven `docs-section-header` buttons.
**Avoid:** treat these as the accessibility floor of the design, not as legacy styling. A
Notion look can be achieved without lowering any of them.

### 10. Changing the theme roster, density scale, or the shell/tier vocabulary
`theme-registry.test.js` pins 13 theme ids, 13 exact background hex values, and the three
featured aliases `system`/`myrlin-dark`/`myrlin-light` mapping to `mocha`/`latte`.
`experience-model.test.js` pins exactly two density choices and exactly five attention states.
`focused-shell.test.js` pins `data-ui-shell="focused"`, the three primary view modes in order,
the three secondary modes in order, the single contextual mode, and the four mobile tabs in
order. `experience-ux-contract.test.js` pins the tab labels `Agent Tasks` and `Issues`.
**Avoid:** ship Notion as a re-skin of the existing `mocha`/`latte` targets first. If a new
`notion-dark` theme id is genuinely wanted, it is a 14th entry plus a test edit plus a
persisted-preference migration, and it should be its own change after the visual refactor
lands green.

---

## Recommended CI workflow for the restyle

1. Before any edit, capture the baseline: `npm test` and save the 1142 figure.
2. Work in this order: `styles.css` `:root` token layer, then component rules, then
   `focused-shell.css`, then `styles-mobile.css`, then HTML/JS templates last.
3. After each file, run the fast targeted gates rather than the whole suite:
   `node test/phantom-tokens.test.js && node test/css-tokens.test.js && node test/mobile-ux-fixes.test.js && node test/usage-meter.test.js`
4. Before touching any `app.js` or `terminal.js` template, run the executing gates first so a
   break is attributable: `node test/terminal-host-ownership.test.js`,
   `node test/provider-tabs.test.js`, `node test/settings-providers.test.js`,
   `node test/terminal-select-v2.test.js`.
5. Every test-expectation edit must be in the same commit as the source change that caused it,
   with a one-line comment in the test saying which restyle decision moved the value. Never
   delete an assertion to make CI green.
