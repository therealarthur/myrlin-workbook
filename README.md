<div align="center">

<picture>
  <source srcset="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/brand/logo.svg" type="image/svg+xml">
  <img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/images/logo.png" alt="Myrlin Workbook" width="140">
</picture>

# Myrlin Workbook

**Every Claude Code and ChatGPT Codex session on your machine, in one sidebar.**

[![npm version](https://img.shields.io/npm/v/myrlin-workbook.svg?style=flat-square)](https://www.npmjs.com/package/myrlin-workbook)
[![npm downloads](https://img.shields.io/npm/dm/myrlin-workbook.svg?style=flat-square)](https://www.npmjs.com/package/myrlin-workbook)
[![License AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](https://github.com/therealarthur/myrlin-workbook/blob/main/LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-green.svg?style=flat-square)](https://nodejs.org)
[![CI](https://github.com/therealarthur/myrlin-workbook/actions/workflows/ci.yml/badge.svg)](https://github.com/therealarthur/myrlin-workbook/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/therealarthur/myrlin-workbook?style=flat-square)](https://github.com/therealarthur/myrlin-workbook/stargazers)

[Install](https://github.com/therealarthur/myrlin-workbook#install) ·
[Features](https://github.com/therealarthur/myrlin-workbook#features) ·
[Phone](https://github.com/therealarthur/myrlin-workbook#phone) ·
[Codex](https://github.com/therealarthur/myrlin-workbook#codex) ·
[Architecture](https://github.com/therealarthur/myrlin-workbook#architecture) ·
[Docs](https://github.com/therealarthur/myrlin-workbook#docs) ·
[Contributing](https://github.com/therealarthur/myrlin-workbook#contributing)

</div>

---

<div align="center">
  <a href="https://github.com/therealarthur/myrlin-workbook/blob/main/docs/media/hero.mp4">
    <img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/hero.webp" alt="The sidebar, a live terminal with scrollback, a Codex session and the cost panel" width="900">
  </a>
  <br>
  <sub><a href="https://github.com/therealarthur/myrlin-workbook/blob/main/docs/media/hero.mp4">Watch the 30 second tour</a></sub>
</div>

## Why

I run Claude Code all day and I started running Codex alongside it. Between the two there
are a few hundred conversations on this machine, spread across two CLIs that do not know
about each other, in a dozen project folders, and the only way to get back to one is to
pick a UUID out of a list. Open three at once and you are juggling terminal windows.
Restart the machine and you reopen everything by hand. Scroll up in a pane to find what an
agent did an hour ago and you hit the top of the buffer, because a coding agent repaints
its screen and keeps no scrollback at all.

So I built the thing I wanted. Myrlin reads both CLIs where they already store their data,
groups every session by the folder it ran in, and opens any of them in a real terminal in
a browser tab. You can wheel back through the whole conversation, drag a selection across
an hour of history and copy it. Costs come out of the transcripts. Docs, a kanban board
and git worktrees sit next to the sessions they belong to. It runs on your phone over your
own network.

It is not a hosted service and it is not an agent. There is no sign-up, no cloud, no
telemetry, and no model gets called unless you ask for one. It is a local Node server, a
browser tab, and your own two CLIs doing what they already do.

## Install

```bash
npx myrlin-workbook@alpha    # v1.3 alpha: Claude Code and ChatGPT Codex, redesigned, phone layout
npx myrlin-workbook          # v0.9 stable: Claude only, unchanged
npx myrlin-workbook --demo   # sample data, no real sessions needed
```

Node 20 or newer. `node-pty` needs C++ build tools; if they are missing the app still
boots, just without terminal panes.

A random password is generated on first launch and saved to `~/.myrlin/config.json`, where
it survives updates, reinstalls and npx cache clears. Set `CWM_PASSWORD` to override it.

The server binds to `127.0.0.1` by default. Set `CWM_HOST` to your LAN IP to reach it from
a phone or another machine, and set a real password first.

Everything else, including tunnels, environment variables, keyboard shortcuts and
troubleshooting, is in
[SETUP.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/SETUP.md).

## Features

<table>
<tr>
<td width="42%" valign="middle">

### Every session, already found

Claude Code sessions are read from `~/.claude/projects`. Codex sessions are read from
`~/.codex`, including `state_5.sqlite`, which is the same thread store the ChatGPT desktop
app lists from, so the folders and sessions you see here are the ones that app shows you.
Both reads are read-only. Sessions group by the directory they ran in, with a Recent list
at the top and a Discovered section at the bottom for anything on disk you have not filed
yet. The All / Claude Code / ChatGPT Codex switcher sits inside that section and filters
that list only. `Ctrl+K` finds anything by name.

</td>
<td><img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/feature-sidebar.webp" alt="The sidebar: Recent, projects grouped by folder, the Discovered section and its provider switcher"></td>
</tr>
<tr>
<td width="42%" valign="middle">

<a id="terminal"></a>

### A terminal you can scroll back through

xterm.js over node-pty, so it is a real PTY. On Windows that is ConPTY directly, with no
WSL; macOS and Linux use their own. Wheel up past the top of what a pane has drawn and it
carries on into the recorded conversation: same background, same typeface, no panel to
open and nothing to switch on. Drag from the line being written right now up into last
hour's output and it is one continuous selection, which `Ctrl+C` copies. `Ctrl+Shift+A`
takes the whole document, `Shift+PageUp` pages, `Escape` leaves, and typing anything
leaves and types. Output keeps flowing while you read.

</td>
<td><img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/feature-terminal.webp" alt="Wheeling back through a terminal's history, dragging a selection across the seam and copying it"></td>
</tr>
<tr>
<td width="42%" valign="middle">

<a id="codex"></a>

### ChatGPT Codex, read from its own store

Codex threads come out of the SQLite database the desktop app uses, through an in-memory
byte image, so no write handle is ever opened against your session history. A filesystem
walk over the rollout JSONL stays as a fallback for machines the desktop app has never run
on. The detail strip shows the model, reasoning effort, approval policy and sandbox that
the session is actually running, read from the conversation itself; anything genuinely
unknown says unknown rather than being filled in with a guess. Codex reports token counts
and no dollar figure, because there is no published price to apply and inventing one would
be worse than showing nothing.

</td>
<td><img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/feature-codex.webp" alt="Codex project folders and sessions matching the ChatGPT app, and the session detail strip"></td>
</tr>
<tr>
<td width="42%" valign="middle">

<a id="phone"></a>

### It works on a phone

Five tabs: Home, Sessions, Terminal, Attention and Search. Attention carries the only
persistent badge in the app, counting what is waiting on you. Flick up past the top of a
terminal and the history opens and keeps going; a long press hands you the phone's own
selection handles and Copy bar rather than an imitation of them. The key row fits five
keys plus an overflow menu on a 390 pixel screen, and holding Ctrl+C gives you every
control key from Ctrl+A to Ctrl+Z. The layout is driven by `visualViewport`, so the
terminal stays above the soft keyboard. Reach it over your LAN with `CWM_HOST`, or through
a Cloudflare tunnel the app can start for you.

</td>
<td width="220"><img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/feature-phone.webp" alt="The five tab phone layout, opening a session, the keyboard rising and a long press" width="220"></td>
</tr>
<tr>
<td width="42%" valign="middle">

### Thirteen terminal palettes, light and dark chrome

Two independent choices. The app chrome is light or dark, toggled from the topbar. The
terminal palette is one of thirteen: Mocha, Macchiato, Frappé, Nord, Dracula, Tokyo Night,
Cherry, Ocean, Amber and Mint in the dark set, Latte, Rose Pine Dawn and Gruvbox Light in
the light one. Pick it under Settings, Interface, Terminal theme, with a live preview
swatch; the choice persists in `localStorage`. Every palette is derived from the same CSS
custom properties as the chrome, and a test fails if the two ever drift apart.

</td>
<td><img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/feature-themes.webp" alt="Light and dark chrome, then four of the thirteen terminal palettes"></td>
</tr>
<tr>
<td width="42%" valign="middle">

### What you spent, and what is next

Cost comes out of Claude's own usage fields in the transcripts: input, output, cache write
and cache read tokens, priced per model, per session and per project. Parsing runs on a
worker thread so a large transcript never stalls terminal I/O. The Costs view has a Day,
Week, Month and All selector, a timeline chart and a table you can sort by cost, tokens or
duration. The agent task board runs Backlog, Planning, Running, Review and Done with drag
and drop, and a card can own a git branch, a worktree and a live session, then open a pull
request through `gh` and track its state on the card.

</td>
<td><img src="https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/feature-board.webp" alt="The cost panel with its timeline chart, then the kanban board with a card being dragged"></td>
</tr>
</table>

## More

- **Session templates.** Save a working directory, model, flags and spawn options, then
  launch from it in one click.
- **Conflict detection.** Warns when two running sessions are editing the same files, with
  a per-file breakdown and a chip that jumps to the session responsible.
- **Quick switcher.** `Ctrl+K` or `Cmd+K` for fuzzy search across every session, project
  and command.
- **Git and worktrees.** Branch, dirty state and ahead/behind per project, worktree create
  and delete, and a right-click that makes a branch, a worktree and a session at once.
- **Pull request automation.** Descriptions generated from the diff, PRs opened through
  the `gh` CLI, and card badges for open, draft, merged and closed.
- **td integration.** Surfaces [td](https://github.com/marcus/td) issues in the docs panel
  and the sidebar, and promotes any issue to a worktree plus a session in one click.
- **Port detection and resource monitoring.** Listening ports per session, live CPU and
  memory, a system overview, and stop, restart or kill from the Resources tab.
- **Search.** One query across both providers, over sessions, commands and past
  conversations.
- **Docs panel.** Notes, Goals, Tasks, Rules and Roadmap per project, in a markdown editor,
  with a Planned, Active, Review and Done feature board.
- **Remote access.** Cloudflare tunnel management from inside the app, and QR pairing so a
  phone signs in once.
- **TUI mode.** A blessed interface for when you do not want a browser tab: `npm start`.

The exhaustive list is in
[FEATURES.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/FEATURES.md).

## Architecture

An Express server and a vanilla HTML, CSS and JavaScript SPA. No React, no bundler, no
build step: the frontend is served as written.

Terminals are xterm.js in the browser talking to node-pty on the server over a WebSocket
carrying binary frames. Live state reaches the browser over SSE, everything else over a
REST API. An optional headless VT sidecar keeps a deeper server-side line log for shells,
behind `CWM_VT_SIDECAR=1`.

Each CLI is a module under `src/providers/`, exposing the same interface for discovery,
parsing, search and spawning. A test guards the seam: hard-coding a provider name outside
that directory fails the build unless the line is explicitly annotated, so the rest of the
app does not know which CLI it is talking to.

State is JSON under `~/.myrlin/`. There is no sign-up, no server of ours, no database of
its own and no telemetry. Your sessions, your costs and your notes stay on your disk.

The contract documents behind the 1.3 redesign are
[DESIGN-SPEC.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/design/notion-restyle/DESIGN-SPEC.md),
[TERMINAL-ARCHITECTURE.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/design/notion-restyle/TERMINAL-ARCHITECTURE.md),
[CODEX-PARITY.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/design/notion-restyle/CODEX-PARITY.md)
and
[MOBILE-EXPERIENCE.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/design/notion-restyle/MOBILE-EXPERIENCE.md).

## Docs

- [SETUP.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/SETUP.md) is
  install, configuration, keyboard shortcuts and troubleshooting.
- [FEATURES.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/FEATURES.md)
  is every capability, by area, plus the roadmap.
- [PROVIDER-INTERFACE.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/PROVIDER-INTERFACE.md)
  is the contract a new CLI provider implements.
- [WORKFLOWS.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/WORKFLOWS.md)
  covers the agent task board and worktree workflow.
- [OPERATIONS.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/OPERATIONS.md)
  covers running it as a long-lived service.
- [CHANGELOG.md](https://github.com/therealarthur/myrlin-workbook/blob/main/CHANGELOG.md)
  is the full record of what changed and why.

## Contributing

Issues and pull requests are welcome. There is no build step: clone it, `npm install`,
start editing.

```bash
npm test             # unit and contract suite
npm run test:browser # real Chromium and xterm acceptance, on Windows
npm run gui          # start the server
```

Read
[CONTRIBUTING.md](https://github.com/therealarthur/myrlin-workbook/blob/main/CONTRIBUTING.md)
first. It covers branch naming, what a good pull request looks like, and which changes
have to pass the browser gate.

## License

[AGPL-3.0](https://github.com/therealarthur/myrlin-workbook/blob/main/LICENSE). Use it,
change it and self-host it however you like. The one obligation is that if you run a
modified version as a service other people can reach, you have to publish your changes.

---

<sub>Claude and Claude Code are trademarks of Anthropic. ChatGPT and Codex are trademarks
of OpenAI. This project is not affiliated with, endorsed by or sponsored by either
company.</sub>

<sub>Built by <a href="https://github.com/therealarthur">Arthur</a>.</sub>
