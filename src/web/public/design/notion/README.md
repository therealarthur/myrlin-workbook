# Vendored Notion design bundle

Created: 2026-08-13 (Notion restyle, phase P0, work package P0.2)

This directory is a **verbatim copy** of the captured Notion design bundle that lives, read only,
at `docs/design/notion-import/_ds/`. It is vendored under `src/web/public/` so the runtime can
serve the parts of it that are actually linked, and so the token values that the project
duplicates into `styles.css` have a machine-checkable source of record inside the served tree.

## What is here

| Path | Bundle source | Linked into `index.html`? |
| --- | --- | --- |
| `tokens/colors.css` | `_ds/tokens/colors.css` | **No.** Reference and parity source only. |
| `tokens/typography.css` | `_ds/tokens/typography.css` | **No.** |
| `tokens/spacing.css` | `_ds/tokens/spacing.css` | **No.** |
| `tokens/effects.css` | `_ds/tokens/effects.css` | **No.** |
| `tokens/motion.css` | `_ds/tokens/motion.css` | **No.** |
| `tokens/tokens.json` | `_ds/tokens/tokens.json` | **No.** Machine-readable provenance, including the `inferred` flags. |
| `components.css` | `_ds/components/components.css` | Yes, from phase P1 onward, **before** `styles.css`. Not linked in P0. |
| `fonts/iAWriterMonoS-*.woff2` | `_ds/assets/fonts/` | Served from phase P1 onward through `fonts.css`. Not linked in P0. |
| `fonts/permanent-marker.woff` | `_ds/assets/fonts/` | Same. |

`fonts.css`, the four `@font-face` blocks with their `src` rewritten to `/design/notion/fonts/`,
is created in phase P1. The bundle's own aggregate entry sheet (`_ds/styles.css`) is deliberately
**not** vendored: it `@import`s the token files and adds a global base layer that would fight the
application's own reset, and having it here would invite someone to link it. Read it in
`docs/design/notion-import/_ds/styles.css` when you need the `@font-face` blocks or the primitives.

## Why the token files are not linked

`test/phantom-tokens.test.js` uses `styles.css` and `styles-mobile.css` as **both** the
consumption scan and the definition scan. A custom property that is defined only here and consumed
in `styles.css` is therefore a phantom: the gate turns red and, worse, the rule that consumes it
silently does nothing in the browser.

So every `--app-*`, `--radius-*`, `--duration-*`, `--ease-*`, `--motion-*` and `--font-*` token the
project consumes is authored into the `:root` block of `styles.css`, with its value copied verbatim
from these files. `test/notion-token-parity.test.js` diffs the two sides on every run, so the
duplication cannot drift silently. See `docs/design/notion-restyle/BUILD-CONTRACT.md` sections
1.1.1 and 6/R9.

## Rules

1. **Never edit a file in this directory.** It is a copy of a captured brand, not project source.
   `test/notion-token-parity.test.js` asserts every vendored file is still identical to its bundle
   source and still matches its recorded SHA-256, so an edit here fails CI.
2. **Never edit `docs/design/notion-import/_ds/**` either.** It is the read-only source of record.
3. To change a token **value** the project uses, change the `:root` block in `styles.css` and
   record the departure in `docs/design/notion-restyle/DEVIATIONS.md`. The parity test will then
   fail until the deviation is added to its allow list, which is the intended friction.
4. Tokens the project needs that the bundle does not contain are **inventions** and go in
   `docs/design/notion-restyle/INVENTIONS.md`. There are exactly three at the time of writing:
   `--app-on-accent`, `--app-scrim`, `--app-terminal-gutter`.

## Licensing

`iA Writer Mono S` is SIL OFL 1.1 and `Permanent Marker` is Apache 2.0. Both are redistributable.
The captured token values are recorded observations of a third-party product's public stylesheets
and are used here as a design reference, not as a claim of ownership.
