# Myrlin Workbook, Notion Restyle: Mobile Experience Specification

**Status:** decision-grade. Every section below is meant to be implementable without a follow-up
design round. Where a decision is genuinely open, it is called out under "Open decisions for the
orchestrator" (section H) rather than left implicit in the body.

**Scope:** the phone experience of the Notion restyle. Tablet is treated as a distinct target only
where a rule would otherwise be wrong there; everything else inherits the desktop spec at 769px and up.

**Why this document exists:** the owner's directive is that mobile working great is super important.
The app is a terminal client. A terminal client on a phone is the hardest possible combination of
constraints: a text surface that must be selectable, a keyboard that eats half the screen, a live
byte stream that repaints under the user's finger, and a shared PTY whose geometry another device can
steal. Getting this right is not a styling pass. It is an interaction architecture.

---

## 0. How this document binds, and what it composes with

| Document | Relationship |
|---|---|
| `docs/design/notion-restyle/DESIGN-SPEC.md` section 14 | Visual authority for mobile. This document is the interaction and architecture authority. Where section 14 gives a pixel value and this document gives a behavior, both apply. Where they collide, the collisions are listed explicitly in section D.1 with a resolution, because every one of them is a touch-target or contrast issue. |
| `docs/design/notion-restyle/PROCEDURE.md` | Retrofit order and the accessibility floor A1 to A10. This document adds a mobile-only floor (section D) that sits on top of A1 to A10, never below. |
| `docs/design/notion-restyle/TEST-CONSTRAINTS.md` | The pins. Three pins in it are directly contradicted by the new IA and are enumerated in section A.6 with the exact test edit each requires. No pin is to be silently deleted. |
| `docs/design/notion-restyle/TERMINAL-ARCHITECTURE.md` | May not exist yet. This document does not depend on it. It does define the mobile-side contract that a scrollback-history surface must satisfy (section B.4 and section E.3), so the two compose without either blocking the other. |
| `docs/design/notion-import/Feature Inventory.md` | The authoritative statement of what exists. Its Mobile section marks pairing as not built; section A.4 gives pairing a permanent home. |

**Non-negotiable constraints on the implementation of this document**

1. Code preservation. Every mobile capability that exists today keeps a reachable route. Nothing in
   this document authorizes deleting a feature. Where a control moves, the old call site stays wired
   and the new surface calls the same method (this is already the established idiom in the codebase;
   see `_runMobileSelectToolbarAction` delegating to `TerminalPane.toggleSelectMode`).
2. No new server, and never port 3456. The live instance on 3456 is a served checkout, not this tree.
   Verification uses an ephemeral static harness on a high port that the QA script starts and stops
   itself (section G.1).
3. Every deviation from the mock is documented inline, in the Notion idiom, with the reason. The
   mock is under-specified in places and wrong about touch targets in others; both are handled as
   deviations, not as license to freestyle.

---

## 0.1 Ground truth: what mobile actually is today

Read from source, not from memory. This is the baseline every claim below is measured against.

**Files that carry mobile behavior**

| File | Mobile surface |
|---|---|
| `src/web/public/styles-mobile.css` (1316 lines) | All phone layout. Ten labelled phases. Everything is inside `@media (max-width: 768px)` except the tab bar and action sheet base rules. |
| `src/web/public/focused-shell.css` lines 1050 to 1230 | The `@media (pointer: coarse)` 44px block (nineteen selectors) and the focused-shell phone block. |
| `src/web/public/app.js` (about 26k lines) | Tab bar wiring, More sheet, action sheet, terminal tab strip, touch gestures, visualViewport handler, reader overlay, pairing modal, mobile toolbar wiring, mobile select-control injection. |
| `src/web/public/terminal.js` | The mobile touch engine (`initMobileInputMode`, momentum scroll, long-press selection), the width-claim system (`activate`, `_requestActivate`, `_installVisibilityActivate`), the Copy view and its phone metrics. |
| `src/web/public/index.html` | Six fixed-slot pane templates, each with its own `.terminal-mobile-toolbar` and `.terminal-mobile-input-row`. The 4-entry `nav.mobile-tab-bar`. |
| `src/web/pty-manager.js` | `sizeOwner`, `claimSizeOwnership`, `applyViewport`. The shared-PTY geometry model that produces the width thrash. |

**The current bottom tab bar is four tabs**, not five: `workspace`, `terminal`, `tasks`, `more`
(`index.html` line 1401 and following). `test/focused-shell.test.js` line 158 pins that list by
`deepStrictEqual`.

**The current mobile key toolbar is thirteen buttons**, not seven. Eleven are authored in
`index.html` (Read, Type, Enter, Tab, Ctrl+C, Copy, Ctrl+D, Esc, Up, Down, Upload) and two more are
injected at runtime by `_injectMobileSelectControls` (Select, Copy view). They live in a
horizontally scrolling strip with no overflow affordance and no pinned trailing control.

**Six capabilities are currently unreachable on a phone.** `styles-mobile.css` line 657 sets
`display: none` on `.terminal-pane-header` at phone widths. The pane header is the only host for:
voice input (`.terminal-pane-mic`), pane expand, pane collapse, pinned notes
(`.terminal-pane-pinnedoc`), the provider pill, and the live activity string plus the needs-input
badge. Select mode and Copy view had the same problem and were rescued in August 2026 by injecting
them into the toolbar; the other six were not. **The mic is the sharpest example: `app.js` feature-
detects `SpeechRecognition`, wires the button, and then the phone stylesheet hides it.** The Notion
mock puts a microphone in the input row, which is the correct fix and is adopted here.

---

# A. The mobile information architecture contract

## A.1 The contract in one sentence

Every capability the app has on a phone today, plus every capability the desktop restyle adds, has
exactly one canonical home in the five-tab IA and at most one secondary shortcut. Nothing is
reachable only by a gesture. Nothing is unreachable.

## A.2 The five tabs and what each owns

The mock's tab set is `Home`, `Sessions`, `Terminal`, `Attention` (badge), `Search`. Adopted as-is.
Ownership below is the load-bearing part.

| Tab | Owns | Does not own |
|---|---|---|
| **Home** | Orientation and jumping off. Attention banner, Active now, Recent (capped), and a Workspace section that is the permanent home for every utility view that the mock does not draw. Header carries workspace identity, New session, and the account avatar. | Bulk operations, search, terminal interaction. |
| **Sessions** | The session database. All sessions, filters, projects, discovered sessions, hidden sessions, per-session actions, bulk select. This is the old `workspace` view plus the old sidebar drawer, merged. | Anything that is not a session or a project. |
| **Terminal** | One live pane at a time, the pane switcher, key input, text input, and every pane-scoped action. The Copy view, Reader, Select mode, schedules, image attach and voice all hang off this tab. | Session lifecycle beyond the pane (create, hide, delete). |
| **Attention** | Everything that wants the user. Needs-input prompts, auto-trust held prompts, failures, completions, and file conflicts. Bulk "Stop all". The red badge is the app's only persistent alarm. | Passive status. A running session with nothing to say never appears here. |
| **Search** | One search surface. Quick switcher, command palette, global transcript search, and help, unified behind scope chips. | Navigation chrome. It is a destination, not a modal. |

**There is no More tab.** The current `more` tab is a bottom sheet of fourteen unrelated items, which
is where features go to be forgotten. Its contents are redistributed in A.4. This is the single
biggest IA change and it is what makes the five-tab mock viable.

## A.3 Exhaustive capability map

Every row is a capability that exists in the code today or is added by the restyle. `Route` is the
canonical path. `Also` is the permitted secondary shortcut. `Today` records where it lives now, so a
reviewer can verify nothing was dropped.

### A.3.1 Navigation and shell

| Capability | Today | Route | Also |
|---|---|---|---|
| Switch primary view | 4-tab bottom bar | 5-tab bottom bar | none |
| Workspace switch | Sidebar drawer (edge swipe) | Home header workspace tile, opens a workspace sheet | Sessions header tile |
| Project list, accordion, counts | Sidebar drawer | Sessions tab, Projects section | Home workspace tile sheet |
| Discovered sessions on this machine | More sheet, then drawer | Sessions tab, "Discovered on this machine" collapsed section | Search, scope Projects |
| Show hidden projects and sessions | Sidebar | Sessions tab, "Show hidden (n)" row | none |
| Sidebar resize | Desktop only | Not applicable on phone | none |
| Collapse sidebar | Not built | Not applicable on phone | none |
| Back from a detail surface | Swipe right, back chevron | Header back chevron (44px) plus OS back | Swipe right on peek sheets only |
| Login | Full-page card | Unchanged, full screen, 48px controls | none |
| Sign out | More sheet | Account sheet footer, danger group | none |

### A.3.2 Sessions

| Capability | Today | Route | Also |
|---|---|---|---|
| Session list, all sessions | `workspace` view | Sessions tab | Home Recent, capped at 5 |
| Filters (All, Running, Needs input, Stopped) | Session manager overlay | Sessions tab, pill filter row under the header | none |
| Session detail | Slide-in panel, swipe right to close | Bottom peek sheet at 88% height, drag handle, swipe down to close | none |
| Session notes (persisted) | Detail panel | Peek sheet, Notes section | none |
| Copy session id, copy transcript | Detail, context menu | Peek sheet actions plus row long-press sheet | none |
| Stop, Resume, Restart | Detail, context menu | Peek sheet actions plus row long-press sheet | Row swipe left reveals Stop |
| Rename, Summarize, Move to project, Hide, Remove | Context menu | Row long-press sheet | Peek sheet overflow |
| Auto-title toggle | Context menu | Row long-press sheet | Settings default |
| Open session in terminal | Drag to pane, tab strip "+" | Row tap opens in the current pane and switches to Terminal | Row swipe right reveals "Terminal"; row long-press "Open in new pane" |
| Bulk select and Stop selected | Not built on mobile | Sessions header overflow, "Select", checkbox mode, bottom action bar | Attention "Stop all" |
| Restart all sessions | More sheet | Sessions header overflow, danger group | none |
| New session (launcher: directory, provider, model, flags, initial prompt) | Sidebar button, hidden on phone | Home header "+" opens the launcher as a full-screen sheet | Long-press the Sessions tab; Terminal empty state "Start session" |
| Session templates (save and apply) | Launcher modal | Template chips inside the launcher sheet, horizontally scrollable, 44px | none |
| Folder browser | Not built | Launcher sheet, directory row opens a picker sheet | none |
| Drag session onto a pane | HTML5 DnD plus touch polyfill | **Removed on phone.** Replaced by tap-to-open and "Open in new pane". See B.6. | none |

### A.3.3 Terminal

| Capability | Today | Route | Also |
|---|---|---|---|
| Pane switching | `.terminal-tab-strip` tabs, dots, horizontal swipe | Pane chip strip per the mock | Horizontal swipe in the body, guarded (B.3) |
| Close a pane | `x` on the tab strip item | Chip long-press sheet, "Close pane" | Pane overflow sheet |
| Open another session into a pane | `+` on the tab strip | Chip strip trailing "+" opens a session picker sheet | Sessions tab row tap |
| Pane position indicator dots | Under the tab strip | Removed. The chip strip already shows position and state. | none |
| Key: Enter | Toolbar | Toolbar, primary style | Input row Send sends text plus Enter |
| Key: Tab, Esc, Ctrl+C, Up, Down | Toolbar | Toolbar | none |
| Key: Ctrl+D | Toolbar | Pane overflow sheet, "Send Ctrl+D" | Long-press Ctrl+C opens the modifier sheet (Ctrl+A through Ctrl+Z) |
| Key: any other Ctrl combination | Not available | Modifier sheet from long-press on Ctrl+C | none |
| Type and send a line | Toolbar "Type" toggles `.terminal-mobile-input-row` | **Input row is permanent.** No Type toggle. See C.4. | none |
| Raw per-keystroke input | Implicit in Type mode | Pane overflow sheet, "Raw keys" toggle, off by default | none |
| Image attach | Toolbar camera key | Input row image button, per the mock | Pane overflow sheet |
| Voice input | Pane header, **hidden on phone, unreachable** | Input row microphone button, per the mock. Hidden when `SpeechRecognition` is absent. | none |
| Copy visible output | Toolbar "Copy" | Toolbar "Copy" | Pane overflow sheet |
| Select mode (pause output, drag to select) | Injected toolbar button plus long-press sheet | Pane overflow sheet, "Text" group | none |
| Copy view (whole transcript snapshot) | Injected toolbar button plus long-press sheet | Pane overflow sheet, "Text" group | none |
| Reader overlay (full scrollback as plain text) | Toolbar "Read" | Pane overflow sheet, "Text" group | none |
| Paste | Long-press sheet | Pane overflow sheet | Native paste callout inside the input row |
| Save selection to Notes | Long-press sheet | Selection callout action plus pane overflow sheet | none |
| Fix terminal (reset) | Long-press sheet | Pane overflow sheet, "Troubleshoot" group | none |
| Restart session | Long-press sheet | Pane overflow sheet, "Troubleshoot" group, danger | Session row sheet |
| Move to tab group | Long-press sheet | Pane overflow sheet | none |
| Scheduled messages | Floating action button, overlaps the toolbar | Pane overflow sheet, "Scheduled messages (n)". **The FAB is removed on phone.** See B.5. | none |
| Pinned notes | Pane header, hidden on phone, unreachable | Pane overflow sheet, "Pinned notes (n)" | none |
| Pane expand and collapse | Pane header, hidden on phone | Not applicable. One pane is always full height on a phone. | none |
| Provider identity | Pane header pill, hidden on phone | Terminal header provider chip, per the mock | Chip strip dot colour |
| Live activity string and needs-input badge | Pane header, hidden on phone | Terminal header second line, per the mock ("project . model" becomes "project . activity" while active) | Chip dot pulses |
| Terminal font size | Not adjustable | Pane overflow sheet, "Text size" (11 / 12 / 13 / 14) | none |
| Terminal palette | Appearance dialog | Settings, Terminal theme. Palette applies on mobile exactly as on desktop (DESIGN-SPEC 14.4). | none |
| Read-only mirror pane | Occupies a slot | Chip with a distinct dot; input row replaced by a "Read only" strip with a "Take over" action | none |
| Tab groups | Desktop strip; phone shows the mobile tab strip instead | Terminal header title tap opens the tab-group sheet (switch, rename, duplicate, close, new) | none |

### A.3.4 Attention

| Capability | Today | Route | Also |
|---|---|---|---|
| Attention queue and count | Header button hidden on phone; More sheet item | **Attention tab**, badge on the tab | Home attention banner |
| Needs-input prompts | Queue | Attention list, "Waiting for you" group | Chip dot, pane header line |
| Auto-trust held prompts | Queue with a reason | Attention list, "Held" group, reason line per DESIGN-SPEC | none |
| Failures | Queue | Attention list, "Failed" group | none |
| Completions | Toast plus queue | Attention list, "Finished" group, auto-clears on view | none |
| File conflicts (Conflict Center) | More sheet, conditional | Attention list, "Conflicts" group, conditional on count | none |
| Stop all | Attention popover | Attention header overflow, danger | none |
| Idle and completion notifications | Toasts | Unchanged, subject to the toast contract (B.5) | Attention list |

### A.3.5 Search

| Capability | Today | Route | Also |
|---|---|---|---|
| Quick switcher (Ctrl+K) | Full-screen overlay on phone, reached from More | **Search tab**, default scope All | none |
| Command palette | Quick switcher | Search, scope Commands | none |
| Global transcript search (Ctrl+Shift+F) | Keyboard only, no phone entry point | Search, scope Conversations | none |
| Find a session | Quick switcher | Search, scope Sessions | none |
| Help | `openQuickSwitcher('help')` | Search, scope Help | Settings footer |
| Recent searches | Not built | Search empty state, "Recent" rows | none |

### A.3.6 Utility views, account, and settings

These are the fourteen orphans from the current More sheet plus the account surfaces. Every one gets a
row in the **Home > Workspace** section. That section is the replacement for the More tab and it is
deliberately a scrolling list of Notion rows, not a menu.

| Capability | Today | Route | Also |
|---|---|---|---|
| Agent tasks (worktree board) | `tasks` tab | Home > Workspace > "Agent tasks (n running)" | Long-press the Home tab |
| Kanban board on a phone | Horizontal columns, unusable at 390px | Tasks screen defaults to a **column segmented control plus a vertical card list**. Board layout is retained at 769px and up. Card move is an action sheet, "Move to column", not a drag. | none |
| New agent task dialog | Modal | Tasks header "+", full-screen sheet | none |
| Merge, Push, Diff | Card buttons | Card tap opens a task peek sheet with the actions | Card long-press sheet |
| Diff viewer | Modal | Full-screen sheet, lazily loaded (E.4) | none |
| td issues tab | Not built | Tasks screen, second segment | none |
| Project notes (docs: Notes, Goals, Tasks, Rules) | More sheet, `docs` view | Home > Workspace > "Project notes" | Pane overflow "Pinned notes" |
| Docs raw editor | Docs view | Project notes screen, per-section "Edit raw" | none |
| Costs | More sheet, `costs` view | Home > Workspace > "Costs" | none |
| System resources | More sheet, `resources` view | Home > Workspace > "System resources" | none |
| Recent activity view | More sheet, `recent` view | Folded into Home "Recent" and the Sessions "Recent" sort chip. The `recent` view mode stays alive for desktop. | none |
| Session manager overlay | More sheet, "All sessions" | Folded into Sessions with filters plus bulk select | none |
| Settings | More sheet | Home > Workspace > "Settings", full-screen sheet with the existing horizontal nav chips | Account sheet footer |
| Appearance (themes, density) | More sheet, dedicated dialog | Settings > Interface. The standalone Appearance dialog stays wired for desktop. | none |
| Account chip, usage meters, resets | Header chip, bottom sheet | Home header avatar, account bottom sheet, unchanged mechanics | none |
| Switch credentials, re-login warning | Account sheet | Unchanged | none |
| Provider tabs (Claude, Codex) in the account sheet | Account sheet | Unchanged | none |
| Machines strip (PC, Mac) and pending per-machine selections | Account sheet | Unchanged | none |
| **Pair device (QR, manual, tunnel URLs)** | More sheet, modal | Home > Workspace > "Paired devices (n)", full-screen sheet with QR and Devices segments | Settings > Devices |
| Revoke a paired device | Devices tab of the modal | Paired devices screen, row long-press or row trailing action | none |
| Update Myrlin | Not built | Settings > About, "Check for updates" | none |

**Result: zero orphans.** Every capability enumerated from the source has a canonical route.

## A.4 The Home screen, specified

The mock draws Home as banner plus Active now plus Recent. That is not enough surface to absorb the
More tab, so Home gains a fourth block. The composition below is in the Notion idiom and reuses the
mock's own primitives.

```
[header 50px]  workspace tile (24px) | "Myrlin's Workbook" 15/600 | "+" 32px visual / 44px hit | avatar 26px in a 44px hit
[scroll body, padding 12px 16px calc(76px + safe-area-inset-bottom)]
  1  Attention banner            wash + ink, 44px min-height, tap goes to the Attention tab
  2  "Active now" label          12/500, --app-sidebar-section-label
  3  Active session cards        bordered, 8px pulsing dot, provider chip. Cap at 6, then "See all (n)".
  4  "Recent" label
  5  Recent rows                 borderless, 7px static dot, trailing relative time. Cap at 5, then "See all".
  6  "Workspace" label
  7  Workspace rows              borderless rows, 20px leading glyph, optional trailing count or chevron:
                                   Agent tasks (n running)
                                   Project notes
                                   Costs
                                   System resources
                                   Paired devices (n)
                                   Settings
  8  Footer meta                 version, last sync, 11px tertiary, non-interactive
[tab bar 64px + safe-area-inset-bottom]
```

Deviations from the mock, with reasons:

1. **The header magnifier becomes "+" (new session).** Search is a tab; a header magnifier on Home
   would be a second route to a first-class destination while New session, a primary action, would
   have none. Notion mobile puts the compose affordance in the header of its Home surface, so this
   stays in the idiom.
2. **The "Workspace" section is added.** Without it the More tab has to survive, which costs a tab
   slot and re-creates the drawer of forgotten features.
3. **Active now and Recent are capped.** Home is an orientation surface. Unbounded lists belong in
   the Sessions tab. The caps are 6 and 5 with "See all" rows.

## A.5 The reachability invariant, and how it is enforced

**Invariant:** for every capability id in the manifest, `route(capability)` is non-empty and consists
only of tap, long-press-on-an-affordance, or a bottom-sheet item. No capability is reachable only by
a swipe, only by a hover, or only by a keyboard shortcut.

Enforcement is a source-gate test in the existing idiom of `test/mobile-ux-fixes.test.js` (which
already greps `index.html` and `app.js` for structural facts and is listed in the recommended CI
workflow in TEST-CONSTRAINTS):

`test/mobile-ia-contract.test.js`

1. Declares the capability manifest as a literal array of ids matching section A.3.
2. Asserts `nav#mobile-tab-bar` contains exactly `['home','sessions','terminal','attention','search']`
   in order.
3. For each capability, asserts the presence of its route marker: a `data-mw-route="<id>"` attribute
   on the element or a string literal in the sheet builder that names it. This is a grep-level check,
   deliberately, because a DOM-level check would need a running app.
4. Asserts that no capability's only marker sits inside a block guarded by a hover selector or inside
   `.terminal-pane-header` (the surface that is `display: none` on phones). **This assertion is the
   regression gate for the six currently-unreachable capabilities.**

## A.6 Pins this IA breaks, and the exact edits required

TEST-CONSTRAINTS is explicit that a pin is never deleted to make CI green, and that an expectation
edit ships in the same commit as the source change with a one-line reason. Three pins are affected.

| Pin | File | Current expectation | Required edit | Reason comment to write in the test |
|---|---|---|---|---|
| Mobile nav is exactly four modes | `test/focused-shell.test.js` line 158 | `['workspace','terminal','tasks','more']` | `['home','sessions','terminal','attention','search']` | "Notion restyle IA: five-tab bar per DESIGN-SPEC 14.1; `tasks` moves to Home > Workspace, `more` is dissolved into Home > Workspace and per-surface overflow sheets." |
| More sheet exposes Settings / Appearance / Pair / All sessions | `test/mobile-ux-fixes.test.js` P0-2 | asserts those four labels in `showMoreMenu` | Retarget to the Home Workspace section builder plus the per-surface overflow builders. Keep `showMoreMenu` and its four labels intact for the classic shell. | "Restyle: the four labels now live on Home > Workspace; `showMoreMenu` is retained for `data-ui-shell=classic`." |
| More sheet routes to secondary and contextual views | `test/mobile-ux-fixes.test.js` P0-3 | asserts `recent`, `costs`, `resources`, `docs` routes from the sheet | Same retarget. `recent` folds into Sessions sort; assert the Sessions sort chip instead. | "Restyle: `recent` is a Sessions sort chip, not a view mode, on phones." |

Everything else in TEST-CONSTRAINTS section 9 (the touch-target and ARIA pins) is **raised**, never
lowered, by section D of this document.

---

# B. The touch interaction map

## B.1 The gesture budget

A phone has five gestures worth spending: tap, long-press, vertical drag, horizontal drag, and
edge-swipe. Two of them are already spoken for by the operating system (edge-swipe for back on both
platforms; vertical drag at the very bottom for the home indicator). The app therefore has **three
gestures to allocate**, and the current build overspends all three.

Rules:

- **R1. One gesture, one meaning, per surface.** If two behaviors want the same gesture on the same
  surface, one of them loses and moves to an explicit affordance.
- **R2. The edge belongs to the OS.** No app gesture starts within 24px of the left or right edge.
  This retires the edge-swipe sidebar drawer, which is the correct trade: the drawer becomes the
  Sessions tab and the workspace sheet, both of which are more discoverable.
- **R3. Long-press means selection inside text, and context outside it.** Enforced structurally by
  the zone model in B.2, not by a denylist.
- **R4. Every gesture has a tap equivalent.** No exceptions. This is the reachability invariant.
- **R5. A gesture never destroys.** Swipe reveals actions; it never performs a destructive one. The
  existing `.swipe-action-hide` in red is a reveal, which is correct; it must never become a
  swipe-past-threshold auto-hide.

## B.2 The three-zone long-press model

The current implementation is a denylist: `app.js` line 15218 exempts
`.terminal-container, .xterm, .terminal-copyview` from the pane long-press. A denylist is wrong here,
because every new text surface (the Reader overlay, the future scrollback-history surface, an inline
diff, a notes editor) has to remember to add itself, and the failure mode is silent: the user's
selection gesture is stolen and replaced by a menu whose second item can be destructive.

Replace it with an **allowlist of three zones**, declared as a data attribute so the classification
is visible in the DOM and greppable in tests.

| Zone | `data-mw-zone` | Members | Long-press behavior | Implementation |
|---|---|---|---|---|
| **Text** | `text` | `.xterm-screen`, `.terminal-copyview`, `.terminal-reader-content`, the scrollback-history surface, docs editors, notes textareas, session peek notes, transcript results in Search | **Native or xterm selection only.** Never a context sheet. | No context listener is bound. Inside xterm, `terminal.js` `_enableMobileSelection()` fires at 400ms with a 25ms haptic. In ordinary DOM, the browser's own selection runs; `user-select: text` and no `touch-action: none`. |
| **Affordance** | `affordance` | Session rows, project rows, pane chips, tab-bar items, kanban cards, sheet rows, toolbar keys, paired-device rows, attention rows | **Context sheet at 400ms**, 8px movement cancel, 25ms haptic, `contextmenu` suppressed. | One delegated listener per list container, keyed on `[data-mw-zone="affordance"]`. Not on the pane, not on the document. |
| **Chrome** | `chrome` | Headers, the toolbar background, the input row background, empty pane areas, section labels, the tab bar background between items | **Nothing.** | No listener. `-webkit-touch-callout: none` and `user-select: none` so a long hold does not produce a stray callout. |

**The pane container is Chrome, not Affordance.** This is the concrete fix for the reported
long-press conflict. Today `pane.addEventListener('touchstart', ...)` at `app.js` 15219 arms a 600ms
timer on any touch inside the pane that is not on the three exempted selectors, which includes the
toolbar background, the input row background, and the gap between toolbar keys. The pane action sheet
moves to the **header overflow button** (the mock's 32px "..." control) and to **long-press on a pane
chip**, both of which are Affordance zone members. The pane-container listener is removed.

Timing constants, unified:

```
MW_LONGPRESS_MS        = 400   // matches terminal.js LONG_PRESS_MS; one number for the whole app
MW_LONGPRESS_MOVE_PX   = 8     // matches terminal.js MOVE_THRESHOLD
MW_LONGPRESS_HAPTIC_MS = 25    // matches the existing navigator.vibrate(25)
```

The current 600ms pane timer is dropped. Two different long-press durations on adjacent elements is
exactly what makes a gesture feel unreliable.

## B.3 Per-surface gesture table

| Surface | Tap | Long-press | Vertical drag | Horizontal drag | Notes |
|---|---|---|---|---|---|
| Bottom tab bar item | Switch tab. Tapping the active tab scrolls its list to top; a second tap returns to the tab's root. | Tab quick-actions sheet (Home: New session, New agent task. Sessions: New session, Select. Terminal: pane switcher. Attention: Stop all. Search: recent searches) | none | none | Quick-actions get a one-time hint chip on first run so the gesture is discoverable. |
| Home cards and rows | Open | Session context sheet | Scroll | none | |
| Home attention banner | Go to Attention tab | none | Scroll | none | |
| Sessions row | Open in current pane, switch to Terminal | Session context sheet | Scroll | Left reveals Stop and Hide; right reveals Terminal. Threshold 72px, spring back below it. | Reveal only. No swipe-past-threshold action. |
| Session peek sheet | Actions | Text selection in Notes | Scroll; drag on the handle or a downward drag from the top 25% dismisses | none | |
| Pane chip strip | Switch pane | Pane context sheet for that pane | none | Scroll the strip. `scroll-snap-type: x proximity`, edge-fade mask. | Reuses the existing `.terminal-groups-tabs` mask idiom. |
| Terminal body | Dismiss the keyboard if open; otherwise nothing (a tap must never move the CLI cursor) | xterm selection at 400ms, haptic | Scroll history with momentum (existing engine) | Switch pane, **guarded**: start must be >32px from both edges, travel >= 96px, duration < 300ms, `|dy| < |dx| * 0.7`, and inert while a selection exists, while Select mode is on, and while the Copy view is open. | Guards are additive to the existing `initTerminalPaneSwipe`. The 80px threshold rises to 96px because 80px on a 360px device is 22% of the width and collides with a lazy vertical scroll. |
| Terminal selection, active | Tap outside clears | Extend via the platform handles | Auto-scroll at the edges | Extend | Selection is native DOM inside the Copy view and the Reader; xterm-model inside the live pane. Section B.4. |
| Key toolbar key | Send the key | Ctrl+C only: modifier sheet. Others: nothing. | none | Scroll only if the priority-plus layout overflowed | Toolbar keys repeat on hold? **No.** Key repeat on a terminal is a footgun; use the arrow keys' tap. |
| Input row field | Focus | Native selection and the platform paste callout | none | Native caret drag | Never intercepted. This field is an ordinary `<input>` and must behave like one. |
| Input row Send | Send text plus Enter | Sheet: "Send without Enter", "Send Shift+Enter (newline)" | none | none | Covers the provider-specific newline case that Feature Inventory marks partial. |
| Input row mic | Start and stop dictation | none | none | none | Pulses while listening per DESIGN-SPEC 14.1. Hidden when the API is absent. |
| Input row image | Open the picker | Sheet: "Camera", "Photo library", "Files" | none | none | |
| Copy view and Reader | Buttons | Native selection | Native momentum scroll | none | The overlay owns its gestures completely; the terminal touch engine already bails via `_isInsideCopyView`. Extend the same bail to the Reader. |
| Action or bottom sheet | Item | none | Scroll; drag the handle down to dismiss | none | Handle drag is new; tap-outside and Cancel stay. |
| Kanban card | Open the task peek | Card context sheet including "Move to column" | Scroll | Switch column segment | No drag-and-drop on phone. |
| Search result | Open | Copy the id or the path | Scroll | none | |

## B.4 Selection, and how it composes with a scrollback-history surface

The Terminal tab has three text surfaces with three different selection mechanics. They must be
distinguishable to the user, because two of them pause the world and one does not.

| Surface | Selection mechanic | Output continues? | Handles |
|---|---|---|---|
| Live pane | xterm model selection via `_enableMobileSelection` | Yes, unless Select mode is on, which freezes writes into the hold queue | xterm's own, no platform handles |
| Copy view | Native DOM selection over a `<pre>` snapshot | Frozen by definition; it is a snapshot | Platform handles, platform callout |
| Reader overlay | Native DOM selection over a `<pre>` of the full buffer | Frozen | Platform handles, platform callout |

**Design rule for the future history surface:** it must be the third native-DOM member of that list,
not a fourth mechanic. Concretely, whatever `TERMINAL-ARCHITECTURE.md` specifies, the mobile contract
is:

1. History renders as ordinary DOM text with `user-select: text` and no `touch-action: none`, so the
   platform gives real selection handles and the real callout bar. Do not reimplement handles.
2. History scrolls with **native** overflow scrolling, not the xterm momentum engine. The engine
   exists only because xterm intercepts touch on `.xterm-viewport`; a DOM surface has no such
   problem, and native scroll runs on the compositor thread, which is where 60fps lives.
3. History is `data-mw-zone="text"`, so no context sheet is bound to it, ever.
4. The transition between "live pane" and "history" is a **scroll continuation**, not a mode switch:
   scrolling up past the top of the live buffer reveals history with no jump, and a "Jump to live"
   pill appears once the user is more than one viewport above the bottom. The pill is the tap
   equivalent required by R4.
5. Selection inside history offers "Save to Notes" and "Copy" in the platform callout via a custom
   callout row where supported, and always in the pane overflow sheet.

Until that surface exists, the Reader overlay is the history surface, and it already satisfies rules
1, 2 and 3.

## B.5 Toast placement contract

**The defect:** `.toast` sets `pointer-events: auto` and `cursor: grab` (styles.css). The container is
`pointer-events: none`, but each toast is a full-width interactive rectangle. On a phone,
`styles.css` at 768px sets `left: 16px; right: 16px; bottom: 16px`, and `styles-mobile.css` line 255
raises it to `bottom: calc(72px + env(safe-area-inset-bottom))`. On the Terminal tab the bottom stack
is tab bar (56 to 60px) plus input row (about 52px) plus key toolbar (about 50px), which is 160px or
more. A toast at 72px therefore lands **directly on top of the key toolbar**, is interactive, and
swallows the tap. That is the reported behavior, exactly.

**The contract:**

```css
:root {
  --mw-tabbar-h:  calc(64px + env(safe-area-inset-bottom, 0px));
  --mw-toolbar-h: 0px;   /* set to the measured height by JS while a pane is active */
  --mw-inputrow-h:0px;   /* set to the measured height by JS while a pane is active */
  --mw-toast-gap: 8px;
}

@media (max-width: 768px) {
  .toast-container {
    left: 12px;
    right: 12px;
    bottom: calc(var(--mw-tabbar-h) + var(--mw-toolbar-h) + var(--mw-inputrow-h) + var(--mw-toast-gap));
    pointer-events: none;
  }
  /* A toast with no action is a notice, not a control. It must never eat a tap. */
  .toast:not(:has(.toast-action)) { pointer-events: none; cursor: default; }
  .toast .toast-action { pointer-events: auto; min-height: 44px; }
}
```

Rules:

1. **A toast without an action button is `pointer-events: none`.** This is the root-cause fix and it
   is independent of placement. Use the `:has()` form where supported and a `.toast-notice` class set
   by `showToast` as the guaranteed fallback, since `:has()` support on older WebKit is not universal.
2. **Placement is computed from measured chrome**, never from a magic constant. The two custom
   properties are written by the same layout pass that sizes the terminal (section C.2), so they can
   never drift from reality.
3. **Maximum two toasts visible on a phone**, oldest evicted. Duration 3500ms, 6000ms for warnings
   and errors, indefinite only when an action is attached.
4. **While the keyboard is open**, the anchor recomputes from the visual viewport, so the toast sits
   above the input row and below nothing. It never overlays the field the user is typing in.
5. **Never over the tab bar.** A toast that hides the Attention badge hides the alarm.
6. Swipe-to-dismiss on a toast is retained (`cursor: grab` implies a drag handler exists), but only on
   toasts that have an action, because those are the only interactive ones.

## B.6 Floating action buttons on phones: removed

**The defect:** `.terminal-pane-schedule` is `position: absolute; bottom: 12px; right: 52px;
z-index: 5`. `.terminal-pane-upload` has the same geometry at `right: 12px` and is explicitly hidden
on phones by a `@media (max-width: 768px)` rule, but the schedule button is not; the comment at
styles.css line 11399 says so out loud ("On mobile, keep the schedule button visible"). Since the
toolbar and input row are the last children of the pane, an absolutely positioned element at
`bottom: 12px` lands on top of them and clips the label of whichever key sits at that x offset.

**The rule: no floating action buttons on phones, ever.** They violate R1 (they occupy the same
pixels as the toolbar), they are undiscoverable at rest (both are `opacity: 0` until hover, and there
is no hover), and they are exactly 32px, under the touch floor.

Resolution:

- `.terminal-pane-schedule` gets `display: none` inside `@media (max-width: 768px)`, matching the
  upload button. The capability moves to the pane overflow sheet as "Scheduled messages (n)", with
  the count that the FAB badge carried.
- Any future pane affordance goes into the overflow sheet or the toolbar, never into a floating layer.
- The Select-mode strip stays, because it is `pointer-events: none` and is already placement-aware
  (`_applySelectStripPlacement`, `SELECT_STRIP_MOBILE_CHROME_FALLBACK_PX`). It is a notice, not a
  control, so it does not violate the rule. Its bottom inset must be recomputed from the same custom
  properties as the toast anchor so the three agree.

## B.7 The key toolbar: priority-plus, not a scroller

**The defect:** thirteen buttons in a horizontal scroller with no overflow affordance. At 390px only
about six are visible, so Esc, the arrows and the camera live past the fold with nothing indicating
they exist. The horizontal scroller also competes with the pane-switch swipe.

**Target composition** (the mock's seven, reordered by frequency, plus a pinned overflow):

```
[ Enter ] [ Ctrl+C ] [ Esc ] [ ↑ ] [ ↓ ] [ Tab ] [ Copy ]   [ ⋯ ]
   primary   secondary ...                                    pinned, never scrolls
```

**Layout algorithm (priority-plus):**

1. Items carry an explicit priority: `Enter (0), Ctrl+C (1), Esc (2), Up (3), Down (4), Tab (5),
   Copy (6), Ctrl+D (7)`, then any future keys.
2. On layout and on every resize or orientation change, measure the available width minus the pinned
   overflow button (44px) minus padding. Fit items in priority order. Every item that does not fit is
   rendered into the overflow sheet instead, under a "Keys" group, with the same `data-key` so it
   routes through the identical click handler.
3. **No horizontal scrolling.** If the strip would scroll, it overflows instead. This frees the
   horizontal axis on the toolbar and removes the competition with the pane swipe.
4. The overflow button is `position: sticky; right: 0` with an opaque background so it is legible
   above any content, and carries a dot when it holds items the user has not seen.

**Width arithmetic, to show this fits.** At 390px with 8px side padding and 6px gaps: Enter 56,
Ctrl+C 58, Esc 44, Up 44, Down 44, Tab 44, Copy 44 (icon plus label truncated to an icon at narrow
widths) equals 334, plus 6 gaps at 6px equals 36, plus overflow 44, plus padding 16, equals 430.
That does not fit, so at 390px the algorithm drops Copy and Tab into the overflow and shows five keys
plus the overflow. At 430px (iPhone Pro Max class) six fit. **The mock's seven-key row is achievable
only if the keys are 40px wide, which is under the touch floor, so the honest answer is five to six
keys on a 390px phone.** This is a documented deviation from DESIGN-SPEC 14.3: the mock draws seven,
the touch floor permits five to six, and the floor wins per PROCEDURE section 4.

**Second row option, rejected:** a two-row toolbar fits all seven but costs 50px of terminal height,
which on a 844px screen with a keyboard open is roughly 20% of the remaining terminal. Rejected in
favour of the overflow sheet. Revisit only if field use shows the overflow is a real cost.

## B.8 Drag and drop on phones: removed

The desktop model is drag a session onto a pane. On touch that requires the DragDropTouch polyfill,
which listens on `document` in the bubble phase and already has a documented interaction with the
terminal's `touchmove` handling (see the comment at `app.js` line 17957). With one visible pane there
is no meaningful drop target, so the gesture buys nothing and costs a conflict with vertical scroll.

Resolution: `data-mw-dnd="off"` on the phone shell; the polyfill is not initialised at 768px and
below. Session-to-pane becomes tap (opens in the current pane) and "Open in new pane" in the row
context sheet. Kanban card moves become "Move to column" in the card sheet.

## B.9 Shared-PTY width: the mobile side of the contract

A phone and a desktop attached to the same session fight over `session.sizeOwner`
(`src/web/pty-manager.js`). Ownership is claimed by typing or by an explicit `activate` message; the
phone sends `activate` from `TerminalPane.activate()` and from `_requestActivate()`, the latter fired
by an `IntersectionObserver` at 50% visibility and by focus on xterm's hidden textarea. The result in
the field is width thrash: the desktop's wide frames arrive on the phone and vice versa, and every
applied resize makes ConPTY repaint the entire viewport into both clients.

The backend half of the fix (alternate-buffer-aware replay plus an ownership debounce) is designed
elsewhere and is folded into this program as a dependency. **The mobile half is specified here** and
is independently valuable:

1. **Claim only when genuinely foreground.** `_requestActivate` gains two additional guards beyond
   the existing freeze, quiet-window, debounce and no-op checks: `document.visibilityState ===
   'visible'`, and the app's active bottom tab is `terminal`. Today a phone that is showing the
   Sessions tab can still satisfy the IntersectionObserver if the pane element is laid out and
   visible behind it, which is a claim the user did not ask for.
2. **Never claim while the keyboard is settling.** Suppress claims from the moment a
   `visualViewport` resize begins until 250ms after the last one. Keyboard open and close changes
   rows, not cols, but every applied resize is a full repaint, and doing it three times during the
   keyboard animation is visible jank.
3. **Never claim from the input row.** Focus on the mobile input row must not reach xterm's textarea,
   so the `focus` claim trigger cannot fire from typing on a phone. This falls out of C.4 for free.
4. **A per-session "Follow this device" toggle** in the pane overflow sheet, default on. Off means
   this client stores its viewport (the server already remembers `ws._viewport`) but never claims,
   so a user watching from a phone while working on a desktop can pin the desktop as the owner. This
   is the user-facing escape hatch for a problem that cannot be fully solved client-side.
5. **The phone must tolerate a width it did not ask for.** The renderer never assumes `term.cols`
   equals its own fit result. When the applied width exceeds the phone's fit by more than 20%, show a
   one-line, dismissible notice in the pane: "Another device is setting the width. Tap to take over."
   Tapping calls `activate()`. This turns a silent unreadable state into an explainable one.
6. **The escape hatch is the Copy view and the Reader**, which reflow as DOM text and are readable at
   any PTY width. The notice in rule 5 links to them.

---

# C. Soft keyboard, viewport, and safe areas

## C.1 The problem, stated precisely

A phone browser has two viewports. The **layout viewport** is what CSS `vh` and
`document.documentElement.clientHeight` describe. The **visual viewport** is what the user can
actually see, and it is what shrinks when the soft keyboard appears. On Chrome for Android the layout
viewport also shrinks by default (the keyboard resizes the content); on iOS Safari it does not, and
instead the page is scrolled and the visual viewport is offset. An app that sizes itself with `vh`
therefore has half of its UI under the keyboard on iOS.

The current code gets three things wrong:

1. **Keyboard detection compares against `window.screen.height`** (`app.js` line 1565:
   `vh < window.screen.height * 0.75`). `screen.height` is the physical screen including OS chrome
   and does not rotate consistently across browsers. In a landscape phone or an installed PWA the
   ratio is wrong, so `body.keyboard-open` toggles at the wrong times.
2. **`body.keyboard-open { position: fixed }`** (styles-mobile.css line 662). Setting `position:
   fixed` on `body` loses the scroll position and is a well-known source of iOS scroll jumps.
3. **`app.style.transform = translateY(offset)`** (app.js line 1584). A transform on an ancestor
   creates a containing block for every `position: fixed` descendant. The action sheet, the account
   sheet backdrop, the modals and the toast container are all fixed, and the codebase already carries
   a long comment (styles-mobile.css line 1139 and following) about the pain caused by `.app` forming
   a stacking context. The transform makes that strictly worse.

## C.2 The layout driver

One module owns viewport geometry. Everything else reads custom properties.

```js
/**
 * Own every viewport-derived measurement on mobile, in one place.
 * Writes four custom properties on <html> and one body class. Nothing else in
 * the app is allowed to read window.innerHeight or window.screen for layout.
 *
 * WHY one owner: the terminal fit, the toast anchor, the Select-mode strip
 * placement and the sheet max-heights all need the same numbers. Three
 * independent readers is how they drift apart.
 */
const MW_KEYBOARD_MIN_INSET_PX = 120;  // below this, it is browser chrome, not a keyboard
const MW_VP_SETTLE_MS          = 150;  // coalesce the keyboard animation's resize storm

function mwApplyViewport() {
  const vv = window.visualViewport;
  const layoutH = document.documentElement.clientHeight;
  const visualH = vv ? Math.floor(vv.height) : layoutH;
  const offsetTop = vv ? Math.round(vv.offsetTop) : 0;
  const keyboardInset = Math.max(0, layoutH - (visualH + offsetTop));
  const root = document.documentElement;

  root.style.setProperty('--mw-vh', visualH + 'px');
  root.style.setProperty('--mw-kb', keyboardInset + 'px');
  // Measured chrome, for the toast anchor and the Select strip (B.5, B.6).
  root.style.setProperty('--mw-toolbar-h', measure('.terminal-pane.mobile-active .terminal-mobile-toolbar'));
  root.style.setProperty('--mw-inputrow-h', measure('.terminal-pane.mobile-active .terminal-mobile-input-row'));

  document.body.classList.toggle('mw-keyboard', keyboardInset > MW_KEYBOARD_MIN_INSET_PX);
}
```

Wiring:

- `visualViewport.resize` and `visualViewport.scroll`, both debounced by `MW_VP_SETTLE_MS`, plus a
  leading call so the first frame is right.
- `orientationchange` and `window.resize`, same debounce.
- Called once on boot before the first paint of `.app`.
- **No `transform` is ever written.** The `visualViewport.scroll` handler exists only to recompute
  `--mw-vh` and `--mw-kb`; it does not move anything.

## C.3 The CSS contract

```css
/* Base: correct before JS runs, and correct on engines without visualViewport. */
.app { height: 100dvh; }

/* Refined: correct once the driver is live. dvh is the large-to-small dynamic
   unit, which handles browser chrome but NOT the soft keyboard on iOS. */
@supports (height: 1dvh) {
  .app { height: var(--mw-vh, 100dvh); }
}

/* 100vh is never used anywhere in the mobile stylesheet. It is the LARGE
   viewport and overflows under the browser chrome by design. */
```

Meta viewport gains one token:

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
```

`interactive-widget=resizes-content` makes Chromium shrink the layout viewport for the keyboard, so
on Android the CSS path alone is correct and the JS driver is a no-op refinement. iOS Safari ignores
the token today, so the driver carries iOS. This is the clean two-path story: **CSS handles Android,
JS handles iOS, and both write the same custom property.**

**`user-scalable=no` and `maximum-scale=1` are forbidden.** They break pinch zoom, which is an
accessibility affordance. The iOS focus-zoom problem is solved instead by the existing 16px minimum
font size on inputs (styles-mobile.css line 64), which must be preserved for every new input,
including the terminal input row (the mock draws it at 14px; **deviation: 16px on iOS**, or 14px with
a 16px `font-size` on focus, which is jankier; take the 16px).

## C.4 The permanent input row, and focus management against xterm

**Decision: on phones the terminal input row is always visible, and xterm's hidden textarea never
receives focus.**

The current design toggles a "Type" button which shows `.terminal-mobile-input-row.active` and,
separately, `TerminalPane.setMobileTypeMode()` flips `pointerEvents` on the textarea and the screen
and calls `term.focus()`. Two overlapping mode systems for the same intent is why focus fights xterm.
The mock draws the input row as permanent, which is both better UX and structurally simpler.

Consequences and the rules that make them safe:

1. `.terminal-mobile-input-row` loses its `.active` gate on phones and is always `display: flex` when
   the pane has a live terminal. The "Type" toolbar key is removed (its capability, showing the
   keyboard, is now just tapping the field).
2. `_mobileTypeMode` stays in `terminal.js` and stays reachable, because tablets and narrow desktop
   windows still use the desktop model, and because of rule 5. On phones it is never entered by the
   UI.
3. xterm's helper textarea keeps `pointer-events: none` (already the case in scroll mode) and gains a
   defensive `focus` interceptor on phones that blurs and re-focuses the input row unless raw-keys
   mode is on. Rationale: several paths can focus it programmatically (`focusTerminal`, the pane
   focus handler, `rebindHost`), and each one currently risks summoning the keyboard against a
   `.xterm-helper-textarea` that autocorrect will then corrupt.
4. `term.focus()` is not called on phones. The `focus`-based width claim
   (`_installVisibilityActivate`, textarea focus handler) therefore never fires on phones, which is
   the desired outcome per B.9 rule 3.
5. **Raw keys**, an explicit toggle in the pane overflow sheet, is the escape hatch for a CLI that
   needs per-keystroke input (a password prompt, a single-key menu, an autocomplete that reacts as
   you type). Turning it on enters the existing `setMobileTypeMode()` path, focuses xterm's textarea,
   and shows a persistent strip reading "Raw keys on. Autocorrect is off." Turning it off restores
   the input row. This preserves a capability that the always-on input row would otherwise remove,
   which the code-preservation rule requires.
6. Send behavior is unchanged from today: the field's text is sent as one `input` frame followed by
   `\r`. Long-press on Send offers "Send without Enter" and "Send Shift+Enter (newline)", covering
   the provider-specific newline case (Ink CLIs want ESC then CR).
7. The field keeps `autocomplete=off autocorrect=off autocapitalize=off spellcheck=false`? **No.**
   The whole reason the input row exists is that it is a normal text field where autocorrect helps.
   Keep autocorrect and spellcheck **on** for the input row (it is a message composer), and keep them
   **off** on xterm's textarea (it is a keystroke pipe). This distinction is currently blurred.

## C.5 The tab bar and the keyboard

Today: `body.keyboard-open .mobile-tab-bar { display: none }`. Keep the intent, fix the mechanics.

```css
@media (max-width: 768px) {
  /* The tab bar retracts when the keyboard is up, because the input row takes
     its place at the bottom of the visual viewport. Transform, not display,
     so there is no layout jump and no reflow of the terminal. */
  .mobile-tab-bar {
    transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
    will-change: transform;
  }
  body.mw-keyboard .mobile-tab-bar {
    transform: translateY(100%);
    pointer-events: none;
  }
  body.mw-keyboard .app-body { padding-bottom: 0; }

  /* When the tab bar is gone, the input row owns the bottom inset. max() because
     iOS reports safe-area-inset-bottom as 0 while the keyboard is up. */
  body.mw-keyboard .terminal-mobile-input-row {
    padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mobile-tab-bar { transition: none; }
}
```

`body.keyboard-open { position: fixed; width: 100%; overflow: hidden }` is deleted. With `.app` sized
to `--mw-vh` there is nothing to scroll, so the fixed-body hack is unnecessary and its scroll-loss
side effect is pure cost.

## C.6 Terminal resize while the keyboard moves

The keyboard changes rows, not cols. Every applied resize is a full ConPTY repaint on every attached
client, so resizing three times during a 250ms keyboard animation is three full repaints.

Rules:

1. Fit the active pane **once**, `MW_VP_SETTLE_MS` after the last viewport event. Never per event.
2. Fit only the pane that is `mobile-active`. `safeFit()` already bails on a zero-rect container, so
   the others are cheap no-ops, but skipping them entirely avoids the guard cost during the animation.
3. Suppress geometry claims for the whole settle window (B.9 rule 2).
4. If Select mode is on, `safeFit` already defers via `_fitDeferredWhileFrozen`. Keep that. A
   keyboard opening must never clear the user's selection.
5. Re-place the Select strip and recompute the toast anchor in the same pass, from the same measured
   custom properties.

## C.7 Safe-area insets

| Surface | Rule | Reason |
|---|---|---|
| `.app` | `padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right)` | Landscape notch. Currently unhandled; in landscape on a notched phone the leftmost terminal column is under the notch. |
| Header | `padding-top: env(safe-area-inset-top)` **only** inside `@media (display-mode: standalone)` | In a browser tab the OS chrome already covers the inset; adding it there produces a 47px dead band. |
| Bottom tab bar | `height: calc(64px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom)` | The mock's 64px is content height. Existing code uses 56px and the focused shell uses 60px; the restyle standardises on the mock's 64px. |
| Input row, keyboard closed | Nothing; the tab bar carries the inset below it | |
| Input row, keyboard open | `padding-bottom: max(env(safe-area-inset-bottom), 8px)` | iOS zeroes the home-indicator inset while the keyboard is up. `max()` keeps a finger-friendly gap either way. |
| Sheets, modals, action sheets | `padding-bottom: calc(16px + env(safe-area-inset-bottom))` | Already correct in `styles-mobile.css`; preserve it. |
| Toast anchor | Included in `--mw-tabbar-h` | Single source of truth. |
| Scroll bodies | `scroll-padding-bottom: var(--mw-tabbar-h)` | So `scrollIntoView` never lands a row under the tab bar. |

## C.8 Orientation change

1. Debounce with the same `MW_VP_SETTLE_MS`; both `orientationchange` and the subsequent `resize`
   fire, and on iOS the dimensions are briefly stale during the rotation animation. Read geometry
   after the debounce, never inside the event.
2. Recompute `--mw-vh`, `--mw-kb`, and the two chrome heights.
3. Re-run the toolbar priority-plus fit (B.7). Landscape at 844px wide fits every key plus the
   overflow.
4. Re-fit the active pane once, then claim geometry once if the app is foreground and Terminal is the
   active tab.
5. Re-render both tab strips. The existing `matchMedia('(max-width: 768px)')` change listener
   (app.js line 1595) already does this for the breakpoint crossing; extend it to fire on orientation
   even when the breakpoint does not change, because a 390x844 to 844x390 rotation crosses 768px in
   one direction only.
6. **Landscape phone (height <= 500px) layout adjustments**, because a 390px-tall viewport with a
   keyboard leaves roughly 150px of terminal:
   - The pane chip strip collapses into the header title (tap the title for the pane sheet).
   - The key toolbar keeps its five highest-priority keys plus the overflow.
   - The tab bar retracts whenever the keyboard is up (already) and can be retracted manually by a
     downward swipe on the toolbar, restoring on an upward swipe.
   - Section labels and the two-line header title collapse to one line.

---

# D. Ergonomics and the accessibility floor

## D.1 The 44px audit of the mock, with resolutions

The mock is a Notion-fidelity drawing, not a touch-audited layout. Nine elements are under the floor.
The floor wins (PROCEDURE section 4.1, and TEST-CONSTRAINTS section 9 pins 44px as the existing
guarantee). The resolution technique throughout is **keep the drawn visual size, expand the hit box**,
which is already the codebase idiom (`.terminal-tab-close::before { inset: -13px }`).

| # | Mock element | Drawn | Hit box | Resolution |
|---|---|---|---|---|
| 1 | Header icon buttons (search, overflow, back) | 32 x 32 | 32 | Keep 32px visual. Add `position: relative` plus `::before { content:''; position:absolute; inset:-6px }` for a 44 x 44 hit box. |
| 2 | Header avatar | 26 x 26 | 26 | Wrap in a 44 x 44 button with the avatar centred. The button, not the avatar, is the account-sheet trigger. |
| 3 | Pane chips | ~26 tall (4px padding, 12px text) | 26 | Raise the visual to 32px min-height (padding 7px 10px), then `::before { inset: -6px }` for 44. The strip container becomes 44px tall. |
| 4 | Key toolbar buttons (`nt-btn`) | height unspecified in the mock | n/a | Explicit `min-height: 44px; min-width: 44px`. This is what forces the five-to-six key count in B.7. |
| 5 | Input row field | 36 tall, 14px text | 36 | `min-height: 44px`, `font-size: 16px` (iOS zoom floor, C.3). |
| 6 | Input row image and mic buttons | 36 x 36 | 36 | `min-height: 44px; min-width: 44px`. The mock's 36px box grows; at 390px the row is field plus 3 x 44 plus 3 x 6 gaps plus 24 padding, leaving 216px of field, which is comfortable. |
| 7 | Input row Send | height 36 | 36 | 44. |
| 8 | Attention banner | ~34 tall | 34 | `min-height: 44px`; it is a tap target that navigates. |
| 9 | Tab badge | 15 x 15, 9px / 700 text | not interactive | Not a target, so no 44px rule, but 9px text is below the legibility floor and white-on-red is a contrast risk (D.4). Raise to 16 x 16 with 10px / 700, cap the count at "9+". |

Passing without change: tab bar items (64px tall, 78px wide at 390/5), active session cards (~56px),
recent rows (~52px), sheet rows (48px min-height already in `styles-mobile.css`).

## D.2 The hit-box expansion rule, stated once

```css
/* The project idiom for "small visual, legal target". Apply to every control
   whose drawn size is under 44px. The pseudo-element is transparent and
   inherits pointer events, so nothing changes visually and everything changes
   ergonomically. Ancestors must not clip it (no overflow:hidden on the row). */
.mw-touch-expand { position: relative; }
.mw-touch-expand::before {
  content: '';
  position: absolute;
  inset: calc((44px - 100%) / -2);   /* symmetric expansion to 44px, both axes */
}
```

Two constraints that make this fail silently if ignored, so they are stated explicitly:

- The nearest ancestor with `overflow: hidden` clips the expansion. The header, the chip strip and the
  toolbar all currently set `overflow: hidden` or `overflow-x: auto`. Use `overflow-x: auto;
  overflow-y: visible`? That is not a valid combination in CSS (a non-visible value on one axis
  computes the other to `auto`). Therefore for scroll containers, expand the **item's own padding**
  rather than using the pseudo-element, and keep the container's padding small.
- Adjacent expanded targets must not overlap, or the outer edges become dead. Minimum gap between two
  expanded 44px targets whose visuals are 32px is 12px. The mock's 6px to 10px gaps are therefore
  raised to 12px in the header and the input row.

## D.3 Thumb zones

On a 390 x 844 phone held one-handed, measured from the bottom edge:

| Band | Range | Reachability | What may live there |
|---|---|---|---|
| Green | 0 to 380px | Easy, thumb pivot | Tab bar, input row, key toolbar, sheet items, primary actions |
| Amber | 380 to 600px | Requires a grip shift | List content, secondary actions |
| Red | 600 to 844px | Two hands or a hand shuffle | Header, identity, navigation-only controls, section labels |

Rules that follow:

1. **The header carries navigation and identity only.** Back, title, provider chip, overflow, avatar.
   No destructive action, no frequent action. The one exception is Home's "+", justified because a new
   session is a deliberate, infrequent, two-handed act; a long-press on the Sessions tab (green band)
   is the one-handed route.
2. **Every action reachable from a red-band control is also reachable from a green-band one.** The
   pane overflow ("...", red band) is mirrored by long-press on a pane chip and by long-press on the
   Terminal tab.
3. **Sheets open from the bottom and are capped at six rows above the fold** so the first six choices
   are all green-band. Longer sets get a scroll with the same cap of six visible.
4. **Destructive items go last, after a separator**, and never within 60px of the sheet's top edge
   where a mis-swipe lands. `.as-danger` already exists and carries red ink; keep it.
5. **Cancel stays at the bottom** of an action sheet (the platform convention and the existing
   `.action-sheet-cancel`), even though that puts it in the greenest zone, because dismissing is the
   most common outcome of an accidental sheet.

## D.4 Contrast in the Notion light and dark chrome

The floor is PROCEDURE A1 and A2: 4.5:1 for body text, 3:1 for large text and UI boundaries, measured
per surface. Mobile-specific checks that the desktop pass will not catch:

| Pair | Surface | Risk | Resolution |
|---|---|---|---|
| Tab badge: `#fff` on `--app-text-red` | Tab bar | The Notion red text token is a mid red. White on it is near 4.4:1, which fails for 9px / 700 text. | **Deviation from the mock: use the wash-plus-ink form** (red wash background, red ink numeral), matching the desktop sidebar badge that DESIGN-SPEC 14.1 already describes. It passes trivially and it makes the two badges consistent. Document per PROCEDURE 4.3. |
| Attention banner: `--app-text-yellow` on `--app-bg-yellow` | Home | This is the pairing Notion itself uses and PROCEDURE 4.2 blesses. | Pass. Do not use yellow ink on the plain canvas anywhere on mobile. |
| Inactive tab label: `--app-text-tertiary` at 10px / 500 | Tab bar | Tertiary ink at 10px is small text and must clear 4.5:1 on `--app-bg-primary`. In Notion dark, tertiary on `#191919` is marginal. | Raise the inactive tab label to `--app-text-secondary` in dark, or raise the label to 11px / 500. Prefer the ink change; the mock's 10px is a deliberate density choice. |
| Terminal ink on terminal ground | Terminal | PROCEDURE A10 already requires all 16 ANSI colours to clear 4.5:1 on the ground, in both themes. On mobile the ground is the selected palette (DESIGN-SPEC 14.4 resolves the mock's discrepancy). | Reuse the desktop programmatic check; no mobile-specific work beyond running it at the mobile font size. |
| Pane chip inactive: `--app-text-secondary` on transparent | Chip strip | Secondary ink on the page ground at 12px. | Verify; if marginal, the inactive chip gains a 1px `--app-border-secondary` outline so the boundary clears 3:1 even if the ink is borderline. |
| Status dots at 6 to 8px | Everywhere | A 7px dot is a UI component and needs 3:1 against its ground, and colour is its only channel. | Every dot is paired with a text label or a chip that repeats the state. This already holds in the mock (activity string, provider chip) and must hold in the chip strip: an inactive chip's dot is accompanied by the chip's own name, and the pane header repeats the state in words. |
| Focus rings | All | A3 requires a visible ring on every interactive element in both themes. On touch, `:focus-visible` rarely triggers, but the app must still be keyboard-navigable on a phone with a Bluetooth keyboard. | Keep every existing `:focus-visible` rule (TEST-CONSTRAINTS pins five of them) and add matching rules for the five tab-bar items, the chip strip, and the input row controls. |
| Forced colours | All | A9 requires the existing `@media (forced-colors: active)` block to survive and to be extended to new components. | Extend it to: tab bar items, the badge, pane chips, the input row, and sheet rows. `outline: 2px solid Highlight` on the active tab and the active chip. |

## D.5 Reduced motion

PROCEDURE A7 is specific: decorative animation is written **inside**
`@media (prefers-reduced-motion: no-preference)`, not disabled inside `reduce`. Mobile animations to
audit:

| Animation | Where | Treatment |
|---|---|---|
| `mwPulse` on status dots | Home cards, attention banner, terminal header, chip dots | Wrap in `no-preference`. Under `reduce`, the dot is static and the state is carried by the text label that already accompanies it. |
| `sheet-up` on action sheets, modals, the account panel | Everywhere | Already handled for the account panel (styles-mobile.css line 1310). Extend to all three. Under `reduce`, sheets appear instantly. |
| `overlay-in` backdrop fade | Sheets | Instant under `reduce`. |
| Tab bar retract (C.5) | Terminal | `transition: none` under `reduce`; it snaps. |
| Toast in and out | Toasts | Instant under `reduce`; the toast still auto-dismisses on its timer. |
| Momentum scroll | Terminal | `TerminalPane.getSmoothScrollDuration()` already resolves to 0 under `reduce` (terminal.js). The **momentum engine itself is not decorative**: it is the scroll physics the platform would otherwise provide, so it stays on under `reduce`. Document this as a deliberate reading of A7: removing momentum would make the terminal harder to use, not calmer. |
| Skeletons | Lists | Skeletons over spinners (house style). Under `reduce`, the shimmer stops but the skeleton geometry stays. |

## D.6 Screen readers, focus order, and live regions

| Concern | Rule |
|---|---|
| Tab bar | `<nav aria-label="Views">` with five `<button role="tab">`? No: they are navigation, not a tablist over sibling panels in the ARIA sense once the views are separate screens. Use plain buttons with `aria-current="page"` on the active one. The existing markup is already `nav` plus `button` plus `aria-label`; keep it and add `aria-current`. |
| Badge | The count is announced via the tab's accessible name, "Attention, 2 items needing input", not via a separate live region. A live region on a badge that changes on every SSE tick is a screen-reader flood. |
| Attention changes | One `aria-live="polite"` region, updated at most once per 5 seconds, announcing only transitions into "needs input". |
| Terminal output | **Never a live region.** The Reader overlay is the accessible transcript; it is announced when opened. |
| Sheets | `role="dialog" aria-modal="true"`, focus moves to the first item (already implemented in `showActionSheet`), Escape closes (already), focus returns to the trigger (already via `_actionSheetReturnFocus`). Preserve all of it. |
| Focus order | Header, then content, then the bottom chrome (toolbar, input row), then the tab bar last. The tab bar last is deliberate: it is persistent chrome and a keyboard user should not traverse it before the content on every screen. |
| Heading structure | One `h1` per screen (the screen title), `h2` per section label. The mock's section labels are styled `div`s; make them headings. |
| Touch target announcement | Every icon-only control has an `aria-label`. The mock has three unlabelled icon buttons (search, back, overflow); label them. |

---

# E. Performance budget on a phone

## E.1 Targets, and the device they are measured on

Reference device: a mid-range Android, Pixel 6a class or a Snapdragon 6-series, throttled in
DevTools to 4x CPU slowdown for emulated runs. iPhone 12 or newer is the iOS reference.

| Metric | Budget | How measured |
|---|---|---|
| Bottom tab switch to first paint | < 100ms | Performance mark around `setViewMode` |
| Pane chip tap to painted terminal | < 150ms | Mark around `switchTerminalTab` through the `requestAnimationFrame` fit |
| Steady output at 60 lines per second | No frame over 16ms on the active pane | Long-task observer during a scripted output burst |
| History momentum scroll | No frame over 32ms; no dropped-frame run longer than 2 | Frame timing during a scripted fling |
| Keyboard open to settled layout | < 300ms including the single fit | Marks around the viewport driver |
| Boot to interactive, warm cache | < 1.5s | Navigation timing |
| Boot to interactive, cold 4G | < 4s | Throttled profile |
| Peak JS heap, 2 panes, 30 minutes | < 180MB | Heap snapshot |

## E.2 The xterm renderer at phone size

The app loads `vendor/xterm/xterm.min.js` with only `FitAddon` and `WebLinksAddon`. **No WebGL or
Canvas addon is loaded**, so xterm runs its DOM renderer.

Analysis at 390px: with `fontSize: 13` and JetBrains Mono, the advance is about 7.8px, so roughly 46
to 48 columns fit; with `lineHeight: 1.2` and a 400px-tall terminal, about 25 rows. The DOM renderer
emits one `<span>` per style run per row, typically 3 to 8 for CLI output, so a full repaint is on the
order of 100 to 200 element mutations. That is comfortably inside budget. **The DOM renderer is the
right choice on phones and should not be replaced**, for three additional reasons:

1. It keeps rows as real DOM text, which is what lets the platform paint a native selection over them
   (the codebase already relies on this; see the `_isMobile` regression comment in terminal.js).
2. WebGL contexts are a scarce, aggressively reclaimed resource on mobile Safari; a lost context in a
   terminal is a blank pane.
3. The measured cost driver is not per-cell rendering; it is **full-viewport repaints caused by PTY
   resizes** (ConPTY repaints everything on every applied resize). B.9 and C.6 attack that directly,
   which is worth far more than a renderer swap.

Font size becomes user-adjustable (11 / 12 / 13 / 14) in the pane overflow sheet. Note the coupling:
font size changes columns, columns change the geometry claim, so a font-size change triggers exactly
one debounced fit-and-claim.

## E.3 Scrollback and history caps

`terminal.js` constructs with `scrollback: 5000`. Cost is roughly `rows x cols x 12 bytes` for
xterm's buffer plus per-line overhead. At a phone's 48 columns that is small; at a desktop-owned 200
columns (which happens under shared-PTY ownership) it is roughly 12MB per pane, and four panes is
about 48MB of buffer before any DOM.

Rules:

| Cap | Phone | Reason |
|---|---|---|
| `scrollback` | 2000 | Roughly 5MB worst case per pane. The real history lives in the transcript on disk and is served by the mirror API, which the Copy view already consumes. xterm's buffer is a live window, not the archive. |
| Live panes | 2 | The third and later chips become dormant: socket closed, buffer released, chip shows a "tap to reconnect" dot. Reconnect replays scrollback from the server, which is the path the code already exercises on every reconnect. |
| Reader overlay text | 200k characters, tail-biased | `openTerminalReader` currently concatenates the entire buffer into one `textContent`. At 5000 x 200 that is a 1MB string plus a 1MB text node. |
| Copy view transcript page | 262144 bytes (existing `COPY_VIEW_TRANSCRIPT_PAGE_BYTES`) | Unchanged; already paged with "Load earlier". |
| History surface (future) | Windowed rendering, 200 rows in DOM, recycled | The contract in B.4 rule 2 is native scroll, so the window must be maintained by an `IntersectionObserver` sentinel, not by a scroll handler. |

**Dormancy is the single biggest memory lever and it is also a UX decision**, so it is surfaced: a
dormant pane keeps its chip, its name and its status dot, and reconnects in under a second. Users who
want three or four live panes on a phone are outside the design target; the desktop is for that.

## E.4 What is lazy-loaded

`app.js` is 1.14MB, `terminal.js` 254KB, `styles.css` 304KB, uncompressed. This project has no
bundler, so lazy loading means dynamic `<script>` and `<link>` injection on first navigation.

| Module | Trigger | Saving |
|---|---|---|
| QR code library | First open of Paired devices | The library is only used by `loadPairingCode` |
| Diff viewer | First "Diff" tap | |
| Kanban board rendering and drag machinery | First Tasks navigation | On a phone the board layout is not even used |
| `mirror-view.js` | First mirror pane | Already a separate file |
| `schedules.js` | First "Scheduled messages" | Already a separate file |
| Costs charts | First Costs navigation | |
| xterm plus `terminal.js` | First Terminal navigation | **The largest single win** if the user lands on Home, which is now the default tab |

Additional, non-splitting wins that cost nothing:

1. Verify the server sends `Content-Encoding` for `.js` and `.css`. 1.7MB of text compresses to
   roughly 350KB; if compression is off, that is the entire cold-start budget.
2. `<link rel="preconnect">` already exists for fonts. Add `rel="preload"` for the two font files
   actually used above the fold, and `font-display: swap`.
3. Defer `theme-registry.js` and `experience-model.js`? No: they run before first paint to set the
   theme and would cause a flash. Keep them blocking; they are small.
4. Pause background pane flushes when the Terminal tab is not active: background panes currently
   flush every 150ms; raise to 500ms when `viewMode !== 'terminal'`. The existing
   `visibilitychange` handler already pauses polling; this extends the same idea to the tab level.

---

# F. PWA polish worth shipping in this redesign

Current state: `manifest.webmanifest` exists and is minimal; `apple-touch-icon`, `favicon-32`,
`favicon-192` and a static `theme-color` are in `index.html`; `sw.js` is a three-line no-op that
installs, claims clients, and registers an empty `fetch` handler.

## F.1 Manifest

```json
{
  "id": "/",
  "name": "Myrlin's Workbook",
  "short_name": "Workbook",
  "description": "Manage Claude Code and Codex sessions",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Terminal",  "url": "/?tab=terminal" },
    { "name": "Attention", "url": "/?tab=attention" }
  ],
  "screenshots": [
    { "src": "/screenshot-home.png",     "sizes": "390x844", "type": "image/png", "form_factor": "narrow" },
    { "src": "/screenshot-terminal.png", "sizes": "390x844", "type": "image/png", "form_factor": "narrow" }
  ]
}
```

Changes and reasons:

- `id` is added so the install identity is stable across `start_url` changes.
- **Both icon entries currently point at the same `/logo.png` with different declared sizes.** The
  browser trusts the declaration, so one of the two is a lie and the install icon is resampled. Ship
  real 192 and 512 files.
- A **maskable** icon is added; without one, Android renders the icon inside a white circle with a
  visible square edge.
- `background_color` and `theme_color` move from the Catppuccin `#1e1e2e` to the Notion chrome. The
  splash screen currently flashes Catppuccin dark before a light-themed app paints.
- `orientation: "any"`. Do **not** lock to portrait: landscape is genuinely useful for a terminal.
- `shortcuts` give long-press-on-the-icon routes to the two high-frequency destinations. They require
  the `?tab=` query to be honoured at boot, which is one line in the boot sequence.
- `screenshots` with `form_factor: narrow` are what make the Chrome install prompt show a rich card
  instead of a bare bar.

## F.2 Theme colour synced to the chrome theme

```html
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#191919" media="(prefers-color-scheme: dark)">
```

Plus a one-line runtime update wherever the chrome theme is set, because the app has an explicit
light/dark toggle that can disagree with the OS preference:

```js
/** Keep the OS status-bar tint in step with the app's chrome theme. */
function mwSyncThemeColor(chrome) {
  const c = chrome === 'dark' ? '#191919' : '#ffffff';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = c; });
}
```

iOS additions, both cheap:

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Workbook">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
```

Use `default`, not `black-translucent`. `black-translucent` puts content under the status bar, which
requires the header to carry `env(safe-area-inset-top)` in standalone mode. C.7 already specifies that
padding, so `black-translucent` becomes safe **after** C.7 lands; treat it as a follow-up, not part of
the initial change, so a header regression cannot ship with it.

## F.3 Service worker: recommended, scoped, and last

**Recommendation: yes, ship it, in the final phase, behind a flag.**

The current `sw.js` already registers and claims clients with an empty fetch handler, so the app is
already "installable" but gains nothing from the worker. The value of a real one on this app is
narrow but real: the shell (HTML, CSS, JS, fonts, xterm) is 1.7MB uncompressed and completely static
between deploys, and the owner opens this app on a phone many times a day, often on a flaky
connection to a home network or a tunnel.

**Strategy**

| Resource | Strategy | Reason |
|---|---|---|
| `index.html` | Network first, 2s timeout, cache fallback | The HTML carries the `?v=` cachebusters for every other asset. A stale HTML pins stale everything. |
| `styles.css`, `app.js`, `terminal.js`, `focused-shell.css`, `semantic-theme.css`, `styles-mobile.css` | Stale while revalidate, keyed on the full URL including `?v=` | They are already versioned by query token, so the key is naturally correct. |
| Fonts, `vendor/xterm/*`, icons | Cache first, 30-day max age | Immutable in practice. |
| `/api/*` | **Never cached.** Bypass entirely. | Session state must never be stale. |
| WebSocket | Not interceptable, no action | |

**Cost:** roughly one to two days including the update story. The update story is the whole risk: a
stale shell talking to a new server is the classic PWA failure and it is worse here because the app
holds live WebSockets.

**Mitigations, all required:**

1. Cache name embedded with a build stamp; `activate` deletes every cache that does not match.
2. `skipWaiting` plus `clients.claim`, but only after showing a "New version available. Reload" toast
   with an action, so a reload never happens under the user's fingers mid-session.
3. A kill switch: if `/api/version` reports a server version the cached shell does not know, the
   worker unregisters itself and hard-reloads once.
4. Behind a flag (`?sw=1` or a Settings toggle) for the first release, so a bad worker is one query
   parameter away from being bypassed rather than a support incident.

**Note the interaction with TEST-CONSTRAINTS:** several tests pin the exact `?v=` cachebuster
literals. The worker must key on the full URL, and the build stamp must be a separate constant, so
bumping a cachebuster does not require touching the worker and vice versa.

---

# G. Verification plan

## G.1 Harness rules

- **Never port 3456.** That port serves a different checkout (see the project memory note). The QA
  script starts its own static harness on an ephemeral high port, serving `src/web/public`, and stops
  it in a `finally` block.
- Terminal behaviour that needs a real PTY is exercised against a **stub WebSocket server** started by
  the same script, which replays a recorded byte stream. This makes the terminal tests hermetic and
  deterministic, which the project memory explicitly flags as a requirement after the corpus-scan hang.
- Artefacts go to the session scratchpad, not into the repository. Screenshots are captured at
  viewport size with `deviceScaleFactor: 2` and immediately checked against the 2000px image rule
  before any of them is read into a model context.
- Every run records the numbers, not adjectives: measured heights, measured hit boxes, measured
  contrast ratios, frame timings.

## G.2 Device matrix

| Profile | Size | Why |
|---|---|---|
| iPhone 13 | 390 x 844, DPR 3 | The mock's exact target |
| iPhone SE (3rd gen) | 375 x 667, DPR 2 | Short viewport; the keyboard leaves the least terminal |
| Galaxy S8 / small Android | 360 x 740, DPR 3 | **The narrow case.** The toolbar priority-plus algorithm is decided here |
| Pixel 5 | 393 x 851, DPR 2.75 | Chromium plus `interactive-widget` path |
| iPhone 13 landscape | 844 x 390 | Section C.8 rule 6 |
| iPad Mini | 768 x 1024 | Exactly on the breakpoint; catches the `max-width: 768px` boundary bugs |
| iPad Mini landscape | 1024 x 768 | Confirms the phone rules do not leak onto tablets |

## G.3 Per-phase checklist

Phases map onto PROCEDURE section 2's retrofit order. Each phase's checks are additive; later phases
re-run the earlier ones.

**Phase T (tokens and base), after PROCEDURE steps 2 to 5**

- [ ] Contrast sweep: every mobile text-on-surface pair from D.4, both themes, measured, no pair under
      its floor. Output is a table of ratios, not a pass or fail claim.
- [ ] No `100vh` anywhere in `styles-mobile.css` or the phone blocks of `focused-shell.css`.
- [ ] `env(safe-area-inset-*)` present on the eight surfaces in C.7.
- [ ] `prefers-reduced-motion` audit: every mobile animation from D.5 is inside a `no-preference`
      block or has a `reduce` override.

**Phase L (layout and chrome), after PROCEDURE steps 6 and 7**

- [ ] Tab bar renders five items, in order, with `aria-current` on the active one, at all seven
      profiles.
- [ ] Bottom-chrome stack heights measured and written into `--mw-tabbar-h`, `--mw-toolbar-h`,
      `--mw-inputrow-h`; assert the toast anchor equals their sum plus the gap.
- [ ] **Toolbar overflow test:** at 360, 375, 390 and 430px, assert zero horizontally scrolled
      content in the key toolbar and that the overflow button is visible and 44px.
- [ ] **Toast occlusion test:** show a toast on the Terminal tab, then `elementFromPoint` at the
      centre of every key toolbar button and the input field; assert none of them returns a toast
      node. This is the direct regression test for the reported defect.
- [ ] **FAB test:** assert `.terminal-pane-schedule` and `.terminal-pane-upload` both compute to
      `display: none` at 768px and below.
- [ ] Screenshot Home, Sessions, Terminal, Attention, Search at all profiles, both themes.

**Phase P (primitives and touch targets), after PROCEDURE step 8**

- [ ] **44px sweep:** enumerate every element matching a broad interactive selector, compute its hit
      rect including any `::before` expansion, and report every one under 44 x 44 with its selector.
      Zero rows is the pass condition. This is the machine form of D.1.
- [ ] Adjacent-target overlap check: no two expanded hit rects intersect.
- [ ] Focus-visible sweep: keyboard-tab every screen and assert a visible ring at each stop, both
      themes.
- [ ] Forced-colours pass: `forcedColors: 'active'` in the emulation context; assert boundaries
      survive on the tab bar, chips, sheet rows and the input row.

**Phase C (composites and IA), after PROCEDURE step 9**

- [ ] Run `test/mobile-ia-contract.test.js` (A.5): every capability has a route marker; no capability's
      only marker is inside `.terminal-pane-header` or a hover-guarded block.
- [ ] Walk every route in A.3 by script, asserting the target surface appears. This is the "nothing is
      unreachable" proof and it is the single most valuable check in this plan.
- [ ] Sheet behaviour: opens, first item focused, Escape closes, focus returns to the trigger, tap
      outside closes, drag handle dismisses.
- [ ] Long-press zone test: synthesise a 450ms hold on one member of each zone; assert Text produces a
      selection and no sheet, Affordance produces a sheet, Chrome produces neither.
- [ ] Swipe guard test: a 90px horizontal swipe in the terminal body does **not** switch panes; a
      110px one does; neither does while a selection exists.

**Phase X (terminal), after PROCEDURE step 13**

- [ ] Against the stub PTY: 2000 lines of output, assert no long task over 50ms and no frame over 16ms
      on the active pane.
- [ ] Fling scroll through history: no frame over 32ms.
- [ ] Keyboard open and close cycle: assert exactly one `resize` frame is sent to the stub, not three.
- [ ] Assert no `activate` frame is sent while the Sessions tab is active.
- [ ] Assert `scrollback` is 2000 at phone widths.
- [ ] Reader overlay with a 5000-line buffer: assert the injected text is capped and open time is
      under 300ms.
- [ ] Copy view at phone width: assert `top` is 0 (the hidden-header case in `_copyOverlayTopPx`) and
      that every bar control measures at least 40px, rising to 44px per D.1.

**Phase W (PWA), last**

- [ ] Manifest validates; icons resolve at their declared sizes; maskable icon present.
- [ ] `theme-color` matches the active chrome theme after a theme switch.
- [ ] With the worker enabled: cold load, then offline reload serves the shell; `/api/*` requests are
      not served from cache; the update toast appears when the build stamp changes.

## G.4 What emulation cannot prove

Playwright device emulation resizes a desktop browser and fakes touch events. It is genuinely useful
for layout, reachability, contrast and target size, and it is genuinely blind to everything below.
Every item here has burned someone before.

| Cannot prove | Why | Consequence if untested |
|---|---|---|
| Momentum scroll feel | Emulated touch has no real velocity profile, and the compositor path differs | The custom momentum engine can feel wrong (too slippery, too sticky) while every automated check passes |
| Native selection handles and the callout bar | Not rendered by the emulator at all | The whole Text-zone premise in B.2 and B.4 is unverified until a finger touches glass |
| Real soft keyboard geometry | The emulator has no keyboard; `visualViewport` never shrinks | C.2 through C.6, the largest section of this document, is entirely unverified by emulation |
| Predictive text, autocorrect, IME composition | No IME in the emulator | The input row's autocorrect decision (C.4 rule 7) is unverified |
| Safe-area insets | `env()` resolves to 0 in the emulator | Notch and home-indicator layout is unverified |
| Haptics | `navigator.vibrate` is a no-op in the emulator and unsupported on iOS entirely | Long-press confirmation may be silent on iPhone |
| PWA standalone chrome | Emulator runs in a tab | Status bar tint, splash screen, safe-area-in-standalone are unverified |
| Touch latency and scroll anchoring under live output | Timing fidelity is not there | Text jumping under the finger during output is the classic terminal-on-phone complaint |
| Android back gesture versus edge swipe | No system gesture layer | R2 is unverified |
| `pointer: coarse` detection | The emulator sets it, but real devices have surprised this codebase before (see the `_isMobile` regression comment) | The engine could fail to engage on a real device |
| Real network on cellular | Throttling profiles approximate but do not reproduce latency variance | Boot budget is approximate |

## G.5 The human test script

Ten minutes on a real phone, after each phase that touches the terminal or the keyboard. Written so it
can be run without reading anything else. Record pass, fail, or "feels wrong" plus one sentence.

1. **Install.** Add to Home Screen. Open from the icon. Does the splash colour match the app, and does
   the status bar tint match the theme?
2. **Land.** Which tab opens? Can you read the attention banner and tell how many sessions want you,
   without scrolling?
3. **Reach.** Holding the phone one-handed, can you reach every tab, the input field, and every key on
   the toolbar with your thumb, without shifting your grip?
4. **Open a session.** Tap a session on Home. Does it open in the terminal within a second?
5. **Type.** Tap the input field. Does the keyboard appear without the layout jumping? Is the input
   field fully visible above the keyboard? Is the key toolbar still visible above the input field?
6. **Send.** Type a short message and send it. Does the keyboard stay up? Does the terminal scroll to
   the new output?
7. **Keys.** With the keyboard open, tap Ctrl+C and then Esc. Did the taps land on the buttons, or did
   something invisible eat them?
8. **Toast.** Trigger a toast (copy something). While it is visible, try to tap the key underneath it.
   Does the key respond?
9. **Scroll.** Flick up through the output. Does it feel like a native scroll, or does it stick or
   overshoot? Flick to the very top and the very bottom; does it rubber-band or jam?
10. **Select.** Press and hold on a line of terminal output. Do you get selection handles, or a menu?
    Drag a handle. Does the selection extend? Does the output stop moving while you do it?
11. **Copy.** Copy the selection. Paste it into any other app. Is it correct?
12. **Long-press the chrome.** Press and hold on the toolbar background, then on the header. Does
    anything unexpected appear?
13. **Rotate.** Turn the phone to landscape with the keyboard open, then back. Is anything cut off,
    doubled, or under the notch?
14. **Two devices.** Open the same session on the desktop. Type on the desktop, then type on the
    phone. Does the phone's text stay readable, or does it wrap into unreadable width? If it wraps,
    is there a visible way to take the width back?
15. **Background.** Switch to another app for two minutes. Come back. Is the session still live? Did
    it repaint at the right width?
16. **Attention.** Make a session ask a question. Does the badge appear on the tab? Does the phone tell
    you within a few seconds?
17. **Reachability spot-check.** Without using search, find: Costs, Paired devices, Project notes,
    Scheduled messages, and the microphone. Time each. Anything over 15 seconds is an IA failure.

---

# H. Risks, tradeoffs, and open decisions for the orchestrator

## H.1 Decisions taken in this document that carry real cost

| Decision | Benefit | Cost | Reversibility |
|---|---|---|---|
| Dissolve the More tab into Home > Workspace | Frees a tab slot for Attention and Search; ends the drawer of forgotten features | Utility views become two taps instead of two taps; roughly equal. Requires the Home screen to grow a fourth block the mock does not draw. | Easy. `showMoreMenu` stays wired for the classic shell. |
| Permanent input row, no Type toggle | Removes an entire mode system and the focus fight with xterm | Loses per-keystroke input unless Raw keys is on. A user who lives in a CLI's interactive autocomplete will notice. | Easy. `_mobileTypeMode` is retained. |
| Key toolbar drops to five or six keys plus overflow | Ends the horizontal-overflow defect; every visible key is 44px | Two of the mock's seven keys move one tap away | Easy. Priority order is a constant. |
| Remove the edge-swipe sidebar drawer | Returns the edge to the OS back gesture; removes a gesture conflict | A familiar gesture disappears. Mitigated by the drawer's contents becoming a first-class tab. | Medium. Re-adding it re-creates the conflict. |
| No drag and drop on phones | Removes a polyfill conflict with terminal touch handling | Session-to-pane drag is gone on phones | Easy. |
| Scrollback 2000 and two live panes | Bounds memory | Less local history; a third session must reconnect | Easy, both are constants. |
| Tab badge uses wash plus ink instead of the mock's solid red | Passes contrast; matches the desktop badge | Visibly less loud than the mock draws | Easy. |
| Kanban becomes a segmented list on phones | Usable at 390px | Diverges from the desktop board | Easy; the board is retained above 768px. |

## H.2 Risks that need watching

1. **The shared-PTY width problem is not fully solvable on the client.** Everything in B.9 reduces
   thrash; only the backend fix (alternate-buffer-aware replay plus ownership debounce) removes it.
   If the backend work slips, ship B.9 rules 1 to 5 anyway: they turn a mysterious unreadable screen
   into an explained one with a fix button, which is most of the felt improvement.
2. **`interactive-widget=resizes-content` changes Android layout behaviour globally.** It is the right
   answer, but it must be verified on a real Android device before it ships, because it interacts with
   every `position: fixed` element in the app, and this app has several with hard-won stacking rules
   (the account sheet backdrop comment in `styles-mobile.css` is a monument to that).
3. **The five-tab bar breaks a `deepStrictEqual` pin.** That is expected and handled in A.6, but it
   means the IA change cannot be split across commits from the test edit.
4. **`:has()` support for the toast rule.** Older WebKit lacks it. The `.toast-notice` class fallback
   is mandatory, not optional.
5. **Removing the pane-container long-press listener could orphan a route** if any capability reaches
   the pane sheet only that way. A.3 says it does not (the sheet is reachable from the header overflow
   and from a chip long-press), but the A.5 test is what actually proves it.
6. **Lazy-loading `terminal.js` changes boot ordering.** `TerminalPane` static state (theme palettes,
   smooth-scroll setting) is read at construction; deferring the file must not defer the theme
   application. Verify the theme is applied from `theme-registry.js`, which stays blocking.
7. **The service worker is the highest-risk item in this document** and is deliberately last and
   flagged. A stale shell against a live WebSocket protocol is a bad failure mode.

## H.3 Open decisions the orchestrator should make

1. **Default landing tab.** Home is assumed. Terminal is defensible for an owner who opens the app to
   check on a running session. Recommendation: Home, with `?tab=` and the manifest shortcuts covering
   the alternative, plus a Settings preference.
2. **Should the terminal input row send per-character when the CLI is in an interactive prompt?**
   This document says no by default, with Raw keys as the escape hatch. An alternative is to detect
   the alternate screen buffer (the app already tracks it) and auto-enable Raw keys there. That is
   more magical and could surprise; it is also potentially much better. Needs a field test.
3. **Font size default on phones.** 13px yields about 46 columns at 390px, which wraps a lot of CLI
   output. 12px yields about 50. The mock draws 12px. Recommendation: 12.5px default with the
   11 to 14 control, matching the DESIGN-SPEC's "12px / 1.7 mobile" note within a half pixel.
4. **Whether the Attention tab replaces toasts for completions.** Two channels for the same signal is
   noise. Recommendation: toasts for transitions while the app is foreground, the Attention tab as the
   durable record, and no toast for a completion the user is already looking at.
5. **Service worker in this program or the next.** Recommendation: in this program, last phase,
   flagged.
6. **Whether tablets get the phone IA or the desktop one.** This document assumes desktop at 769px and
   up, which means an iPad Mini in portrait (768px) gets the phone IA and in landscape gets the
   desktop one. That is a jarring rotation. Recommendation: a third breakpoint at 900px, phone IA
   below, desktop above, so the iPad Mini is consistently the phone IA in portrait and the desktop in
   landscape only above 900px. This needs a decision because it affects every `max-width: 768px` rule
   in the codebase.

---

## Appendix: the custom-property contract

Every measurement this document introduces, in one place, so implementers do not invent parallel
constants.

| Property | Written by | Read by |
|---|---|---|
| `--mw-vh` | viewport driver (C.2) | `.app` height |
| `--mw-kb` | viewport driver | Diagnostics; sheet max-heights |
| `--mw-tabbar-h` | static CSS, `calc(64px + env(safe-area-inset-bottom))` | Toast anchor, `app-body` padding, `scroll-padding-bottom` |
| `--mw-toolbar-h` | viewport driver, measured | Toast anchor, Select-strip placement |
| `--mw-inputrow-h` | viewport driver, measured | Toast anchor, Select-strip placement |
| `--mw-toast-gap` | static, 8px | Toast anchor |
| `MW_LONGPRESS_MS` (JS) | constant, 400 | Both long-press paths |
| `MW_LONGPRESS_MOVE_PX` (JS) | constant, 8 | Both long-press paths |
| `MW_VP_SETTLE_MS` (JS) | constant, 150 | Viewport driver, fit debounce, claim suppression |
| `MW_KEYBOARD_MIN_INSET_PX` (JS) | constant, 120 | Keyboard detection |
| `MW_SWIPE_MIN_PX` (JS) | constant, 96 | Pane swipe guard |
| `MW_SWIPE_EDGE_PX` (JS) | constant, 32 | Pane swipe guard, R2 |
| `data-mw-zone` | markup | Long-press zone model (B.2) and its test |
| `data-mw-route` | markup | IA contract test (A.5) |
