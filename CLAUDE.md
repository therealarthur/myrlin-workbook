# Claude Workspace Manager

## CRITICAL SCOPE CONSTRAINT
**You MUST only create, edit, and modify files within this project directory.**

**NEVER modify files outside this folder.** This includes:
- Do NOT edit `~/.claude/settings.json` or any global config
- Do NOT edit files in other projects
- Do NOT modify system files
- All scripts, configs, tests, and output MUST stay within this folder

If you need to READ files outside this folder (e.g., to understand Claude session data), that's fine. But all WRITES stay here.

## Project Goal
Build a lightweight terminal workspace manager for Claude Code sessions that:
1. **Persists session state** — tracks which Claude sessions are running, their IDs, working directories, topics
2. **Auto-recovers after crash/restart** — saves state to disk, auto-reopens sessions on launch
3. **Groups sessions** — organize related sessions into named workspaces
4. **Notifications** — surface agent status, completion, errors
5. **Terminal UI** — clean, fast, minimal. Think tmux-inspired but purpose-built for Claude sessions

## Tech Stack Preferences
- PowerShell or Node.js (must work natively on Windows without WSL)
- State persisted to JSON in this folder
- Leverage Windows Terminal tabs/panes if possible
- Keep dependencies minimal

## Agent Teams
This project has agent teams enabled. Use teammates for:
- One teammate for core state management logic
- One teammate for terminal UI/display
- One teammate for testing and screenshots
- Coordinate via the lead agent

## Testing
- Build tests alongside the code
- Take screenshots of the working UI using Playwright or similar
- Store screenshots in `./screenshots/`

## File Structure
```
claude-workspace-manager/
├── CLAUDE.md          # This file
├── src/               # Source code
├── test/              # Tests
├── screenshots/       # UI screenshots
├── state/             # Persisted workspace state (JSON)
└── dist/              # Built output (if applicable)
```
