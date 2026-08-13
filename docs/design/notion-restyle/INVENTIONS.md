# INVENTIONS: components and tokens this project derived rather than captured

| Field | Value |
| --- | --- |
| Status | Living. Opened in phase P0 (work package P0.3), appended every phase. |
| Opened | 2026-08-13 |
| Required by | `BUILD-CONTRACT.md` 5.5.5, the deliverables gate. `PROCEDURE.md` section 7. |

The captured Notion bundle at `docs/design/notion-import/_ds/` contains a design system for a
document editor and a marketing site. Myrlin Workbook is neither. Every component and token this
project needs that the capture does not contain is an **invention**, and every invention gets a row
here before it ships.

A row answers four questions:

1. **Nearest relative.** What in the captured system is this closest to?
2. **Inherited.** Which properties were taken from that relative unchanged?
3. **Invented.** What had to be decided from nothing, and on what principle?
4. **Where.** The file and the phase.

An invention is not a licence to design freely. The order of preference is always: use a captured
component, then derive from the nearest captured relative, then invent. Reaching row four without
having tried rows one and two is a review failure.

---

## Tokens

`test/notion-token-parity.test.js` reads this file's token names out of the table below. A token
that `styles.css` defines in a bundle-owned family but that the bundle does not contain must appear
here, or the parity test fails. That is the enforcement: an invention cannot be smuggled in as a
typo.

| Token | Value | Nearest relative | Inherited | Invented | Where | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| `--app-on-accent` | `#ffffff` in both chrome themes | `--mkt-white`, which is what the bundle's own `nt-btn-app` paints its label with | The colour itself, white, and the role, ink on the primary action | That it is a **token** at all, and that it is theme invariant. The bundle reaches for a marketing token here, and `DESIGN-SPEC.md` 16.2 puts `--mkt-*` on the rejection list for the app surface. The obvious app-surface substitute, `--app-text-inverse-primary`, resolves to `#191919` in dark chrome, which is near-black ink on a mid blue and fails the contrast floor. `--app-accent-blue` does not change between themes, so its ink must not either. | `styles.css` `:root` | P1 |
| `--app-scrim` | `rgba(15,15,15,0.55)` | `--app-image-overlay` | The rgba form and the near-black hue | The alpha. The captured overlay is tuned for an image inside a document; Workbook modals sit over a dense application with live terminals behind them, and `DESIGN-SPEC.md` 8.3 says follow the mock and go darker so the modal wins attention. | `styles.css` `:root` | P1 |
| `--app-terminal-gutter` | `var(--app-bg-primary)` | Nothing. The capture contains no terminal. | The value, which is just the canvas | The name. The terminal grid's gutter is given its own token even though it currently resolves to the canvas, so that a later decision to tint it is a one-line change rather than an edit to every grid rule. | `styles.css` `:root` | P1 |
| `--radius-pill` | `999px` | `--radius-round`, `624.9375rem`, which the capture builds `--radius-badge` and `--radius-menu-button` on | The role: one radius large enough that any control height resolves to a true pill, applied to the account chip, the attention badge and the count badges | The value, and the fact that the token exists at all. `--radius-round` cannot be authored: `DEVIATIONS.md` DV-4 records that the capture's own `.mkt-theme-academic` and `.mkt-theme-serif` blocks re-declare every ramp rung including `--radius-round` as `0`, so the value the parity gate reads from the bundle is `0` and copying it would ship square pills. `999px` is what the mock itself writes for the account chip (`DESIGN-SPEC.md` 1.4), and above roughly twice the tallest control it is visually indistinguishable from `624.9375rem`. | `styles.css` `:root` | P2 |
| `--radius-pane-frame` | `8px` | `--radius-callout` `10px` and `--radius-block-hover` `6px`, the two captured radii it sits between | The idea of a semantic radius name rather than a rung number | The value. `DESIGN-SPEC.md` 1.4 lists 8px as **mock-local**: the pane frame, the cost card, the drop slot, the board column and the mobile cards are all drawn at 8px and the captured token file contains no 8px radius, because a document editor has no pane frame. Rounding these to the 10px callout would erase the mock's own distinction between a frame and a callout, and rounding down to 6px would make a 260px board column look like a button. | `styles.css` `:root` | P2 |

---

## Components

No component inventions yet. P2 onward will add rows here for every Workbook surface that has no
counterpart in a document editor. The list to expect, from `DESIGN-SPEC.md`: the terminal pane
header, the pane grid gutter, the session status dot system, the provider identity pill, the
attention queue, the cost meter, the usage meter, the kanban board card, the worktree review banner,
the mobile tab bar and the Select-mode strip.
