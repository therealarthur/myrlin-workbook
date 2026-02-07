# Myrlin Workbook

A workspace manager for AI coding sessions. Organize, monitor, and control multiple Claude Code sessions from a single browser UI. Built for developers who run parallel AI assistants across projects.

> Currently supports Claude Code. GPT Codex and other providers are on the [roadmap](#roadmap).

<!-- TODO: Screenshot of the main terminal view with 2-3 panes active -->
<!-- ![Myrlin Workbook](screenshots/hero.png) -->

---

## Why This Exists

If you use Claude Code seriously, you end up with a mess:
- 10+ terminal tabs with no way to tell them apart
- Sessions scattered across projects with no grouping
- No idea which sessions are still running or how much memory they're eating
- No way to see what each session was working on without opening it
- Lose everything on crash or restart

Myrlin Workbook fixes all of that with a web-based dashboard that feels like Linear meets tmux.

---

## Features

### Workspace & Session Management
- **Named workspaces** with color-coded organization
- **Nested session display** — sessions grouped by project directory within workspaces
- **Drag-and-drop** sessions into terminal panes
- **Inline rename** — double-click any session name to edit
- **Session state tracking** (running / stopped / error) with PID monitoring
- **Persistent state** to disk — survives crashes and restarts
- **Auto-recovery** on startup (detects orphaned sessions, restores state)
- **Workspace groups** for organizing related workspaces together

### Embedded Terminals
- **4-pane terminal grid** with xterm.js + node-pty + WebSocket
- **Terminal tab groups** — named windows ("Research", "Debug", "Deploy"), switchable and persistent
- **PTY sessions persist server-side** (survive page refresh, tab groups disconnect without killing PTYs)
- **Scrollback buffer** with 100KB cap and replay on reconnect
- **Model selection** for Claude sessions (Opus, Sonnet, Haiku)
- **Session resume** support (`--resume` flag)
- **Raw binary WebSocket frames** for terminal output — no JSON overhead, no lag

### Project Discovery
- **Auto-scans** `~/.claude/projects/` for all Claude Code sessions on your machine
- Shows project directory, session count, total size, last active
- **AI-powered session summaries** (overall theme + recent activity)
- Import discovered sessions into workspaces with one click
- Right-click context menu for session operations

### Documentation System
- **Per-workspace docs** with Notes, Goals, and Tasks sections
- **Large markdown editor** with formatting toolbar (Bold, Italic, Code, Link, List)
- **AI Insights tab** — auto-generated summaries of each session in a workspace
- Click existing notes to edit in-place
- Raw markdown editing mode

### Resource Monitoring
- **System overview** — CPU, RAM, core count, uptime with color-coded progress bars
- **Per-Claude-session memory tracking** — see which sessions are resource-heavy
- Auto-refresh polling (10s intervals)
- Claude sessions table with PID, memory, and status

### Security
- **Password-based auth** with bearer token sessions
- **Login rate limiting** (5 attempts/min per IP)
- **CORS restricted** to localhost origins only
- **CSP headers** (Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- **No hardcoded credentials** — password loaded from env var, config file, or auto-generated on first run
- **Timing-safe** password comparison

### Resilience
- **Auto-backup** of all frontend files on server start
- **One-click restore** to last known working version if the UI breaks
- **Fallback banner** when running a restored version
- **Global error handler** catches init failures and offers recovery options
- **Graceful shutdown** — saves state, terminates PTYs on SIGINT/SIGTERM

### Mobile Support
- **Responsive design** with bottom tab bar on mobile
- **Touch gestures** — long-press for context menus, edge swipe for sidebar
- **Action sheets** instead of dropdown menus on small screens

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/therealarthur/myrlin-workbook.git
cd myrlin-workbook

# Install dependencies
npm install

# Start the web UI (opens browser automatically at localhost:3456)
npm run gui
```

On first launch, a random password is generated and printed to the console. Use it to log in. The password is saved to `state/config.json` for subsequent launches.

**Set a custom password:**
```bash
# Via environment variable
CWM_PASSWORD=your-password npm run gui

# Or edit state/config.json directly
echo {"password":"your-password"} > state/config.json
```

### Other Run Modes

| Command | Description |
|---------|-------------|
| `npm run gui` | Web UI (default, opens browser) |
| `npm run gui:demo` | Web UI with sample data pre-loaded |
| `npm start` | TUI mode (terminal-only, tmux-style via blessed) |
| `npm run demo` | TUI with sample data |
| `npm test` | Run the test suite (26 tests) |

### Requirements

- **Node.js 18+** (tested on 22.x)
- **Windows** — node-pty uses ConPTY. Linux/macOS support is untested but should work with minor adjustments.
- C++ build toolchain for node-pty compilation (Visual Studio Build Tools on Windows, `build-essential` on Linux)

---

## Remote Access (Cloudflare Tunnel)

Access your workbook from anywhere — your phone, another machine, or on the go. CWM's built-in security (rate limiting, auth tokens, CSP) makes it safe to expose.

### Quick Setup (Free, 5 minutes)

1. **Install cloudflared:**
   ```bash
   # Windows
   winget install cloudflare.cloudflared

   # macOS
   brew install cloudflared

   # Linux
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
   ```

2. **Start your CWM server:**
   ```bash
   npm run gui
   ```

3. **Create a tunnel:**
   ```bash
   cloudflared tunnel --url http://localhost:3456
   ```

4. **Done.** Cloudflared prints a public URL like `https://random-words.trycloudflare.com`. Open it from any device and log in with your CWM password.

### Persistent Tunnel (Named Domain)

For a stable URL that doesn't change between restarts:

```bash
# One-time setup
cloudflared tunnel login
cloudflared tunnel create myrlin
cloudflared tunnel route dns myrlin your-subdomain.yourdomain.com

# Run with your named tunnel
cloudflared tunnel run --url http://localhost:3456 myrlin
```

### Coming Soon: Managed Remote Access

We're building a simplified hosted option so you don't need to set up cloudflared yourself:

1. **Sign up** at myrlin.dev and get an access token
2. **Add the token** to your CWM config (or set `CWM_TUNNEL_TOKEN` env var)
3. **CWM auto-connects** a secure tunnel on startup
4. **Access your dashboard** at `yourname.myrlin.dev`

No cloudflared install, no DNS config, no port forwarding. One token, one URL.

**Security guarantees:**
- End-to-end encrypted via Cloudflare tunnels (TLS 1.3)
- CWM password + tunnel token = two-factor access
- Rate limiting at both tunnel edge and application layer
- Audit log of all remote access (IP, timestamp, actions)
- Optional IP allowlisting
- Your data stays on your machine — the tunnel connects directly, nothing passes through our servers

---

## Architecture

```
Browser (vanilla JS SPA)
  │
  ├── REST API ──────── Express server (src/web/server.js)
  │                       ├── State store (JSON persistence + EventEmitter)
  │                       ├── Session manager (launch/stop/restart)
  │                       ├── Resource monitoring (CPU, RAM, per-PID)
  │                       └── Workspace groups, discovery, docs, stats
  │
  ├── SSE ───────────── Real-time updates (store events → all clients)
  │
  └── WebSocket ─────── Terminal I/O (binary frames, no JSON overhead)
                           └── node-pty → ConPTY / PTY processes
```

**Tech stack:** Node.js, Express, xterm.js, node-pty, WebSocket, vanilla JS SPA. No React, no build step, no framework lock-in.

### Project Structure

```
src/
├── state/
│   ├── store.js              # Core state (JSON persistence + EventEmitter)
│   └── docs-manager.js       # Per-workspace markdown documentation
├── core/
│   ├── session-manager.js    # Launch/stop/restart processes
│   ├── workspace-manager.js  # Workspace CRUD + business logic
│   ├── process-tracker.js    # PID monitoring
│   ├── recovery.js           # Auto-recovery on startup
│   └── notifications.js      # Event-based notifications
├── web/
│   ├── server.js             # Express API + SSE + resource monitoring
│   ├── auth.js               # Token auth + rate limiting
│   ├── backup.js             # Frontend backup/restore system
│   ├── pty-manager.js        # PTY session lifecycle management
│   ├── pty-server.js         # WebSocket server for terminal I/O
│   └── public/
│       ├── index.html        # SPA shell
│       ├── app.js            # Frontend application (~4400 lines)
│       ├── styles.css        # Catppuccin Mocha theme (~2400 lines)
│       └── terminal.js       # TerminalPane (xterm.js + WebSocket)
├── ui/                       # TUI mode (blessed library)
├── index.js                  # TUI entry point
├── demo.js                   # TUI demo mode
└── gui.js                    # GUI entry point (auto-opens browser)
```

---

## Configuration

### Password

Password is loaded in this order:
1. `CWM_PASSWORD` environment variable
2. `state/config.json` → `{ "password": "..." }`
3. Auto-generated random password (printed to console, saved to config)

### Port

Default is 3456. Override with the `PORT` environment variable:
```bash
PORT=8080 npm run gui
```

### Theme

The entire UI uses [Catppuccin Mocha](https://github.com/catppuccin/catppuccin). All colors are defined as CSS custom properties in `styles.css`. Swap the palette variables to use a different flavor.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` / `Cmd+K` | Quick switcher (search workspaces and sessions) |
| `Escape` | Close modals, quick switcher, context menus |
| `Ctrl+Enter` | Save in notes editor |
| Double-click session name | Inline rename |
| Right-click session | Context menu (launch modes, model, rename, hide) |
| Right-click workspace | Context menu (docs, add session, edit, delete) |

---

## Roadmap

### In Progress
- **Multi-provider support** — GPT Codex, Cursor, Aider alongside Claude Code ([details](IDEAS.md))
- **Project docs discovery** — auto-scan TODO.md, IDEAS.md from project directories
- **Session templates** — save and reuse session configurations

### Planned
- Session search and filtering across all workspaces
- Activity timeline visualization (Linear-style)
- Export/import workspace configurations
- Pinned sessions (sticky top of list)
- Keyboard shortcut customization
- Light theme option
- Session logs browser (historical scrollback access)
- Session cost estimation (token tracking)

### Paid Tier (Coming Soon)
- **Managed remote access** — `yourname.myrlin.dev` with zero setup
- Multi-user auth with roles (admin / contributor / viewer)
- Shared workspaces with invite links
- AI goal tracking across sessions
- Cross-session references and relationship graphs
- Managed cloud hosting with backups and uptime SLA

See [IDEAS.md](IDEAS.md) for the full feature roadmap and design notes.

---

## License

**AGPL-3.0** — You can use, modify, and self-host freely. If you run a modified version as a public service, you must publish your source code. See [LICENSE](LICENSE) for full terms.

---

## Contributing

Issues and PRs welcome. The codebase is vanilla JS with no build step — clone, `npm install`, and start hacking.

```bash
npm test        # Run the test suite (26 tests)
npm run gui     # Start the dev server
```

---

Built by [Arthur](https://github.com/therealarthur). Made for managing Claude Code at scale.
