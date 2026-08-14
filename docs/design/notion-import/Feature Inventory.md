# Myrlin Workbook — Feature Inventory

Every feature found in the original app (source: `src/web/public/index.html`, `terminal.js` surfaces, `theme-registry.js`, `provider-specs.js`, `instance-colors.js`, `experience-model.js`, `docs/WORKFLOWS.md`, `docs/images/*`), mapped to the Notion redesign (`Myrlin Workbook (Notion Redesign) v2.dc.html`).

Legend: ● built in redesign · ◐ partial / merged elsewhere · ○ not built yet (accounted for, buildable on request)

## Header
| Original | Status | Where in redesign |
|---|---|---|
| Logo + app title | ● | Sidebar workspace header |
| Account chip (avatar, name, reset countdown) | ● | Topbar chip "Gayane · 42%" |
| Account panel: usage meters per limit (Session/Opus/Fable) | ● | Click account chip → usage popover with 3 bars + resets |
| Account panel: switch credentials, re-login warning | ● | Popover rows + Settings → Accounts |
| Account panel: provider tabs (Claude/Codex) | ◐ | Single list; provider chips on rows |
| Account panel: machines strip (PC/Mac sync), pending per-machine selections | ○ | Noted; needs multi-machine model |
| View tabs: Workbench / Sessions / Tasks | ● | Sidebar nav (Notion idiom) |
| More menu: Costs | ● | Sidebar nav → Costs view (period selector, by-project, by-model) |
| More menu: Recent | ◐ | Sessions table "Last active" column (sorted data) |
| More menu: Docs (Project Notes) | ○ | Peek Notes covers per-session notes; per-project notes board not built |
| More menu: Resources (System Resources, auto-refresh) | ○ | Not built |
| More menu: Appearance modal | ● | Merged into Settings → Interface |
| Attention button + count | ● | Sidebar Attention + red badge |
| Session manager overlay: Select All / Stop Selected / filter tabs | ◐ | Attention popover with Stop all; bulk checkbox selection not built |
| Conflict Center overlay (file conflicts, refresh) | ◐ | Conflict-detection toggle in Settings; overlay not built |
| Usage meter bars in header | ● | Moved into account popover (cleaner topbar) |
| Quick Switcher button (Ctrl+K) | ● | Sidebar Search + ⌘K / ⌘P |

## Sidebar
| Original | Status | Where |
|---|---|---|
| New Session button | ● | Sidebar footer + topbar button + project ctx menu |
| Provider tabs above Projects | ○ | Provider chips shown per-row instead |
| Projects accordion (dot, name, session count, live activity) | ● | Projects section with running-count pulse |
| Project active accent + expanded session rows (status dot, activity, time) | ● | Selected wash (no side-bars) |
| Refresh projects / New project buttons | ◐ | Project ctx menu (New session here, Rename, Hide, Delete); refresh not needed in prototype |
| Show hidden projects/sessions | ● | "Show hidden (n)" row + per-session Hide/Unhide ctx |
| Projects ⇄ Discovered section resize handle | ◐ | Whole-sidebar drag resize built; inner section split not |
| Discovered section (project rows, count, size) | ● | "Discovered on this machine" |
| Filter input (projects / session IDs) | ◐ | ⌘K Quick Find filters everything |
| Find a Conversation (full-text transcript search) | ◐ | Quick Find footer row "Find in conversations" |
| Collapse sidebar | ○ | Drag-resize built; collapse toggle not |
| Sidebar drag-resize | ● | Drag right edge (200–420px) |

## Workbench (terminal area)
| Original | Status | Where |
|---|---|---|
| Tab groups bar (positional colors red/yellow/green/teal/blue/mauve) | ● | Pill tabs with positional dots (instance-colors order) |
| Tab group counts, + new group | ● | Pills + ghost + |
| Tab group right-click: rename / duplicate / close | ● | Ctx menu |
| Tab group drag-reorder | ● | Drag pills |
| Pane grid 1–4 panes | ● | Grid; drop slot when <2 panes |
| 6-pane layouts | ○ | Lives as a task card on the board ("6-pane grid layouts") |
| Pane resize (split drag) | ● | Drag the gutter between 2 panes (25–75%) |
| Pane header: status dot, title, provider, activity, needs-input | ● | Pane header (sheds chrome when narrow) |
| Pane actions: copy transcript, menu, close | ● | Header buttons + ⋯ menu |
| Pane fullscreen / font size | ○ | Not built |
| Drag session → pane / drop slot | ● | With blue drop highlight |
| Pane focus shortcuts ⌘1–4 | ● | Focus ring |
| Pane color highlights (per-slot color) | ● | Settings toggle "Pane color highlights" |
| Terminal input row | ● | Prompt ❯, image attach, mic (pulses while listening), ⏎ hint |
| Shift+Enter newline (provider-specific, Ink ESC+CR) | ◐ | Hint text; real PTY behavior is backend |
| Provider idle/needs-input detection (claude/codex regexes) | ◐ | Simulated via status model |
| Empty state (drop zone) | ● | Dashed drop slot |
| Workbench empty-state onboarding card | ◐ | Drop slot copy covers it |

## Session model & states
| Original | Status | Where |
|---|---|---|
| States: Running / Needs input / Failed / Complete / Stale / Idle / Stopped | ● | Full chip + dot color system (experience-model.js parity) |
| Density: Quiet / Informative | ● | Settings toggle "Informative density" |
| Auto-title sessions | ● | Settings toggle + session ctx "Auto-title" |
| Auto-trust safe prompts, hold risky ones | ● | Settings toggle + Attention "held" reason + transcript line |
| Idle/complete notifications | ● | Settings toggle |
| Conflict detection (two sessions, same files) | ● | Settings toggle |
| Instance colors (same session open in several panes) | ◐ | Positional tab dots; per-instance badge not built |

## Sessions database view
| Original | Status | Where |
|---|---|---|
| Session list + filters | ● | Notion table + pill filters (All/Running/Needs input/Stopped) |
| Discover sessions on this PC | ◐ | Sidebar Discovered section |
| Session detail panel (info grid, actions, activity log) | ● | Side peek: 8 properties, actions, notes, last output |
| Notes per session (persisted) | ● | Peek Notes → localStorage |
| Rich notes editor (bold/italic/lists/checklist toolbar) | ○ | Plain textarea for now |
| Activity log (full) | ◐ | "Last output" tail in peek |
| Copy session ID / transcript | ● | Peek buttons + ctx menu |
| Stop / Resume / Restart | ● | Peek + ctx menu |
| Rename (dbl-click), Summarize, Move to project, Hide, Remove | ● | Ctx menu + inline rename |
| Bulk select / stop selected | ○ | Attention "Stop all" covers the common case |
| Drag row → Workbench | ● | Drag onto pane/slot |

## Agent tasks (worktrees)
| Original | Status | Where |
|---|---|---|
| Worktree board (columns, cards, live output line) | ● | 5-column board, drag between columns |
| New Agent Task dialog (branch preview, model, tags, start now) | ● | Dialog + ⌘⇧N |
| Merge / Push / Diff on review cards | ● | Card buttons + ctx menu |
| Diff viewer (file list, hunks, +/− stats) | ● | Modal with merge/push |
| PR creation dialog (title/body/base) | ○ | Push toasts "open a PR"; dialog not built |
| Task spinoff dialog (split into parallel tasks) | ○ | Not built |
| td integration (issues tab, issue detail, promote to worktree) | ○ | Settings toggle exists; td panel not built |
| Git tab / Files tab | ○ | Placeholders in original too |

## Launcher & dialogs
| Original | Status | Where |
|---|---|---|
| Session Launcher (directory, provider, model, flags, initial prompt) | ● | New session dialog |
| Session templates (save/apply) | ● | Template chips + "Save as template" |
| Folder browser modal | ○ | Select stand-in |
| Generic confirm/prompt modal | ◐ | Toasts + confirm-close setting |
| Update Myrlin modal | ○ | Not built |
| Pair Mobile Device (QR / manual, cloudflared tunnel) | ○ | Mobile screens exist; pairing modal not built |

## Search
| Original | Status | Where |
|---|---|---|
| Quick Switcher (Ctrl+K) | ● | ⌘K / ⌘P Quick Find |
| Global search Ctrl+Shift+F (all sessions) | ◐ | Merged into Quick Find + "Find in conversations" row |
| Find a Session modal | ◐ | Same |

## Appearance & themes
| Original | Status | Where |
|---|---|---|
| Featured choices: System / Myrlin Dark / Myrlin Light | ● | Settings → Terminal theme pills (theme-registry.js parity) |
| All 13 themes (Mocha, Macchiato, Frappé, Nord, Dracula, Tokyo Night, Cherry, Ocean, Amber, Mint, Latte, Rose Pine Dawn, Gruvbox Light) | ● | "More themes…" select; palettes drive every terminal surface + ❯ prompt accent |
| App chrome light/dark | ● | Notion light/dark; topbar toggle + Tweak |
| UI scale (85–120%) | ○ | Not built |
| Information density | ● | Toggle |

## Mobile
| Original | Status | Where |
|---|---|---|
| Bottom tab bar, session cards, terminal + key toolbar | ● | Myrlin Workbook Mobile (Notion Redesign).dc.html |
| Image attach + mic in input row | ● | Added |
| Pair device / remote access | ○ | Not built |

## Not carried over (deliberate)
- One-side accent highlights (left-border active bars, tab underlines) — replaced everywhere with Notion washes/pills per direction.
- Catppuccin as the app chrome — original themes now live in the terminal surfaces; chrome is Notion light/dark.
