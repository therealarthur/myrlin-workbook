# Mobile Terminal: why the output frayed, and what now holds it together

| Field | Value |
|---|---|
| Status | Diagnosis measured. Fix specified and implemented on `fix/mobile-terminal`. |
| Date | 2026-08-19 |
| Reported symptom | "The text output from the terminal gets broken up and is scattered and frayed here and there and hard to read. Badly formatted." |
| Scope | The phone's view of a live PTY: what geometry it renders at, who owns that geometry, and what the unified scrollback surface does with the same text. |
| Harness | `test/browser/mobile-terminal.spec.js`, run with `npm run test:mobile-terminal` |
| Pictures | `screenshots/mobile-terminal/before/`, `screenshots/mobile-terminal/after/`, `screenshots/mobile-terminal/sheet.png` |
| Composes with | `TERMINAL-ARCHITECTURE.md` (the terminal model), `MOBILE-EXPERIENCE.md` B.9 and C.6 (the shared-width contract), `DO-NOT-BREAK.md` (protected ids and classes) |

---

## 0. The one-sentence finding

A phone attached to a shared PTY renders the owner's screen on **its own grid instead of the
PTY's**, so a frame that an agent CLI painted for 155 columns and 40 rows arrives at a 49 by 28
terminal, every row wraps, every absolute cursor move after the first wrap lands on a row it was
not aimed at, and two thirds of the frame falls off the top: measured 0 of 30 frame rows intact,
20 fragment rows, 10 rows scattered onto the wrong row, and 2.9 percent of the desktop's screen
reproduced.

---

## 1. Reproduction, and why it is deterministic

The harness boots a sandboxed Workbook on an ephemeral port and attaches **two clients to one
live pane**: a desktop context at 1440x900 and a phone context at 390x844 with `isMobile` and
`hasTouch` (both asserted, because `terminal.js` gates every phone path on a coarse primary
pointer plus real touch points, and an emulation that fails either one would measure a desktop).

The pane runs `test/browser/fake-agent-cli.js`, the faithful alternate-buffer fixture: it enters
`?1049h`, enables mouse tracking and bracketed paste, enables DEC 1004 focus reporting, and then
repaints **by absolute cursor addressing only**, exactly as ten live Claude Code sessions were
measured doing in `TERMINAL-ARCHITECTURE.md` section 2. Two properties were added for this work,
both to increase fidelity rather than to make a point:

1. It **clips every row it paints to the PTY's current width**, as a real TUI does. Without this
   the fixture would manufacture wrapping the real application never produces, and the harness
   would be measuring its own fixture.
2. It **repaints the whole frame on SIGWINCH** (`2J` plus a full absolute repaint), which is the
   measured real behaviour and is what makes the difference between "the client was told" and
   "the client was not told" observable.

The fixture is driven with 30 conversation turns, so its frame is 34 rows tall: taller than the
phone holds and shorter than the desktop holds. One PTY geometry therefore cannot satisfy both by
accident.

The scenario is driven exactly as it happens to a person:

1. The desktop opens the session and owns it. PTY 155x40.
2. The phone opens the same session with every default in place. Nobody turns on an escape hatch
   before looking at their phone.
3. The desktop is **typed on**, which is what a person at a laptop does. The width returns to it.
4. From that moment the phone is a non-owner watching a frame built for a width it does not have.

Step 4 is the reported screen. `screenshots/mobile-terminal/before/1-desktop-owns.png` is it.

### 1.1 One pass against the real CLI, so the fixture is not proving itself to itself

The fixture gained two behaviours for this work, and a fixture that is trusted on its own word is a
fixture that measures its author's assumptions. So `claude 2.1.235` was spawned once on a real PTY
in a throwaway directory, at 155x40, left alone for fourteen seconds, resized to 63x39, watched for
eight more, and ended with two interrupts. No prompt was sent and no key that could answer a dialog
was sent; the run only read what the CLI painted.

| Property | Startup at 155x40 | After the resize to 63x39 |
|---|---|---|
| Enters the alternate buffer (`?1049h`) | yes | already there |
| Bracketed paste (`?2004h`) | on | already on |
| **Focus reporting (`?1004h`)** | **on** | already on |
| Mouse tracking (`?1000h` to `?1003h`) | on | re-asserted |
| Absolute cursor moves | 11 | 2 |
| Full-screen clears (`2J`) | 2 | **1** |
| Erase-to-end-of-line | 42 | 55 |
| **Scroll sequences and scroll regions** | **0 and 0** | **0 and 0** |

Three things this settles.

1. **D2 is a production defect, not a fixture artefact.** The real CLI turns DEC 1004 focus
   reporting on. Every attached client therefore emits `\x1b[I` and `\x1b[O` on every focus change,
   in both directions, against every real session. The measured width theft was not something the
   fixture invented.
2. **The alternate-buffer, absolute-addressing, never-scrolls model holds**, three years of
   releases after TERMINAL-ARCHITECTURE.md measured it. Zero scroll sequences and zero scroll
   regions in both phases.
3. **The CLI repaints its whole frame when it is told the size changed**, which is the property the
   fixture now reproduces and the property the fix depends on. A client that is never told is never
   repainted for, which is exactly why rendering at the published geometry, rather than hoping for
   a repaint that is not coming, is the shape of the answer.

One measurement was attempted and is reported as inconclusive rather than quietly dropped: whether
every painted row fits the width it was told about. The probe split the byte stream on absolute
cursor moves, carriage returns and line feeds, and the longest resulting run was 954 characters at
155 columns, which means the CLI moves between rows with sequences the split does not recognise
(cursor up and down rather than absolute positioning, most likely). The number therefore measures
the probe, not the CLI, and no conclusion is drawn from it.

---

## 2. The ranked defects, with the measurement that proves each

### D1. A non-owning client renders the owner's frame on its own grid

**Severity: this is the reported symptom.**

Measured, phone against a desktop-owned PTY:

| Measure | Desktop (owner) | Phone (non-owner) |
|---|---|---|
| xterm grid | 155x40 | 49x28 |
| PTY grid | 155x40 | 155x40 |
| Frame rows intact on one line | 30 of 30 | **0 of 30** |
| Frame rows present at all | 30 of 30 | **10 of 30** |
| Rows painted onto a row the CLI did not address | 0 | **10** |
| Fragment rows (truncated head, orphan tail) | 0 | **20** |
| Rows shared with the owner's screen | 100% | **2.9%** |

The literal shape of the fragments, straight out of the phone's xterm buffer:

```
LIVE-SCREEN-ROW-21: the frame the CLI is painting
 right now
LIVE-SCREEN-ROW-22: the frame the CLI is painting
 right now
```

Plus a stranded `status: working, tick 13` at the bottom of the pane, below the frame's own
status row, left there because the CLI addresses its status line at absolute row 34 and a 28 row
terminal clamps that onto the last row. That leftover is the "frayed" half of the report.

**Root cause.** `TerminalPane.safeFit()` always calls `fitAddon.fit()`, which sets `term.cols` and
`term.rows` from the client's own container. Nothing in the protocol ever told the client what the
PTY holds: the server's only geometry-bearing control frame was `mode`, which carries buffer and
mouse state and no size. A client that cannot know the PTY's geometry cannot render at it.

**Second-order consequence.** `syncPaneWidthNotice` in `app.js`, the affordance that was supposed
to explain exactly this state, compares `pane.fitAddon.proposeDimensions().cols` against
`pane.term.cols`. On a client that always fits itself those are the same number by construction,
so the comparison could never fire. Measured: `widthNoticeShowing: false` in every situation,
including the one it was written for. The feature existed and had never once run.

### D2. A terminal-generated focus report steals the shared geometry

**Severity: this is what puts a phone into D1's state, and it also shrinks the desktop.**

Measured: the phone opens the session, no key is pressed, no affordance is tapped, and the PTY
goes from **155x40 to 49x28**. The phone sent exactly one input frame in that window, and its
payload was `\x1b[O`: the DEC 1004 **focus-out report**, generated by the terminal emulator, not
by a person.

**Root cause.** `pty-manager.js` treats every `{type:'input'}` frame as a deliberate claim
(`claimSizeOwnership('input')`). At that layer a keystroke and a terminal reply are the same
thing. The fixture enables `?1004h` because the real CLI does, so focus reports flow on every
focus change on every attached client, in both directions. That is also the engine of the width
ping-pong: the desktop's own focus report claims it straight back.

The per-session "Follow this device" escape hatch does not help, because it gates `activate` and
the app-layer claim paths, and this claim arrives on the `input` path.

### D3. The unified scrollback surface renders terminal text in a proportional font

**Severity: independent of ownership, and it makes the history unreadable on any device.**

Measured, on the phone with the history layer open:

```
history document font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI ...
history document font-size:   14px
```

**Root cause.** `TerminalHistory.applyMetrics` reads the resolved face off `.xterm-screen`. xterm 6's
DOM renderer injects its font rule onto **`.xterm-rows`**, not `.xterm-screen`, so the read returns
the value `.xterm-screen` inherits from the application shell, which is the proportional UI face at
14px. `.terminal-history-doc` then has no stylesheet fallback of its own and `.terminal-history-seg`
is `font: inherit`, so the whole surface, live snapshot and transcript alike, renders monospaced
terminal output in a proportional face with `pre-wrap`. Columns do not line up, box drawing
collapses, and every long line wraps at a different place than it did in the terminal.

### D4. A phone at the shipped font size gets 49 columns, and nothing lets the user change that

Measured ladder, real xterm cell metrics in a 390px viewport at device pixel ratio 2:

| Font size | Columns | Rows | Cell advance |
|---|---|---|---|
| 14px | 45 | 26 | 8.20px |
| **13px (shipped)** | **49** | **28** | **7.61px** |
| 12px | 53 | 30 | 7.04px |
| 11px | 57 | 32 | 6.45px |
| **10px** | **63** | **39** | **5.86px** |
| 9px | 71 | 42 | 5.27px |
| 8px | 79 | 48 | 4.69px |

49 columns is below what an agent CLI's own frame is designed for, and there was no user control
anywhere: no font size in the pane sheet, none in the key toolbar, none in settings.

### D5. The sidecar snapshot replays the owner's screen into a client with different geometry

Measured: a cold phone attach to a desktop-owned pane produces the identical damage to D1 (0 of 30
intact, 20 fragments, 10 scattered, 2.9% fidelity). This is not a separate bug so much as D1
arriving through the replay path instead of the live path. `applyViewport` already keeps the VT
shadow's grid identical to the PTY's, so the snapshot is correct **for the PTY**; the client then
re-wraps it. Worth stating separately because it is the state a phone wakes up into, before any
live output arrives to be blamed.

### D6. Rows are lost, not merely wrapped

Measured: 10 of 30 frame rows present at all. Wrapping consumes rows, the frame is taller than the
phone's grid to begin with, and the top of the frame scrolls out of the alternate buffer, which by
definition has nowhere to keep it. Fixing the width alone would not have recovered these; the row
count has to match too.

### D7. Client and PTY geometry disagree for whole seconds, not milliseconds

Measured with a continuous sampler on both sides (80ms in the page, 120ms against `/api/pty`):
in the reported scenario the phone rendered at a geometry the PTY did not hold for **1665ms** of a
single situation, and in the cold-attach scenario for **1470ms**. Every repaint that arrives during
that window lands in the wrong place. Under the pre-fix model that window is unbounded: it only
ends when somebody claims.

The same sampler cleared two suspicions that turned out to be innocent, and they are recorded
because a fix aimed at them would have been wasted work:

- **A hidden pane is not fitted to a degenerate grid.** Switching the phone to another tab and back
  leaves the grid at 49x28 throughout. `safeFit`'s zero-rect guard does its job.
- **The keyboard does not produce a resize storm.** One emulated iOS keyboard raise produced one
  resize frame, and the client and the PTY agreed within 21ms. `MyrlinMobileViewport`'s settle
  window and the claim-suppression window already hold.

---

## 3. The model after the fix

One sentence: **the PTY's geometry is published, and a client that does not own it renders at it.**

### 3.1 The `size` control frame (server)

`pty-manager.js` sends every attached client a per-client frame:

```json
{ "type": "size", "cols": 155, "rows": 40, "owned": false, "seq": 7 }
```

`owned` is per client, so the frame is sent individually rather than broadcast. It goes out:

- on attach, immediately after the `mode` frame,
- whenever `applyViewport` actually applies a change,
- whenever ownership commits, even when the geometry did not change, because `owned` flipped for
  two clients and both need to know.

Carries a monotonic `seq` so an out-of-order frame cannot move a client backwards, the same
convention the `mode` frame already uses. A client that ignores the type keeps working exactly as
before, which is what makes this safe in a mixed-version window.

### 3.2 Follower rendering (client)

On a `size` frame with `owned: false` the pane enters **follower mode**:

- `term.resize(serverCols, serverRows)`. The client renders the owner's grid, so the frame is
  reproduced rather than re-wrapped, and every absolute cursor move lands where it was aimed.
- `fitAddon.fit()` is not called while following. The client still sends `{type:'resize'}` with its
  **own** proposed dimensions, so `ws._viewport` stays correct and a later handoff restores the
  phone's real geometry rather than the owner's.
- The pane body becomes a pannable viewport: `overflow: auto` with `touch-action: pan-x pan-y`, so a
  grid wider than the screen is read by panning instead of being destroyed by wrapping.
- The font size is auto-fitted **down** the ladder so the owner's grid fits the phone where it can,
  floored at 8px. This is a transient render decision and never touches the user's stored
  preference.

On `owned: true` the pane leaves follower mode: the stored preference is restored, `fitAddon.fit()`
runs, and the resize goes out.

### 3.3 Typed input and terminal replies are told apart (server)

`isUserOriginatedInput(data)` returns false for a frame that contains **only** terminal-generated
reports: focus in and out (`\x1b[I`, `\x1b[O`), SGR and legacy mouse reports, and the cursor
position, device attributes and device status replies. Such a frame is still written to the PTY
byte for byte; it simply does not claim the geometry. Anything containing one other byte claims, so
a real keystroke always claims. The direction of the conservatism is deliberate: failing to claim on
a genuine keystroke would be a worse bug than claiming on an exotic reply.

### 3.4 The take-over affordance

`syncPaneWidthNotice` now compares the **server's** column count against this client's own fit, which
is a comparison that can actually differ. The wording says what is happening and what to do:
"Another device is setting the width. Tap to take over." It is a single quiet bar above the key
toolbar with a dismiss control. No status pill, no dot indicator, in line with the standing rule.

### 3.5 The font size control

`A-` and `A+` in the phone key toolbar, 44px touch targets, stepping the ladder
`8, 9, 10, 11, 12, 13, 14, 16` and persisted in `localStorage` under `mw_term_font_px`. Changing the
size recomputes columns and rows and resizes the PTY **only when this client owns the geometry**;
in follower mode it changes how much of the owner's grid fits on screen and nothing else.

**The phone's default is chosen by measurement, not taste.** A first-run phone takes the largest
ladder size whose measured cell advance yields at least 60 columns in the pane, with a floor of
9px. On the reference device that is **10px, a 5.86 CSS pixel advance, 63 columns**, which at a
device pixel ratio of 2 is 11.7 device pixels per glyph and at 3 is 17.6. An explicit A- or A+
press pins the choice and the automatic selection never runs again.

### 3.6 The history surface reads its face from where xterm writes it

`applyMetrics` reads `.xterm-rows` first and falls back to `.xterm-screen`, and
`.terminal-history-doc` carries a monospace fallback in the stylesheet so a failed read can never
land on a proportional face again.

---

## 4. Before and after

Numbers from the same harness, the same fixture and the same two devices. The picture is
`screenshots/mobile-terminal/sheet.png`.

| Measure | Before | After |
|---|---|---|
| Phone grid against the PTY, non-owner | 49x28 against 155x40 | 155x40 against 155x40 |
| Frame rows whole on one line, non-owner | 0 of 30 | **30 of 30** |
| Fragment rows, non-owner | 20 | **0** |
| Rows painted where nothing addressed them | 10 | **0** |
| Share of the owner's screen reproduced | 2.9% | **100%** |
| Cold attach through the sidecar snapshot | 2.9%, 20 fragments | **100%, 0 fragments** |
| PTY after a phone merely opens the session | 155x40 becomes 49x28 | **unchanged at 155x40** |
| Take-over affordance shown to a non-owner | never, in any situation | **yes** |
| Phone-owned columns at the default size | 49 | **63** |
| Rendered glyph advance at that size | 7.61 CSS px | **5.86 CSS px** |
| Geometry divergence, reported scenario | 1665ms | 846ms, all of it the phone's own attach |
| Geometry divergence, cold attach | 1470ms | 280ms |
| Live screen after a phone tab switch | 27 fragments | **0** |
| Live screen after a keyboard animation | 11 fragments | **0** |
| History surface typography | proportional UI face at 14px | terminal's own mono at 13px |

Every expectation in the harness now holds; before the fix, fourteen did not. The remaining
divergence is a client attaching and learning the geometry, which is bounded by one round trip
rather than by somebody eventually claiming, and nothing renders during it.

The full record of both runs, including row samples, fragment samples, the font ladder and the
geometry timeline, is in `screenshots/mobile-terminal/<label>/manifest.json`.

### 4.1 One test was passing because it was asking the wrong element

`test/browser/terminal-history-e2e.test.js` asserts that the history surface is "metrically
indistinguishable from the terminal", and it read `.xterm-screen` for both halves of the
comparison. Since that element carries the shell's inherited face rather than the terminal's, the
check compared the layer against the shell and passed while both were wrong. It now reads
`.xterm-rows`, which is where xterm writes its type, and additionally asserts the resolved stack is
monospaced. This is worth recording because it is the reason D3 survived a suite that had a test
for it.

---

## 5. Running the harness

```
npm run test:mobile-terminal                                     # assert and capture into after/
node test/browser/mobile-terminal.spec.js --label before --no-assert
node test/browser/mobile-terminal.spec.js --out <directory>
node scripts/build-mobile-terminal-sheet.js                      # the side by side sheet
```

`--no-assert` records every expectation that did not hold and still exits 0, which is what the
before pass needs: the point of that pass is to photograph all seven situations, not to stop at the
first one that is broken.

The pure parts of the contract also run on every `npm test`, in
`test/mobile-terminal-geometry.test.js`: the input classifier, the `size` frame's shape, the type
ladder arithmetic, and the source-level rules that the fit path defers to the published grid, that
a follower reports its own viewport, that ambient claims stand down against a live owner while an
explicit take-over never does, and that the stylesheet and the markup carry their halves.

Safety, unchanged from the other harnesses in `test/browser/`: an ephemeral port and never 3456, a
disposable sandbox that owns `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and every `CWM_*` path
and is validated before deletion, `CWM_CRED_EXTERNAL_BRIDGE_OWNER=1` with `proactiveRefreshMinutes`
at 0 so nothing can refresh or rotate a credential mid-run, every non-loopback request blocked at
the browser, every owned child stopped by its own pid in a finally block with no blanket kill
anywhere, and every captured PNG asserted at 2000px or less on both axes before it can reach a
model context. The phone captures at device pixel ratio 2 rather than 3 for that last reason: 390x844
at 3x is 1170x2532, and 2532 is over the guard, so a 3x capture could never be looked at.

---

## 6. What was deliberately not done

- **No renderer swap.** `MOBILE-EXPERIENCE.md` E.2 argues for keeping xterm's DOM renderer on
  phones and the measurements here support it: the cost driver was geometry, not per-cell painting.
- **No pinch-zoom gesture handler.** The pannable follower viewport plus a real font-size control
  covers the same need with real glyph rendering rather than a scaled bitmap, which is sharper on a
  2x or 3x screen. A transform-based zoom would also have needed a sizing wrapper inside
  `.terminal-container`, which is protected structure.
- **No change to the ownership debounce.** The contention control in `pty-manager.js` was measured
  behaving correctly; the problem was what counted as a claim, not how claims were coalesced.
- **No attempt to recover the rows that scrolled out of the alternate buffer.** There is nothing to
  recover: the buffer never scrolled, so no terminal-layer history exists. That is what the unified
  scrollback surface and the transcript are for, and they are unchanged here apart from D3.

## 7. Two tradeoffs the orchestrator should know about

**A follower pane is a viewer, not a selectable terminal.** While a pane is rendering somebody
else's grid, xterm's own viewport is neutralised so the pane body can be the single scroller on
both axes, and the phone's long-press selection engine stands aside so the platform's panning is
what a finger gets. Selecting text on a followed pane therefore goes through the unified scrollback
surface or the Copy view, which are DOM text and readable at any width, or through one tap on the
take-over affordance, after which the pane is an ordinary terminal this device drives. This is
MOBILE-EXPERIENCE B.9 rule 6's escape hatch used as designed. It is called out because it is a
capability that moves rather than one that grows.

**Ambient claims now stand down against a live owner on every device, not only on phones.** Two
desktops attached to one session behave the way a phone and a desktop do: the second one follows
and offers to take over rather than silently resizing the first. That is a behaviour change beyond
the reported bug, and it is the right one, but it is a change. Typing, tapping the affordance, and
the per-session "Follow this device" switch all still claim exactly as before, so no route to the
width was removed.
