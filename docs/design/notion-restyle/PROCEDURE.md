# PROCEDURE: retrofitting the Notion design system onto Myrlin Workbook

Status: analysis deliverable. Nothing in this file has been applied to source. No source file was
modified to produce it.

Audience: implementation agents who have never seen either codebase. Everything you need to start is
either here or at a cited path.

Authority: this document is a faithful adaptation of the retrofit playbook at
`C:/Users/Arthur/Desktop/work/design-systems/notion/build/APPLY.md`, with layout rules from
`.../build/LAYOUT.md`, motion rules from `.../build/MOTION.md`, copy rules from `.../build/VOICE.md`,
brand truth from `.../build/readme.md`, and the commercial read from `.../build/CONVERSION.md`.
Where this document departs from APPLY.md, the departure is labelled ADAPTATION and carries a
reason. Where APPLY.md is quoted as a hard rule, it wins over anything convenient.

Design bundle, two copies, identical content:

| Copy | Path | Use it for |
|---|---|---|
| Canonical, read only | `C:/Users/Arthur/Desktop/work/design-systems/notion/build/` | Reading the docs, the reference screenshots, the UI kits, the component library |
| Imported into this repo | `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/_ds/` | The files you actually copy into the served tree: `styles.css`, `tokens/*.css`, `components/components.css`, `assets/fonts/*` |

Target application, all paths under `C:/Users/Arthur/Desktop/cwm-restyle/`:

| File | Lines | What it is |
|---|---|---|
| `src/web/public/index.html` | 2006 | The SPA shell. Header, sidebar, main content, terminal grid, every modal |
| `src/web/public/styles.css` | 12202 | The entire desktop stylesheet. Catppuccin Mocha on `:root`, three more flavors as `:root[data-theme="..."]` overrides |
| `src/web/public/semantic-theme.css` | 93 | The existing semantic role layer. Surfaces, status colors, focus ring, forced colors block |
| `src/web/public/styles-mobile.css` | 1315 | Mobile layout overrides |
| `src/web/public/focused-shell.css` | 1391 | The focused single session shell |
| `src/web/public/app.js` | 25695 | Frontend controller. Also the source of 182 inline `style="..."` strings |
| `src/web/public/terminal.js` | 5275 | xterm.js pane wrapper, including the xterm theme object and ANSI palette |
| `src/web/public/theme-registry.js` | 141 | The theme picker registry |
| `src/web/server.js` | 317+ | `app.use(express.static(path.join(__dirname, 'public')))`, so everything under `src/web/public/` is served from the site root |

---

## 0. Decide what you are actually doing

APPLY.md section 0 forces two decisions before any code moves. Both are made here, with reasons, so
that implementation agents do not re-litigate them.

### 0.1 Mode

APPLY.md offers three modes: Reskin (tokens only, hours), Restyle (tokens plus primitives plus
spacing rhythm, days), Rebuild (adopt the layout architecture too, weeks).

**Decision: Restyle, with the Rebuild layout adopted only on the prose surfaces.** See 0.3 for
exactly which surfaces those are.

Reason: APPLY.md gives a brand specific warning that a Notion reskin fails more often than for other
brands, because the two recognizable things are structural rather than cosmetic, namely the 720px
column with a 96px minimum gutter and the 6px plus 2px block box model with zero margins. Quoting
APPLY.md: "You can apply every color and every font correctly and still have something nobody
identifies as Notion." A pure reskin of `styles.css` would produce a warm grey Catppuccin, not a
Notion.

Reason the mode is not full Rebuild: a terminal grid is not a document. See 0.3.

### 0.2 Surface

APPLY.md section 0: Notion is two design systems. Marketing lives on bare `<html>`. The editor lives
on `<html data-surface="app">`. "A product app that adopts the marketing surface will look like a
Notion landing page rather than like Notion. Pick `app` for anything with a sidebar."

**Decision: app surface. Set `data-surface="app"` on `<html>` in `src/web/public/index.html`.**

Consequences that follow automatically from that one attribute, per
`docs/design/notion-import/_ds/tokens/colors.css` section C:

- the blue becomes `#2383e2`, not `#0075de`
- the ink becomes `#2c2c2b`, not `rgba(0,0,0,0.95)`
- the hover wash becomes `rgba(55,53,47,0.04)`, warm and translucent
- `--container` becomes 720px and `--gutter` becomes 96px
- the body font resolves to the OS UI stack with no webfont

### 0.3 Which surfaces are documents and which are data

This is the single largest ADAPTATION in this file, and every later step depends on it.

Myrlin Workbook is a dense data application: a sidebar of projects and sessions, a tabbed grid of
live xterm.js terminals, a sessions table, a kanban board, a docs panel, and roughly thirty modals
and menus. APPLY.md section 5 anticipates exactly this case and gives the ruling:

> Target has a data-dense screen the brand never designed: Follow the brand's densest real surface,
> which is the database table view in `LAYOUT.md`: 36px header row, a 7 percent warm hairline
> instead of a fill, a 2.4 percent hover wash, 20px chips. **Reduce type size before you reduce
> padding.**

So the app splits into two rule sets. Classify every screen into one of them before styling it.

| Class | Rule set | Screens in this app |
|---|---|---|
| **Document surfaces**: prose, one column, generous | The 720px `.nt-layout` grid, the 6px plus 2px block box model, zero margins, heading padding top, the 270px bottom dead zone where a page can be appended to | The docs panel (Notes, Goals, Tasks, Rules), modal bodies and forms, settings panes, empty states, onboarding and login, any markdown render, the mirror read only transcript view |
| **Data surfaces**: dense, gridded, information first | The database table view metrics: 36px header row, 32px rows, `rgba(42,28,0,0.07)` hairlines, `rgba(55,53,47,0.024)` row hover, 20px chips at 14px/16.8px/500, 40px view tabs. No 720px cap. No block box model | Sessions table, kanban board, terminal grid and its tab strip, sidebar lists, the header stats cluster, usage meters, notification lists |
| **Chrome** | The sidebar spec and the topbar spec from LAYOUT.md 1.3 and 1.7 verbatim | App header, sidebar, terminal pane headers, status bars |

The failure mode to avoid, and it is the likely one: capping the terminal grid or the sessions table
at 720px because "that is the Notion number". That would make the product unusable and it is not
what LAYOUT.md says. The 720px cap is a property of the text column, not of the viewport.

The complementary failure mode: leaving the docs panel and the modals full width, which loses the
strongest brand signal the system has. readme.md ranks "a narrow document floating in a lot of
nothing" as tell number one.

### 0.4 Theme count decision, to be confirmed by the orchestrator

The app currently ships four Catppuccin flavors (Mocha default, Macchiato, Frappe, Latte) selected
through `src/web/public/theme-registry.js` and implemented as `:root[data-theme="..."]` override
blocks in `styles.css` at lines 8171, 9323 and 9388.

Notion ships exactly two app themes, light and dark, both real and both captured, in
`_ds/tokens/colors.css`.

Recommended resolution, following the APPLY.md pattern for "client insists on their own color",
which is to isolate an accent exception rather than edit base tokens: keep the picker component and
its persistence contract, and reduce the shipped set to **Notion Light** and **Notion Dark**, then,
if a four item picker must survive, add the two extra entries as **named accent themes** that remap
only the accent quad using the section palette theme mechanism, never the neutrals. Do not attempt
to recolor the Catppuccin ramps into warm greys and keep four flavors. That produces four
half correct systems.

This decision must be confirmed by the orchestrator before step 2. Record the answer in
`DECISIONS.md` next to this file.

---

## 1. Audit the target project

APPLY.md section 1: "Produce this inventory before changing anything. Ten minutes of audit saves a
day of rework." Most of the inventory has already been taken and is recorded below so that
implementation agents do not repeat it. Verify, do not re-derive.

| Audit item | Finding | Source |
|---|---|---|
| Styling system | Vanilla CSS, no preprocessor, no framework, no UI kit | `src/web/public/styles.css` |
| Existing token surface | Yes, two of them. Raw Catppuccin ramp plus product aliases on `:root` in `styles.css` lines 23 to 128, and a semantic role layer in `semantic-theme.css`. This is good news: APPLY.md step 2 says point existing variables at new tokens rather than rewriting call sites, and this project already has the indirection | `styles.css`, `semantic-theme.css` |
| Font loading | Google Fonts CDN link in `index.html` line 15, Plus Jakarta Sans in 8 weights plus JetBrains Mono in 2 | `src/web/public/index.html` |
| Dark mode | Dark only, effectively. Three dark flavors plus one light flavor (Latte), all attribute based via `data-theme` on `:root`. No `prefers-color-scheme` query drives the palette | `styles.css` |
| Component inventory | Buttons, inputs, selects, checkboxes, cards, tables, modals, toasts, tabs, badges and chips, avatars, context menus, tooltips, kanban cards, terminal pane headers, resize handles, a command palette, a search overlay | `index.html`, `app.js` |
| Layout inventory | App shell with header plus sidebar plus main, terminal pane grid, sessions table view, kanban board view, docs panel, focused single session shell, mobile layout, login screen | `index.html`, `focused-shell.css`, `styles-mobile.css` |
| Density baked in | `--sidebar-width: 280px`, `--header-height: 80px`, radius ramp 4/6/10/14/18 | `styles.css` lines 88 to 98 |

APPLY.md's four Notion specific audit questions, answered:

1. **How wide is the main content column at 1440?** Full width. Every view fills the space left by
   the sidebar. This is the biggest change ahead, and per 0.3 it applies only to document surfaces.
2. **Where does the vertical rhythm come from, margin or padding?** Mixed, and margin heavy in the
   list and card regions. On document surfaces this has to move onto wrappers as padding. APPLY.md
   warns that hover and selection targets will not line up with the visible spacing until it does.
3. **Are the greys warm or cool?** Cool, and strongly so. Catppuccin is a blue violet ramp:
   `#1e1e2e`, `#313244`, `#45475a`, `#6c7086`. Every one has to go. Notion greys carry a yellow
   brown cast.
4. **Is a webfont loaded in the app shell?** Yes, Plus Jakarta Sans. On the app surface that font
   has to come out. Expect resistance; see step 1 and section 5.

Baseline drift counters, measured on the current tree, so QA can prove movement rather than assert
it:

| Counter | Current | Command |
|---|---|---|
| Hex literals in `styles.css` | 316 | `grep -oE "#[0-9a-fA-F]{3,8}" styles.css \| wc -l` |
| Hex literals in `styles-mobile.css` | 5 | same, that file |
| Hex literals in `focused-shell.css` | 1 | same, that file |
| Literal `border-radius:` values | 199 | `grep -oE "border-radius:\s*[0-9]" styles.css \| wc -l` |
| Inline `style="` in `index.html` | 63 | `grep -oE 'style="' index.html \| wc -l` |
| Inline `style="` in `app.js` | 182 | `grep -oE 'style="' app.js \| wc -l` |
| `linear-gradient` uses | 5 | `grep -c linear-gradient styles.css` |
| `backdrop-filter` uses | 5 | `grep -c backdrop-filter styles.css` |
| `translateY` uses, the hover lift suspects | 21 | `grep -c translateY styles.css` |
| `@keyframes` blocks | 37 | `grep -c "@keyframes" styles.css` |

---

## 2. The retrofit steps, in order, with done criteria

APPLY.md section 3: "Do these in order. Each step should leave the app in a shippable state." One
commit per step, on a dedicated branch, so any single step can be reverted without unwinding the
rest (APPLY.md section 7).

Steps 1 through 12 below are APPLY.md's own order, adapted. Step 0 and step 13 are additions for
this project and are marked ADAPTATION.

### Step 0. ADAPTATION: stage the bundle into the served tree

Not in APPLY.md, required here because this app serves static files from disk and has no build step.

Do:

1. Create `src/web/public/ds/`.
2. Copy from `docs/design/notion-import/_ds/`: `styles.css`, `tokens/` (all six files),
   `components/components.css`, `assets/fonts/` (all five font files).
3. Keep the relative paths intact so the `@import url("tokens/colors.css")` chain and the
   `url("assets/fonts/...")` font sources in `ds/styles.css` resolve without edits.
4. Do not link `ds/styles.css` into `index.html` yet. Steps 1 and 2 control what is linked and when.

Done criteria:

- [ ] `curl -sf http://127.0.0.1:3456/ds/styles.css | head -1` returns CSS, not a 404.
- [ ] `curl -sfI http://127.0.0.1:3456/ds/assets/fonts/iAWriterMonoS-Regular.woff2` returns 200 and
      `content-type: font/woff2`.
- [ ] Application renders exactly as before. Nothing is linked yet, so this step is visually inert.

### Step 1. Fonts

APPLY.md: "Load the families from `assets/fonts/` or the documented fallback stack. Set
`--font-body`, `--font-display`, `--font-mono`. Ship this alone and look at the app. Type changes
more than people expect. **For the app surface this step is a deletion**: remove the webfont from
the document body and let `--font-body` resolve to the OS stack."

Do:

1. Delete the Google Fonts `<link>` and the two `preconnect` links, `index.html` lines 13 to 15.
2. Point `--font-sans` in `styles.css` line 112 at `--font-app-ui`, the OS stack shipped verbatim in
   `ds/tokens/typography.css`.
3. Point `--font-mono` in `styles.css` line 113 at the shipped `"iA Writer Mono"` stack.
4. See section 5 of this document for the exact `@font-face` wiring and for the terminal font
   decision, which is a separate call.

Done criteria:

- [ ] `getComputedStyle(document.body).fontFamily` starts with `ui-sans-serif`. Check in DevTools,
      not by eye. This is a QA line item from APPLY.md section 6.
- [ ] Zero requests to `fonts.googleapis.com` or `fonts.gstatic.com` in the network panel on a hard
      reload. The app now loads its full type system offline.
- [ ] No element falls back to Times. Check the computed family on the header, the sidebar, a table
      cell, a modal, and a code block.
- [ ] The terminal still renders a fixed pitch face with correct cell metrics and no visible column
      drift after 200 rows of output.

### Step 2. Tokens

APPLY.md: "Drop in `tokens/*.css`. Point the project's existing theme variables at the new tokens
rather than replacing every usage site. This is the single highest leverage step and it is
reversible."

This project is unusually well set up for that instruction, because `semantic-theme.css` already is
the indirection layer. Do not delete it. Re-point it.

Do:

1. Link `ds/styles.css` in `index.html` **before** `styles.css`, so project rules still win during
   the migration and nothing breaks in one jump.
2. Set `data-surface="app"` on `<html>`.
3. Rewrite the right hand side of every alias in `semantic-theme.css` to a semantic contract token
   (`--surface`, `--ink`, `--brand` and friends). Leave the left hand names alone; every call site
   in the 12202 line stylesheet keeps working.
4. Rewrite the product aliases in `styles.css` lines 49 to 82 the same way.
5. Only then start deleting the raw Catppuccin ramp at lines 23 to 46, one variable at a time, each
   deletion proven by a zero result grep for its name.

Use the mapping table in section 3 of this document. Do not delegate the mapping to find and
replace. APPLY.md: "The mapping is where the real design decisions get made."

Done criteria:

- [ ] Every row of the section 3 mapping table has a filled Mapped column.
- [ ] `grep -nE "var\(--(base|mantle|crust|surface0|surface1|surface2|overlay0|overlay1|mauve|lavender|flamingo|rosewater|sapphire|sky)\)" src/web/public/*.css` returns zero results.
- [ ] `grep -nE "#(1e1e2e|181825|11111b|313244|45475a|585b70|6c7086|7f849c|cdd6f4|cba6f7|89b4fa)" src/web/public/` returns zero results.
- [ ] Toggling `data-theme="dark"` on `<html>` flips the whole app to the captured Notion dark values
      and back with no orphaned light surface and no orphaned dark text.
- [ ] Reverting this one commit restores the previous appearance completely. Verify by reverting on
      a scratch branch, not by assuming.

### Step 3. Global resets and base

APPLY.md: "Body background, default text color, link color, selection color, focus ring, scrollbar
if the brand styles it."

Do: body background `--surface`, default text `--ink`, `::selection` to
`--app-selection-token` which is `rgba(35,131,226,0.14)`, and the focus ring per the accessibility
floor in section 4. Note that the existing `::selection` rule in `semantic-theme.css` lines 44 to 47
is the right hook and only needs its value re-pointed.

Done criteria:

- [ ] Body ink is `#2c2c2b` in light and `#f0efed` in dark. Never `#000000`, which is an explicit QA
      line item.
- [ ] Text selection anywhere outside the terminal paints the Notion blue wash.
- [ ] Every interactive element shows a visible focus ring under keyboard focus in both themes.
- [ ] The app scrollbars do not fight the warm ground. If a custom scrollbar exists, its thumb comes
      from `--border-strong`, not from a leftover Catppuccin value.

### Step 4. Radius and border

APPLY.md: "These two carry an enormous amount of brand signal and are cheap to change globally.
**Notion specific: resist unifying them.** Chips stay 4px while cards and callouts stay 10px; making
them match is on the rejection list because it reads as a generic design system."

The current ramp is 4/6/10/14/18. The Notion editor assignments are specific per component, listed
in `ds/tokens/spacing.css` section 2:

| Component | Token | Value |
|---|---|---|
| In app button | `--radius-app-button` | 6px |
| Property chip, icon button, page icon | `--radius-property-chip`, `--radius-icon-button`, `--radius-page-icon` | 4px |
| Status chip | `--radius-status-chip` | 10px |
| Callout, bookmark, collection card | `--radius-callout`, `--radius-bookmark`, `--radius-collection-card` | 10px |
| Block hover and selection box | `--radius-block-hover` | 6px |
| Menu and popover | `--radius-popover` | 12px |
| Cover image | `--radius-cover` | 0 |
| Avatar | `--radius-avatar` | 100 percent |

Done criteria:

- [ ] `grep -oE "border-radius:\s*[0-9]" src/web/public/styles.css | wc -l` is 0, down from 199.
- [ ] Chips measure 4px and cards measure 10px in DevTools. They are not the same number.
- [ ] `--radius-xl: 18px` no longer exists anywhere. There is no 14px and no 18px radius in the
      Notion editor set.
- [ ] Borders are 1px everywhere except focus rings.

### Step 5. Elevation

APPLY.md: "Replace every shadow at once from `tokens/effects.css`. Mixed shadow systems read as
sloppiness faster than almost anything else. **Notion specific: most shadows should become
nothing.** Only 11 elements on Notion's entire homepage carry a shadow, and the editor canvas
carries none at all. Expect to delete more shadows than you replace."

The project ships four shadow tokens, `--shadow-sm` through `--shadow-xl`, at `styles.css` lines 106
to 109, all of them heavy dark mode shadows up to 50px blur at 45 percent black. Almost all of these
become `none`.

Keep a shadow only on: menus and popovers (`--app-shadow-menu`), modals
(`--app-shadow-outlined-lg`), toasts, tooltips (`--app-shadow-outlined-sm`), the topbar in its
scrolled state (`--app-shadow-topbar`), avatars (`--app-shadow-avatar`), and the collection card
treatment on kanban cards. Everything else, including every panel, every table, every sidebar item
and the terminal panes, carries no shadow at all. Separation comes from the warm hairline.

Done criteria:

- [ ] Every remaining `box-shadow` in the project CSS resolves to a token from `ds/tokens/effects.css`.
      Grep for `box-shadow:` and read every hit.
- [ ] The count of elements carrying a shadow, measured by a DevTools sweep of the default screen,
      is in single digits.
- [ ] The sidebar has no border and no outset shadow. It carries the inset hairline
      `--app-sidebar-edge`, which is `rgb(240,239,237) -1px 0 0 0 inset`. LAYOUT.md 1.7 calls a
      bordered sidebar a rejection list item.
- [ ] `--shadow-xl` is gone.

### Step 6. Layout, before spacing

APPLY.md: "Set the content column ... The app surface gets `.nt-layout`, the 720px named line grid.
Nothing else in this migration changes the impression as much."

ADAPTATION: applied per class from 0.3. Document surfaces get `.nt-layout`. Data surfaces get the
chrome numbers but keep their full width.

Do, in this order:

1. Header height 80px becomes the **44px topbar** from LAYOUT.md 1.3. This is the largest single
   visual change in the app and it will force a re-think of the header stats cluster. Reduce type
   before padding.
2. Sidebar 280px becomes **240px** with `--app-bg-secondary` `#f9f8f7`, the inset hairline right
   edge, section labels at `--app-sidebar-section-label` `#91918e`, item hover
   `rgba(55,53,47,0.04)`, item selected `rgba(0,0,0,0.03)`, item height around 27px, z-index 111,
   collapse to `width: 0` with a 20px peek and a 0.2s transition. All from LAYOUT.md 1.7.
3. Wrap the docs panel body, modal bodies, settings panes and empty states in `.nt-layout`.
4. Leave the terminal grid, the sessions table, the kanban board and the sidebar lists at their
   current widths.

Done criteria:

- [ ] At 1440 viewport, the docs panel text column measures exactly 720px and its gutters measure
      375px each. Measure it in DevTools.
- [ ] At 768 viewport the same column measures about 602px with 96px gutters and there is no
      breakpoint rule doing it. The `minmax` pair does the whole job.
- [ ] The topbar measures 44px.
- [ ] The sidebar measures 240px and its right edge is an inset shadow, not a border.
- [ ] The terminal grid still fills the available width at every breakpoint.
- [ ] Nothing scrolls horizontally at 320, 768, 1024 and 1440.

### Step 7. Spacing rhythm

APPLY.md: "Re-space the page shells to the rhythm in `LAYOUT.md`. On the app surface this means
converting block margins to wrapper padding at 6px, adding the 2px leaf, and implementing the list
collapse to 1px. This is where a reskin becomes a restyle."

APPLY.md section 7 also flags this as the hardest step to revert, because it rewrites component
internals rather than a theme layer. Give it its own commit, after the token work is merged and
stable.

Do: on document surfaces only, implement the block box model from LAYOUT.md 1.4, reproduced in
section 6.3 of this document. On data surfaces, implement the table view rhythm instead: 36px header
row, 32px rows, hairline separation, 2.4 percent hover.

Done criteria:

- [ ] `getComputedStyle` on any block in the docs panel returns `margin: 0px`. All rhythm is padding.
- [ ] A one line paragraph in the docs panel measures exactly 40px tall at 16px/24px body. Measure
      it, do not assume it.
- [ ] Two consecutive list items have 1px of collapsed vertical padding between them, not 6px, and a
      solo list item keeps the 6px paragraph rhythm.
- [ ] A heading that is the first block in its container has 6px of top padding, not 30px.
- [ ] Sessions table header row measures 36px and rows measure 32px.
- [ ] Table row hover paints `rgba(55,53,47,0.024)` and not a solid fill.

### Step 8. Primitives

APPLY.md: "Replace button, input, select, checkbox, radio and badge. Keep the target project's props
API and swap only the internals, so call sites do not churn."

For a vanilla CSS app, "props API" means class names. Do not rename `.btn`, `.btn-ghost`,
`.btn-sm`, `.form-label`, `.form-checkbox` or any other existing class. Replace only the
declarations inside them, sourcing from `ds/components/components.css` and the component prompt
files at `docs/design/notion-import/_ds/components/` and the canonical
`.../build/components/*/*.prompt.md`.

Key metrics, from `ds/tokens/spacing.css` section 10, with their provenance markers preserved:

| Primitive | Metric | Provenance |
|---|---|---|
| In app button height | 28px | measured |
| Icon button | 28px, 24px small, 32px large | inferred |
| Input height | 28px, 32px for the search variant, padding `0 8px` | inferred |
| Sidebar item height | 27px | inferred, and LAYOUT.md 1.7 says not measurable |
| Checkbox | 16px | inferred |
| Toggle caret | 18px inside the measured 24px marker box | inferred |
| Switch | 26 by 16 with a 12px knob | inferred |
| Avatar | 20, 24, 32 | inferred, the 18px row icon is measured |
| Property chip | 20px tall, 4px radius, `0 6px` padding, 14px/16.8px/500 | measured |
| Status chip | 10px radius, `0 9px 0 7px` padding | measured |

Done criteria:

- [ ] No class was renamed. `git diff --stat` on `index.html` shows attribute and structure changes
      only where a wrapper was genuinely added.
- [ ] Buttons, inputs and chips match the metrics above in DevTools.
- [ ] Every primitive works in both themes and both at 320px and 1440px.
- [ ] Two CTA weights only, one hue, per CONVERSION.md section 1: a solid blue primary and a tinted
      blue secondary. No third color, no gradient, no glow, and no icon inside the primary button.
      A neutral outline secondary is not the Notion pattern.

### Step 9. Composites

APPLY.md: "Cards, tables, modals, menus, tabs, toasts."

Several of this project's composites have no captured Notion spec. APPLY.md section 4 says derive
them, do not invent freely, and write down what you invented. The derivations it prescribes, applied
to this app:

| This app needs | Derive from | Concretely |
|---|---|---|
| Command palette, session quick switcher, search overlay | The popover spec. APPLY.md calls the slash menu geometry a documented gap | `--app-shadow-menu`, radius 12px, `.15s ease-in` fade in, rows around 28px with a 16px monoline icon and secondary text at `#7d7a75`. Mark it invented |
| Context menus on sessions and panes | Same popover family | 320px width, 28px rows, 4px container padding, `0 10px` row padding |
| Kanban board | Not observed by the capture at all | Follow the gallery view: 296px cards, 10px radius, elevated card treatment. Mark it invented |
| Sessions table | The database table view, which **is** measured | 36px header, `rgba(42,28,0,0.07)` cell borders, `rgba(55,53,47,0.024)` row hover, 20px chips |
| View tabs (workbook view nav) | The database view tab | 40px tall, plain text, no pill, no underline slab |
| Dropdown and select | The property chip plus the popover | 4px radius trigger, chip typography, popover with `--app-shadow-menu` |
| Tooltip | The popover family | `--app-shadow-outlined-sm`, small radius, 12px text, 150ms fade in |
| Toast | Snackbar keyframes exist, geometry does not | 300px wide, popover shadow, `nt-snackbar-slide-in-bottom` |
| Terminal pane header | No precedent. Nearest relative is the sidebar row plus the view tab | Prefer the plainest thing that respects the tokens. APPLY.md: "An under-designed component that obeys the system disappears; an over-designed one that invents new treatment breaks the system visibly" |
| Terminal surface itself | No precedent whatsoever | See step 13 |

Done criteria:

- [ ] Every derived component is listed in `INVENTIONS.md` next to this file with its nearest
      relative and what was borrowed.
- [ ] Modals use `--app-shadow-outlined-lg` and a 12px radius, not the old `--shadow-xl`.
- [ ] Menus and popovers all use one shadow token and one radius.
- [ ] The sessions table matches the measured database table view numbers exactly.

### Step 10. Motion

APPLY.md: "Motion last, because animating a layout you are still changing wastes work. **Notion
specific: most of this step is removal.** Delete the scroll reveals, the entrance animations on list
items, and any hover transform. Then set fade in to 150ms and fade out to 200ms, in that asymmetry."

Full rules in `.../build/MOTION.md`. The three that decide it: fade in is faster than fade out,
nothing animates on scroll, loading is a shimmer and never a spinner for content.

Do:

1. Audit all 37 `@keyframes` blocks in `styles.css`. Delete every scroll reveal, entrance and fade
   up. Keep shimmer, pulse, shake and the indeterminate spin.
2. Delete all 21 `translateY` hover lifts. MOTION.md: "No block moves, scales or lifts on hover.
   Only its handles fade in. A transform on a block on hover is on the rejection list."
3. Set the three transition tokens at `styles.css` lines 101 to 103 to the Notion durations and
   easings from `ds/tokens/motion.css`. Fade in 150ms `--ease-out`, fade out 200ms `--ease-in`,
   transform 300ms `--ease-in-out-quint`.
4. Replace content spinners with shimmer skeletons. Keep `nt-spin` only for genuinely indeterminate
   operations such as a running command with no progress signal.
5. Implement the hover gate. MOTION.md ships `.nt-enable-hover` plus a scroll gating helper.
   ADAPTATION: this app has long scrolling lists and a scrolling terminal, so the gate is worth more
   here than on a marketing page. Apply it to the sidebar list, the sessions table and the kanban
   board.
6. Write decorative motion inside `@media (prefers-reduced-motion: no-preference)`, not
   unconditionally with a disable inside `reduce`. Both halves of the query, per MOTION.md.

Done criteria:

- [ ] `grep -c translateY src/web/public/styles.css` is 0 for hover rules. Any surviving hit is a
      layout translate, not a hover lift, and is justified in the commit message.
- [ ] Fade in is 150ms and fade out is 200ms, in that asymmetry, everywhere.
- [ ] Nothing animates on scroll anywhere in the app.
- [ ] Every content loading state is a shimmer skeleton.
- [ ] With `prefers-reduced-motion: reduce` set at the OS level, the app remains fully usable and
      every decorative animation is absent rather than merely instant.
- [ ] Hover washes do not flash under the cursor while a list is scrolling.

### Step 11. Copy

APPLY.md: "Apply `VOICE.md` to headings, button labels, empty states and error messages. Copy is
design. A perfectly styled app with off voice copy does not read as the brand."

The rules that bind, from `.../build/VOICE.md`:

- Sentence case everywhere. The only title cased strings are proper product nouns. In this app that
  means Claude Code, Codex, Myrlin Workbook, GitHub. Not "Start Session", which becomes "Start
  session".
- Headings are declarative sentences that end in a period. Buttons do not take a period.
- Button labels are verbs.
- Nothing uppercase. VOICE.md: uppercase tracked out labels are on the rejection list, and the
  tracking system runs negative above 16px so they are off brand mechanically as well as tonally.
- No exclamation marks.
- No em dashes. VOICE.md notes Notion's own copy uses them and instructs not to reproduce them; the
  house rule for this repository forbids them independently. Both agree.
- Empty states point forward and name the next action. The model line: "Nothing here yet. Add your
  first page to get started."
- Error messages are sentence case, a full sentence, terminal period.

Done criteria:

- [ ] `grep -rnE "text-transform:\s*uppercase" src/web/public/` returns zero results.
- [ ] No exclamation mark in any user facing string in `index.html` or `app.js`.
- [ ] No em dash and no double hyphen used as punctuation in any user facing string.
- [ ] Every empty state was rewritten, not left as a default. List them and tick them individually.
- [ ] Every button label is a verb in sentence case.

### Step 12. Art direction

APPLY.md: "Illustration, imagery, iconography, texture per `ART-DIRECTION.md`. **For this brand this
step is not optional decoration.** The illustration carries all of Notion's personality; without it
the result is a competent white page that nobody identifies."

ADAPTATION, and it needs an explicit decision. CONVERSION.md section 7 lists the developer product
case: "The illustration language is the risk. Notion's naive hand inked figures read as warm and
domestic, and on a developer product they can read as unserious. Keep the layout, the white ground,
the two CTA weights and the copy discipline; replace the illustration with the chromeless product
screenshot treatment, which is already part of this system."

Myrlin Workbook is a developer product. Recommended: adopt the icon and texture half of
ART-DIRECTION.md in full, using `.../build/assets/icons.svg`, the canonical 43 symbol monoline
sprite, and take the CONVERSION.md escape hatch on figurative illustration, restricting hand inked
illustration to empty states and the login screen where warmth helps and nothing is being claimed.
Confirm with the orchestrator; readme.md ranks the illustration as tell number four, so dropping it
entirely has a measurable cost against the final test in section 6.

Done criteria:

- [ ] All icons come from one monoline family at one stroke weight. No mixed icon sets.
- [ ] No icon sits inside a rounded square badge. readme.md names that as a generic SaaS tell.
- [ ] Empty states carry either a hand inked illustration or nothing. Not a grey box.
- [ ] The decision on figurative illustration is recorded in `DECISIONS.md`.

### Step 13. ADAPTATION: the terminal surface

Not in APPLY.md. Required because the terminal is the product and the Notion capture contains no
terminal.

APPLY.md section 4 governs: find the nearest relative, ask what the brand would do, prefer the
plainest thing that respects the tokens, write down what you invented.

Nearest relative is the code block, which **is** measured: Prism light on `#f5f2f0` with a sticky
header at `#f7f6f3`, tokens `--app-code-block-bg` and `--app-code-sticky-header-bg`.

Do:

1. Terminal background: `--app-code-block-bg` in light, `--app-bg-secondary` in dark. Not pure
   white in light, and not pure black in dark.
2. The xterm theme object in `src/web/public/terminal.js` needs a full 16 color ANSI palette. Derive
   it from the named block palette in `ds/tokens/colors.css`, which is theme invariant for text
   colors: gray `#7d7a75`, red `#cf5148`, green `#50946e`, yellow `#cb9434`, blue `#387dc9`, purple
   `#9a6bb4`, pink `#c14c8a`, teal `#2c8b9e`, brown `#9f765a`, orange `#d27b2d`.
3. Bright variants have no captured source. Derive them and mark them invented.
4. Contrast is not negotiable here either. Every ANSI color must clear 4.5:1 against the terminal
   background in both themes, or the mapping is wrong. See section 4.
5. Terminal font: see section 5.3.

Done criteria:

- [ ] All 16 ANSI colors plus foreground, background, cursor and selection are set from tokens in
      `terminal.js`, with a comment naming the source token for each.
- [ ] Every ANSI color measured against the terminal background clears 4.5:1 in both themes, with the
      measured ratios recorded in `INVENTIONS.md`.
- [ ] A full `claude` session, a `git diff` with color, and a `npm test` run are all legible in both
      themes. Screenshot each.
- [ ] Cell metrics are stable. No column drift after 200 rows.

---

## 3. The token mapping table

This is the table APPLY.md section 2 prescribes, with the Notion side pre-filled. The Target and
Current columns are pre-filled from the audit so implementers verify rather than re-derive. Fill the
Mapped column. APPLY.md: fill this table before writing CSS.

Notion values given are the **app surface** values, because section 0.2 selected the app surface.
Marketing values are given only where a reviewer is likely to quote them at you.

### 3.1 The rows APPLY.md prescribes

| Target project token | Current value | Notion token | App value | Marketing value | Mapped |
|---|---|---|---|---|---|
| `--accent` | `var(--mauve)` `#cba6f7` | `--brand` | `#2383e2` | `#0075de` | |
| `--bg-primary`, `--surface-canvas` | `var(--base)` `#1e1e2e` | `--surface` | `#ffffff` light, `#191919` dark | `#ffffff` | |
| `--bg-secondary`, `--surface-sidebar` | `var(--mantle)` `#181825` | `--surface-sunken` | `#f9f8f7` light, `#202020` dark | `#f9f9f8` | |
| `--bg-elevated`, `--surface-raised` | `var(--surface0)` `#313244` | `--surface-raised` | `#ffffff` light, `#202020` dark | `#ffffff` | |
| `--bg-tertiary` | `var(--crust)` `#11111b` | `--surface-neutral` | `#f0efed` light, `#383836` dark | | |
| `--text-primary`, `--text-base` | `var(--text)` `#cdd6f4` | `--ink` | `#2c2c2b` light, `#f0efed` dark | `rgba(0,0,0,0.95)` | |
| `--text-secondary` | `var(--subtext1)` `#bac2de` | `--ink-soft` | `#7d7a75` light, `#ada9a3` dark | `rgba(0,0,0,0.90)` | |
| `--text-tertiary` | `var(--subtext0)` `#a6adc8` | `--ink-muted` | `#7d7a75` light, `#ada9a3` dark | `rgba(0,0,0,0.54)` | |
| `--text-muted` | `var(--overlay1)` `#7f849c` | `--ink-faint` | `#a19e99` light, `#7d7a75` dark | `rgba(0,0,0,0.30)` | |
| `--border-default`, `--border` | `var(--surface1)` `#45475a` | `--border` | `#e6e5e3` light, `#383836` dark | `rgba(0,0,0,0.10)` | |
| `--border-subtle` | `rgba(69,71,90,0.5)` | `--app-border-secondary` | `#f0efed` light, `#2c2c2b` dark | | |
| `--focus-ring` | `0 0 0 2px canvas, 0 0 0 4px accent` | `--focus-ring` | `#2383e2` | `#0075de` | |
| `--bg-hover` | `var(--surface0)` `#313244`, a **solid** | `--hover-wash` | `rgba(55,53,47,0.04)` light, `rgba(255,255,255,0.055)` dark | `rgba(0,0,0,0.05)` | |
| no equivalent | | `--press-wash` | `rgba(55,53,47,0.10)` light, `rgba(255,255,255,0.13)` dark | `rgba(0,0,0,0.10)` | |
| `--color-success`, `--status-complete` | `var(--green)` `#a6e3a1` | `--success` | `#50946e` | `#14832b` | |
| `--color-attention`, `--status-needs-input` | `var(--yellow)` `#f9e2af` | `--warning` | `#d27b2d` | `#ff6d00` | |
| `--color-danger`, `--status-failed` | `var(--red)` `#f38ba8` | `--danger` | `#cf5148` | `#f64932` | |
| `--color-info`, `--status-running` | `var(--blue)` `#89b4fa` | `--app-text-blue` | `#387dc9` | | |
| `--color-stale`, `--status-stale` | `var(--overlay1)` `#7f849c` | `--app-text-gray` | `#7d7a75` | | |
| `--radius-sm` | `6px` | `--radius-app-button` | `6px` | `8px` | |
| `--radius-xs` | `4px` | `--radius-property-chip` | `4px` | `4px` | |
| `--radius-md` | `10px` | `--radius-callout` | `10px` | `8px` | |
| `--radius-lg` | `14px` | `--radius-popover` | `12px` | `12px` | |
| `--radius-xl` | `18px` | none. Delete it | | | |
| `--shadow-sm` through `--shadow-xl` | 4 heavy dark shadows | `--app-shadow-*`, and mostly `none` | see step 5 | `--shadow-200` | |
| `--font-sans` | `'Plus Jakarta Sans', system-ui, ...` | `--font-app-ui` | the OS UI stack, no webfont | the Inter chain | |
| `--font-mono` | `'JetBrains Mono', ...` | `--font-mono` | `"iA Writer Mono", Nitti, Menlo, Courier, monospace` | same | |
| no display font | | `--font-display` | same as body. Notion has no separate display face | same as body | |
| base spacing unit | ad hoc | `--space-2` | `4px`, but the editor really runs on **6px and 2px** | `4px` | |
| content max width | full width | `--container` | **`720px`** on document surfaces only | `1252px` | |
| `--sidebar-width` | `280px` | `--app-sidebar-width` | `240px` | | |
| `--header-height` | `80px` | `--app-topbar-height` | `44px` | `64px` nav | |
| `--transition-fast` | `150ms cubic-bezier(0.16,1,0.3,1)` | `--duration-150` plus `--ease-out` | `150ms`, fade in | | |
| `--transition-normal` | `200ms cubic-bezier(0.16,1,0.3,1)` | `--duration-200` plus `--ease-in` | `200ms`, fade out | | |
| `--transition-slow` | `300ms cubic-bezier(0.16,1,0.3,1)` | `--duration-300` plus `--ease-in-out-quint` | `300ms`, transform | | |
| `--selection-bg` | `color-mix(accent 25%)` | `--app-selection-token` | `rgba(35,131,226,0.14)` | | |
| `--provider-claude-accent` | `var(--mauve)` `#cba6f7` | `--app-text-purple` | `#9a6bb4` | | |
| `--provider-codex-accent` | `var(--green)` `#50946e` was `#a6e3a1` | `--app-text-green` | `#50946e` | | |

### 3.2 Key app tokens not covered by the APPLY.md row list

Pre-filled reference. These have no current equivalent in the project and get introduced by this
retrofit. Source: `docs/design/notion-import/_ds/tokens/`.

| Notion token | Light | Dark | Where it lands in this app |
|---|---|---|---|
| `--app-bg-interactive` | `#f4f3f3` | `#262626` | Pressed and active list rows |
| `--app-text-disabled` | `#bcbab6` | `#5f5e59` | Disabled labels |
| `--app-border-strong` | `#d4d3cf` | `#5f5e59` | Input borders, scrollbar thumb |
| `--app-icon-primary` | `#383836` | `#e6e5e3` | Toolbar icons |
| `--app-icon-secondary` | `#8e8b86` | `#ada9a3` | Inactive icons |
| `--app-sidebar-section-label` | `#91918e` | `#9b9b9b` | Sidebar group headings |
| `--app-sidebar-item-selected` | `rgba(0,0,0,0.03)` | `rgba(255,255,255,0.055)` | Active project or session row |
| `--app-sidebar-section-band` | `rgba(0,0,0,0.024)` | | Sidebar section band fill |
| `--app-wash-button-hover` | `rgba(55,53,47,0.06)` | `rgba(255,255,255,0.055)` | Button hover, distinct from row hover |
| `--app-wash-button-press` | `rgba(55,53,47,0.16)` | `rgba(255,255,255,0.03)` | Button press |
| `--app-wash-table-row-hover` | `rgba(55,53,47,0.024)` | `rgba(255,255,255,0.055)` | Sessions table row hover, the faintest wash in the system |
| `--app-divider` | `rgba(28,19,1,0.11)` | | Horizontal rules |
| `--app-table-cell-border` | `rgba(42,28,0,0.07)` | | Every table hairline |
| `--app-code-block-bg` | `#f5f2f0` | | Code blocks and the terminal ground |
| `--app-code-sticky-header-bg` | `#f7f6f3` | | Code block header, terminal pane header |
| `--app-title-placeholder` | `rgba(55,53,47,0.15)` | `#373737` | Empty input placeholders |
| `--app-glass-page` | `rgba(255,255,255,0.8)` | `rgba(25,25,25,0.8)` | Modal scrim |
| `--app-sidebar-edge` | `rgb(240,239,237) -1px 0 0 0 inset` | `#2c2c2b -1px 0 0 0 inset`, inferred | Sidebar right edge |
| `--app-shadow-menu` | see effects.css | | Menus, popovers, command palette |
| `--app-shadow-outlined-sm` | see effects.css | | Tooltips |
| `--app-shadow-topbar` | `rgba(15,15,15,0.1) 0 2px 4px, rgba(15,15,15,0.15) 0 2px 8px` | | Topbar when scrolled |

### 3.3 The five mapping rules, verbatim from APPLY.md, with this project's instance of each

1. **Never map one-to-one on hue alone. Map on role.** This project's `--accent` is mauve and it is
   currently doing three jobs: brand identity, focus ring, and Claude provider identity. Notion
   splits those. Brand and focus become `#2383e2`; provider identity becomes a named block palette
   hue.
2. **Count the greys. Most projects have too many. Collapse to this system's ramp; do not extend the
   ramp to preserve an old shade.** This project has 12 neutral steps between `--crust` and
   `--text`. The Notion app ramp has 5 backgrounds and 5 inks. Collapse into them.
3. **Contrast is not negotiable.** See section 4.
4. **Do not map a muted grey background to a hover wash.** `--bg-hover` is currently the solid
   `#313244`. Notion hovers are translucent so a hovered row inside a colored callout still reads
   correctly. A solid hover will look wrong the first time it lands on a tinted surface, and this
   app has tinted status surfaces already (`--status-running-surface` and friends in
   `semantic-theme.css` lines 28 to 32).
5. **Keep two chip systems apart.** This app uses one chip treatment for session tags, provider
   labels, model labels and status. Notion splits content labels (named block colors) from database
   properties (the translucent chip palette). Split them: status and model become property chips,
   user authored tags become named block colors. APPLY.md: "Splitting them is a real design decision,
   not a cleanup."

---

## 4. The accessibility floor, and how to document deviations

### 4.1 The floor

APPLY.md states it twice, once as a mapping rule and once as a conflict resolution.

> **Contrast is not negotiable.** After mapping, check body text on every surface at 4.5:1 and large
> text and UI at 3:1. If a mapping fails, the mapping is wrong, not the standard.

> Accessibility requirement conflicts with brand: **Accessibility wins. Document the deviation.**

The full floor, assembled from APPLY.md section 6 and MOTION.md:

| # | Requirement | Measured how |
|---|---|---|
| A1 | Body text 4.5:1 on every surface it appears on | Contrast checker against `--surface`, `--surface-sunken`, `--surface-raised`, every status surface, and the terminal ground |
| A2 | Large text and UI components 3:1 | Same, for anything 18px and up or any non text interface boundary |
| A3 | Focus ring visible on every interactive element, and visible in both light and dark | Keyboard tab sweep of every screen, in both themes |
| A4 | Disabled states distinguishable without relying on color alone | Opacity plus cursor plus `aria-disabled`, not color alone |
| A5 | Body text is never `#000000` | `grep -rn "#000000\|#000\b" src/web/public/` |
| A6 | `prefers-reduced-motion: reduce` honored, and the app remains usable | OS level toggle, then walk the app |
| A7 | Decorative animation written **inside** `prefers-reduced-motion: no-preference`, not disabled inside `reduce` | Read every `@media (prefers-reduced-motion` block |
| A8 | No animation blocks interaction | Click a control mid animation and confirm it responds |
| A9 | Forced colors mode does not lose element boundaries | The existing `@media (forced-colors: active)` block in `semantic-theme.css` lines 82 to 93 must survive the retrofit and be extended to any new component |
| A10 | ADAPTATION: every ANSI terminal color clears 4.5:1 against the terminal ground in both themes | Programmatic check over the 16 color palette in `terminal.js` |

A9 and A10 are additions. A9 exists because the project already ships a forced colors block and
deleting it would be a regression. A10 exists because APPLY.md's contrast rule applies to "body text
on every surface it appears on" and the terminal is a surface carrying body text.

### 4.2 The known collision to expect

The Notion warning color `#d27b2d` on the light canvas `#ffffff` is a mid orange and will not clear
4.5:1 as body text. Notion uses it as a **block text color on a tinted background**, not as small
text on white. The same holds for `--app-text-yellow` `#cb9434`.

Correct response, per APPLY.md: the mapping is wrong, not the standard. Use the pairing Notion uses,
which is the hue text color on its matching `--app-bg-<hue>` background: `#d27b2d` on `#fbebde`.
Where an orange must sit on the plain canvas as small text, drop to `--ink` and carry the warning
signal with an icon plus the tinted surface instead of with the ink color.

Do not "fix" this by darkening `#d27b2d`. That edits a captured brand token and it will read wrong
next to the correct hues.

### 4.3 How APPLY.md says to document deviations

APPLY.md gives three separate documentation instructions. Use all three; they cover different
things.

1. **Accessibility deviations.** APPLY.md section 5: "Accessibility wins. Document the deviation."
2. **Invented components.** APPLY.md section 4, point 4: "Write down what you invented, in the
   project, so it can be reviewed later." Its derivation table also repeats "Mark it as invented"
   on four separate rows.
3. **Inferred rather than observed values.** The bundle's own convention, from `readme.md` under
   Gaps and inferences: every derived value carries a matching `/* inferred */` comment in the CSS
   and an `"inferred": true` flag in `tokens.json`. Mirror it. Grep
   `docs/design/notion-import/_ds/tokens/spacing.css` for `inferred:` to see roughly forty worked
   examples.

Concretely, for this project, three files live beside this one and all three are required before the
retrofit can be called complete:

| File | Holds | Row shape |
|---|---|---|
| `DEVIATIONS.md` | Every place the implementation departs from the captured brand, accessibility driven or otherwise | What the brand says, what we shipped, why, what it costs, who approved, date |
| `INVENTIONS.md` | Every component derived rather than captured | Component, nearest relative in the system, what was inherited, what was invented, provenance note |
| `DECISIONS.md` | The open calls from 0.4, step 12 and 5.3 | Decision, options, choice, reason, date, decided by |

And in the CSS itself, at the point of the departure, one comment line in the bundle's own voice:

```css
/* deviation: warning ink lightened path rejected; using #d27b2d on --app-bg-orange
   because #d27b2d on --surface measures 3.1:1 and the floor is 4.5:1. See DEVIATIONS.md row 4. */
```

```css
/* invented: terminal pane header. Nearest relative is the code block sticky header
   (--app-code-sticky-header-bg, measured). Height and control layout are reconstructed.
   See INVENTIONS.md row 7. */
```

Rule: an undocumented deviation is a bug. A documented one is a design decision. The difference is
one comment and one table row.

---

## 5. Fonts: what ships, what is a stand in, and exactly how to wire it

Facts from `readme.md` under Font licenses and `_ds/tokens/typography.css` section 1.

### 5.1 The licensing table

| Family | Role | License | Redistributable | Ships in the bundle |
|---|---|---|---|---|
| **OS system UI stack** | The app UI default body font | Not a webfont, no license question | n/a | Yes, as the `--font-app-ui` token. **This IS the answer. Do not replace it with a webfont** |
| **NotionInter** | Marketing sans | A Notion specific cut of Inter served from notion.com. No public license grant | **No** | **No.** Stand in is plain **Inter** (SIL OFL 1.1), self hosted. Notion's own declared fallback already names Inter second, so adding Inter upgrades the stack with zero token edits and no metric correction |
| **Lyon Text** | Marketing serif, and the app's Serif font option | Commercial Type, paid retail | **No** | **No.** Notion's own declared fallback is the Georgia chain in `--font-serif`. Free stand ins with comparable warmth: **Source Serif 4** (OFL) or **Newsreader** (OFL). Both run wider than Lyon; if substituted, drop one tracking step at 42px and above |
| **iA Writer Mono S** | Marketing mono, and the app's Mono font option | **SIL OFL 1.1**, iaolo/iA-Fonts, a derivative of IBM Plex Mono, copyright 2017 IBM Corp and Information Architects GmbH | **Yes** | **Yes, shipped**: Regular, Italic, Bold, BoldItalic, as woff2 |
| **Permanent Marker** | Marketing handwriting accent | **Apache License 2.0**, Google Fonts, Font Diner | **Yes** | **Yes, shipped**, as woff |
| Noto Sans Arabic and Hebrew | Script coverage | SIL OFL 1.1 | Yes if added | Not shipped, not needed for a Latin build. Named in the stacks so a project that adds them gets them |

Two more facts that constrain implementation:

- Only four faces load on the real marketing site: NotionInter at 400, 500, 600 and 700, all roman.
  Every italic and every subset is declared and reports `unloaded`. **Do not ship italics** on the
  marketing side. A faithful rebuild needs exactly four weights.
- The app surface is not affected by any of that, because it loads no webfont at all.

### 5.2 Exact wiring for this project

Because section 0.2 chose the app surface, **this project needs no sans webfont at all**. The only
webfont it wires is the mono, and the only reason to wire it is code blocks, IDs and, optionally,
the terminal.

Step by step.

**1. Copy the files.** From `docs/design/notion-import/_ds/assets/fonts/` into
`src/web/public/ds/assets/fonts/`, preserving names:

```
iAWriterMonoS-Regular.woff2
iAWriterMonoS-Italic.woff2
iAWriterMonoS-Bold.woff2
iAWriterMonoS-BoldItalic.woff2
permanent-marker.woff
```

`src/web/server.js` line 317 serves `src/web/public` at the site root, so these become
`/ds/assets/fonts/...` with no route work.

`permanent-marker.woff` is optional for this project. Copy it for completeness; only reference it if
step 12 lands a handwriting accent.

**2. Declare the faces.** These are the bundle's own `@font-face` blocks, verbatim from
`_ds/styles.css` lines 65 to 103, with the `src` paths rewritten for the served location. If you
link `ds/styles.css` directly, they come along for free and you write none of this. Write them only
if you are inlining rather than linking.

```css
@font-face {
  font-family: "iA Writer Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/ds/assets/fonts/iAWriterMonoS-Regular.woff2") format("woff2");
}

@font-face {
  font-family: "iA Writer Mono";
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url("/ds/assets/fonts/iAWriterMonoS-Italic.woff2") format("woff2");
}

@font-face {
  font-family: "iA Writer Mono";
  font-style: normal;
  font-weight: 600 700; /* inferred: Notion declares 600; widened so 700 resolves to the real file */
  font-display: swap;
  src: url("/ds/assets/fonts/iAWriterMonoS-Bold.woff2") format("woff2");
}

@font-face {
  font-family: "iA Writer Mono";
  font-style: italic;
  font-weight: 600 700; /* inferred: as above */
  font-display: swap;
  src: url("/ds/assets/fonts/iAWriterMonoS-BoldItalic.woff2") format("woff2");
}
```

The `font-weight: 600 700` range is the only edit the bundle made to Notion's own `@font-face`
rules, and readme.md logs it: it widens Notion's `600` declaration so a `font-weight: 700` rule
resolves to the real bold file rather than to a synthetic bold. Keep it.

**3. Set the stacks.** In `src/web/public/styles.css`, replace the two family declarations at lines
112 and 113:

```css
/* was: 'Plus Jakarta Sans', system-ui, ... */
--font-sans: var(--font-app-ui);

/* was: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace */
--font-mono: "iA Writer Mono", Nitti, Menlo, Courier, monospace;
```

`--font-app-ui` is defined in `ds/tokens/typography.css` and is the OS stack verbatim, in source
order:

```
ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display",
"Segoe UI", Helvetica, "Apple Color Emoji", "Noto Sans Arabic",
"Noto Sans Hebrew", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"
```

`ui-sans-serif` first is what makes macOS pick SF. `"Segoe UI Variable Display"` before `"Segoe UI"`
is what makes Windows 11 look right. Do not reorder it and do not trim it.

**4. Delete the CDN.** Remove `index.html` lines 13 to 15, the two `preconnect` hints and the
`fonts.googleapis.com` stylesheet link. This also removes a hard network dependency from a tool that
is frequently used offline and over a tunnel.

**5. Do not add Inter.** APPLY.md section 5 names this the most common and most damaging conflict:

> Someone wants Inter loaded into the app shell. This is the most common and most damaging conflict,
> and it usually comes from a "we should have consistent typography" instinct. The Notion editor
> genuinely ships no webfont. Loading Inter into a document editor body looks wrong on macOS and on
> Windows, and it is on the rejection list.

This project has no marketing surface inside the SPA. If the marketing site under
`C:/Users/Arthur/Desktop/cwm-restyle/site/` is restyled later, that surface, and only that surface,
gets self hosted Inter.

### 5.3 The terminal font, an open decision

The terminal in `src/web/public/terminal.js` currently renders in JetBrains Mono. Three options,
listed with their tradeoffs. The orchestrator picks one and records it in `DECISIONS.md`.

| Option | For | Against |
|---|---|---|
| **A. iA Writer Mono for the terminal too** | One mono family across the whole product. Shipped, OFL, offline. Most faithful | iA Writer Mono S is a text oriented mono derived from IBM Plex Mono. It is comfortable but slightly wide, so a fixed width terminal fits fewer columns at the same point size |
| **B. iA Writer Mono for code blocks and IDs, keep a terminal specific mono** | Terminal legibility and column density are functional requirements, not aesthetic ones | Two mono families in one product. Must be documented as a deviation |
| **C. `--font-code`, the editor's own code stack** | It is a real Notion token: `SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace`. Zero webfont bytes, native on every platform | Different metrics on every OS, so terminal column counts differ between Mac and Windows |

Recommendation: **C for the terminal, A for code blocks and IDs.** `--font-code` is a captured Notion
token used for exactly this job, it keeps the terminal on native metrics, and it needs no deviation
note because it is part of the system. If B is chosen instead, it is a deviation and needs a
`DEVIATIONS.md` row.

---

## 6. LAYOUT.md rules that bind an app shell, and the ones to ignore

`LAYOUT.md` is in two parts. Part 1 is the editor and it is authoritative for this project. Part 2 is
marketing and almost none of it applies.

### 6.1 The grid, verbatim

From LAYOUT.md 1.1, the shipped editor CSS. The bundle ships it as `.nt-layout` in
`_ds/styles.css`:

```css
.layout {
  --content-width: minmax(auto, 720px);
  --margin-width: minmax(96px, 1fr);
  display: grid;
  width: 100%;
  grid-template-columns:
    [full-start]    var(--margin-left-width,  var(--margin-width))
    [content-start] var(--content-width)
    [content-end]   var(--margin-right-width, var(--margin-width))
    [full-end];
}
```

Why named lines rather than a centered `max-width` container: a full bleed element stays in the
document flow. No negative margins, no `100vw` hacks, no scrollbar arithmetic. Because a line pair
suffixed `-start` and `-end` implicitly defines an area of that name, `grid-column: content` and
`grid-column: full` both just work.

Resolved widths, verified by measurement, so QA can check a number rather than a feeling:

| Viewport | Gutter / content / gutter |
|---|---|
| 1600 | 416.45 / **720** / 416.47 |
| 1440 | 375.80 / **720** / 375.80 |
| 1280 | 303.55 / **720** / 303.55 |
| 1024 | 206.30 / **720** / 206.31 |
| 900 | 108.22 / **720** / 108.22 |
| 768 | 96 / 602.08 / 96 |
| 600 | 96 / 457.48 / 96 |
| 430 | 96 / 287.98 / 96 |

There is no breakpoint here at all. The `minmax` pair does the whole job. Do not add media queries to
reproduce this.

The layout modifiers are all real classes that change only those two custom properties. The ones
worth having in this app:

| Modifier | `--content-width` | `--margin-width` | Use in this app |
|---|---|---|---|
| base | `minmax(auto, 720px)` | `minmax(96px, 1fr)` | Docs panel, modal bodies, settings |
| `.layout-wide` | `1fr` | `96px` | The per document full width toggle. Ship it as an opt in, never as the default |
| `.layout-phone` | `1fr` | `18px` | Mobile document surfaces |
| `.layout-side-peek` | `1fr` | `76px` | A slide over detail panel |
| `.layout-form` | `minmax(auto, 600px)` | `minmax(40px, 1fr)` | Login, session create form, settings forms |
| `.layout-wide-right-margin-expanded` | `1fr` | left `96px`, right **`468px`** | Any right hand detail panel. The 468px is exact and worth copying rather than eyeballing |

APPLY.md section 5, on the pressure that will arrive: "Someone wants the content to fill the width.
Notion has an answer for this and it is a per page toggle, not a default: `.nt-layout-wide`. Ship it
as an opt in and keep 720px as the default."

### 6.2 Chrome numbers, from LAYOUT.md 1.3 and 1.7

**Topbar.** 44px tall, full width, background transparent over the canvas. At rest its shadow is
`--app-shadow-topbar-rest`; scrolled it becomes `--app-shadow-topbar`, and MOTION.md gives that
transition a deliberately slow 700ms so the breadcrumb and controls do not flicker.

This app's header is 80px and carries a brand block, a view tab cluster, a stats cluster and a
control cluster. Getting to 44px requires reducing type before padding, per LAYOUT.md 1.8. Expect to
move the stats cluster into a popover.

**Sidebar**, every value from LAYOUT.md 1.7:

| Property | Value |
|---|---|
| Width | **240px** |
| Background | `#f9f8f7` light, `#202020` dark. **Warmer than the canvas, not darker** |
| Right edge | `box-shadow: rgb(240,239,237) -1px 0 0 0 inset`. An inset 1px hairline, **not a border and not an outset shadow** |
| z-index | 111 |
| Collapse | container `width: 0` plus panel `transform: translate(-220px, y)`, so 20px stays as the hover peek hit target |
| Transition | container `width 0.2s`; panel `width 0.2s, opacity 0.2s, transform 0.2s` |
| Section label | `#91918e` light, `#9b9b9b` dark |
| Item selected fill | `rgba(0,0,0,.03)` light, `rgba(255,255,255,.055)` dark |
| Section band fill | `rgba(0,0,0,.024)` |
| Item hover fill | `rgba(55,53,47,.04)` |
| Item height | Not measurable. Estimated 27 to 28px |

Rejection list items named in that section: a dark or colored sidebar, and a bordered one. The inset
hairline is what keeps the sidebar and the canvas at the same layout width.

**Page header stack**, LAYOUT.md 1.3. Applies to document surfaces in this app, which means the docs
panel and any full page detail view. Cover height `min(30vh, 280px)`, full bleed, square cornered.
Page icon 78 by 78 at 4px radius, `margin: -42px 0 0 8px` with a cover and `96px 0 0 8px` without.
Page title 40px/48px/700 with `padding: 0 8px`. Page controls hidden until the header is hovered and
only 12px tall so they do not push the title down. Page bottom `padding-bottom: 270px`, the click to
append dead zone.

Three failure modes, all on the rejection list: a rounded or shadowed cover, a page icon that does
not overlap the cover, and persistent page controls.

### 6.3 The block box model, LAYOUT.md 1.4

```
.notion-text-block               padding: 0;  margin: 0
  > div                          padding: 6px            <- the block rhythm
    > div                        border-radius: 6px      <- the hover and selection box
      > [content-editable-leaf]  padding: 2px            <- the text
```

At 16px/24px body a one line paragraph is **exactly 40px tall**: 24 plus 2 plus 2 plus 6 plus 6. At
14px/21px small text mode it is 37px. Text glyphs start 8px inside the content column edge.

**There are zero margins between blocks.** The gap between two consecutive paragraphs is
`6 + 2 + 2 + 6 = 16px` and all of it is padding. LAYOUT.md on why this matters: "A margin based
rhythm produces dead zones between blocks that you cannot click, and the whole editor feel falls
apart."

Per block metrics that a docs panel and a markdown renderer both need:

| Block | Wrapper padding | Inner treatment |
|---|---|---|
| Paragraph | `6px` | text row radius 6px, leaf 2px |
| H1 / H2 / H3 / H4 | `30px 6px 6px` / `26px 6px 6px` / `22px 6px 6px` / `18px 6px 6px` | Top padding drops to a plain `6px` when the heading is the first block in its container |
| List or toggle, solo | `6px` | |
| List or toggle, first of a run | `6px 6px 1px` | marker box 24px wide, leaf padding `2px 0`, content offset `padding-left: 2px` |
| List or toggle, middle of a run | `1px 6px` | |
| List or toggle, last of a run | `1px 6px 6px` | |
| Callout | `8px` | inner `padding: 12px`, radius 10px, `border: 1px solid transparent`, background from the named palette, icon column 24px with `margin-top: 7.5px` |
| Bookmark, embed card | `8px` | inner radius 10px |
| Divider | `0 8px` | 1px rule in `rgba(28,19,1,.11)`, total block height **13px** |
| Column list | `12px 0` | children are flex row |
| Image | `8px` | overlay controls at `rgba(0,0,0,.3)` |
| Code block | | Prism light on `#f5f2f0`, sticky header `#f7f6f3` |
| Quote | | left rule in the current ink with left padding. **Not observed on any captured public page.** Mark it invented |

The list collapse is called out as "one of the most recognizable behaviors in the product". A run of
list items reads visibly denser than the paragraphs around it, while a solo list item keeps the
paragraph rhythm. Even spacing throughout reads as a generic editor.

Two correction notes the bundle records after rendering rather than reasoning, both worth copying:

- The naive collapse rule (collapse the bottom padding of any list item that is not the last child)
  is wrong for a run followed by a paragraph. Restore 6px unless the **next sibling is itself a list
  item**, so a run collapses only between its own members.
- The divider rule carries its own 6px margins and the block has no padding, so without a flow root
  those margins collapse out of the wrapper and the block measures 1px instead of 13px.

Indent: lists and toggles indent **24px per level**, matching the 24px marker box. Callout content
indents 21px, which is 8 wrapper plus 12 inner plus 1 border and is a consequence of the box model
rather than a separate rule.

### 6.4 The data surface rhythm, LAYOUT.md 1.8

This is the section that governs most of this app. LAYOUT.md: "This is the brand's densest real
surface."

| Element | Measured |
|---|---|
| View tab button | 40px tall, plain text, 14px or 16px per the page text size |
| Table header row | **36px**, color `#7d7a75`, `margin-left: 8px`, `box-shadow: rgb(255,255,255) -3px 0 0 0, rgba(42,28,0,.07) 0 -1px 0 0` |
| Table cell borders | `rgba(42,28,0,.07)` |
| Table row hover | `rgba(55,53,47,.024)`, the faintest wash in the system |
| Gallery view | `padding: 0 104px`, `min-width: calc(100% - 192px)`, full bleed |
| Gallery card | **296px** wide, 130 to 186px tall depending on the preview |
| Calendar header days row | 24px tall with a 1px `#e6e5e3` underline |
| Collection item | elevated card, radius 10px, white fill in light |
| Property chip | 20px tall, 4px radius, `0 6px` padding, 14px/16.8px/500 |
| Status chip | 10px radius, `0 9px 0 7px` padding |

And the governing instruction, which is the one to repeat in every review: **reduce type before
padding, never the other way around.** A 14px table with 36px header and generous cell padding is
Notion. A 16px table crammed into 24px rows is not.

### 6.5 Empty space

LAYOUT.md Part 3: "The app is extreme. The 720px column inside a 1440 viewport leaves 375px of empty
gutter each side, untinted and unbordered, plus 270px of empty click zone at the bottom of every
page. If a Notion-alike looks wrong and you cannot say why, the first thing to check is whether the
content is too wide."

Two temptations to refuse on document surfaces: filling the gutter with a secondary panel, and
tinting the gutter to "balance" the page. It is meant to be nothing.

### 6.6 The marketing rules to ignore

Everything in LAYOUT.md Part 2 is out of scope for the SPA. Listed explicitly so nobody applies one
by accident:

| Marketing rule | Why it does not apply here |
|---|---|
| 1252px content container | That is the marketing cap. The app cap is 720px and only on document surfaces |
| The fluid gutter `round(up, 7.22223vw, 0.20rem)` | Marketing only. The app gutter is a hard 96px minimum inside a `minmax` |
| 96px section bands and 64px section gaps | There are no marketing bands in an app shell |
| The 64px nav | The app topbar is 44px |
| The five breakpoint system, 600 / 840 / 1080 / 1280 / 1440 | Marketing CSS frequency counts. The app grid has **no breakpoints at all** |
| Hero construction, the seven avatar pile, the 958 by 599 product video | Marketing page composition |
| Social proof band, 24px wordmarks, four stat lines | Marketing |
| Section palette themes `.mkt-theme-<hue>` on `<section>` | Marketing. The one exception is the accent remap mechanism referenced in 0.4, which is borrowed as a **pattern** for theme variants, not applied as a marketing class |
| Template gallery rhythm, 1267px rows, 406px carousel cards, 34px arrows | Marketing |
| Help center 1200px cap and the 56px search pill | Marketing |
| Customer story 576px tinted hero band | Marketing |
| Everything in `CONVERSION.md` about pricing cards, CTA ladders and the template funnel | Marketing, with two exceptions worth carrying into the app: the **two CTA weights in one hue** rule from section 1, and the **copy discipline** from section 7 |

If the marketing site at `C:/Users/Arthur/Desktop/cwm-restyle/site/` is restyled later, Part 2 becomes
authoritative for that surface and only that surface, on the bare `<html>` marketing token set with
self hosted Inter.

---

## 7. QA checklist

APPLY.md section 6: "Concrete pass or fail. No judgement calls." Reproduced with its own grouping and
wording, with app surface applicability marked and with the marketing only items retained but struck
as N/A so a reviewer can see nothing was quietly dropped. Where a line needed a project specific
command to be checkable, the command is added and the criterion is unchanged.

### Tokens

- [ ] No hardcoded hex value remains in component code. `grep -rnE "#[0-9a-fA-F]{3,8}" src/web/public/*.css`. Baseline was 316 plus 5 plus 1.
- [ ] No hardcoded px radius remains. `grep -nE "border-radius:\s*[0-9]" src/web/public/*.css`. Baseline was 199.
- [ ] Every shadow comes from `ds/tokens/effects.css`. Read every `box-shadow:` hit.
- [ ] Fonts resolve. No fallback-to-Times anywhere. Check in DevTools, not by eye.
- [ ] Grep for `slate`, `zinc`, `gray-50`, `#f8fafc`, `#f1f5f9`. Zero results. Notion greys are warm. **Project addition:** also grep the Catppuccin names `base`, `mantle`, `crust`, `surface0`, `surface1`, `surface2`, `overlay0`, `overlay1`, `subtext0`, `subtext1`, `mauve`, `lavender`, `flamingo`, `rosewater`, `sapphire`, `sky`. Zero results.
- [ ] Grep for `linear-gradient` and `backdrop-filter`. Expect zero, or one deliberate exception. Baseline was 5 and 5.

### Type

- [ ] Every text size in the app maps to a step in the documented scale (page title 40/48/700, H1 30/39/600, H2 24/31.2/600, H3 20/26/600, H4 18/23.4/600, body 16/24/400, chip 14/16.8/500).
- [ ] Headline tracking matches the scale. This is the most commonly missed detail.
- [ ] Tracking is negative at every size above 16px and positive only at 12px.
- [ ] No `text-transform: uppercase` with positive `letter-spacing` anywhere. **On this project the stronger rule applies: no `text-transform: uppercase` at all.**
- [ ] ~~Exactly one element on a marketing page is weight 600, the hero.~~ N/A, no marketing surface in the SPA. The app rule instead: headings are 600, body is 400, labels and chips are 500, the page title is 700. There is no 300, no 800 and no 900 anywhere.
- [ ] On the app surface, `getComputedStyle(document.body).fontFamily` starts with `ui-sans-serif`.
- [ ] ~~Numerals are lining, via `font-feature-settings: "lnum" 1, "locl" 0` on marketing.~~ N/A on the app surface, but harmless and recommended on numeric columns.

### Color and contrast

- [ ] Body text 4.5:1 on every surface it appears on.
- [ ] Large text and UI components 3:1.
- [ ] Focus ring visible on every interactive element, and visible on both light and dark.
- [ ] Disabled states are distinguishable without relying on color alone.
- [ ] Body text is not `#000000` anywhere. The app is `#2c2c2b`.
- [ ] Named block text colors are the same hex in light and dark. They are theme invariant. Recoloring them in dark mode is on the rejection list.
- [ ] **Project addition:** every ANSI terminal color clears 4.5:1 against the terminal ground in both themes.

### Layout

- [ ] ~~Section vertical rhythm matches `LAYOUT.md` at every breakpoint.~~ Marketing framing. The app equivalent: block rhythm matches LAYOUT.md 1.4 and 1.5 on every document surface.
- [ ] Container max width matches: **720px app**, on document surfaces.
- [ ] At 1440, the app content column measures exactly 720px and each gutter measures 375px.
- [ ] Nothing scrolls horizontally at 320px, 768px, 1024px, 1440px.
- [ ] A one line paragraph in the docs panel measures exactly **40px** tall. Measure it, do not assume it.
- [ ] Two consecutive list items have **1px** of collapsed padding between them, not 6px.
- [ ] `getComputedStyle` on any block returns `margin: 0px`. All rhythm is padding.
- [ ] A full bleed element spans the entire width without a negative margin hack.
- [ ] **Project addition:** topbar is 44px, sidebar is 240px with an inset hairline right edge, table header is 36px, table rows are 32px, chips are 20px.
- [ ] **Project addition:** the terminal grid, sessions table and kanban board are not capped at 720px.

### Motion

- [ ] Durations and easings come from `ds/tokens/motion.css`.
- [ ] Fade in is 150ms and fade out is 200ms, in that asymmetry.
- [ ] `prefers-reduced-motion: reduce` is honored and the app remains usable.
- [ ] Decorative animation is written inside `prefers-reduced-motion: no-preference`, not disabled inside `reduce`.
- [ ] No animation blocks interaction.
- [ ] Nothing animates on scroll. No reveal, no parallax, no fade up.
- [ ] No block moves, scales or lifts on hover. Only its handles fade in.
- [ ] Content loading shows a shimmer skeleton, not a spinner.
- [ ] **Project addition:** the hover gate strips hover affordances during scroll on the sidebar list, the sessions table and the kanban board.

### Voice

- [ ] Button labels are verbs and match the brand's capitalization rule, which is sentence case.
- [ ] Headings end in a period. Customer story headings do not.
- [ ] Empty states and error messages are rewritten, not left as defaults.
- [ ] No exclamation marks.
- [ ] No em dashes.

### The final test

- [ ] Screenshot the target's main screen next to `.../build/reference/` and the guideline cards in
      `.../build/guidelines/`. If a person familiar with Notion would not guess the two came from the
      same system, list what is different and fix the top three things.
- [ ] Ask a Notion user to look at the app screen for three seconds and say what it reminds them of.
      **The four tells that decide this**, in order of weight: is the content column narrow with a lot
      of empty margin; are the greys warm; is the type the OS font rather than a webfont; is there a
      hand inked illustration rather than a line icon in a rounded square. If they say "Linear" you
      have cool greys and too much density. If they say "a generic docs site" you are missing the
      illustration and the column is probably too wide.

ADAPTATION note on the final test: this app is a dense data product, so tell number one only reads on
its document surfaces. Run the three second test twice, once on the docs panel and once on the
terminal grid, and judge each against its own class from section 0.3.

### Deliverables gate

- [ ] `DEVIATIONS.md` exists and every accessibility driven departure has a row.
- [ ] `INVENTIONS.md` exists and every derived component has a row.
- [ ] `DECISIONS.md` exists and answers 0.4, step 12 and 5.3.
- [ ] Every commit maps to exactly one step from section 2.
- [ ] The step 7 spacing commit is separate from and later than the step 2 token commit, per the
      APPLY.md rollback caution.

---

## 8. Rollback

APPLY.md section 7: because step 2 points existing variables at new tokens rather than rewriting call
sites, a rollback is: revert `tokens/`, revert the theme indirection, keep everything else. Keep the
migration in its own branch and its own commits per step, so any single step can be reverted without
unwinding the rest.

The one caution, repeated because it decides the commit order: **step 7, the margin to padding
conversion, is the hardest step to revert**, because it rewrites component internals rather than a
theme layer. Do it in its own commit, after the token work is already merged and stable, so that
reverting it does not take the palette with it.

Project specific rollback aid: `src/web/public/semantic-theme.css` is 93 lines and is the single
choke point for the color contract. Reverting that one file plus the `<html>` `data-surface`
attribute returns the app to Catppuccin even if every other step has landed.
