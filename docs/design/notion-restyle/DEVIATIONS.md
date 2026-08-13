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

Rows DV-1 to DV-3 are recorded in P0 because they are already decided by the contract; the code that
implements them lands in P1 and P2. Every later row is added by the phase that ships it.

## Expected rows, not yet incurred

These are named here so the phase that hits them writes a row rather than quietly choosing.

| Trigger | Phase | What the row will have to say |
| --- | --- | --- |
| Warning orange `#d27b2d` or yellow `#cb9434` as small text on the plain canvas | P3, P4 | The pairing is re-cut onto the matching `--app-bg-<hue>` wash. The token is **never** darkened. Each instance carries the measured ratio in an inline CSS comment. `PROCEDURE.md` 4.2. |
| `--status-complete` moving from green to teal | P1 | A state distinction the sidebar dots, table chips and attention list all read. Green stays running. |
| Any new z-index rung | P4, P7, P10, P11 | The authored ladder and where the new layer sits in it, per risk R6. Nothing above 10004. |
| A terminal font other than `--font-code` | P5 | Only if OQ-2 is answered against the default. |
| Dropping figurative illustration entirely | P12 | Only if OQ-3 is answered against the default. Costs a measurable amount against the three-second test. |
| The shadowed `POST /api/sessions/:id/summarize` handler at `server.js:2800` | P9 | The dead second registration is recorded rather than deleted, per code preservation and OQ-5. |
