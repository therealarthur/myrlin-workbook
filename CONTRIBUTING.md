# Contributing to Myrlin Workbook

Thanks for wanting to contribute! Here's how to get started.

## Getting Set Up

1. **Fork** the repo on GitHub (top right button)
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/myrlin-workbook.git
   cd myrlin-workbook
   npm install
   ```
3. **Run** it to make sure everything works:
   ```bash
   npm run gui:demo   # demo mode with sample data
   npm test           # run the test suite
   ```

## Making Changes

1. Create a branch off `main`:
   ```bash
   git checkout -b fix/your-fix-name
   ```
2. Make your changes
3. Run tests to make sure nothing broke:
   ```bash
   npm test
   ```
4. Commit with a clear message explaining what and why:
   ```bash
   git commit -m "Fix thing that was broken because reason"
   ```
5. Push to your fork:
   ```bash
   git push origin fix/your-fix-name
   ```
6. Open a **Pull Request** against `main` on the original repo

## Pull Request Guidelines

- Keep PRs focused. One fix or feature per PR.
- Include a short description of what changed and why.
- If it's a visual change, a screenshot helps.
- Make sure `npm test` passes.
- Don't worry about being perfect. We'll work through any feedback together.

## Branch Naming

Use whatever makes sense, but these prefixes help keep things organized:

- `fix/` for bug fixes
- `feat/` for new features
- `docs/` for documentation changes
- `refactor/` for code cleanup

## Project Structure

```
src/
  state/        # Core data store + docs manager
  core/         # Session management, recovery, notifications
  web/
    server.js   # Express API + SSE + cost tracking
    pty-manager.js  # Terminal sessions (node-pty + WebSocket)
    auth.js     # Token authentication
    public/     # Frontend SPA (vanilla HTML/CSS/JS)
      app.js    # Main application (~8000 lines)
      terminal.js   # Terminal pane class
      styles.css    # All themes + layout
      index.html    # SPA shell
  ui/           # TUI (blessed) - terminal UI mode
```

## Running Locally

| Command | What it does |
|---------|-------------|
| `npm run gui` | Start the web UI (live data) |
| `npm run gui:demo` | Start with sample data |
| `npm start` | Start the TUI (terminal mode) |
| `npm test` | Run test suite |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CWM_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `CWM_PASSWORD` | `myrlin` | Login password |
| `CWM_NO_OPEN` | unset | Skip auto-opening browser on start |

## Questions?

Open an issue. No question is too small.

## License

AGPL-3.0. By contributing, you agree your code will be released under this license.
