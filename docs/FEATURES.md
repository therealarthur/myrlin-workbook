# Features

This is the exhaustive list of what Myrlin Workbook does today. The
[README](https://github.com/therealarthur/myrlin-workbook/blob/main/README.md)
is the tour; this file is the inventory. If a capability exists, it is on this
page.

Setup, configuration, keyboard shortcuts and troubleshooting live in
[SETUP.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/SETUP.md).

---

## Discovery and organization

- **Session discovery.** Scans `~/.claude/projects/` and finds every Claude Code
  session you have ever run. Codex sessions are read from `~/.codex`: the
  `state_5.sqlite` thread store the ChatGPT desktop app itself lists from, plus
  the rollout JSONL under `~/.codex/sessions/`. Both reads are read-only.
- Shows project directory, session count, size on disk and last active time.
- Auto-titles sessions from conversation content.
- Import discovered sessions into a project with one click.
- **Provider switcher.** An All / Claude Code / ChatGPT Codex control inside the
  Discovered section header. It filters the Discovered list and nothing else;
  your tracked projects are never filtered by it.
- **Recent list.** A merged, cross-provider list of what you were last in, at
  the top of the sidebar.
- **Project management.** A three-level hierarchy:

  ```
  Category ("Side Projects", "Work")     optional top-level grouping
    Project ("Myrlin Workbook")          the codebase, the main container
      Focus ("UI Polish", "Backend")     sub-groups within a project
        Sessions                         individual CLI conversations
  ```

  - **Categories** group related projects, for example "Work" against
    "Side Projects".
  - **Projects** are the main containers, one per codebase, with color coding
    and their own docs.
  - **Focuses** are sub-groups within a project for different areas of work.
- Drag and drop sessions between projects and into terminal panes.
- Tab groups are free-form: mix sessions from any project in any tab.
- **State persistence.** JSON on disk. Survives crashes and restarts.
- **Auto-recovery.** On startup the app checks the PID of every session it
  believed was running, detects orphans and restores state.

## Terminals

- **Terminal grid** built on xterm.js, node-pty and a WebSocket. A real PTY, not
  a rendered log. On Windows that is ConPTY directly, with no WSL.
- **Tab groups.** Named sets of terminal panes ("Research", "Debug"),
  switchable and persistent.
- **Tab close buttons** with a live-session kill confirmation dialog.
- **Drag and hold tab grouping.** Hold 1.2s over another tab to create a folder.
- **Cross-tab terminal pane dragging.** Move sessions between panes freely.
- **PTY sessions survive a page refresh**, with scrollback replay on reconnect.
  A pane whose sign-in was invalidated by a server restart waits for the new
  sign-in and reconnects itself instead of dead-ending.
- **Model selection** per terminal (Opus, Sonnet, Haiku for Claude).
- **Right-click context menu:** Copy, Stop, Restart, model picker.
- **Bracketed paste**, applied only when the running application asked for it.
  Multi-line pastes are normalized so one line break is one Enter, and an
  end-of-paste marker inside pasted text is stripped rather than honored.
- **Message row** at the bottom of every desktop pane: prompt, field, image
  button, microphone, Send.
- **Scheduled messages** and **pinned notes** per pane.

### Scrollback and copying

- Wheel up past the top of what a pane has drawn and it continues into the
  recorded conversation. Same background, same typeface, same line spacing. No
  panel, no banner, nothing to switch on.
- Hold Shift and the wheel always goes there, whatever the pane is running.
- One drag from the current screen up into earlier output selects a single
  continuous stretch; `Ctrl+C` copies it.
- `Ctrl+Shift+A` selects the whole document, history included.
- `Shift+PageUp` and `Shift+PageDown` page through it, `Escape` leaves, and
  typing anything leaves and types.
- A quiet six-pixel scrollbar appears on the right edge while you move and
  fades out afterwards.
- Output keeps flowing while you read. What pauses is the copy of the screen
  you are selecting on, so nothing queues up and catches back up in a rush.
- Terminal buffer is 10,000 lines on desktop and 2,000 on phones. The full
  history is on disk and the history surface reads it from there.
- A long history is held in blocks, so only the blocks near what you are
  reading keep their text in the page. Select-all still selects everything.
- **Copy view** overlay with a raw terminal snapshot and a paged full
  transcript.
- **Reader** view, capped at its last 200,000 characters with a line saying so.
- An optional deeper server-side line log for shells and build logs, behind
  `CWM_VT_SIDECAR=1`.

## ChatGPT Codex

- Codex projects and sessions match what the ChatGPT desktop app shows, because
  they are read from the same `state_5.sqlite` thread store. The read is done on
  an in-memory byte image through sql.js, so no write handle is ever opened
  against your Codex data.
- The filesystem walk over `~/.codex/sessions/**/rollout-*.jsonl` remains as a
  fallback for machines where the desktop app has never run.
- **Session details** show the model, reasoning effort, approval policy and
  sandbox that the session is actually running, read from the conversation
  itself. Anything genuinely unknown says so rather than being filled in with a
  guess.
- The menus you change those values from offer exactly what the CLI will accept
  when the session next starts, and the sandbox setting displays as its name
  rather than its raw policy record.
- Resume through `codex resume <id>`.
- **Token usage** is shown for Codex sessions. There is no published price for
  them, so no dollar figure is invented; the real token count is what you see.
- **Account switcher** with provider tabs, identifying the active account by
  filename without ever opening its contents.
- Codex plan usage (plan, window used, reset time, credit balance) is read from
  your own disk rather than fetched, so it works offline.
- Cross-provider search covers Codex sessions, and a Codex result is labelled
  with its folder name on every platform.

## Cost tracking

- Per-session and per-project cost breakdown: input, output, cache write and
  cache read tokens.
- Parses Claude's JSONL usage fields and applies per-model pricing.
- Parsing runs on a worker thread so a large transcript never stalls terminal
  I/O.
- **Costs dashboard** with a period selector: Day, Week, Month, All.
- **SVG timeline chart** of spend over time, with a model breakdown.
- **Sortable session table.** Rank sessions by cost, tokens or duration.
- Context growth tracking: latest and peak input tokens per session.

## Session management

- **Session manager overlay.** Click the header stats to open it. Full session
  control from one place.
- **Mass selection and batch stop.** Select several sessions, stop them
  together.
- **Filters:** All, Running, Needs input, Stopped, with counts.
- **One-click terminal open** from any session manager row.
- **Session templates.** Save a launch configuration (working directory, model,
  flags, spawn options) and launch from it in one click.
- **Quick switcher.** `Ctrl+K` or `Cmd+K` opens a fuzzy search across every
  session and project.
- **Attention queue.** Sessions waiting on you, sessions that failed and
  sessions that finished, grouped in one place.
- **Paired devices** with QR code pairing, so a phone signs in once.

## Docs and planning

- **Per-project docs:** Notes, Goals, Tasks, Rules and Roadmap sections.
- **Feature board**, kanban style: Planned, Active, Review, Done.
- **Markdown editor** with a formatting toolbar.
- **AI Insights tab:** auto-generated summaries of a project's sessions.
- **Summarize to Docs** writes a session summary into the project's docs.

### td integration (optional)

Myrlin optionally integrates with [td](https://github.com/marcus/td), a
minimalist CLI task manager built for AI agent workflows. When `td` is installed
and initialized in a repo, Myrlin surfaces its issues in the docs panel and the
sidebar, so you do not have to switch to a terminal to read them.

Install td:

```bash
go install github.com/marcus/td@latest
```

Enable it under Settings, td Task Management. Set the binary path if `td` is not
on your PATH, for example `~/.local/bin/td` or `~/go/bin/td`.

**Worktree promotion.** Click "Worktree" on any td issue to create a git
worktree and a session in one action, with the issue description passed as the
opening prompt.

## Conflict detection

- **Real-time file conflict warnings** when two or more running sessions are
  editing the same files. Runs `git status` across active sessions and
  cross-references the modified files.
- **Conflict center** with a per-file breakdown and session attribution.
- Click a session chip to jump straight to that session's terminal pane.

## Git, worktree tasks and PR automation

- **Git status per project:** current branch, dirty or clean, ahead or behind
  the remote.
- **Branch listing and worktree CRUD:** create, switch and delete from the UI.
- **New Feature Session.** Right-click a project to create a branch, a worktree
  and a session in one action.
- **Kanban task board** with five columns: Backlog, Planning, Running, Review,
  Done, with drag and drop.
- **PR automation.** Create GitHub PRs through the `gh` CLI, with descriptions
  generated from the diff.
- **PR state tracking.** Badges on cards for open, draft, merged and closed,
  with auto-advance on merge.
- **Multi-model orchestration.** Assign a model per task and a default model per
  workflow stage, auto-assigned on column transitions.
- **Task dependencies.** Blocking relationships with visual indicators on cards.
- **Cross-cutting tags.** Color-coded tag badges, searchable, editable from the
  context menu.
- **Concurrent task limits.** Configurable maximum of 1 to 8, enforced on create
  and on column drag.
- **Worktree init hooks.** Copy files and run scripts after a worktree is
  created.
- **Branch badges** on session rows.
- **Task search.** Filter the board by branch, description, model, status or
  tags.
- **Live terminal preview.** A running task card shows its last terminal line.

## Search

- Cross-provider search over sessions, commands, past conversations and help.
- On a phone, Search is its own tab with chips for what you are looking for.

## Themes

- **Two chrome themes**, light and dark, toggled from the topbar or from
  Settings, Interface, Appearance.
- **Thirteen terminal palettes.** Ten dark: Mocha, Macchiato, Frappé, Nord,
  Dracula, Tokyo Night, Cherry, Ocean, Amber, Mint. Three light: Latte, Rose
  Pine Dawn, Gruvbox Light. Four of them are official
  [Catppuccin](https://github.com/catppuccin/catppuccin) flavors.
- Three featured shortcuts (System, Myrlin Dark, Myrlin Light) resolve to one of
  the thirteen.
- Chosen under Settings, Interface, Terminal theme, with a live preview swatch.
  The choice persists in `localStorage`.
- Every palette is derived from the same CSS custom properties as the app
  chrome, and a test fails if the two drift apart.
- The terminal font chain leads with a face that carries box-drawing characters,
  block shapes and braille dots, so a CLI that draws framed panels stays
  aligned.

## Resources and monitoring

- **Port detection** for running sessions: `Get-NetTCPConnection` on Windows,
  `lsof` on Unix.
- **Per-session CPU and memory**, tracked live.
- **System overview:** CPU, RAM, uptime.
- **Stop, restart or kill** a session from the Resources tab.

## Phone

- **Five tabs:** Home, Sessions, Terminal, Attention, Search.
- **Home** opens on a banner counting the sessions that want your input, then
  the sessions running now, then the ones you were last in, then a Workspace
  list with agent tasks, project notes, costs, system resources, paired devices
  and settings.
- **Attention** carries the only persistent badge in the app.
- **Touch gestures.** Long-press at 400ms with an 8px move cancel. Long-press on
  terminal output selects text and only selects text. Long-press on a row opens
  its context sheet. Long-press on chrome does nothing.
- Swipe a session row: right reveals Terminal, left reveals Stop and Hide. A
  swipe only ever reveals a button, it never performs one.
- Horizontal drag on the terminal body switches panes, guarded so it cannot fire
  from a screen edge or during a selection.
- **Terminal key row** fits what fits at a hittable size, with the rest behind an
  overflow button. Five keys plus the menu on a 390-pixel phone, six on a larger
  one. Hold Ctrl+C for any control key from Ctrl+A to Ctrl+Z. Hold Send for
  "send without Enter" and "send a newline". Hold the image button for camera,
  library or files.
- **Terminal options sheet:** Reader, select mode, copy view, paste, Ctrl+D,
  send without Enter, send a newline, scheduled messages, pinned notes, move to
  another tab, reset, restart.
- **Raw keys** switch for prompts that want every keystroke as you type it. It
  says on screen when it is on, because it turns autocorrect off.
- **Microphone** in the message row next to the image button.
- **Keyboard-aware layout** driven by `visualViewport`, not a guess from screen
  size. The tab bar retracts when the keyboard opens so the input row takes the
  bottom of the viewport.
- Flicking up past the top of a terminal carries straight into its history, with
  Oldest and Jump to live buttons, and the phone's own selection handles,
  magnifier and Copy bar.
- **Hold a bottom tab for its shortcuts:** new session from Home and Sessions,
  the pane switcher from Terminal, Stop all from Attention.
- **Installable to a home screen** on iOS and Android, with real icons at every
  size including a padded maskable one for Android's circular masks.
- Nothing in the app blinks: a filled dot for running, a ring for needs-input.

## Remote access

- **Cloudflare tunnel management** from inside the app when `cloudflared` is
  installed, both quick tunnels and token-run named tunnels.
- LAN access by binding to a LAN IP with `CWM_HOST`.
- See
  [SETUP.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/SETUP.md)
  for both.

## TUI mode

A terminal-only interface built on blessed, for when you do not want a browser
tab: `npm start`, or `npm run demo` for sample data.

---

## How it compares

This table was compiled in early 2026 and the other tools have moved since. The
Myrlin column is current; the rest is a snapshot and has not been re-verified.

| Feature | Myrlin | [ClaudeCodeUI](https://github.com/siteboon/claudecodeui) | [Opcode](https://github.com/winfunc/opcode) | [Claude Squad](https://github.com/smtg-ai/claude-squad) |
|---------|--------|-------------|--------|-------------|
| Cost tracking | Yes | No | Yes | No |
| Costs dashboard | Yes | No | Yes | No |
| Session discovery | Yes | Yes | No | No |
| Session manager overlay | Yes | No | No | No |
| Project docs/kanban | Yes | No | No | No |
| Themes | 13 terminal palettes, light and dark chrome | No | No | No |
| Session templates | Yes | No | No | No |
| Conflict detection | Yes | No | No | No |
| Kanban task board | Yes (5 columns, drag and drop) | No | No | Yes (basic) |
| PR automation | Yes (generated descriptions, `gh`) | No | No | No |
| Model orchestration | Yes (per stage) | No | No | No |
| Embedded terminals | Multi-pane grid | Single | No | No |
| Tab grouping | Yes | No | No | No |
| Windows native | Yes | Buggy | Yes (desktop) | No (tmux) |
| TUI mode | Yes | No | No | No |
| Providers | Claude Code, ChatGPT Codex | Claude, Cursor, Codex | Claude only | 5+ tools |
| File explorer | No | Yes | No | No |
| npx install | Yes | Yes | No | No |
| Build step required | None | Vite | Tauri | None |

**What those tools do better:** ClaudeCodeUI has a file explorer. Opcode is a
polished desktop app with a large following. Claude Squad supports more CLIs.
Myrlin is project-first, with cost tracking and per-project docs.

## td against the built-in kanban

Myrlin's kanban board and `td` solve different problems and work well together.

| | Myrlin kanban | td |
|---|---|---|
| **Lives in** | Myrlin's state store | `.todos/` directory in the repo |
| **Follows git?** | No | Yes, committed alongside code |
| **AI agent access** | Via the Myrlin GUI | Via the `td` CLI in any terminal |
| **Session isolation** | No | Yes, an implementer cannot approve its own work |
| **Handoff structured state** | No | Yes, `td handoff --done / --remaining / --decision` |
| **Worktree per task** | Yes, Myrlin creates it | Via Myrlin's Worktree button |
| **PR tracking** | Yes, through `gh` | No |
| **Cross-context memory** | No | Yes, designed for AI agent workflows |

**Use Myrlin's kanban** to orchestrate worktrees, track PR state, manage
dependencies and coordinate parallel agents at the project level.

**Use td** inside those worktrees to track granular sub-tasks, log decisions and
hand structured context to the next session, which matters most when a task
spans several context windows or needs a review step by a separate session.

---

## Roadmap

Nothing in this section is shipped. It is what is planned.

### Next up: task spinoff from sessions

Right-click a running session, choose "Spinoff Tasks", and the model extracts
actionable tasks from the conversation. Each task gets a pre-filled creation
form with context, relevant files and acceptance criteria. Confirm, and each
task spins off to its own worktree branch with a structured context handoff
document: not a raw conversation dump but a spec, covering current state,
desired state, file inventory and constraints. Tasks appear on the kanban board,
run in parallel on isolated branches, and report back with PRs when done.

The reason for the structure is context engineering: each agent should know
exactly what to build without the parent conversation's full history filling its
context window.

### Also planned

- **Task spinoff from sessions.** Right-click, extract tasks, parallel worktree
  agents with a structured context handoff.
- **Collapsible sidebar.** A toggle for more terminal space.
- **6-pane grid.** Smart layouts for one to six panes with no dead space.
- **Pane drag and drop.** Reorder terminal panes by dragging their headers.
- **Saveable layouts.** Named pane configurations you can switch between.
- **Frosted glass permission prompts.** A blur overlay with clickable buttons
  when a CLI asks for input.
- **Per-action cost breakdown.** Token usage per tool call, not just session
  totals.
- **Conflict detection v2.** File-level collision warnings across parallel
  agents.
- **More providers.** Gemini and Aider alongside Claude Code and Codex.

### Shipped along the way

The changelog is the full record. In rough order:

- Project hierarchy (Category, Project, Focus, Sessions).
- Multi-pane grid layout, worktree tasks, conflict center, session manager
  overlay.
- Costs dashboard, tab grouping, session templates, session search.
- 13 terminal themes, cost tracking, feature board, git worktree management.
- Port detection, phone support, auto-trust dialogs.
- Kanban workflow board with five columns and drag and drop.
- PR automation with generated descriptions, PR creation and tracking through
  `gh`, auto-advance on merge.
- Multi-model orchestration: a default model per stage, auto-assigned on column
  transitions.
- Cross-cutting tags on tasks and sessions, searchable.
- Agent teams UX: workflow explanation, stage progress dots, model hints.
- Task dependencies with visual indicators.
- Concurrent task limits, configurable from 1 to 8.
- Task search across branch, description, model, status and tags.
- Live terminal preview on running task cards.
- Worktree init hooks.
- The Notion-style redesign, ChatGPT Codex parity, the unified scrollback
  surface and the five-tab phone layout, across 1.3.0-alpha.20 to alpha.30.
