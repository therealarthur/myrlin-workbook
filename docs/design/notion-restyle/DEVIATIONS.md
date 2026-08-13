# DEVIATIONS: every departure from the captured brand

| Field | Value |
| --- | --- |
| Status | Living. Opened in phase P0 (work package P0.3), appended every phase. |
| Opened | 2026-08-13 |
| Required by | `BUILD-CONTRACT.md` 5.5.5, the deliverables gate. `PROCEDURE.md` 4.3. |

Every row answers six questions, in this order, per `PROCEDURE.md` 4.3:

1. **What the brand says.** The captured value, rule or pattern.
2. **What shipped.** The value or pattern this project uses instead.
3. **Why.** The constraint that forced it. "It looked better" is not a reason; "the JS reads this
   number back" is.
4. **What it costs.** The fidelity, accessibility or consistency price, stated honestly.
5. **Who approved.** A named decision, not a shrug.
6. **Date.**

A deviation is not a bug and it is not a failure. An undocumented deviation is both.

---

## Open rows

| # | What the brand says | What shipped | Why | Cost | Approved by | Date |
| --- | --- | --- | --- | --- | --- | --- |
| DV-1 | The mock initialises the sidebar at 244px. | 240px. | `LAYOUT.md` 1.7 and `PROCEDURE.md` step 6 both give 240px as the measured brand value; 244 is an unexplained prototype default. | 4px of mock fidelity. Invisible. | Contract 1.9 C3 | 2026-08-13 |
| DV-2 | The mock's sidebar drag clamps between 200px and 420px. | The existing `180..600` clamp is unchanged. | `DO-NOT-BREAK.md` D.4: `cwm_sidebarWidth` already holds persisted values outside the mock's range, and narrowing the clamp would silently invalidate them for existing users. | The sidebar can be dragged narrower and wider than the mock intends. | Contract 1.9 C3 | 2026-08-13 |
| DV-3 | The bundle's `nt-enable-hover` is set once on the shell and never removed. | It is stripped on `scroll` and `dragstart` and restored after a short idle. | `DESIGN-SPEC.md` 1.7 and `PROCEDURE.md` step 10 item 5 both require the strip. The mock is a prototype and never scrolls a live terminal grid. | None. This is the mock being wrong, not the brand. | Contract 2.1 | 2026-08-13 |
| DV-4 | The capture defines a numeric radius ramp, `--radius-4` through `--radius-16` plus `--radius-round`, and builds twelve semantic radii on top of it, including `--radius-popover: var(--radius-12)`. | Neither the ramp nor the twelve aliases are authored into `styles.css`. The project consumes the capture's literal-valued semantic radii (`--radius-property-chip` 4px, `--radius-app-button` 6px, `--radius-callout` 10px, `--radius-status-chip` 10px, `--radius-collection-card` 10px, `--radius-block-hover` 6px, `--radius-row-icon` 3.5px, `--radius-page-icon` 4px, `--radius-avatar` 100%), and `--radius-lg` carries a literal `12px`. | The capture's own `.mkt-theme-academic` and `.mkt-theme-serif` section themes re-declare all ten ramp names as `0`. A last-definition-wins read of the bundle, which is what `notion-token-parity.test.js` performs, therefore records the ramp as `0`, not as `0.25rem` and friends. Copying the `:root` value would read as drift and fail the gate; copying `0` would ship square corners everywhere. Authoring the marketing section-theme block into an application stylesheet to reproduce the cascade would be worse: two rejection-list class names and nine dead declarations, for a theme this product does not have. | 12px arrives as a literal instead of an indirection, so a future change to the capture's `--radius-12` would not propagate automatically. Mitigated by the inline comment at the definition site and by this row. No visual cost: `var(--radius-12)` resolves to exactly 12px. | P1 implementation agent, under contract 1.4 table C, which specifies the resolved value `12px` for `--radius-lg` rather than the token path | 2026-08-13 |
| DV-5 | `BUILD-CONTRACT.md` 3.1 says the fonts stylesheet carries "the four `@font-face` blocks". | Five ship: the four iA Writer Mono faces plus Permanent Marker. | The capture's own drop-in stylesheet declares five, the Permanent Marker binary was already vendored in P0, and `--font-handwriting` names the family. A declared family with no matching face falls back silently to Times. A face is only downloaded when something matches it, and nothing does yet, so the cost of declaring it now is zero bytes on the wire. | None. This is more faithful to the capture, not less. | P1 implementation agent | 2026-08-13 |
| DV-6 | `BUILD-CONTRACT.md` 4.4 P1.5 lists sanctioned test edits SE-1 through SE-6 as P1 work. | Only SE-1 and SE-4 shipped in P1, alongside SE-7 and the orchestrator's SE-11. SE-2, SE-3, SE-5 and SE-6 were not made. | Contract 5.4 requires every sanctioned edit to ship "in the same commit as its source change", and 4.1 item 7 forbids editing a test that is not actually broken. SE-2, SE-3, SE-5 and SE-6 all retarget assertions over CALL SITES in `styles.css` (a 4px pane border, a `linear-gradient`, `var(--red)` in a Codex chip, three single-line meter-fill rules). P1 re-points token DEFINITIONS and touches none of those call sites, so all four tests pass unedited. Making the edits in P1 would have asserted values that do not exist yet and turned CI red. | None now. The four edits move to the phase that changes their call sites: SE-2 and SE-3 to P2 or P3 with the pane frame and the gradient removal, SE-5 to P3 or P4 with the status ink sweep, SE-6 to P3 or P4 with the meter sweep. Recorded so the phase that hits them knows they are already blessed. | P1 implementation agent, under contract 5.4 and 4.1 item 7 | 2026-08-13 |

Rows DV-1 to DV-3 are recorded in P0 because they are already decided by the contract; the code that
implements them lands in P1 and P2. Every later row is added by the phase that ships it.

Rows DV-4 to DV-6 were incurred in P1.

## Expected rows, not yet incurred

These are named here so the phase that hits them writes a row rather than quietly choosing.

| Trigger | Phase | What the row will have to say |
| --- | --- | --- |
| Warning orange `#d27b2d` or yellow `#cb9434` as small text on the plain canvas | P3, P4 | The pairing is re-cut onto the matching `--app-bg-<hue>` wash. The token is **never** darkened. Each instance carries the measured ratio in an inline CSS comment. `PROCEDURE.md` 4.2. |
| ~~`--status-complete` moving from green to teal~~ | ~~P1~~ | **Shipped in P1.3.** Not a brand deviation after all: `DESIGN-SPEC.md` 6 gives complete as teal, so the change moves the project **onto** the brand rather than away from it. No row incurred. Recorded here so nobody re-opens it. |
| Any new z-index rung | P4, P7, P10, P11 | The authored ladder and where the new layer sits in it, per risk R6. Nothing above 10004. |
| A terminal font other than `--font-code` | P5 | Only if OQ-2 is answered against the default. |
| Dropping figurative illustration entirely | P12 | Only if OQ-3 is answered against the default. Costs a measurable amount against the three-second test. |
| The shadowed `POST /api/sessions/:id/summarize` handler at `server.js:2800` | P9 | The dead second registration is recorded rather than deleted, per code preservation and OQ-5. |
