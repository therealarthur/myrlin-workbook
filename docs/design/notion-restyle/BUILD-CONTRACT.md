# BUILD-CONTRACT: the executable build contract for the Notion restyle of Myrlin Workbook

| Field | Value |
|---|---|
| Status | Decision ready. Nothing in this file has been applied to source. |
| Date | 2026-08-13 |
| Repo | `C:/Users/Arthur/Desktop/cwm-restyle` |
| Branch | `feat/notion-restyle` (implementation agents work in worktrees off it) |
| Version line | continue `1.3.0-alpha.N`; current on disk is `1.3.0-alpha.10`, so the first phase ships `alpha.11` |
| Audience | Implementation agents with zero prior context. Everything you need is here or at a cited path. |

## Executive summary

1. This document is the single build contract. It synthesises eight analysis documents into one ordered, testable plan and it wins over all of them where they disagree.
2. The restyle is a **Restyle**, not a reskin and not a rebuild. Chrome becomes Notion light and dark. The thirteen Catppuccin-family palettes do not disappear; they move to the terminal surface.
3. The single highest-leverage mechanism is the **alias flip**: Notion `--app-*` tokens carry raw values, and every existing token name survives as an alias pointing at them. No legacy token name is ever deleted.
4. The single hardest constraint is that **CI reads the frontend as text**. 596 assertions across 35 files pin literal selectors, single-line anchors, attribute order and whitespace. A formatter run over `styles.css` breaks about twenty of them.
5. The second hardest constraint is the phantom-token gate: it scans `styles.css` and `styles-mobile.css` **only** as definition sources, so vendored token files cannot be the definition site for anything `styles.css` consumes.
6. Therefore all raw Notion colour, radius, motion and shadow values are authored **into `styles.css` `:root`**, and a new parity test diffs them against the vendored bundle so the duplication can never drift silently.
7. The terminal keeps its own metrics, its own palettes and its own furniture. Terminal palettes never leak into chrome; chrome tokens never leak into the terminal.
8. Codex parity is a backend program, not a restyle task. It runs fully in parallel with the frontend work and gates on one dependency spike.
9. Mobile is an interaction architecture, not a styling pass. The 44px touch floor beats mock fidelity everywhere the two collide.
10. Work is grouped into thirteen phases, `P0` through `P12`. Each phase is independently shippable, independently revertable, and must leave the branch green.
11. The user sees a screenshot-able Notion shell at the end of `P2`, which is the third phase. That is the early-win ordering constraint honoured.
12. Every phase gate is the same three things: `npm test` green at or above baseline, Playwright screenshots at 1280x800 and 390x844, and the DO-NOT-BREAK grep gates.
13. Nothing deploys live without the user seeing screenshots first.
14. Every test-expectation edit ships in the same commit as the source change that caused it, with a one-line reason comment. No assertion is ever deleted to make CI green.
15. Code preservation is absolute: files grow or stay the same size. Retirement is expressed as `RETIRED-with-alias`, never as deletion.

---

## 0. How this contract binds

### 0.1 Authority order

Highest first. If two sources disagree, the higher one wins and the lower one is wrong for this build.

1. The user's live instruction in the current conversation.
2. The global `CLAUDE.md` rules, in particular code preservation, no em dashes, commit and push discipline.
3. This document.
4. `DO-NOT-BREAK.md` and `TEST-CONSTRAINTS.md`. These two are treated as a joint hard floor: this document never lowers them, only raises them.
5. `DESIGN-SPEC.md` for what a region looks like, `PROCEDURE.md` for the order and the accessibility floor, `MOBILE-EXPERIENCE.md` for phone interaction, `TERMINAL-ARCHITECTURE.md` for the terminal, `CODEX-PARITY.md` for the provider.
6. `CURRENT-UI.md` as the factual baseline. Verify against source, do not re-derive.
7. `docs/design/notion-import/_ds/**` as the read-only design bundle and the source of record for token values.

### 0.2 Decisions already taken by the orchestrator, not open for relitigation

| # | Decision |
|---|---|
| D1 | Chrome theming is Notion light and dark, selected by a root attribute, with `data-surface="app"` permanently on `<html>`. The thirteen terminal themes live in the theme registry as terminal-surface palettes driving xterm, the history layer and the prompt accent through **one** `terminalSurface` projection. Chrome tokens stay palette-swappable in architecture through semantic aliases as insurance, but no Catppuccin chrome ships now. |
| D2 | Codex SQLite adds **no new native module**. A small spike compares `sql.js` (WASM) against copy-the-file plus `node:sqlite`. Default to `sql.js` if the spike is ambiguous. Read-only, copy-before-read to dodge WAL locks, and the filesystem walk stays as a union fallback forever. |
| D3 | Terminal history is semantic transcript history with the deliberate one-turn overlap seam. Correctness over cosmetics. All Select v1, v2 and v3 code and tests are preserved additively, rescoped, never deleted. |
| D4 | On mobile the 44px touch floor beats mock fidelity wherever they conflict. The tablet breakpoint is 900px, shipped as a flagged constant that QA revisits with real usage. |
| D5 | Every phase gate includes `npm test` green, Playwright screenshots at 1280x800 **and** 390x844, and the DO-NOT-BREAK grep gates. Nothing deploys live without the user seeing screenshots. |
| D6 | Versioning continues `1.3.0-alpha.N` per phase, `CHANGELOG.md` per phase, one commit per work package with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer, and **no pushes from implementation agents**. The orchestrator pushes. |

### 0.3 Vocabulary used throughout

| Term | Meaning |
|---|---|
| **RETIRED-with-alias** | The token name stays defined, its value becomes `var(<replacement>)`, and its consumption count goes to zero. Nothing is deleted. This is how every "delete this token" instruction in `PROCEDURE.md` is executed under the code-preservation rule. |
| **Re-point** | Change only the right-hand side of a definition. Every call site keeps working untouched. |
| **Sweep** | Mechanically rewrite consumption sites for one token, proven by a grep whose result count must reach a stated number. |
| **Pinned** | A literal string, selector, anchor or attribute order asserted by a test in `test/`. Changing it requires a same-commit test edit with a reason comment. |
| **Sanctioned edit** | A test-expectation edit that `TEST-CONSTRAINTS.md` explicitly anticipates and blesses. Listed by name in section 5.4 so no agent invents one. |
| **WP** | Work package. The unit an implementation agent is given. Sized to one agent, one commit, one file-ownership set. |

### 0.4 The five rules every implementation agent obeys

1. **Never rename or delete an ID** from `DO-NOT-BREAK.md` section A.3 (336 of them). A missing ID is a silent `null` that kills a feature branch at first click.
2. **Never rename a class** from `DO-NOT-BREAK.md` section B.1 (278 of them). Restyle every declaration inside the rule freely. Keep the token present in the `class` attribute.
3. **`[hidden]` must always win.** JS toggles visibility through the `hidden` property 264 times. Any new rule that sets `display:` on such an element needs a paired `[hidden] { display: none !important; }` guard.
4. **Never drop a `data-*` attribute** from `DO-NOT-BREAK.md` section B.2 (93 dataset keys).
5. **Run the gates in section 5 before declaring anything done.** Fifteen test files read production frontend source as text and assert 302 literal anchors.

### 0.5 No servers

No implementation agent starts a dev server, and nothing ever binds port 3456: that port serves a different checkout. Verification uses the existing Playwright harnesses in `test/browser/`, which start and stop their own static servers on ephemeral ports.

---

# 1. THE TOKEN MAP

This is the most load-bearing artifact in the contract. It maps all 104 custom properties currently defined across the four stylesheets, plus the 179 hardcoded-literal sites spanning 124 distinct values, onto Notion semantic tokens, `terminalSurface` slots, or `RETIRED-with-alias`.

## 1.1 The three token families, and why they must not merge

The restyle fails if these three are allowed to blend. Separate them first, then everything else follows.

| Family | Names | Values | Consumed by | Theme axis | Definition site |
|---|---|---|---|---|---|
| **Chrome** | `--app-*`, plus the `--radius-*`, `--duration-*`, `--ease-*`, `--motion-*`, `--font-*` scales | Notion light and dark | every chrome rule in `styles.css`, `styles-mobile.css`, `focused-shell.css`, `semantic-theme.css` | `data-chrome` on `<html>` | `styles.css` `:root` plus one dark block |
| **Terminal palette** | the 24 Catppuccin-family names, redeclared inside all 13 `:root[data-theme="<id>"]` blocks | **unchanged**, per theme | `terminal.js` via `getComputedStyle` only, plus the terminal-furniture inline styles, plus the `terminalSurface` projection | `data-theme` on `<html>`, still one of the 13 persisted ids | the 13 existing theme blocks in `styles.css`, untouched |
| **Semantic roles** | the 28 role tokens in `semantic-theme.css` | now `var(--app-*)` | status chips, attention states, drop targets, focus | follows chrome | `semantic-theme.css`, right-hand sides only |

The base `:root` copies of the 24 palette names also stay, because `theme-registry.test.js` executes `TerminalPane.getCurrentTheme()` and the pre-paint script can transiently run before a `data-theme` block applies. They keep their Mocha values. **Chrome simply stops consuming them.**

### 1.1.1 Why the chrome tokens cannot live in a vendored file

`test/phantom-tokens.test.js` line 34 sets `CSS_FILES = ['styles.css', 'styles-mobile.css']` and uses that pair as **both** the consumption scan and the definition scan. A token defined only in `src/web/public/design/notion/tokens/colors.css` and consumed in `styles.css` is a phantom and turns CI red.

Therefore:

- The vendored bundle under `src/web/public/design/notion/` is **reference plus the `nt-*` paint layer plus the fonts**. Its token files are copied for provenance and are **not linked**.
- Every `--app-*`, `--radius-*`, `--duration-*`, `--ease-*` and `--motion-*` token that any project stylesheet consumes is **authored into `styles.css` `:root`**, with the value copied verbatim from the bundle.
- `test/notion-token-parity.test.js` (new, WP0.4) diffs the `--app-*` and scale definitions in `styles.css` against `design/notion/tokens/*.css` and fails on any value mismatch. Duplication becomes a red CI run instead of silent drift.
- This also satisfies `TEST-CONSTRAINTS` top-10 item 8: all raw colour values live in one `:root` block in `styles.css`; every other file consumes `var()` only.

### 1.1.2 The chrome theme attribute

`data-theme` is already occupied by 13 persisted ids, is read pre-paint from `localStorage.cwm_theme`, drives the 13 palette blocks, is read by `terminal.js:631`, and is pinned by `theme-registry.test.js`. Overloading it with `light` and `dark` would break persistence, the terminal palette and three test files at once.

**Mechanism: a new root attribute `data-chrome`, values `light` and `dark`, persisted under `cwm_chrome`, defaulting from `prefers-color-scheme`.** It is independent of `data-theme` so a light terminal palette on a dark chrome is legal, which `DESIGN-SPEC.md` 10.5 requires.

For bundle compatibility and to honour the literal wording of decision D1, every dark chrome block is written as a two-selector list so both attributes work:

```css
:root[data-chrome="dark"],
:root[data-theme="dark"] { /* --app-* dark values */ }
```

The existing `data-theme-appearance` attribute (`app.js:4753`) stays exactly as it is. It remains the terminal palette's own light/dark signal and is not repurposed. See OQ-1 if the orchestrator wants a different attribute name; the default above ships unless told otherwise.

### 1.1.3 The `<html>` tag

Target markup for `src/web/public/index.html` line 2:

```html
<html lang="en" data-ui-shell="focused" data-surface="app" data-chrome="light">
```

Verified safe: `test/focused-shell.test.js` parses root attributes with an `attribute(tag, name)` regex helper (lines 49 to 56), not with a literal substring match on the whole tag, so added attributes do not break it. `data-chrome` is stamped pre-paint by the existing inline IIFE at `index.html:23-78`, alongside the six attributes it already writes.

## 1.2 Table A: the 24 palette tokens

**Disposition for all 24: retained, values unchanged, consumption in chrome swept to zero.** The "Chrome replacement" column is what a chrome consumption site becomes. Uses are `var()` counts across the four stylesheets from `CURRENT-UI.md` 2.2.

| Old token | Mocha value | Uses | Role it is doing | Chrome replacement | Notes |
|---|---|---|---|---|---|
| `--surface0` | `#313244` | **183** | four jobs, see 1.2.1 | fan-out, see 1.2.1 | The largest single sweep in the project. |
| `--overlay0` | `#6c7086` | **131** | muted text, placeholder, disabled, empty-state copy | `--app-text-tertiary`; placeholders `--app-title-placeholder`; disabled `--app-text-disabled`; passive glyphs `--app-icon-secondary` | |
| `--text` | `#cdd6f4` | **126** | primary ink | `--app-text-primary` | |
| `--surface1` | `#45475a` | **118** | borders, dividers, scrollbar thumb, second elevation | internal hairline `--app-border-secondary`; frame `--app-border-primary`; scrollbar thumb `--app-border-strong`; fill `--app-bg-tertiary` | The frame-versus-hairline split is rule 4 of the nine screen rules. |
| `--mauve` | `#cba6f7` | **116** | brand, focus ring, Claude identity, decorative glow | brand and focus `--app-accent-blue` at rest and `--app-ui-blue` on hover and focus; Claude identity `--app-text-purple`; glow **deleted** | Contested, see 1.9 C1. |
| `--green` | `#a6e3a1` | **111** | success, running, Codex identity, mobile active tab | success and running `--app-text-green`; Codex identity `--app-text-green`; mobile active tab `--app-text-primary` | The mock marks the active mobile tab with ink alone, no colour. |
| `--subtext0` | `#a6adc8` | **96** | secondary label text | `--app-text-tertiary` | Notion collapses this project's four ink steps onto three. |
| `--red` | `#f38ba8` | 66 | error, danger, destructive fill | ink `--app-text-red`; tinted surface `--app-bg-red`; **destructive fill deleted** | There is no destructive button fill in this system. Danger is red ink on a normal control. |
| `--blue` | `#89b4fa` | 62 | info, ports, diff renames, drag affordance | semantic ink `--app-text-blue`; interaction and drop affordance `--app-ui-blue`; tinted surface `--app-bg-blue` | |
| `--base` | `#1e1e2e` | 46 | canvas | `--app-bg-primary` | |
| `--mantle` | `#181825` | 44 | sidebar, header, pane header | sidebar `--app-bg-secondary`; topbar **no background at all**; pane header `--app-bg-primary` with a bottom hairline | The topbar losing its fill is a real visual change; it is `DESIGN-SPEC.md` 4. |
| `--yellow` | `#f9e2af` | 43 | attention, idle, dirty git, conflicts | ink `--app-text-yellow` **only on** `--app-bg-yellow` | Never on the plain canvas. See 1.9 C4. |
| `--surface2` | `#585b70` | 36 | third elevation, hover borders | `--app-border-strong` | |
| `--overlay1` | `#7f849c` | 34 | source of `--text-muted` | `--app-text-tertiary` | |
| `--subtext1` | `#bac2de` | 19 | source of `--text-secondary` | `--app-text-secondary` | |
| `--crust` | `#11111b` | 18 | terminal grid gutter, primary-button ink, deepest bg | grid gutter `--app-bg-primary` with a 12px gap; primary-button ink `--app-on-accent`; deepest bg `--app-bg-tertiary` | `--app-on-accent` is invented, see 1.9 C2. |
| `--peach` | `#fab387` | 17 | output tokens in cost bars, running activity dot | `--app-text-orange` | |
| `--teal` | `#94e2d5` | 10 | push actions, settings result type | `--app-text-teal` | |
| `--lavender` | `#b4befe` | 8 | spinoff loading dots, tag palette | `--app-text-purple` | |
| `--sapphire` | `#74c7ec` | 2 | tag palette only | `--app-text-blue` | |
| `--pink` | `#f5c2e7` | 1 | tag palette, pane slot colour | `--app-text-pink` | |
| `--sky` | `#89dceb` | **0 in CSS** | `_tagColor` in `app.js:7697` only | `--app-text-teal` | Name retained; JS map re-pointed, see 1.8. |
| `--flamingo` | `#f2cdcd` | **0 in CSS** | `_tagColor` only | `--app-text-brown` | Same. |
| `--rosewater` | `#f5e0dc` | **0 in CSS** | xterm cursor at `terminal.js:616` | **stays terminal-only**; `terminalSurface().cursor` owns it | Never enters chrome. |

### 1.2.1 The `--surface0` fan-out

183 sites cannot map to one token. Map on role, per `PROCEDURE.md` 3.3 rule 1. Sweep in this order, each with its own grep and its own commit.

| Role at the call site | How to recognise it | Replacement |
|---|---|---|
| Row hover background | inside a `:hover` on a list, sidebar, menu or result row | `--app-wash-hover` |
| Button hover background | inside a `:hover` on `.btn`, `.btn-icon`, `.btn-ghost` | `--app-wash-button-hover` |
| Table row hover | inside a `:hover` on a `tr` or `.costs-session-row` | `--app-wash-table-row-hover` |
| Pressed or active state | `:active`, or a `.active` / `.selected` / `.is-active` rule | selection `--app-sidebar-item-selected`; momentary press `--app-wash-press` |
| Chip or badge fill | `.session-badge-*`, `.stat-chip`, `.qs-result-type` | property chips `--app-chip-<hue>-fill`; content labels `--app-bg-<hue>` |
| Panel or card fill inside the canvas | `.settings-row`, `.detail-*`, `.costs-card` | **no fill at all**: `--app-bg-primary` plus a `--app-border-primary` hairline |
| Overlay fill | `.modal`, `.context-menu`, `.account-panel`, `.theme-dropdown` | `--app-bg-elevated` |
| Input background | `.input`, `textarea`, `select` | `--app-bg-primary` plus `1px solid --app-border-primary` |
| Track or well | progress tracks, meter tracks, `.docs-*` wells | `--app-bg-tertiary` |

Done criterion for the sweep: `grep -c "var(--surface0)" src/web/public/styles.css src/web/public/styles-mobile.css src/web/public/focused-shell.css` returns 0 outside the 13 theme blocks and outside the terminal-furniture exceptions in 1.7.

## 1.3 Table B: semantic aliases and compatibility aliases

These 16 are the highest-leverage rows in the whole map. Re-pointing them redirects a large share of the 2011 `var()` consumption sites with no call-site churn. Do these first, in `WP1.1`.

| Old token | Current value | Uses | New value | Notes |
|---|---|---|---|---|
| `--bg-primary` | `var(--base)` | 17 | `var(--app-bg-primary)` | |
| `--bg-secondary` | `var(--mantle)` | 10 | `var(--app-bg-secondary)` | Also read by `app.js:4757` to rewrite the `theme-color` meta. |
| `--bg-tertiary` | `var(--crust)` | **0** | `var(--app-bg-tertiary)` | Zero consumers today; re-point and start using it for tracks and wells. |
| `--bg-elevated` | `var(--surface0)` | **0** | `var(--app-bg-elevated)` | Same. This is the correct token for every overlay fill. |
| `--border-subtle` | `rgba(69,71,90,0.5)`, re-derived in `focused-shell.css:26` | 59 | `var(--app-border-secondary)` | Re-derivation in `focused-shell.css` also re-points. Note it is currently a **literal** at `:root`; it becomes a `var()`. |
| `--border-default` | `var(--surface1)` | 7 | `var(--app-border-primary)` | |
| `--text-primary` | `var(--text)` | 72 | `var(--app-text-primary)` | |
| `--text-secondary` | `var(--subtext1)` | 30 | `var(--app-text-secondary)` | |
| `--text-tertiary` | `var(--subtext0)` | 25 | `var(--app-text-tertiary)` | The Latte-only override at `focused-shell.css:30` is **pinned** by `focused-shell.test.js`; keep the rule verbatim. It becomes inert, which is harmless. |
| `--text-muted` | `var(--overlay1)`, re-derived in `focused-shell.css:25` | 36 | `var(--app-text-disabled)` | Notion has a real disabled ink; use it rather than collapsing onto tertiary. |
| `--accent` | `var(--mauve)` | 30 | `var(--app-ui-blue)` | **The cheapest single lever in the project.** It also feeds `--color-focus`, and it is what `focused-shell.test.js` and `mobile-ux-fixes.test.js` pin inside two `:focus-visible` rules, so those two tests stay green with no edit. |
| `--bg-hover` | `var(--surface0)` | 3 | `var(--app-wash-hover)` | Must stay a `var()` alias; `phantom-tokens.test.js` assertion 3 forbids a hex. |
| `--border` | `var(--border-default)` | 7 | `var(--app-border-primary)` | Must stay a `var()` alias. |
| `--surface-1` | `var(--surface0)` | 15 | `var(--app-bg-tertiary)` | Must stay a `var()` alias. Note the near-collision with `--surface1`; do not conflate. |
| `--surface-2` | `var(--surface1)` | 8 | `var(--app-border-secondary)` | Must stay a `var()` alias. |
| `--text-base` | `var(--text)` | 3 | `var(--app-text-primary)` | Must stay a `var()` alias. |

## 1.4 Table C: dimensions, radii, motion, shadows, fonts

| Old token | Current value | Uses | Disposition | New value | Notes |
|---|---|---|---|---|---|
| `--ui-scale` | `1` | 1 | **retained unchanged** | `1` | Consumed by `html { zoom: var(--ui-scale, 1) }` at `styles.css:8218`. **Do not replace `zoom` with `transform: scale()`**: every `getBoundingClientRect()` in the app becomes scaled and the terminal fit breaks (`DO-NOT-BREAK.md` D.11). |
| `--sidebar-width` | `280px` | 1 | re-point | `var(--app-sidebar-width)` = `240px` | The JS drag, its `180..600` clamp and `cwm_sidebarWidth` persistence are unchanged (`DO-NOT-BREAK.md` D.4). `styles.css:2979` resets it to `100%` on mobile; keep that. |
| `--header-height` | `80px` | 3 | re-point for focused, retained for classic | `var(--app-topbar-height)` = `44px` | `getSettingsRegistry` is pinned to omit `headerHeight` for the focused shell and include it for classic, so the classic path keeps a user-settable height. |
| `--radius-xs` | `4px` | 3 | re-point | `var(--radius-property-chip)` = `4px` | |
| `--radius-sm` | `6px` | 46 | re-point | `var(--radius-app-button)` = `6px` | |
| `--radius-md` | `10px` | 25 | re-point | `var(--radius-callout)` = `10px` | |
| `--radius-lg` | `14px` | 7 | re-point | `var(--radius-popover)` = `12px` | 14px does not exist in the Notion editor set. |
| `--radius-xl` | `18px` | 1 | **RETIRED-with-alias** | `var(--radius-callout)` | `PROCEDURE.md` step 4 says delete it; code preservation says retire it. Consumption goes to 0, definition stays. |
| `--transition-fast` | `150ms cubic-bezier(0.16,1,0.3,1)` | **93** | re-point | `var(--duration-150) var(--ease-out)` | `provider-account-tabs.test.js` requires this token to remain defined. Keep the name. |
| `--transition-normal` | `200ms ...` | 2 | re-point | `var(--duration-200) var(--ease-in)` | Fade out is the slower one. Preserve the asymmetry. |
| `--transition-slow` | `300ms ...` | **0** | re-point | `var(--duration-300) var(--ease-in-out-quint)` | Zero consumers today; becomes the transform duration. |
| `--shadow-sm` | 2-layer black | 3 | re-point | `var(--app-shadow-outlined-sm)` | Tooltips only after the elevation sweep. |
| `--shadow-md` | 2-layer black | **0** | **RETIRED-with-alias** | `var(--app-shadow-outlined-sm)` | |
| `--shadow-lg` | 2-layer black | 4 | re-point | `var(--app-shadow-menu)` | Menus, popovers, command palette. |
| `--shadow-xl` | `0 16px 50px rgba(0,0,0,.45), ...` | 7 | re-point | `var(--app-shadow-scrim)` | Modals. `PROCEDURE.md` step 5 says `--shadow-xl` is gone; retire it by alias, not by deletion. |
| `--font-sans` | Plus Jakarta Sans stack | 14 | re-point | `var(--font-app-ui)` | The OS UI stack, verbatim, in source order. Do not reorder and do not trim. |
| `--font-mono` | JetBrains Mono stack | 56 | re-point | `"iA Writer Mono", Nitti, Menlo, Courier, monospace` | Code blocks, IDs, branch names, diff hunks. **Not** the terminal. |

**New tokens introduced at `styles.css` `:root` alongside these**, with values copied verbatim from the bundle: the full `--app-*` set from `design/notion/tokens/colors.css` (approximately 120 names), the `--radius-*` set from `spacing.css`, the `--duration-*`, `--ease-*` and `--motion-*` sets from `motion.css`, `--font-app-ui`, `--font-mono`, `--font-code`, `--font-serif` from `typography.css`, and the `--app-shadow-*`, `--app-focus-shadow`, `--app-input-focus-ring`, `--app-input-error-ring`, `--app-sidebar-edge` set from `effects.css`. Only the names actually consumed need to ship; the parity test asserts that whatever ships matches the bundle.

**Three invented tokens**, each requiring an `INVENTIONS.md` row:

| Token | Value | Why |
|---|---|---|
| `--app-on-accent` | `#ffffff` in both themes | `nt-btn-app` needs white ink on the theme-invariant `--app-accent-blue`. The bundle uses `--mkt-white`, but marketing tokens are on the rejection list for this surface, and `--app-text-inverse-primary` is `#191919` in dark, which would be unreadable. See 1.9 C2. |
| `--app-scrim` | `rgba(15,15,15,0.55)` | The mock's modal scrim, darker than the bundle's `--app-image-overlay`. `DESIGN-SPEC.md` 8.3 says follow the mock because Workbook modals sit over a dense app, not over a document. |
| `--app-terminal-gutter` | `var(--app-bg-primary)` | The terminal grid gutter. Named so a future decision to tint it does not require touching every grid rule. |

## 1.5 Table D: provider accent tokens

| Old token | Current value | Uses | New value | Test consequence |
|---|---|---|---|---|
| `--provider-claude-accent` | `var(--mauve)` | 11 | `var(--app-text-purple)` | `css-tokens.test.js` rows 1 and 4 pin `var(--mauve)`. **Sanctioned edit**, see 5.4 SE-1. |
| `--provider-codex-accent` | `var(--green)` | 13 | `var(--app-text-green)` | Same, SE-1. |
| `--provider-gemini-accent` | `var(--blue)` | 5 | `var(--app-text-blue)` | Same, SE-1. Reserved and unused, but must still exist. |
| `--provider-claude-tint` | `color-mix(in srgb, var(--mauve) 10%, transparent)` | 1 | `color-mix(in srgb, var(--app-text-purple) 10%, transparent)` | The `color-mix(in srgb, var(--X) N%, transparent)` **shape is mandatory**; only the inner token changes. |
| `--provider-codex-tint` | same with `--green` | 1 | same with `--app-text-green` | |
| `--provider-gemini-tint` | same with `--blue` | **0** | same with `--app-text-blue` | |

Two further pinned artifacts move with these and must be edited in the same commit:

- `provider-label-pill.test.js` pins `color-mix(in srgb, var(--mauve) 8%, var(--bg-primary))` and the `--green` equivalent at **exactly 8 percent**, and `border-top: 4px solid var(--provider-claude-accent)` at **exactly 4px**. The 4px top border is a one-side accent bar, which is on the rejection list. It becomes `1px solid` plus the pane-colour tint from `DESIGN-SPEC.md` 5.3. Sanctioned edit SE-2.
- `css-tokens.test.js` row 10 pins `linear-gradient(180deg, var(--provider-claude-tint) 0, transparent Npx)`. Gradients are on the rejection list. The gradient is replaced by a flat `--provider-claude-tint` fill on the pane header. Sanctioned edit SE-3.

Note the internal tension `TEST-CONSTRAINTS.md` flags: `css-tokens.test.js` lets the tint percentage drift while `provider-label-pill.test.js` pins 8 percent. **Change both or neither.**

## 1.6 Table E: the semantic role layer

`semantic-theme.css` is the correct hook point and the cheapest rollback lever: reverting this one 93-line file plus the root attributes returns the app to Catppuccin even if every other step has landed. Two hard constraints govern it, both pinned by `experience-ux-contract.test.js`:

- It must define all 15 named tokens listed in the test, unchanged names.
- It must contain **zero raw colours**. The regex `#[0-9a-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(` must not match. Every right-hand side is a `var()` or a `color-mix()` over `var()`s.

| Old token | Current value | Uses | New value |
|---|---|---|---|
| `--surface-canvas` | `var(--base)` | 5 | `var(--app-bg-primary)` |
| `--surface-sidebar` | `var(--mantle)` | **0** | `var(--app-bg-secondary)` |
| `--surface-raised` | `var(--surface0)` | 4 | `var(--app-bg-elevated)` |
| `--surface-interactive` | `color-mix(--surface1 42%, transparent)` | 5 | `var(--app-wash-hover)` |
| `--surface-selected` | `color-mix(--accent 12%, --base)` | 2 | `var(--app-sidebar-item-selected)` |
| `--color-focus` | `var(--accent)` | 10 | `var(--app-ui-blue)` (unchanged text, follows the `--accent` re-point) |
| `--color-info` | `var(--blue)` | 1 | `var(--app-text-blue)` |
| `--color-attention` | `var(--yellow)` | 2 | `var(--app-text-yellow)` |
| `--color-success` | `var(--green)` | 3 | `var(--app-text-green)` |
| `--color-danger` | `var(--red)` | 2 | `var(--app-text-red)` |
| `--color-stale` | `var(--overlay1)` | 1 | `var(--app-text-brown)` |
| `--status-needs-input` | `var(--color-attention)` | 4 | unchanged text |
| `--status-running` | `var(--color-info)` | 9 | unchanged text |
| `--status-complete` | `var(--color-success)` | 2 | **`var(--app-text-teal)`** |
| `--status-failed` | `var(--color-danger)` | 3 | unchanged text |
| `--status-stale` | `var(--color-stale)` | 3 | unchanged text |
| `--status-*-surface` (5) | 10 to 12 percent `color-mix` | 1 total | `var(--app-bg-yellow)`, `var(--app-bg-green)`, `var(--app-bg-teal)`, `var(--app-bg-red)`, `var(--app-bg-brown)` respectively |
| `--action-warning` / `--action-success` / `--action-danger` | role aliases | **0** each | `var(--app-text-orange)` / `var(--app-text-green)` / `var(--app-text-red)` |
| `--selection-bg` | `color-mix(--color-focus 25%, transparent)` | 1 | `var(--app-selection-token)` = `rgba(35,131,226,0.14)` |
| `--drop-target-bg` | `color-mix(--color-focus 6%, --surface-canvas)` | 1 | `var(--app-bg-blue)` |
| `--resize-handle-hover` | `color-mix(--color-focus 44%, transparent)` | 1 | `color-mix(in srgb, var(--app-ui-blue) 28%, transparent)` per `DESIGN-SPEC.md` 3.7 |
| `--focus-ring` | `0 0 0 2px canvas, 0 0 0 4px focus` | **0** | `var(--app-focus-shadow)` |
| `--attention-color` | set per `.attention-state[data-attention-state]` | scoped | unchanged mechanism; the five rules keep their exact selector text, pinned |

`--status-complete` moving from green to teal is a deliberate change: `DESIGN-SPEC.md` 6 gives running green and complete teal, and merging them loses a state distinction the status system depends on. `experience-model.js` already models five attention states and is pinned to exactly five; this only changes the hue, not the count.

The `@media (forced-colors: active)` block at `semantic-theme.css:82-93` must survive verbatim and be **extended** to every new component (accessibility floor A9). Extension list in 5.3.

## 1.7 Table F, G: focused-shell tokens, JS-set dynamic tokens, and terminal furniture

| Old token | Current value | Uses | New value |
|---|---|---|---|
| `--focused-header-height` | `58px` | 5 | `var(--app-topbar-height)` = `44px` |
| `--focused-sidebar-width` | `264px` | 1 | `var(--app-sidebar-width)` = `240px` |
| `--focused-control-height` | `34px` | 3 | `var(--app-icon-button-size)` = `28px` desktop; `44px` under `@media (pointer: coarse)` |
| `--focused-content-max` | `1120px` | **0** | `1100px`, the Sessions and Costs measure from `DESIGN-SPEC.md` 6 and 9.2 |

The eight JS-set dynamic tokens are **retained with their setter mechanism unchanged**, because `phantom-tokens.test.js` allow-lists them by name and requires each to still be consumed. Only the values the setters write change.

| Token | Setter | Value change |
|---|---|---|
| `--ws-color` | `app.js` `renderWorkspaces` | now emits `var(--app-text-<hue>)`, see 1.8 |
| `--ws-group-color` | `app.js` `renderWorkspaces` | same |
| `--group-color` | `app.js` workspace-group-header | same |
| `--tab-color` | `app.js` terminal group tab | same |
| `--folder-color` | `app.js` `.tab-folder-header` | same |
| `--c-outer` / `--c-inner` | `app.js:5519-5520` instance pip | same |
| `--vh` | `app.js:1561` | unchanged mechanism; **keep both the `100vh` and `100dvh` fallbacks and the token name** |

**Terminal furniture keeps the legacy palette tokens.** The Copy view, the Select-mode strip, the Reader overlay and the one-time copy hint are terminal-surface objects, not chrome. `TERMINAL-ARCHITECTURE.md` 10.4 states this explicitly. Their inline `style.cssText` strings keep `var(--mantle, #181825)`, `var(--surface0, ...)`, `var(--surface1, ...)`, `var(--text, ...)` and `var(--mauve, ...)`, which is exactly what `terminal-select-v2.test.js` pins. No edit, no risk.

Two exceptions inside that furniture that **must** change, because the webfont they name stops loading in `P1`:

| Site | Current | Change to | Pinned? |
|---|---|---|---|
| `terminal.js:4047` Select strip | `font: 11px/1.4 'Plus Jakarta Sans'` with **no fallback** | `font: 11px/1.4 var(--font-sans, ui-sans-serif)` | No. Safe. |
| `terminal.js:4306` Copy view bar | `font: 600 12px/1.4 'Plus Jakarta Sans'` | `font: 600 12px/1.4 var(--font-sans, ui-sans-serif)` | No. Safe. |
| `terminal.js:4382` Copy view `<pre>` | `font: 12px/1.5 'JetBrains Mono', ...` | `font: 12px/1.5 var(--font-code, ui-monospace, monospace)` | **Yes.** `terminal-select-v2.test.js` pins the literal `JetBrains Mono`. Sanctioned edit SE-4. |

Without the first two changes, deleting the Google Fonts link leaves those two strings with no fallback family and both surfaces fall back to Times. This is a real bug the font step would otherwise introduce.

## 1.8 The JS colour maps: token names, not values

Five maps in JS build `var(--<name>)` strings by concatenation. A palette rename breaks them silently, and leaving them pointed at the palette leaks the terminal theme into the chrome, which `DESIGN-SPEC.md` 10.4 forbids.

**Mechanism: keep the pinned name arrays exactly as they are, and add a separate name-to-token map used only at string-build time.**

| Source | Array | Disposition |
|---|---|---|
| `instance-colors.js:17` `TAB_COLORS` | `red, yellow, green, teal, blue, mauve` | **Array literal unchanged.** `instance-colors.test.js` pins the six entries and the first five by index. Add `TAB_COLOR_TOKENS = { red:'--app-text-red', yellow:'--app-text-yellow', green:'--app-text-green', teal:'--app-text-teal', blue:'--app-text-blue', mauve:'--app-text-purple' }` and build the `var()` string from it. Verified safe: the test pins the array values and the modulo-6 wraparound, not the emitted string. |
| `app.js:247` `PANE_SLOT_COLORS` | `mauve, blue, green, peach, red, pink` | Same pattern. `DESIGN-SPEC.md` 5.3 gives the pane slot order as purple, blue, green, orange; extend with red and pink for slots 5 and 6. |
| `app.js:7697` `_tagColor` palette | `teal, pink, sky, peach, lavender, flamingo, sapphire, rosewater` | Same pattern, mapping to teal, pink, teal, orange, purple, brown, blue, brown. These are user-authored tags, so per `PROCEDURE.md` 3.3 rule 5 they are **content labels** and use the named block palette, not the chip palette. |
| `app.js:20200` `FOLDER_COLORS` | `mauve, blue, green, peach, red, pink, teal, yellow` | Same pattern. |
| `app.js:12989` `colorMap[ws.color]` | workspace colour picker, see `styles.css:3423-3462` | Same pattern; the picker swatches also re-point. |

## 1.9 Contested mappings, with rationale

| # | Contest | Options | Decision and reason |
|---|---|---|---|
| **C1** | `--mauve` is doing three jobs at once: brand identity, focus ring, and Claude provider identity. | (a) map all three to the Notion blue, (b) map all three to Notion purple, (c) split by role. | **(c).** `PROCEDURE.md` 3.3 rule 1 is explicit: never map one-to-one on hue alone, map on role. Brand and focus become `--app-ui-blue` because the app surface's brand hue is `#2383e2`. Claude identity becomes `--app-text-purple` `#9a6bb4` because provider identity is a **content label**, which is what the named block palette is for. Mapping Claude to blue would collide with focus and with the drag affordance; mapping brand to purple would ship the wrong brand blue. |
| **C2** | Ink on the primary blue button. | (a) `--mkt-white`, which is what the bundle's `nt-btn-app` uses, (b) `--app-text-inverse-primary`, (c) a new token. | **(c) `--app-on-accent: #ffffff`, invented.** (a) is a marketing token and `DESIGN-SPEC.md` 16.2 puts `--mkt-*` on this surface on the rejection list. (b) resolves to `#191919` in dark, which would be near-black ink on a mid blue and fails contrast. `--app-accent-blue` is theme invariant, so its ink must be too. Requires an `INVENTIONS.md` row. |
| **C3** | Sidebar width. | `DESIGN-SPEC.md` 3 says the mock initialises at 244px; `LAYOUT.md` 1.7 and `PROCEDURE.md` step 6 say 240px. | **240px.** `LAYOUT.md` is the measured brand value and the mock's 244 is an unexplained prototype default. The 4px difference is recorded in `DEVIATIONS.md`. The JS drag clamp stays `180..600` (`DO-NOT-BREAK.md` D.4), **not** the mock's 200 to 420, because narrowing an existing clamp would invalidate persisted `cwm_sidebarWidth` values. |
| **C4** | Warning orange and yellow as small text. | Use `#d27b2d` on the canvas, or darken it, or re-pair it. | **Re-pair, never darken.** `#d27b2d` on `#ffffff` measures about 3.1:1 and the floor is 4.5:1. `PROCEDURE.md` 4.2 is explicit that the mapping is wrong, not the standard, and that darkening a captured brand token is forbidden. Every warning ink sits on its matching `--app-bg-<hue>` wash. Where an orange must sit on the plain canvas as small text, drop to `--app-ink` and carry the signal with an icon plus the tinted surface. Each instance gets a `DEVIATIONS.md` row and an inline CSS comment. |
| **C5** | The complete status hue. | Keep green (today), or teal (`DESIGN-SPEC.md` 6). | **Teal.** Green is running. Merging them destroys a state distinction that `experience-model.js` models and that the sidebar dots, the table chips and the attention list all read. |
| **C6** | Sidebar right edge. | `border-right` (the mock) or `--app-sidebar-edge` inset shadow (`LAYOUT.md` 1.7, which calls a bordered sidebar a rejection-list item). | **The inset hairline.** A border shifts layout by 1px and `DO-NOT-BREAK.md` D.4 makes the sidebar's own `width` the JS-controlled dimension; adding a border changes what `getBoundingClientRect().width` returns relative to `style.width` and desynchronises the drag. The inset shadow costs zero layout width. |
| **C7** | Whether the 13 theme blocks keep their `::selection`, `.stat-dot-running`, drag-over and resize-handle tails (48 literal rules). | Delete as dead weight (`CURRENT-UI.md` 3.2 suggests it) or retire in place. | **Retire in place.** `data-ui-shell` is always set, so `semantic-theme.css:44-60` always wins already. Re-point the 48 rules to tokens rather than deleting them, per code preservation. Their literal count drops to zero; their rule count does not. |
| **C8** | Where `--app-*` values are defined. | The vendored bundle (clean) or `styles.css` `:root` (duplicated). | **`styles.css` `:root`.** Forced by `phantom-tokens.test.js`. Drift is mitigated by the new parity test, not by hoping. See 1.1.1. |

## 1.10 The 179 literal sites, 124 distinct values

`CURRENT-UI.md` 4 is the census. Destinations below. Line numbers are from that document; verify before editing, do not trust them blind.

### 1.10.1 The Mocha bleed (highest risk: every non-Mocha theme is already slightly wrong today)

| Literal family | Palette equivalent | Count | Destination |
|---|---|---|---|
| `rgba(203,166,247,α)` | `--mauve` | 26 | focus and brand alphas to `--app-ui-blue`; drop and drag affordance to `--app-bg-blue`; Claude tint to `--provider-claude-tint`; **every glow deleted** (rejection list: no gradient, no glow) |
| `rgba(166,227,161,α)` | `--green` | 15 | wash to `--app-bg-green`, ink to `--app-text-green` |
| `rgba(243,139,168,α)` | `--red` | 14 | `--app-bg-red` / `--app-text-red` |
| `rgba(249,226,175,α)` | `--yellow` | 13 | `--app-bg-yellow` / `--app-text-yellow`, subject to C4 |
| `rgba(137,180,250,α)` | `--blue` | 10 | `--app-bg-blue` / `--app-text-blue` |
| `rgba(148,226,213,α)` | `--teal` | 5 | `--app-bg-teal` / `--app-text-teal` |
| `rgba(250,179,135,α)` | `--peach` | 3 | `--app-bg-orange` / `--app-text-orange` |
| `rgba(108,112,134,0.15)` | `--overlay0` | 1 | `--app-bg-gray` |
| `rgba(69,71,90,0.4)` | `--surface1` | 1 | `--app-border-secondary` |
| `rgba(17,17,27,α)` | `--crust` | 4 | modal scrim to `--app-scrim`; other uses to `--app-bg-tertiary` |
| `rgba(205,214,244,α)` | `--text` | 2 | `--app-text-primary` |

Concentrated families to sweep as units: status dots and badges (`styles.css:395-514`), session inline badges (456-514), the login glow (656-754), quick-switcher result type chips (2559-2572), worktree review buttons (2684-2736), diff file status and line backgrounds (7064-7175), resource action buttons (7921-7948), port and git badges (8011-8040), and the RGB border-glow keyframes (8075-8082, **deleted**: it is an entrance and a glow, both on the rejection list).

### 1.10.2 The rest

| Site | Current | Destination |
|---|---|---|
| `styles.css:4586, 4590, 4594, 4621` | Latte-family rgba patches that exist only to fix the Mocha literals above | Neutralise to tokens once the literals are gone. Retire the rules, do not delete them. |
| `styles.css:5062-5065` `.board-card-priority-*` | Latte hex used as **dark**-theme backgrounds, a pre-existing bug | `--app-bg-red`, `--app-bg-orange`, `--app-bg-blue`, `--app-bg-gray`. Fixes the bug. |
| The per-theme 48-rule tail | 12 themes x 4 rules of literal rgba | Re-point to tokens, per C7. |
| 15 shadow-alpha sites `rgba(0,0,0,0.15..0.45)` | ad hoc depth | `--app-shadow-*` per `PROCEDURE.md` step 5. Expect to delete more shadows than you replace: the canvas has zero depth and only overlays lift. |
| `styles.css:887, 1179, 1474` `rgba(255,255,255,0.025..0.04)` | white-alpha hover washes, invisible on the three light themes | `--app-wash-hover`. Fixes the bug. |
| `styles.css:5473` `#000` | `.instance-indicator-inner` divider | `--app-divider` |
| `styles-mobile.css:1116-1117` `#000` | mask gradients | Keep. Masks are not colour. |
| `app.js:30-95` | two full boot-failure screens with 8 Catppuccin hexes | **Keep the literals** (they render when `styles.css` may not have loaded) and restyle to Notion neutrals: ground `#ffffff`, ink `#2c2c2b`, danger `#cf5148`, muted `#7d7a75`, border `#e6e5e3`. |
| `app.js:2000-2002`, `4130`, `16768`, `25461` | `var(--token, #hex)` fallbacks and console styling | Update the fallback hexes to the Notion equivalents. Harmless either way. |
| `index.html:314-327` | 13 `.theme-swatch` inline backgrounds | **Keep verbatim.** These are literal previews of the 13 terminal palettes and the palette set is unchanged. |
| `index.html:6` | `<meta name="theme-color" content="#1e1e2e">` | The light and dark pair from `MOBILE-EXPERIENCE.md` F.2, plus the runtime sync helper. `app.js:4757-4762` currently rewrites it from `--bg-secondary`; re-point that to the chrome theme. |
| `terminal.js:223-421` | 8 static xterm palettes, 264 hex literals | **Unchanged.** These are the terminal palettes and `theme-registry.test.js` pins all 13 background hexes. |

## 1.11 New token families introduced by this build

| Family | Names | Defined in | Consumed by |
|---|---|---|---|
| `terminalSurface` projection | `bg, ink, dim, rule, accent, cursor, selectionBg, selectionInk, ansi{16}` per theme id | `src/web/public/terminal-surface.js` as data, not CSS | `terminal.js` xterm theme, `terminal-history.js`, the settings live-preview swatch, the peek "Last output" block, the board card live-output line |
| Mobile geometry | `--mw-vh, --mw-kb, --mw-tabbar-h, --mw-toolbar-h, --mw-inputrow-h, --mw-toast-gap` | `styles.css` `:root` for the statics, `mobile-viewport.js` for the measured ones | toast anchor, `.app` height, Select-strip placement, `scroll-padding-bottom` |
| Mobile constants (JS) | `MW_LONGPRESS_MS 400`, `MW_LONGPRESS_MOVE_PX 8`, `MW_LONGPRESS_HAPTIC_MS 25`, `MW_VP_SETTLE_MS 150`, `MW_KEYBOARD_MIN_INSET_PX 120`, `MW_SWIPE_MIN_PX 96`, `MW_SWIPE_EDGE_PX 32` | `mobile-viewport.js` | both long-press paths, the swipe guard, the fit debounce |
| Breakpoint | `MW_TABLET_BREAKPOINT_PX = 900` | `mobile-viewport.js`, mirrored as a CSS comment on every `900px` media query | the phone-versus-desktop IA split. **Flagged constant**, per D4. |

Any measured mobile geometry that is added later must be added to this table, not invented at the call site.

---

# 2. THE COMPONENT MAP

## 2.1 The class strategy, stated once

Three rules, in priority order.

1. **Never rename an existing class.** Replace every declaration inside its rule. This is `DO-NOT-BREAK.md` rule 2 and it applies to all 278 JS-coupled classes and to the roughly 950 style-only ones alike.
2. **Add `nt-*` classes after the existing tokens inside the same `class="..."` value**, for example `class="btn btn-primary nt-btn nt-btn-app"`. New classes are always appended, never prepended.
3. **Three templates are attribute-order and class-value frozen.** On these, deliver the Notion recipe by restyling the existing class only. Do not append anything.

| Frozen template | Pinned by | Exact pin |
|---|---|---|
| Sidebar provider tabs | `provider-tabs.test.js` | `class="sidebar-tab(?:\s+active)?"` and `class="sidebar-tab"\s+role="tab"\s+data-provider="all"`. Attribute order is fixed: class, role, data-provider. |
| Settings provider tiles | `settings-providers.test.js` | `<div class="settings-providers-tile" data-provider="` |
| Search results | `search-render.test.js` | `<div class="search-result" data-session-id="${sessionId}" data-project-path="${...}" data-provider="${providerAttr}"`, exact order, single-space separation |

A fourth is near-frozen: `data-provider-attr.test.js` pins `<div class="ws-session-item${...}`, `<div class="project-session-item"`, `<div class="project-accordion${...}` with the class name as the **first** token. Appending after the interpolation is safe; prepending is not.

A fifth: `terminal-select-v2.test.js` pins the injected pane-header buttons carrying `btn btn-ghost btn-icon btn-sm`. The shared icon-button recipe is therefore delivered by restyling `.btn-ghost.btn-icon.btn-sm`, not by a new class.

**`nt-enable-hover` goes on the shell container** (`#app`), and is stripped on `scroll` and `dragstart` and restored after a short idle. `DESIGN-SPEC.md` 1.7 and `PROCEDURE.md` step 10 item 5 both require the strip; the mock sets it once and never strips it, which is the mock being a prototype.

## 2.2 Buttons and icon buttons

| Current family | Where | Recipe | `nt-*` and tokens | Must survive on the element |
|---|---|---|---|---|
| `.btn` | `styles.css:193-212` | `DESIGN-SPEC.md` 12 buttons table | height 28px, `padding: 0 8px`, `--radius-app-button` 6px, 14px/16.8px, `--motion-hover-reveal` | `.btn` |
| `.btn-primary` | `:226-238` | `nt-btn nt-btn-app` | `background: var(--app-accent-blue)`, hover `var(--app-ui-blue)`, `color: var(--app-on-accent)`. **No icon inside the primary button, no gradient, no glow, no `translateY` lift.** | `.btn-primary` |
| `.btn-ghost` | `:240-287` | `nt-btn nt-btn-app-secondary` | `background: var(--app-bg-elevated)`, `box-shadow: var(--app-shadow-button)`, `border-color: transparent`, hover `var(--app-bg-interactive)` | `.btn-ghost` |
| `.btn-danger` | `:240-287` | **no destructive fill exists in this system** | red **ink** on an otherwise normal secondary control: `color: var(--app-text-red)` | `.btn-danger`, `.btn-danger-hover` |
| `.btn-icon`, `.btn-sm`, `.btn-full` | `:240-287` | icon button | 28px in topbar, peek and dialogs; 26px in pane headers, popovers and the tab bar; `border: none`, `--radius-4`, transparent, `color: var(--app-text-secondary)`, hover `--app-wash-hover`. Under `@media (pointer: coarse)`: 44px. | `.btn-icon`, `.btn-sm`, `.btn-full` |
| `.btn-loader` | `:289-306` | spinner | **Retained** but no longer used for content loading. Content uses `.skeleton`. Spin survives only for genuinely indeterminate operations. | `.btn-loader` |
| Disabled | | | `opacity: 0.5; cursor: default`, plus `aria-disabled`. Never colour alone (floor A4). | |

**Two CTA weights, one hue, per `CONVERSION.md` section 1.** A solid blue primary and a tinted blue secondary. No third colour. A neutral outline secondary is not the Notion pattern.

## 2.3 Chips and dots: two systems that must not merge

This is `PROCEDURE.md` 3.3 rule 5 and `DESIGN-SPEC.md` 16.2. Splitting them is a design decision, not a cleanup.

| System | Used for | Fill | Ink | Radius | Metrics |
|---|---|---|---|---|---|
| **Property chip** `nt-chip` | status, model, plan, provider, template | `--app-chip-<hue>-fill`, translucent so it composites on a hovered row | `--app-chip-<hue>-ink` | `--radius-property-chip` 4px | 20px tall, `0 6px`, 14px/16.8px/500 |
| **Status chip** `nt-chip nt-chip-status` | states with a leading dot | same | same | `--radius-status-chip` 10px | `0 9px 0 7px` |
| **Named block colour** | user-authored tags, callouts, washes | `--app-bg-<hue>` | `--app-text-<hue>` | `--radius-callout` 10px | never used to build a chip |

| Current class | Where | Becomes |
|---|---|---|
| `.session-badge-model`, `-cost`, `-agents`, `-pr`, `-port`, `-warn` | `styles.css:456-514` | `nt-chip` property chips. **`.session-badge-cost` and `.session-badge-cost-na` markup is pinned character-for-character by `cost-display.test.js`, including the `&ndash;` entity and the exact `title` text.** Restyle the class, do not touch the template. |
| `.session-badge-tag`, `_tagColor` output | `app.js:7697` | named block colours, per 1.8 |
| `.status-dot`, `.status-badge-*` | `styles.css:395-455` | 7px block-palette circle, `background: var(--app-text-<hue>)`, **no glow shadow**. `mwPulse 2s ease-in-out infinite` when running or needs-input, inside `@media (prefers-reduced-motion: no-preference)` |
| `.nt-chip-dot` | new | 8px, `border-radius: 50%`, `background: currentColor`, so it inherits the **chip ink**, not the block palette |
| `.pane-provider-pill` | `styles.css`, pinned | `nt-chip nt-chip-purple` for Claude, `nt-chip nt-chip-green` for Codex. `provider-label-pill.test.js` pins `.pane-provider-pill[data-provider="claude"]::before` referencing `--provider-claude-accent`; keep the selector, re-point the token. |
| `.codex-status-chip`, `.codex-status-chip-bypass` | `styles.css`, pinned | `nt-chip nt-chip-gray`; the bypass chip keeps a `var(--app-text-red)` reference within 400 chars, per `codex-status-strip.test.js`. Sanctioned edit SE-5 changes `var(--red)` to `var(--app-text-red)`. |
| `.ws-group-chip`, `.ws-group-chip-remove` | pinned by `workspace-group-ux.test.js` | `nt-chip`; keep `.ws-group-chip:hover .ws-group-chip-remove { opacity: 1 }` within 80 chars |

**The chip-dot trap** (`DESIGN-SPEC.md` 6.1): standalone status dots are **7px block-palette** circles; chip dots are **8px `currentColor`** circles. Two sizes, two colour systems. Never unify them.

## 2.4 Menus and popovers

One shadow token, one radius, one entrance, across every menu and popover in the app.

| Current | Where | Recipe |
|---|---|---|
| `.context-menu`, `.context-menu-item`, `.ctx-submenu`, `.ctx-item-wrapper`, `.context-menu-sep`, `.context-menu-sep-labeled`, `.ctx-sep-label` | `styles.css:3562-3749` | `nt-menu` family. Width **240px** (the mock narrows the bundle's 320px), `--app-bg-elevated`, `--radius-app-button` 6px, `box-shadow: var(--app-shadow-menu)`, `padding: 4px`, rows `min-height: 28px` `padding: 0 10px` `--radius-4`, hover `--app-wash-hover`, separator `1px` `--app-divider` with `4px 0` margin, icon slot 18px holding a 15px SVG in `--app-icon-secondary`, hint in `--app-text-tertiary` 12px, `.is-danger` in `--app-text-red`. Selected model rows carry a **check icon in the icon slot**, never a highlight and never a radio. |
| `#account-panel`, `#conflict-center-overlay`, `#session-manager-overlay`, `.schedule-popover`, `.theme-dropdown` | various | popover recipe: `--app-bg-elevated`, `1px solid --app-border-primary`, `--radius-callout` 10px, `--app-shadow-menu`, `mwFadein 0.15s ease-out` |
| `.tooltip` (native `title=` today) | | keep native `title` for now. If upgraded: `nt-tooltip`, dark chip, `4px 8px`, `--radius-4`, 12px/16px, `--app-shadow-outlined-sm`, 150ms fade in |

**Two hard measurement constraints** (`DO-NOT-BREAK.md` D.7):

- `app.js:18568` sets `menu.hidden = false` then immediately reads `getBoundingClientRect()` to clamp against the viewport. **An entry animation that starts at `scale(0.95)` or `height: 0` returns a wrong rect and the menu lands wrong.** `mwFadein` animates `opacity` and a 4px `translateY` only, which does not change the layout rect. This is why the 4px limit is not merely aesthetic.
- `.ctx-submenu-visible` must make a submenu **measurable**: not `visibility: hidden`, not `display: none`. `.ctx-submenu` must stay `position: fixed` so the offscreen-measure trick at `app.js:18444` lands in viewport coordinates.

`focused-shell.css` must keep `.context-menu-sep-labeled` with `height: auto`, pinned by `mobile-ux-fixes.test.js`.

## 2.5 Modals and dialogs

| Current | Recipe |
|---|---|
| `.modal-overlay`, `.qs-overlay` (`styles.css:2002-2020`) | scrim `var(--app-scrim)` = `rgba(15,15,15,0.55)`. **Delete `backdrop-filter: blur(8px)`**: blurred glass is on the rejection list. |
| `.modal`, `.modal-panel`, `.modal-dialog` (`:2341-2357`) | `--app-bg-elevated`, `--radius-callout` 10px, `box-shadow: var(--app-shadow-scrim)`, `mwFadein 0.15s ease-out`. `--shadow-xl` and the 200ms `modal-in` keyframe are retired. |
| Widths | Quick Find 560px at `padding-top: 96px`; New session 480px; New agent task 500px; diff viewer 900px by `min(600px, 100vh - 64px)`; settings 780px by `min(560px, 100vh - 64px)`; confirm 480px. |
| Dialog head | `display:flex; justify-content:space-between; padding: 16px 20px 4px`, `h3` at 16px/600, 28px close icon button. |
| Field group | label 12px/500 `--app-text-secondary`; control `padding: 6px 10px`, `1px solid --app-border-primary`, `--radius-app-button`, `--app-bg-primary`, 14px, `outline: none` plus a real `:focus-visible` ring. |
| Footer | right aligned, `Cancel` secondary then the confirming action as `nt-btn-app`. Red ink only on the label if destructive. |
| Modal bodies | wrapped in `.nt-layout` (document surface, 720px measure) per `PROCEDURE.md` 0.3 and step 6. |

Focus-trap constraint (`DO-NOT-BREAK.md` D.9): `app.js:1528` filters focusables with `!el.hidden && el.getClientRects().length > 0`. **Any control hidden with `opacity: 0` or `visibility: hidden` stays in the trap as an invisible tab stop.** Use `display: none` or the `hidden` attribute.

## 2.6 Tables

The database table view is the one dense surface Notion actually measured. Copy it exactly.

| Property | Value |
|---|---|
| Header row height | **36px**, `color: var(--app-text-secondary)`, `font-weight: 400` |
| Body row height | **32px** |
| Cell padding | `0 8px` |
| Cell borders | `border-bottom` and `border-right` in `var(--app-table-cell-border)`; last column drops the right border |
| Row hover | `var(--app-wash-table-row-hover)`, the faintest wash in the system. Not a solid fill. |
| Base | `border-collapse: collapse`, 14px/21px |
| Numeric columns | `text-align: right; font-variant-numeric: tabular-nums` |
| New-row affordance | a 34px footer row with a 14px plus glyph and the label `New session`, directly under the table with no separator |

Applies to: `#session-list` in table mode, `.costs-sessions-table`, `.claude-session-table`, the Costs by-project and by-model tables. Add `nt-table` alongside the existing classes.

**Reduce type before padding.** A 14px table with a 36px header and generous cell padding is Notion. A 16px table crammed into 24px rows is not.

Pinned: `mobile-ux-fixes.test.js` and `experience-ux-contract.test.js` require the mobile table-to-block collapse `@media (max-width: 768px) ... .claude-session-table ... display: block`. Keep the mechanism.

## 2.7 Tabs: six families, all becoming pills

`.nt-tabs` and `.nt-tab` from the bundle paint an **underlined** text tab. That is exactly the one-side accent idiom this redesign removes. **Do not use them.** Every tab family becomes the pill recipe.

**The pill recipe**, used verbatim by all six: `padding: 4px 10px; border: none; border-radius: 6px; font-size: 13px; white-space: nowrap;` with active = `background: var(--app-sidebar-item-selected)` plus `color: var(--app-text-primary)` plus `font-weight: 600`, inactive = `background: transparent` plus `color: var(--app-text-secondary)` plus `font-weight: 500`, hover = `var(--app-wash-hover)`. Trailing counts at 12px `--app-text-tertiary` weight 400.

| Family | Classes | Notes |
|---|---|---|
| Workbook view tabs | `.view-tab` in `#workbook-view-tabs` | `data-shell-tier` order is pinned by `focused-shell.test.js`: primary `terminal, workspace, tasks`; secondary `costs, recent, resources`; contextual `docs`. **Do not reorder and do not remove `recent`.** |
| Terminal group tabs | `.terminal-group-tab`, `-close`, `-name`, `.terminal-group-tab-item` | Adds a **7px positional dot** whose colour comes from list position, not content: `red, yellow, green, teal, blue, purple` cycling. Markup is pinned by `mobile-ux-fixes.test.js` down to tag order, `type="button"`, and the single space between the two sibling buttons. `.terminal-group-tab` must keep `touch-action: pan-x` as a standalone brace-free rule. |
| Tasks tabs | `.tasks-tab`, `.tasks-tab-panel` | Labels `Agent Tasks` and `Issues` are pinned; `data-shell-maturity="retired"` on git and files stays `display: none`. |
| Docs tabs | `.docs-tab`, `.docs-tabs` | |
| Account tabs | `.account-tab`, `.is-active` | `provider-account-tabs.test.js` pins `.account-tab.is-active[data-provider-tab="claude"]` and a hex-free zone between `.account-tabs {` and `.account-empty-hint`. |
| Sidebar provider tabs | `.sidebar-tab` | **Frozen template** per 2.1. CSS-only restyle. |
| Filter and period pills | `.costs-period-btn`, `.sm-filter`, session filters | Same recipe. |

`.active` and `.is-active` are **different, non-interchangeable tokens** and both must survive. `.active` alone carries 41 `classList` operations across three files.

## 2.8 Toasts

| Property | Value |
|---|---|
| Position | bottom **left**, `bottom: 24px; left: 24px`, `z-index: 400` on desktop |
| Geometry | `width: var(--app-toast-width)` 300px, `padding: 8px 12px`, `--radius-app-button` 6px |
| Colour | `background: var(--app-bg-accent-primary)` (near-black in light, near-white in dark), `color: var(--app-text-inverse-primary)` |
| Shadow | `var(--app-shadow-lg)` |
| Type | 14px/21px |
| Entrance | `var(--duration-200) var(--ease-out) nt-snackbar-slide-in-bottom` |
| Lifetime | 2200ms; a new toast clears the previous timer so only one is ever on screen |

Mobile changes the anchor and the hit behaviour; see 2.12 and the `MOBILE-EXPERIENCE.md` B.5 contract, which is a defect fix, not a restyle.

Existing classes that must survive: `.toast-container`, `.toast-close`, `.toast-dragging`, `.toast-exit`, `.toast-swipe-exit`, `.fallback-banner`, `.fallback-dismiss`.

## 2.9 Inputs, selects, checkboxes, switches

| Current | Recipe |
|---|---|
| `.input`, `textarea`, `select` (`styles.css:330-352`) | height 28px (32px for the search variant), `padding: 0 8px`, `1px solid var(--app-border-primary)`, `--radius-app-button`, `background: var(--app-bg-primary)`. Focus is `var(--app-input-focus-ring)`, error is `var(--app-input-error-ring)`. The current literal mauve focus rgba goes. |
| Placeholder | `var(--app-title-placeholder)` in title-shaped fields, `var(--app-text-tertiary)` elsewhere |
| `.form-checkbox`, native checkbox | 16px, `accent-color: var(--app-ui-blue)`. The mock uses native checkboxes with `accent-color`; either that or `nt-checkbox` is acceptable, `accent-color` is the minimum. |
| Switch | `nt-switch` plus `nt-switch-knob`, `role="switch"`. 26 by 16, `--radius-round`, off `--app-bg-tertiary`, on `--app-ui-blue`, 12px white knob with `--app-shadow-avatar`, translate by `calc(width - height)`, **only the knob moves**, 200ms `--ease-out`. |
| Borderless editors | peek Notes and the docs raw editor are **borderless and groundless**: no border, no background, `--font-app-ui` 14px/1.5, `padding: 6px 2px`. The note looks like page content, not like a form field. This is the strongest Notion idiom in the whole app. |
| Mobile | every input at `font-size: 16px` to defeat iOS zoom-on-focus (`styles-mobile.css:64`, preserve), `min-height: 44px` |

## 2.10 Cards and board columns

| Current | Recipe |
|---|---|
| `.kanban-column`, `.board-column` | `nt-board-col`: `width: var(--app-board-column-width)` 260px, `flex: none`, `gap: var(--app-board-card-gap)` 8px, `border-radius: 8px`, `padding: 4px`, `min-height: 220px`, `background: transparent` at rest and `var(--app-bg-blue)` while a card is dragged over. The board itself is `align-items: stretch` so columns are equal height, which matters because each column is a drop target. |
| Column head | `min-height: 36px`, `padding: 0 4px`, a status chip plus a count in `--app-text-tertiary` 14px. Five columns: Backlog gray, Planning blue, Running green, Review yellow, Done purple. |
| `.kanban-card`, `.board-card` | `nt-board-card`: `padding: 8px 12px`, `--app-bg-elevated`, `--radius-collection-card` 10px, `box-shadow: var(--app-shadow-outlined-sm)`, hover `background: var(--app-bg-secondary)` with `--motion-hover-reveal`. **No `translateY` lift on hover.** Title 14px/21px/500, branch 11px mono `--app-text-tertiary`, live-output line 11px mono on `terminalSurface().bg` at `--radius-4`. |
| Column footer | `nt-board-add`: 13px `--app-text-tertiary` plus a 13px plus glyph, label `New`, hover raises ink to secondary. |
| Mobile | the board becomes a **column segmented control plus a vertical card list** below 900px. Card move is a "Move to column" action sheet, not a drag. The board layout is retained above the breakpoint. |

Must survive: `.kanban-column`, `.kanban-column-body`, `.kanban-column-count`, `.kanban-card`, `.kanban-drop-target`, `.board-card`, `.board-column-body`, `.board-column-count`, `.task-item`, `#kanban-board`, `#feature-board`, `#board-columns`.

## 2.11 Meters and progress bars

One component, three consumers. `DESIGN-SPEC.md` 8.1 and 9.2 draw the same 5px bar.

| Property | Value |
|---|---|
| Track | `height: 5px; border-radius: 3px; background: var(--app-bg-tertiary); overflow: hidden` |
| Fill | `height: 100%; border-radius: 3px; width: {pct}%` |
| Fill colour by threshold | below 60 `--app-text-green`, below 85 `--app-text-yellow`, otherwise `--app-text-red` |
| Label row | 12px, key in `--app-text-secondary` weight 500, right side in `--app-text-tertiary` reading `{pct}% · {reset}` |

Consumers: `#usage-meter` and `#account-panel-meter` (account usage), the Costs `Share` column, the System Resources gauges, `#detail-token-bar`.

**`usage-meter.test.js` asserts three whitespace-exact single-line rules**: `.usage-meter-fill.u-low { background: var(--green); }` and the `u-mid` and `u-high` equivalents, plus `.account-panel-meter {\s*display: none;\s*}`, plus `.usage-meter-fill { transition: none; }` inside a reduced-motion block, plus **zero hardcoded hex between `.usage-meter {` and `.account-panel-meter {`**. Sanctioned edit SE-6 changes the three token names and nothing else. Do not reformat these rules; they are matched as single lines.

## 2.12 Remaining surfaces, in one table

| Surface | Current classes | Recipe |
|---|---|---|
| Sidebar row | `.workspace-item`, `.ws-session-item`, `.project-accordion`, `.project-session-item`, `.sidebar-tab` | `min-height: 27px`, `padding: 4px 8px`, `gap: 8px`, `--radius-block-hover` 6px, hover `--app-wash-hover`, selected `--app-sidebar-item-selected` plus primary ink plus weight 600. **Zero left borders, zero bars, zero underlines.** This is the single most important idiom in the restyle. |
| Sidebar section label | `.sidebar-section-divider-label`, `#sidebar-projects-header`, `#projects-header` | `padding: 4px 8px`, 12px/500, `var(--app-sidebar-section-label)`. Marked up as `h2` for the heading structure. |
| Topbar | `.app-header` | **44px, no background of its own, no shadow at rest**, bottom hairline `--app-border-secondary`. Scrolled state gets `--app-shadow-topbar` over a deliberately slow 700ms so the breadcrumb does not flicker. The header stats cluster moves into a popover. |
| Pane header | `.terminal-pane-header` and its 11 children | 38px, `padding: 0 8px 0 12px`, bottom hairline. Order: 7px dot, title 13px/600 with hover wash, provider chip, needs-input chip, activity text `flex-shrink: 4`, spacer, then copy, menu and close buttons at 26px. **Progressive chrome shedding** implemented as a real width-driven rule (container query or a measured class), not a guess. |
| Pane frame | `.terminal-pane` | `1px solid`, `border-radius: 8px`, `background: var(--app-bg-primary)`, focus `inset 0 0 0 2px var(--app-ui-blue)`. Slot colour is a **35 percent mix into the hairline**, never a saturated frame: `color-mix(in srgb, {paneColor} 35%, var(--app-border-primary))`. |
| Drop slot | `.terminal-pane-empty` | `1.5px dashed var(--app-border-strong)`, `border-radius: 8px`, `min-height: 120px`, 20px plus glyph, copy at 13px. Drag-over flips border to `--app-text-blue` and fill to `--app-bg-blue`. |
| Side peek | `#session-detail-panel` | A **layout sibling**, not an overlay: opening it narrows the main column. `border-left: 1px solid var(--app-border-primary)`, no shadow. 44px header mirroring the topbar. Property grid `minmax(80px,110px) 1fr`, `gap: 2px 10px`, rows `min-height: 30px`. |
| Empty states | `#session-empty`, `#workbench-empty-state`, `#docs-project-empty`, `.ai-insights-empty` | `nt-empty`: centred column, `gap: 8px`, `padding: 40px 24px`, title 16px/600 primary, body 14px/21px secondary capped at 320px. Art slot takes a hand-inked line drawing or **nothing**. Never a line icon in a rounded square. `#workbench-empty-state` copy is pinned: it must contain `browse sessions already on this machine` and `>Browse sessions</button>`. |
| Skeletons | `.skeleton`, `.skeleton-line` | 1s linear shimmer between `--app-bg-tertiary` and `--app-bg-interactive`, disabled under `prefers-reduced-motion: reduce`. **Fix the pre-existing double declaration** at `styles.css:2944` and `:4141` so the AI find-card sizing stops leaking into every other consumer. |
| Avatars | `.nt-avatar` | 20, 24, 32px, `--radius-avatar` 100 percent, `--app-shadow-avatar` |
| Dividers | `.settings-row` separators, `.nt-menu-sep` | 1px `--app-divider`. Setting rows are **row separators only**: no card, no panel, no grouping box. |
| Resize handles | `.sidebar-resize-handle`, `.terminal-resize-handle`, `#sidebar-section-resize` | 5px wide (12px for the pane splitter), transparent at rest, hover `color-mix(in srgb, var(--app-ui-blue) 28%, transparent)`. The `- 3px` centring constant in `app.js:18135` assumes a 6px handle; **change the constant if the width changes**. |
| Docs panel | `#docs-panel` and its 7 sections | **Document surface**: wrap the body in `.nt-layout` (720px measure, 96px minimum gutter), block box model 6px plus 2px, zero margins, list collapse to 1px between consecutive items. Section headers stay `<button aria-expanded>` with the seven pinned `aria-controls` values in order. |

## 2.13 The recency system, cross-cutting

**Requirement, verbatim from the user: "we need to make it really easy to find most recent sessions."**

Recency is a first-class affordance, not a table sort. It appears on five surfaces backed by one data contract. This is treated as a product feature with its own acceptance criteria, and it lands early because it is the highest-leverage single change on desktop.

### 2.13.1 The data contract: one recency source of truth

There is exactly **one** recency field, computed server side, merged across providers, and exactly **one** formatter. No surface computes its own.

| Element | Specification |
|---|---|
| Field | `lastActiveAt`, epoch milliseconds, integer, always present, never null. Sessions with no signal get their creation time. |
| Claude source | the store's `lastActive` where the workbook owns the record, else the session JSONL `mtimeMs`. `lastActive` already appears 30 times in `app.js`; do not add a second name. |
| Codex source, SQLite path | `threads.recency_at_ms`, falling back to `threads.updated_at_ms`, then `threads.created_at_ms`. `recency_at_ms` is the desktop app's own sort key and is distinct from `updated_at`; use it. This is the field that makes Codex recency reliable and it is a direct payoff of `CODEX-PARITY.md` P0-2. |
| Codex source, walk fallback | the rollout file `mtimeMs`. Less accurate, always available, and the reason the filesystem walk stays forever. |
| Merge rule | one flat list across providers, sorted `lastActiveAt` descending, ties broken by session id descending so the order is stable across renders. |
| Exclusions | hidden sessions are excluded from every recency surface by default; archived Codex threads are excluded unless the surface explicitly opts in. |
| Server surface | `GET /api/sessions/recent?limit=N` returns the merged list with the fields every consumer needs: `id, providerId, title, projectPath, projectLabel, projectEmoji, status, model, lastActiveAt`. One endpoint, five consumers. |
| Live update | recency updates over the existing SSE stream, not only on refresh. A `session:activity` event carrying `{id, lastActiveAt, status}` re-sorts the client's cached list in place and re-renders only the affected rows. Polling for recency is forbidden; it is the exact pattern that produced the 5.5 second Codex discovery cost. |
| Formatter | the existing `relativeTime()` at `app.js:7368` is the **single** helper. Do not add a second. Extend it if a surface needs a shorter form; the mock's vocabulary is `just now` and `{n} ago`. |
| Reduced-precision rule | never render a timestamp more precise than the update cadence. Under one minute is `just now`. |

### 2.13.2 Surface 1: Quick Find zero-query recents (the highest-leverage change)

Opening Quick Find with an empty input currently shows nothing useful. It becomes the command-palette recents pattern.

| Aspect | Specification |
|---|---|
| Trigger | `Ctrl/Cmd + K` and `Ctrl/Cmd + P`, both existing |
| Zero-query state | the **8** most recent sessions, cross-provider, merged, under a group header reading `Recent` |
| Row anatomy | 7px status dot, title at 14px/500, project as `{emoji} {name}` at 12px `--app-text-tertiary`, provider chip, spacer, relative time at 12px tertiary. `padding: 7px 10px`, `--radius-block-hover`, hover `--app-wash-hover`. |
| Keyboard | the first row is highlighted on open; `Enter` opens it; arrows move; `Escape` closes |
| On typing | the recents group is replaced by matches, capped at 6, exactly as today |
| Group header | `padding: 6px 10px 2px`, 11px/600, `--app-sidebar-section-label`, `text-transform: uppercase`, `letter-spacing: 0.03em`. **This is the single sanctioned uppercase tracked-out label in the entire design. Do not spread the treatment.** |
| Footer | unchanged: the `Find in conversations` row plus `⌘K search · ⌘P switcher` |

**DO-NOT-BREAK constraints on this surface.** `#quick-switcher-overlay`, `#qs-input`, `#qs-results` are pinned IDs. `.qs-result`, `.qs-result-group`, `.qs-result-icon`, `.qs-result-info`, `.qs-result-name`, `.qs-result-detail` are existing classes. `openQuickSwitcher()` at `app.js:11659`, `renderQuickSwitcherResults()` at `:11704` and `updateQuickSwitcherHighlight()` at `:11898` are existing methods at two-space class indentation. Implement the zero-query state **inside** `renderQuickSwitcherResults` as a new branch. Do not rename anything, do not restructure the results container, and do not change the method signatures.

### 2.13.3 Surface 2: desktop sidebar Recent section

A `Recent` section in the sidebar, placed **above** `Projects`, using the existing section-label and 27px row geometry.

| Aspect | Specification |
|---|---|
| Label | `Recent`, `padding: 4px 8px`, 12px/500, `--app-sidebar-section-label` |
| Rows | the **5** most recent sessions. 27px row geometry, 7px status dot (pulsing when live), title 13px ellipsised, trailing relative time at 11px `--app-text-tertiary`. |
| Interaction | single click opens the session in the workbench, matching the session-row idiom already in the sidebar. Right click opens the existing session context menu. |
| Overflow | a final row reading `See all` that routes to `setViewMode('recent')`, which is an existing, pinned view mode. |
| Density | hidden entirely when `data-density="quiet"` shows zero sessions, and always present under `informative`. It never renders an empty section with a label. |
| Collapse | collapsible, state persisted under a new key `cwm_recentCollapsed`. |

**DO-NOT-BREAK constraints.** The sidebar's ordered children and their IDs are pinned by `focused-shell.test.js` first-run scaffolding rules, which name `#sidebar-provider-tabs`, `.sidebar-footer`, `#sidebar-section-resize`, `#projects-header`, `#projects-search-bar`, `#projects-list`. The new section is inserted with a **new** ID `#sidebar-recent-section` and must not sit between any two of those pinned siblings in a way that changes their relative order. `app.js:11591-11647` splits the sidebar interior by writing inline `flex` and `height` on `#workspace-list` and `#projects-list` and subtracts a hard-coded `200` for headers and footer. **Adding a section changes that arithmetic**: the constant becomes `200 + measured height of #sidebar-recent-section`, measured, not guessed. This is risk R12.

### 2.13.4 Surface 3: Sessions table default sort

| Aspect | Specification |
|---|---|
| Default sort | `Last active` descending, on first load and after a reset |
| Column | a new `Last active` column, right aligned, `--app-text-tertiary` 13px, formatted by `relativeTime()`. The mock specifies exactly this column. |
| Sort control | a `th` carrying `data-sort="lastActive"`, matching the five existing `data-sort` values at `app.js:21793-21797`. `[data-sort]` on `th` is an existing `DO-NOT-BREAK` behaviour selector; follow the established pattern. |
| Persistence | new key `cwm_sessionsSort`, value `{ key, dir }`. Absent means `{ key: 'lastActive', dir: 'desc' }`. |
| Indicator | the existing `.sort-active`, `.sort-asc` state classes, restyled. No new state class. |

### 2.13.5 Surface 4: workbench "Continue where you left off"

The workbench empty state and every new tab group currently show a bare dashed drop slot. That is a dead end for the most common intent, which is resuming.

| Aspect | Specification |
|---|---|
| Placement | inside `#workbench-empty-state`, **above** the drop slot, never replacing it. The drop slot must always remain as a drop target; this is a recorded lesson in project memory. |
| Content | label `Continue where you left off` at 12px/500 `--app-sidebar-section-label`, then a horizontal row of up to **4** recent session cards. |
| Card | bordered, `1px solid var(--app-border-primary)`, `--radius-callout`, `padding: 10px 12px`, containing a 7px status dot, the title at 13px/600, the project as `{emoji} {name}` at 12px tertiary, a provider chip, and the relative time. Click opens the session into the focused pane. |
| Empty case | when there are no recent sessions the row is absent and only the drop slot renders, with its existing pinned copy. |

**DO-NOT-BREAK constraints.** `#workbench-empty-state`, `#workbench-empty-title`, `#workbench-start-btn`, `#workbench-projects-btn` are pinned IDs bound in `app.js` `els`. The copy `browse sessions already on this machine` and `>Browse sessions</button>` are pinned strings. Insert the new block as a sibling; do not restructure the existing children.

### 2.13.6 Surface 5: mobile Home tab

The mock's Home screen is already the recency surface. Build it exactly as drawn, per `MOBILE-EXPERIENCE.md` A.4.

| Block | Specification |
|---|---|
| `Active now` | bordered cards, 8px pulsing dot, title 14px/600, meta `{emoji} {project} · {activity}` at 12px secondary, provider chip. Capped at **6**, then a `See all (n)` row. |
| `Recent` | borderless rows, 7px static `--app-text-gray` dot, title 14px/500, meta `{emoji} {project}` at 12px tertiary, trailing relative time at 12px tertiary. Capped at **5**, then `See all`. |
| The distinction | **bordered cards for live things, borderless rows for history.** This is the semantic being drawn and it must survive. |
| Default landing | Home, so recency is the first thing the phone shows. See OQ-4. |

### 2.13.7 Recency acceptance criteria

Every one of these is a checkable statement, verified in the final sweep.

1. From a cold app load, the most recently active session is reachable in **two keystrokes**: `Ctrl+K`, `Enter`.
2. The Quick Find zero-query list, the sidebar Recent section, the Sessions table default sort and the mobile Home Recent list all show the **same session first**, for the same account, at the same moment.
3. A session that produces output updates its relative time on every recency surface within **5 seconds**, over SSE, with no manual refresh and no polling.
4. Codex sessions and Claude sessions interleave correctly by time in one merged list. A Codex session active one minute ago sorts above a Claude session active one hour ago.
5. Every relative timestamp in the app is produced by `relativeTime()`. `grep -c "relativeTime(" src/web/public/app.js` is greater than the number of surfaces, and no second formatter exists.
6. Hidden sessions never appear in any recency surface.
7. On the phone, finding the most recent session takes under 5 seconds from app open, measured in the section G.5 human script.

---

# 3. FILE PLAN

All paths relative to `C:/Users/Arthur/Desktop/cwm-restyle`.

## 3.1 Created

| Path | Contents | Created in |
|---|---|---|
| `src/web/public/design/notion/tokens/{colors,typography,spacing,effects,motion}.css` | verbatim copies of the bundle. **Reference and parity source. Not linked.** | P0 |
| `src/web/public/design/notion/tokens/tokens.json` | verbatim copy, machine-readable provenance including the `inferred` flags | P0 |
| `src/web/public/design/notion/components.css` | verbatim copy of the bundle's `nt-*` paint layer. **Linked**, before `styles.css`. | P0 |
| `src/web/public/design/notion/fonts.css` | the four `@font-face` blocks with `src` rewritten to `/design/notion/fonts/`. Keeps `font-weight: 600 700` on the bold faces so a 700 rule resolves to the real file rather than a synthetic bold. | P1 |
| `src/web/public/design/notion/fonts/iAWriterMonoS-{Regular,Italic,Bold,BoldItalic}.woff2`, `permanent-marker.woff` | SIL OFL 1.1 and Apache 2.0, both redistributable | P1 |
| `src/web/public/terminal-surface.js` | `window.MyrlinTerminalSurface`, the single `terminalSurface(themeId)` projection: `bg, ink, dim, rule, accent, cursor, selectionBg, selectionInk, ansi{16}` for all 13 themes. Loaded in `<body>` **before** `terminal.js`, so the four pinned head assets keep their relative order. | P5 |
| `src/web/public/terminal-history.js` | the Unified Scrollback Surface history layer: DOM, scroll boundary logic, source router, segment rendering, mirror freeze. Exposed as `window.TerminalHistory`. | P7 |
| `src/web/public/mobile-viewport.js` | the single owner of viewport geometry: writes `--mw-vh`, `--mw-kb`, `--mw-toolbar-h`, `--mw-inputrow-h` and the `mw-keyboard` body class. Holds every `MW_*` constant. | P10 |
| `src/web/vt-sidecar.js` | headless VT: snapshot, normal-buffer line log, mode signal. Requires `@xterm/headless` and `@xterm/addon-serialize` behind the same containment guard `pty-manager.js` uses for `node-pty`. | P6 |
| `src/providers/codex/state-db.js` | read-only accessor over `state_5.sqlite` and `sqlite/codex-dev.db`. Copy-before-read. Never opens `logs_2.sqlite`. Degrades to the walk on any failure. | P8 |
| `src/providers/codex/paths.js` | `normalizeCodexPath`, `projectKeyFor`, `projectIdFor`. Exported and unit tested. | P8 |
| `docs/design/notion-restyle/DECISIONS.md` | answers `PROCEDURE.md` 0.4, step 12 and 5.3, plus every OQ in section 7 | P0 |
| `docs/design/notion-restyle/INVENTIONS.md` | every derived component: nearest relative, what was inherited, what was invented | P0, appended every phase |
| `docs/design/notion-restyle/DEVIATIONS.md` | every departure from the captured brand: what the brand says, what shipped, why, cost, who approved, date | P0, appended every phase |
| `docs/design/notion-restyle/id-snapshot.txt` | the 336 pinned IDs, committed so gate G1 can diff against it | P0 |
| `docs/design/notion-restyle/class-snapshot.txt` | the 278 JS-coupled classes, for gate G2 | P0 |
| `test/notion-token-parity.test.js` | diffs `--app-*` and scale definitions in `styles.css` against the vendored bundle; also asserts every `var()` in the vendored `components.css` resolves against the union of definition sites | P0 |
| `test/recency-contract.test.js` | one `lastActiveAt` field, one `relativeTime` helper, the merge and tie-break rule, the SSE event shape, hidden exclusion | P4 |
| `test/paste-input-preparation.test.js` | the `prepareInputForPty` truth table | P5 |
| `test/vt-sidecar.test.js` | golden byte-stream tests, prefix-pruned snapshot, containment on forced require failure | P6 |
| `test/terminal-history.test.js` | router truth table, paging cursor, seam behaviour | P7 |
| `test/codex-paths.test.js` | normalisation, including the real `New project 2` collision, and the two proven sha256 project ids | P8 |
| `test/codex-state-db.test.js` | read-only discipline, graceful degradation, `PRAGMA table_info` per-column probing, the title cascade | P8 |
| `test/mobile-ia-contract.test.js` | the capability manifest, five-tab order, `data-mw-route` markers, and the assertion that no capability's only marker is inside `.terminal-pane-header` or a hover-guarded block | P10 |
| `test/mobile-viewport.test.js` | the geometry driver: no `transform` written, custom properties correct, debounce | P10 |
| `test/browser/notion-shell.spec.js` | Playwright: screenshots at 1280x800 and 390x844 in both chrome themes, the 44px sweep, the toast occlusion test, the computed-metric assertions | P0, extended every phase |

**Every new test file must be appended to the `standaloneTests` array in `test/run.js`** (currently 76 entries), with a one-line comment naming the phase. `npm test` does not auto-discover.

## 3.2 Edited heavily

### `src/web/public/styles.css`, 12202 lines: rewrite in place, never shrink

**Strategy decision: rewrite in place. Do not create a parallel sheet.** A new sheet plus a shrinking old one would violate code preservation on the old file, double the cascade surface, and break roughly twenty tests that slice rule bodies out of `styles.css` by literal selector.

Non-negotiable editing rules for this file:

1. **No formatter, no minifier, no re-indent, no repo-wide Prettier or Stylelint pass.** About twenty assertions slice rule bodies with `indexOf(selector + ' {')` and cut at the first `}`, or match single-line rules verbatim.
2. **Preserve the `selector {` spacing exactly**, one space before the brace.
3. **Never merge a pinned selector into a grouped selector list.** Put shared Notion properties in a new grouped rule and keep the pinned single selector as its own rule underneath, even if it carries one declaration.
4. **Never introduce a nested brace into a pinned rule body.** `ruleBody()` cuts at the first `}`.
5. **The file is stored with CRLF.** Do not normalise line endings. Test anchors are deliberately single-line; a signature that wraps across lines stops matching.
6. The 13 `:root[data-theme="<id>"]` palette blocks are **not touched** in P1 or P2. They are the terminal palette.
7. New content is **added**: the Notion `:root` token block, the dark chrome block, and new grouped rules. Existing rules are re-pointed, not removed.

Line-range ownership when two work packages both need this file: they run **in sequence within the phase**, never in parallel. See 4.2.

### Other heavily edited files

| File | Change | Phase |
|---|---|---|
| `src/web/public/semantic-theme.css` | right-hand sides only, per 1.6. Must stay hex-free and keep all 15 pinned names and the forced-colors block. | P1 |
| `src/web/public/focused-shell.css` | token re-point, the 44px topbar, the 240px sidebar, the coarse-pointer block extended. **Every pinned block keeps its exact selector header text**, including the trailing comma on the provider-pane selector and the two `!important` grid override blocks. | P2 |
| `src/web/public/styles-mobile.css` | the whole mobile program, sections A through F | P10, P11 |
| `src/web/public/index.html` | root attributes, font links out, new stylesheet links, cachebusters, the `Last active` column, the five-tab bar, `data-mw-zone` and `data-mw-route` markers, meta theme-color pair | P1 onward |
| `src/web/public/app.js` | boot-failure screens, the JS colour maps, `setTheme` plus a new `setChrome`, Quick Find zero-query branch, the sidebar Recent section, the workbench continue row, the sessions sort, the 182 inline `style=` strings, the mobile IA | P1 onward |
| `src/web/public/terminal.js` | `prepareInputForPty`, `Ctrl+Shift+C`, `Ctrl+Shift+A`, scrollback bump, the `terminalSurface` read, the three font-string fixes, the history-layer hooks | P5, P7 |
| `src/web/public/theme-registry.js` | additive `terminalSurface(id)` accessor delegating to `window.MyrlinTerminalSurface` with a null-safe fallback. **The 13 ids, labels, tiers, `xterm.paletteId`, `xterm.fallback` and the frozen objects are untouched.** | P5 |
| `src/web/public/instance-colors.js` | additive `TAB_COLOR_TOKENS` map. `TAB_COLORS` array literal untouched. | P2 |
| `src/web/public/mirror-view.js`, `schedules.js` | restyle their generated markup's classes only | P4 |
| `src/web/server.js` | `GET /api/sessions/recent`, the `session:activity` SSE event, the cost route gate, the provider dispatch fixes | P4, P9 |
| `src/web/pty-manager.js` | VT sidecar hook, ownership debounce, alternate-buffer-aware replay | P6 |
| `src/providers/codex/{discover,index,parse,search,spawn}.js` | SQLite-first discovery, title cascade, the `custom_tool_call` emit set, `parseUsage`, widened enums | P8, P9 |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | PWA | P12 |
| `CHANGELOG.md`, `package.json` | one entry and one bump per phase | every phase |

## 3.3 Test files edited, in lockstep only

Listed in full in 5.4. Every edit ships in the **same commit** as the source change, carries a one-line reason comment naming the decision that moved the value, and never deletes an assertion.

## 3.4 Untouched

| Path | Why |
|---|---|
| `src/web/public/vendor/**` | xterm, lucide, material-icons, codemirror, qrcode, drag-drop-touch. Vendored. `xterm.css` is structural only; restyle it with descendant rules from `.terminal-pane`. |
| `terminal.js:223-421`, the 8 static xterm palettes | 264 hex literals that **are** the terminal palettes. `theme-registry.test.js` pins all 13 background hexes. |
| `src/ui/**`, `src/core/**`, `src/state/**` | the blessed TUI and the state layer. Out of scope. |
| `src/web/public/experience-model.js` | pinned to exactly two densities and exactly five attention states. |
| `src/web/mirror-service.js`, `src/web/jsonl-tailer.js` | mature, bounded, read-only. USS **consumes** them, it does not reimplement them. |
| `docs/design/notion-import/**` | read-only source of record. Copy from it; never edit it. |
| `index.html:314-327`, the 13 theme swatches | literal previews of an unchanged palette set. |
| `.claude/**`, `~/.claude/**`, any global config | out of scope for every agent, always. |

---

# 4. PHASE DAG

## 4.1 Rules that govern every phase

1. **Every phase leaves the branch green.** `npm test` at or above baseline, screenshots captured, gates passed. A phase that cannot finish green is split, not merged. This is also the compaction defence: a phase boundary is a safe resume point.
2. **One commit per work package**, with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. One `1.3.0-alpha.N` bump and one `CHANGELOG.md` entry per **phase**, not per package.
3. **Implementation agents never push.** They commit to their worktree branch and exit. The orchestrator reviews, merges and pushes.
4. **Each work package names its file-ownership set.** Two packages in the same phase may run in parallel only if their ownership sets are disjoint.
5. **`styles.css` has exactly one writer at a time.** No exceptions. It is one 12202-line file with about twenty text-anchored assertions in it.
6. **Worktrees never junction `node_modules`.** `npm install` per worktree. Junctioning and then running `git worktree remove` guts the main repo through the junction; this has happened on this project before.
7. **A phase that needs a test-expectation edit lists it up front**, from the sanctioned list in 5.4. An agent that discovers an unlisted test break stops and reports rather than editing the test.

## 4.2 Parallelisation matrix

Three independent tracks run concurrently from P1 onward. They touch disjoint file sets, so they never collide.

| Track | Phases | Owns |
|---|---|---|
| **Frontend chrome** | P1, P2, P3, P4 | `styles.css`, `semantic-theme.css`, `focused-shell.css`, `index.html`, chrome regions of `app.js` |
| **Terminal** | P5, P6, P7 | `terminal.js`, `terminal-surface.js`, `terminal-history.js`, `vt-sidecar.js`, `pty-manager.js` |
| **Backend and provider** | P8, P9 | `src/providers/**`, `src/web/server.js` |
| **Mobile** | P10, P11, P12 | `styles-mobile.css`, `mobile-viewport.js`, mobile regions of `app.js` and `index.html` |

The one shared file across tracks is `app.js`. Ownership is split by **method region**, and each agent is given the exact method names it may modify. Any agent that must touch a method outside its region reports back instead of editing.

## 4.3 The graph

```
P0 Baseline & scaffold
 |
 +-- P1 Token foundation ---------------------------------------+
 |    |                                                          |
 |    +-- P2 Notion shell  (FIRST SCREENSHOT-ABLE NOTION UI)     |
 |    |    |                                                     |
 |    |    +-- P3 Primitives & chips                             |
 |    |         |                                                |
 |    |         +-- P4 Composites, regions & RECENCY             |
 |    |                                                          |
 |    +-- P5 Terminal input & surface --+                        |
 |                                       |                       |
 +-- P6 Server terminal core ------------+-- P7 Unified          |
 |                                              Scrollback       |
 +-- P8 Codex parity P0 -- P9 Codex parity P1                    |
 |                                                                |
 +-------------------------------------- P10 Mobile IA & viewport
                                          |
                                          +-- P11 Mobile interaction & touch
                                               |
                                               +-- P12 PWA, art direction, acceptance
```

Hard dependencies only: P1 needs P0. P2 needs P1. P3 needs P2. P4 needs P3. P5 needs P1 (for the token layer) and creates `terminal-surface.js`. P7 needs P5 and P6. P9 needs P8. P10 needs P2 (the chrome must exist before the phone layout is tuned to it). P12 needs everything.

P6 and P8 have **no frontend dependency at all** and should start at the same time as P1.

## 4.4 The phases

### P0. Baseline and scaffold, `1.3.0-alpha.11`

Visually inert. Everything after this depends on the gates existing.

| WP | Work | Owns | Done criteria |
|---|---|---|---|
| P0.1 | Capture the baseline. Run `npm test`, record the assertion count and the per-file breakdown into `DECISIONS.md`. Record the drift counters: hex literals 316 / 5 / 1, radius literals 199, inline `style="` 63 and 182, `linear-gradient` 5, `backdrop-filter` 5, `translateY` 21, `@keyframes` 37. | none | numbers recorded, no source changed |
| P0.2 | Vendor the bundle into `src/web/public/design/notion/`, preserving relative paths. Do **not** link anything yet. | `design/notion/**` | files present, app renders identically |
| P0.3 | Create `DECISIONS.md`, `INVENTIONS.md`, `DEVIATIONS.md`, `id-snapshot.txt`, `class-snapshot.txt`. | `docs/design/notion-restyle/**` | snapshots match today's source exactly |
| P0.4 | Write `test/notion-token-parity.test.js` and register it in `test/run.js`. It passes trivially today (nothing to compare) and becomes load-bearing in P1. | `test/**` | green |
| P0.5 | Write `test/browser/notion-shell.spec.js` on the existing `test/browser/workbook-shell-server.js` harness. Captures 1280x800 and 390x844 in both chrome themes. **PIL-style dimension guard: assert every captured PNG is at most 2000px on both axes before it is ever read into a model context.** | `test/browser/**` | screenshots land in the scratchpad, dimensions asserted |
| P0.6 | Write the DO-NOT-BREAK grep gates as a script (section 5.3) and register it. | `scripts/`, `test/**` | all gates pass on unmodified source |

Parallel: P0.2 through P0.6 all have disjoint ownership and can run as five concurrent agents.

### P1. Token foundation, `1.3.0-alpha.12`

The first visible change. The whole app turns warm and light. Nothing is laid out correctly yet, and that is expected.

| WP | Work | Inputs | Owns | Done criteria |
|---|---|---|---|---|
| P1.1 | Author the Notion `:root` token block and the dark chrome block into `styles.css`, values copied verbatim from the vendored bundle. Re-point all 16 rows of table B, all of table C, all of table D. | 1.1 to 1.5 | `styles.css` | `test/notion-token-parity.test.js` green; `phantom-tokens.test.js` green |
| P1.2 | Fonts: delete the Google Fonts link and both preconnects; create and link `design/notion/fonts.css`; re-point `--font-sans` and `--font-mono`; fix the three terminal font strings from 1.7. | 1.4, 1.7 | `index.html`, `design/notion/fonts.css`, `terminal.js` font strings only | `getComputedStyle(document.body).fontFamily` starts with `ui-sans-serif`; **zero requests to `fonts.googleapis.com` or `fonts.gstatic.com` on a hard reload**; nothing falls back to Times on the header, sidebar, a table cell, a modal, a code block, the select strip or the copy view |
| P1.3 | Re-point `semantic-theme.css` per table E. | 1.6 | `semantic-theme.css` | hex-free regex passes; all 15 pinned names present; forced-colors block intact |
| P1.4 | Root attributes and the chrome switch: `data-surface="app"`, `data-chrome`, pre-paint stamping, `cwm_chrome` persistence, `setChrome()`, the `prefers-color-scheme` default, the `theme-color` meta pair and its runtime sync. | 1.1.2, 1.1.3 | `index.html`, `app.js` `setTheme` region | toggling `data-chrome` flips the whole app with no orphaned light surface and no orphaned dark text |
| P1.5 | The sanctioned test edits SE-1, SE-2, SE-3, SE-4, SE-5, SE-6, each with its reason comment. | 5.4 | `test/**` | `npm test` at baseline |
| P1.6 | Link `design/notion/components.css` **before** `styles.css`. Bump all cachebusters atomically across `index.html` and the three test files that pin them. | 5.4 SE-7 | `index.html`, `test/**` | `experience-ux-contract.test.js`, `terminal-select-mode.test.js`, `copy-secure-context-fallback.test.js` green |

Sequence: P1.1 first and alone (it owns `styles.css`). P1.2, P1.3, P1.4 then run in parallel. P1.5 and P1.6 close the phase.

**Gate additions**: body ink is `#2c2c2b` in light and `#f0efed` in dark, never `#000000`. Text selection outside the terminal paints the Notion blue wash. Reverting this one phase on a scratch branch restores the previous appearance completely; verify by reverting, not by assuming.

### P2. Notion shell, `1.3.0-alpha.13` (first screenshot-able Notion UI)

This is the phase the user is shown. After it, a person familiar with Notion should recognise the system.

| WP | Work | Inputs | Owns | Done criteria |
|---|---|---|---|---|
| P2.1 | Topbar: 80px to **44px**. Reduce type before padding. Move the header stats cluster into a popover. No background, no shadow at rest, bottom hairline, scrolled shadow over 700ms. | `DESIGN-SPEC.md` 4, `PROCEDURE.md` step 6 | `styles.css` topbar region, `focused-shell.css`, `app.js` header region | topbar measures 44px in DevTools |
| P2.2 | Sidebar: 280px to **240px**, `--app-bg-secondary` ground **warmer than the canvas, not darker**, inset hairline right edge, 27px rows, section labels, hover and selected washes, z-index 111. | `DESIGN-SPEC.md` 3, `LAYOUT.md` 1.7 | `styles.css` sidebar region | sidebar measures 240px; its right edge is an inset shadow, **not** a border; the drag still works and still persists |
| P2.3 | Radius sweep: all five ramp tokens re-pointed, all 199 literal `border-radius:` values replaced. | 1.4 | `styles.css` | `grep -oE "border-radius:\s*[0-9]" styles.css \| wc -l` is **0**, down from 199. Chips measure 4px and cards measure 10px and **they are not the same number**. |
| P2.4 | Elevation sweep: every shadow to a token, most to `none`. Keep a shadow only on menus, popovers, modals, toasts, tooltips, the scrolled topbar, avatars and board cards. | `PROCEDURE.md` step 5 | `styles.css` | every remaining `box-shadow` resolves to a token; the count of elements carrying a shadow on the default screen is in single digits; the sidebar, tables, panels and terminal panes carry none |
| P2.5 | Motion sweep: audit all 37 `@keyframes`; delete every scroll reveal, entrance and fade-up; delete all 21 `translateY` hover lifts; set the three duration tokens; write decorative motion **inside** `prefers-reduced-motion: no-preference`; implement the `nt-enable-hover` scroll and drag strip. | `PROCEDURE.md` step 10 | `styles.css`, `app.js` hover-gate region | fade in 150ms, fade out 200ms, in that asymmetry; nothing animates on scroll; no block moves, scales or lifts on hover; hover washes do not flash under the cursor while a list scrolls |
| P2.6 | Global base: body ground and ink, `::selection`, focus ring, the 7px overlay scrollbar with `--app-border-strong` thumb. | `DESIGN-SPEC.md` 1.5 | `styles.css` | every interactive element shows a visible focus ring in both chrome themes under keyboard focus |
| P2.7 | The `instance-colors.js` and `app.js` colour-map re-point, so tab dots and pane tints stop reading the terminal palette. | 1.8 | `instance-colors.js`, `app.js` map region | `instance-colors.test.js` green with no edit |

Sequence: P2.1 and P2.2 in sequence (both own `styles.css`), then P2.3, P2.4, P2.5, P2.6 in sequence. P2.7 runs in parallel throughout (disjoint files).

**This is the first phase whose screenshots go to the user before anything else proceeds.**

### P3. Primitives and chips, `1.3.0-alpha.14`

| WP | Work | Inputs | Owns | Done criteria |
|---|---|---|---|---|
| P3.1 | Buttons and icon buttons: `.btn` family internals replaced, no class renamed. | 2.2 | `styles.css` | no class renamed; `git diff --stat index.html` shows attribute and structure changes only where a wrapper was genuinely added; **two CTA weights, one hue**, no third colour, no gradient, no glow, no icon inside the primary button |
| P3.2 | The two chip systems, split. Status and model become property chips; user-authored tags become named block colours. | 2.3 | `styles.css`, `app.js` chip render region | chips measure 20px tall at 4px radius with `0 6px` padding and 14px/16.8px/500; status chips are 10px pills; the 7px versus 8px dot distinction holds |
| P3.3 | Inputs, selects, checkboxes, switches, the borderless editors. | 2.9 | `styles.css` | metrics match; `accent-color: var(--app-ui-blue)` on every checkbox |
| P3.4 | Focus-visible coverage: every custom control (pill tabs, menu rows, board cards, chip strip, tab-bar items) gains a real ring. The five pinned `:focus-visible` rules are preserved. | floor A3 | `styles.css`, `focused-shell.css` | keyboard tab sweep of every screen shows a visible ring at every stop, in both chrome themes |
| P3.5 | Extend the `@media (forced-colors: active)` block to every new component. | floor A9 | `semantic-theme.css` | boundaries survive in forced-colors emulation |

Sequence: P3.1, P3.2, P3.3, P3.4 in sequence on `styles.css`. P3.5 parallel.

### P4. Composites, regions and recency, `1.3.0-alpha.15`

The largest frontend phase. It is also where the user's recency requirement lands.

| WP | Work | Inputs | Owns | Done criteria |
|---|---|---|---|---|
| P4.1 | Menus, popovers, context menus, command palette. One shadow, one radius, one entrance. Verify the measure-after-unhide and the offscreen-submenu-measure invariants still hold. | 2.4 | `styles.css` menu region | menus and popovers all use one shadow token and one radius; the context menu still lands correctly at every viewport edge |
| P4.2 | Modals and dialogs, scrim, `backdrop-filter` deleted, `.nt-layout` on modal bodies. | 2.5 | `styles.css` modal region | modals use `--app-shadow-scrim` and 10px radius; `grep -c backdrop-filter styles.css` down from 5 to 0 |
| P4.3 | Tables: the measured database view metrics on all four tables. | 2.6 | `styles.css` table region | header row 36px, body rows 32px, hairlines `rgba(42,28,0,0.07)`, row hover the 2.4 percent wash and **not a solid fill** |
| P4.4 | All six tab families to pills. `.nt-tabs` is never used. | 2.7 | `styles.css` tab region, `app.js` tab render | no underline slab and no pill-less text tab anywhere; the pinned tab markup is byte-identical |
| P4.5 | Toasts, board columns and cards, meters, side peek, empty states, skeletons (including the double-declaration fix), avatars, dividers, resize handles, drop slots. | 2.8, 2.10, 2.11, 2.12 | `styles.css` remaining regions, `mirror-view.js`, `schedules.js` | every content loading state is a shimmer skeleton, not a spinner |
| P4.6 | Docs panel as a document surface: `.nt-layout`, block box model, list collapse. | `PROCEDURE.md` step 7 | `styles.css` docs region | at 1440 the docs text column measures exactly 720px with 375px gutters; a one-line paragraph measures exactly 40px; two consecutive list items have 1px of collapsed padding and a solo item keeps 6px; `getComputedStyle` on any block returns `margin: 0px` |
| **P4.7** | **Recency backend**: `GET /api/sessions/recent`, the merged `lastActiveAt` field, the `session:activity` SSE event, hidden exclusion, the stable tie-break. | 2.13.1 | `src/web/server.js` | `test/recency-contract.test.js` green |
| **P4.8** | **Recency surface 1**: Quick Find zero-query recents, as a new branch inside `renderQuickSwitcherResults`. | 2.13.2 | `app.js` quick-switcher region, `styles.css` qs region | `Ctrl+K` then `Enter` opens the most recent session; the uppercase group header is the **only** one in the app |
| **P4.9** | **Recency surfaces 2, 3, 4**: sidebar Recent section, sessions table default sort plus the `Last active` column, workbench "Continue where you left off". | 2.13.3 to 2.13.5 | `index.html`, `app.js` sidebar and table and workbench regions | all four surfaces agree on the first session; the sidebar split arithmetic constant is **measured**, not guessed |
| P4.10 | Copy pass per `VOICE.md`: sentence case, verbs on buttons, headings end in a period, no uppercase, no exclamation marks, no em dashes, every empty state rewritten and individually ticked. | `PROCEDURE.md` step 11 | `index.html`, `app.js` strings | `grep -rnE "text-transform:\s*uppercase" src/web/public/` returns exactly **1**, the Quick Find group header |

Sequence: P4.1 through P4.6 in sequence on `styles.css`. P4.7 runs in parallel from the start (backend). P4.8 and P4.9 depend on P4.7. P4.10 last.

### P5. Terminal input and surface, `1.3.0-alpha.16` (terminal stage 1)

Starts as soon as P1 lands. Owns `terminal.js` and creates `terminal-surface.js`, so it never collides with the chrome track.

| WP | Work | Inputs | Done criteria |
|---|---|---|---|
| P5.1 | `prepareInputForPty(text, { bracketedPasteMode, confirmMultiline })` as a **module-level** function: normalise `\r?\n` to `\r`, gate bracketing on `term.modes.bracketedPasteMode`, strip embedded `\x1b[201~`, report `lineCount`. Route all three paste entry points through it. | TA D1, D2, 9.2, 9.3 | `test/paste-input-preparation.test.js` truth table over `{single, multi} x {bracketed on, off} x {CRLF, LF, CR}` plus the embedded end-marker case. Manual: paste two lines into `cmd.exe` **and** into an agent pane. |
| P5.2 | Multi-line paste safety per the 9.4 table, with `terminalConfirmMultilinePaste` defaulting to `auto`. | TA 9.4 | bracketed sessions never nag; unbracketed multi-line shows the confirm |
| P5.3 | `Ctrl+Shift+C` copies always and never sends SIGINT. `Ctrl+Shift+A` calls `term.selectAll()`. Client `scrollback` 5000 to 10000. | TA D5, 8.4 | the existing Ctrl+C branch is **untouched**: it must keep containing no `preventDefault` and no `copyTextToClipboard`, which `copy-secure-context-fallback.test.js` gates |
| P5.4 | `terminal-surface.js`: the single `terminalSurface(themeId)` projection for all 13 themes. `theme-registry.js` gains the accessor. `TerminalPane.getCurrentTheme()` builds its `ITheme` from it, **with the eight existing static palettes retained as the last-resort fallback** so a missing custom property can never make one pane inherit another theme's colours. | TA 10.2, D1 | `theme-registry.test.js` green with **no edit**; all 13 background hexes unchanged |
| P5.5 | Terminal region restyle: pane frame, pane header, drop slot, the input row **inside the terminal palette** with the `❯` prompt in `terminalSurface().accent` and a top rule in `terminalSurface().rule`. Terminal font moves to `--font-code`. | `DESIGN-SPEC.md` 5.3 to 5.6, `PROCEDURE.md` step 13 | all 16 ANSI colours plus foreground, background, cursor and selection set from the projection, each with a comment naming its source. **Every ANSI colour clears 4.5:1 against its terminal ground in every one of the 13 palettes**, ratios recorded in `INVENTIONS.md`. Cell metrics stable: no column drift after 200 rows. |

**Critical constraint carried into every WP here**: `_colorWithAlpha` at `terminal.js:464-472` **only parses 6-digit hex** and silently returns its fallback for anything else. Every value the projection feeds it must be 6-digit hex. No `rgba()`, no `hsl()`, no `oklch()`, no `color-mix()`. This is risk R5.

### P6. Server terminal core, `1.3.0-alpha.17` (terminal stage 2 plus the width-thrash fix)

No frontend dependency. Starts at the same time as P1.

| WP | Work | Inputs | Done criteria |
|---|---|---|---|
| P6.1 | `src/web/vt-sidecar.js` with `@xterm/headless` and `@xterm/addon-serialize`, containment-guarded require, `VT_SIDECAR_MAX_SESSIONS` 12, headless `scrollback` 500 because the line log carries depth. | TA 7.1, 11.2 | a forced require failure leaves the server up and the byte ring in use |
| P6.2 | Snapshot replay on attach instead of `scrollback.join('')`, behind `CWM_VT_SIDECAR=1`, **defaulting off for one release**. The byte ring is retained for the fallback and for `GET /api/sessions/:id/scrollback`. | TA D3, stage 2 | a byte stream whose prefix has been pruned still snapshots correctly; golden-stream tests re-render to the same grid as a fresh xterm fed the same bytes |
| P6.3 | Mode signal: `{type:'mode', altBuffer, mouseTracking, bracketedPaste}` broadcast on change. Older clients already ignore unknown control types, so the mixed-version window is safe. | TA stage 2 | signal observed on both an agent pane and a shell pane |
| P6.4 | **The width-thrash backend fix**: ownership debounce on `sizeOwner`, suppression of no-op resizes during a settle window, and alternate-buffer-aware replay. | `MOBILE-EXPERIENCE.md` B.9, H.2 item 1 | two clients attached to one session no longer produce a resize storm; each applied resize is counted and asserted |
| P6.5 | Close verification gates VG-3 (is the Codex CLI normal or alternate buffer) and VG-4 (`@xterm/headless` and `CSI ?9001h`) using the Appendix A recipe. | TA 15 | answers recorded in `DECISIONS.md` |

### P7. Unified Scrollback Surface, `1.3.0-alpha.18` (terminal stages 3 and 4)

Depends on P5 and P6.

| WP | Work | Done criteria |
|---|---|---|
| P7.1 | `terminal-history.js`: the layer DOM, open and close **by scroll boundary**, `Shift`+wheel, `Shift+PageUp`, `Escape`, and **printable-key dismissal**. Not a mode: no toggle, no strip, no announcement. | wheel up at the top boundary opens the layer; wheel down at the bottom closes it and pins live; typing dismisses |
| P7.2 | Typography derived from the **live instance** at open time, not from a stylesheet: family, size, line height in px, letter spacing, ground, ink, and horizontal padding measured from `.xterm-screen` so column 1 lands on the same x coordinate. | the layer's computed `font-size`, `line-height` and `background-color` **equal** the live `.xterm-screen` values, asserted in Playwright |
| P7.3 | The **mirror freeze**: pause the `screen` segment refresh on a non-collapsed selection inside the layer. The PTY is never blocked. | a selection held in the layer survives 200 lines of new PTY output |
| P7.4 | The quiet scrollbar affordance: 6px overlay, `--app-border-secondary` at 40 percent, fading after 900ms, representing the whole logical extent so the thumb communicates how much history exists. A 2px indeterminate shimmer at the track top while paging. **No spinner.** | hidden entirely when there is nothing above the current screen |
| P7.5 | Real sources: the `transcript` segment for alternate-buffer panes paged by `beforeOffset`, the `deep` segment from the sidecar line log, the source router re-evaluated on `onBufferChange`, and the **deliberate one-turn overlap seam** with a subtle rule in `terminalSurface().rule` and no label. | scrolling up in an agent pane shows conversation older than the visible frame, selectable, and copying it yields the expected text |
| P7.6 | `Ctrl+Shift+A` upgraded to select the whole document. Select mode **demoted, not retired**: its strip appears only on the first plain drag under mouse tracking. All v1, v2 and v3 identifiers preserved verbatim. | a source-level test asserts **no Select mode identifier was removed** |

**Preservation is unusually strict here.** `terminal-select-mode.test.js` (563 lines) and `terminal-select-v2.test.js` (2636 lines, 134 assertions) assert against the source text of `terminal.js` with regular expressions. Renaming a private method, reformatting a call, or moving a guard breaks them even when behaviour is identical. Strategy is **additive layering, zero deletions**, per `TERMINAL-ARCHITECTURE.md` 13.2.

### P8. Codex parity P0, `1.3.0-alpha.19`

No frontend dependency. Starts at the same time as P1. **P8.1 gates everything else in this phase.**

| WP | Work | Gaps closed | Done criteria |
|---|---|---|---|
| P8.1 | **The dependency spike.** Compare `sql.js` (WASM, pure JS, no build) against copy-the-file plus `node:sqlite`. Node here is v22.16.0, so `node:sqlite` exists but is **experimental and emits a runtime warning**. Measure: read time for the 24MB `state_5.sqlite`, memory, warning noise, and behaviour against a live WAL. **Default to `sql.js` if the result is ambiguous**, per D2. Record in `DECISIONS.md`. | C.1 item 4 | a written comparison with numbers, and a decision |
| P8.2 | `src/providers/codex/state-db.js`. Read-only, copy-before-read, named columns only, `PRAGMA table_info(threads)` probing so a missing column costs one feature rather than the whole path. **Never opens `logs_2.sqlite` (2.1GB).** Tolerates absence, unreadable DB, schema drift and a locked WAL without throwing. | B1, B24 | a forced failure degrades to the walk; discovery under 100ms |
| P8.3 | `src/providers/codex/paths.js`: `normalizeCodexPath`, `projectKeyFor`, `projectIdFor`. Hash the **non-lowercased** normalised path; group on the lowercased one; display the basename of the non-lowercased one. | B2 | both proven hashes reproduce: `sha256("C:\Users\Arthur\Documents\test workday")[:32] === "96dac46ed15428c0b9d16938cd85d65b"`, and the `New project 2` collision collapses to one folder |
| P8.4 | SQLite-first `discover()`, filesystem walk as a **union fallback, not a replacement**. Visible set is `archived = 0 AND preview <> '' AND NOT spawn-child`. Filter on the **spawn edge**, never on `thread_source`. | B1 | returns approximately 125 sessions, up from 52 |
| P8.5 | The seven-step title cascade. Steps 1, 2, 4 and 6 are O(1); step 5 is a file scan and runs **lazily, on demand, only for rows still unresolved**. | B3 | titled coverage rises from 27 of 52 to at least 55 of 125, with the remainder labelled from a truncated `preview` |
| P8.6 | Cross-provider folder merge by `projectKeyFor`, so one directory is one sidebar row carrying both providers' sessions. | B2 | `test workday` appears once, not twice |
| P8.7 | Widen `EFFORT_VALUES` to include `ultra`, `xhigh`, `max` and `SANDBOX_VALUES` to include `disabled` and `managed`. Today's frozen sets silently drop 98 percent of real usage. | B5, B16, B17 | a saved template with `ultra` round-trips |
| P8.8 | `resolveRolloutPath` from `threads.rollout_path`, including the two threads under `D:\CodexArchive` that the walk can never reach. Store the **thread id** as the key and resolve the path at read time, so a synced state file is not machine-specific. | B24, A.6 | O(1) lookup replaces the O(n) walk; `/api/cost/batch` stops re-walking per session |
| P8.9 | Feed `lastActiveAt` from `threads.recency_at_ms` into the recency contract. | 2.13.1 | Codex and Claude interleave correctly by time |

**Contract note for every agent in this phase**: `groupProviderSessionsForUI` emits `claudeSessionId` as the id key for **every** provider, and `findArtifactByWorkingDir` returns `{jsonlPath, claudeSessionId}` for Codex too. These legacy names are load-bearing across the frontend. **Do not rename them.** Add aliases if clarity is wanted; do not remove.

### P9. Codex parity P1, `1.3.0-alpha.20`

| WP | Work | Gaps | Done criteria |
|---|---|---|---|
| P9.1 | Add `custom_tool_call` and `custom_tool_call_output` to the transcript emit set. **This is a correctness bug, not cosmetics: 43 percent of a real session is currently dropped with no error, no warning and no log.** | B8, B7 | a 2465-line rollout yields far more than 217 messages; the 1072 dropped lines are recovered |
| P9.2 | An **unknown-payload-type counter** in `parseTranscript`, surfaced rather than swallowed. Treat the emit set as an allow-list with a logged else-branch, never a silent default. Add a fixture test per observed `cli_version` family. | D.1 | a transcript that drops lines says so |
| P9.3 | `provider.parseUsage()` reading `token_count.info.total_token_usage`, or `threads.tokens_used` for an O(1) total. Flip `supportsCost` to true. **Gate `/api/sessions/:id/cost` on the flag**, which it currently does not do, so Codex reports `$0.00` instead of "unsupported". | B10 | Codex cost is real, or honestly absent, never a false zero |
| P9.4 | Search titles from the same cascade; index from the DB. | B9 | search results carry the titles the user recognises |
| P9.5 | Watcher covers `state_5.sqlite` mtime and `archived_sessions`. **Poll the mtime; do not `fs.watch` `CODEX_HOME`**, which churns constantly from WAL activity. Keep the existing 5-minute fallback poll. | B23 | no watcher storm; new threads appear within the poll interval |
| P9.6 | Rate-limit and plan data from `token_count.rate_limits` into the account usage popover. | A.7 | the three meters carry real Codex data |

### P10. Mobile IA and viewport, `1.3.0-alpha.21` (sections A, C, D)

Depends on P2.

| WP | Work | Done criteria |
|---|---|---|
| P10.1 | The five-tab bar: `home, sessions, terminal, attention, search`. The More tab is **dissolved** into Home > Workspace. `showMoreMenu` and its four pinned labels are **retained** for the classic shell. | `test/mobile-ia-contract.test.js` green; the three pin edits SE-8, SE-9, SE-10 land in the **same commit** as the source change, because a `deepStrictEqual` cannot be split |
| P10.2 | The Home screen with all eight blocks, including the added Workspace section that absorbs the fourteen orphans. **Zero orphans**: every capability in the A.3 manifest has a canonical route. | walk every route by script; the assertion that no capability's only marker sits inside `.terminal-pane-header` is the regression gate for the **six currently-unreachable capabilities**, of which the microphone is the sharpest example |
| P10.3 | `mobile-viewport.js`: one owner of viewport geometry. **No `transform` is ever written**, which removes the containing-block bug that breaks every `position: fixed` descendant. `body.keyboard-open { position: fixed }` is deleted. Keyboard detection stops comparing against `window.screen.height`. | exactly **one** resize frame is sent to the stub PTY per keyboard open-and-close cycle, not three |
| P10.4 | The CSS contract: `.app { height: 100dvh }` refined to `var(--mw-vh)`, `interactive-widget=resizes-content` on the meta viewport, `100vh` eliminated from every mobile block. **`user-scalable=no` and `maximum-scale=1` remain forbidden.** | no `100vh` anywhere in `styles-mobile.css` or the phone blocks of `focused-shell.css` |
| P10.5 | The permanent input row. The Type toggle is removed; `_mobileTypeMode` is **retained** and reachable through the Raw keys escape hatch, which preserves per-keystroke input. Autocorrect stays **on** for the input row and **off** for xterm's textarea. | `term.focus()` is never called on phones, so the focus-based width claim cannot fire |
| P10.6 | The 44px sweep and the hit-box expansion rule. Nine mock elements are under the floor; the floor wins. For scroll containers, expand the **item's own padding**, because `overflow-x: auto` computes the other axis to `auto` and clips a pseudo-element. | enumerate every interactive element, compute its hit rect including `::before` expansion, report every one under 44x44. **Zero rows is the pass condition.** No two expanded rects intersect. |
| P10.7 | Safe-area insets on all eight surfaces, including the currently-unhandled landscape notch on `.app`. | `env(safe-area-inset-*)` present on all eight |

### P11. Mobile interaction and touch, `1.3.0-alpha.22` (section B, terminal stage 5, section E)

| WP | Work | Done criteria |
|---|---|---|
| P11.1 | The three-zone long-press model as an **allowlist** via `data-mw-zone`, replacing today's denylist. **The pane container becomes Chrome, not Affordance**, and its listener is removed; the pane sheet moves to the header overflow and to a chip long-press. One timing constant, 400ms, everywhere. | synthesise a 450ms hold on a member of each zone: Text produces a selection and no sheet, Affordance produces a sheet, Chrome produces neither |
| P11.2 | The toast contract. Root cause first: **a toast with no action is `pointer-events: none`**, with a `.toast-notice` class as the guaranteed fallback because `:has()` is not universal on older WebKit. Placement computed from measured chrome, never a magic constant. | `elementFromPoint` at the centre of every key-toolbar button and the input field returns **no toast node** while a toast is visible |
| P11.3 | **No floating action buttons on phones.** `.terminal-pane-schedule` gets `display: none` at 768px and below, matching the upload button; the capability moves to the pane overflow sheet with its count. | both FABs compute to `display: none` at phone widths |
| P11.4 | The priority-plus key toolbar. **No horizontal scrolling**; overflow goes to a pinned sheet. The honest count at 390px is five to six keys, not the mock's seven, because seven requires 40px keys which are under the floor. | zero horizontally scrolled content at 360, 375, 390 and 430px; the overflow button is visible and 44px |
| P11.5 | Drag and drop off on phones (`data-mw-dnd="off"`); tap-to-open and "Open in new pane" replace it. The guarded pane swipe: 96px travel, 32px edge exclusion, inert while a selection exists. | a 90px swipe does **not** switch panes; a 110px one does; neither does while a selection exists |
| P11.6 | B.9 client-side width discipline: claim only when genuinely foreground and the Terminal tab is active, never while the keyboard settles, never from the input row, a per-session **Follow this device** toggle, and the "Another device is setting the width. Tap to take over." notice. | no `activate` frame is sent while the Sessions tab is active |
| P11.7 | Terminal stage 5: wheel escalation behind a flag, momentum carried through the boundary, native selection handles, pull-to-refresh suppression, `Ctrl+Shift+Home` and `Ctrl+Shift+End`, reduced-motion on the open and close animations. | manual matrix on a real phone; touch selection cannot be meaningfully asserted headlessly |
| P11.8 | Performance: `scrollback` 2000 on phones, two live panes with the rest dormant, Reader capped at 200k characters tail-biased, lazy loading per E.4. | 2000 lines of output produce no long task over 50ms and no frame over 16ms on the active pane; a fling produces no frame over 32ms |

### P12. PWA, art direction and acceptance, `1.3.0-alpha.23`

| WP | Work | Done criteria |
|---|---|---|
| P12.1 | Manifest: stable `id`, **real 192 and 512 icons** (both entries currently point at the same `/logo.png` with different declared sizes, so one is a lie), a maskable icon, Notion `background_color` and `theme_color`, `orientation: any`, shortcuts, narrow-form screenshots. | manifest validates; icons resolve at their declared sizes |
| P12.2 | Theme colour synced to the chrome theme, plus the three iOS meta tags. `black-translucent` is **deferred** until the safe-area header padding has shipped and been verified. | `theme-color` matches the active chrome after a switch |
| P12.3 | Service worker, **last and behind a flag**. Network-first HTML with a 2s timeout, stale-while-revalidate for the `?v=`-keyed assets, cache-first for fonts and vendor, `/api/*` never cached. Build stamp separate from the cachebusters. Update toast with an action; never reload under the user's fingers. A kill switch that unregisters on a version mismatch. | offline reload serves the shell; `/api/*` is never served from cache; the update toast appears on a stamp change |
| P12.4 | Art direction: one monoline icon family at one stroke weight on a 16-unit grid, `currentColor` only, **no icon inside a rounded square**. The only filled glyphs are the three-dot overflow circles. Figurative illustration restricted per OQ-3. | all icons come from one family; no mixed icon sets; empty states carry an illustration or nothing, never a grey box |
| P12.5 | The final acceptance sweep, section 5.5. | every row green |

---

# 5. VERIFICATION GATES

## 5.1 The standing gate, run at the end of every phase

No phase merges until all four blocks pass.

**Block 1: the suite.**

```bash
cd C:/Users/Arthur/Desktop/cwm-restyle
npm test                       # assertion count must be >= the P0.1 baseline
```

**Block 2: the fast targeted gates, run after every file rather than every phase.**

```bash
node test/phantom-tokens.test.js
node test/css-tokens.test.js
node test/notion-token-parity.test.js
node test/mobile-ux-fixes.test.js
node test/usage-meter.test.js
```

**Block 3: the executing gates, run BEFORE touching any `app.js` or `terminal.js` template, so a break is attributable.**

```bash
node test/terminal-host-ownership.test.js
node test/provider-tabs.test.js
node test/settings-providers.test.js
node test/terminal-select-v2.test.js
```

**Block 4: screenshots and the grep gates.**

```bash
npx playwright test test/browser/notion-shell.spec.js   # 1280x800 and 390x844, both chrome themes
node scripts/do-not-break-gates.js                      # G1 through G12, section 5.3
```

Screenshots go to the session scratchpad, never into the repository, and every PNG is dimension-checked to be at most 2000px on both axes before any of them is read into a model context.

**Nothing deploys live until the user has seen the screenshots.**

## 5.2 Per-phase gate additions

| Phase | Additional checks |
|---|---|
| P0 | Baseline recorded. All gates pass on unmodified source, proving they are not vacuous. |
| P1 | `getComputedStyle(document.body).fontFamily` starts with `ui-sans-serif`. Zero network requests to `fonts.googleapis.com` or `fonts.gstatic.com` on a hard reload. Body ink is `#2c2c2b` light and `#f0efed` dark, never `#000000`. Toggling `data-chrome` leaves no orphaned surface. **Reverting this phase alone on a scratch branch restores the previous appearance completely.** |
| P2 | Topbar measures 44px. Sidebar measures 240px with an **inset** right edge, not a border. `border-radius:` literal count is 0. Shadow-carrying elements on the default screen are in single digits. Fade in 150ms and fade out 200ms. Nothing animates on scroll. Nothing scrolls horizontally at 320, 768, 1024, 1440. The terminal grid, sessions table and kanban board are **not** capped at 720px. |
| P3 | Chips are 4px and cards are 10px, measured, and they are not the same number. Buttons, inputs and chips match their metrics in DevTools. Keyboard tab sweep of every screen shows a visible ring, both themes. No class was renamed. |
| P4 | Docs column measures exactly 720px at 1440 with 375px gutters; a one-line paragraph measures exactly 40px; consecutive list items collapse to 1px. Table header 36px, rows 32px, row hover is the 2.4 percent wash. **The seven recency acceptance criteria in 2.13.7.** |
| P5 | Every ANSI colour clears 4.5:1 against its ground in all 13 palettes, ratios recorded. No column drift after 200 rows. A full agent session, a coloured `git diff` and an `npm test` run are all legible in both chrome themes; screenshot each. |
| P6 | A forced require failure leaves the server up. A prefix-pruned byte stream still snapshots correctly. One resize per settle window with two clients attached. |
| P7 | The history layer's computed `font-size`, `line-height` and `background-color` equal the live `.xterm-screen` values. A selection held in the layer survives 200 lines of output. Typing dismisses. **A source-level test proves no Select mode identifier was removed.** |
| P8 | Discovery returns approximately 125 sessions in under 100ms. Both proven sha256 project ids reproduce. A forced DB failure degrades to the walk. |
| P9 | The dropped-transcript bug is closed and measured. Codex cost is real or honestly absent, never `$0.00`. |
| P10 | The 44px sweep returns **zero** rows. No two expanded hit rects intersect. Exactly one resize frame per keyboard cycle. Every A.3 route walks to its surface. |
| P11 | Toast occlusion test passes. Both FABs are `display: none` on phones. Zero horizontally scrolled toolbar content at four widths. Swipe guard thresholds hold. |
| P12 | Manifest validates. Offline reload serves the shell. `/api/*` never cached. One icon family, no rounded-square icon containers. |

## 5.3 The DO-NOT-BREAK grep gates

Implemented as `scripts/do-not-break-gates.js`, run from the repo root. Each gate prints its number, its measured value and its target.

| # | Gate | Command or check | Target |
|---|---|---|---|
| G1 | IDs intact | `grep -oE 'id="[a-zA-Z0-9-]+"' src/web/public/index.html \| sort -u` diffed against `docs/design/notion-restyle/id-snapshot.txt` | **additions only**, zero removals |
| G2 | JS-coupled classes intact | every name in `class-snapshot.txt` still appears in `index.html`, `app.js`, `terminal.js`, `mirror-view.js` or `schedules.js` | zero missing. **This is the only gate that catches the 23 behaviour-only classes with no CSS rule anywhere**, which a "remove unused classes" pass would silently delete. |
| G3 | `[hidden]` guards | count of `[hidden]` guard rules across the four stylesheets | at least 12, never decreasing |
| G4 | Catppuccin purged from chrome | `grep -nE "var\(--(base\|mantle\|crust\|surface0\|surface1\|surface2\|overlay0\|overlay1\|subtext0\|subtext1\|mauve\|lavender\|flamingo\|rosewater\|sapphire\|sky\|peach\|pink\|text\|blue\|green\|yellow\|red\|teal)\)" src/web/public/*.css` minus the 13 theme blocks and the terminal-furniture allow-list | 0 by end of P4 |
| G5 | Hex literals | `grep -oE "#[0-9a-fA-F]{3,8}" src/web/public/styles.css \| wc -l` | baseline 316. Target is the Notion `:root` block plus the 13 theme blocks **only**. Every hit outside those is a failure. `styles-mobile.css` 5 to 0, `focused-shell.css` 1 to 0. |
| G6 | Radius literals | `grep -oE "border-radius:\s*[0-9]" src/web/public/styles.css \| wc -l` | 199 to **0** |
| G7 | Uppercase labels | `grep -rnE "text-transform:\s*uppercase" src/web/public/` | exactly **1**, the Quick Find group header, and nothing else |
| G8 | Hover lifts | `grep -n translateY src/web/public/styles.css` | every surviving hit is a layout translate, never a hover lift, and is justified in the commit message |
| G9 | Gradients and glass | `grep -c linear-gradient src/web/public/styles.css` and `grep -c backdrop-filter src/web/public/styles.css` | 5 and 5 down to 0, or one deliberate documented exception each |
| G10 | Cachebuster atomicity | `grep -rn "?v=" src/web/public/index.html test/` | the four head assets, `terminal.js` and `app.js` literals agree across `index.html`, `experience-ux-contract.test.js`, `terminal-select-mode.test.js` and `copy-secure-context-fallback.test.js`. **Treat a bump as a five-file atomic change.** |
| G11 | Semantic layer purity | `grep -nE "#[0-9a-f]{3,8}\b\|rgba?\s*\(\|hsla?\s*\(" src/web/public/semantic-theme.css` | **0 matches** |
| G12 | Em dashes and prose double hyphens | scan changed files for U+2014, U+2015, and `--` used as prose punctuation in user-facing strings and comments | 0 |

## 5.4 The sanctioned test edits, in full

These ten are the **only** test-expectation edits this program authorises. Each ships in the same commit as its source change, with the stated reason comment. An agent that hits an unlisted break stops and reports.

| ID | File | Change | Reason comment to write |
|---|---|---|---|
| SE-1 | `test/css-tokens.test.js` rows 1 to 6 | `var(--mauve)` to `var(--app-text-purple)`, `var(--green)` to `var(--app-text-green)`, `var(--blue)` to `var(--app-text-blue)`, in both the accent and the tint assertions. The `color-mix(in srgb, var(--X) N%, transparent)` shape and the no-hex rule are unchanged. | "Notion restyle: provider identity is a named block-palette hue, not the app brand. Token names unchanged." |
| SE-2 | `test/provider-label-pill.test.js` | `--mauve` to `--app-text-purple` and `--green` to `--app-text-green` in the two 8-percent `color-mix` assertions; `--bg-primary` to `--app-bg-primary`; `border-top: 4px solid` to `1px solid`. | "Notion restyle: a 4px one-side accent bar is on the rejection list; the pane frame carries a 35 percent tint of the hairline instead." |
| SE-3 | `test/css-tokens.test.js` row 10 | the `linear-gradient(180deg, ...)` assertion becomes a flat `background: var(--provider-claude-tint)` assertion. | "Notion restyle: gradients are on the rejection list (effects.css lines 20 to 21)." |
| SE-4 | `test/terminal-select-v2.test.js` | the literal `JetBrains Mono` inside the `_ensureCopyOverlay` inline-style assertion becomes `--font-code`. **Every other anchor in this 134-assertion file is untouched.** | "Notion restyle: the terminal mono stack is --font-code per PROCEDURE 5.3 option C." |
| SE-5 | `test/codex-status-strip.test.js` | `var(--red)` to `var(--app-text-red)` within the 400-char window. | "Notion restyle: status ink moves to the named block palette." |
| SE-6 | `test/usage-meter.test.js` | the three whitespace-exact single-line rules change token names only: `var(--green)` to `var(--app-text-green)`, `var(--yellow)` to `var(--app-text-yellow)`, `var(--red)` to `var(--app-text-red)`. **Do not reformat; they are matched as single lines.** | "Notion restyle: meter thresholds use the named block palette." |
| SE-7 | `test/experience-ux-contract.test.js`, `test/terminal-select-mode.test.js`, `test/copy-secure-context-fallback.test.js` | the cachebuster literals `?v=20260725-5`, `terminal.js?v=20260806-selectv3`, `app.js?v=20260805-mobile-select1` bump together with `index.html`. | "Notion restyle phase N: assets changed, cachebuster bumped atomically across index.html and three tests." |
| SE-8 | `test/focused-shell.test.js` line 158 | `['workspace','terminal','tasks','more']` to `['home','sessions','terminal','attention','search']`. | "Notion restyle IA: five-tab bar per DESIGN-SPEC 14.1; tasks moves to Home > Workspace, more is dissolved into Home > Workspace and per-surface overflow sheets." |
| SE-9 | `test/mobile-ux-fixes.test.js` P0-2 | retarget the four label assertions to the Home Workspace section builder plus the per-surface overflow builders. **`showMoreMenu` and its four labels stay intact for the classic shell.** | "Restyle: the four labels now live on Home > Workspace; showMoreMenu is retained for data-ui-shell=classic." |
| SE-10 | `test/mobile-ux-fixes.test.js` P0-3 | `recent` folds into the Sessions sort chip; assert the sort chip instead of the sheet route. **The `recent` view mode itself stays alive for desktop and stays in the pinned secondary tier.** | "Restyle: recent is a Sessions sort chip, not a view mode, on phones." |

SE-8, SE-9 and SE-10 are `deepStrictEqual` and label assertions. **They cannot be split across commits from the source change.** They land in P10.1 as one commit.

## 5.5 The final acceptance sweep

Run once, at the end of P12, before anything is called complete.

### 5.5.1 Feature Inventory parity

Every row of `docs/design/notion-import/Feature Inventory.md` must be `●`, or `◐` **with a named route**. No row may be `○` without an explicit deferral recorded in `DECISIONS.md` with a reason.

Rows currently `○` that this program closes: More menu Docs, More menu Resources, provider tabs (deliberately replaced by per-row chips), collapse sidebar, pane fullscreen and font size, bulk select, PR dialog, task spinoff, td integration, folder browser, Update modal, pair mobile, UI scale, mobile pair device. Rows that remain `○` need a `DECISIONS.md` deferral row each. The account panel machines strip stays `○` pending a multi-machine model.

### 5.5.2 The 17-step device script

The `MOBILE-EXPERIENCE.md` G.5 human script, run on a real phone, ten minutes, recording pass, fail, or "feels wrong" plus one sentence. It is the only thing that verifies momentum feel, native selection handles, real keyboard geometry, IME and autocorrect, safe-area insets, haptics, PWA standalone chrome, touch latency under live output, and the Android back gesture. **Playwright emulation is blind to every one of those.**

Step 17 gains a recency clause: without using search, find Costs, Paired devices, Project notes, Scheduled messages, the microphone, **and the most recently active session**. Anything over 15 seconds is an IA failure; the recency target is 5 seconds.

### 5.5.3 The APPLY.md QA checklist

`PROCEDURE.md` section 7 in full: Tokens, Type, Colour and contrast, Layout, Motion, Voice, the final test, and the deliverables gate. Concrete pass or fail, no judgement calls. Two items deserve restating because they are the ones most often skipped:

- **Tracking is negative at every size above 16px and positive only at 12px.** This is the most commonly missed detail in the whole system.
- **The three-second test, run twice**: once on a document surface (the docs panel) and once on a data surface (the terminal grid), each judged against its own class. If a Notion user says "Linear", the greys are still cool and the density is too high. If they say "a generic docs site", the illustration is missing and the column is too wide.

### 5.5.4 The contrast floor

All ten rows of `PROCEDURE.md` 4.1, measured and tabulated as ratios, not asserted as a pass. A1 body text 4.5:1 on **every** surface it appears on, including every status surface and every one of the 13 terminal grounds. A2 large text and UI 3:1. A3 focus ring visible on every interactive element in both chrome themes. A4 disabled distinguishable without colour alone. A5 body text is never `#000000`. A6 and A7 reduced motion honoured, and decorative animation written **inside** `no-preference` rather than disabled inside `reduce`. A8 no animation blocks interaction. A9 forced colours keeps every boundary. A10 all 16 ANSI colours clear 4.5:1 on their ground.

The known collision is the mid orange `#d27b2d` and the yellow `#cb9434` as small text on the canvas. They fail at about 3.1:1 and the correct response is to re-pair them onto their matching `--app-bg-<hue>` wash, **never to darken the token**. Each instance gets a `DEVIATIONS.md` row and an inline CSS comment naming the measured ratio.

### 5.5.5 The deliverables gate

- `DEVIATIONS.md` exists and every departure has a row: what the brand says, what shipped, why, what it costs, who approved, date.
- `INVENTIONS.md` exists and every derived component has a row: nearest relative, what was inherited, what was invented.
- `DECISIONS.md` exists and answers `PROCEDURE.md` 0.4, step 12 and 5.3, plus all five open questions in section 7.
- Every commit maps to exactly one work package, and the P4.6 spacing work is a separate, later commit than the P1.1 token work, per the rollback caution.

---

# 6. RISK REGISTER

Twelve risks, ordered by expected cost. Each carries a mitigation that is an action, not an intention.

### R1. `styles.css` churn, formatting and CRLF break the text-extraction anchors

**Severity: highest.** About twenty assertions slice rule bodies with `indexOf(selector + ' {')` and cut at the **first** `}`, or match whole single-line rules verbatim such as `.usage-meter-fill.u-low { background: var(--green); }`. Others use `balancedBlock()`, which takes the **first** literal occurrence of a selector string. The file is 12202 lines, stored with CRLF, and this program rewrites most of it.

**Mitigation.** No repo-wide Prettier or Stylelint pass, ever, on `src/web/public/*.css`. Edit rules in place. Preserve the single space before `{`. Never merge a pinned selector into a grouped list; put shared properties in a new grouped rule and leave the pinned selector as its own rule underneath even if it carries one declaration. Never introduce a nested brace into a pinned rule body. Do not normalise line endings. Run block 2 of the standing gate after **every file**, not every phase, so a break is attributable to one edit.

### R2. `focused-shell.css` `!important` interplay with JS-written inline grid tracks

Three layers compete on `#terminal-grid` and the resolution is deliberate: the default track template in `styles.css:5092-5097`, then JS inline styles from the drag-resizable fr ratios, then `focused-shell.css:291-324` overriding the inline styles **with `!important`** for 5- and 6-pane layouts at laptop widths and inside `@container workbook-main`. **Dropping the `!important` silently reverts 5- and 6-pane layouts to three columns on laptop widths**, and `experience-ux-contract.test.js` asserts all of it literally, including `container-name: workbook-main` and `container-type: inline-size`.

**Mitigation.** Treat those two blocks as frozen. Any new grid rule goes **below** them, never above. Verify with `node test/experience-ux-contract.test.js` and `node test/focused-shell.test.js` after every `focused-shell.css` edit. The inverse hazard is equally real: an `!important` added by the restyle on a property JS writes inline makes the JS inert. The list of JS-owned inline properties is in `DO-NOT-BREAK.md` D.11 and includes `gridTemplateColumns`, `gridTemplateRows`, `width`, `height`, `left`, `top`, `transform` and `cursor`.

### R3. `@xterm/headless` version drift against the vendored `@xterm/xterm@6.0.0`

The sidecar must share one parser and one set of quirks with the client. A mismatch produces a snapshot that re-renders differently from the live pane, which is the exact failure the sidecar exists to prevent. `@xterm/headless` is also a **new server-side dependency**, and VG-4 (does it handle the ConPTY `CSI ?9001h` win32 input mode without warnings) is still open.

**Mitigation.** Pin `@xterm/headless` and `@xterm/addon-serialize` to exact versions matching the vendored client, no caret. Close VG-4 in P6.5 with a golden-stream test before the sidecar ships. Ship behind `CWM_VT_SIDECAR=1`, **defaulting off for one release**. Containment-guard the require exactly as `pty-manager.js` guards `node-pty`, so a failed load degrades to the byte ring rather than taking the server down. It is pure JavaScript, so it carries none of `node-pty`'s prebuild risk.

### R4. Codex SQLite schema drift

`threads` already shows migration scars: `created_at` beside `created_at_ms`, `updated_at` beside `recency_at_ms`, and a trailing block of `ALTER TABLE`-added columns. `_sqlx_migrations` exists, so the schema keeps moving. The visible-thread predicate is an **UNCONFIRMED inference**: the schema and the counts support it, but the desktop app's actual query was never read.

**Mitigation.** `SELECT` named columns only, never `SELECT *`. Probe `PRAGMA table_info(threads)` and degrade **per column**: a missing `is_pinned` costs the pin feature, not the whole discovery path. Keep the filesystem walk permanently as a union fallback; it is also the only path that works when the desktop app has never run. Read-only handles only, copy-before-read, because a write to this DB damages the user's real session history. Never open `logs_2.sqlite` (2.1GB). A companion risk: `custom_tool_call` already proves format drift silently dropped 43 percent of a transcript, so P9.2's unknown-payload counter is mandatory, not optional.

### R5. `_colorWithAlpha` only parses 6-digit hex

`terminal.js:464-472` accepts 6-digit hex and **silently returns its fallback for anything else**. A palette value expressed as `rgba()`, `hsl()`, `oklch()` or `color-mix()` loses the terminal selection colour with no error. The `terminalSurface` projection feeds this function.

**Mitigation.** Every value in the projection is 6-digit hex, asserted by `test/notion-token-parity.test.js` with a regex over the projection data. The eight static xterm palettes stay as the last-resort fallback so a missing custom property can never make one pane inherit another theme's colours. Consider widening `_colorWithAlpha` to parse `rgb()` **additively**, as a new branch, never by replacing the hex branch, since its shape is source-anchored.

### R6. z-index ladder collisions

The authored ladder runs 0, 1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 100, 200, 900, 1000, 9999, 10000, 10001, 10002, 10003, 10004, with load-bearing comments explaining several of them: `.terminal-pane.pane-expanded-stage2` sits at 900 **deliberately below 1000**, `.modal-overlay` at 10002 **must beat `.context-menu`** at 10000, and `SELECT_STRIP_Z_INDEX` is a constant in `terminal.js`. This program adds at least four new layers: the history layer, the mobile toast anchor, the Home workspace sheets and the recency popover.

**Mitigation.** New layers take **existing** rungs rather than inventing new ones: the history layer sits inside the pane body below the pane's own chrome, the recents surfaces reuse the popover rung. Do not introduce any value above 10004. Record every new z-index in an appendix to `DEVIATIONS.md` alongside the existing ladder. The mobile tab bar at 50 and the account sheet at 10001 are the two most collision-prone rungs; verify both after every mobile phase.

### R7. Cachebuster and test-token coupling

The restyle **must** bump `?v=` so browsers refetch, and four literals are asserted across three test files. Meanwhile `styles.css` and `styles-mobile.css` carry **no** cachebuster today, so a CSS-only change ships stale to every warm cache.

**Mitigation.** Treat a bump as a **five-file atomic change**: `index.html` plus `experience-ux-contract.test.js` plus `terminal-select-mode.test.js` plus `copy-secure-context-fallback.test.js`, verified by gate G10. Add a cachebuster to `styles.css` and `styles-mobile.css` in P1.6, which is free because nothing pins them today. Keep the service-worker build stamp a **separate constant** from the cachebusters, so bumping one never requires touching the other.

### R8. Session length, compaction, and work survival

This program is long. A context compaction mid-phase loses everything not on disk. The two selection test files alone total 3199 lines of source-text assertions, which is a real constraint on refactoring velocity and a real temptation to batch changes.

**Mitigation.** Every phase leaves the branch green and every work package is one commit, so the maximum loss is one package. Refresh `<project>/.claude/HANDOFF.md` at every phase boundary and at any 75 percent context warning, capturing standing directives, live state, commits and flags shipped, the prioritised remaining TODO, and the one-liner commands. After any compaction, read the handoff **first** and continue. Never start a work package whose context package would take longer to write than the task itself; do those inline.

### R9. The phantom-token definition-site trap

`test/phantom-tokens.test.js` scans `styles.css` and `styles-mobile.css` as **both** the consumption and the definition set. It does not scan `focused-shell.css`, `semantic-theme.css` or anything vendored. A token defined only in the vendored bundle and consumed in `styles.css` is a phantom, and the rule using it silently does nothing.

**Mitigation.** Section 1.1.1 is the structural answer: all raw values are authored into `styles.css` `:root`, the vendored token files are never linked, and `test/notion-token-parity.test.js` diffs the two so the duplication cannot drift. That test additionally asserts every `var()` in the vendored `components.css` resolves against the union of definition sites, which closes the one hole the phantom gate cannot see.

### R10. The provider-accent knot must move as one unit

`css-tokens.test.js` pins `--provider-claude-accent: var(--mauve)` and the tint shape; `provider-label-pill.test.js` pins the same hue at **exactly 8 percent** and a **4px** top border; `css-tokens.test.js` row 10 pins a `linear-gradient` that the rejection list forbids. One file lets the tint percentage drift while the other pins it.

**Mitigation.** SE-1, SE-2 and SE-3 are a single commit. Change both percentages or neither. Never edit one of the three without the other two. Run `node test/css-tokens.test.js && node test/provider-label-pill.test.js && node test/search-render.test.js` together as a triple after that commit.

### R11. Terminal palette leaking into chrome through the JS colour maps

Five maps build `var(--<name>)` strings by concatenation from palette **names**. If they keep pointing at the palette, the sidebar dots, tab dots, pane tints, folder tints and workspace accents will render in the **terminal theme's** hues, which `DESIGN-SPEC.md` 10.4 explicitly forbids. `instance-colors.test.js` pins the array literal, so the naive fix (rename the entries) is unavailable.

**Mitigation.** Section 1.8: keep the pinned arrays byte-identical and add a separate name-to-token map used only at string-build time. Verified safe against the test, which pins array values and modulo-6 wraparound, not the emitted string. Gate G4 catches any survivor.

### R12. Layout-read couplings break when the chrome shrinks

The chrome is shrinking from an 80px header and a 280px sidebar to 44px and 240px, and P4.9 **adds a sidebar section**. Four measured couplings depend on those numbers. `app.js:11591` subtracts a hard-coded `200` for headers and footer when splitting the sidebar interior. `app.js:11499-11549` writes `#sidebar` `style.width` and **reads it back** with `parseInt`, so moving the sidebar into a grid track makes the drag inert and `NaN` kills persistence. `terminal.js:2141` `safeFit()` early-returns on a zero-rect container, so a collapsed flex track or a missing `min-height: 0` leaves the PTY at 80x24 forever. `terminal.js:4493` `_copyOverlayTopPx()` treats a measured `0` as meaningful, so **hiding the mobile pane header with `visibility: hidden` or `opacity: 0` instead of `display: none` regresses a previously-fixed bug** and leaves a live repainting band above the Copy view snapshot.

**Mitigation.** The `200` becomes a measured value, not a guess, in P4.9. `#sidebar` stays an element whose `width` property controls its size; the drag, the `180..600` clamp and `cwm_sidebarWidth` are untouched. Keep `min-height: 0` on every flex column in the pane chain. Hide the mobile pane header with `display: none` only. `safeFit()` is re-run after sidebar collapse (250ms), sidebar drag end, UI-scale change (100ms), visual-viewport resize and grid relayout; **if any new animation runs longer than those delays, the fit measures mid-animation** and must be re-timed.

---

# 7. OPEN QUESTIONS FOR THE USER

Five, each with a default that ships if no answer arrives. Nothing blocks.

### OQ-1. The chrome theme attribute name

`data-theme` is already occupied by 13 persisted ids, is read pre-paint, drives the terminal palette and is pinned by three test files. Decision D1 says "Notion light/dark via `data-theme`", which cannot be taken literally without breaking persistence and the terminal.

- **Default (ships unless told otherwise):** a new `data-chrome="light|dark"` on `<html>`, persisted as `cwm_chrome`, with every dark block written as `:root[data-chrome="dark"], :root[data-theme="dark"]` so the bundle contract and the literal wording both resolve.
- **Alternative:** reuse the existing `data-theme-appearance`, which costs zero new attributes but couples chrome appearance to the selected terminal palette, which `DESIGN-SPEC.md` 10.1 forbids.

**Cost of getting it wrong:** a persisted-preference migration for every existing user.

### OQ-2. The terminal font

`PROCEDURE.md` 5.3 explicitly leaves this to the orchestrator and it needs a `DECISIONS.md` row.

- **Default:** `--font-code` (`SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace`) for the terminal, iA Writer Mono for code blocks, IDs, branch names and diff hunks. `--font-code` is a real captured Notion token used for exactly this job, it keeps the terminal on native metrics, and it needs no deviation note.
- **Alternative A:** iA Writer Mono everywhere, one family, most faithful, but it is text-oriented and slightly wide, so a fixed-width terminal fits fewer columns at the same point size.
- **Alternative B:** keep a terminal-specific mono. This is a documented deviation and needs a `DEVIATIONS.md` row.

**Cost:** column count per platform, and one `terminal-select-v2.test.js` anchor either way.

### OQ-3. Figurative illustration

`PROCEDURE.md` step 12 says this is not optional decoration for this brand, and `readme.md` ranks the hand-inked illustration as brand tell number four. `CONVERSION.md` section 7 offers a developer-product escape hatch, warning that naive hand-inked figures can read as unserious on a developer tool.

- **Default:** adopt the icon and texture half in full (the 43-symbol monoline sprite, one stroke weight), and restrict hand-inked illustration to the **login screen and the workbench empty state**, where warmth helps and nothing is being claimed. Everywhere else: no art rather than placeholder art.
- **Alternative:** drop figurative illustration entirely and use the chromeless product-screenshot treatment. This has a measurable cost against the three-second test.

### OQ-4. The default mobile landing tab

- **Default:** Home, which makes recency the first thing the phone shows and is what the recency requirement argues for. `?tab=` and the two manifest shortcuts cover the alternative, plus a Settings preference.
- **Alternative:** Terminal, defensible for an owner who opens the app to check on a running session.

### OQ-5. Codex P2 scope, and the shadowed summarize route

`CODEX-PARITY.md` P2 covers auto-title, summarize, subagents from the spawn graph, shared export and extract readers, pins and sections, and the cwd fallback. Auto-title and Summarize are **hard 404s** for Codex today. Separately, **two `POST /api/sessions/:id/summarize` handlers are registered**, at `server.js:2800` and `:5660`; Express serves the first, so the provider-aware one is unreachable dead code. The code-preservation rule forbids deleting the shadowing handler.

- **Default:** ship P0 and P1 in this program (phases P8 and P9), defer P2 to a follow-up, and in P9 make the **first** handler at `:2800` dispatch through the provider registry rather than reordering or deleting anything. Record the dead code in `DEVIATIONS.md` rather than removing it.
- **Alternative:** pull P2-1, P2-2 and P2-3 into P9, which adds roughly one phase of work but closes the two 404s and unlocks the Codex subagent graph, which is genuinely richer than Claude's.

---

## 8. Rollback

Because P1 points existing variables at new tokens rather than rewriting call sites, rollback is: revert the token block, revert the theme indirection, keep everything else. Every phase is its own set of commits so any single phase reverts without unwinding the rest.

The one caution that decides commit order: **P4.6, the margin-to-padding conversion on document surfaces, is the hardest step to revert**, because it rewrites component internals rather than a theme layer. It ships in its own commit, after the token work is merged and stable, so reverting it does not take the palette with it.

The project-specific rollback aid: `src/web/public/semantic-theme.css` is 93 lines and is the single choke point for the colour contract. **Reverting that one file plus the two root attributes returns the app to Catppuccin even if every other phase has landed.**








