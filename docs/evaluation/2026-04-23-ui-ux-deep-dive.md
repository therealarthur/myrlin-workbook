# Myrlin Workbook UI/UX Deep-Dive Evaluation

> **Date:** 2026-04-23
> **Version audited:** 0.9.27
> **Scope:** Desktop GUI (`src/web/public/`) + mobile overrides (`styles-mobile.css`)
> **Files inspected:** `index.html` (1668 lines), `styles.css` (9885 lines), `styles-mobile.css` (969 lines), `app.js` (17,576 lines), `terminal.js` (1344 lines)
> **Reviewer method:** strategic full reads of DOM structure, tokens, transitions, render functions, modal patterns, context menus, keyboard bindings, and theme definitions; cross-referenced against CHANGELOG 0.8.0-0.9.27 to understand feature drift.
> **Assessment bar:** parity with the official Anthropic Claude Code desktop app (claude.ai/code) and the Linear / Raycast / Warp reference tier.

---

## 1. Executive Summary

Myrlin Workbook in 0.9.27 is feature-rich (14 top-level views, 23+ modals, 13 themes, 2300+ icons, 3 context-menu systems, worktree-task Kanban, cost dashboard with SVG charts, PTY terminal grid up to 6 panes, mobile bottom-tab navigation). Architecturally, the Catppuccin token system is sound and the base components (buttons, toasts, settings toggles, context menu) are on par with Linear or Raycast at their best. However, iterative growth across nine point-releases has produced **significant drift**, and the polish bar is uneven. Five highest-priority findings:

1. **Modal fragmentation** — the codebase ships at least **8 distinct modal containers** (`#modal-overlay`, `#settings-overlay`, `#update-overlay`, `#folder-browser-overlay`, `#diff-viewer-overlay`, `#new-task-overlay`, `#pr-dialog-overlay`, `#spinoff-overlay`, `#pair-mobile-overlay`, `#notes-editor-overlay`, `#td-issue-modal-overlay`, `#launcher-overlay`, `#find-convo-overlay`), each with its own HTML, CSS, close handler, and animation. They use three different close icons (`&times;`, an X SVG, an explicit `.modal-close-btn`), two different shells (`.modal` vs `.modal-panel` vs bespoke panels), and inconsistent footer layouts. This is the single biggest consistency gap vs Anthropic's desktop app, which ships a single `<Dialog>` primitive.
2. **Hardcoded rgba values break theme fidelity** — 234 occurrences of raw `rgba(...)` in `styles.css`. Mocha hex values (`rgba(203,166,247,.x)`, `rgba(166,227,161,.x)`, `rgba(243,139,168,.x)`) are patched for Latte/Frappe/Macchiato in ~8 per-theme override blocks, but only for `::selection`, `stat-dot-running`, and `terminal-resize-handle` (3 selectors each). Everything else (hover glows, badge tints, button shadows, glow effects, login grid, toasts, token bars) still uses Mocha purple/green/red regardless of active theme. Latte / Rose Pine Dawn / Gruvbox Light in particular look distinctly wrong in several places.
3. **Terminal pane HTML is duplicated 6× verbatim in `index.html`** (`index.html:541-816`, 274 lines of identical markup). Any change to a pane button (e.g. adding screenshot-to-clipboard, changing the mic icon) requires touching 6 copies. This is a smell Anthropic's app would never ship.
4. **Escape-key cascade is the only keyboard-navigation contract** (`app.js:1039-1064`, 8 overlay priorities). No tab order in modals, no arrow keys in sidebar, no numeric shortcuts (1–9) to switch workspaces, no `Cmd+W` to close the active pane, no `Cmd+1..5` to switch views, no `Gg` / `Shift+G` vim-style jumps in session lists. Raycast and Linear both expose 30+ shortcuts. Myrlin has 5.
5. **Empty and first-run states are purely functional.** Login has a beautiful floating logo, but every other empty state (no sessions, no projects, no tasks, no docs, no cost data) is a terse SVG + one line of text. There's no onboarding tour, no "try this" chip row, no confetti on first session, no sample data offer, nothing that says "this is where your work begins". Compare to Raycast's onboarding or Anthropic's "start a new conversation" canvas.

**Bottom line:** Myrlin is a heavyweight power-tool with Linear-class bones. To sit next to claude.ai/code on Arthur's taskbar without visible seams, it needs (in this order) a **unified `<Modal>` component**, **a theme-audit sweep** to kill hardcoded rgba, **a keyboard-map pass** to bring it to Raycast parity, **an empty/loading/error-state refresh**, and **OS-native gestures** (menu bar, global hotkey, tray icon). The rest is polish-pass grooming.

---

## 2. Polish Gap vs Anthropic Claude Code Desktop

The official Claude Code desktop app is a React/Electron shell around the same CLI. Its polish bar is high but not unreachable. Here's where Myrlin is behind and what closes the gap.

### 2.1 Unified dialog primitive

Anthropic's app uses a single radix-style `<Dialog>` component. Every confirm, every prompt, every multi-step form uses the same overlay, same escape handling, same focus trap, same animation. The content inside varies; the chrome does not.

Myrlin ships at least 13 distinct dialog/overlay containers (enumerated in Section 3). They share CSS tokens (radius, shadow, border) but their shells are hand-rolled in HTML. Three of them use `&times;` as the close character (`td-issue-modal-close`, `modal-close-btn`, `update-close-btn`), three use a 14×14 stroke SVG X (`find-convo-close`, `folder-browser-close`, `launcher-close`), and the rest differ. See `index.html:1303`, `index.html:1258`, `index.html:1281`.

**Fix:** a single `<div class="modal-overlay"><div class="modal modal-sm|modal-md|modal-lg"><header><body><footer></div></div>` template. One close button. One animation. One Esc handler. 280-line reduction in HTML.

### 2.2 Window chrome / native frame

Claude Code desktop hides the system title bar and owns the chrome (rounded corners, integrated traffic-light buttons on macOS, Windows title-bar color matching). Myrlin is a browser tab. It inherits Chrome/Edge chrome: URL bar, tab bar, browser menu.

**Fix:** ship as an Electron or Tauri shell with a trimmed chrome. Even a minimal titlebar drag region with window controls integrated into `.app-header` closes 80% of the visual gap. Windows 11 with backdrop-filter blur on the header would match Warp / Arc.

### 2.3 Command palette breadth and depth

Anthropic's command palette (`Cmd+K`) is the **primary input method**. It can launch new sessions, resume old ones, switch models, change themes, open settings, and accept natural-language queries. Myrlin has Ctrl+K but the data density is thin: sessions + workspaces + a small action catalog (`app.js:3642`, `app.js:3921`). No way to launch a new session from Ctrl+K with directory/model/prompt inline. No way to trigger "rename this workspace" without right-clicking. No arrow-key action preview pane.

**Fix:** expand the Ctrl+K catalog so every visible action in the UI has a palette entry. Add a right-side preview pane. Support natural-language prefix (`>` already does commands, add `!` for session launch, `@` for workspaces, `#` for features, `?` for help). The AI session finder (`find-convo-modal`) should be merged back into Ctrl+K rather than a separate modal.

### 2.4 Contextual menus with submenu peek

The terminal context menu (`app.js:10209-10372`) is dense (Copy, Paste, Fix Terminal, Restart, Kill, shell switcher, conflicts, close, inspect) and uses `ctx-has-submenu` for shell switching. But there's no preview, no shortcut hints on the right edge, no cascading style. Anthropic's and Raycast's context menus show `⌘C`, `⌘V`, etc. on the right edge of each item. Myrlin has `ctx-hint` CSS (`styles.css:3526-3533`) but it isn't populated anywhere.

**Fix:** pass keyboard shortcut strings to every context item and render them right-aligned. Retro-fit the `ctx-hint` slot for it.

### 2.5 Micro-motion discipline

Anthropic's app uses **one** easing curve (approx `cubic-bezier(0.32, 0.72, 0, 1)`) and **three** durations (80ms, 120ms, 200ms). Myrlin has:

- `--transition-fast: 150ms cubic-bezier(0.16, 1, 0.3, 1)`
- `--transition-normal: 200ms cubic-bezier(0.16, 1, 0.3, 1)`
- `--transition-slow: 300ms cubic-bezier(0.16, 1, 0.3, 1)`

Good token definitions. But in practice, **~40 inline transitions specify literal `150ms ease`** (`styles.css:3840, 3934, 4207, 4254, 4300, 4332, 4922, 5010, 5070, 5079, 7417, 7441, 7516, 7522, 7545, 7590` among others) bypassing the token. Spot-check: `toast-dragging` uses `transition: none`, `toast` uses `transform 0.15s ease, opacity 0.15s ease` — three different ways to say the same thing. This will be invisible at small scales but accumulates into a slightly-off feel.

**Fix:** grep for hardcoded `ms` / `cubic-bezier` in `styles.css` and replace with `var(--transition-fast|normal|slow)`. 40-line change but meaningful.

### 2.6 Typography rhythm

Anthropic's app uses a 4px baseline grid religiously. Font sizes: 11/12/13/14/16/18/20. Line heights: 1.4 (body), 1.5 (prose), 1.2 (code).

Myrlin uses `11/12/13/14/15/16/17` (panel title 15, modal title 16, header title 17) and line-height defaults to `1.5` globally (`styles.css:89`) but terminal-specific code uses `1.2` and kanban card uses `1.3`. Reasonable but not rigorous. The 15/16/17 progression in headers is unusual — typically you want 14/16/20 with semantic roles.

**Fix:** bump the docs panel title to match modal title (both should be the same semantic level). Consolidate to 11/12/13/14/16/20 scale.

### 2.7 Loading state discipline

The login page uses `.btn-loader` (`styles.css:239-255`, `:239`) — a spinner. The AI insights section uses `.ai-insight-skeleton` with proper skeleton bars (`styles.css:5724-5747`). The spinoff modal uses 3 pulsing dots (`styles.css:467-469`). The cost dashboard shows a "Loading cost data..." text string (`index.html:1082`). Resources panel shows "Loading resource data..." (`index.html:1099`). Docs shows nothing on initial load.

Five different loading idioms. This is by far the most visible drift.

**Fix:** standardize on skeletons everywhere (already built for AI insights). Spinners only appear on buttons. Text like "Loading..." is replaced with skeleton rows matching the final layout.

### 2.8 Notification / status integration

Anthropic's desktop app uses macOS/Windows native notifications for completion events. Myrlin dispatches a `terminal-idle` CustomEvent from `terminal.js:1219` that the app layer listens to (`app.js:1071-1073`, `onTerminalIdle` handler). This currently only shows an in-app toast. Native OS notifications (via `Notification` API or Electron/Tauri shell) are not wired, despite the `notifications.js` backend module existing.

**Fix:** add `Notification.requestPermission()` on first login, then dispatch `new Notification('Claude finished in "X"', { body: ..., icon: '/favicon-192.png' })` from `onTerminalIdle`. Zero infrastructure cost. Immediately bridges the "did it finish" gap.

### 2.9 First-person welcome

Claude Code desktop's new-conversation canvas says "What can I help with today?" — it's personal, focused. Myrlin's empty-session state (`index.html:389-396`) is: icon + "No sessions yet" + "Create a session to get started". Cold.

**Fix:** a single warm line keyed to time of day and project name. "Morning, Arthur. Ready to ship myrlin-workbook today?" works because Myrlin already knows the user's name (from login) and the active workspace. Keep it out of the way; just make it feel alive.

---

## 3. Consolidation Candidates

These are components that have drifted into near-duplicates. Merging them produces code reduction and consistency simultaneously.

### 3.1 Modal/overlay container (P0)

**The problem.** 13+ distinct modal definitions:

| Modal | ID | File:Line |
|---|---|---|
| Generic confirm/prompt | `#modal-overlay` | index.html:1253 |
| Settings | `#settings-overlay` | index.html:1577 |
| Update app | `#update-overlay` | index.html:1299 |
| Folder browser | `#folder-browser-overlay` | index.html:1276 |
| Diff viewer | `#diff-viewer-overlay` | index.html:1527 |
| New task | `#new-task-overlay` | index.html:1317 |
| PR creation | `#pr-dialog-overlay` | index.html:1391 |
| Task spinoff | `#spinoff-overlay` | index.html:1436 |
| Session launcher | `#launcher-overlay` | index.html:1476 |
| TD issue detail | `#td-issue-modal-overlay` | index.html:1552 |
| Pair mobile | `#pair-mobile-overlay` | index.html:1629 |
| Notes editor | `#notes-editor-overlay` | index.html:1109 |
| Find conversation | `#find-convo-overlay` | index.html:1228 |
| Quick switcher | `#quick-switcher-overlay` | index.html:1186 |

**Each brings its own:**
- HTML shell (header / body / footer markup varies)
- Close button (`&times;` vs explicit SVG vs `modal-close-btn` class)
- CSS selectors (.modal vs .modal-panel vs .modal-dialog vs .settings-panel vs bespoke)
- Show/hide plumbing (different flags: `_modalOpen` vs `_smOpen` vs direct `.hidden`)
- Esc handler (all funnel through `app.js:1039` cascade but in different orders of priority)
- Max-width (440, 520, 560, 640, 680 — 5 different values)
- Padding (modal-body has `padding:20px 24px` while new-task has `padding:16px` inline)

**Proposed single template.**

```
.modal-overlay (z:10002, backdrop-filter, flex center, padding-top:15vh)
  .modal .modal-{sm|md|lg|xl} (base 440/560/680/880, flex-column)
    .modal-header (flex, 16-20px padding, border-bottom optional)
      .modal-title
      .modal-header-actions (btn row including close)
    .modal-body (overflow-y:auto, flex:1)
    .modal-footer (flex-end, 8px gap, 16-20px padding, border-top optional)
```

**Before/after sketch:**

```
BEFORE: 13 modal shells, ~800 lines of HTML, 3 close icons, 5 widths

AFTER: 1 modal shell + content templates
┌─────────────────────┐
│ [Title]          [×]│  ← .modal-header
├─────────────────────┤
│ Body (scrollable)   │  ← .modal-body
│                     │
│                     │
├─────────────────────┤
│         [Cancel][OK]│  ← .modal-footer
└─────────────────────┘

13 → 1 shell; body contents stay but live in <template> blocks
or dynamic innerHTML
```

**Estimated saving:** 400 lines of HTML, 200 lines of CSS, 3 close-icon SVGs deleted, 1 consistent escape/focus-trap flow, elimination of the `_modalOpen` / `_smOpen` / per-modal `hidden` inconsistency.

### 3.2 Context menu systems (P1)

There are **three context-menu implementations**:

1. Desktop context menu (`#context-menu` + `context-menu-item` classes, `styles.css:3373`)
2. Mobile action sheet (`#action-sheet-overlay` + `action-sheet-item`, `styles-mobile.css:255`)
3. "Choice modal" (`showChoiceModal`, `app.js:8090`) — modal with multiple action buttons

The first two are symmetric: same items, different presentation. `app.js` already builds items as a JS array then dispatches to either `_renderContextItems` (desktop) or `showActionSheet` (mobile). This is correct.

The third is a **degenerate modal** that overlays custom buttons on the generic modal footer. It could be a context menu in a `position: fixed` container centered on the viewport. It's used for: "multiple actions on a destructive operation" — exactly what a radio-style action sheet is for.

**Fix:** delete `showChoiceModal`. Use `showActionSheet` for mobile and a desktop-styled action sheet for desktop (dropdown-style, positioned center). Or just fold into `showConfirmModal` with an array of button options.

### 3.3 Session-like items (P1)

There are **four different session-row components**:

| Component | Class | File:Line |
|---|---|---|
| Session list main | `.session-item` | styles.css:1407 |
| Workspace sidebar session | `.ws-session-item` | styles.css:1288 |
| Project sidebar session | `.project-session-item` | styles-mobile.css:891 (also defined in main CSS) |
| Session manager overlay item | `.session-manager-list` rows | render logic in `renderSessionManager` |
| Recent view item | same as `.session-item` | shared |
| Costs sessions table row | `.costs-session-row` | app.js:14000 |
| Conflict center session chip | `.conflict-session-chip` | app.js:16229 |

They show the same fundamental data (status dot, name, badges, time) with slightly different emphasis. They have independent CSS, independent render code, and slightly different hover/active states. A `<SessionRow variant="compact|detailed|table|chip">` primitive would consolidate this.

### 3.4 Workspace CRUD vs Group CRUD vs Feature CRUD (P2)

- `renderWorkspaces` (`app.js:8527`) renders the workspace sidebar list with icons and colors
- Workspace groups have their own rendering (`renderWorkspaces` also handles accordions)
- Features (`renderFeatureBoard`, `app.js:16297`) are a separate entity, separate CSS (`.board-card`), separate CRUD
- Kanban worktree-tasks (`renderTasksView`, `app.js:5602`) are another separate entity, another separate CSS (`.kanban-card`, `styles.css:6128`)

Two "kanban with cards" implementations ship side by side: Feature board (`#feature-board`, columns planned/active/review/done) and Worktree-task kanban (`#kanban-board`, columns backlog/planning/running/review/completed). They render essentially the same card shape with different status names.

**Proposed:** one `<Kanban columns={[...]} cards={[...]} onMove={...}>` primitive parameterized by the column definitions and card fields. Expected saving: ~150 lines of JS + 80 lines of CSS.

### 3.5 Docs item renderers (P2)

`renderDocs` (`app.js:11781`) contains five nearly-identical loops for notes/goals/tasks/rules/roadmap sections. Each is:

```js
list.innerHTML = (docs.notes || []).length > 0
  ? (docs.notes || []).map((n, i) => `
    <div class="docs-item" data-index="${i}">
      ...slightly different inner markup per section...
      <button class="docs-item-delete ...">×</button>
    </div>`).join('')
  : '<div class="docs-empty">No notes yet...</div>';
```

A single `renderDocsSection(section, items, renderItem)` helper removes ~80 lines.

### 3.6 Form field rendering in modals (P2)

`showPromptModal` (`app.js:7851`) dispatches on `f.type`: `hidden`, `color`, `icon`, `checkbox`, `select`, `textarea`, `text`. Good. But the **new-task** modal (`index.html:1317`), **PR dialog** (`index.html:1391`), and **settings** panel (`renderSettingsBody`, `app.js:4103`) all re-implement form fields with bespoke HTML/inline styles. Migrating them to use `showPromptModal` or a shared `<FormRow>` would take 4 different styles of form down to 1.

### 3.7 Refresh buttons (P2)

At least 5 refresh buttons with the same circular-arrow SVG, slightly different sizes:

- `#workspaces-refresh` (14×14)
- `#projects-refresh` (14×14)
- `#costs-refresh-btn` (14×14)
- `#resources-refresh-btn` (14×14)
- `#detail-restart-btn` (14×14, restart not refresh)

Each rewrites the SVG path inline. One `<button class="btn btn-ghost btn-icon" data-icon="refresh">` + a single `<symbol>` definition in an SVG sprite cuts ~40 lines.

### 3.8 Tab strips (P2)

At least 4 tab-strip patterns:

- `.view-tabs` / `.view-tab` in header (`index.html:102`, `styles.css:809`)
- `.docs-tabs` / `.docs-tab` in docs panel (`index.html:836`, `styles.css:4710`)
- `.tasks-tab-strip` / `.tasks-tab` (`index.html:975`, tab-panel pattern)
- `.pair-modal-tabs` / `.pair-tab` (`index.html:1633`)
- `.sidebar-view-toggle` / `.sidebar-view-btn` (`index.html:285`)
- Mobile: `.terminal-tab-strip` / `.terminal-tab` (`styles-mobile.css:403`)

Six tab-strip implementations. All do the same thing: horizontal row of buttons with one active. Share CSS via `.tab-strip` + `.tab-strip-item` + data-active.

---

## 4. P0 Issues (broken/embarrassing)

### 4.1 Hardcoded Mocha rgba in light themes

**File:line:** `styles.css:5089` among ~230 others.
**Observation:** The "Drop a session here" empty pane uses `background: rgba(203, 166, 247, 0.05)` when dragged over. In Latte, that's a Mocha-purple tint on a cream background — it looks dirty. The per-theme override at `:7819` corrects this but only for `.terminal-pane-empty.drag-over .terminal-container`. The same rgba appears in many other places (login grid, toast highlights, kanban hover, etc.) without per-theme fixes.
**Fix sketch:** introduce `--accent-bg-subtle: color-mix(in srgb, var(--mauve) 5%, transparent)` and use it everywhere. Or mass-replace `rgba(203,166,247,X)` with `color-mix(in srgb, var(--mauve) Y%, transparent)`. Already partly done (see `styles.css:6122` kanban drop zone).

### 4.2 Toast auto-dismiss is 60 seconds

**File:line:** `app.js:8366` — `setTimeout(() => this.dismissToast(toast), 60000)`.
**Observation:** Toasts live on screen for a full minute. Linear auto-dismisses info/success in 3-4s, warning in 6s, error stays until dismissed. A session-started toast squatting on the screen for a minute is distracting and unprofessional, especially when SSE fires 3-4 per session launch (`session:created` + `session:started` + `stats:updated`).
**Fix sketch:** level-specific timeouts. `info: 3500`, `success: 3500`, `warning: 6000`, `error: null` (manual dismiss). Pause on hover.

### 4.3 Terminal pane HTML repeated 6× in DOM

**File:line:** `index.html:541-816` — one `<div class="terminal-pane">` template duplicated across 6 slots.
**Observation:** 274 lines of identical markup. Adding a button requires editing 6 places. This is structural debt: Myrlin almost certainly has a past bug where slot 3 missed an update and slot 0/1/2 didn't.
**Fix sketch:** one `<template id="terminal-pane-template">` in HTML, clone-and-append at runtime. App.js already has the slot-index plumbing, so this is purely a HTML → template rewrite. ~240 lines removed from `index.html`.

### 4.4 No focus trap in modals

**Files searched:** grep for `focus()` in modals shows no `tabindex` management, no first/last element tabs, no `role="dialog" aria-modal="true"` on every modal (some have it, most don't).
**Observation:** tabbing in any modal eventually escapes to the main app below, which is still keyboard-active. This is a known a11y failure pattern. Raycast has airtight focus trap with Tab and Shift+Tab cycling inside modal.
**Fix sketch:** a shared `trapFocus(modalEl)` helper that intercepts Tab at the modal root and cycles between `querySelectorAll('button, input, textarea, select, [tabindex="0"]')`. Hook into `showPromptModal` and `showConfirmModal`.

### 4.5 Login logo is 420px wide on a 400px card

**File:line:** `styles.css:637-644` — `.login-logo-img { width: 420px; ... }` inside `.login-card { max-width: 400px; }` (`:616`).
**Observation:** The logo image is explicitly wider than the card. The `object-fit: contain` constraint saves it but it's a brittle render. On narrow viewports, the image overflows with `max-width: calc(100% - 32px)` on the card (`styles.css:2897`) triggering an off-canvas crop.
**Fix sketch:** constrain the image `max-width: 100%` and use a proper 200-240px width for a compact login. The current bloom effect can stay.

### 4.6 Settings toggle thumb "white" in Latte

**File:line:** `styles.css:2108-2117` — `.settings-toggle-thumb { background: var(--text); }`. In Mocha that's `#cdd6f4` (light gray-white, looks fine). In Latte (`:7714`) `--text: #4c4f69` which is dark slate. So the thumb is dark purple-gray on a dark-purple-active track, which reads as "always on" visually.
**Observation:** in-bad-state only distinguishable by thumb position (left vs right). The thumb should contrast against the track, not match it.
**Fix sketch:** `background: var(--bg-primary)` (always contrasts with track because track is surface1 or mauve).

### 4.7 "60-second auto-dismiss" toast stacking

Follow-up to 4.2: if 4 toasts arrive in quick succession (which they do on workspace creation), all 4 stack for up to a minute. The toast container uses `flex-direction: column-reverse` (`styles.css:2589`) which correctly shows newest at bottom, but the lingering old toasts become clutter.
**Fix:** max 3 toasts visible at once. Older toasts auto-dismiss when a 4th arrives. Or collapse same-level toasts into a single toast with a count badge.

### 4.8 Title bar says "myrlin's workbook" but header says "Myrlin's Workbook"

**File:line:** `index.html:8` title vs `index.html:97` header.
**Observation:** two capitalizations of the same phrase. `TODO.md:66` notes the "rebrand to drop apostrophe-s" is still pending. Pick one.
**Fix sketch:** confirm with user, then mass-rename to either `Myrlin Workbook` or `myrlin workbook` (lowercase is distinctly Linear/Warp).

### 4.9 No `role="dialog"` on many modals

- `#launcher-overlay` inner: has `role="dialog" aria-modal="true"` ✓
- `#modal-overlay` inner: has `role="dialog" aria-modal="true"` ✓
- `#settings-overlay` inner `.settings-panel`: **no role**
- `#update-overlay` inner `.modal`: **no role**
- `#folder-browser-overlay` inner `.folder-browser`: has `role="dialog"` ✓
- `#notes-editor-overlay` inner `.notes-editor-modal`: has `role="dialog"` ✓
- `#diff-viewer-overlay` inner `.diff-viewer`: has `role="dialog"` ✓
- `#pr-dialog-overlay` inner `.modal-dialog`: has `role="dialog"` ✓
- `#spinoff-overlay` inner `.modal-panel`: **no role**
- `#new-task-overlay` inner `.modal-panel`: **no role**
- `#td-issue-modal-overlay` inner `.td-issue-modal`: has `role="dialog"` ✓

**Fix:** add `role="dialog" aria-modal="true" aria-labelledby="..."` to every modal inner. 5 minutes of work.

### 4.10 `host` check missing in SSE reconnect can leave EventSource dangling

**File:line:** `app.js:8402-8412` — error handler retries SSE after 5s. If the user logs out, the pending retry fires a fresh connect attempt with a now-invalid token.
**Observation:** not strictly a UX issue but shows up as `console.warn('[SSE] Connection rejected (auth expired?).')`  appearing repeatedly for signed-out users watching DevTools.
**Fix:** clear `sseRetryTimeout` in logout flow.

---

## 5. P1 Issues (high-polish wins)

### 5.1 Hover-only workspace actions invisible on trackpad-first use

**File:line:** `styles.css:1227-1236` — `.workspace-actions { opacity: 0; }` with `:hover` showing them. Mobile override forces them visible (`styles-mobile.css:54`). Good.
**Observation:** on trackpad / pen / touch-screen Windows where hover is ambiguous, users don't discover these actions. Raycast solves this by showing them on focus + with a keyboard shortcut.
**Fix:** also show on `:focus-within` and on keyboard arrow selection. Add a subtle always-visible `⋯` menu button on the right.

### 5.2 Activity indicators are very quiet

**File:line:** `app.js:10175-10207` renders activity into `.terminal-pane-activity` in the pane header: "Reading: path/to/file". Colors coded per activity (`styles.css:4940-4946`).
**Observation:** the activity text is `11px` and uses `var(--overlay1)` which is a dim overlay color. On a busy session it's nearly invisible. Anthropic's desktop app shows activity in the pane header with a pulsing avatar dot and clearer typography.
**Fix:** bump size to 12px, color to `var(--subtext0)`, add a subtle fade-in animation, and truncate with ellipsis at 240px rather than 200px.

### 5.3 No "what's Claude doing" meta-indicator on idle panes

**Observation:** when all panes are idle, there's no signal of "everything's done, time to do something". Warp has a "conductor" mode; Anthropic's app shows a last-output-line preview.
**Fix:** when all panes hit idle, subtly desaturate the pane headers (3% lighter, non-pulsing dot), and show a persistent "all panes idle" text in the bottom status area.

### 5.4 Pane expand has 3 states; expand button inverts at stage 2

**File:line:** `app.js:10446-10473` — normal → stage1 → stage2 (full viewport). At stage2 the expand button **disappears** (`styles.css:4974-4976` `display: none !important`). Collapse is red-only.
**Observation:** a user in stage2 pressing Esc (lowest priority, not caught by other overlays) collapses _all_ expanded panes via `_collapseAllExpandedPanes` (`app.js:10496`). If they only wanted to go from stage2 to stage1, they can't. It's all-or-nothing.
**Fix:** Esc at stage2 goes to stage1. Second Esc goes to normal. Cmd+Shift+F toggles between stage1 and stage2. Add keyboard cue.

### 5.5 Update modal doesn't show changelog

**File:line:** `index.html:1299-1314`.
**Observation:** update modal has `#update-steps` and `#update-status` divs. No changelog excerpt, no "what's new in 0.9.27". User is asked to update without being told why.
**Fix:** fetch `/api/changelog/latest` and render as markdown. Or embed the last 3 changelog entries into the update modal body.

### 5.6 Pair-mobile modal QR has no regeneration timer visible

**File:line:** `index.html:1641-1645`.
**Observation:** `#pair-timer` exists but no visual countdown. If the QR is time-limited (token expiry), users don't know they have 60s left.
**Fix:** rotating conic-gradient timer ring around the QR code, draining over 60s. Linear does this for their invite codes.

### 5.7 Kanban card status transition not animated

**File:line:** `app.js:16332` — `moveFeature` does a PUT then `await loadFeatureBoard()` which re-renders everything.
**Observation:** card pops from one column to another discontinuously. Drag-drop feels unforgiving. Optimistic UI + FLIP animation would make this delightful.
**Fix:** use View Transitions API or manually measure → move → animate.

### 5.8 Workspace accordion chevron uses `&#9654;` (arrow)

**File:line:** `index.html:882` and similar docs-section chevrons.
**Observation:** black right-pointing triangle is inconsistent with the rest of the iconography (stroke SVGs everywhere else). Linear uses a thinner, custom chevron.
**Fix:** replace with a 10×10 SVG stroke chevron. Matches the view-tab icons stylistically.

### 5.9 "Discover" and "Find a Conversation" are separate flows

**File:line:** `index.html:371` "Discover" button + `index.html:339` "Find a Conversation" button.
**Observation:** both search for sessions. "Discover" is list all unregistered JSONL sessions on disk. "Find a Conversation" is AI-powered semantic search. From the user's perspective these are both "find me a session". They're in different panels. Confusing.
**Fix:** merge into `Find...` entry in Ctrl+K with two sub-tabs: "Search" (AI) and "Discover" (list all).

### 5.10 Session detail has analytics, cost, subagents, logs, actions in a single scroll

**File:line:** `index.html:425-528`.
**Observation:** nine meta rows (Status, Project, Directory, Topic, Command, PID, Ports, Branch, Created, Last Active) + cost block + subagent block + analytics block + 3 action buttons + activity log. On a 1080p screen, this is a scroll-fest. Dense without hierarchy.
**Fix:** collapse the meta to 2 rows (Project · Directory, Created · Last Active). Put Command, PID, Ports, Branch into a "Details" disclosure (click to expand). Promote Status and cost to the header.

### 5.11 No "ship it" celebration

**Observation:** nothing happy happens after a task completes, a PR merges, or a worktree succeeds. Linear has confetti on first cycle completion. Raycast has a subtle pulse when a command succeeds.
**Fix:** subtle green glow + pulse on `.terminal-pane-done` (already partially built, `styles.css:7647-7655`). Add a sound effect option for power users.

### 5.12 Dashboard period selector toggles jump

**File:line:** `styles.css` doesn't seem to define `.costs-period-btn.active` smooth transition; HTML has `active` class (`index.html:1073`).
**Observation:** clicking period buttons jumps the active state visually. No sliding indicator.
**Fix:** a sliding `::before` pseudo-element that animates from one position to another (Linear/Arc style). Smooth transitions.

### 5.13 Theme picker is a dropdown; Arc-style swatch grid would be better

**File:line:** `index.html:160-184`. Renders 13 themes in a vertical dropdown with small swatches.
**Observation:** the swatches are 16×16 blobs with gradients. Users can't preview what a theme looks like without switching. Arc does a live preview on hover; Raycast shows a mini window preview.
**Fix:** hover on a theme option paints the app a 50%-preview tint. Or hover triggers a 2x2 grid preview (header/sidebar/card/terminal). At minimum, larger swatches with more theme content hinted.

### 5.14 No drag-to-reorder for themes

They're listed Mocha / Macchiato / Frappe / Nord / Dracula / Tokyo Night / Cherry / Ocean / Amber / Mint / Latte / Rose Pine Dawn / Gruvbox Light in hard-coded order. Users who prefer Tokyo Night shouldn't have to scroll past 6 others. Save recent theme choice to the top.

### 5.15 `#conflict-indicator-btn` badge is always shown even when 0

**File:line:** `index.html:236` — `<span class="conflict-badge" id="conflict-badge">0</span>`.
**Observation:** the `.conflict-indicator` button has `hidden` attribute on the button itself (line 231, `hidden`), so it's hidden when conflicts = 0. Good. But when conflicts > 0, the badge is rendered as plain text "3" without visual affordance. A red circle badge would be more recognizable.
**Fix:** style `.conflict-badge` as an absolutely positioned red circle in the top-right of the button, not inline text.

### 5.16 Folder browser doesn't remember last path

**File:line:** `app.js:8164-8300`.
**Observation:** every open starts from `initialPath || ''` which is typically the user's home directory. Professional apps remember the last path visited per use-case (this flow usually wants to re-pick a similar directory).
**Fix:** stash the last selected path in localStorage keyed by what invoked it (workspace CWD, session CWD, task CWD).

### 5.17 No "jump to previous pane" shortcut

**Observation:** terminal panes numbered 0-5. No shortcut to cycle focus. Tmux users reach for `Ctrl+a o` or `Ctrl+\` `.
**Fix:** `Ctrl+[1-6]` to focus slot N. `Ctrl+Tab` and `Ctrl+Shift+Tab` to cycle forward/back. Stored setting because some browsers intercept Ctrl+Tab.

### 5.18 Pair-mobile has no "copy link" fallback

**File:line:** `index.html:1641-1644` — QR container + `#pair-urls` div.
**Observation:** if the user is pairing from a tablet without a camera, they can't scan the QR. The URL list is shown below, but it's not obvious you can copy it.
**Fix:** make each URL a copy-to-clipboard button with a QR-less "Copy pairing URL" CTA.

### 5.19 Window-focus doesn't refresh SSE

**Observation:** SSE auto-reconnects on error (`app.js:8411`). But if the user sleeps their laptop and wakes up, there's no explicit `visibilitychange` listener to force-refresh state. They'll see stale session counts until the next SSE event arrives.
**Fix:** `document.addEventListener('visibilitychange', ...)` on visible → `loadAll()`. Also refresh when window regains focus.

### 5.20 Drop-target empty-pane label is literal CSS content

**File:line:** `styles.css:5086` — `.terminal-pane-empty .terminal-container::after { content: 'Drop a session here'; }`.
**Observation:** "Drop a session here" is hard-coded in English via CSS `content`. Un-internationalizable. Also styled as 13px muted text — weak visual pull. Linear's empty-terminal sells the action harder.
**Fix:** HTML-driven copy (`<div class="drop-hint">`). Stronger visual: illustration + primary CTA button "Launch a session" + secondary "Drop here".

### 5.21 Sidebar shows "0 projects" forever when empty

**File:line:** `app.js:8527-8540` — falls through to `<button>Create one</button>`.
**Observation:** fine, but the button is `btn-ghost btn-sm` so it looks weak. This is the first thing a user sees after login with nothing imported yet. It should be a primary CTA with an explainer.
**Fix:** full empty state with illustration, title "Organize your Claude sessions", description, primary "Create project", secondary "Discover existing".

### 5.22 Session list lacks filter UI

**File:line:** `index.html:367-397` — just "Discover" and "New" buttons. No filter.
**Observation:** if a workspace has 40 sessions, there's no way to filter by running/stopped/tag without going to the Session Manager overlay. Even Linear exposes inline filters.
**Fix:** add a small search input + status filter chips to the session list header. Or wire in a sidebar search mode (Ctrl+F while session list focused).

### 5.23 Docs raw editor is a giant textarea

**File:line:** `index.html:967-969`.
**Observation:** no syntax highlighting (despite CodeMirror being bundled per CHANGELOG 0.9.26). Plain textarea for Markdown. No preview split.
**Fix:** mount CodeMirror in Markdown mode when the raw tab is active. Add a "Preview" pane toggle.

### 5.24 `.ws-session-item` has inconsistent padding for pane color pip

**File:line:** `styles.css:1288-1299` — `.ws-session-item` has `padding: 5px 10px 5px 34px` and `.ws-session-meta-row` has `padding-left: 12px`. Two separate paddings across two different sub-elements. Very fragile under theme/scale changes.
**Fix:** establish `--session-item-indent: 34px` token and use it everywhere.

### 5.25 Cost dashboard chart has no zoom/pan

**File:line:** `app.js:14151-14255`.
**Observation:** SVG chart with fixed viewBox 600×180. Tooltip on dot hover. No zoom, no range selection. For users with months of data, day-resolution is too granular.
**Fix:** add a brush selector below the chart to zoom. Already have period buttons (day/week/month/all) at the top; the brush would be a secondary zoom-within-period.

---

## 6. P2 Issues (nice-to-haves)

### 6.1 Toast positions under mobile tab bar on iPhone
Already handled at `styles-mobile.css:249-251` with `bottom: calc(72px + env(safe-area-inset-bottom))`. Double-check on landscape mode.

### 6.2 Scrollbar thickness 6px is thin
`styles.css:113-115`. 8-10px is more usable. 6px feels like it's hiding. But Linear uses 4px, so this is defensible.

### 6.3 No "command menu" breadcrumb inside Ctrl+K
Type `> ` to filter to commands. Good. But after typing `> th`, there's no breadcrumb "Commands > Theme" at top. Raycast shows this.

### 6.4 Session time uses relative format everywhere
`app.js:9043` renders `relativeTime(s.lastActive || s.createdAt)`. "2 hours ago". For sessions 2+ days old this loses specificity. Add tooltip with absolute ISO timestamp on hover.

### 6.5 Color picker uses 12 colors; no custom
`app.js:7857-7870`. No HSL picker or hex input for power users who want exact branding.

### 6.6 Icon picker grid has no virtualization
`app.js:7895-7940`. With 2,331 icons rendered upfront, initial render may be slow on low-end devices. Search-as-filter helps but not for the first open.

### 6.7 Tab strip (header) has no overflow handling
`index.html:102-150` — 7 tabs (Terminal, Projects, Tasks, Costs, Recent, Docs, Resources). On narrow windows (<1100px) they overflow. Mobile hides them. Tablet breakpoint (1024px) hides stats but not tabs.

### 6.8 No `rel="noopener noreferrer"` on external links
Spot check: `app.js:4202` and other links have `rel="noopener"` but not `noreferrer`. Minor security polish.

### 6.9 Modal body `<p>` renders plain
`showConfirmModal` wraps message in `<p>${message}</p>` (`app.js:7831`). If the message contains HTML (user-controlled), it renders. `escapeHtml` is not called. Potential XSS if any caller passes user input.

### 6.10 Session logs render inline with no search/filter
`renderLogs` (`app.js:9364`). For busy sessions with 100+ log entries, no way to filter by type (error/warn/info) or search.

### 6.11 Voice input button is per-pane, but only one can record at once
`toggleVoiceInput` (`app.js:10513`). Behavior correct, but UI doesn't indicate which pane owns the current recording from elsewhere in the app.

### 6.12 Header logo has `width:64px height:64px` but title has `17px` font
`styles.css:784-786`. Logo is visually much heavier than the wordmark. Consider `width: 40px`.

### 6.13 No "pin pane" feature
If a user drags an important session to pane 0 and wants it to survive tab-group switches, no lock mechanism exists.

### 6.14 Discovered projects list has no sort options
`renderProjects` (`app.js:9423`). Alphabetical by default. No recency sort, no "most sessions" sort.

### 6.15 Scale control max is 1.2x / 120%
`index.html:22-25`. Some users may want larger. Relaxing to 1.5x is safe via CSS zoom.

### 6.16 `.btn:active { transform: scale(0.97) }` on ALL buttons
`styles.css:165-167`. Including icon-only tiny buttons. On a 20px button a 3% scale is visually nothing; on a wide primary CTA it's a solid press feel. Doesn't hurt but could be per-size.

### 6.17 Text in `<kbd>` tags inconsistent
`.qs-shortcut` vs `.qs-hint kbd` use slightly different paddings/backgrounds. Same visual token but two classes.

### 6.18 Session manager overlay has fixed filters
"All/Running/Stopped". No "idle", no tag filter, no recency.

### 6.19 Conflict center shows "Protected" text but not hover tooltip
`app.js:16224`. No hover explanation of what "protected" means.

### 6.20 No keyboard shortcut hint on hover for buttons
Compare to macOS native buttons that show `⌘K` on hover after 0.5s. Would require a 500ms hover-intent timer.

### 6.21 Dark themes have different shadows
Mocha: `0 1px 2px rgba(0,0,0,0.2)` etc. Latte: `0 1px 2px rgba(0,0,0,0.06)`. Fine. But Nord / Dracula / Tokyo Night override only the palette, not shadows — so Nord uses Mocha shadow values (`styles.css:8883`). Shadow depth is wrong for the lighter Nord bases.

### 6.22 Notes editor toolbar has no keyboard shortcuts
`index.html:1113-1118`. Clickable B/I/code/link/list buttons. Ctrl+B / Ctrl+I not bound.

### 6.23 Diff viewer uses "Select a file to view changes" empty state
`index.html:1541`. Weak empty state. Should list files and highlight first by default.

### 6.24 No "jump to top" button in long scrollable panels
Cost dashboard can be 1500px tall. No scroll-to-top anchor button.

### 6.25 `position: fixed` modals don't handle internal viewport resize on mobile keyboard open
Only `body.keyboard-open` is reset (`styles-mobile.css:600-614`). Modal layout may stick out.

### 6.26 `login-bg-grid` animated?
`styles.css:602-611`. It's static. A slight slow pan would feel more alive.

### 6.27 Logo float animation doesn't respect focus loss
`.login-logo-img` animates `logo-float 4s ease-in-out infinite`. No pause when window blurred. Minor CPU waste.

### 6.28 No zero-state illustration set
All empty states use the same SVG template (`index.html:390-394`). A little variety (different illustrations for sessions/workspaces/tasks/costs) would feel more designed.

### 6.29 Worktree task "Start with Context" naming
Appears in project context menu (`app.js:3158`). Unclear what it does without tooltip.

### 6.30 Launcher session-name field isn't validated
`index.html:1500` — plain `<input>`. No character limit, no slug normalization indicator.

---

## 7. Theme-Specific Issues

### 7.1 Latte (light)

- **Settings toggle thumb** (`styles.css:2108`) — see P0 4.6.
- **Stat dot running box-shadow** — overridden at `:7816` to use correct Latte green. Good.
- **Button-loader border top** uses `currentColor` — fine in all themes.
- **Toast background** uses `var(--surface0)` which in Latte is `#ccd0da` (pale lavender-gray). Good.
- **Mauve accent** `#8839ef` is a strong purple — good contrast on `#eff1f5` base.
- **Git branch badge** (`styles.css:7563`) `rgba(166, 227, 161, 0.1)` is Mocha green. In Latte it shows as a weak gray-green. Override needed.
- **Port link** (`styles.css:7544`) `rgba(137, 180, 250, 0.08)` is Mocha blue. In Latte, faint dusty lavender on cream. Not bad, but off-brand.
- **`.git-branch-badge.dirty`** `rgba(249, 226, 175, 0.1)` — Mocha yellow. Latte yellow is `#df8e1d` (more orange). Subtle, fixable.
- **Login grid mauve** `rgba(203, 166, 247, 0.03)` (`styles.css:606`) on light base — barely visible. Needs theme-aware color.
- **`.conflict-session-chip .conflict-session-dot`** no explicit style found; if it uses default red it may overflow contrast.
- **`.btn-primary:hover` box-shadow** `rgba(203, 166, 247, 0.2)` — works in Latte because violet is violet in both, but intensity feels wrong in light mode.

### 7.2 Rose Pine Dawn

- Defined at `styles.css:9009-9046`. Has `::selection`, `stat-dot-running`, `terminal-pane-empty.drag-over`, `terminal-resize-handle` overrides. **Nothing else.**
- Every hover-glow, every toast icon tint, every kanban drop zone uses Mocha rgba values.
- The `.login-bg-grid` and `.login-logo-img` drop-shadow stay Mocha mauve — looks wrong against `#faf4ed` base.

### 7.3 Gruvbox Light

- Same issue as Rose Pine Dawn. Defined at `styles.css:9051-9086`. 
- Gruvbox is known for its warm yellowy-cream palette. The Catppuccin shadow stack (subtle mauves, pinks, teals) doesn't fit. Shadows should be warmer sepia tones.

### 7.4 Nord

- Defined at `styles.css:8883-8919`.
- Shadows inherited from Mocha — too harsh for Nord's cool gray-blue palette. Should be lighter.
- `.stat-dot-running` override sets green box-shadow correctly.

### 7.5 Tokyo Night

- Defined at `styles.css:8967-9003`.
- Overrides the essentials but not hover glows, notification tints, or the login grid.
- Shadows are okay because Tokyo Night is dark like Mocha.

### 7.6 Dracula

- Defined at `styles.css:8925-8961`.
- Same caveats as Nord.
- `.btn-primary:hover` glow is Mocha mauve `rgba(203, 166, 247, 0.2)` — should be Dracula purple `rgba(189, 147, 249, 0.2)`.

### 7.7 Cherry / Ocean / Amber / Mint

- All defined (`styles.css:7961-8190`) with the core 4 overrides each.
- All still leak Mocha rgba in 200+ other places.

### 7.8 Frappe / Macchiato

- As close siblings to Mocha, they're fine. Minor contrast shifts (`#cad3f5` vs `#cdd6f4` text).
- `::selection` and `stat-dot-running` overridden correctly.

**Summary:** every non-Mocha theme has 10-40 visible tint/glow bugs. A single PR could fix them by mass-replacing `rgba(MocchaHEX, X)` with `color-mix(in srgb, var(--theme-token) X%, transparent)`.

---

## 8. Keyboard Navigation Audit

### Works today

| Shortcut | Action | File:Line |
|---|---|---|
| `Ctrl+K` / `Cmd+K` | Quick switcher | app.js:1002 |
| `Ctrl+Shift+F` / `Cmd+Shift+F` | Global search | app.js:1007 |
| `?` (non-input context) | Help / feature discovery | app.js:1012 |
| `F1` | Help / feature discovery | app.js:1017 |
| `Ctrl+,` / `Cmd+,` | Settings | app.js:1022 |
| `Ctrl+Shift+N` / `Cmd+Shift+N` | New worktree task | app.js:1027 |
| `Ctrl+S` / `Cmd+S` | Save file (Files tab) | app.js:1032 |
| `Esc` | Cascade close (8 overlays in priority order) | app.js:1039 |
| `Ctrl+V` in terminal | Paste | terminal.js:381 |
| `Shift+Enter` in terminal | Newline | terminal.js:388 |
| `Ctrl+Enter` in notes editor | Save | app.js:13648 |
| Arrow up/down in Ctrl+K | Navigate results | app.js:7563 |
| Enter in rename inputs | Commit rename | app.js:12526 (and 3 other locations) |
| Escape in rename inputs | Cancel rename | app.js:12527 |

### Missing (proposed additions)

| Shortcut | Action | Priority |
|---|---|---|
| `Ctrl+1..7` | Switch view tabs (Terminal/Projects/Tasks/Costs/Recent/Docs/Resources) | P0 |
| `Ctrl+Shift+[1..6]` | Focus pane N | P0 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle panes | P1 |
| `Ctrl+W` | Close active pane | P1 |
| `Ctrl+T` | New terminal in active workspace | P1 |
| `Ctrl+/` | Toggle sidebar | P1 |
| `Ctrl+Shift+P` | Show/hide pane | P1 |
| `Ctrl+B` | Toggle sidebar (VSCode muscle memory) | P2 |
| `Arrow Up/Down` in sidebar | Navigate workspaces | P0 |
| `Arrow Right/Left` in sidebar | Expand/collapse workspace | P1 |
| `Enter` on focused workspace | Open | P0 |
| `g` then `g` | Jump to top of session list (vim) | P2 |
| `G` | Jump to bottom | P2 |
| `j` / `k` | Down / up (vim alt) | P2 |
| `n` / `N` | Next / prev tab group | P2 |
| `Ctrl+R` | Refresh current view | P2 |
| `Ctrl+Shift+C` | Copy last Claude response | P2 |
| `Ctrl+D` in terminal | Duplicate session to new pane | P2 |
| `Ctrl+Alt+↑/↓` | Move pane up/down in grid order | P2 |

### Focus management holes

- No focus ring visible on most interactive elements until tabbed. `:focus-visible` is set globally (`styles.css:106-109`) with `outline: 2px solid var(--accent)` but most custom buttons override it via `.btn { border: none }` + a subtle hover, losing the focus state.
- Modal first-input auto-focus is inconsistent. `showPromptModal` focuses first input via `requestAnimationFrame` (`app.js:8076`). `showConfirmModal` doesn't — the confirm button isn't auto-focused. `showFolderBrowser` doesn't focus its list.
- No focus return after modal close: when a user tabs into a workspace action, opens rename modal, confirms, focus is lost (returns to `<body>`). Should return to the invoking element.

### Screen reader findings

- `aria-live="polite"` on `#login-error` ✓ and `#toast-container` ✓.
- `aria-label` on icon-only buttons: many use `title` but not `aria-label` (e.g. `#sidebar-toggle` has both, `#password-toggle-btn` has both, `#update-btn` has `title` only, `#theme-toggle-btn` has `title` only, the terminal pane buttons have `title` only).
- `role="tablist"` is used for view-tabs (`index.html:102`) ✓.
- `role="tab"` on each tab ✓.
- `role="dialog"` — partial (see P0 4.9).
- No `aria-describedby` on modal body text.

---

## 9. Micro-Interactions Wishlist

### 9.1 Stagger list reveals on view switch

When the user switches to "Sessions" view, all session items fade in simultaneously. Staggering them 30ms apart creates a Linear-like cascade.

```js
// in renderSessions:
list.querySelectorAll('.session-item').forEach((el, i) => {
  el.style.animationDelay = `${i * 20}ms`;
  el.classList.add('session-enter');
});
```

Add CSS: `.session-enter { animation: fadeSlideIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both; }`.

### 9.2 Optimistic kanban card move

On drag-drop, immediately position the card in the target column with a subtle spring; fire API in background. On failure, snap back with a shake animation.

### 9.3 Active pane pulse on first interaction

When a user first types into a pane after a period of inactivity, the pane header glows mauve for 200ms. Signals "you're in this one now".

### 9.4 Cost counter tick-up animation

Cost dashboard total cost could count up from 0 to the final value over 600ms on load (`countUpAnimation` with `requestAnimationFrame`). Small detail, very Stripe.

### 9.5 Breadcrumb transitions in docs panel

When user switches from Docs tab to Board tab (`index.html:836`), animate the underline indicator left-to-right via the sliding-indicator pattern.

### 9.6 Drag ghost preview

When dragging a session from sidebar to terminal pane, show a small floating preview card with session name + status dot instead of the native browser drag image.

### 9.7 Toast swipe-back animation

The toast already supports swipe-right-to-dismiss (`app.js:8322-8361`). If the user drags 40% of the way then releases, it snaps back with a tiny overshoot spring.

### 9.8 Workspace reorder drop-indicator with motion

Current implementation shows a static 2px line (`styles.css:1152-1157`). A subtle cyan glow that animates 300ms before the drop completes feels much more premium.

### 9.9 Theme switch transition

Switching themes currently re-applies CSS variables instantly. A 200ms `background`/`color` transition on `:root` would make it feel like turning a dial, not flipping a switch.

```css
:root { transition: background 200ms ease, color 200ms ease; }
```

### 9.10 Pane-done flash → toast trail

When a pane's task finishes, the pane flashes green (`styles.css:7653`). Also emit a small floating text particle "Done" that rises from the pane center and fades. Raycast-style.

### 9.11 Typing indicator for partial idle

When Claude is streaming a response mid-sentence, show 3 blinking dots after the `Thinking` label in the pane header. Synced with the activity detection already in `terminal.js:1122`.

### 9.12 Haptic feedback on mobile swipe-to-reveal

The mobile session-item swipe-actions (`styles-mobile.css:789-836`) reveal on swipe. Add `navigator.vibrate(10)` on the snap-to-reveal for tactile feedback.

### 9.13 Cursor effects on login card

On the login screen, the mouse cursor position should subtly tilt the card (CSS `perspective` + `transform: rotateX/rotateY`). Arc does this beautifully.

### 9.14 Spinner → skeleton replacement

Current `.btn-loader` is a spinning circle. A skeleton bar sliding through the button (like Stripe's "Processing") feels more 2026.

### 9.15 Glow trail for active pane border

The active pane has `box-shadow: inset 0 0 0 1px var(--mauve)` (`styles.css:5108`). A looping gradient border (`animation: conic-gradient-rotate`) would be a nice "currently alive" signal.

### 9.16 First-time context-menu hint

On first right-click after login, show a tooltip "Tip: press `?` for all shortcuts". Dismiss permanently on first dismiss.

### 9.17 Search result diff highlight

When the quick switcher matches a session, highlight the matched substring in mauve. Already partial (character class matches). Needs to be a real diff substring, not just a class toggle.

### 9.18 Command palette sibling preview

Typing `theme` in Ctrl+K shows theme-related items; hovering a theme item paints the preview in the main app behind the modal (50% opacity through the backdrop). Arc does this with browser themes.

### 9.19 Drag-to-reorder tabs animation

Tab group tabs (`terminal-groups-tabs`, `index.html:533`) have drag-drop to reorder. Ensure a FLIP animation plays during the reorder, not a teleport.

### 9.20 Modal entrance stagger

Currently modals enter with `modal-in` (`styles.css:2734-2743`) which translates Y + scales. Add a second layer: child elements (header → body → footer) fade in staggered 40ms apart for a more considered feel.

---

## 10. Native-Feel Gaps

Myrlin is a browser app. The official Claude Code desktop is Electron/Tauri. Here's what Myrlin can add to close the gap without full native rewrite.

### 10.1 OS-level notifications (P0)

Already discussed in 2.8. Use the `Notification` API directly:

```js
if (Notification.permission === 'granted') {
  new Notification(`${sessionName} finished`, {
    body: detail || 'Claude is waiting for input',
    icon: '/favicon-192.png',
    badge: '/favicon-32.png',
    tag: `session-${sessionId}`,
    renotify: true,
  });
}
```

Effort: S (1-2 hours).

### 10.2 System tray icon / menu bar (P1)

Requires Electron/Tauri shell. On macOS, show pane count in menu bar (e.g. `"Myrlin 4↑"` meaning 4 panes, 1 finished awaiting attention). Clicking brings Myrlin to the front, or opens a quick action list.

Effort: L (1-2 weeks for Electron shell packaging).

### 10.3 Global hotkey to summon Myrlin (P1)

`Cmd+Shift+M` (or user-defined) from anywhere in the OS brings Myrlin to the front and focuses Ctrl+K. Raycast is the reference.

Effort: M (Electron feature, few days).

### 10.4 Auto-launch on login (P2)

Electron/Tauri `app.setLoginItemSettings({ openAtLogin: true })`. Add a setting toggle.

Effort: S.

### 10.5 Window state persistence (P1)

Remember size, position, full-screen state across launches. Currently if you close and reopen, window size resets.

Effort: S.

### 10.6 Native file drag-drop from OS

Currently image drag-drop works via browser `DataTransfer` API. But dragging a .py file from Explorer doesn't insert its path into the terminal. Native shells can handle this with `electron/remote`.

Effort: M.

### 10.7 Drag-out session to desktop

Export a session as a `.myrlin-session` bundle dragged to the desktop. Users could share sessions with teammates.

Effort: M.

### 10.8 macOS Dock / Windows taskbar badges

Show running session count as dock badge: `1`, `2`, ... with red dot for "needs input". `app.setBadgeCount(n)` in Electron.

Effort: S.

### 10.9 Jump lists on Windows taskbar

Right-click the taskbar icon shows "Recent sessions" + "New session" + "Open last workspace". `app.setJumpList()` in Electron.

Effort: M.

### 10.10 macOS menu bar menus

App > Preferences, File > New Session, Edit > Copy, View > Switch pane, Window > Minimize, Help > Shortcuts. Full macOS menu rigor. `Menu.buildFromTemplate(...)` in Electron.

Effort: M.

### 10.11 Touch Bar support (macOS)

On MacBook Pros with Touch Bar, show: current pane status, play/pause, kill session, copy output. `TouchBar` in Electron.

Effort: M (small user base — 2019-2024 MBPs only).

### 10.12 Window transparency on compatible OSes

macOS Monterey+ and Windows 11 support `vibrancy` and `Mica` backdrops. Myrlin could render its sidebar with OS-level blur. Electron `setVibrancy()` or Tauri `window_vibrancy` crate.

Effort: S once shell is in place.

### 10.13 Auto-update with in-app dialog

Current update modal (`index.html:1299`) is manual-check. Native shell allows `autoUpdater.checkForUpdates()` with background download and "Restart to install" prompt. Like VS Code, Chrome.

Effort: M.

### 10.14 Native sharing on mobile

On mobile `share` button currently copies text. iOS/Android native share sheet via `navigator.share({...})` is already supported but not wired from many places. Copy Session ID, Copy URL, export JSON all should route through `share()`.

Effort: S.

### 10.15 Universal deep links

`myrlin://session/<id>` protocol. Click a Myrlin link in Slack/Messages and it opens the app to that session. Electron `app.setAsDefaultProtocolClient('myrlin')`.

Effort: M.

### 10.16 Drag to different monitor

Multi-monitor users: detect and offer to spawn a new Myrlin window on monitor 2. `BrowserWindow.setBounds()`.

Effort: M.

### 10.17 Spellcheck in notes / docs

Native spellcheck in `<textarea>` is on (`spellcheck="true"`), good. But no word-highlighting. Electron's `SpellCheckProvider` adds underlines + right-click replacements.

Effort: S (native shell).

### 10.18 Trackpad gestures

Pinch-to-zoom pane, swipe with 3 fingers to switch tab groups. Web API has limited support; native shell gestures via `ontouchforcechange` (macOS force touch) or pointer events.

Effort: M.

### 10.19 Window snap zones (Windows 11)

Win11 lets you snap windows to pre-defined layouts. Myrlin's multi-pane layout should respect snap-zone hints.

Effort: S.

### 10.20 Background mode when minimized

Native shells can keep SSE + WS connections alive even when the browser tab would be throttled. Currently Myrlin's SSE/WS connections may be throttled to 1hz when tab is hidden. Native shell = no throttle.

Effort: inherent to native shell.

---

## 11. Proposed v0.10 "Polish Pass" Scope

Ranked by impact × feasibility. S = small (< 4h), M = medium (1-2 days), L = large (1+ week).

| # | Item | Effort | Impact | Priority |
|---|---|---|---|---|
| 1 | Unify modal primitives into single `<Modal>` + variant HTML snippets (consolidates 13 → 1) | L | P0 huge | **Do first** |
| 2 | Sweep hardcoded Mocha rgba → `color-mix(var(--X) N%, transparent)` | M | P0 theme fidelity | **Do first** |
| 3 | Replace `index.html` 6× terminal-pane duplication with `<template>` + JS clone | M | P0 maintainability | Second |
| 4 | OS notifications on `terminal-idle` + permission-request flow | S | P0 | Second |
| 5 | Keyboard map expansion: `Ctrl+1..7` view switch, `Ctrl+Shift+1..6` pane focus, `Ctrl+B` sidebar, arrow-nav in sidebar | M | P1 big productivity | Third |
| 6 | Loading-state unification: all data-fetching panels use skeleton rows, not "Loading..." text | M | P0 polish | Third |
| 7 | Empty-state refresh: illustrations + primary CTAs for "no sessions", "no projects", "no tasks", "no cost data" | M | P1 first-run feel | Fourth |
| 8 | Focus trap + focus return for every modal | S | P0 a11y | Fourth |
| 9 | Theme-aware `stat-dot-running`, `terminal-pane-empty.drag-over`, `git-branch-badge`, `port-link`, `.btn-primary:hover`, `.input:focus` glow for all 13 themes | M | P0 | Fifth |
| 10 | First-run onboarding overlay: 3-step guided tour (Ctrl+K, Launch session, Terminal grid) | M | P1 | Fifth |
| 11 | Cost dashboard chart with brush selector + tick-up animation | M | P2 | Sixth |
| 12 | Context menu keyboard-shortcut hints via `ctx-hint` slot | S | P1 | Sixth |
| 13 | Drag-to-reorder tabs animation (FLIP) + optimistic kanban card move | M | P2 | Sixth |
| 14 | Toast level-specific timeouts + max 3 visible | S | P0 | Seventh |
| 15 | Electron/Tauri shell with tray icon, global hotkey, window state, native notifications (consolidates #4 + adds OS layer) | L | transformative | **v0.11 big bet** |

### Polish Pass design principle

Every item above should pass the "Linear at home" test: **if I were looking at this in Linear or Raycast, would I notice it?** If yes, it's a cut. If no, keep iterating.

### Priority order recommendation

Ship v0.10.0 with items 1-9 (the P0 foundation). This is 2-3 weeks of focused work. Items 10-14 make v0.10.1-0.10.3. Item 15 is the v0.11 tentpole.

---

## 12. Appendix: File-by-File Observation Log

### index.html (1668 lines)

| Line(s) | Finding | Priority |
|---|---|---|
| 8 | Title "myrlin's workbook" (lowercase, apostrophe-s) | P0 rebrand |
| 9-11 | Three favicon references — good PWA hygiene | ok |
| 14 | Plus Jakarta Sans + JetBrains Mono from Google Fonts | ok, consider local bundle for offline |
| 21 | Theme array hardcoded: 13 themes | fine |
| 24 | UI-scale localStorage range 0.85-1.2 | P2 allow 0.75-1.5 |
| 38-44 | Login logo + title + subtitle, centered | ok |
| 39 | Logo referenced `logo.png` (per CHANGELOG 0.9.3 fix) | ok |
| 57 | Password toggle button is `tabindex="-1"` so it's skipped in tab order | ok |
| 66-67 | Two eye icons (show + hide SVG), one always hidden | ok |
| 89-99 | Header layout: left (toggle + brand), center (tabs), right (actions) | ok |
| 102-150 | View tabs: Terminal, Projects, Tasks, Costs, Recent, Docs, Resources | 7 tabs — overflow at <1100px |
| 154-159 | Update button | small, understated |
| 160-184 | Theme picker dropdown with 13 themes | P1 preview-on-hover |
| 193-198 | Settings button with title="Settings (Ctrl+,)" | ok |
| 199-210 | Stats chips (running count + total count) | ok |
| 213-228 | Session manager overlay sub-panel | complex, see 4.9 |
| 231-237 | Conflict indicator button | P1 styling |
| 240-252 | Conflict center overlay | ok |
| 254-258 | Open switcher button (Ctrl+K) | ok |
| 260-270 | Restart all + logout buttons | ok |
| 277-358 | Sidebar structure: launch btn, view toggle, projects header/list, resize handle, tasks header/list, footer, nested projects header/list | complex |
| 302-312 | Workspace list + sidebar-tasks-header switching | ok |
| 315-323 | Workspace count + toggle-hidden button (eye icon) | ok |
| 324 | `#sidebar-section-resize` divider between workspaces and projects | good UX |
| 337-346 | Projects search bar with "Find a Conversation" button | P1 merge into Ctrl+K |
| 350-357 | Sidebar collapse button | ok |
| 364 | Main content container | ok |
| 367-397 | Session list panel (has Discover + New buttons + empty state) | P1 filter UI |
| 400-529 | Session detail panel with 9 meta rows + cost + subagents + analytics + actions + logs | P1 dense, collapse meta |
| 532-535 | Terminal tab groups bar (multiple tab groups of panes) | ok |
| 538-816 | Terminal grid: 6 panes, each ~45 lines of duplicated HTML | **P0 deduplicate** |
| 819-964 | Docs panel: notes/goals/tasks/td/roadmap/rules/ai-insights | ok |
| 836-875 | Feature board (kanban) | P2 consolidate with worktree kanban |
| 973-1063 | Tasks panel with 4 sub-tabs: worktree/td/git/files | ok |
| 1005-1048 | Worktree kanban columns (Backlog/Planning/Running/Review/Done) | ok |
| 1066-1084 | Costs panel | ok |
| 1087-1101 | Resources panel | ok |
| 1106-1135 | Notes editor modal | separate modal |
| 1137-1180 | Mobile bottom tab bar | ok |
| 1184-1213 | Quick switcher modal (Ctrl+K) | ok |
| 1215-1223 | Global search modal (Ctrl+Shift+F) | ok |
| 1225-1250 | Find conversation modal (AI session finder) | P1 merge |
| 1252-1271 | Generic confirm/prompt modal | **P0 unify** |
| 1273-1294 | Folder browser modal | separate |
| 1296-1314 | Update modal | separate, P1 changelog |
| 1316-1386 | New task modal | separate |
| 1388-1431 | PR dialog | separate |
| 1433-1471 | Spinoff modal | separate |
| 1473-1522 | Launcher modal | separate |
| 1524-1545 | Diff viewer | separate |
| 1547-1574 | TD issue modal | separate |
| 1577-1591 | Settings overlay | separate |
| 1594 | Toast container | ok |
| 1600-1603 | Context menu | ok |
| 1605-1615 | Mobile action sheet | ok |
| 1617-1624 | Terminal reader overlay | ok |
| 1627-1654 | Pair mobile modal with QR | P1 regen timer |
| 1657 | Hidden file input for image uploads | ok |
| 1659-1666 | Script tags: lucide, material-icons, qrcode, xterm + addons, terminal, app | ok |

### styles.css (9885 lines)

| Line(s) | Finding | Priority |
|---|---|---|
| 21-94 | Root tokens: Catppuccin Mocha palette + semantic tokens + dimensions + transitions + shadows + typography | **Base is good** |
| 65 | `--sidebar-width: 280px` | P2 configurable |
| 66 | `--header-height: 80px` | tall; most apps use 48-56px |
| 73-75 | Transition tokens: fast 150, normal 200, slow 300 — all same easing | ok |
| 89 | Default font-size 14px + line-height 1.5 | ok |
| 106-109 | `:focus-visible` with 2px mauve outline + 2px offset | good base, overridden by button hovers |
| 112-128 | Scrollbar styling 6px, surface1 thumb, surface2 hover | ok |
| 144-255 | Button system: base, primary, danger, ghost, icon, sm, full, danger-hover, loader | solid |
| 146-163 | `.btn` base: padding 8/16, radius md, font-sans 13/500, cursor pointer, transition all fast | ok |
| 179-188 | `.btn-primary` mauve + black text + hover glow 3px rgba mauve .2 | theme-hardcoded rgba |
| 190-197 | `.btn-danger` red + black + hover glow 3px rgba red .2 | theme-hardcoded rgba |
| 258-343 | Input system | solid |
| 345-445 | Status badges + session list inline badges | ok |
| 465-585 | Spinoff task card styles | separate, consolidate with modal |
| 587-713 | Login screen + logo floating animation | ok, logo too wide |
| 661-668 | `@media (prefers-reduced-motion: reduce)` for login logo | good |
| 716-996 | App layout, header, sidebar | ok |
| 721-725 | `.app` uses 100vh + 100dvh | good mobile |
| 755-762 | `.sidebar-toggle` hidden by default, shown on mobile | ok |
| 809-855 | View tabs styling with per-mode accent colors | interesting idea, mauve/green/peach per mode |
| 864-896 | Header stats chips | ok |
| 911-994 | Sidebar + collapse states + resize handle | ok |
| 998-1100 | Sidebar launch button + workspace list items | ok |
| 1115-1225 | Workspace item: transition all fast, hover bg, active bg + border, per-workspace color accent left-bar | **good design** |
| 1162-1172 | Active workspace has `::before` color bar — elegant | good |
| 1227-1236 | Workspace-actions opacity 0 → 1 on hover | P1 see 5.1 |
| 1288-1366 | `.ws-session-item` nested session rows | ok |
| 1368-1502 | Main content + session list + items + empty state | ok |
| 1505-1700 | Session detail panel | ok |
| 1759-1806 | Cost summary block in session detail | ok |
| 1940-1960 | `.modal-overlay` + backdrop-filter blur 8px + animation | good base |
| 1962-2211 | Settings panel styles (header, search, body, category, row, toggle, scale, number, hidden items) | complete, mostly good |
| 2080-2122 | Settings toggle switch track + thumb | **P0 thumb contrast in Latte** |
| 2214-2266 | `.modal` + header + body + footer | generic, but overridden by many specific modals |
| 2269-2453 | Quick switcher styles | solid |
| 2414-2423 | `.qs-result-shortcut` — good, but only on command palette items, not context menus |
| 2456-2576 | Worktree task review banner with merge/reject/diff/resume/push colored buttons | good design |
| 2579-2670 | Toast system with swipe-dismiss | P0 60s timeout |
| 2673-2706 | Fallback banner | ok |
| 2709-2791 | Animation keyframes: login-enter, fade-in, overlay-in, modal-in, toast-in, toast-out, pulse-green, spin, skeleton-pulse | good collection |
| 2799-2807 | `prefers-reduced-motion` global override | good |
| 2809-2945 | Tablet/mobile responsive queries | ok |
| 2947-3073 | Terminal tab strip + mobile toolbar | ok |
| 3076-3099 | Terminal reader overlay | ok |
| 3373-3556 | Context menu + items + submenu | solid |
| 3526-3533 | `.ctx-hint` for keyboard shortcuts — **defined but never populated** |
| 3559-3731 | Discover rows + sidebar projects/divider + projects search/find convo | ok |
| 3733-3838 | Find convo modal with AI search | ok |
| 3840 | `transition: all 150ms ease` — bypasses token |
| 4103-4244 | Settings row + toggle + scale + number + tunnel configuration | dense |
| 4137-4703 | Docs panel structured view | solid |
| 4415 | `:root[data-theme="latte"] .docs-rule-item` override | scattered |
| 4683-4735 | Docs raw editor + tab strip | ok |
| 4892-5177 | Terminal grid + pane + header + activity + expand/collapse + mic + upload + drag | **complex, pane dup** |
| 4940-4946 | Activity-dot colors per type | good |
| 4988-5011 | Pane expand stage1/stage2 positioning | P1 see 5.4 |
| 5089 | `rgba(203, 166, 247, 0.05)` on drop — theme-hardcoded |
| 5099-5104 | Pane drag-reposition with box-shadow inset 2px mauve | ok |
| 5118-5135 | Pane color highlights via `html.pane-colors-enabled` — optional feature, good |
| 5174-5177 | Tristate pulse animation | ok |
| 5199-5203 | Activity indicators disable class | ok |
| 5204-5232 | Terminal grid resize handles | ok |
| 5242-5338 | Nested session display (project groups in sidebar) | ok |
| 5647-5798 | AI insights section + skeleton + error | **good skeleton example** |
| 5800-6016 | Tasks panel + header + search + layout toggle | ok |
| 5861-5957 | Task item with tri-state dots + branch + meta + changes + actions | dense but ok |
| 6049-6273 | Kanban board + column + card (worktree tasks) | good design |
| 6128-6263 | Kanban card with status-colored left border, hover elevation, preview, timeline | good |
| 6460 | Second `.workspace-item` selector? duplicate definition? | P2 check for dead CSS |
| 7405-7674 | Resources panel + tables + actions + tunnel section | ok |
| 7563 | `.git-branch-badge` uses `rgba(166, 227, 161, 0.1)` | theme-hardcoded |
| 7604-7693 | Terminal loading animation with RGB border glow + done flash + tab notify | good |
| 7704-8190 | 7 dark themes defined | solid base |
| 7704 | Latte palette | correct colors |
| 8883 | Nord palette | correct |
| 8925 | Dracula palette | correct |
| 8967 | Tokyo Night palette | correct |
| 9009 | Rose Pine Dawn palette | correct |
| 9051 | Gruvbox Light palette | correct |
| **per-theme override count** | 3-4 selectors per theme beyond the root palette | **insufficient** |

### styles-mobile.css (969 lines)

| Line(s) | Finding | Priority |
|---|---|---|
| 9-118 | Mobile foundation: 44px tap targets, safe-area-inset, `font-size:16px` inputs to prevent iOS zoom, `sidebar.open` slide-in | **Well-done** |
| 42-45 | `.view-tab` min-height 44px on mobile | correct |
| 53-63 | Hover elements always visible on mobile | correct |
| 74-76 | Sidebar transition cubic-bezier 0.16, 1, 0.3, 1 | consistent with tokens |
| 82-86 | `-webkit-overflow-scrolling: touch` on scrollable areas | iOS support |
| 89-94 | `body.sheet-open` lockdown | correct |
| 103-112 | App header fixed 50px on mobile | correct |
| 121-147 | Mobile bottom-sheet modals with sheet-up animation | good |
| 152-208 | Mobile tab bar with safe-area padding | well-done |
| 197-203 | Active tab is green, `:active` opacity 0.7 | ok |
| 226-246 | Session detail slides in from right | good |
| 255-400 | Action sheet with handle, header, items, cancel | solid |
| 404-644 | Mobile terminal layout: viewport-fill, overscroll prevention, xterm pan-y | detailed |
| 403-491 | Terminal tab strip in mobile | ok |
| 516-517 | `body.terminal-active .app { height: var(--vh, 100dvh); }` | correct |
| 531-548 | Terminal grid becomes single-pane on mobile | correct |
| 586-588 | `.xterm-screen { touch-action: none }` | correct |
| 600-614 | Keyboard-open body state | correct |
| 620-642 | Pane position indicator dots | good |
| 646-783 | Mobile terminal toolbar with type/read/send/etc buttons | ok |
| 788-837 | Session swipe-to-reveal actions | good |
| 842-969 | Quick switcher full-screen on mobile, docs editor, workspace/session touch sizing | solid |

**Overall mobile CSS is well-designed.** Much more rigorous than desktop CSS in several ways (consistent 44px touch targets, safe-area respect, proper scroll lockdown). The mobile code is in better shape than the desktop code.

### app.js (17,576 lines)

Selected observations only (file too large to catalog each function):

| Line(s) | Finding | Priority |
|---|---|---|
| 1-1200 | Class `CWMApp` instance setup, element refs, state, router, initial loads | ok |
| 682-714 | Keydown handler for context menu Esc + quick switcher input keydown | ok |
| 999-1065 | Global keyboard shortcuts + Escape cascade | limited map |
| 1071-1087 | Terminal event listeners: terminal-idle, terminal-activity, terminal-needs-input | solid |
| 1106-1128 | Mobile tab bar wiring | ok |
| 1145-1180 | VisualViewport listener for soft keyboard | good |
| 1999-2030 | showLogin / showApp | ok |
| 2985-3266 | 3 context menu builders (session, projectSession, project) | **consolidate?** |
| 3642 | Settings registry for Ctrl+K action catalog | good |
| 3921-3986 | More action catalog entries | ok |
| 4103-4457 | renderSettingsBody with 8 control types (scale, number, select, server-text, tunnel, toggle, hidden-items) | dense but comprehensive |
| 4571-4700 | Sidebar tasks rendering | ok |
| 4766-4901 | Tasks TD panel | ok |
| 4913-5248 | Tasks files panel with CodeMirror editor | ok |
| 5249-5601 | Tasks git panel | ok |
| 5602-6324 | Tasks view main render | big function |
| 6325-6408 | Branch preview update | ok |
| 7405-7584 | Sidebar resize handles (main + section) | ok |
| 7585-7822 | Quick switcher results render + highlight + navigation | ok |
| 7826-8152 | 3 modal variants: showConfirmModal, showPromptModal, showChoiceModal + closeModal | **consolidate** |
| 8164-8299 | showFolderBrowser (separate modal logic) | consolidate |
| 8301-8376 | Toast system with swipe-dismiss | **P0 timeout** |
| 8382-8520 | SSE + handleSSEEvent | ok |
| 8527-8779 | renderWorkspaces (big function) | dense but ok |
| 8780-9005 | 3 more context menus (workspace, group, feature) | see 3.2 |
| 9006-9420 | renderSessions + renderSessionDetail + renderWorkspaceAnalytics + renderLogs + renderStats | ok |
| 9423-9778 | renderProjects (discovered sessions) | dense |
| 9779-10174 | Drag-and-drop init | complex but ok |
| 10175-10208 | updatePaneActivity | ok |
| 10209-10572 | showTerminalContextMenu (shell switcher, shared items) | complex, see 3.1 |
| 10760-11082 | updateTerminalGridLayout + initTerminalResize | ok |
| 11083-11244 | initTerminalPaneSwipe (mobile swipe) | ok |
| 11245-11305 | showActionSheet (mobile) | see 3.2 |
| 11306-11479 | showMoreMenu (mobile) | ok |
| 11480-11638 | updateTerminalTabs (mobile) | ok |
| 11639-11780 | initTouchGestures (swipe to switch views) | ok |
| 11781-11973 | renderDocs (5 section renderers inline) | **P2 consolidate** |
| 11984-12621 | TD issues logic | ok |
| 12623-12958 | Terminal groups (tab groups) | ok |
| 13640-13732 | Notes editor modal logic | ok |
| 13733-13858 | AI insights loading + render | ok |
| 13859-14255 | Cost dashboard rendering + chart | dense, good |
| 14262-14651 | Resources loading + rendering + tunnel management | ok |
| 14726-14938 | showWorktreeList | ok |
| 14939-15372 | Worktree task banner + diff viewer | ok |
| 15373-15785 | Update modal + version handling | P1 changelog |
| 15786-15923 | Image upload handler | ok |
| 16181-16295 | renderConflictCenter | ok |
| 16297-16539 | Feature board (kanban) rendering + CRUD | consolidate with worktree kanban |
| 16588-16958 | Session manager overlay | ok |
| 16959-17225 | Launcher rendering | ok |
| 17226-17575 | Pair mobile init + modal + device actions + badge | ok |

### terminal.js (1344 lines)

| Line(s) | Finding | Priority |
|---|---|---|
| 1-219 | 8 THEME_* static color palettes + getCurrentTheme | ok, but only 8 of 13 themes have palettes — Nord/Dracula/Tokyo Night/Rose Pine Dawn/Gruvbox Light fall back to THEME_MOCHA |
| 221-261 | Constructor: sessionId, term, ws, reconnect tracking, activity state, write batching buffers | clean |
| 280-485 | mount() — Terminal init, fit, connect, ResizeObserver, key handlers, paste interception | solid |
| 399-458 | iOS autocorrect / insertReplacementText / paste handling | **excellent robustness** |
| 487-643 | connect() — WebSocket lifecycle, onopen/onmessage/onclose/onerror | good |
| 610-637 | Exponential backoff reconnect with 10 max attempts + fatal error cb | ok |
| 663-691 | pasteFromClipboard, sendCommand | ok |
| 693-727 | safeFit + isMobile | ok |
| 729-990 | initMobileInputMode, _enableMobileSelection, _disableMobileSelection, setMobile{Type,Scroll}Mode, toggleMobileInputMode | **excellent** touch-scroll implementation |
| 991-1075 | Write batching with rAF + bg flush timer | **good perf design** |
| 1076-1137 | Activity detection (tool-use pattern matching) | well-done |
| 1139-1225 | Completion detection with debounced idle check | solid |
| 1226-1323 | Auto-trust / question detection with danger keywords | good |
| 1325-1344 | dispose() | correct cleanup |

**terminal.js is the most polished file in the codebase.** Clean, well-commented, handles edge cases, proper cleanup, no duplication. It's the example that the rest of the code should aim for.

**One finding:** themes Nord, Dracula, Tokyo Night, Rose Pine Dawn, Gruvbox Light fall back to THEME_MOCHA for xterm colors. So when a user on Rose Pine Dawn opens a terminal, the xterm palette is Mocha while the surrounding UI is Rose Pine. Add 5 more static theme palettes.

---

## Closing thought

Myrlin Workbook at 0.9.27 is a working, feature-dense, genuinely usable tool. The terminal subsystem alone (terminal.js) is worthy of a conference talk. The mobile responsive work (`styles-mobile.css`) is better than most commercial shipping products. The Catppuccin integration is tasteful. The kanban + worktree + cost dashboard breadth is remarkable for a solo-built project.

But the app is also carrying nine versions of iteration debt. Modal shells drift. Themes leak Mocha colors. Keyboard shortcuts are sparse. Empty states are flat. Micro-motion is inconsistent. And a single-person tool can get away with this because the creator knows every keyboard shortcut and every corner. A polished product for other people needs the drift cleaned.

The gap to "sits next to claude.ai/code without shame" is real but finite. Items 1-9 in Section 11 are the foundation. Items 10-14 are the difference between "competent" and "excellent". Item 15 (native shell) is the difference between "excellent web app" and "app I'd recommend to a friend". All are within reach.

The bones are great. What's needed is a focused v0.10 pass with less feature work and more grooming. Six to eight weeks of deliberate consolidation would produce something genuinely special.
