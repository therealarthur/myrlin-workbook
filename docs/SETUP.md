# Setup

Everything about installing, running, configuring, reaching and troubleshooting
Myrlin Workbook. The
[README](https://github.com/therealarthur/myrlin-workbook/blob/main/README.md)
is the tour and
[FEATURES.md](https://github.com/therealarthur/myrlin-workbook/blob/main/docs/FEATURES.md)
is the full capability list.

---

## Prerequisites

- **Node.js 20 or newer.** [Download](https://nodejs.org). The package declares
  `engines.node >= 20`, and CI tests against Node 20 and 22.
- **C++ build tools**, needed by `node-pty` for real terminal emulation:
  - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
    with the "Desktop development with C++" workload.
  - **macOS:** `xcode-select --install`
  - **Linux:** `sudo apt install build-essential python3`

`node-pty` ships prebuilt binaries for macOS and Windows. On Linux it compiles
during install, which is why the toolchain is not optional there. If the build
fails, the app still boots; it just boots with the terminal panes disabled and
prints a platform-specific remediation banner. Everything else keeps working.

If `npm install` fails with node-gyp errors, the build tools above are what is
missing. See [Troubleshooting](#troubleshooting).

## Install and run

### From npm

```bash
npx myrlin-workbook@alpha    # v1.3 alpha: Claude Code and ChatGPT Codex, redesigned, phone layout
npx myrlin-workbook          # v0.9 stable: Claude only, unchanged
npx myrlin-workbook --demo   # sample data, no real sessions needed
```

`npx myrlin-workbook` and `@latest` install the stable line. All v1.3
multi-provider work ships under the `alpha` dist-tag until 1.3 goes stable.

For a permanent install and a shorter command:

```bash
npm install -g myrlin-workbook@alpha
myrlin
```

### From source

```bash
git clone https://github.com/therealarthur/myrlin-workbook.git
cd myrlin-workbook
npm install
npm run gui        # real sessions
npm run gui:demo   # sample data
```

There is no build step. The frontend is vanilla HTML, CSS and JavaScript served
as-is.

### Run modes

| Command | What it does |
|---------|--------------|
| `npx myrlin-workbook` | Web GUI through npx |
| `npm run gui` | Web GUI under a supervisor that restarts it if it crashes |
| `npm run gui:demo` | Web GUI with sample data |
| `npm run gui:bare` | Web GUI without the supervisor |
| `npm run gui:daemon` | Supervisor detached into the background, logging to `logs/server.log` |
| `npm run gui:cdp` | Launches the browser with Chrome DevTools Protocol remote debugging on, for the visual QA MCP |
| `npm start` | TUI mode, terminal only, built on blessed |
| `npm run demo` | TUI with sample data |
| `node src/index.js --reset` | Clear all state and start fresh (TUI entry point) |
| `npm test` | Unit and contract suite |
| `npm run test:browser` | Real Chromium and xterm acceptance gate (Windows) |

The GUI opens your default browser on start. Set `CWM_NO_OPEN` to skip that.

## Password and sign-in

On first launch a random password is generated and saved to
`~/.myrlin/config.json`. That password **persists across updates, reinstalls and
npx cache clears**, so it stays the same one.

To set your own:

```bash
# Option 1: edit the config file. Recommended, persists forever.
# ~/.myrlin/config.json  ->  { "password": "your-password-here" }

# Option 2: environment variable. Overrides the config, for this launch only.
CWM_PASSWORD=mypassword npx myrlin-workbook@alpha
```

Lookup order, highest first:

1. The `CWM_PASSWORD` environment variable.
2. `~/.myrlin/config.json`
3. `./state/config.json`
4. Auto-generate, print it to the console, and save it to both config files.

When a password is found in one location and not the other, it is copied across
so both stay in sync.

### The startup token

On startup the console prints a clickable URL carrying a one-time token, for
example `http://127.0.0.1:3456?token=<random>`. Click it to sign in without
typing the password. The token is single-use and expires 60 seconds after it is
printed, so it is safe even when it ends up in a terminal log, and it is
stripped from the URL bar immediately after login.

Sign-ins are held in memory, so restarting the server signs every browser out.
Open terminal panes wait for the new sign-in and reconnect themselves rather
than dying.

## Port

The default is `3456`. Override it with `PORT`:

```bash
PORT=8080 npm run gui
```

## Access from other devices on your LAN

By default the GUI binds to `127.0.0.1`, which is localhost only. To reach it
from a phone, a tablet or another computer on the same network, bind to your
machine's LAN IP with `CWM_HOST`:

```bash
# Find your LAN IP first: ipconfig on Windows, ifconfig or ip addr on macOS and Linux.
CWM_HOST=192.168.1.121 npx myrlin-workbook@alpha
# then open http://192.168.1.121:3456 from any device on that network
```

Combine it with `PORT` if 3456 is taken:

```bash
PORT=3457 CWM_HOST=192.168.1.121 npx myrlin-workbook@alpha
```

To avoid retyping the variable on every launch, export it in your shell profile
(`export CWM_HOST=192.168.1.121`) or install globally and run `myrlin`.

> **Security.** Binding to a LAN IP exposes the login page to everyone on that
> network. The password and token above are the only gate, so set a strong
> password before you do this.

## Remote access over a tunnel

The app manages Cloudflare tunnels itself when `cloudflared` is installed: both
quick tunnels and token-run named tunnels, from the paired devices screen.

To do it by hand instead:

```bash
npm run gui                                     # start the server
cloudflared tunnel --url http://localhost:3456  # in another terminal
```

Open the printed URL from any device. WebSocket terminal connections, SSE
streams and REST calls all route through the tunnel. For a stable URL rather
than an ephemeral one, see the
[Cloudflare tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

Pairing a phone is easier than typing a URL: open paired devices, scan the QR
code, and the phone signs in once and stays signed in.

## Configuration

### Environment variables

| Variable | Default | What it does |
|----------|---------|--------------|
| `PORT` | `3456` | Server port |
| `CWM_HOST` | `127.0.0.1` | Bind address. Set a LAN IP for other devices |
| `CWM_PASSWORD` | auto-generated | Login password, overrides the config files |
| `CWM_NO_OPEN` | unset | Skip auto-opening the browser on start |
| `CWM_DATA_DIR` | `~/.myrlin` | Where persistent state is written |
| `CWM_VT_SIDECAR` | off | Set to `1` for the deeper server-side scrollback log for shells and build logs |
| `CWM_RESTART_DELAY` | `2000` | Milliseconds the supervisor waits before restarting a crashed server |
| `CWM_MAX_RESTARTS` | `20` | Consecutive supervisor restarts before it gives up |

### Where state lives

All persistent state lives under `~/.myrlin/`: `workspaces.json`,
`layout.json`, `config.json`, `docs/` and `backups/`. Every launch method (npm
run gui, npx, a global install) reads and writes the same directory, so your
projects follow you between them.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` / `Cmd+K` | Quick switcher across sessions and projects |
| `Ctrl+,` / `Cmd+,` | Settings |
| `Ctrl+Shift+N` / `Cmd+Shift+N` | New agent task |
| `Ctrl+1` to `Ctrl+4` | Switch to the workbench and focus pane 1 to 4 |
| `Escape` | Close modals, menus, the peek, and cancel an inline rename |
| `Ctrl+Enter` | Save in the notes editor |
| Double-click a session | Inline rename |
| Right-click a session | Context menu: launch, model, rename, hide |
| Right-click a project | Context menu: docs, add session, edit, delete |

### In a terminal pane

| Key | Action |
|-----|--------|
| Wheel up at the top of the pane | Continue into the recorded history |
| `Shift` + wheel | Go to history whatever the pane is running |
| `Ctrl+C` | Copy when there is a selection, otherwise send SIGINT |
| `Ctrl+Shift+A` | Select the whole document, history included |
| `Shift+PageUp` / `Shift+PageDown` | Page through the history |
| `Escape` | Leave the history and return to live |
| Any other key | Leave the history and type it |

## Troubleshooting

### `npm install` fails with node-gyp errors

`node-pty` needs C++ build tools to compile its native bindings. Install the
tools listed under [Prerequisites](#prerequisites).

Windows quick fix:

```powershell
npm install -g windows-build-tools
```

### `npx myrlin-workbook` hangs on install

Same cause. `node-pty` is compiling. If it fails, install the C++ build tools
first, then try again.

### npm blocked the node-pty install script, and terminals are disabled

Modern npm (11.16 and later, and the default in npm 12) blocks dependency
install scripts until you approve them. When node-pty's build script is
blocked, the native terminal binary is never compiled, so the server boots in
degraded mode with the terminal panes disabled. Everything else keeps working.

Approve the script and rebuild. Approving alone does not rebuild a copy that is
already installed:

```bash
npm install-scripts approve node-pty
npm rebuild node-pty --foreground-scripts
```

Then restart the app.

### `npx` crash: `Cannot find module './prebuilds/linux-x64//pty.node'`

`node-pty` ships prebuilt binaries only for macOS and Windows; on Linux it must
compile during install. If the toolchain was missing or the install script was
blocked, an `npx` run could crash with that error.

Since the fix for
[issue #68](https://github.com/therealarthur/myrlin-workbook/issues/68) the app
no longer crashes in that case. It boots without terminals and prints a
platform-specific remediation banner. To restore terminals on Linux:

1. Install the build toolchain (Debian and Ubuntu):

   ```bash
   sudo apt install build-essential python3
   ```

2. Clear the stale `npx` cache so it reinstalls fresh, then run it again:

   ```bash
   npx clear-npx-cache
   # or remove it manually: rm -rf ~/.npm/_npx
   ```

3. If npm blocked the install script, approve and rebuild as shown above.

### A new version does not reach my phone

The document is served `no-store` and every asset it loads carries a version
stamp, so a hard refresh should be enough. If a phone is still on the old app,
clear the site data for it once and reload.

**Still stuck?** Open an
[issue](https://github.com/therealarthur/myrlin-workbook/issues) with your full
error output and your OS version.

---

## Repository layout

```
src/
  providers/
    index.js              # provider registry
    claude/               # discovery, parse, search, spawn, mirror for Claude Code
    codex/                # the same for ChatGPT Codex, plus state-db.js and usage.js
  state/
    store.js              # core state, JSON persistence plus an EventEmitter
    docs-manager.js       # per-project markdown docs
  core/
    session-manager.js    # launch, stop, restart
    workspace-manager.js  # project and focus CRUD
    process-tracker.js    # PID monitoring
    recovery.js           # auto-recovery on startup
    notifications.js      # event-based notifications
  web/
    server.js             # Express API, SSE, cost, search, conflicts, tunnels
    auth.js               # token auth and rate limiting
    pty-manager.js        # PTY session lifecycle
    vt-sidecar.js         # optional headless VT for deep scrollback
    mirror-service.js     # read-only transcript tailing
    git-manager.js        # git status, branches, worktrees
    public/
      index.html          # SPA shell
      app.js              # frontend application
      terminal.js         # TerminalPane, xterm.js over a WebSocket
      terminal-history.js # the scrollback surface
      styles.css          # themes and layout
  ui/                     # TUI mode, blessed
  index.js                # TUI entry point
  gui.js                  # GUI entry point
  supervisor.js           # restarts gui.js if it exits unexpectedly
```

The full test suite lives under `test/`, with browser acceptance tests in
`test/browser/`.
