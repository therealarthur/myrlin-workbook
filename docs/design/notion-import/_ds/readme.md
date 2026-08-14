# Notion design system

Captured 2026-08-10 from live bytes and from computed styles measured in headless Chromium at
1440x900 unless stated otherwise.

## The one thing to understand first

**Notion is two design systems wearing one logo, and they share almost nothing.**

| | Marketing | App UI |
|---|---|---|
| Where | `notion.com` | the `notion.so` and `*.notion.site` editor |
| Token layer | `base_theme`, nine step ramps per hue | `.notion-light-theme` and `.notion-dark-theme`, three letter abbreviations |
| Font | NotionInter webfont, four weights | **no webfont at all**, the OS UI stack |
| Blue | `#0075de` | `#2383e2` |
| Ground | pure `#ffffff` | `#ffffff` canvas, `#f9f8f7` sidebar |
| Ink | `rgba(0,0,0,0.95)` | `#2c2c2b` |
| Container | 1252px, fluid gutter | **720px hard cap, 96px minimum gutter** |
| Depth | 11 shadowed elements on the whole homepage | zero shadow on the canvas, all depth in overlays |

Do not blend them. In this bundle they are `--mkt-*` and `--app-*`, and a semantic layer sits on
top that flips between them with a single attribute:

```html
<html>                     <!-- marketing -->
<html data-surface="app">  <!-- the editor -->
```

## Five things that make this brand recognizable

1. **A narrow document floating in a lot of nothing.** The editor text column is 720px, hard
   capped, centered, with a hard 96px minimum gutter. In a 1440 viewport that leaves 375px of
   empty margin on each side, and that margin is not filled, not tinted and not bordered. Add a
   270px empty click zone at the bottom of every page. This is the single strongest signal.
2. **The block box model.** 6px wrapper padding plus 2px leaf padding, zero margins between
   blocks, so a one line 16px/24px paragraph is exactly 40px tall. Consecutive list and toggle
   items collapse from 6px to 1px, which is why a Notion list reads visibly denser than the prose
   around it. Heading air comes from `padding-top` on the wrapper, never from margin.
3. **Warm neutrals and warm translucent washes.** Grays carry a yellow brown cast, never a blue
   cast: `#f9f9f8`, `#f6f5f4`, `#dfdcd9`, `#a39e98` on marketing, `#f9f8f7`, `#f0efed`, `#e6e5e3`,
   `#2c2c2b` in the app. Every hover and press is `rgba(55,53,47, .04 / .06 / .10 / .16)`, the
   legacy Notion ink `#37352f` surviving as an alpha base. Anything built on `slate` or `zinc` is
   wrong.
4. **The editor has no webfont.** `.notion-frame` computes to
   `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI",
   Helvetica, ...`. **Loading Inter into a Notion-alike document body is instantly wrong**, on both
   macOS and Windows, and it is the mistake almost everyone makes.
5. **Hand inked illustration with coarse halftone screentone.** Black brush line of non uniform
   weight, solid black hair and clothing, halftone dots for skin and mid tones, one to three flat
   unoutlined accent shapes, naive proportions with an oversized head, no background, no container,
   no shadow, 30 to 45 percent deliberate empty canvas. The page around it is white with near black
   text and a blue button. Get the illustration wrong and the whole thing reads as generic SaaS.

## The palette conflict, read this before filing a bug

Notion **refreshed the named block palette**, and the current values differ from every third party
document about Notion colors that you are likely to check this bundle against.

| | Current, what this bundle ships as primary | Legacy, what most articles still quote |
|---|---|---|
| Blue text | `--c-bluTexSec` `#387dc9` | `--cd-palBlu500` `#337ea9` |
| Blue background | `--c-bluBacSec` `#e5f2fc` | `--cd-palBlu50` `#e7f3f8` |
| Red text | `--c-redTexSec` `#cf5148` | `#cd3c3a` |
| Gray text | `--c-graTexSec` `#7d7a75` | n/a |
| Gray background | `--c-graBacSec` `#f0efed` | `rgba(84,72,49,.08)` over white, the familiar `#f1f1ef` |

Both sets are still shipped by Notion. The legacy set survives only as `--cd-pal*` and is present
here under `--app-legacy-*` for recognition and migration. **A reviewer checking this bundle
against stale public documentation will conclude it is wrong when it is right.** Point them here.

Two further palette facts that get missed:

- The named **text** colors are **theme invariant**. There is no dark override for any `TexSec`
  token, verified by grepping the captured dark theme. Blue text in a dark Notion page is the same
  `#387dc9` it is in a light one. Only the ground and the neutral inks flip.
- **Property chips are a separate, denser color system.** Fill is a translucent hue wash
  (`--ca-<hue>BacTerTra`), ink is a deep tinted hue (`--c-<hue>TexPri`). Neither comes from the
  block palette. Because the fill is translucent, a chip composites correctly on white, on a
  hovered row, and inside a colored callout with no extra rules.

## Palette at a glance

**Marketing action colors.** Only two visual weights of CTA exist above the fold.

| Role | Value | Where |
|---|---|---|
| Primary button | `#0075de` blue-600, white text | "Get Notion free" |
| Primary hover | `#005bab` blue-700 | |
| Secondary button | `#e6f3fe` blue-200 fill, `#005bab` blue-700 text | "Request a demo" |
| Link | `#0075de`, hover `#00396b` | |
| Body ink | `rgba(0,0,0,0.95)` alpha-black-900 | never flat `#000000` |
| Nav ink | `rgba(0,0,0,0.898)` alpha-black-800 | |
| Eyebrow ink | `rgba(0,0,0,0.54)` alpha-black-500 | |
| Hairline | `rgba(0,0,0,0.10)` alpha-black-200 | every border on the site |
| Page ground | `#ffffff` | **pure white, not cream** |
| Section band | `#f9f9f8` gray-100, one block at `#f6f5f4` gray-200 | alternating, and often absent |

**App UI core.**

| Role | Light | Dark |
|---|---|---|
| Canvas | `#ffffff` | `#191919` |
| Sidebar | `#f9f8f7` | `#202020` |
| Elevated surface | `#ffffff` | `#202020` |
| Body ink | `#2c2c2b` | `#f0efed` |
| Secondary ink | `#7d7a75` | `#ada9a3` |
| Tertiary ink, placeholders | `#a19e99` | `#7d7a75` |
| Border | `#e6e5e3` | `#383836` |
| UI blue | `#2383e2` | `#2383e2` |
| Hover wash | `rgba(55,53,47,.04)` | `rgba(255,255,255,.055)` |
| Press wash | `rgba(55,53,47,.10)` | `rgba(255,255,255,.13)` |

**Named block palette, current.** Text colors identical in light and dark.

| Hue | Text | Background light | Background dark |
|---|---|---|---|
| Gray | `#7d7a75` | `#f0efed` | `#383836` |
| Brown | `#9f765a` | `#f5ede9` | `#45362d` |
| Orange | `#d27b2d` | `#fbebde` | `#53361f` |
| Yellow | `#cb9434` | `#f9f3dc` | `#504425` |
| Green | `#50946e` | `#e8f1ec` | `#263d30` |
| Blue | `#387dc9` | `#e5f2fc` | `#233850` |
| Purple | `#9a6bb4` | `#f3ebf9` | `#3c2d47` |
| Pink | `#c14c8a` | `#fae9f1` | `#4e2b3c` |
| Red | `#cf5148` | `#fce9e7` | `#502c29` |
| Teal | `#2c8b9e` | `#e0f3f7` | `#143d45` |

## Type scale

**Marketing.** Fifteen steps. Tracking runs negative at every size above 16px and is positive
exactly once, at the 12px micro step. Uppercase tracked out labels are therefore off brand by
construction.

| Step | Size | Line | Tracking regular | Tracking bold | Used for |
|---|---|---|---|---|---|
| 50 | 12px | 16px | +0.125px | +0.125px | template counts, micro labels |
| 100 | 14px | 20px | 0 | 0 | eyebrows, captions, tags |
| 150 | 15px | 20px | 0 | 0 | form fields, list links |
| 200 | 16px | 24px | 0 | 0 | **body default**, nav, buttons |
| 300 | 18px | 28px | -0.125px | -0.125px | lead paragraphs |
| 350 | 20px | 28px | -0.125px | -0.125px | large body |
| 400 | 22px | 28px | -0.25px | -0.25px | card and plan headings, **and the price** |
| 500 | 26px | 32px | -0.625px | -0.625px | gallery row headings |
| 600 | 32px | 40px | -1px | -0.75px | pricing section headings |
| 700 | 42px | 48px | -2px | -1.5px | final CTA, customer story h1 |
| 800 | 54px | 56px | -3.5px | -1.875px | **the standard section h2** |
| 900 | 64px | 64px | -2.75px | -2.125px | pricing page h1 |
| 1000 | 76px | 80px | -4px | -2.5px | campaign display |
| 1100 | 96px | 100px | | -4.6px semibold | **homepage hero h1** |

The hero is the only fluid type on the site. It scales continuously from 42px to 96px and caps at a
1280 viewport. Measured: 375, 430 and 600 all give 42px; 768 gives 60.9px; 834 gives 68.3px; 1024
gives 89.7px; 1280 and above give 96px. It is also the only weight 600 text on the site. Every
other heading is 700.

**App UI.** Fixed px, no rem, three ratios and nothing else.

| Role | Size | Line | Ratio | Weight | Wrapper padding |
|---|---|---|---|---|---|
| Page title | 40px | 48px | 1.2 | 700 | `0 8px` |
| H1 | 30px | 39px | 1.3 | 600 | `30px 6px 6px` |
| H2 | 24px | 31.2px | 1.3 | 600 | `26px 6px 6px` |
| H3 | 20px | 26px | 1.3 | 600 | `22px 6px 6px` |
| H4 | 18px | 23.4px | 1.3 | 600 | `18px 6px 6px` |
| Body | 16px | 24px | 1.5 | 400 | `6px` |
| Property chip | 14px | 16.8px | 1.2 | 500 | inside a 20px chip |

Small text mode scales body to 14px/21px and the title to 32px/38.4px, keeping the same ratios.

## Font licenses

| Family | Role | License | Redistributable here? | Fallback if not |
|---|---|---|---|---|
| **OS system UI stack** | **App UI default body font** | n/a, not a webfont | n/a | This IS the answer. See `--font-app-ui`. Do not replace it with a webfont. |
| **NotionInter** | Marketing sans, everything | A Notion specific cut of Inter, served from notion.com. No public license grant. | **No** | Ship **Inter** (SIL OFL 1.1) and self host it. Notion's own declared fallback is literally `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, ..., Arial, sans-serif`, which is what `--font-mkt-sans` already contains, so adding Inter to the project upgrades the stack with zero token edits. Metrics are near identical; no size, weight or tracking adjustment is needed. |
| **Lyon Text** | Marketing serif; the app's "Serif" font option | Commercial Type, paid retail license | **No** | Notion's own declared fallback is the Georgia chain in `--font-serif`. Closest free stand ins with comparable warmth: **Source Serif 4** (OFL) or **Newsreader** (OFL). Both run slightly wider than Lyon; if you substitute, drop one tracking step at 42px and above. |
| **iA Writer Mono S** | Marketing mono; the app's "Mono" font option | **SIL OFL 1.1** (iaolo/iA-Fonts, a derivative of IBM Plex Mono, copyright 2017 IBM Corp and Information Architects GmbH) | **Yes, shipped**: Regular, Italic, Bold, BoldItalic | n/a |
| **Permanent Marker** | Marketing handwriting accent | **Apache License 2.0** (Google Fonts, Font Diner) | **Yes, shipped** | n/a |
| Noto Sans Arabic / Hebrew | Script coverage, both surfaces | SIL OFL 1.1 | Not shipped, not needed for a Latin build | Named in the stacks so a project that adds them gets them |

Only four faces actually load on the marketing site: `NotionInter` at 400, 500, 600 and 700, all
roman. Every italic, every `-i18n` subset and every `-math` subset is declared and reports
`unloaded`. **Do not ship italics.** A faithful rebuild needs exactly four weights.

## What is in this bundle

```
SKILL.md          the skill entry point, read this first when restyling
readme.md         this file, brand truth
APPLY.md          the retrofit playbook for an existing app
LAYOUT.md         the 720px grid, the block box model, the header stack
VOICE.md          headline formulas, verbatim samples, a rewrite gallery
MOTION.md         durations, easings, named patterns, what does NOT animate
ART-DIRECTION.md  the illustration brief, concrete enough to hand to an illustrator
CONVERSION.md     how the design does commercial work
styles.css        drop in stylesheet: fonts, tokens, base, primitives
tokens/           five CSS files, tokens.json, tailwind.config.js
guidelines/       sixteen preview cards, one per topic
components/       thirty seven components, each with jsx, d.ts and prompt.md,
                  plus components.css, the paint layer they all consume
_ds_bundle.js     the ES5 runtime mirror of components/, on one global
ui_kits/          two full pages: the marketing site and the editor
assets/fonts/     the two redistributable families
assets/icons.svg  the canonical monoline icon sprite, 43 symbols
reference/        nine 1280x800 screenshots of the real pages
```

`components/components.css` is imported by `styles.css`, so linking that one file still gets
everything. It is a separate file only so `styles.css` stays readable.

`tokens/tokens.json` is generated by parsing `tokens/*.css`, so it cannot drift from the CSS. Every
token carries a `source` naming the captured file it came from, and any token that was derived
rather than observed carries `"inferred": true`.

## Gaps and inferences

Everything below was either derived rather than observed, or could not be determined at all. Nothing
here is presented in the tokens as fact without a matching `/* inferred */` comment.

### Derived values shipped in the tokens

| Token | What was done | Why |
|---|---|---|
| `--hero-size` | Fitted a `clamp()` to the two measured endpoints, 42px at a 600 viewport and 96px at 1280. | Notion's real curve is a build time calculation, not a token. The fit is exact at both ends; in the middle it predicts 55.3 / 60.6 / 75.7 against measured 60.9 / 68.3 / 89.7, so the real curve is slightly steeper. Treat it as a close reproduction, not a byte match. |
| `--app-bg-accent-primary`, `--app-bg-accent-secondary`, `--app-text-inverse-primary`, `--app-text-inverse-secondary`, `--app-border-accent-primary` in dark | Used the inverse of the light value. | No dark override exists for these in the captured dark theme, and the light `#2c2c2b` primary button fill would be invisible on the `#191919` dark ground. |
| `--shadow-nav-scrolled` | Read the color from the hairline token the nav animates toward. | The rest state, a transparent 1px bottom shadow, is captured; the scrolled state is only observable by scrolling. |
| `--app-sidebar-edge` in dark | Kept the inset 1px pattern, recolored to the dark `--app-border-secondary`. | The mechanism is captured in light; the dark value is not. |
| Bold `iA Writer Mono` declared at `font-weight: 600 700` | Widened Notion's own `600` declaration. | So a `font-weight: 700` rule resolves to the real bold file rather than to a synthetic bold. This is the only change made to Notion's own `@font-face` rules. |
| `nt-slide-up-small`, `nt-shake`, `nt-selected-outline-scale` keyframe bodies | Keyframe names and durations are captured; the offsets and amplitudes are read from rendered UI. | The keyframe bodies live in lazily loaded chunks. |
| `.nt-sidebar-item` `min-height: 27px` | Estimated from rendered proportions. | See the next table. |

### Added by the component build, and why

The component library needed metrics that no captured page carried. They live in
`tokens/spacing.css` section 10, are mirrored in `tokens.json` with `"inferred": true`, and are
listed here so nobody mistakes a reconstruction for a measurement. Two are measured rather than
inferred, and one is derived.

| Token group | Status | What was done |
|---|---|---|
| `--mkt-btn-height` 36px, `--mkt-btn-height-secondary` 38px, `--mkt-btn-height-ghost` 30px, `--mkt-search-height` 56px, `--mkt-search-pad` | **Measured** | Read off the rendered CTA row and the help centre search field, same provenance as the rest of the marketing set. |
| `--app-peek-width` | **Derived** | `720px content column + 2 x 76px side peek margin`, both measured. Deriving it keeps a peeked page and a full page at the same measure, which is what makes a peek feel like the same document. |
| `--app-handle-*` (4), `--app-menu-*` (4), `--app-toolbar-height` | Inferred | The slash menu, the inline toolbar and the block hover handles need an authenticated session. Their captured BEHAVIOUR is reproduced exactly; the pixel geometry is reconstructed from the chrome around them. |
| `--app-input-*`, `--app-icon-button-size*`, `--app-sidebar-item-height`, `--app-todo-box-size`, `--app-toggle-caret-size`, `--app-switch-*`, `--app-avatar-*` | Inferred | Anchored on values that were measured: the 28px in-app button height, the 18px database row icon, the 24px marker box. |
| `--app-quote-rule-width` 3px, `--app-quote-pad` 14px | Inferred | No captured public page carried a quote block. The rule COLOUR is not a guess: it is the current page ink, which is why a quote inverts correctly in dark mode. |
| `--app-table-row-height`, `--app-board-*` (3), `--app-gallery-gap`, `--app-gallery-preview-height`, `--app-code-*` (2), `--app-modal-width`, `--app-toast-width` | Inferred | The 36px table header, the 296px gallery card, the `#f5f2f0` code fill and the `#f7f6f3` sticky header are all measured; the geometry around them is not. |

Two behaviours were also corrected in the component layer after rendering the result rather than
reasoning about it, and both corrections are commented in `components/components.css`:

- **The list collapse.** `styles.css` collapses the bottom padding of any list item that is not the
  last child of its container. That is right for a run that ends a page and wrong for a run followed
  by a paragraph. The component layer restores 6px unless the next sibling is itself a list item, so
  a run collapses only between its own members. Measured: the last item of a run was 30px where it
  should be 35px.
- **The divider block.** The rule carries its own 6px margins and the block has no padding, so
  without a flow root those margins collapsed out of the wrapper and the block measured 1px instead
  of 13px.

### Not determinable, and what that costs

| Item | Status | Who this affects |
|---|---|---|
| Sidebar row height, and the sidebar drag resize minimum and maximum | Not measurable. Public `*.notion.site` pages always render the sidebar at `width: 0`, and the constants are not in the three captured JS bundles. | Anyone building an app shell. Use the 27px estimate and adjust by eye. |
| **Slash command menu geometry**: width, row height, section header style, icon size | Not observable without an authenticated session. The `.15s ease-in fadein` animation and the `--c-shaOutMd` popover shadow are captured; the menu's own metrics are not. | **The app UI kit. Flagged specifically because it is a headline editor affordance.** |
| **Inline selection toolbar geometry** | Same. Not reachable on a read only public page. | **The app UI kit.** |
| **Block hover handle geometry**: the six dot drag handle and the plus button, their pixel size and gutter offset | Same. The behavior is confirmed from CSS: hidden until the row is hovered, positioned in the left gutter outside the text column so they never shift the text, and gated behind a `.notion-enable-hover` class that is stripped during scroll and drag. The exact pixels are not. | **The app UI kit.** Build the behavior, approximate the pixels. |
| **Comment thread visual spec** | Only the 468px right margin reservation is confirmed. | **The app UI kit.** |
| Quote block left rule width and color | Not present on any captured public page. | Anyone reproducing the full block set. |
| Board (kanban) column width and card spacing | No captured public page rendered a board view with measurable columns. | Anyone reproducing database views. |
| Whether marketing honors `prefers-color-scheme` | Unresolved, and probably not. No such media query exists in any of the 20 captured stylesheets. Marketing dark appears to be section scoped via `dark_palette_theme` only. **This bundle wires the real captured dark values to the system preference anyway, which is an extension rather than brand truth.** If you want to match Notion exactly, put `.mkt-theme-dark` on a section and set `data-theme="light"` on the root. | Anyone shipping a marketing page with a dark toggle. |
| Exact binding of the `fadein` durations to specific overlays | The keyframes and the durations `.15s`, `.23s`, `.33s`, `.5s`, `.6s` are captured. Which component uses which lives in lazily loaded chunks that require an authenticated session. | Anyone matching overlay timing precisely. Use `.15s` for menus and popovers; it is the fast group. |

## Provenance

Captured 2026-08-10.

- **Marketing pages fetched:** `notion.com/`, `/pricing`, `/product`, `/templates`, five
  `/templates/category/*` pages, `/help`, two help articles, `/customers`, `/customers/figma`,
  `notion.so/login`.
- **Stylesheets fetched:** 20 marketing stylesheets from `/_next/static/css/`, 3 app stylesheets,
  3 app JS bundles.
- **Editor pages measured:** `notion.so/28ffdd08...` plus twelve independent public
  `*.notion.site` pages, chosen so that every editor measurement in this bundle is corroborated
  across pages built by different people.
- **Illustrations examined:** 8 assets from `/front-static/`, all under 1200px on the long edge.
- **Probes:** 13 JSON measurement sets from 11 reproducible probe scripts, kept alongside the
  dossier so any computed number can be re-derived rather than trusted.
- **Screenshots:** 9 at 1280x800 in `reference/`.

Where the static CSS and the computed styles disagreed, the computed value won, because it is what
the browser actually painted.
