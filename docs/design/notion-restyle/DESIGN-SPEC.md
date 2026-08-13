# Myrlin Workbook / Notion Restyle: DESIGN SPEC

Extracted from the imported design project. This document is the single source of truth for what the
redesigned UI looks like, region by region, with exact values. It is written so an implementer who has
never opened the mocks can build from it.

**Sources (all read-only, do not edit):**

| Role | Path |
|---|---|
| Primary mock (desktop, 1619 lines) | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/Myrlin Workbook (Notion Redesign) v2.dc.html` |
| Mobile mock (218 lines) | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/Myrlin Workbook Mobile (Notion Redesign).dc.html` |
| Parity map (designer's own intent) | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/Feature Inventory.md` |
| Brand truth / rejection rules | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/_ds/readme.md` |
| Primitives + editor grid + fonts | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/_ds/styles.css` |
| Component paint layer (`nt-*`) | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/_ds/components/components.css` |
| Color tokens | `.../_ds/tokens/colors.css` |
| Type tokens | `.../_ds/tokens/typography.css` |
| Spacing, radii, geometry | `.../_ds/tokens/spacing.css` |
| Shadows, focus rings | `.../_ds/tokens/effects.css` |
| Durations, easings, keyframes | `.../_ds/tokens/motion.css` |

**How the mock is written.** It is a `dc-runtime` prototype: an HTML template with `{{ binding }}`
placeholders, `<sc-if>` / `<sc-for>` control tags, and a `<script type="text/x-dc" data-dc-script>`
block at the end holding a `class Component extends DCLogic` with the data model and all computed
values. Structure and literal CSS live in the template; every color decision that varies by state is
computed in `renderVals()`. Both halves are normative. The `hint-placeholder-count` and
`hint-placeholder-val` attributes are authoring hints for the prototype tool and carry no design
meaning.

**Note on quoted copy.** Every user-facing string in this document is wrapped in backticks and is a
verbatim reproduction of the mock's own copy. A few of those strings contain an em dash, because the
mock's copy does. Reproduce them character for character; the em dashes belong to the product copy, not
to this document's prose.

**Critical reading note.** The mock hand-rolls most surfaces with inline styles rather than using the
`nt-*` component classes, even where a matching class exists. It uses `nt-*` classes for exactly nine
things: `nt-enable-hover`, `nt-btn` / `nt-btn-app` / `nt-btn-app-secondary`, `nt-chip` and its hue and
status variants, `nt-chip-dot`, `nt-avatar` and its hue variants, `nt-menu` and its parts, `nt-table`,
`nt-board` and its parts, `nt-switch` / `nt-switch-knob`, `nt-toast` / `nt-toast-label`. Everywhere
else the inline values are the spec. Where an inline value differs from the design system primitive,
this document flags it and states which one wins.

---

## 1. Foundations

### 1.1 The surface switch and the theme switch

Two independent attributes on `<html>`, both set imperatively by the mock:

```js
// mock, componentDidMount()
document.documentElement.dataset.surface = 'app';   // -> <html data-surface="app">
// mock, _applyTheme()
document.documentElement.dataset.theme = this._theme();  // 'light' | 'dark'
```

`data-surface="app"` is mandatory and permanent for the Workbook. It is what flips `--font-body` to the
OS stack, `--brand` to `#2383e2`, the ground to `#ffffff`, the ink to `#2c2c2b`, and the hover wash to
`rgba(55,53,47,.04)`. Without it the page silently inherits the Notion **marketing** palette, which is
the wrong blue, the wrong gray temperature, and loads Inter into the body. `_ds/styles.css` lines 20 to
24 call this out as "the one rule people break first". The Workbook is an app surface. It is never a
marketing surface.

`data-theme` is `light` or `dark`. Light is the bare `:root` default. Dark is applied three ways, all
already wired in `_ds/tokens/colors.css`:

- `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }` (lines 644 to 734)
- `:root[data-theme="dark"]` (line 736 onward)
- subtree classes `.app-theme-dark` / `.app-theme-light` for forcing a region (line 828 onward)

The mock always writes an explicit `data-theme`, so the system-preference branch never fires in the
prototype. Keep the explicit attribute in the real app (the app already has a theme setting), and keep
the media-query branch as the default for a first paint before the setting is read.

`_ds/tokens/colors.css` lines 990 to 1038 exist specifically so that `data-surface="app"` still wins in
dark mode. Do not delete them or a dark page picks up the marketing dark palette.

### 1.2 Color vocabulary, app surface (all values from `_ds/tokens/colors.css`)

**Neutral core.**

| Token | Light | Dark | Used for in the mock |
|---|---|---|---|
| `--app-bg-primary` | `#ffffff` | `#191919` | app ground, pane body, peek ground, mobile screen ground, inputs inside dialogs |
| `--app-bg-secondary` | `#f9f8f7` | `#202020` | sidebar, settings left nav, the info panel in the New agent task dialog, mobile key toolbar and input row |
| `--app-bg-tertiary` | `#f0efed` | `#383836` | progress-bar tracks, mobile active pane chip, mobile page ground behind device frames |
| `--app-bg-elevated` | `#ffffff` | `#202020` | every popover, modal, menu, board card |
| `--app-bg-interactive` | `#f4f3f3` | `#262626` | `nt-btn-app-secondary` hover |
| `--app-bg-accent-primary` | `#2c2c2b` | `#f0efed` | toast fill, tooltip fill |
| `--app-text-primary` | `#2c2c2b` | `#f0efed` | body ink, active row ink |
| `--app-text-secondary` | `#7d7a75` | `#ada9a3` | inactive rows, labels, descriptions, icon buttons |
| `--app-text-tertiary` | `#a19e99` | `#7d7a75` | counts, timestamps, hints, placeholders |
| `--app-text-inverse-primary` | `#f0efed` | `#191919` | toast label |
| `--app-border-primary` | `#e6e5e3` | `#383836` | sidebar right edge, pane border, card borders, input borders, peek left edge |
| `--app-border-secondary` | `#f0efed` | `#2c2c2b` | every internal hairline: topbar bottom, tab bar bottom, pane header bottom, settings row rules, popover dividers |
| `--app-border-strong` | `#d4d3cf` | `#5f5e59` | drop-slot dashed border at rest, scrollbar thumb |
| `--app-ui-blue` | `#2383e2` | `#2383e2` | focus ring, inline-rename input border, checkbox `accent-color`, `nt-btn-app` hover, switch on-state |
| `--app-accent-blue` | `#2783de` | `#2783de` | `nt-btn-app` rest fill (note: not the same blue as `--app-ui-blue`) |
| `--app-sidebar-item-selected` | `rgba(0,0,0,0.03)` | `rgba(255,255,255,0.055)` | **every selected state in the app** (see 6.1) |
| `--app-sidebar-section-label` | `#91918e` | `#9b9b9b` | all section labels |
| `--app-wash-hover` | `rgba(55,53,47,0.04)` | `rgba(255,255,255,0.055)` | every hover |
| `--app-wash-press` | `rgba(55,53,47,0.10)` | `rgba(255,255,255,0.13)` | every press |
| `--app-wash-table-row-hover` | `rgba(55,53,47,0.024)` | `rgba(255,255,255,0.055)` | table row hover only, the faintest wash in the system |
| `--app-table-cell-border` | `rgba(42,28,0,0.07)` | (unchanged) | `nt-table` cell hairlines |
| `--app-divider` | `rgba(28,19,1,0.11)` | (unchanged) | `nt-menu-sep` |
| `--app-selection-token` | `rgba(35,131,226,0.14)` | (unchanged) | text selection |
| `--app-code-block-bg` | `#f5f2f0` | (unchanged) | mobile terminal ground in light |

**Named block palette, text.** Theme invariant. There is no dark override for any of these, and
recoloring them in dark mode is on the rejection list (`_ds/tokens/colors.css` line 489).

`--app-text-gray #7d7a75`, `--app-text-brown #9f765a`, `--app-text-orange #d27b2d`,
`--app-text-yellow #cb9434`, `--app-text-green #50946e`, `--app-text-blue #387dc9`,
`--app-text-purple #9a6bb4`, `--app-text-pink #c14c8a`, `--app-text-red #cf5148`,
`--app-text-teal #2c8b9e`.

**Named block palette, background.** These do flip. Light / dark:
gray `#f0efed` / `#383836`, brown `#f5ede9` / `#45362d`, orange `#fbebde` / `#53361f`,
yellow `#f9f3dc` / `#504425`, green `#e8f1ec` / `#263d30`, blue `#e5f2fc` / `#233850`,
purple `#f3ebf9` / `#3c2d47`, pink `#fae9f1` / `#4e2b3c`, red `#fce9e7` / `#502c29`,
teal `#e0f3f7` / `#143d45`.

**Property chip palette.** A separate, denser system. The fill is a translucent hue wash
(`--app-chip-<hue>-fill`, for example blue light `rgba(0,118,217,0.204)`, blue dark
`rgba(81,166,255,0.494)`) and the ink is a deep tinted hue (`--app-chip-<hue>-ink`, blue light
`#264a72`, blue dark `#e5f2fc`). Because the fill is translucent a chip composites correctly on white,
on a hovered row, and inside a colored panel with no extra rules. Never build a chip out of the block
palette and never build a callout out of the chip palette.

### 1.3 Type

Font stack, ship verbatim (`_ds/tokens/typography.css` lines 41 to 44):

```
--font-app-ui: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display",
  "Segoe UI", Helvetica, "Apple Color Emoji", "Noto Sans Arabic", "Noto Sans Hebrew", Arial,
  sans-serif, "Segoe UI Emoji", "Segoe UI Symbol";
--font-mono: "iA Writer Mono", Nitti, Menlo, Courier, monospace;
```

No webfont in the body. `"Segoe UI Variable Display"` before `"Segoe UI"` is what makes Windows 11
correct, and `ui-sans-serif` first is what makes macOS pick SF. Loading Inter into an app-surface body
is instantly wrong. iA Writer Mono S is shipped under SIL OFL 1.1 at
`_ds/assets/fonts/iAWriterMonoS-*.woff2` (Regular, Italic, Bold, BoldItalic) and the `@font-face`
blocks are already in `_ds/styles.css` lines 65 to 95.

Sizes actually used by the mock. The mock does **not** use the editor document scale (40 / 30 / 24 /
20 / 18 / 16 body). It uses a compressed application scale, because it is chrome, not a document:

| Role | Size | Weight | Where |
|---|---|---|---|
| Shell base | 14px / 1.5 | 400 | root container of the mock |
| View title (`h1`) | 30px, `letter-spacing: -0.01em` | 700 | Sessions, Costs, Agent tasks |
| Peek title (`h2`) | 22px, `-0.01em` | 700 | side peek |
| Cost stat value | 26px, `-0.01em`, tabular-nums | 700 | cost cards |
| Dialog title (`h3`) | 16px | 600 | New session, New agent task, Settings |
| Diff modal title | 15px | 600 | diff viewer |
| Popover title | 14px | 600 | account, attention |
| Quick Find input | 15px | 400 | search field |
| Sidebar workspace name, nav rows, form inputs, setting titles | 14px | 600 / 500 | see regions |
| Sidebar session rows, pane title, table rows, pill tabs, menu rows | 13px | 500 / 600 active | see regions |
| Section labels, counts, meta, descriptions, chips | 12px | 500 / 400 | see regions |
| Shortcut hints, badges, branch names, stats | 11px | 400 / 600 / 700 | see regions |
| Terminal body | 12.5px / 1.7 desktop, 12px / 1.7 mobile | 400 mono | pane, mobile terminal |
| Peek "Last output" and diff hunks | 12px / 1.65 and 12px / 1.7 | 400 mono | peek, diff |

`nt-chip` and `nt-table` pull 14px from `--app-chip-size` and `--app-property-size`. Numeric columns
(cost, totals) carry `font-variant-numeric: tabular-nums`.

### 1.4 Radii

From `_ds/tokens/spacing.css` lines 96 to 106. Chips are 4px while cards and callouts are 10px, and
matching them up is on the rejection list because it reads as a generic design system.

| Token | Value | Applied to |
|---|---|---|
| `--radius-property-chip` | `4px` | `nt-chip` |
| `--radius-status-chip` | `10px` | `nt-chip-status` |
| `--radius-app-button` | `6px` | `nt-btn-app`, `nt-btn-app-secondary`, `nt-menu`, toast |
| `--radius-4` | `4px` | icon buttons, breadcrumb items, menu items, inline rename input |
| `--radius-block-hover` | `6px` | every hoverable row (sidebar, nav, pill tab, popover row, menu row) |
| `--radius-callout` | `10px` | popovers, modals, dialogs, the diff viewer, settings |
| `--radius-collection-card` | `10px` | `nt-board-card` |
| `--radius-page-icon` | `4px` | sidebar workspace emoji tile |
| `--radius-avatar` | `100%` | `nt-avatar` |
| `--radius-round` | `624.9375rem` | `nt-switch`, account chip (mock writes `999px`) |

Mock-local radii not in the token file: pane frame `8px`, cost card `8px`, drop slot `8px`, board column
`8px`, peek "Last output" block `6px`, board card live-output line `4px`, diff file-kind badge `3px`,
terminal theme swatch `3px`, progress-bar track and fill `3px`, attention badge `9px` (a 18px pill),
mobile cards and inputs `8px`, mobile device frame `24px`.

### 1.5 Depth

The canvas has zero depth. All depth lives in overlays. Anything at 10 percent black or above, anything
with a hue in it, any glass nav, any gradient and any grain overlay is on the rejection list
(`_ds/tokens/effects.css` lines 20 to 21).

Shadows the mock actually uses, written inline rather than by token:

| Surface | Value |
|---|---|
| Account popover, attention popover | `0 8px 30px rgba(0,0,0,0.18)` |
| Quick Find, all dialogs, diff viewer, settings | `0 16px 50px rgba(0,0,0,0.25)` |
| Mobile device frame (presentation only) | `0 8px 30px rgba(0,0,0,0.08)` |
| Focused pane | `inset 0 0 0 2px var(--app-ui-blue, #2383e2)` |

Token equivalents, preferred for the real build because they carry dark-mode variants
(`_ds/tokens/effects.css`): `--app-shadow-menu` for popovers and menus,
`--app-shadow-scrim` for modals, `--app-shadow-outlined-sm` for board cards (already applied by
`.nt-board-card`), `--app-shadow-lg` for the toast (already applied by `.nt-toast`),
`--app-shadow-button` for `nt-btn-app-secondary` (already applied).

Focus rings, verbatim from `_ds/tokens/effects.css` lines 237 to 245:
`--app-focus-shadow: rgba(35,131,226,0.57) 0 0 0 1px inset, rgba(35,131,226,0.35) 0 0 0 2px`,
`--app-input-focus-ring: 0 0 0 1px #2383e2 inset, 0 0 0 1px #2383e2`,
`--app-input-error-ring: 0 0 0 1px #cd3c3a inset, 0 0 0 1px #cd3c3a`.

The scrollbar treatment is mock-local and applies everywhere:

```css
::-webkit-scrollbar { width: 7px; height: 7px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--app-border-strong, #cfccc8); border-radius: 4px;
  border: 1px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: var(--app-text-tertiary, #a19e99); }
::-webkit-scrollbar-corner { background: transparent; }
* { scrollbar-width: thin; }
```

### 1.6 Motion

Three rules decide almost everything (`_ds/tokens/motion.css` lines 7 to 15): fade in is faster than
fade out (150ms in, 200ms out); nothing animates on scroll; loading is a shimmer, never a spinner.
Everything user-triggered stays under 300ms.

Durations: `--duration-instant 20ms` (hover reveal), `--duration-100 100ms`, `--duration-150 150ms`,
`--duration-200 200ms`, `--duration-250 250ms`, `--duration-300 300ms`.
Easings: `--ease-out cubic-bezier(0,0,0.58,1)`, `--ease-in cubic-bezier(0.42,0,1,1)`,
`--ease-strong-out cubic-bezier(0.32,0.72,0,1)`.
Composites: `--motion-hover-reveal: background var(--duration-instant) ease-in`,
`--motion-hover-opacity: opacity var(--duration-100)`,
`--motion-menu-open: var(--duration-150) ease-in nt-fadein`,
`--motion-focus: box-shadow var(--duration-150) var(--ease-out)`,
`--motion-sidebar: width var(--duration-200)`.

The mock defines two local keyframes and uses nothing else:

```css
@keyframes mwPulse   { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
@keyframes mwFadein  { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
```

- `mwPulse 2s ease-in-out infinite` on every live status dot: sidebar session dots and the project
  running-count dot when status is `running` or `needs-input`, pane header dots, attention row dots,
  the mobile attention banner dot, and the mobile terminal header dot.
- `mwPulse 1.4s ease-in-out infinite` on the microphone button while listening.
- `mwFadein 0.15s ease-out` on every overlay entrance: side peek, account popover, attention popover,
  context menu, Quick Find, New session, New agent task, diff viewer, settings.

`mwFadein` is the mock's spelling of the system's `nt-slide-up-small` (4px rise) inverted to a 4px
drop, at the captured 150ms menu-open duration. Use `--motion-menu-open` plus a 4px translate, or port
`mwFadein` verbatim. Either is faithful; do not increase the distance beyond 4px, and do not add a
scale.

Reduced motion: copy both halves of `_ds/tokens/motion.css` lines 235 to 267. `reduce` zeroes
functional animation. `no-preference` is the gate for anything decorative. In this app the pulsing
status dots are functional signal, not decoration, but they must still drop to a static full-opacity
dot under `prefers-reduced-motion: reduce`.

### 1.7 Hover gating

Put `nt-enable-hover` on the shell container. The mock does this on its root div. Every hover rule in
the design system is written as `.nt-enable-hover .thing:hover`, which mirrors Notion's own
`.notion-enable-hover`. Notion strips the class during scroll and drag so hover states never flash
under a moving pointer, and the real build should reproduce that: remove the class on `scroll` and on
`dragstart`, restore it after a short idle.

---

## 2. Shell layout

```
<div class="nt-enable-hover" style="display:flex; width:100vw; height:100vh; overflow:hidden;
     background: var(--app-bg-primary); color: var(--app-text-primary);
     font-family: var(--font-app-ui, ui-sans-serif); font-size:14px; line-height:1.5;
     position: relative;">
  <aside>            sidebar, width bound to state, flex-shrink 0
  <div flex:1>       main column
     <topbar 44px>
     <view: workbench | sessions | costs | tasks>
  </div>
  <peek?>            side peek, a flex sibling, not an overlay
  <overlays...>      popovers, menus, modals, toast (position: fixed)
</div>
```

The peek is a **layout sibling**, not a floating panel. Opening it narrows the main column rather than
covering it. This is a deliberate departure from the design system's `.nt-peek`
(`components.css` line 705), which is `position: absolute; right: 0` with a scrim shadow. Follow the
mock: sibling, no shadow, a single `border-left: 1px solid var(--app-border-primary)`.

The Notion 720px editor grid (`.nt-layout` in `_ds/styles.css`) is **not used** by this design. The
Workbook is an app shell, not a document. Document views instead use a centered measure: 1100px for
Sessions and Costs, 1240px for Agent tasks, both with `padding: 28px 48px 60px`.

Keyboard map, from the mock's `componentDidMount()`:

| Keys | Action |
|---|---|
| `Cmd/Ctrl + K` or `Cmd/Ctrl + P` | open Quick Find (and close attention, settings, context menu) |
| `Cmd/Ctrl + ,` | open Settings |
| `Cmd/Ctrl + Shift + N` | open New agent task |
| `Cmd/Ctrl + 1..4` | switch to Workbench and focus pane N |
| `Escape` | close every overlay, the peek, the context menu, and cancel an inline rename |

---

## 3. Region: sidebar

Container: `<aside>` at `width: {{ sidebarW }}px; min-width: 200px; max-width: 420px;
display:flex; flex-direction:column; background: var(--app-bg-secondary);
border-right: 1px solid var(--app-border-primary); overflow:hidden; flex-shrink:0;`
Initial `sidebarW` is `244`. The drag clamps to 200 to 420.

The design system's own sidebar edge is an inset hairline, `--app-sidebar-edge:
rgb(240,239,237) -1px 0 0 0 inset` (`_ds/tokens/effects.css` line 134), not a border, because a border
shifts layout by 1px. The mock uses a plain `border-right`. Either is acceptable; if you use the token,
remember it is `--app-border-secondary` colored, one step lighter than the mock's choice. Note the
sidebar ground is `#f9f8f7`, **warmer** than the white canvas, not darker and not a different hue. A
gray or dark sidebar is on the rejection list (`_ds/tokens/colors.css` line 420).

### 3.1 Workspace header

`margin: 8px 8px 2px; padding: 5px 8px; border-radius: 6px; gap: 8px; cursor: pointer;` hover
`background: var(--app-wash-hover)`.

- Emoji tile: `display:grid; place-items:center; width:22px; height:22px; border-radius:4px;
  background: var(--app-bg-purple); font-size:13px; flex-shrink:0;` content `🎩`.
- Name: `flex:1; font-weight:600; font-size:14px;` ellipsized. Content `Myrlin's Workbook`.
- Chevron: 12px inline SVG, `color: var(--app-text-secondary)`, path `M3.5 6L8 10.5 12.5 6`.

### 3.2 Utility rows (Search, Attention, Settings)

Wrapper `padding: 2px 8px 6px`. Each row:
`display:flex; align-items:center; gap:8px; padding:4px 8px; min-height:27px; border-radius:6px;
cursor:pointer; color: var(--app-text-secondary); font-weight:500;` hover `var(--app-wash-hover)`.
Icon 16px, label `flex:1`, trailing hint `font-size:11px; color: var(--app-text-tertiary)`.

- Search: hint `⌘K`. Opens Quick Find.
- Attention: no hint; instead a count badge when non-zero, and the row itself takes
  `background: var(--app-sidebar-item-selected)` while the popover is open.
  Badge: `display:grid; place-items:center; min-width:18px; height:18px; padding:0 5px;
  border-radius:9px; background: var(--app-bg-red); color: var(--app-text-red);
  font-size:11px; font-weight:600;`
- Settings: hint `⌘,`.

`min-height: 27px` is the design system's `--app-sidebar-item-height`, an inferred value
(`_ds/tokens/spacing.css` line 380). Keep it.

### 3.3 Workbook nav section

Wrapper `padding: 6px 8px 2px`. Section label:
`padding:4px 8px; font-size:12px; font-weight:500; color: var(--app-sidebar-section-label);` text
`Workbook`.

Four rows, same 27px geometry as 3.2, each with a 16px icon, a `flex:1` label, and a right-aligned
count at `font-size:12px; color: var(--app-text-tertiary)`:

| Row | Icon key | Count |
|---|---|---|
| Workbench | `code` | panes in the active tab group |
| Sessions | `database` | visible session count |
| Agent tasks | `todo` | tasks whose status is not `done` |
| Costs | `clock` | empty string |

Active row: `background: var(--app-sidebar-item-selected); color: var(--app-text-primary);
font-weight: 600;`. Inactive: `background: transparent; color: var(--app-text-secondary);
font-weight: 500;`. **There is no left border, no bar, no underline.** This is the single most
important idiom in the whole restyle.

### 3.4 Projects tree

Scroll region: `flex:1; overflow-y:auto; overflow-x:hidden; padding: 8px 8px 4px; min-height:0;`.
Section label `Projects`, same style as 3.3.

Project row: same 27px row geometry, `color: var(--app-text-secondary); font-weight:500`. Contents in
order: emoji tile (`display:grid; place-items:center; width:18px; height:18px; font-size:14px`),
name (`flex:1`, ellipsized), optional running indicator, total count.

Running indicator, shown only when the project has at least one `running` or `needs-input` session:
`display:inline-flex; align-items:center; gap:4px; font-size:11px; color: var(--app-text-green);`
containing a `6px` circle in `var(--app-text-green)` with `mwPulse 2s ease-in-out infinite`, then the
number.

Drag-over state (a session dragged onto a project, which moves it):
`background: var(--app-bg-blue); outline: 1px solid var(--app-text-blue); outline-offset: -1px;`.
Note the outline with a negative offset rather than a border, so nothing reflows.

Session child rows, wrapped in `padding-left: 14px`:
`display:flex; align-items:center; gap:8px; padding:3px 8px; min-height:26px; border-radius:6px;`
hover `var(--app-wash-hover)`. Contents: a `7px` status dot (pulsing when live), the title at
`font-size:13px` ellipsized, and the relative time at `font-size:11px; color: var(--app-text-tertiary)`.
Selected (its peek is open): `background: var(--app-sidebar-item-selected)`. Hidden session:
`opacity: 0.5`.

Inline rename, triggered by double click, replaces the title span with:
`border: 1px solid var(--app-ui-blue, #2383e2); border-radius:4px; padding:1px 5px; font-size:13px;
font-family: inherit; background: var(--app-bg-primary); color: var(--app-text-primary); outline:none;`
Enter commits, Escape cancels, blur commits.

Status dot colors, from `_dot(status)` in the mock:

| Status | Dot |
|---|---|
| running | `var(--app-text-green)` |
| needs-input | `var(--app-text-yellow)` |
| idle | `var(--app-text-blue)` |
| failed | `var(--app-text-red)` |
| complete | `var(--app-text-teal)` |
| stale | `var(--app-text-brown)` |
| stopped (default) | `var(--app-text-gray)` |

### 3.5 Hidden toggle and Discovered section

Hidden toggle row: `padding:3px 8px; border-radius:6px; color: var(--app-text-tertiary);
font-size:12px;` with a 14px eye icon; hover raises the ink to `var(--app-text-secondary)` plus the
hover wash. Label is `Show hidden (n)` or `Hide hidden sessions`.

Discovered label: `padding: 14px 8px 4px` (note the larger top pad, which is the only vertical section
separation in the sidebar), text `Discovered on this machine`. Rows use the 27px geometry with a 16px
page icon tinted `var(--app-text-tertiary)`, a 13px name, and a 12px tertiary count.

### 3.6 Footer

`padding: 8px; border-top: 1px solid var(--app-border-secondary);` with two rows at
`padding: 5px 8px; border-radius:6px; gap:8px; color: var(--app-text-secondary); font-weight:500`:
`New session` (plus icon) and `New agent task` (checklist icon) with hint `⌘⇧N`.

### 3.7 Resize handle

`position:absolute; top:0; right:0; bottom:0; width:5px; cursor:col-resize; z-index:30;`
hover `background: rgba(35,131,226,0.28)`. Title attribute `Drag to resize the sidebar`. On mousedown
it sets `document.body.style.cursor = 'col-resize'` and `userSelect = 'none'` for the duration.

---

## 4. Region: topbar

`display:flex; align-items:center; height:44px; min-height:44px; padding: 0 12px; gap:8px;
border-bottom: 1px solid var(--app-border-secondary);`

44px is `--app-topbar-height`. The topbar has **no background of its own** and no shadow at rest.

**Breadcrumb** (left, `flex: 0 1 auto`, `overflow:hidden`): `display:flex; gap:2px; font-size:14px;
color: var(--app-text-secondary);`. Each crumb `padding:3px 6px; border-radius:4px; cursor:pointer`
with hover wash and ellipsis; the separator is a literal `/` at `color: var(--app-text-tertiary)`; the
leaf crumb takes `color: var(--app-text-primary)`. Leaf text by view:
`Workbench · {group label}`, `Sessions`, `Agent tasks`, `Costs`.

**Spacer**: `flex:1; min-width:8px`.

**Account chip**: `display:inline-flex; align-items:center; gap:6px; padding:2px 8px 2px 3px;
border-radius:999px; border:1px solid var(--app-border-primary); cursor:pointer; font-size:12px;
color: var(--app-text-secondary); flex:none; white-space:nowrap;` hover wash. It contains
`<span class="nt-avatar nt-avatar-sm nt-avatar-purple" style="width:18px; height:18px; font-size:10px">G</span>`
then the text `Gayane · 42%`. `title` is `Account usage & switching`. This is the only pill-shaped
bordered control in the desktop chrome.

**Icon buttons**: theme toggle (sun icon, `title="Toggle light / dark"`) and a More button (three-dot
icon). Both: `display:grid; place-items:center; width:28px; height:28px; border:none;
border-radius:4px; background:transparent; color: var(--app-text-secondary); cursor:pointer;` hover
wash. 28px is `--app-icon-button-size`.

The mock's More button has no menu wired. Treat it as the entry point for whatever overflow the real
app needs.

---

## 5. Region: workbench

### 5.1 Tab pill bar

`display:flex; align-items:center; padding: 0 16px;
border-bottom: 1px solid var(--app-border-secondary);`
Left cluster `display:flex; gap:2px; padding: 8px 0;`.

Each tab group is a **pill with a positional dot**:

```
display:inline-flex; align-items:center; gap:7px; padding:4px 10px; border:none;
border-radius:6px; cursor:pointer; font-family:inherit; font-size:13px;
font-weight: {600 active | 500 inactive};
background: {var(--app-sidebar-item-selected) active | transparent};
color: {var(--app-text-primary) active | var(--app-text-secondary)};
white-space:nowrap;   hover: var(--app-wash-hover)
```

Inside: a `7px` circle whose color comes from the **position in the list, not from the content**:

```js
['var(--app-text-red)', 'var(--app-text-yellow)', 'var(--app-text-green)',
 'var(--app-text-teal)', 'var(--app-text-blue)', 'var(--app-text-purple)'][i % 6]
```

This is the `instance-colors` order carried over from the original app. Then the label, then the pane
count at `font-size:12px; color: var(--app-text-tertiary); font-weight:400`.

Tabs are `draggable` and reorder by drop. Right click opens the group context menu (rename, duplicate,
separator, close group as a danger item).

`+ new group` button: `display:grid; place-items:center; width:26px; height:26px; border:none;
border-radius:6px; background:transparent; color: var(--app-text-tertiary);` hover raises to
`var(--app-text-secondary)` plus the wash. Icon 14px plus glyph.

Right side of the bar: a hint `⌘1–4 focuses a pane` at `font-size:12px;
color: var(--app-text-tertiary); margin-right:10px`, then `<button class="nt-btn nt-btn-app">New
session</button>`.

**Do not use `.nt-tabs` / `.nt-tab`** here. That component (`components.css` line 1005) paints an
underlined text tab, which is exactly the one-side accent idiom this redesign replaces. The pill is
correct.

### 5.2 Pane grid

```
position:relative; flex:1; min-height:0; display:grid;
grid-template-columns: {{ paneGridCols }}; grid-auto-rows: 1fr; gap:12px;
padding: 12px 16px 16px; background: var(--app-bg-primary);
```

`paneGridCols` resolves as: exactly two items gives `${splitPct}fr ${100-splitPct}fr` (default 50/50,
clamped 25 to 75); more than two gives `1fr 1fr` (so three or four panes make a 2x2); one item gives
`1fr`. Item count includes the drop slot, which appears whenever the group has fewer than two panes.

Splitter, only when the item count is exactly two:
`position:absolute; top:12px; bottom:16px; left: calc(16px + (100% - 44px) * pct + 6px); width:12px;
transform: translateX(-50%); cursor:col-resize; z-index:20; border-radius:6px;` hover
`background: rgba(35,131,226,0.18)`. Title `Drag to resize panes`.

Drop slot (empty state for the grid):
`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px;
min-height:120px; border: 1.5px dashed var(--app-border-strong); border-radius:8px;
color: var(--app-text-tertiary); cursor:pointer; background: transparent;`
with a 20px plus glyph and the copy `Drag a session here, or click for a new one` at 13px. While a
session is dragged over it the border becomes `var(--app-text-blue)` and the fill becomes
`var(--app-bg-blue)`. Clicking it opens the New session dialog.

### 5.3 Pane frame

```
display:flex; flex-direction:column; min-height:0; min-width:0;
border: 1px solid {{ pane.borderColor }}; border-radius:8px; overflow:hidden;
background: var(--app-bg-primary); box-shadow: {{ pane.focusRing }};
```

`borderColor` precedence:
1. drag-over: `var(--app-text-blue)`
2. pane color highlights on (a settings toggle, default on):
   `color-mix(in srgb, {paneColor} 35%, var(--app-border-primary))`
   where `paneColors = ['var(--app-text-purple)','var(--app-text-blue)','var(--app-text-green)','var(--app-text-orange)']`
   indexed by slot
3. otherwise `var(--app-border-primary)`

The 35 percent mix is the whole point: the slot color is a **tint of the hairline**, never a saturated
frame. `focusRing` is `inset 0 0 0 2px var(--app-ui-blue, #2383e2)` on the focused pane and `none`
otherwise.

### 5.4 Pane header

```
display:flex; align-items:center; gap:8px; height:38px; min-height:38px;
padding: 0 8px 0 12px; border-bottom: 1px solid var(--app-border-secondary);
```

In order:

1. Status dot: `7px` circle, `background: {{ pane.dotColor }}`, `mwPulse 2s ease-in-out infinite` when
   running or needs-input, `flex-shrink:0`.
2. Title: `font-weight:600; font-size:13px; padding:2px 4px; border-radius:4px; min-width:24px;
   flex-shrink:1; cursor:pointer;` ellipsized, hover wash. Single click opens the peek, double click
   starts an inline rename.
3. Provider chip: `<span class="nt-chip nt-chip-purple">Claude</span>` or
   `<span class="nt-chip nt-chip-green">Codex</span>`, `flex-shrink:0`.
4. Needs-input chip, when applicable:
   `<span class="nt-chip nt-chip-status nt-chip-yellow"><span class="nt-chip-dot"></span>Needs input</span>`.
5. Activity text: `font-size:12px; color: var(--app-text-tertiary);` ellipsized, `flex-shrink:4` so it
   is the first thing to give way.
6. Spacer `flex:1; min-width:0`.
7. Copy transcript button, pane menu button, close button. All three:
   `display:grid; place-items:center; width:26px; height:26px; flex-shrink:0; border:none;
   border-radius:4px; background:transparent; color: var(--app-text-secondary); cursor:pointer;`
   hover wash, 15px icons.

**Progressive chrome shedding.** This is a designed behavior, computed in the mock:

```js
const narrowPanes = itemsCount > 1;
showActivity        = !needsInput && !!activity && !narrowPanes;
showProviderChip    = !(narrowPanes && needsInput);
showInlineButtons   = !(narrowPanes && needsInput);   // the copy button
```

In plain terms: activity text only survives in a single-pane layout; when a pane is narrow and needs
input, the needs-input chip is the only thing that survives besides the dot, the title, the menu and
the close button. Implement this as a real width-driven rule (container queries or a measured class),
not as a guess.

### 5.5 Terminal surface

```
flex:1; overflow-y:auto; padding: 12px 14px;
background: {{ termBg }};
font-family: var(--font-mono, 'iA Writer Mono', ui-monospace, monospace);
font-size: 12.5px; line-height: 1.7; color: {{ termInk }};
```

Each line: `margin-bottom: {{ ln.mb }}; padding-left: {{ ln.pad }}; color: {{ ln.color }};
white-space: pre-wrap;`. The mock's sample transcripts show the intended rhythm: `0` / `2px` / `8px` /
`10px` bottom margins to group related output, and `0` / `16px` / `28px` left pads for tool-result
indentation. Two colors are hard-coded in the sample data and are meaningful:
`#cb9434` (block-palette yellow) for held or approval-requested lines, and `#9a6bb4` (block-palette
purple) for the mode line `▶▶ accept edits on (shift+tab to cycle)`. Everything else is `termInk` for
primary output or `termDim` for compaction, timing, and tool-result lines.

`termBg`, `termInk`, `termDim`, `termRule` all come from the selected terminal palette, never from the
Notion tokens. See section 10.

### 5.6 Pane input row

```
display:flex; align-items:center; gap:8px; padding: 8px 12px;
border-top: 1px solid {{ termRule }}; background: {{ termBg }};
```

- Prompt: a literal `❯` at `color: {{ pane.promptColor }}` which is the terminal palette's `accent`,
  `font-family: var(--font-mono, ui-monospace, monospace); font-size:13px`.
- Input: `flex:1; border:none; outline:none; background:transparent; color: {{ termInk }};
  font-family: mono; font-size:12.5px;` placeholder `Message Claude…` (provider-interpolated) or
  `Listening…` while the mic is active.
- Attach image button and mic button: both 26px, `border-radius:4px`, transparent, 15px icons. The mic
  while listening takes `background: var(--app-bg-red); color: var(--app-text-red);
  animation: mwPulse 1.4s ease-in-out infinite`.
- Hint: `⏎ send` at `font-size:11px; color: var(--app-text-tertiary); white-space:nowrap`.

The input row sits **inside the terminal palette**, not on the Notion ground. Its top rule is the
palette's `rule` color, not `--app-border-secondary`. This is what makes a pane read as one continuous
terminal object.

---

## 6. Region: sessions view

Scroll container `flex:1; min-height:0; overflow-y:auto`, inner page
`max-width:1100px; margin: 0 auto; padding: 28px 48px 60px`.

**Page header.** `display:flex; align-items:center; gap:10px; padding: 4px 0 2px` with a `28px` emoji
(`📓`) and `<h1 style="margin:0; font-size:30px; font-weight:700; letter-spacing:-0.01em">Sessions</h1>`.
Then a lede paragraph: `margin: 4px 0 14px; color: var(--app-text-secondary); font-size:14px`, text
`Every conversation across every provider on this machine. Right-click a row for actions; drag one onto the Workbench.`

**Filter bar.** `display:flex; align-items:center; border-bottom: 1px solid var(--app-border-secondary);
margin-bottom:2px;` with a pill cluster at `gap:2px; padding: 6px 0`. Each filter pill:
`padding:4px 10px; border:none; border-radius:6px; font-size:13px;` with the same active recipe as the
tab pills (`--app-sidebar-item-selected` fill, primary ink, weight 600) and a trailing count at
`font-size:12px; color: var(--app-text-tertiary); font-weight:400`. Filters are `All`, `Running`,
`Needs input`, `Stopped`. On the right, `<button class="nt-btn nt-btn-app">New</button>`.

Filter predicates from the mock: `all` excludes hidden; `running` is `running` or `needs-input` and not
hidden; `needs-input` is exactly that status; `stopped` is any of `stopped, idle, complete, failed,
stale` and not hidden.

**Table.** `<table class="nt-table" style="width:100%">`. The class supplies
(`components.css` lines 1056 to 1081): `border-collapse: collapse; font-size:14px; line-height:21px;`
cells `padding: 0 8px` with `border-bottom` and `border-right` in `var(--app-table-cell-border)`
(`rgba(42,28,0,0.07)`), last column drops the right border, header row height `36px` with
`color: var(--app-text-secondary); font-weight:400`, body rows height `32px`, row hover
`var(--app-wash-table-row-hover)` which is `rgba(55,53,47,0.024)`, the faintest wash in the system.

Columns: `Name` (width 30 percent), `Project`, `Provider`, `Status`, `Model`, `Cost` (right aligned),
`Last active` (right aligned).

Cell contents:

- Name: `display:flex; align-items:center; gap:8px; font-weight:500` with a `7px` status dot then the
  ellipsized title.
- Project: `display:inline-flex; gap:5px; color: var(--app-text-secondary); font-size:13px` with the
  project emoji then its name.
- Provider: `<span class="nt-chip nt-chip-purple|nt-chip-green">`.
- Status: `<span class="nt-chip nt-chip-status nt-chip-{hue}"><span class="nt-chip-dot"></span>{label}</span>`.
- Model: `color: var(--app-text-secondary); font-size:13px; white-space:nowrap`.
- Cost: `text-align:right; font-variant-numeric: tabular-nums; color: var(--app-text-secondary);
  font-size:13px`.
- Last active: `text-align:right; color: var(--app-text-tertiary); font-size:13px`, formatted
  `just now` or `{n} ago`.

Rows are `draggable` (drop onto a pane or the drop slot), left click opens the peek, right click opens
the session context menu, hidden rows render at `opacity: 0.55`.

Status chip mapping, from `_statusChip(status)`:

| Status | Label | Class |
|---|---|---|
| running | `Running` | `nt-chip-green` |
| needs-input | `Needs input` | `nt-chip-yellow` |
| idle | `Idle` | `nt-chip-blue` |
| failed | `Failed` | `nt-chip-red` |
| complete | `Complete` | `nt-chip-teal` |
| stale | `Stale` | `nt-chip-brown` |
| stopped (default) | `Stopped` | `nt-chip-gray` |

**Table footer row.** `display:flex; align-items:center; gap:6px; height:34px; padding: 0 8px;
color: var(--app-text-tertiary); font-size:14px; border-radius:4px;` hover wash, a 14px plus glyph and
the label `New session`. This is Notion's own "new row" affordance and it belongs directly under the
table with no separator.

### 6.1 The chip dot trap

`.nt-chip-dot` is `width:8px; height:8px; border-radius:50%; background: currentColor` and it therefore
inherits the **chip ink** (`--app-chip-yellow-ink`, a deep tinted hue), not the status dot color. The
standalone `7px` dots in rows, panes, and popovers use the **block palette text** color
(`--app-text-yellow`). Two different dots, two different sizes, two different color systems. Do not
unify them.

---

## 7. Region: session side peek

A flex sibling of the main column, `width: {{ peekW }}px; min-width:300px; max-width:46vw;
display:flex; flex-direction:column; border-left: 1px solid var(--app-border-primary);
background: var(--app-bg-primary); animation: mwFadein 0.15s ease-out; flex-shrink:0;`
Initial `peekW` is `420`; the drag clamps to 300 to 600.

Resize handle on its left edge: `position:absolute; top:0; left:-1px; bottom:0; width:5px;
cursor:col-resize; z-index:30;` hover `rgba(35,131,226,0.28)`.

**Header.** `display:flex; align-items:center; gap:4px; height:44px; min-height:44px; padding: 0 10px;
border-bottom: 1px solid var(--app-border-secondary);` A 28px close icon button, a `flex:1` spacer,
then `<button class="nt-btn nt-btn-app">Open in Workbench</button>`. The header mirrors the topbar
height exactly so the two read as one 44px band across the window.

**Body.** `flex:1; overflow-y:auto; padding: 20px 24px 32px`.

1. Title row: `display:flex; align-items:center; gap:8px` with a `9px` status dot (note: 9px here, not
   7px) and `<h2 style="margin:0; font-size:22px; font-weight:700; letter-spacing:-0.01em;
   overflow-wrap:anywhere">`.
2. Property grid: `display:grid; grid-template-columns: minmax(80px,110px) 1fr; gap: 2px 10px;
   margin-top:16px; font-size:13px`. Each label cell:
   `display:flex; align-items:center; gap:6px; color: var(--app-text-tertiary); min-height:30px;
   white-space:nowrap`. Each value cell: `display:flex; align-items:center; min-height:30px;
   color: var(--app-text-primary); overflow-wrap:break-word; min-width:0` with a per-property font.
   The eight properties, in order:

   | Label | Rendering |
   |---|---|
   | Status | status chip (`nt-chip nt-chip-status nt-chip-{hue}`) |
   | Project | text, `{emoji} {name}`, inherit font, 13px |
   | Provider | provider chip (`nt-chip-purple` or `nt-chip-green`) |
   | Model | text, inherit, 13px |
   | Directory | text, `var(--font-mono, ui-monospace, monospace)`, 12px |
   | Branch | text, mono, 12px |
   | Cost | text, `{cost} this session`, inherit, 13px |
   | Last active | text, `just now` or `{n} ago`, inherit, 13px |

   This is Notion's property-row idiom compressed. The design system ships `.nt-property-row` with a
   fixed `148px` label column (`components.css` line 1199); the peek narrows it to `minmax(80px,110px)`
   because the peek is narrower than a document. Follow the mock.
3. Divider: `height:1px; background: var(--app-border-secondary); margin: 16px 0 12px`.
4. Action row: `display:flex; gap:8px; flex-wrap:wrap` with
   `<button class="nt-btn nt-btn-app-secondary">` for `Copy transcript`, `Copy session ID`, then a
   conditional `Stop` (with an inline `color: var(--app-text-red)`) when live, or `Resume` when ended.
5. Notes: label `font-size:12px; font-weight:600; color: var(--app-text-secondary); margin-bottom:4px`,
   text `Notes`. Textarea: `width:100%; box-sizing:border-box; border:none; outline:none;
   resize:vertical; background:transparent; color: var(--app-text-primary);
   font-family: var(--font-app-ui, ui-sans-serif); font-size:14px; line-height:1.5; padding:6px 2px;
   min-height:84px;` rows 4, placeholder `Add a note about this session…`. It is a **borderless,
   groundless** editor, which is the Notion idiom: the note looks like page content, not like a form
   field. It persists to `localStorage` under the key `mw-notion-notes`.
6. Last output: label as above, text `Last output`. Block: `border-radius:6px; background: {{ termBg }};
   padding: 10px 12px; font-family: mono; font-size:12px; line-height:1.65; color: {{ termInk }};`
   showing the last three transcript lines with their own colors.

---

## 8. Region: overlays

Every overlay in the mock follows one of three recipes. Learn these three and every popover, menu and
modal in the app falls out.

### 8.1 Popover recipe (account, attention)

A transparent full-screen click-catcher at `position:fixed; inset:0; z-index:290` whose click closes
the overlay, containing an absolutely positioned card that stops propagation:

```
background: var(--app-bg-elevated); border: 1px solid var(--app-border-primary);
border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.18); overflow:hidden;
animation: mwFadein 0.15s ease-out;
```

Anchors in the mock are hard-coded (account: `top:46px; right:76px; width:340px`; attention:
`top:96px; left:252px; width:380px`) because it is a prototype. In the real build, anchor them to their
trigger and keep the widths.

**Account / usage popover** (`data-screen-label="Account usage popover"`):

- Head: `display:flex; justify-content:space-between; padding: 12px 14px 6px`, title
  `Claude usage — Gayane` at `font-size:14px; font-weight:600`, and a 26px refresh icon button.
- Meters: `display:flex; flex-direction:column; gap:8px; padding: 4px 14px 12px`. Each meter is a
  label row plus a track:
  - label row `display:flex; justify-content:space-between; font-size:12px`, key at
    `color: var(--app-text-secondary); font-weight:500`, right side at
    `color: var(--app-text-tertiary)` reading `{pct}% · {reset}`.
  - track `height:5px; border-radius:3px; background: var(--app-bg-tertiary); overflow:hidden`, fill
    `height:100%; border-radius:3px; width:{pct}%`.
  - fill color by threshold: below 60 `var(--app-text-green)`, below 85 `var(--app-text-yellow)`,
    otherwise `var(--app-text-red)`.
  - Three meters: `Session` (42 percent, `resets 2h 14m`), `Opus` (67 percent, `resets Thu 09:00`),
    `Fable` (12 percent, `resets Thu 09:00`).
- Divider: `height:1px; background: var(--app-border-secondary)`.
- Credential rows: wrapper `padding:6px`, each row `display:flex; align-items:center; gap:10px;
  padding: 6px 8px; border-radius:6px` with hover wash. Contents: `nt-avatar` at 24px / 11px with a hue
  class, name at `font-size:13px; font-weight:500`, a plan chip `nt-chip nt-chip-gray` with
  `margin-left:6px`, then a conditional `Active` chip (`nt-chip-status nt-chip-green`) or `Re-login`
  chip (`nt-chip-status nt-chip-yellow`), and a `Switch` button (`nt-btn-app-secondary`) shown only
  when the row is neither active nor warning. A warning row renders at `opacity: 0.7`.
- Footer row: `padding: 6px 8px; border-radius:6px; color: var(--app-text-tertiary); font-size:12px`
  with hover raising to secondary ink. Text `Manage accounts in Settings →`. It opens Settings on the
  Accounts section.

**Attention popover** (`data-screen-label="Attention inbox"`):

- Head: `padding: 12px 14px 8px`, title `Needs your attention` at 14px / 600, and a
  `Stop all` button (`nt-btn-app-secondary`).
- Rows: wrapper `padding: 2px 6px 8px`; each row `display:flex; align-items:center; gap:10px;
  padding:8px; border-radius:6px` with hover wash. Contents: a `7px` pulsing dot, a two-line block
  (title `font-size:13px; font-weight:500` ellipsized, reason `font-size:12px;
  color: var(--app-text-tertiary)`), then an `Open` button (`nt-btn nt-btn-app`) that jumps to the
  Workbench.
- Reason strings are generated: Codex sessions read `Codex is waiting for command approval`, Claude
  sessions read `Held by auto-trust: prompt mentions overwrite`.
- Empty state: `padding:18px; text-align:center; color: var(--app-text-tertiary); font-size:13px`, text
  `All clear — nothing is waiting on you.`
- Footer: `padding: 8px 14px; border-top: 1px solid var(--app-border-secondary); font-size:11px;
  color: var(--app-text-tertiary)`, text
  `Auto-trust answers safe prompts; anything touching deletes or credentials waits here for you.`

### 8.2 Menu recipe (context menus)

Click-catcher at `position:fixed; inset:0; z-index:350` which also swallows `contextmenu`. The menu is
the design system's `.nt-menu` with three inline overrides:
`position:absolute; left:{x}px; top:{y}px; width:240px; max-height: calc(100vh - 24px);
animation: mwFadein 0.15s ease-out;`

`.nt-menu` itself (`components.css` line 484) supplies `background: var(--app-bg-elevated);
border-radius: var(--radius-app-button)` (6px), `box-shadow: var(--app-shadow-menu)`,
`padding: var(--app-menu-pad)` (4px), `font-size:14px; line-height:16.8px`, `overflow: hidden auto`.
The mock narrows the default `--app-menu-width` of 320px to 240px. Keep 240px.

Positioning is clamped in `_openCtx`: `x = min(clientX, innerWidth - 260)`,
`y = min(clientY, innerHeight - 380)`.

Row anatomy:
- `.nt-menu-section`: `padding: 8px 12px 4px; color: var(--app-text-tertiary); font-size:12px;
  font-weight:500`.
- `.nt-menu-sep`: `height:1px; background: var(--app-divider); margin: 4px 0`.
- `.nt-menu-item`: `display:flex; gap:8px; min-height:28px; padding: 0 10px; border-radius:4px;
  color: var(--app-text-primary)`, hover `var(--app-wash-hover)`.
- `.nt-menu-item-icon`: `width:18px; color: var(--app-icon-secondary)`, holding a 15px inline SVG.
- `.nt-menu-item-label`: `flex:1`, ellipsized.
- `.nt-menu-item-hint`: `color: var(--app-text-tertiary); font-size:12px`.
- `.nt-menu-item.is-danger`: `color: var(--app-text-red)`.

Four menus are specified. Every item carries an icon key from the icon set in section 11.

**Session menu** (`View details` `sidebar`, `Open in Workbench` `code`, `Stop` `close` or `Resume`
`toggle`, `Restart` `clock`, separator, section `Model`, then `Opus 4.6` / `Sonnet 4.5` / `Haiku 4`
each with icon `check` when it is the current model and `none` otherwise, separator, `Rename` `page`
hint `dbl-click`, `Auto-title` `sparkle`, `Summarize` `list`, `Copy transcript` `copy`,
`Copy session ID` `copy`, `Copy last output` `copy`, separator, section `Move to`, one row per other
project prefixed with its emoji, separator, `Hide` / `Unhide` `eye`, `Remove from project` `trash`
danger).

**Project menu** (`New session here` `plus`, `New agent task` `todo` hint `⌘⇧N`,
`New feature session` `sparkle`, separator, `Rename project` `page`, `Hide project` `eye`,
`Delete project` `trash` danger).

**Tab group menu** (`Rename group` `page`, `Duplicate group` `copy`, separator, `Close group` `trash`
danger).

**Task menu** (`Open session` `code`, `View diff` `sidebar`, `Copy branch name` `copy`, separator,
`Merge to main` `check`, `Push branch` `arrow-right`, separator, `Delete task` `trash` danger).

The selected-model row is marked with a **check icon in the icon slot**, not with a highlight and not
with a radio. That is the Notion idiom.

### 8.3 Modal recipe (Quick Find, dialogs, diff, settings)

Scrim: `position:fixed; inset:0; background: rgba(15,15,15,0.55); z-index:300; display:flex;` plus a
placement (`align-items:flex-start; justify-content:center; padding-top:96px` for Quick Find,
`align-items:center; justify-content:center; padding:32px` for everything else). Clicking the scrim
closes. Card:

```
background: var(--app-bg-elevated); border-radius: 10px;
box-shadow: 0 16px 50px rgba(0,0,0,0.25); overflow:hidden;
animation: mwFadein 0.15s ease-out;
```

Note the scrim is `rgba(15,15,15,0.55)`, darker than the design system's `--app-image-overlay`
(`rgba(0,0,0,0.3)`). Follow the mock: the Workbook's modals sit over a dense app, not over a document.

**Quick Find** (`data-screen-label="Quick Find"`), width `560px`, `max-width: calc(100vw - 48px)`,
`max-height: 60vh`, `display:flex; flex-direction:column`:

- Search row: `display:flex; align-items:center; gap:10px; padding: 14px 16px;
  border-bottom: 1px solid var(--app-border-secondary)`. An 18px search icon at
  `color: var(--app-text-tertiary)`, an autofocused borderless input at `font-size:15px;
  font-family: var(--font-app-ui, ui-sans-serif)` with placeholder
  `Find a session, project, or conversation…`, and an `esc` key cap: `font-size:11px;
  color: var(--app-text-tertiary); border: 1px solid var(--app-border-primary); border-radius:4px;
  padding: 1px 5px`.
- Results: `flex:1; overflow-y:auto; padding:6px`. Group header: `padding: 6px 10px 2px;
  font-size:11px; font-weight:600; color: var(--app-sidebar-section-label); text-transform:uppercase;
  letter-spacing:0.03em`, text `Sessions`. This is the **only uppercase tracked-out label in the whole
  design**; do not spread the treatment. Result row: `display:flex; align-items:center; gap:10px;
  padding: 7px 10px; border-radius:6px` with hover wash, containing a `7px` status dot, the title at
  `font-size:14px; font-weight:500`, the project as `{emoji} {name}` at `font-size:12px;
  color: var(--app-text-tertiary)`, a spacer, and the relative time at 12px tertiary.
- Empty: `padding:24px; text-align:center; color: var(--app-text-tertiary); font-size:13px`, text
  `No sessions match "{query}". Try "Find in conversations" to search transcript content.`
- Footer: `display:flex; align-items:center; gap:8px; padding: 9px 16px;
  border-top: 1px solid var(--app-border-secondary); font-size:12px; color: var(--app-text-tertiary)`,
  a 14px sparkle icon, the text
  `Find in conversations — full-text search across every transcript`, a spacer, and
  `⌘K search · ⌘P switcher`.

Matching is `title` or project name, case-insensitive, capped at 6 results.

**New session dialog**, width `480px`, `max-width: calc(100vw - 64px)`,
`max-height: calc(100vh - 64px)`, `overflow-y:auto`:

- Head: `display:flex; justify-content:space-between; padding: 16px 20px 4px`, `<h3 style="margin:0;
  font-size:16px; font-weight:600">New session</h3>`, 28px close icon button.
- Body: `padding: 8px 20px 20px; display:flex; flex-direction:column; gap:12px`.
- Template chips row: `display:flex; gap:6px; flex-wrap:wrap` of clickable `nt-chip` in rotating hues
  `['nt-chip-blue','nt-chip-purple','nt-chip-green'][i % 3]` with `cursor:pointer`. Clicking one fills
  the whole form. Shipped templates: `Bugfix (Sonnet, skip perms)`, `Research (Opus, verbose)`,
  `Codex quick edit`.
- Field group pattern: `display:flex; flex-direction:column; gap:4px`; label `font-size:12px;
  color: var(--app-text-secondary); font-weight:500`; control `width:100%; box-sizing:border-box;
  padding: 6px 10px; border: 1px solid var(--app-border-primary); border-radius:6px;
  background: var(--app-bg-primary); color: var(--app-text-primary); font-family:inherit;
  font-size:14px; outline:none`. Textareas add `resize:vertical`.
- Fields: `Name` (placeholder `e.g. fix-login-redirect`), `Project` (select of the four projects with
  emoji), a two-up row of `Provider` and `Model` (`display:flex; gap:10px`, each `flex:1`),
  `Initial prompt` with an inline optional marker: `<span style="font-weight:400;
  color: var(--app-text-tertiary)">(optional)</span>`.
- Checkbox row: `display:flex; gap:14px; font-size:13px; color: var(--app-text-secondary)`; each label
  `display:flex; align-items:center; gap:6px; cursor:pointer` wrapping a native
  `<input type="checkbox" style="accent-color: #2383e2">`. Options `Skip permissions` and `Verbose`.
  The mock uses native checkboxes with `accent-color`, not `.nt-checkbox`. Either is acceptable;
  `accent-color: var(--app-ui-blue)` is the minimum.
- Footer: `display:flex; justify-content:space-between; align-items:center; gap:8px; padding-top:4px`
  with `Save as template` (secondary) on the left and `Cancel` (secondary) plus `Start session`
  (`nt-btn-app`) on the right.

**New agent task dialog**, width `500px`, otherwise identical framing. Fields: `Task name` with a
**live branch preview** below it (`font-size:11px; color: var(--app-text-tertiary);
font-family: mono`, computed as `'feat/' + name.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-')`,
falling back to `feat/your-task-name`), `Project directory` (select), `Initial prompt`, a two-up
`Model` and `Tags` row, a three-up checkbox row (`Start immediately`, `Skip permissions`,
`Agent teams`), then an explanatory panel:
`font-size:12px; color: var(--app-text-tertiary); background: var(--app-bg-secondary);
border-radius:6px; padding: 8px 10px`, text
`Creates a git worktree on its own branch, runs the agent there, and lands the task on the board for review and merge.`
Footer is right aligned: `Cancel` then `Create task`.

**Diff viewer** (`data-screen-label="Diff viewer"`), `width:900px; max-width: calc(100vw - 48px);
height: min(600px, calc(100vh - 64px)); display:flex; flex-direction:column`:

- Head: `display:flex; align-items:center; gap:10px; padding: 14px 18px 10px;
  border-bottom: 1px solid var(--app-border-secondary)`. `<h3 style="font-size:15px; font-weight:600">`
  with the task title, the branch at `font-size:12px; color: var(--app-text-tertiary);
  font-family: mono`, a stats cluster at `font-size:12px` reading
  `<span style="color: var(--app-text-green)">+214</span>` then
  `<span style="color: var(--app-text-red)">−38</span>` then
  `<span style="color: var(--app-text-tertiary)">· 3 files</span>`, a spacer, `Merge` (`nt-btn-app`),
  `Push` (secondary), and a 28px close button.
- File list: `width:240px; min-width:240px; border-right: 1px solid var(--app-border-secondary);
  overflow-y:auto; padding:8px`. Row: `display:flex; align-items:center; gap:8px; padding: 6px 8px;
  border-radius:6px` with hover wash; selected takes `background: var(--app-sidebar-item-selected)`.
  Kind badge: `width:16px; height:16px; display:grid; place-items:center; border-radius:3px;
  font-size:10px; font-weight:700`, added files `background: var(--app-bg-green);
  color: var(--app-text-green)`, modified files `background: var(--app-bg-blue);
  color: var(--app-text-blue)`. Path: `font-size:12px; font-family: mono; direction:rtl;
  text-align:left` with ellipsis, so long paths truncate at the **front** and keep the filename. Stats:
  `font-size:11px` with `+n` green and `−n` red.
- Hunk pane: `flex:1; overflow-y:auto; font-family: mono; font-size:12px; line-height:1.7`. Each line
  is `display:flex` with `background: {{ dl.bg }}; color: {{ dl.ink }}`, a gutter
  (`width:44px; min-width:44px; text-align:right; padding-right:10px;
  color: var(--app-text-tertiary); user-select:none; font-size:11px`), a sign column
  (`width:14px; min-width:14px; user-select:none`), and the text
  (`flex:1; white-space:pre-wrap; padding-right:14px`).
- Line colors are the block palette, computed per theme:
  add `dark ? '#263d30' : '#e8f1ec'` with ink `var(--app-text-green)`;
  delete `dark ? '#502c29' : '#fce9e7'` with ink `var(--app-text-red)`;
  hunk header `dark ? '#233850' : '#e5f2fc'` with ink `var(--app-text-blue)`;
  context `transparent` with ink `var(--app-text-secondary)`.
  Those literals are exactly `--app-bg-green`, `--app-bg-red`, `--app-bg-blue` in both themes, so use
  the tokens rather than the literals.

---

## 9. Region: agent-task board and costs

### 9.1 Agent tasks

Page frame `max-width:1240px; margin: 0 auto; padding: 28px 48px 60px`. Header row with `🗂️` at 28px,
`<h1>Agent tasks</h1>` at 30px / 700 / `-0.01em`, a spacer, and
`<button class="nt-btn nt-btn-app">New agent task</button>`. Lede at 14px secondary:
`Each task runs on its own git worktree branch. Drag cards between columns; right-click for merge, diff, and push.`

Board: `<div class="nt-board" style="align-items: stretch; padding-bottom: 12px">`. `.nt-board`
supplies `display:flex; align-items:flex-start; gap: var(--app-board-gap)` (16px) and
`overflow-x:auto`; the inline `align-items: stretch` makes columns equal height, which matters because
each column carries a drop-target background.

Column: `<div class="nt-board-col" style="border-radius:8px; padding:4px; background:{{ col.bg }};
min-height:220px">`. `.nt-board-col` supplies `width: var(--app-board-column-width)` (260px),
`flex:none`, `display:flex; flex-direction:column; gap: var(--app-board-card-gap)` (8px). `col.bg` is
`var(--app-bg-blue)` while a card is dragged over it, otherwise `transparent`.

Column head: `<div class="nt-board-col-head" style="padding: 0 4px">` (min-height 36px) containing a
status chip and `<span class="nt-board-count">` (tertiary, 14px). The five columns and their chips:

| Column | Chip class |
|---|---|
| Backlog | `nt-chip-gray` |
| Planning | `nt-chip-blue` |
| Running | `nt-chip-green` |
| Review | `nt-chip-yellow` |
| Done | `nt-chip-purple` |

Card: `<div class="nt-board-card" draggable style="cursor: grab">`. `.nt-board-card` supplies
`display:flex; flex-direction:column; gap:4px; padding: 8px 12px;
background: var(--app-bg-elevated); border-radius:10px;
box-shadow: var(--app-shadow-outlined-sm); transition: var(--motion-hover-reveal)` and hover
`background: var(--app-bg-secondary)`. Contents in order:

1. `<div class="nt-board-card-title" style="font-weight:500">` (14px / 21px).
2. Branch: `font-size:11px; color: var(--app-text-tertiary); font-family: mono` ellipsized.
3. Live output line, only in the Running column and only when the task has one:
   `font-size:11px; color: var(--app-text-secondary); font-family: mono; background: {{ termBg }};
   border-radius:4px; padding: 4px 6px` ellipsized. Example content
   `● Indexing 4,812 JSONL lines…`. Note it uses the **terminal palette** ground, which ties a board
   card back to the terminal world.
4. `<div class="nt-board-card-props">` (`display:flex; flex-wrap:wrap; gap:4px`) with a model chip
   (`nt-chip nt-chip-gray`), then tag chips using the map
   `{ ui: 'nt-chip-blue', grid: 'nt-chip-teal', search: 'nt-chip-purple', urgent: 'nt-chip-red',
   infra: 'nt-chip-brown' }` with `nt-chip-gray` as the fallback, then an optional stats string at
   `font-size:11px; color: var(--app-text-tertiary); align-self:center` (for example
   `3 commits · 3 files` or `merged`).
5. Review-column cards only: `display:flex; gap:6px; margin-top:2px` with `Merge` (`nt-btn-app`),
   `Diff` and `Push` (both `nt-btn-app-secondary`).

Column footer: `<div class="nt-board-add" style="padding:4px; color: var(--app-text-tertiary);
font-size:13px; display:flex; align-items:center; gap:5px">` with a 13px plus glyph and the label
`New`; hover raises the ink to secondary.

### 9.2 Costs

Page frame `max-width:1100px; padding: 28px 48px 60px`. Header row: `🧮` at 28px,
`<h1>Costs</h1>`, spacer, then a period pill group (`display:flex; gap:2px`) with
`Today` / `This week` / `This month` / `All time`, each `padding: 4px 10px; border:none;
border-radius:6px; font-size:13px` using the standard active recipe. Lede at 14px secondary:
`Spend across every provider session on this machine.`

Stat cards: `display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:22px`. Each
card `border: 1px solid var(--app-border-primary); border-radius:8px; padding: 14px 16px` with a label
(`font-size:12px; color: var(--app-text-secondary); font-weight:500`) and a value
(`font-size:26px; font-weight:700; letter-spacing:-0.01em; margin-top:2px;
font-variant-numeric: tabular-nums`). Cards are `Total spend`, `Tokens`, `Sessions`.

Sub-section label pattern, used twice: `font-size:13px; font-weight:600;
color: var(--app-text-secondary); margin-bottom:4px`, texts `By project` and `By model`.

`By project` table (`nt-table`): columns `Project` (34 percent), `Sessions`, `Tokens`, `Cost` (right,
tabular), `Share` (26 percent). The Share cell is a bar plus a number:
track `flex:1; height:5px; border-radius:3px; background: var(--app-bg-tertiary); overflow:hidden`,
fill `height:100%; border-radius:3px; width:{pct}%; background: var(--app-text-blue)`, then
`font-size:12px; color: var(--app-text-tertiary); min-width:32px; text-align:right`.

`By model` table: `Model` (34 percent), `Provider` (a provider chip), `Tokens`, `Cost` (right,
tabular).

The bar is the same 5px / 3px-radius meter as the usage popover. Treat it as one component.

---

## 10. Theming model

### 10.1 Two independent axes

1. **App chrome theme.** `data-surface="app"` plus `data-theme="light" | "dark"`. Controlled from the
   topbar sun toggle and from Settings > Interface > Appearance (a `Light` / `Dark` pair where the
   active side is `nt-btn-app` and the inactive side is `nt-btn-app-secondary`). Drives every
   `--app-*` token.
2. **Terminal palette.** Thirteen fixed palettes carried over from the original app's
   `theme-registry.js`, plus three "featured" choices. Drives only the terminal surfaces and the prompt
   accent. It is **not** a chrome theme and it must never leak into the chrome.

### 10.2 The thirteen palettes

Verbatim from `_termThemes()` in the mock. Each has `id`, `label`, `appearance`, and four colors:
`bg` (terminal ground), `ink` (primary output), `dim` (secondary output), `rule` (the input row's top
border), `accent` (the `❯` prompt and the settings preview swatch).

| id | label | appearance | bg | ink | dim | rule | accent |
|---|---|---|---|---|---|---|---|
| `mocha` | Mocha | dark | `#1e1e2e` | `#cdd6f4` | `#a6adc8` | `#45475a` | `#cba6f7` |
| `macchiato` | Macchiato | dark | `#24273a` | `#cad3f5` | `#a5adcb` | `#494d64` | `#c6a0f6` |
| `frappe` | Frappé | dark | `#303446` | `#c6d0f5` | `#a5adce` | `#51576d` | `#ca9ee6` |
| `nord` | Nord | dark | `#2e3440` | `#d8dee9` | `#81a1c1` | `#434c5e` | `#88c0d0` |
| `dracula` | Dracula | dark | `#282a36` | `#f8f8f2` | `#6272a4` | `#44475a` | `#bd93f9` |
| `tokyo-night` | Tokyo Night | dark | `#1a1b26` | `#c0caf5` | `#565f89` | `#3b4261` | `#7aa2f7` |
| `cherry` | Cherry | dark | `#241521` | `#f4dbe4` | `#a97f92` | `#4a2c3d` | `#ed5e93` |
| `ocean` | Ocean | dark | `#0f1c24` | `#d4e3ec` | `#7e9aab` | `#29414f` | `#4fb3d9` |
| `amber` | Amber | dark | `#201a12` | `#f0e0c8` | `#a8906a` | `#4a3c26` | `#e8a33d` |
| `mint` | Mint | dark | `#12211c` | `#d8ece3` | `#86a89a` | `#2e4a40` | `#57c99a` |
| `latte` | Latte | light | `#eff1f5` | `#4c4f69` | `#8c8fa1` | `#bcc0cc` | `#8839ef` |
| `rose-pine-dawn` | Rose Pine Dawn | light | `#faf4ed` | `#575279` | `#9893a5` | `#dfdad9` | `#b4637a` |
| `gruvbox-light` | Gruvbox Light | light | `#fbf1c7` | `#3c3836` | `#d5c4a1` (dim `#7c6f64`) | `#d5c4a1` | `#af3a03` |

(Gruvbox Light in the source reads `dim: '#7c6f64', rule: '#d5c4a1'`.)

### 10.3 Resolution rule

```js
_resolveTermPalette(dark) {
  const id = state.termCustomId
    || (state.termChoice === 'myrlin-dark'  ? 'mocha'
     : state.termChoice === 'myrlin-light' ? 'latte'
     : (dark ? 'mocha' : 'latte'));
  return themes.find(t => t.id === id) || themes[0];
}
```

So: an explicit palette from the `More themes…` select always wins; `Myrlin Dark` means Mocha;
`Myrlin Light` means Latte; `System` follows the app theme, giving Mocha in dark and Latte in light.
Picking a custom palette clears the featured pill selection (the pill is active only when
`termChoice === id && !termCustomId`).

### 10.4 What the palette paints, exhaustively

| Surface | Property |
|---|---|
| Pane transcript body | `background: bg`, `color: ink` |
| Pane transcript dim lines | `color: dim` |
| Pane input row | `background: bg`, `border-top: 1px solid rule` |
| Pane input text | `color: ink` |
| Pane prompt `❯` | `color: accent` |
| Peek "Last output" block | `background: bg`, `color: ink` |
| Board card live-output line | `background: bg` |
| Settings live-preview swatch | `background: bg`, the 10px square is `accent`, the `❯ {label}` text is `ink` |

Everything else in the app stays on `--app-*` tokens. The palette never touches the sidebar, the
topbar, a chip, a menu, a modal, or a table.

### 10.5 What is theme invariant

- The ten named block **text** colors (`--app-text-gray` through `--app-text-teal`). No dark override
  exists and adding one is on the rejection list. This means every status dot, the diff `+` / `−` inks,
  the attention badge ink, the running-count green, and the hard-coded `#cb9434` / `#9a6bb4` transcript
  colors are identical in light and dark.
- `--app-ui-blue` `#2383e2` and `--app-accent-blue` `#2783de`.
- All thirteen terminal palettes. They are data, not tokens; a light palette stays light on a dark
  chrome and that is intended.
- The 4px chip radius against the 10px card radius.

What does flip: the neutral core, the block **background** palette, the chip fills and inks, the washes,
the borders, the shadows, and the diff row fills (because those are block backgrounds).

### 10.6 Settings > Interface, terminal theme control

The block is `display:flex; flex-direction:column; gap:8px; padding: 10px 0;
border-bottom: 1px solid var(--app-border-secondary)`:

- Row one: title `Terminal theme` (14px / 500) and description
  `All 13 Workbook palettes carry over; System follows the app theme` (12px secondary) on the left; on
  the right a pill group `display:flex; gap:2px` of `System` / `Myrlin Dark` / `Myrlin Light` at
  `padding: 4px 10px; border-radius:6px; font-size:12px` with the standard active recipe.
- Row two: `display:flex; align-items:center; gap:8px` with a `flex:1` select whose first option is
  `More themes…` and whose remaining options are labelled `{Label} · dark` or `{Label} · light`, then
  the live preview:
  `display:inline-flex; gap:6px; align-items:center; padding: 5px 10px; border-radius:6px;
  background: {{ termBg }}; border: 1px solid var(--app-border-secondary)` containing a
  `10px` square at `border-radius:3px; background: {{ termAccent }}` and the text
  `❯ {{ termThemeLabel }}` at `font-family: mono; font-size:11px; color: {{ termInk }}`.
  `title` is `Live preview`.

---

## 11. Iconography

Every icon in both mocks is an inline SVG on a **16 unit grid**, stroked, never filled, at 1.5 weight
with round joins:

```html
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="..."/>
</svg>
```

Rules:

- `viewBox` is always `0 0 16 16` regardless of the rendered size. Rendered sizes in use: `20px` (drop
  slot glyph, mobile tab icons), `18px` (Quick Find search), `16px` (sidebar rows, topbar buttons,
  dialog closes, mobile header), `15px` (pane header buttons, menu item icons), `14px` (hidden toggle,
  refresh, plus in tab bar, footers), `13px` (board "New"), `12px` (workspace chevron).
- Color is always `currentColor`. Icons never carry their own color; the parent sets it
  (`--app-text-secondary` for interactive chrome, `--app-text-tertiary` for passive glyphs,
  `--app-icon-secondary` inside menus).
- The **only** filled icons are the three-dot overflow glyphs, which are three
  `<circle cx="4|8|12" cy="8" r="1.35" fill="currentColor">` on a `fill="none"` root.
- No icon has a background, a container, a rounded square, or a duotone treatment.
- Icons are generated centrally. The mock's `_icon(name, size)` returns
  `{ __html: '<svg ...>' + paths + '</svg>' }` from a path dictionary. Reproduce that: one sprite or one
  helper, one stroke recipe, no per-call overrides.

The canonical path dictionary, verbatim from the mock (reuse these exact paths so the set stays
coherent):

| key | paths |
|---|---|
| `code` | `M5.5 5L3 8l2.5 3` , `M10.5 5L13 8l-2.5 3` |
| `database` | `M8 5.25c2.5 0 4.5-.62 4.5-1.38S10.5 2.5 8 2.5 3.5 3.12 3.5 3.88 5.5 5.25 8 5.25z` , `M3.5 3.88v8.24c0 .76 2 1.38 4.5 1.38s4.5-.62 4.5-1.38V3.88` , `M3.5 8c0 .76 2 1.38 4.5 1.38S12.5 8.76 12.5 8` |
| `clock` | `M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z` , `M8 5v3.25l2 1.25` |
| `template` | `M3 3.5h10v3H3z` , `M3 8.5h4.5v4H3z` , `M9.5 8.5H13v4H9.5z` |
| `user` | `M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z` , `M3.5 13.5c0-2.2 2-3.75 4.5-3.75s4.5 1.55 4.5 3.75` |
| `sparkle` | `M8 2.5l1.2 3.3 3.3 1.2-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2z` , `M12.25 10.75l.5 1.25 1.25.5-1.25.5-.5 1.25-.5-1.25-1.25-.5 1.25-.5z` |
| `link` | `M6.75 9.25l2.5-2.5` , `M7 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 8` , `M9 11.5L7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8` |
| `todo` | `M3 4.5h10v7H3z` , `M5.5 8l1.75 1.75L10.5 6.5` |
| `sidebar` | `M3 3.5h10v9H3z` , `M6.5 3.5v9` |
| `copy` | `M5.5 5.5h7v7h-7z` , `M10.5 5.5V4a.5.5 0 0 0-.5-.5H4a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h1.5` |
| `close` | `M4 4l8 8` , `M12 4l-8 8` |
| `check` | `M3.5 8.5l3 3 6-7` |
| `trash` | `M3.5 4.5h9` , `M6.5 4.5V3h3v1.5` , `M4.75 4.5l.6 8h5.3l.6-8` |
| `page` | `M4 2.5h5L12 6v7.5H4z` , `M8.75 2.5V6H12` |
| `arrow-right` | `M3 8h10` , `M9 4l4 4-4 4` |
| `star` | `M8 2.75l1.65 3.4 3.6.5-2.6 2.6.6 3.7L8 11.2l-3.25 1.75.6-3.7-2.6-2.6 3.6-.5z` |
| `toggle` | `M6 4l4 4-4 4` |
| `list` | `M6 4.5h7` , `M6 8h7` , `M6 11.5h7` , `M3.5 4.5h.01` , `M3.5 8h.01` , `M3.5 11.5h.01` |
| `plus` | `M8 3.25v9.5` , `M3.25 8h9.5` |
| `eye` | `M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z` , `M8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z` |
| `none` | (empty, renders an invisible 16x16 spacer so menu rows stay aligned) |

Additional inline-only icons defined in the template rather than the dictionary: search
(`M7.25 12a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5z` + `M10.75 10.75L13.5 13.5`), inbox / attention
(`M3 3.5h10v9H3z` + `M3 9h3l.75 1.5h2.5L10 9h3`), gear, sun, refresh
(`M2.5 8a5.5 5.5 0 0 1 10.1-3M13.5 8a5.5 5.5 0 0 1-10.1 3` + `M12.5 2v3h-3M3.5 14v-3h3`), image
(`M3 3.5h10v9H3z` + `M3 10.5l3-3 2.5 2.5L11 7.5l2 2` + `M6 6.5h.01`), microphone
(`<rect x="6" y="1.75" width="4" height="7" rx="2">` + `M3.75 7.5a4.25 4.25 0 0 0 8.5 0` +
`M8 11.75v2.5` + `M6 14.25h4`), chevron-down (`M3.5 6L8 10.5 12.5 6`), chevron-left
(`M10 3.5L5.5 8 10 12.5`), chevron-right (`M6 3.5L10.5 8 6 12.5`), and home
(`M3 7.5L8 3l5 4.5` + `M4.5 6.75v6.25h7V6.75`).

The project and workspace glyphs are **emoji**, not icons: `🎩` for the workspace, `🛠️ 🔬 📣 📡` for
projects, `📓 🧮 🗂️` for view titles. Emoji sit in a `display:grid; place-items:center` box (22px in the
sidebar header on an `--app-bg-purple` tile, 18px on project rows with no tile, 28px in page titles).

---

## 12. Toasts, empty states, and other small surfaces

**Toast.** `<div class="nt-toast" style="position:fixed; bottom:24px; left:24px; z-index:400">
<span class="nt-toast-label">{text}</span></div>`. `.nt-toast` supplies `width: var(--app-toast-width)`
(300px), `padding: 8px 12px`, `background: var(--app-bg-accent-primary)` (near-black in light,
near-white in dark), `color: var(--app-text-inverse-primary)`, `border-radius:6px`,
`box-shadow: var(--app-shadow-lg)`, 14px / 21px, and
`animation: var(--duration-200) var(--ease-out) nt-snackbar-slide-in-bottom`. Bottom **left**, not
bottom right. One line, one optional action (`.nt-toast-action`). Auto dismisses after `2200ms`; a new
toast clears the previous timer, so only one toast is ever on screen.

The mock fires a toast for essentially every mutation. The full copy set, which doubles as the app's
confirmation vocabulary: `Session opened in pane {n}`, `Session started`, `Pane closed — session keeps
running` (or `Pane closed` when the confirm-close setting is off), `Transcript copied`,
`Session ID copied`, `Last output copied`, `Moved to {project}`, `Stopped {title}`, `Resuming {title}`,
`Restarted {title}`, `Titled from conversation content`, `Summary added to notes`, `Session hidden`,
`Session unhidden`, `Removed — back in Discovered`, `Branch + worktree + session created`,
`{project} hidden`, `Sessions return to Discovered`, `Group duplicated`, `Task moved to {column}`,
`Squash-merged {branch} into main`, `Pushed {branch} — open a PR on GitHub`,
`Worktree created — agent running`, `Task added to backlog`, `Task and worktree removed`,
`Saved as template`, `Switched to {name} — applies to new sessions`,
`Usage refreshed from provider APIs`, `Stopped {n} sessions`, `Voice input off`,
`Listening — speak your prompt`, `Attach an image — drop a file or paste from the clipboard`,
`Model set to {model}`.

**Empty states.** The mock draws exactly three, and none of them uses the design system's `.nt-empty`
component:

| Where | Treatment |
|---|---|
| Empty pane grid | The dashed drop slot (5.2). Doubles as the onboarding card. |
| Quick Find, no matches | `padding:24px; text-align:center; color: var(--app-text-tertiary); font-size:13px` |
| Attention, nothing waiting | `padding:18px; text-align:center; color: var(--app-text-tertiary); font-size:13px` |

For any empty state the mock does not draw, use `.nt-empty` from `components.css` line 1238:
centered column, `gap: 8px`, `padding: 40px 24px`, title at 16px / 600 primary, body at 14px / 21px
secondary capped at `320px`, actions row with `margin-top: 8px`; or `.nt-empty.nt-empty-inline` for the
left-aligned database variant (`padding: 24px 8px`). The art slot expects a hand-inked line drawing,
never a line icon in a rounded square. If no illustration exists, ship the state with no art rather than
with a placeholder glyph.

**Loading.** Nothing in the mock loads. When you need a loading state, it is `.nt-skeleton`
(`_ds/styles.css` line 696): a 1s linear shimmer between `--app-bg-tertiary` and
`--app-bg-interactive`, disabled under `prefers-reduced-motion: reduce`. A spinner is only for a
genuinely indeterminate operation. Content never spins.

**Tooltips.** The mock uses native `title=` attributes throughout (`Copy transcript`, `Pane menu`,
`Close pane`, `Attach an image`, `Voice input` / `Stop voice input`, `Toggle light / dark`, `More`,
`Drag to resize the sidebar`, `Drag to resize panes`, `Drag to resize`, `New tab group`,
`Refresh usage`, `Account usage & switching`, `Live preview`). If you upgrade to real tooltips, use
`.nt-tooltip`: dark chip, `padding: 4px 8px`, `border-radius: 4px`, 12px / 16px, with an optional
`.nt-tooltip-hint` shortcut line under the label.

**Buttons, the complete set.**

| Class | Recipe |
|---|---|
| `nt-btn nt-btn-app` | `background: var(--app-accent-blue)` `#2783de`, `color: var(--mkt-white)`, `font-size:14px; line-height:16.8px; height:28px; padding: 0 8px; border-radius:6px`; hover `background: var(--app-ui-blue)` `#2383e2` |
| `nt-btn nt-btn-app-secondary` | `background: var(--app-bg-elevated)`, `color: var(--app-text-primary)`, `box-shadow: var(--app-shadow-button)` (an inset hairline plus a 1px lift), `border-color: transparent`, same 28px / 6px / 14px metrics; hover `background: var(--app-bg-interactive)` |
| Icon button | 28px in the topbar, peek and dialogs; 26px in pane headers, popovers and the tab bar. `border:none; border-radius:4px; background:transparent; color: var(--app-text-secondary)`; hover wash. |
| Disabled | `.nt-btn[disabled] { opacity: 0.5; cursor: default }` |

There is no third button weight and no destructive button fill. Danger is expressed as red **ink** on
an otherwise normal control (`Stop` in the peek, `.is-danger` menu rows).

**Switch.** `<button class="nt-switch is-on" role="switch"><span class="nt-switch-knob"></span></button>`.
26px by 16px, `border-radius: var(--radius-round)`, off `background: var(--app-bg-tertiary)`, on
`background: var(--app-ui-blue)`; the knob is 12px, white, `box-shadow: var(--app-shadow-avatar)`,
and translates by `calc(width - height)`; only the knob moves; 200ms `--ease-out`.

---

## 13. Region: settings

Modal card `width:780px; max-width: calc(100vw - 64px); height: min(560px, calc(100vh - 64px));
display:flex;` (a row, not a column) on the standard modal recipe.

**Left nav.** `width:200px; min-width:200px; background: var(--app-bg-secondary);
border-right: 1px solid var(--app-border-secondary); padding: 12px 8px; display:flex;
flex-direction:column; gap:1px`. A section label `Settings` at `padding: 4px 8px 8px; font-size:12px;
font-weight:500; color: var(--app-sidebar-section-label)`, then rows at
`display:flex; align-items:center; gap:8px; padding: 5px 8px; border-radius:6px; font-size:13px` with a
15px icon and the standard active recipe. Five sections and their icons: `Interface` `template`,
`Accounts` `user`, `Sessions` `database`, `Providers` `sparkle`, `Integrations` `link`.

**Right pane.** Head `display:flex; justify-content:space-between; padding: 16px 24px 8px` with
`<h3 style="font-size:16px; font-weight:600">` carrying the section label and a 28px close button. Body
`flex:1; overflow-y:auto; padding: 4px 24px 24px`.

**Setting row pattern**, used for every toggle:
`display:flex; align-items:center; gap:12px; padding: 10px 0;
border-bottom: 1px solid var(--app-border-secondary)` with a `flex:1` text block (title
`font-size:14px; font-weight:500`, description `font-size:12px; color: var(--app-text-secondary)`) and
the control on the right. Note the rule is a **row separator only**, no card, no panel, no grouping box.

Interface section: `Appearance` (description `How the workbook looks on this device`, control is the
`Light` / `Dark` button pair), `Terminal theme` (see 10.6), then three switches:

| Title | Description |
|---|---|
| Pane color highlights | `Each pane slot gets a distinct colored border` |
| Informative density | `Show live counts, activity text, and workspace labels everywhere` |
| Auto-title sessions | `Name new sessions from their conversation content` |

Sessions section, four switches:

| Title | Description |
|---|---|
| Auto-accept trust dialogs | `Answers safe prompts; anything mentioning deletes or credentials waits in Attention` |
| Completion notifications | `Notify when a running session goes idle or needs input` |
| Confirm before closing live sessions | `Ask before killing a running terminal` |
| Conflict detection | `Warn when two running sessions edit the same files` |

Accounts section: an intro paragraph at `font-size:12px; color: var(--app-text-secondary);
padding: 4px 0 10px`, text
`Credentials found on this machine. The active account is used for new sessions; switching applies on the next launch.`
Then credential rows at `display:flex; align-items:center; gap:12px; padding: 10px 8px;
border-radius:6px; cursor:pointer` with hover wash: a 28px `nt-avatar` in a hue class, a text block
(name at 14px / 500 plus a `nt-chip nt-chip-gray` plan chip on the same line, meta at 12px secondary),
and a trailing `Active` or `Re-login` status chip. A warning row is `opacity: 0.7`. Footer line at
`padding: 8px; font-size:12px; color: var(--app-text-tertiary)`:
`Usage of the active account — Session 42% · Opus 67% · Fable 12%, resets 2h 14m`.

**Providers and Integrations have no body.** The mock's `settingsNav` select handler explicitly refuses
to switch to them:
`select: () => this.setState({ settingsSection: ['interface','accounts','sessions'].includes(n.id) ? n.id : s.settingsSection })`.
They exist in the nav as a promise, not as a screen. See section 15.

---

## 14. Mobile

Source: `Myrlin Workbook Mobile (Notion Redesign).dc.html`. Two screens at `390 x 844`, presented side
by side inside device frames (`border-radius:24px; border: 1px solid var(--app-border-primary);
box-shadow: 0 8px 30px rgba(0,0,0,0.08)`) on an `--app-bg-tertiary` ground. The frame and its shadow are
presentation chrome for the mock and are not part of the app.

### 14.1 Shared mobile chrome

- Header: `height:50px; min-height:50px; padding: 0 12px` (or `0 8px` on the terminal screen), `gap`
  8 to 10px, `border-bottom: 1px solid var(--app-border-secondary)`.
- Icon buttons: `32px` square, `border-radius:6px`, transparent, `color: var(--app-text-secondary)`,
  icons at 16 to 18px. Larger than the 26 to 28px desktop equivalents; this is the intended touch
  scaling.
- Bottom tab bar: `height:64px; background: var(--app-bg-primary);
  border-top: 1px solid var(--app-border-primary)`. Five equal `flex:1` tabs, each a centered column
  with `gap:3px`, a 20px icon, and a 10px / 500 label. Active `color: var(--app-text-primary)`,
  inactive `color: var(--app-text-tertiary)`. **No pill, no fill, no indicator bar**; ink alone marks
  the active tab. Tabs: `Home`, `Sessions`, `Terminal`, `Attention` (badge), `Search`.
- Tab badge: `position:absolute; top:8px; right: calc(50% - 18px); min-width:15px; height:15px;
  padding: 0 4px; border-radius:8px; background: var(--app-text-red); color: #fff; font-size:9px;
  font-weight:700; display:grid; place-items:center`. Note this badge is a **solid red fill with white
  text**, unlike the desktop sidebar badge which is a red **wash** with red ink. Both are in the design;
  the mobile one has to survive at 15px.

### 14.2 Home / Sessions screen

Header: workspace tile (`24px`, `border-radius:5px`, `background: var(--app-bg-purple)`, 14px emoji),
title `Myrlin's Workbook` at 15px / 600, a 32px search button, and a 26px `nt-avatar nt-avatar-sm
nt-avatar-purple` at 11px.

Scroll body: `flex:1; overflow-y:auto; padding: 12px 16px 76px` (the 76px bottom pad clears the
absolutely positioned tab bar).

1. Attention banner: `display:flex; align-items:center; gap:8px; padding: 8px 10px; border-radius:8px;
   background: var(--app-bg-yellow); margin-bottom:14px` with a `7px` pulsing dot in
   `var(--app-text-yellow)`, the text `2 sessions need your input` at `font-size:13px;
   color: var(--app-text-yellow); font-weight:500`, and a 14px chevron in the same yellow. This is the
   block-palette callout idiom: a hue **wash** with hue **ink**, no border, no icon container.
2. Section label `Active now`: `font-size:12px; font-weight:500;
   color: var(--app-sidebar-section-label); padding: 2px 2px 6px`.
3. Active session cards: `display:flex; align-items:center; gap:12px; padding: 11px 10px;
   border-radius:8px; border: 1px solid var(--app-border-primary); margin-bottom:8px` with an `8px`
   pulsing dot, a text block (title 14px / 600 ellipsized, meta `{emoji} {project} · {activity}` at 12px
   secondary with `margin-top:1px`), and a provider chip.
4. Section label `Recent` with `padding: 12px 2px 6px`.
5. Recent rows: `padding: 10px; border-radius:8px` with hover wash, a `7px` static
   `var(--app-text-gray)` dot, title 14px / 500, meta `{emoji} {project}` at 12px tertiary, and a
   trailing relative time at 12px tertiary. **Bordered cards for live things, borderless rows for
   history** is the distinction being drawn.

### 14.3 Terminal screen

Header: 32px back chevron, a two-line title block (row one: `7px` pulsing green dot plus the session
name at 14px / 600; row two: `🛠️ Myrlin Features · Opus 4.6` at `font-size:11px;
color: var(--app-text-tertiary)`), a provider chip, and a 32px overflow button.

Pane switcher strip: `display:flex; gap:6px; padding: 8px 12px;
border-bottom: 1px solid var(--app-border-secondary); overflow-x:auto`. Each chip:
`display:inline-flex; align-items:center; gap:6px; padding: 4px 10px; border-radius:6px;
font-size:12px; font-weight:500; white-space:nowrap` with a `6px` status dot. Active:
`background: var(--app-bg-tertiary); color: var(--app-text-primary);
border: 1px solid var(--app-border-primary)`. Inactive: `background: transparent;
color: var(--app-text-secondary); border: 1px solid transparent`. This is the mobile translation of the
desktop pane grid: the multi-pane grid collapses to one visible pane plus a horizontal chip switcher.

Terminal body: `flex:1; overflow-y:auto; padding: 12px 14px; background: {{ termBg }};
font-family: var(--font-mono, 'iA Writer Mono', ui-monospace, monospace); font-size:12px;
line-height:1.7; color: {{ termInk }}`. Indent pads shrink to `14px` / `24px` from the desktop
`16px` / `28px`.

Key toolbar: `display:flex; gap:6px; padding: 8px 10px;
border-top: 1px solid var(--app-border-secondary); overflow-x:auto;
background: var(--app-bg-secondary)`. Seven buttons, all `flex-shrink:0`: `Enter` as
`nt-btn nt-btn-app`, then `Tab`, `Esc`, `Ctrl+C`, `↑`, `↓`, `Copy` as `nt-btn nt-btn-app-secondary`.

Input row: `display:flex; align-items:center; gap:6px; padding: 8px 12px 10px;
background: var(--app-bg-secondary)`. Text input `flex:1; padding: 9px 12px;
border: 1px solid var(--app-border-primary); border-radius:8px; background: var(--app-bg-primary);
color: var(--app-text-primary); font-size:14px` with placeholder `Message Claude…`. Two 36px buttons
(image, microphone) at `border: 1px solid var(--app-border-primary); border-radius:8px;
background: var(--app-bg-primary)`. Then `<button class="nt-btn nt-btn-app" style="height:36px">Send</button>`.

**Mobile input row differs from desktop deliberately.** Desktop puts the input row *inside* the
terminal palette with a `❯` prompt and borderless field. Mobile puts it on `--app-bg-secondary` with a
bordered field, larger targets, and an explicit Send button, because a phone has no Enter key in view
and no hover.

### 14.4 The mobile terminal palette discrepancy (resolve before building)

The mobile mock does **not** use the thirteen palettes. It computes:

```js
const termBg  = dark ? '#262626' : '#f5f2f0';   // --app-bg-interactive / --app-code-block-bg
const termInk = dark ? '#e6e5e3' : '#2c2c2b';   // --app-icon-primary / --app-text-primary
const termDim = dark ? '#9b9b9b' : '#7d7a75';   // --app-sidebar-section-label / --app-text-secondary
```

That is Notion's own code-block treatment, not a terminal theme. The `Feature Inventory.md` theme row
says the palettes "drive every terminal surface", and the desktop mock honors that. **Treat the mobile
mock as under-specified rather than as a contradicting decision: apply the selected terminal palette on
mobile exactly as on desktop.** The Notion code-block values above are the correct fallback for the one
case the desktop mock also lacks, which is a terminal-adjacent surface where no palette applies.

---

## 15. What the mock does NOT draw

Everything below has no visual specification in either mock. For each, the implementer must restyle the
existing Workbook surface into this design language using the primitives in sections 1 to 12, rather
than copying mock structure. The `Where` column of `Feature Inventory.md` is the authoritative statement
of intent and is quoted where it exists.

### 15.1 Not built at all (Feature Inventory `○`)

| Feature | Inventory note | How to restyle it |
|---|---|---|
| Account panel machines strip (PC / Mac sync), pending per-machine selections | `Noted; needs multi-machine model` | Extend the account popover (8.1) with a third block below the credential rows: a section divider, a `--app-sidebar-section-label` header, then rows using the credential-row geometry with a machine glyph in place of the avatar. |
| Per-project notes board (More menu > Docs / Project Notes) | `Peek Notes covers per-session notes; per-project notes board not built` | Use the peek Notes treatment (borderless, groundless, 14px / 1.5) inside a project peek that reuses the session peek frame verbatim. |
| System Resources panel (More menu > Resources, auto-refresh) | `Not built` | A Costs-style page: 1100px measure, stat cards at `border: 1px solid var(--app-border-primary); border-radius:8px; padding: 14px 16px`, and the 5px meter bar for each gauge. |
| Provider tabs above Projects in the sidebar | `Provider chips shown per-row instead` | Do not build the tabs. Put a `nt-chip nt-chip-purple` / `nt-chip-green` on the row instead. This is a deliberate removal. |
| Collapse sidebar toggle | `Drag-resize built; collapse toggle not` | If needed, animate `width` with `--motion-sidebar` (`width 200ms`) to `--app-sidebar-peek` (20px). Never a hamburger overlay. |
| 6-pane layouts | `Lives as a task card on the board` | Deliberately deferred. The grid recipe in 5.2 already generalizes: keep `grid-auto-rows: 1fr` and extend the column expression. |
| Pane fullscreen and per-pane font size | `Not built` | Add to the pane `⋯` menu (8.2 menu recipe). Fullscreen is a layout change, not a modal. |
| Rich notes editor (bold / italic / lists / checklist toolbar) | `Plain textarea for now` | If built, use `.nt-toolbar` from `components.css` line 559: one row, 33px tall, elevated, `--app-shadow-menu`, hairline separators, active buttons in `--app-ui-blue`. |
| Bulk select / stop selected | `Attention "Stop all" covers the common case` | If built: a checkbox column in `nt-table` using `.nt-checkbox`, and a selection action bar in the toast position and toast styling. |
| PR creation dialog | `Push toasts "open a PR"; dialog not built` | Standard dialog recipe (8.3) at 480px with title / body / base fields. |
| Task spinoff dialog | `Not built` | Same recipe. |
| `td` integration (issues tab, issue detail, promote to worktree) | `Settings toggle exists; td panel not built` | Issues as a second `nt-table` view under Agent tasks; issue detail in the peek frame. |
| Agent-task Git tab and Files tab | `Placeholders in original too` | Leave as placeholders or use `.nt-empty`. |
| Folder browser modal | `Select stand-in` | Dialog recipe, with rows on the menu-row geometry (28px, 4px radius, hover wash). |
| Update Myrlin modal | `Not built` | Dialog recipe, 480px, one paragraph, two buttons. |
| Pair Mobile Device (QR / manual, cloudflared tunnel) | `Mobile screens exist; pairing modal not built` | Dialog recipe; the QR sits on `--app-bg-primary` with no frame and no shadow. |
| UI scale (85 to 120 percent) | `Not built` | Every value in this spec is px. A scale control must be a root `zoom` or a `--root-font-size` change, not a second token set. |
| Mobile pair device / remote access | `Not built` | Follow the pairing dialog above; on mobile it is a full-screen sheet, not a centered modal. |

### 15.2 Partially covered or merged elsewhere (Feature Inventory `◐`)

| Feature | What the mock actually gives you | What is missing |
|---|---|---|
| Account provider tabs (Claude / Codex) | A single credential list with provider chips per row | No tabbed split. If the real app needs one, use the pill-tab recipe (5.1), not underlined tabs. |
| Session manager overlay (Select All / Stop Selected / filter tabs) | The attention popover with `Stop all` | No bulk checkbox selection surface. |
| Conflict Center overlay | A `Conflict detection` switch in Settings > Sessions | No overlay is drawn. Build it on the popover recipe with rows in the attention-row geometry. |
| More menu > Recent | The Sessions table `Last active` column, sorted | No separate Recent view. |
| Refresh projects / New project buttons | The project context menu | No always-visible header buttons. If needed, use the hover-revealed `.nt-sidebar-item-controls` pattern (`components.css` line 191): `opacity: 0` until the row is hovered. |
| Projects and Discovered inner split resize | Whole-sidebar drag resize only | No inner splitter. |
| Sidebar filter input | Quick Find | No inline filter field. |
| Find a Conversation (full-text transcript search) | A single footer row in Quick Find advertising it | **No results UI at all.** Build it as a second group in the Quick Find results list with the same uppercase group header and row geometry, plus a snippet line at 12px tertiary. |
| Shift+Enter newline, provider-specific | The `⏎ send` hint text | Real key handling is backend. |
| Provider idle / needs-input detection | Simulated from a status field | The regex detection layer is untouched by the restyle. |
| Workbench empty-state onboarding card | The drop-slot copy | No richer onboarding card. |
| Instance colors (same session in several panes) | Positional tab dots and positional pane border tints | **No per-instance badge.** If built, it belongs in the pane header beside the title, as a `nt-chip` in the slot color, not as a border treatment. |
| Discover sessions on this PC | The sidebar `Discovered on this machine` section | No discovery action UI, no scan progress. |
| Full activity log | The peek `Last output` tail (last 3 lines) | No scrollable log view. If built, use the terminal-surface recipe (5.5) inside the peek. |
| Generic confirm / prompt modal | Toasts plus a `Confirm before closing live sessions` switch | **No confirm dialog is drawn anywhere.** Use the dialog recipe at 480px, body text at 14px secondary, footer right-aligned with `Cancel` (secondary) and the confirming action (`nt-btn-app`), red ink only on the label if destructive. |
| Global search `Ctrl+Shift+F` and Find a Session modal | Merged into Quick Find | One search surface only. |

### 15.3 Present in the mock's own structure but undrawn

- **Settings > Providers** and **Settings > Integrations**: nav rows exist, bodies do not, and the click
  handler refuses to select them.
- **The topbar More button**: rendered, no menu attached.
- **Toast actions**: `.nt-toast-action` exists in the component layer; the mock never renders one.
- **Tooltips**: native `title` only.
- **Skeletons and any loading state**: nothing in the mock loads.
- **`.nt-empty`**: never used, despite three empty states existing.
- **Focus-visible styling**: `:focus-visible` is defined globally in `_ds/styles.css` (a 2px
  `--focus-ring` outline at 2px offset) but the mock adds nothing on top and sets `outline: none` on
  every input. Keyboard focus for the custom controls (pill tabs, menu rows, board cards) is
  **unspecified** and must be designed: use `--app-focus-shadow` on rows and `--app-input-focus-ring`
  on fields.
- **Drag ghost / drag preview styling**: the mock relies on the browser default.
- **Scroll-driven hover gating**: `nt-enable-hover` is set once and never stripped.
- **Error, offline, disconnected and reconnecting states**: none exist in either mock.
- **Login / auth screen**: not drawn.
- **Anything added to the Workbook after the mock was cut** (session mirror and liveness dots, copy /
  select mode, conflict status cache, credential pool passive mode): not drawn. Restyle these from the
  primitives; the liveness dot is the `7px` block-palette dot with `mwPulse 2s`, and a copy-mode banner
  is a block-palette wash strip in the mobile-banner geometry (14.2, item 1).

---

## 16. Interaction idioms and the rejection list

### 16.1 The five idioms this design is built on

1. **Washes, never side accents.** Selection is `background: var(--app-sidebar-item-selected)` plus
   primary ink plus weight 600. Hover is `background: var(--app-wash-hover)`. Press is
   `var(--app-wash-press)`. Table row hover is the fainter `var(--app-wash-table-row-hover)`. There is
   not one left-border accent bar, tab underline, or colored rail anywhere in either mock, and
   `Feature Inventory.md` names this explicitly under "Not carried over (deliberate)": *one-side accent
   highlights (left-border active bars, tab underlines) replaced everywhere with Notion washes and
   pills per direction*.
2. **Pill tabs with positional dots.** Tab groups, session filters, cost periods and terminal-theme
   choices are all the same control: a 6px-radius pill, 13px (12px in settings), weight 600 when
   active, filled with `--app-sidebar-item-selected`. Tab groups additionally carry a `7px` dot whose
   color is derived from **position**, cycling red, yellow, green, teal, blue, purple.
3. **Peeks, not full-page navigation.** Session detail is a resizable side panel that narrows the
   workspace rather than replacing it. The same frame should serve every other detail surface.
4. **Popovers and menus over modals.** Attention, account and every context action are popovers or
   menus anchored to their trigger with a fade at 150ms. Modals are reserved for creation flows
   (New session, New agent task), destructive review (diff), and settings.
5. **Chips carry state and category.** Provider, status, model, tag, plan and template are all chips.
   Property chips are 4px and 20px tall; status chips are 10px pills with a leading 8px `currentColor`
   dot. Never invent a sixth shape.

Supporting behaviors that are part of the design, not implementation detail: drag-and-drop everywhere
(session onto pane, session onto project, tab pill reorder, board card between columns) always shows a
blue affordance (`--app-text-blue` border or outline plus an `--app-bg-blue` fill); double-click renames
in place with a blue-bordered input; every mutation confirms with a bottom-left toast; and chrome sheds
progressively as a pane narrows rather than wrapping or scrolling.

### 16.2 The rejection list

Compiled from `_ds/readme.md` and every `rejection list` marker in the bundle. Any one of these breaks
the Notion read.

**Color and ground**
- A gray or dark sidebar. The sidebar is `#f9f8f7`, warmer than the canvas, not darker
  (`tokens/colors.css` line 420).
- Slate, zinc, or any blue-cast neutral ramp. Notion grays carry a yellow-brown cast
  (`readme.md` item 3).
- Recoloring the named block text palette in dark mode. Those tokens are theme invariant
  (`tokens/colors.css` line 489).
- Building chips out of the block palette, or callouts out of the chip palette. Two systems, never
  merged (`styles.css` line 486, `tokens/colors.css` line 548).
- Quoting the legacy palette (`#337ea9` blue, `#cd3c3a` red, `#f1f1ef` gray) as current. Those survive
  only as `--app-legacy-*` (`readme.md`, "The palette conflict").
- Marketing tokens (`--mkt-*`) on this surface. The Workbook is `data-surface="app"` only.

**Depth and texture**
- Any shadow at 10 percent black or above, any shadow with a hue in it, any glass or blurred nav, any
  gradient, any noise or grain overlay (`tokens/effects.css` lines 20 to 21).
- Depth on the canvas. Blocks, panes and rows have no shadow; only overlays lift.
- A rounded or shadowed cover image (`styles.css` line 378).

**Shape**
- Matching the chip radius to the card radius. 4px against 10px is deliberate; unifying them reads as a
  generic design system (`tokens/spacing.css` line 94).

**Type**
- Loading a webfont into an app-surface body. The editor ships no webfont; Inter on an editor body is
  instantly wrong (`styles.css` lines 20 to 24, `readme.md` item 4).
- Uppercase tracked-out labels. Tracking runs negative at every size above 16px and positive exactly
  once, at the 12px micro step (`readme.md`, Type scale). The single exception in this design is the
  Quick Find group header; do not add a second.
- Shipping italics of the display faces (`readme.md`, Font licenses).

**Motion**
- Reveal on scroll, parallax, fade-up, or any entrance on block insert. Nothing animates on scroll
  (`tokens/motion.css` line 11).
- Fade out faster than fade in. It is 150ms in and 200ms out, in that order.
- A spinner for content loading. Content shimmers; spin is reserved for genuinely indeterminate work
  (`tokens/motion.css` line 13).
- Entrances that move more than 4px, or that scale.

**Structure and affordance**
- Persistent hover handles, or handles that shift the text when they appear. Handles live in the left
  gutter, outside the column, and are invisible until the row is hovered (`styles.css` line 531).
- Uniform list spacing. Consecutive list items collapse from 6px to 1px (`styles.css` line 316). This
  matters in this app for menu rows and property rows.
- A sticky blurred nav (`styles.css` line 564).
- Underlined view tabs. `.nt-tabs` exists in the component layer and is explicitly the wrong choice
  here; this design uses pills.
- A four-column plan grid with a ribbon (marketing only, but the instinct it names, decorating a grid
  with a badge, applies everywhere).
- Line icons in rounded squares as empty-state art (`components.css` line 1236).

---

## 17. Build contract and checklist

**Wire-up order.** Nothing else can be verified until these are true.

1. `<html data-surface="app" data-theme="light|dark">`.
2. Link `_ds/styles.css` (it `@import`s the five token files and `components/components.css`), or inline
   the same six files in that order. `components.css` must come **before** the primitives, exactly as
   `styles.css` does it, because its modifiers are written as double-class selectors that win on
   specificity rather than on order.
3. Copy `_ds/assets/fonts/iAWriterMonoS-*.woff2` and the five `@font-face` blocks. Do not add a body
   webfont.
4. Put `nt-enable-hover` on the shell container and strip it during scroll and drag.
5. Port the two mock keyframes (`mwPulse`, `mwFadein`) and the scrollbar block.

**The nine rules to check any screen against.**

1. No token literal in a component. Every color, radius, duration, shadow and font is a `var()`.
2. Every selected state is `--app-sidebar-item-selected` plus primary ink plus weight 600. Zero left
   borders.
3. Every hover is `--app-wash-hover`, except table rows which are `--app-wash-table-row-hover`.
4. Every hairline inside the app is `--app-border-secondary`; every frame around something is
   `--app-border-primary`.
5. Every overlay is `--app-bg-elevated` at 10px radius with a 150ms fade and a 4px rise.
6. Every icon is a 16-grid, 1.5-stroke, round-cap inline SVG in `currentColor`.
7. Terminal palettes touch terminal surfaces and the prompt only.
8. Status dots are 7px block-palette circles; chip dots are 8px `currentColor` circles. Never mixed.
9. Nothing spins, nothing parallaxes, nothing moves more than 4px on entrance.

**Token map for the existing app.** The current Workbook is built on Catppuccin CSS custom properties.
The migration is a rename plus a re-grouping, not a rewrite:

| Old role | New token |
|---|---|
| `--base` / page ground | `--app-bg-primary` |
| `--mantle` / `--crust` / sidebar | `--app-bg-secondary` |
| `--surface0` / raised | `--app-bg-tertiary` (fills) or `--app-bg-elevated` (overlays) |
| `--text` | `--app-text-primary` |
| `--subtext1` / `--subtext0` | `--app-text-secondary` / `--app-text-tertiary` |
| `--overlay0` borders | `--app-border-primary` (frames) or `--app-border-secondary` (internal rules) |
| `--blue` accent | `--app-ui-blue` for interaction, `--app-text-blue` for semantic ink |
| `--green` / `--yellow` / `--red` / `--teal` / `--mauve` status | `--app-text-green` / `-yellow` / `-red` / `-teal` / `-purple` |
| Any accent used as a left border | delete; replace with `--app-sidebar-item-selected` |
| Terminal colors | the thirteen palettes in section 10.2, unchanged |

Catppuccin does not disappear. It moves: the palettes become the terminal themes, and the chrome becomes
Notion light and dark. That is the whole thesis of the redesign, stated in the last line of
`Feature Inventory.md`.
