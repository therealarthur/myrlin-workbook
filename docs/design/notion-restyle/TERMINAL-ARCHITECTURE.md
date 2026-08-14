# Terminal Architecture: True Terminal Fidelity in the Notion Redesign

| Field | Value |
|---|---|
| Status | Decision ready. Awaiting orchestrator approval before any code lands. |
| Date | 2026-08-13 |
| Scope | The terminal region of Myrlin Workbook: xterm.js panes over node-pty / ConPTY WebSockets, their scrollback, selection, and clipboard behaviour. |
| Branch context | `feat/notion-restyle`, repo `C:/Users/Arthur/Desktop/cwm-restyle` |
| Primary sources read | `C:/Users/Arthur/Desktop/cwm-restyle/src/web/public/terminal.js`, `C:/Users/Arthur/Desktop/cwm-restyle/src/web/pty-manager.js`, `C:/Users/Arthur/Desktop/cwm-restyle/src/web/mirror-service.js`, `C:/Users/Arthur/Desktop/cwm-restyle/src/web/jsonl-tailer.js`, `C:/Users/Arthur/Desktop/cwm-restyle/src/web/public/app.js`, `C:/Users/Arthur/Desktop/cwm-restyle/src/web/public/theme-registry.js`, `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/Myrlin Workbook (Notion Redesign) v2.dc.html`, `C:/Users/Arthur/Desktop/cwm-restyle/docs/design/notion-import/Feature Inventory.md` |
| Deliverable constraint | This document is the only file written. Everything else was read only. |

---

## 0. Executive decision

Adopt **Architecture D+**, a hybrid named the **Unified Scrollback Surface (USS)**, backed by a **server side headless VT sidecar**.

Three claims drive it, and the first one is a measured negative result rather than an opinion:

1. **For an alternate screen agent CLI there is no terminal layer history to recover.** Measured on this machine against five live Claude Code PTY sessions: the CLI enters the alternate buffer, then repaints by absolute cursor addressing only. It emits zero scroll sequences, zero scroll regions, and never scrolls its viewport. A terminal cannot capture scrollback from a viewport that never scrolls. This forecloses Architecture A and the history half of Architecture B on correctness grounds, not on cost grounds.
2. **For a normal buffer session the native path already satisfies the mandate**, and is currently degraded only by a shallow client ring, a shallow server ring, and a couple of guard layers that were written for the alternate screen case. Fixing those is cheap.
3. **The only ground truth for agent conversation history is the session transcript**, which Workbook already reads through a hardened, read only mirror API. Architecture C is therefore not a fallback, it is the source of record. Its problem today is packaging, not data: it lives behind an overlay the user must know to open. The fix is to reach it by scroll position instead of by a button.

USS keeps the live xterm exactly as it is, and adds a history surface that is reached by scrolling past the top of the live screen. The history surface is visually indistinguishable from the live surface, is ordinary selectable DOM, and is routed to the correct history source by the live buffer mode. Selection holds are enforced by pausing the DOM mirror rather than by freezing the PTY write pipeline, which removes the "select freeze" awkwardness the user is complaining about.

The server side VT sidecar is recommended for what it is genuinely good at, which is **state fidelity, not history**: exact screen replay on reconnect, deep normal buffer line history, and an authoritative buffer mode signal shared by every attached client.

---

## 1. The mandate and the acceptance bar

The user's words, restated as requirements:

> Evaluate how best to implement a true terminal in this design where it functions exactly as the native terminal it connects to on the machine. Copy and paste must be thought through: we still have issues copying the entire terminal window; select freeze plus copy works but you cannot drag up and copy history. That all needs to be clean and worked out.

### 1.1 Acceptance tests

These are the tests the finished system must pass. They are written so a human can run them in five minutes, and so stages 1 to 5 in section 14 can each be scored against them.

| ID | Test | Session type |
|---|---|---|
| A1 | Wheel up moves through history. Wheel down returns to live and pins to the bottom. | both |
| A2 | Drag select across content that is above the visible screen, including content only reachable by scrolling, and copy it. | both |
| A3 | Drag to the top edge of the pane while selecting and the view auto scrolls, extending the selection. | both |
| A4 | Ctrl+C with a selection copies and does not send SIGINT. Ctrl+C with no selection sends SIGINT. | both |
| A5 | Right click offers Copy when there is a selection, and Paste always. | both |
| A6 | Select the entire pane content, including history, with one action. | both |
| A7 | Paste multi line text into a shell. Nothing executes until the user presses Enter, or the user is warned first. | normal buffer |
| A8 | Paste into an agent CLI. The text arrives as one block, bracketed, with no stray control text. | alternate buffer |
| A9 | Output keeps streaming while the user reads history. Returning to live shows current state with no tear. | both |
| A10 | Reconnect or refresh restores the pane to the exact screen it had, with no partial frame. | both |
| A11 | None of the above requires learning a mode, reading a strip, or pressing a toggle first. | both |

### 1.2 One honesty constraint on "exactly as the native terminal"

Windows Terminal and iTerm2 running the same Claude Code CLI **also cannot scroll back through the conversation**. When an application owns the alternate buffer and enables mouse tracking, the host terminal has no scrollback for that region and forwards the wheel to the application. That is not a Workbook defect, it is how the alternate buffer is defined.

So "exactly as the native terminal" is a floor, not a ceiling, and Workbook can beat it because it has something Windows Terminal does not: the session transcript on disk. The design below meets native behaviour exactly where native behaviour is good (normal buffer, Shift plus wheel, Shift plus PageUp, drag select, Ctrl+C), and exceeds it where native behaviour is simply absent (conversation history under an alternate screen app).

---

## 2. Ground truth, measured rather than assumed

### 2.1 Why this section exists

The brief pointed at a forensic report at
`C:/Users/Arthur/AppData/Local/Temp/claude/C--Users-Arthur-Desktop-claude-workspace-manager/4ece62ba-44db-49a2-8af5-4c44f85a1514/scratchpad/tui-diagnosis/report.md`.
That path does not exist in this session; the scratchpad for this session id contains other artifacts but no `tui-diagnosis` directory, and a search of the whole `claude` temp tree found no `report.md` and no decode files.

Rather than build an architecture on a summary I could not verify, I re-derived the facts independently against **live PTY sessions running on this machine right now**, through the existing read only API (`GET /api/pty`, `GET /api/sessions/:id/scrollback`). Every claim below is reproducible with the recipe in Appendix A.

The good news: every claim in the brief's summary was confirmed, and the measurement additionally produced one fact the summary did not contain, which turns out to be the decisive one.

### 2.2 Measured escape sequence usage, ten live sessions

| Session (prefix) | Alt buffer | Chars sampled | 2J | Mouse 1000 / 1002 / 1003 / SGR 1006 | Bracketed paste 2004 | Focus 1004 | Sync output 2026 | OSC 52 | Absolute cursor moves | Erase line K |
|---|---|---|---|---|---|---|---|---|---|---|
| `95ba1aab` | yes | 2596 | 2 | yes | yes | yes | **no** | **no** | 17 | 33 |
| `667fef24` | yes | 2572 | 2 | yes | yes | yes | **no** | **no** | 25 | 33 |
| `890ff08c` | yes | 3345 | 2 | yes | yes | yes | **no** | **no** | 31 | 33 |
| `b01f8a3f` | yes | 2860 | 2 | yes (x9) | yes | yes | **no** | **no** | 23 | 29 |
| `proj-mpc` | yes | 1595 | 2 | yes (x3) | yes | yes | **no** | **no** | 12 | 30 |
| `397d46b7` | pre alt | 969 | 1 | no | yes | yes | **no** | **no** | 10 | 0 |
| `proj-ms3` | pre alt | 972 | 1 | no | yes | yes | **no** | **no** | 10 | 0 |
| `ad46c629` | pre alt | 972 | 1 | no | yes | yes | **no** | **no** | 10 | 0 |
| `0dec6592` | ring wrapped | 101848 | 0 | pruned | pruned | pruned | **no** | **no** | 2221 | 0 |
| `b22e13aa` | exited | 269 | 1 | no | yes | yes | **no** | **no** | 0 | 0 |

Confirmations of the brief's summary: alternate buffer, mouse tracking 1000 plus 1002 plus 1003 with SGR 1006 encoding, no synchronized output (DEC 2026), no OSC 52 clipboard.

### 2.3 The decisive negative result

Across **all ten sessions**, including the 100 KB sample from the long running one:

| Signal | Meaning | Count observed |
|---|---|---|
| `ESC D` (IND), `ESC M` (RI) | explicit index / reverse index | **0** |
| `CSI n S` / `CSI n T` | scroll up / scroll down | **0** |
| `CSI n L` / `CSI n M` | insert line / delete line | **0** |
| `CSI t ; b r` (DECSTBM) | set scrolling region | **0** |
| Max absolute cursor row targeted | vs. viewport height | 27 to 31, always inside the viewport |

**The alternate viewport never scrolls.** The CLI clears the screen once on entry, walks down the rows with `CSI K` plus CRLF to blank them, and from then on repaints by absolute addressing: `CSI 13;1H`, write a glyph, `CSI 42C`, write a token count, `CSI 22;3H` to park the cursor, all wrapped in `CSI ?25l` / `CSI ?25h` to hide the cursor during the patch.

The 100 KB sample from session `0dec6592` is 2221 absolute cursor moves and 450 title updates with **zero** scroll sequences. That is a spinner and a token counter being rewritten in place, thousands of times, in the same cells.

Two consequences follow immediately, and they are the load bearing conclusions of this document:

> **C1. There are no scroll off events, so there is nothing for a shadow scrollback to capture.**
> A client side or server side terminal model can perfectly reproduce the grid, and the grid still contains no history, because history was never expressed as terminal state. It exists only inside the application's own memory and in the transcript it writes to disk.

> **C2. Frame diffing cannot recover it either.**
> The repaint is not a clean full frame replacement that could be aligned against its predecessor. It is a surgical in place patch, and the content it patches is a **streaming assistant message that grows token by token in the same cells**. A line level diff would emit the same logical line once per token, producing hundreds of near duplicate history lines. Any dedupe heuristic aggressive enough to suppress that would also suppress genuinely repeated output such as a repeated log line or a repeated prompt. There is no correct setting of that dial.

### 2.4 The startup sequence, annotated

Captured verbatim from session `95ba1aab`:

```
CSI ?9001h        win32 input mode (ConPTY)
CSI ?1004h        focus reporting on
CSI ?25l          hide cursor
CSI 2J  CSI m  CSI H     clear the NORMAL buffer, home the cursor
OSC 0;claude BEL         window title
CSI ?25h
CSI ?2004h        bracketed paste ON
CSI ?1004h        focus reporting (again)
CSI ?2031h        colour scheme change notification
CSI >0q           XTVERSION query
CSI ?1049h        ENTER ALTERNATE BUFFER
CSI 2J            clear it
CSI ?1000h CSI ?1002h CSI ?1003h CSI ?1006h    mouse tracking, any event, SGR
(CSI K CRLF) x31  blank each row of the viewport
OSC 0;<session title> BEL
CSI 3;1H > /login ...   absolute addressed repaint begins
```

Note the line `CSI 2J CSI m CSI H` **before** the alternate buffer is entered. The CLI wipes the normal buffer on startup. Combined with the fact that Workbook spawns agent panes through a bare `cmd.exe /c claude`, this means:

> **C3. For a Workbook spawned agent pane, the normal buffer is empty.**
> The existing Copy view "Terminal" source composes normal buffer plus divider plus current alternate frame (`_composeCopyViewText` in `terminal.js`). Its own guard already handles the empty case by dropping the divider, which means for the common agent pane that source yields **the current screen and nothing else**. This is precisely the user's complaint, now with a mechanical explanation.

### 2.5 What is different about normal buffer sessions

Sessions `397d46b7`, `proj-ms3`, `ad46c629` had not yet entered the alternate buffer when sampled (they were sitting on the CLI's trust prompt). Plain shells, and any line oriented CLI, stay in the normal buffer permanently. For those:

- `CSI K` count is 0, absolute cursor moves are few, output is append oriented.
- xterm's own scrollback is populated, byte exact, colour exact, and reflow aware.
- Native drag select, drag at edge auto scroll, and Ctrl+C already work with no Workbook machinery at all.

**The hybrid split is therefore real and it is detectable at runtime**, via `term.buffer.active.type` on the client and via the VT sidecar on the server.

### 2.6 A note on the Codex CLI

The brief asked whether the Codex CLI is line oriented. No live Codex PTY session was running during this measurement, so this is **unverified** and is listed as verification gate VG-3 in section 15. The architecture does not depend on the answer: the routing rule is buffer mode at runtime, not provider identity. If Codex is normal buffer, it gets the native path for free. If it is alternate buffer, it gets the transcript path, and `src/web/mirror-service.js` already supports it through the provider registry (`test/codex-mirror-parse.test.js` exists, so the parse side is already built).

---

## 3. Inventory of the current implementation

### 3.1 Client, `src/web/public/terminal.js` (5275 lines)

| Layer | Mechanism | Notes |
|---|---|---|
| Terminal | xterm 6.0.0, `scrollback: 5000`, `smoothScrollDuration` gated on reduced motion, `rightClickSelectsWord: false` | vendored at `src/web/public/vendor/xterm/xterm.min.js` |
| Write path | `_enqueueWrite` accumulates, `_flushWriteBuffer` writes once per animation frame when focused, once per 150 ms when not | good design, keep |
| Select mode v1 | capture phase mouse interceptor re dispatches a plain drag as a Shift forced clone, so xterm's `shouldForceSelection` returns true under mouse tracking | `_installSelectModeInterceptor` |
| Select mode v2 | freeze the write pipeline while the mode is on | superseded by v3, code retained |
| Select mode v3 | freeze only while a selection is being made or held (`_selectHold`), released by mouseup without selection, by `onSelectionChange`, by input, by resync, by overflow | `_engageSelectHold`, `_releaseSelectHold`, `_isWriteFrozen` |
| Report filter | `TERMINAL_REPORT_ONLY_RE` classifies focus reports, CPR, DA, and SGR / X10 mouse reports as machine generated so they do not cancel the mode | correct and hard won, keep verbatim |
| Wheel guard | capture phase, swallows the wheel while holding under the alternate buffer, translates to `scrollLines` on the normal buffer | see 4.6 |
| Copy view | overlay with two sources: Terminal snapshot, and Full transcript paged from `GET /api/mirror/history` | the right data, the wrong packaging |
| Clipboard | `TerminalPane.copyTextToClipboard` tries `execCommand('copy')` synchronously first to preserve the gesture, then `navigator.clipboard.writeText`; never throws, never rejects | excellent, reuse unchanged |
| Paste | three entry points: `beforeinput` with `insertFromPaste`, native `paste` on the helper textarea, and `pasteFromClipboard` for the menu | see defects D1 and D2 |
| Width claim | `activate()` claims PTY geometry on visibility, focus, pane click, tab restore | `ACTIVATE_*` constants |
| Mobile | separate touch engine driving `term.scrollLines`, long press for selection, scroll and type modes | keep |

### 3.2 Server, `src/web/pty-manager.js` (1338 lines)

| Property | Value | Consequence |
|---|---|---|
| Model | one PTY per session id, N WebSocket clients | shared geometry |
| Scrollback | `MAX_SCROLLBACK_CHARS = 100 * 1024`, an array of **raw byte chunks**, pruned from the front | see defect D3 |
| Attach | send `{type:'reset'}`, then `scrollback.join('')`, then join the broadcast set | replay is a byte log, not a state snapshot |
| Backpressure | over 64 KB buffered, mark lagged and withhold; on drain, reset plus full replay | correct in shape |
| Geometry | `sizeOwner` claimed by input or `activate`, `applyViewport` suppresses no op resizes | correct, ConPTY repaints on every applied resize |
| Resize bounds | 500 cols, 200 rows | fine |

### 3.3 Transcript path, `src/web/mirror-service.js` plus `src/web/jsonl-tailer.js`

| Property | Value |
|---|---|
| Keying | `providerId` + `':'` + `providerSessionId`, refcounted watchers |
| History window | `MIRROR_HISTORY_TAIL_BYTES` default 2 MB from EOF, paged backwards by `beforeOffset` |
| Live | `mirror:message` batches with contiguous offsets, `mirror:reset` on truncate, `mirror:status` liveness, `mirror:closed` |
| Limits | 10 concurrent watchers, 60 s idle close, 8 KB per message text cap |
| Safety | strictly read only, never touches the running session, provider agnostic and grep gated |

This is a mature, well bounded subsystem. USS should consume it, not reimplement it.

---

## 4. Defects found by inspection, with evidence

These are independent of the architecture choice. Several are cheap and should ship first regardless of what is decided about history.

### D1. Bracketed paste is applied unconditionally

`terminal.js` wraps every paste in `\x1b[200~ ... \x1b[201~` at three sites, with no check of whether the application asked for bracketed paste mode.

xterm's own implementation, read from `node_modules/@xterm/xterm/lib/xterm.js`, is:

```js
function s(e, t) { return t ? "\x1b[200~" + e + "\x1b[201~" : e }
// called as: s(i(e), r.decPrivateModes.bracketedPasteMode && n.rawOptions.ignoreBracketedPasteMode !== true)
```

Workbook bypasses that path with `e.preventDefault(); e.stopImmediatePropagation();` and does its own unconditional bracketing. Against an application that has not enabled DEC 2004 (a bare `cmd.exe`, `powershell.exe`, or any simple REPL), the brackets are delivered as literal garbage.

**Fix.** Gate on `term.modes.bracketedPasteMode`, which xterm 6 exposes publicly (`IModes` in `node_modules/@xterm/xterm/typings/xterm.d.ts`). Confirmed present on the agent CLI in the live measurement (`CSI ?2004h`), so the agent path is unaffected and only the broken shell path changes.

### D2. Newlines are not normalized on paste

xterm normalizes before sending:

```js
function i(e) { return e.replace(/\r?\n/g, "\r") }
```

Workbook's bypass sends clipboard text verbatim. Windows clipboard text uses CRLF, so a two line paste currently delivers `CR LF CR LF`, which a PTY line discipline reads as **two** Enters plus two stray line feeds. Combined with D1 this is why multi line paste behaviour is unpredictable today.

**Fix.** Normalize `\r?\n` to `\r` in one shared pure function used by all three paste entry points.

### D3. Reconnect replay can render a torn or blank screen

The server replays a raw byte ring, and the ring is pruned from the front. For a long lived agent pane the pruned prefix contains `CSI ?1049h` and the entire frame construction; what survives is tens of thousands of tiny in place patches. Session `0dec6592` measured exactly this state: 101848 characters, 2221 absolute cursor moves, and no alternate buffer entry left in the buffer.

Replaying that onto a freshly `reset()` terminal paints a handful of digits and a spinner glyph onto an otherwise blank screen. The pane looks broken until the CLI happens to repaint, which in practice is triggered by the width claim resize that follows attach. That is why the bug is intermittent rather than constant.

**Fix.** Replay a **state snapshot**, not a byte log. See section 7.3.

### D4. The Terminal copy source is empty above the current screen for agent panes

Established as C3 in section 2.4. Not a coding error, a consequence of the CLI clearing the normal buffer before entering the alternate buffer. It does mean the existing "Terminal" source cannot answer the user's request on its own, ever.

### D5. There is no select all

`Terminal.selectAll()` exists in xterm 6 (`xterm.d.ts` line 1191) and is not wired to anything. The Copy view has `_selectAllInCopyView` for its own overlay, but the live terminal has no equivalent. "Copying the entire terminal window" currently has no single action.

### D6. The selection hold freezes more than it needs to

Select mode v3 freezes the **write pipeline**, so PTY bytes queue in `_writeBuf` while a selection is held, with a 2 MB overflow valve that drops the user out of the mode. This is a sound answer to the constraint "xterm anchors selection to absolute buffer coordinates and a repaint invalidates it". It is a heavy answer, because it makes a user reading text also stop the terminal from updating, and it introduces the overflow failure mode.

Once history lives in a DOM surface, the constraint disappears: DOM text nodes are not repainted by PTY output, so a selection over them is stable by construction. The hold degrades from "pause the stream" to "pause the mirror refresh", which is invisible and unbounded.

### D7. Client scrollback depth is shallow and unbacked

`scrollback: 5000` on the client, 100 KB of raw bytes on the server. For a chatty shell the server ring holds well under a thousand lines. Once the client ring trims, the content is gone from both ends. There is no deep history for normal buffer sessions today.

---

## 5. The three meanings of "history"

Most of the confusion in this problem comes from one word covering three different things with three different owners.

| | H1 Terminal scrollback | H2 Application history | H3 Session transcript |
|---|---|---|---|
| Owner | the terminal emulator | the CLI process | the CLI process, on disk |
| Exists for | normal buffer output | alternate screen apps | agent CLIs only |
| Fidelity | byte exact, colour exact, reflow aware | exact, but unreachable from outside | semantic, no ANSI, tool payloads summarized |
| Reachable by | wheel, Shift plus PageUp, drag | the app's own keys, for example Ctrl+O | file read, already wired to `/api/mirror/*` |
| Present in Workbook today | client ring 5000 lines, server ring 100 KB | not at all | Copy view "Full transcript" source |
| Recoverable by a terminal model | yes, trivially | **no, measured** | not applicable |

The user's sentence "you cannot drag up and copy history" is about H2 when they are looking at an agent pane, and about H1 when they are looking at a shell. **One gesture must reach whichever one is behind the current pane.** That is the entire design problem, stated precisely.

---

## 6. Architecture evaluation

### 6.1 A. Client side shadow history terminal

A second xterm instance with a large scrollback, fed a normalized stream in which alternate screen enter and exit and full repaint frames are translated into append only lines.

**How it would have to work.** Filter `CSI ?1049h` so the shadow never enters the alternate buffer, optionally set `scrollOnEraseInDisplay: true` so `CSI 2J` pushes the erased screen into scrollback, and diff successive frames to extract newly revealed lines.

**Why it fails.** Measured facts C1 and C2. The stream contains no scroll offs to harvest, so the only remaining mechanism is frame diffing, and the frames are in place patches of a token by token streaming message. `scrollOnEraseInDisplay` would append one full screen per `CSI 2J`, and `CSI 2J` was observed only twice per session, so it captures almost nothing while the interesting mutation happens between the 2Js. Diffing at line granularity emits the same growing line hundreds of times.

Secondary costs, for completeness: a second xterm doubles per pane memory (roughly 12 bytes per cell in xterm's `Uint32Array` backed buffer lines, so 5000 lines at 200 columns is on the order of 12 MB per instance), and the shadow must be kept in sync across resize, reconnect, and width ownership changes.

**Verdict: reject.** Not viable at any implementation budget.

### 6.2 B. Server side line history extraction with a headless VT

A headless VT state machine on the server, which already sees every byte, maintaining the model and appending lines to a persistent log.

`@xterm/headless@6.0.0` exists on npm and matches the vendored `@xterm/xterm@6.0.0`, so the client and server would share one parser and one set of quirks. `@xterm/addon-serialize@0.14.0` is also available.

**Why the history half fails.** Identical to A. A perfect server side model of a viewport that never scrolls contains no history. Moving the model from the browser to Node changes the cost profile and nothing about the information content.

**Why the rest of it is valuable anyway.** A headless VT solves three real problems that have nothing to do with alternate screen history:

1. **Exact replay** (defect D3). Serialize the current screen plus the normal buffer scrollback and send that on attach, instead of a truncated byte log.
2. **Deep normal buffer history** (defect D7). On the normal buffer, scroll off is a real, correct, unambiguous commit event. Hook it and append committed lines to a bounded log. This is the append only capture that A and B cannot do for the alternate buffer and **can** do here.
3. **Authoritative mode signal.** The server knows the buffer type and the mouse tracking mode with no client sniffing, and can broadcast it so every attached client routes identically and instantly.

**Verdict: adopt as a subsystem, reject as the history answer for alternate screen sessions.**

### 6.3 C. Transcript native history

Promote the existing Copy view "Full transcript" source into a first class live scrollback surface, reachable by wheel up from the live screen and dismissed by wheel down.

**Strengths.** It is the only correct source for H2. Selection is native DOM, so drag up and copy everything works by construction. The data path already exists, is read only, is provider agnostic, is refcounted, is paged, and is tested (`test/mirror-service.test.js`, `test/mirror-routes.test.js`, `test/claude-mirror-parse.test.js`, `test/codex-mirror-parse.test.js`). The Notion redesign already renders the pane body as a scrolling `div` with `white-space: pre-wrap`, so the visual language accommodates it.

**Weaknesses, and how the design handles them.**

| Weakness | Handling |
|---|---|
| Not byte exact. No ANSI colour, tool payloads collapse to one line. | Acceptable for the stated goal, which is copying the conversation. The existing terminal snapshot stays reachable as an explicit fallback, which preserves the honest answer. |
| Misses non conversation terminal output: startup banner, `!bash` passthrough, `/login` results. | Documented. The terminal snapshot fallback covers it. |
| A pane with no upstream session id yet has no transcript. | Already handled by `_copyViewIdentity`, which returns null and shows a notice. USS shows the terminal snapshot instead of an error. |
| Only exists for providers with a mirror parser. | Routing falls back to the terminal snapshot when `getProvider(id).mirror` is absent. |

**Verdict: adopt as the history source for alternate screen sessions.**

### 6.4 D. Hybrid

Normal buffer sessions keep the pure native xterm path. Alternate buffer sessions get transcript history while the live screen stays exactly as it is.

**Verdict: adopt as the overall shape.** The one refinement required is that the routing key must be the **live buffer mode**, not the provider, because a single pane crosses the boundary: a shell pane where the user types `claude` moves from normal to alternate and back on exit.

### 6.5 E. Do nothing beyond native (baseline)

Raise the client scrollback, wire select all, fix the paste bugs, and accept that agent panes have no history.

Worth scoring because it is cheap and it fixes several real complaints. It fails A2 and A6 for agent panes, which is the user's primary complaint, so it is a stage, not a destination. It is in fact stage 1 of the recommended plan.

### 6.6 Scorecard

Scored 1 (poor) to 5 (excellent) against the criteria the brief specifies.

| Criterion | A shadow | B server VT (history) | B server VT (replay + normal log) | C transcript | **D+ USS** | E native only |
|---|---|---|---|---|---|---|
| Fidelity to native feel | 2 | 2 | 5 | 3 | **5** | 4 |
| Correctness under measured forensics | **1** | **1** | 5 | 5 | **5** | 5 |
| Copy and paste completeness | 2 | 2 | 3 | 4 | **5** | 2 |
| Robustness: reconnect, resize, multi client | 2 | 3 | 5 | 4 | **4** | 3 |
| Implementation cost and risk in this codebase | 2 | 2 | 3 | 4 | **3** | 5 |
| Interaction with Select mode v3 machinery | 2 | 4 | 5 | 4 | **4** | 5 |
| **Weighted verdict** | reject | reject | adopt as subsystem | adopt as source | **recommend** | adopt as stage 1 |

Note the pattern: the two columns that score 1 on correctness are the two that try to synthesize history from terminal state. That is the whole finding.

---

## 7. Recommended architecture: D+, the Unified Scrollback Surface

### 7.1 Components

```
                      ┌─────────────────────────── server ───────────────────────────┐
   PTY (node-pty)  ──▶│ PtySession.onData                                            │
                      │   ├─▶ broadcast to clients            (unchanged)            │
                      │   ├─▶ appendScrollback (byte ring)    (unchanged, kept)      │
                      │   └─▶ VtSidecar.write(bytes)          NEW                    │
                      │                                                              │
                      │  VtSidecar  (@xterm/headless + addon-serialize)               │
                      │   ├─ snapshot()      exact screen + normal scrollback        │
                      │   ├─ lineLog         normal buffer scroll offs, bounded ring │
                      │   └─ modeSignal      {altBuffer, mouseTracking, bracketed}   │
                      │                                                              │
                      │  MirrorService (existing, untouched)                         │
                      │   └─ /api/mirror/open | history | close   transcript pages   │
                      └──────────────────────────────────────────────────────────────┘
                                                │  WebSocket + REST
                      ┌─────────────────────── client pane ──────────────────────────┐
                      │  LIVE LAYER    xterm.js, unchanged, always the full pane rect │
                      │  HISTORY LAYER terminal-history.js, DOM, theme identical      │
                      │     source router keyed on modeSignal.altBuffer:              │
                      │        normal    → xterm scrollback, then server lineLog      │
                      │        alternate → transcript pages, then live screen tail    │
                      └──────────────────────────────────────────────────────────────┘
```

### 7.2 The routing rule

One predicate, evaluated live, with a client side fallback so the sidecar is optional:

```
historySource(pane) =
  if serverModeSignal.altBuffer ?? (term.buffer.active.type === 'alternate')
     then TRANSCRIPT   (fall back to TERMINAL_SNAPSHOT when no transcript identity)
     else NATIVE       (xterm scrollback, extended by the server line log)
```

The signal is re evaluated on `term.buffer.onBufferChange`, which xterm 6 exposes on `IBufferNamespace`. A pane that crosses the boundary re routes without any user action and without tearing down the surface.

### 7.3 The mirror freeze principle

This is the single most important behavioural change, and it is what dissolves the user's "select freeze" complaint.

Today: a selection hold freezes the **PTY write pipeline**. The terminal stops updating, bytes queue, and a 2 MB overflow drops the user out of Select mode with a notice.

Under USS: a selection lives on **DOM text nodes** in the history layer. PTY output cannot repaint a DOM text node. So the only thing that must pause during a drag is the periodic refresh of the **live screen tail** at the bottom of the history document. That refresh is a `textContent` swap on one element, on a rAF throttle. Pausing it costs nothing, has no queue, has no overflow, and is invisible.

Consequences:

- The PTY never stops. Requirement A9 is satisfied by construction.
- `SELECT_FREEZE_MAX_HOLD_CHARS` and `_overflowSelectFreeze` become unreachable in the USS path. The code stays (preservation rule), it simply stops being exercised for panes using the history surface.
- The elaborate report filter (`TERMINAL_REPORT_ONLY_RE`) is still needed for the **live** layer, because Select mode still governs plain drag selection over the live screen under mouse tracking. Keep it verbatim.

### 7.4 The history document, and the seam

The history layer renders one continuous document. It is composed, oldest first, of provenance tagged segments:

| Segment | Present when | Content | Selectable | Copied |
|---|---|---|---|---|
| `deep` | normal buffer, server sidecar enabled | server line log, paged backwards | yes | yes |
| `ring` | normal buffer | xterm's own scrollback lines above the viewport | yes | yes |
| `transcript` | alternate buffer, transcript identity resolvable | mirror messages, paged backwards by `beforeOffset` | yes | yes |
| `screen` | always | the current visible screen, refreshed on a rAF throttle, paused while a selection is held | yes | yes |

The seam between `transcript` and `screen` deserves a decision, because the newest transcript messages and the live frame describe the same conversation turn.

**Decision: overlap, do not attempt a join.** The transcript tailer is live, so its last message and the live frame will often restate the same turn. Attempting to compute the exact join point requires matching semantic text against a width wrapped, ANSI decorated frame, which is fragile and fails silently. An overlap of one turn is honest, visible, and harmless when copying. The `screen` segment is separated by a subtle rule line in the theme's `rule` colour with no label, so the boundary reads as structure rather than as a mode banner.

Rejected alternative: dropping transcript messages whose text appears in the frame. Rejected because a false positive silently deletes real conversation from the copy, which is a worse failure than a visible duplicate.

---

## 8. Interaction model, normative specification

This section is the contract. Every clause is testable.

### 8.1 Scroll boundaries

The pane has one logical scroll axis. Position `live` is the bottom.

| Situation | Wheel up | Wheel down |
|---|---|---|
| Live, normal buffer, `buffer.viewportY > 0` | xterm scrolls its own scrollback. **No Workbook code involved.** | xterm scrolls down. At the bottom, pin to live. |
| Live, normal buffer, `buffer.viewportY === 0` (xterm at its top) | open the history layer, positioned so the first revealed line is the line immediately above xterm's top line. Continuity is exact. | close the history layer at its bottom, hand back to xterm. |
| Live, alternate buffer, mouse tracking **off** | open the history layer immediately. | close at bottom. |
| Live, alternate buffer, mouse tracking **on** | forward to the application as today, so the CLI's own scrolling keeps working. See 8.2. | forward to the application. |
| History layer open | native DOM scroll. Page backwards automatically when within two viewports of the top. | native DOM scroll. Passing the bottom closes the layer and pins live. |

Opening and closing are **not** modal transitions. There is no toggle, no strip, and no announcement. The layer animates in over 160 ms with a translateY of one row height, honouring `prefers-reduced-motion` through the existing `TerminalPane.getSmoothScrollDuration` gate. Closing is symmetric.

### 8.2 The wheel under mouse tracking, and why Shift is not a mode

When an application enables mouse tracking, every mainstream terminal forwards the wheel to the application and reserves **Shift plus wheel** for its own scrollback. Windows Terminal, xterm, and iTerm2 all behave this way. So the native answer to "the app has the mouse, how do I reach scrollback" is Shift plus wheel, and Shift plus PageUp for the keyboard.

Therefore:

- **Guaranteed path.** `Shift` plus wheel up, and `Shift+PageUp`, always open the history layer, in every session type, whatever the mouse mode. This is native muscle memory, not a Workbook invention, and it satisfies "zero modes to learn" because a modifier is not a mode.
- **Convenience path, behind a flag.** Plain wheel up under mouse tracking is forwarded to the application as today. If no PTY output arrives within `WHEEL_EXHAUSTION_MS` (proposed 140 ms) after forwarding, the application's own history is exhausted, and the next wheel up notch opens the history layer instead. This gives plain wheel continuity with a one notch, sub 150 ms hesitation at the exhaustion boundary only.

  The convenience path is a heuristic that depends on application behaviour, so it ships behind `settings.terminalWheelEscalation` defaulting **on**, with an off switch. It must never be the only way to reach history.

### 8.3 Scrollbar affordance

The Notion language is quiet chrome, so the scrollbar must be quiet too.

- A 6 px overlay scrollbar on the right edge of the pane, `--app-border-secondary` at 40 percent opacity, appearing on scroll or hover and fading after 900 ms.
- It represents the **whole** logical extent, live layer plus history layer, so its thumb size communicates how much history exists. This is the only persistent affordance that history is reachable, and it is the reason no strip or toggle is needed.
- When the history layer is paging backwards, the track shows a 2 px indeterminate shimmer at its top in `--app-text-tertiary`. No spinner. Skeletons over spinners, per the house rule.
- Hidden entirely when there is nothing above the current screen.

### 8.4 Keyboard

| Keys | Action | Precedent |
|---|---|---|
| `Shift+PageUp` / `Shift+PageDown` | scroll history by one page, opening the layer if needed | Linux console, xterm, Windows Terminal |
| `Ctrl+Shift+Home` / `Ctrl+Shift+End` | jump to the oldest loaded content / return to live | Windows Terminal |
| `Ctrl+C` | copy when a selection exists, otherwise SIGINT | already implemented in `attachCustomKeyEventHandler`, unchanged |
| `Ctrl+Shift+C` | copy, always, never SIGINT | Linux terminal convention, new |
| `Ctrl+Shift+A` | select all of the history document plus the current screen | new, satisfies A6 |
| `Ctrl+V`, `Ctrl+Shift+V` | paste through the native trusted path | already implemented, unchanged |
| `Escape` while the history layer is open | close and pin live | matches the existing Copy view Escape handling |
| any printable key while the history layer is open | close, pin live, and deliver the key to the PTY | this is what a native terminal does, and it is why no explicit exit is needed |

That last row is the one that makes the whole thing modeless: the way out of history is to start typing, exactly as in a native terminal.

### 8.5 Touch and mobile

The existing touch engine in `initMobileInputMode` already drives `term.scrollLines` with momentum and long press selection, and already exempts the Copy view overlay from its capture handlers via `_isInsideCopyView`. USS extends that exemption to the history layer, so:

- One finger drag scrolls. At the top boundary the same rule as 8.1 applies, and the history layer opens with the momentum carried through.
- Inside the history layer the browser scrolls natively, with `-webkit-overflow-scrolling: touch`, exactly as the Copy view already does.
- Long press selects, using the platform's own selection handles, which is strictly better than the terminal's selection on touch.
- The mobile toolbar mirror (`_syncMobileSelectToolbar`, `SELECT_CHROME_EVENT`) gains a "history open" state so the phone chrome stays honest. The existing bubbling `CustomEvent` contract is reused, not replaced.
- Pull to refresh must stay suppressed at the top of the history layer, matching the existing `e.preventDefault()` in `onTouchMove`.

### 8.6 Selection

| Where | Mechanism | Copy path |
|---|---|---|
| Live layer, normal buffer, no mouse tracking | native xterm selection, native drag at edge auto scroll | `term.getSelection()` |
| Live layer, under mouse tracking | Shift plus drag natively, or Select mode v1's Shift forced clone, both retained | `term.getSelection()` |
| History layer | native DOM selection, native auto scroll, native touch handles | `document.getSelection().toString()` |
| Across the boundary | **not possible, and not needed**: the history document already contains the current screen as its `screen` segment, so any selection the user wants is entirely inside one surface | DOM |

That last row is the design's answer to the user's exact sentence "you cannot drag up and copy history". Once the history layer is open it contains everything **including** what is on screen, so a single drag from the bottom of the document to any point above it selects a contiguous range with no seam and no special case.

`getCopySelection()` already returns `{hasSelection, text, source: 'xterm' | 'dom'}` and already accepts a DOM selection whose endpoints are inside the pane element. It needs no change to cover the history layer, because the layer is parented on `paneEl`. That is a genuinely fortunate piece of existing design.

### 8.7 Where Select mode remains

Select mode is **not** retired. It keeps one job, narrowed and clearly stated:

> Select mode makes a plain drag select text **on the live screen** while an application owns the mouse.

That is still needed, because a user may want to select the visible frame without opening history, for example to grab one line of a tool result. Everything else Select mode currently carries moves to USS:

| Select mode responsibility today | Under USS |
|---|---|
| Make a plain drag select under mouse tracking | **keeps it** |
| Freeze the write pipeline during a hold | keeps it for the live layer only; the history layer uses the mirror freeze instead |
| Be the route to copying more than the visible screen | **replaced** by USS |
| Explain itself with a bottom strip | demoted: the strip stops appearing by default once USS ships, because the scrollbar is the affordance. Shown only on the first ever plain drag under mouse tracking. |

The header toggle stays, the persisted per session preference stays, the keyboard and context menu entry points stay.

### 8.8 Focus, typing, and the live screen

While the history layer is open the terminal keeps keyboard focus, because typing must dismiss it (8.4). The layer therefore must **not** take focus on open, which is a change from the Copy view's `_openCopyView`, which focuses its `<pre>`. Instead the layer is scrolled programmatically and receives keys through a pane level handler. Its `<pre>` is still `tabIndex=0` for accessibility and for explicit Tab access.

---

## 9. Copy and paste specification

### 9.1 Copy paths

| Trigger | Source of text | Clipboard mechanism | Works on insecure origin |
|---|---|---|---|
| `Ctrl+C` with xterm selection | `term.getSelection()` | browser's trusted `copy` event, xterm writes `clipboardData` | yes |
| `Ctrl+C` with DOM selection in the history layer | `document.getSelection()` | browser's trusted `copy` event | yes |
| `Ctrl+Shift+C` | `getCopySelection().text` | `TerminalPane.copyTextToClipboard` | yes |
| Right click, Copy | snapshot taken at `contextmenu` time, with `getSelectionPosition()` restore for xterm | `copyTextToClipboard` inside the trusted click | yes |
| `Ctrl+Shift+A` then copy | whole history document plus screen | `copyTextToClipboard` | yes |
| Pane header "Copy transcript" (present in the Notion mock) | whole history document plus screen | `copyTextToClipboard` | yes |

`TerminalPane.copyTextToClipboard` is kept exactly as written. Its ordering (synchronous `execCommand` first to preserve the gesture, then `navigator.clipboard.writeText` in the same call stack, never throwing, never rejecting) is the correct solution to a genuinely subtle problem and must not be simplified.

### 9.2 Paste paths

All three existing entry points are preserved and all three route through one new pure function:

```
prepareInputForPty(text, { bracketedPasteMode, confirmMultiline }) -> { data, needsConfirm, lineCount }
```

| Entry point | Current handling | Change |
|---|---|---|
| `beforeinput` with `inputType === 'insertFromPaste'` | preventDefault, manual bracket, send | route through `prepareInputForPty` |
| native `paste` on `.xterm-helper-textarea` | preventDefault, stopImmediatePropagation, manual bracket, send | route through `prepareInputForPty` |
| `pasteFromClipboard()` from the menu | `navigator.clipboard.readText`, manual bracket, send | route through `prepareInputForPty` |

The `_pasteHandled` latch and its zero delay reset timer stay as is. They solve a real double send between `beforeinput` and `paste`.

`test/bracketed-paste-isolation.test.js` gates the **character distance** between `pasteFromClipboard` and `this.ws.send(`, which is why the existing explanatory comments were hoisted above the function. Any refactor must keep that body compact; `prepareInputForPty` must be a module level function so the call site stays one short line.

### 9.3 Bracketed paste correctness

```
bracketed = term.modes.bracketedPasteMode === true
data = text.replace(/\r?\n/g, '\r')
if (bracketed) data = '\x1b[200~' + data + '\x1b[201~'
```

Additionally, when `bracketed` is true, strip any `\x1b[201~` occurring **inside** the pasted text. A crafted or accidental end marker inside the payload would otherwise terminate the bracket early and let the remainder be interpreted as typed input. This is the one place in the terminal path where untrusted external content is framed by control sequences, so it gets an explicit sanitizer rather than an assumption.

### 9.4 Multi line paste safety

| Condition | Behaviour |
|---|---|
| Single line | send immediately, no interruption |
| Multi line and `bracketedPasteMode` is on | send immediately. The application asked for bracketing precisely so it can handle multi line safely, and every agent CLI measured has it on. |
| Multi line and `bracketedPasteMode` is off | show a confirm with the line count and the first line, defaulting to "Paste". This is the case where each line becomes a command. |
| Setting `terminalConfirmMultilinePaste` | default `auto`, meaning the table above. Can be set to `always` or `never`. |

This matches Windows Terminal's `confirmMultilinePaste`, refined by the bracketed paste check so the common agent case never nags.

### 9.5 Insecure origin

Unchanged and already correct. Copy works on every origin through the `execCommand` fallback. Programmatic paste reads are impossible on insecure origins, so `pasteFromClipboard` emits `cwm:paste-unavailable` and the app shell tells the user to press Ctrl+V, which reaches the native `beforeinput` and `paste` listeners and works everywhere. `test/copy-secure-context-fallback.test.js` and `test/paste-secure-context-fallback.test.js` guard this and must keep passing.

---

## 10. Theming contract for the Notion redesign

### 10.1 The problem to avoid

The history surface must be **visually indistinguishable** from the live surface. If it is off by one pixel of line height, or a shade of background, the seam is immediately visible and the illusion of one continuous terminal collapses. This is the single highest risk item for perceived quality.

### 10.2 Single source of truth

`src/web/public/theme-registry.js` becomes canonical for terminal surface colour. It currently holds metadata only, with a documented intent to absorb palettes later. Extend it additively with a `terminalSurface` projection per theme:

```
terminalSurface(themeId) -> {
  bg, ink, dim, rule, accent,      // the 5 slots the Notion mock uses
  selectionBg, selectionInk,
  ansi: { black, red, green, yellow, blue, magenta, cyan, white,
          brightBlack, ... brightWhite }   // the 16 xterm slots
}
```

Both consumers read from it:

- `TerminalPane.getCurrentTheme()` builds its xterm `ITheme` from `terminalSurface().ansi` plus `bg`, `ink`, `selectionBg`, `selectionInk`. The existing per theme static fallbacks stay as the last resort so a missing custom property can never make one pane inherit another theme's colours.
- The history layer reads `bg`, `ink`, `dim`, `rule`, `accent` for its own chrome.

The 13 persisted theme ids are unchanged. `theme-registry.js` already warns that they are persistence ids stored under `cwm_theme`; nothing here renames one.

### 10.3 Typography must come from the terminal, not from the mock

The Notion mock renders the pane body at `font-size: 12.5px; line-height: 1.7` with `--font-mono: 'iA Writer Mono'`. The live terminal renders at `fontSize: 13, lineHeight: 1.2` with `'JetBrains Mono'`.

**Decision: the terminal's metrics win inside the terminal region.** A 1.7 line height inside a terminal wastes roughly 40 percent of the vertical rows, which changes the PTY row count and therefore changes what the CLI renders. The Notion values apply to the mono usages **outside** the terminal region: branch names, the worktree card live line, the diff viewer, the session peek tail.

The history layer therefore derives its typography from the live instance at open time, not from a stylesheet:

| Property | Source |
|---|---|
| `font-family` | `term.options.fontFamily` |
| `font-size` | `term.options.fontSize` |
| `line-height` | `term.options.fontSize * term.options.lineHeight`, in px, not unitless |
| `letter-spacing` | `term.options.letterSpacing` |
| `background` | `terminalSurface().bg`, identical value, not a near neighbour |
| `color` | `terminalSurface().ink` |
| horizontal padding | measured from the live `.xterm-screen` offset so column 1 lands on the same x coordinate |

Re derived on theme change, on font size change, and on `rebindHost`.

### 10.4 The Notion surface treatment

From the mock: the pane body is a warm code block surface with quiet chrome, a header that sheds controls when narrow, and a bottom input row separated by `1px solid termRule`. The history layer:

- occupies exactly the pane body rect, between the header and the input row, so the header and the input row never move when it opens,
- uses `background: termBg` with **no** border, shadow, or backdrop blur, because any of those would announce it as an overlay,
- carries a single `1px solid termRule` divider above the `screen` segment,
- renders paging chrome as a full width 24 px bar in `termBg` with `termDim` text, matching the mock's quiet rows.

The current Copy view uses `--mantle` for its background and a `--surface1` top border, which deliberately reads as a panel. That treatment is correct for the Copy view and wrong for USS; the two must not share a stylesheet.

### 10.5 Contrast gate

The three light themes (`latte`, `rose-pine-dawn`, `gruvbox-light`) must be checked for `dim` on `bg` at 4.5:1 for the paging chrome and provenance rules. `test/css-tokens.test.js` already exists as a home for a token assertion of this kind.

---

## 11. Data model, limits, and persistence

### 11.1 Where each thing lives

| Data | Owner | Bound | Survives client reload | Survives session restart |
|---|---|---|---|---|
| Live screen | client xterm | `rows` | no, replayed from the sidecar snapshot | no |
| Client scrollback | client xterm | `scrollback` option | no | no |
| Byte ring | `PtySession.scrollback` | `MAX_SCROLLBACK_CHARS`, 100 KB | yes | no |
| VT snapshot | `VtSidecar` | one screen plus normal scrollback | yes | no |
| Normal buffer line log | `VtSidecar.lineLog` | `VT_LINE_LOG_MAX_LINES`, `VT_LINE_LOG_MAX_BYTES` | yes | no, unless persisted |
| Transcript | the CLI, on disk | the file itself | yes | **yes** |

The last row is the point. Only the transcript survives a session restart, which is another reason it is the right history source for agent panes.

### 11.2 Proposed limits

| Constant | Value | Reasoning |
|---|---|---|
| `Terminal.scrollback` (client) | 10000, from 5000 | xterm stores 3 `uint32` per cell, so 12 bytes per cell. 10000 lines at 200 columns is roughly 24 MB per pane, 96 MB across a 4 pane grid. That is the ceiling; going to 20000 would double it and is not worth it once the server line log exists. |
| `VT_LINE_LOG_MAX_LINES` | 50000 | deep enough that a full build log is reachable |
| `VT_LINE_LOG_MAX_BYTES` | 32 MB per session | hard second bound, whichever trips first |
| `VT_SIDECAR_MAX_SESSIONS` | 12 | matches the practical pane and tab group ceiling; beyond it the sidecar is skipped and the byte ring path is used |
| `HISTORY_PAGE_LINES` | 2000 | one page of the history document |
| `HISTORY_PREFETCH_VIEWPORTS` | 2 | page backwards when within two viewports of the top |
| `HISTORY_MAX_LOADED_LINES` | 40000 | trim the far end of the DOM document to keep node count bounded; the trimmed part is re fetchable |
| `WHEEL_EXHAUSTION_MS` | 140 | the escalation window in 8.2 |
| `MIRROR_HISTORY_TAIL_BYTES` | 2 MB, unchanged | already correct |
| `COPY_VIEW_TRANSCRIPT_PAGE_BYTES` | 256 KB, unchanged | reused by USS |

### 11.3 Memory budget statement

Worst case with four panes open, all normal buffer, sidecar on:

```
client:  4 panes x 24 MB xterm buffers                =  96 MB
         4 panes x 40000 loaded history lines, DOM    =  ~40 MB   (text nodes, trimmed)
server:  4 sessions x (headless VT ~24 MB + 32 MB log) = 224 MB
```

The server figure is the one to watch. Mitigations, in order: cap `VT_SIDECAR_MAX_SESSIONS`, make the headless VT's own `scrollback` small (500) because the line log is doing the deep retention, and make `VT_LINE_LOG_MAX_BYTES` operator tunable through an environment variable exactly as `mirror-service.js` does with `envInt`. With the headless scrollback at 500 the server figure drops to roughly 140 MB.

### 11.4 Session restart

On restart the PTY is new, the byte ring is empty, and the sidecar starts fresh. For an agent pane the transcript is untouched and the history layer shows the full prior conversation immediately, which is a genuine improvement over today. For a shell pane the history is legitimately gone, exactly as in a native terminal.

Persisting the line log to disk is deliberately **out of scope**. It would put arbitrary terminal output, which routinely contains tokens and secrets, onto disk in a new location. If it is ever wanted it needs its own security review and its own retention policy. Noted here so the decision is explicit rather than accidental.

---

## 12. Robustness matrix

| Event | Required behaviour | Mechanism |
|---|---|---|
| WebSocket reconnect | pane shows the exact prior screen, history layer keeps its scroll position if open | sidecar snapshot replaces byte replay; the history layer is client state and is not reset by `{type:'reset'}` |
| Server initiated resync (lagged client) | same as reconnect | same path |
| Resize while the history layer is open | the live layer refits and the PTY resizes as today; the history document reflows as DOM text, so no re fetch | history is `white-space: pre-wrap`, not a fixed grid |
| Resize while a selection is held | defer the fit, as `safeFit` already does through `_fitDeferredWhileFrozen` | keep that guard |
| Width ownership moves to another device | the CLI repaints at the other device's width; the `screen` segment shows the new width, the `transcript` segment is width independent | this is an argument for the transcript source, which cannot be corrupted by another client's geometry |
| Two clients open history on the same session | independent, because the history layer is client state and both sources are read only and paged | mirror is already refcounted per device |
| PTY exits | the history layer stays open and readable, the `screen` segment freezes at the last frame | no special case needed |
| `node-pty` unavailable (issue 68) | unchanged, `PTY_UNAVAILABLE` banner, no reconnect loop | `_showPtyUnavailableBanner` |
| Transcript file missing or truncated | inline notice in the paging bar, fall back to the terminal snapshot segment | `mirror:reset` already models truncation |
| Mirror watcher limit reached (10) | the history layer opens a mirror, reads one window, and closes immediately, exactly as `_loadTranscriptSnapshot` does today | snapshot semantics, not a live subscription, so the limit is not consumed |
| Sidecar throws or is disabled | fall back to the byte ring and to `term.buffer.active.type` sniffing | every sidecar consumer is written with `?? fallback` |
| Very fast output while the history layer is open | the `screen` segment refresh is rAF throttled and paused during a selection; the PTY is never blocked | mirror freeze, section 7.3 |

---

## 13. Migration of Select mode v1, v2, v3, and its tests

### 13.1 The preservation constraint is unusually strict here

`test/terminal-select-mode.test.js` (563 lines) and `test/terminal-select-v2.test.js` (2636 lines) assert against the **source text** of `terminal.js` with regular expressions, for example:

```js
assert.ok(/_saveSelectModePreference\(this\.sessionId,\s*this\._selectMode\)/.test(termSrc), ...);
assert.ok(/shiftKey:\s*true/.test(termSrc), 'expected the clone to force shiftKey: true');
assert.ok(/e\.button\s*!==\s*0/.test(termSrc), 'expected a left-button-only guard');
```

Renaming a private method, reformatting a call, or moving a guard breaks these tests even when behaviour is identical. Combined with the global code preservation rule, this makes the migration strategy obvious and non negotiable.

### 13.2 Strategy: additive layering, zero deletions

| Artifact | Disposition |
|---|---|
| `_installSelectModeInterceptor`, the Shift forced clone, `__cwmSelSynthetic` | **preserve verbatim.** Still the mechanism for plain drag on the live screen under mouse tracking. |
| `TERMINAL_REPORT_ONLY_RE`, `_isTerminalReportOnly`, `_isReportOnlyInputFrame`, `_installInputUnfreezeHook` | **preserve verbatim.** Still required for the live layer. This is the most expensively earned code in the file. |
| `_engageSelectHold`, `_releaseSelectHold`, `_onSelectionChanged`, `_isWriteFrozen`, `_unfreezeAndFlush`, `_discardSelectModeHold` | **preserve.** Scoped to the live layer. The history layer never engages them. |
| `SELECT_FREEZE_MAX_HOLD_CHARS`, `_overflowSelectFreeze` | **preserve.** Becomes unreachable for panes using the history surface; still reachable for live layer drags. |
| Select mode strip (`_showSelectModeStrip`, `SELECT_STRIP_TEXT`, placement helpers) | **preserve, demote.** Gate first display on a new "first plain drag under mouse tracking" condition instead of on the toggle. The static string stays so its test keeps passing. |
| Copy view (`_ensureCopyOverlay` and the whole block) | **preserve, reposition.** Stays as the explicit "terminal bytes" fallback and as the phone friendly full screen reader. Reachable from the pane menu and the mobile sheet. USS is a new sibling, not a rewrite of it. |
| `_loadTranscriptSnapshot`, `_loadEarlierTranscript`, `_renderTranscriptText`, `_copyViewIdentity`, `_copyViewApi`, `_copyViewDeviceId` | **preserve and reuse.** These become the transcript data layer for USS. Promote them to shared methods used by both surfaces rather than duplicating the fetch logic. |
| `getCopySelection` | **preserve unchanged.** Already covers the history layer because the layer is parented on `paneEl`. |
| `copyTextToClipboard`, `_copyViaExecCommand` | **preserve unchanged.** |
| Wheel guard (`_installSelectModeWheelGuard`) | **preserve, and add a new sibling** that uses xterm 6's public `attachCustomWheelEventHandler` for the USS boundary logic. Do not rewrite the capture phase guard; run the new handler first and let the old one stay inert when USS owns the gesture. |

### 13.3 New files

| Path | Contents |
|---|---|
| `src/web/public/terminal-history.js` | the history layer: DOM, scroll boundary logic, source router, segment rendering, mirror freeze. Loaded before `app.js`, exposed as `window.TerminalHistory`, consistent with how `terminal.js` exposes `TerminalPane`. |
| `src/web/vt-sidecar.js` | the headless VT: snapshot, line log, mode signal. Requires `@xterm/headless` and `@xterm/addon-serialize`, both guarded by the same containment pattern `pty-manager.js` uses for `node-pty`, so a failed load degrades to the byte ring rather than taking the server down. |
| `test/terminal-history.test.js` | source and behaviour tests for the new layer |
| `test/vt-sidecar.test.js` | golden stream tests for the sidecar |
| `test/paste-input-preparation.test.js` | the `prepareInputForPty` truth table |

### 13.4 Documentation obligations

Per the house rules: `CHANGELOG.md` entry per stage under Unreleased, a version bump per shippable stage, `docs/ARCHITECTURE.md` updated with the USS component diagram if that file is adopted in this repo, and an ADR recording the rejection of A and B on the measured grounds in section 2.3, because that is exactly the kind of decision a future session will otherwise re litigate.

---

## 14. Staged build plan

Five stages. Each is independently shippable, independently valuable, and independently revertable. Each names its own tests.

### Stage 1. Input path correctness and select all

**Fixes** D1, D2, D5. No architecture change. Ships in isolation.

| Item | Detail |
|---|---|
| `prepareInputForPty(text, opts)` | pure module level function in `terminal.js`; normalize `\r?\n` to `\r`, gate bracketing on `term.modes.bracketedPasteMode`, strip embedded `\x1b[201~`, report `lineCount` |
| Three paste call sites | route through it; keep `pasteFromClipboard` body compact for `test/bracketed-paste-isolation.test.js` |
| Multi line confirm | per the 9.4 table, with the `terminalConfirmMultilinePaste` setting |
| `Ctrl+Shift+C` | copy always, never SIGINT |
| `Ctrl+Shift+A` | `term.selectAll()` for now; upgraded in stage 3 to include history |
| Client `scrollback` | 5000 to 10000 |

**Tests.** `test/paste-input-preparation.test.js`: a truth table over `{single, multi} x {bracketed on, off} x {CRLF, LF, CR}` plus the embedded end marker case. Extend `test/bracketed-paste-isolation.test.js` to assert the mode gate exists. Manual: paste two lines into `cmd.exe` and into an agent pane.

**Acceptance covered.** A4 partly, A6 partly, A7, A8.

### Stage 2. VT sidecar, snapshot replay, mode signal

**Fixes** D3, and lays the foundation for deep normal buffer history.

| Item | Detail |
|---|---|
| `src/web/vt-sidecar.js` | `@xterm/headless` per session, containment guarded require, `VT_SIDECAR_MAX_SESSIONS` cap |
| Snapshot replay | on attach, send `addon-serialize` output instead of `scrollback.join('')`, behind `CWM_VT_SIDECAR=1`, defaulting off for one release |
| Mode signal | new control frame `{type:'mode', altBuffer, mouseTracking, bracketedPaste}` broadcast on change; unknown control types are already ignored by older clients, so the mixed version window is safe |
| Byte ring | **retained** as the fallback and for `GET /api/sessions/:id/scrollback` |

**Tests.** `test/vt-sidecar.test.js`: feed the captured byte streams in Appendix A through the sidecar and assert the serialized snapshot re renders to the same grid as a fresh xterm fed the same bytes. Assert that a byte stream whose prefix has been pruned still snapshots correctly. Assert containment: a forced require failure leaves the server up and the byte ring in use.

**Acceptance covered.** A10.

### Stage 3. The history layer, terminal snapshot content only

The surface, the boundaries, the theming, and the mirror freeze, using only data the client already has. No new data source. This is the stage that proves the interaction model.

| Item | Detail |
|---|---|
| `src/web/public/terminal-history.js` | layer DOM, open and close by scroll boundary, Shift plus wheel, Shift plus PageUp, Escape, printable key dismissal |
| Segments | `ring` from `term.buffer.normal` plus `screen` from the active buffer, both via the existing `_readBufferLines` |
| Mirror freeze | pause the `screen` refresh on `selectionchange` with a non collapsed selection inside the layer |
| Theming | metrics derived from the live instance per section 10.3 |
| Scrollbar affordance | per 8.3 |
| `Ctrl+Shift+A` | upgraded to select the whole document |

**Tests.** Extend `test/browser/terminal-interaction.test.js` (Playwright, 1136 lines, already exists) with: wheel up at the top boundary opens the layer; wheel down at the bottom closes it and pins live; a selection held in the layer survives 200 lines of new PTY output; typing dismisses; the layer's computed `font-size`, `line-height`, and `background-color` equal the live `.xterm-screen` values. Add a source level test asserting no Select mode identifier was removed.

**Acceptance covered.** A1, A2, A3, A5, A9, A11.

### Stage 4. Real history sources

| Item | Detail |
|---|---|
| Transcript segment | auto load on first open for alternate buffer panes, paged backwards with `beforeOffset`, reusing `_loadEarlierTranscript` |
| Deep segment | server line log from the sidecar, new paged endpoint `GET /api/sessions/:id/history?beforeLine=&lines=` |
| Source router | per 7.2, re evaluated on `onBufferChange` |
| Provenance | subtle rule between segments, no labels, `title` attributes for accessibility |
| Trim | `HISTORY_MAX_LOADED_LINES` with re fetch on scroll back |

**Tests.** `test/terminal-history.test.js` for the router truth table and the paging cursor. Extend `test/mirror-routes.test.js` if a new query shape is added. Browser test: open an agent pane, scroll up, assert conversation text older than the visible frame is present and selectable, and that copying it yields the expected text.

**Acceptance covered.** A2 and A6 for agent panes, which is the user's primary complaint.

### Stage 5. Native feel polish and mobile

| Item | Detail |
|---|---|
| Wheel escalation | the `WHEEL_EXHAUSTION_MS` heuristic behind `settings.terminalWheelEscalation` |
| Touch | momentum carry through the boundary, native selection handles, pull to refresh suppression |
| Mobile chrome | history state in `SELECT_CHROME_EVENT`, toolbar mirror |
| Keyboard | `Ctrl+Shift+Home` and `Ctrl+Shift+End` |
| Select mode strip demotion | first plain drag under mouse tracking only |
| Reduced motion | open and close animations respect the existing gate |

**Tests.** `test/mobile-ux-fixes.test.js` extension. Manual matrix on a real phone, since touch selection cannot be meaningfully asserted headlessly. Visual QA screenshots before and after per the house rule, across at least `mocha`, `latte`, and `gruvbox-light` to catch the light theme contrast case.

**Acceptance covered.** the remainder of A1, A3, A11 on touch.

---

## 15. Verification gates and open questions

These must be closed before or during the stage that depends on them. None of them changes the recommendation; each changes a detail.

| ID | Question | Blocks | How to close |
|---|---|---|---|
| VG-1 | Does the agent CLI ever scroll its alternate viewport during a **very long** single response, for example one that overflows the frame? All measured samples were short. | nothing; if it does scroll, an optional scroll off capture segment becomes an additional history source, which only adds fidelity | run Appendix A against a session with a multi screen response |
| VG-2 | Does the CLI restore the normal buffer on exit (`CSI ?1049l`)? Not observed because no session exited during sampling. | the `ring` segment content for a pane that has exited a CLI and returned to a shell | sample a session immediately after the CLI exits |
| VG-3 | Is the Codex CLI normal buffer or alternate buffer? | nothing; the router keys on buffer mode, not provider | run Appendix A with a live Codex pane |
| VG-4 | Does `@xterm/headless@6.0.0` handle the ConPTY `CSI ?9001h` win32 input mode sequence without warnings? | stage 2 | golden stream test |
| VG-5 | Actual per pane memory of xterm at 10000 lines and 200 columns, measured rather than estimated. | the stage 1 scrollback bump | Chrome heap snapshot with four panes open |
| VG-6 | Does the wheel escalation heuristic misfire when the CLI is simply slow to respond rather than exhausted? | stage 5 only, and it is flagged | manual, with the flag off as the escape hatch |
| VG-7 | Light theme contrast for `dim` on `bg` in the three light themes. | stage 3 | `test/css-tokens.test.js` extension |

One further note on the missing forensic report. Because it could not be located, this document's factual base is the Appendix A measurement rather than that report. Everything the brief attributed to the report was independently confirmed, so the two agree wherever they overlap. If the report resurfaces it should be diffed against section 2 rather than assumed to supersede it, since section 2 was taken from live processes on this machine on 2026-08-13.

---

## 16. Risks and tradeoffs surfaced for the orchestrator

Stated plainly, because these are scope decisions rather than engineering details.

1. **Transcript history is semantic, not byte exact.** A user who scrolls up in an agent pane sees the conversation, not the exact pixels the CLI drew. Tool payloads are one line summaries. This is a deliberate tradeoff and it is the only correct one available, but it should be a conscious product decision, not a surprise.
2. **The seam is an overlap, not a join.** The newest transcript turn and the live frame may both show the same content. Chosen over a heuristic join because a wrong join silently deletes real content.
3. **Stage 2 adds a native dependency surface.** `@xterm/headless` is pure JavaScript so it carries none of `node-pty`'s prebuild risk, but it is still a new server side dependency and a new per session memory cost. It is behind a flag for one release for exactly this reason.
4. **The wheel escalation heuristic depends on CLI behaviour that can change with a CLI update.** It is a convenience layered on a guaranteed Shift path, never the only route.
5. **Select mode's strip is demoted, which changes a visible behaviour users may have learned.** The code and its tests are preserved, but the default surface changes. Worth a changelog note and possibly a one time in app notice.
6. **The two selection test files total 3199 lines of source text assertions.** They are a real constraint on refactoring velocity. The additive strategy respects them, but any future decision to consolidate Select mode v1, v2, and v3 into one implementation is a separate, explicitly approved piece of work.
7. **Not addressed here, and worth its own decision:** persisting terminal history to disk. Deliberately out of scope, section 11.4.

---

## Appendix A. Reproduction recipe for the measurements

Read only. Requires the Workbook server running locally and at least one live PTY pane.

```bash
# 1. Auth against the local server. Password source order is documented in
#    src/web/auth.js: env CWM_PASSWORD, then ~/.myrlin/config.json, then ./state/config.json.
TOK=$(curl -s -X POST http://127.0.0.1:3456/api/auth/login \
      -H "Content-Type: application/json" \
      -d "{\"password\":\"<password>\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")

# 2. List live PTY sessions.
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3456/api/pty

# 3. Pull a session's raw byte scrollback (escape sequences are preserved;
#    the endpoint splits on \n only).
curl -s -H "Authorization: Bearer $TOK" \
     "http://127.0.0.1:3456/api/sessions/<sessionId>/scrollback?lines=1000&from=end"
```

Classify the result with these patterns. The scroll family is the decisive one.

| Pattern | Meaning |
|---|---|
| `\x1b\[\?1049h` / `\x1b\[\?1049l` | alternate buffer enter / exit |
| `\x1b\[\?(1000\|1002\|1003\|1006)h` | mouse tracking and SGR encoding |
| `\x1b\[\?2004h` | bracketed paste mode, the gate for defect D1 |
| `\x1b\[\?2026[hl]` | synchronized output, absent on this CLI |
| `\x1b\]52` | OSC 52 clipboard, absent on this CLI |
| `\x1b[DM]` and `\x1b\[\d*[STL]` and `\x1b\[\d*;\d*r` | **the scroll family. All zero. This is the finding.** |
| `\x1b\[(\d+);(\d+)H` | absolute cursor addressing, the repaint mechanism |

Caveat to record with any future run: `PtySession.appendScrollback` prunes from the **front** at 100 KB, so on a long lived session the alternate buffer enter has usually been pruned away. Absence of `?1049h` in a large sample is evidence of ring wrap, not of a normal buffer session. Cross check with the absolute cursor row distribution: a fixed viewport TUI addresses a bounded set of rows, a line oriented program does not.

Raw artifacts from the 2026-08-13 run were written to the session scratchpad at
`C:/Users/Arthur/AppData/Local/Temp/claude/C--Users-Arthur-Desktop-claude-workspace-manager/4ece62ba-44db-49a2-8af5-4c44f85a1514/scratchpad/termarch/`
and are ephemeral; the tables in section 2 are the durable record.

## Appendix B. xterm 6.0.0 API surface relied on

Verified against `C:/Users/Arthur/Desktop/cwm-restyle/node_modules/@xterm/xterm/typings/xterm.d.ts`.

| API | Line | Used for |
|---|---|---|
| `IModes.mouseTrackingMode` | 1932 | routing and the wheel decision |
| `IModes.bracketedPasteMode` | 1918 | defect D1 |
| `ITerminalOptions.ignoreBracketedPasteMode` | 140 | operator escape hatch |
| `IBufferNamespace.onBufferChange` | 1590 | live re routing |
| `IBuffer.viewportY`, `baseY`, `length` | 1521 to 1535 | scroll boundary detection |
| `IBufferLine.isWrapped`, `translateToString` | 1600 onward | segment extraction |
| `Terminal.attachCustomWheelEventHandler` | 1094 | boundary wheel handling without capture phase hacks |
| `Terminal.selectAll` | 1191 | defect D5 |
| `Terminal.select`, `getSelectionPosition`, `clearSelection` | 1173 to 1198 | context menu selection restore, already used |
| `Terminal.scrollLines`, `scrollToTop`, `scrollToBottom`, `scrollToLine` | 1211 to 1233 | keyboard and touch scrolling |
| `ITerminalOptions.scrollOnEraseInDisplay` | 258 | evaluated and **not** adopted, see 6.1 |
| `Terminal.parser.registerCsiHandler` | 1817 | available if a future segment needs sequence level hooks |
