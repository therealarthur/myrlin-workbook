# Session Sharing / Proxy Feature Plan

> Issue: [#10](https://github.com/therealarthur/myrlin-workbook/issues/10)
> Status: Pinned for later
> Created: 2026-03-07

## Problem

When a user starts a Claude Code session outside Myrlin (Windows Terminal, VS Code, bare CLI), Myrlin can discover it but can only launch a NEW session. Users want to observe and optionally interact with already-running sessions.

## Feasibility Summary

| Approach | Windows | macOS/Linux | Verdict |
|----------|---------|-------------|---------|
| Attach to existing PTY | Impossible (ConPTY is 1:1) | Possible via /dev/pts/N | Platform-split |
| node-pty attach existing | Not supported | Not supported | Dead end |
| JSONL file tailing | Works everywhere | Works everywhere | Best option |
| `claude --resume` from Myrlin | Creates conflicting 2nd writer | Same conflict | Dangerous |
| `claude -p --output-format stream-json` | Headless structured output | Same | Good for programmatic |
| Named pipe interception | Can't retrofit | N/A | Dead end |

**Winner: JSONL file-watching as a structured read-only mirror, with optional "Take Over" that forks into a Myrlin-owned PTY.**

## Three Tiers

### Tier 1: Live Session Mirror (Read-Only)

Watch any running Claude session in real-time, rendered as structured conversation (not raw terminal).

**What the user sees:**
- Discovered sessions that are actively running show a "live" indicator
- Clicking one opens a conversation view showing user messages, assistant responses, tool use blocks, progress indicators, and token usage
- New messages appear in real-time as Claude responds
- Full scrollback to conversation history

**Technical components:**

1. **JSONL Watcher Service** (`src/web/jsonl-watcher.js`, new)
   - Watches a specific `.jsonl` file on demand
   - Tracks byte offset; reads only new bytes on `fs.watch` events
   - Parses each line as JSON, emits structured events
   - Handles file rotation, caps concurrent watchers at ~10

2. **API Endpoints**
   - `GET /api/sessions/:id/mirror/start` - Start watching
   - `GET /api/sessions/:id/mirror/history` - Full parsed history
   - SSE channel extension for mirror events
   - `GET /api/sessions/:id/mirror/stop` - Stop watching

3. **Conversation Renderer** (`src/web/public/conversation-renderer.js`, new)
   - Renders JSONL entries as structured conversation UI
   - User messages as bubbles, assistant as markdown with syntax highlighting
   - Tool use as collapsible panels, progress as inline indicators
   - Auto-scroll with pinned-scroll detection

4. **Live Detection Enhancement**
   - Extend `GET /api/discover` to cross-reference running `claude.exe` PIDs
   - Windows: `tasklist /FI "IMAGENAME eq claude.exe" /FO CSV`
   - macOS/Linux: `ps aux | grep claude`
   - Add `isRunning` and `pid` fields to discovery results

**JSONL entry types:**

| Entry Type | Render As | Priority |
|------------|-----------|----------|
| `user` | User message bubble | Must have |
| `assistant` | Markdown response with tool_use blocks | Must have |
| `progress` (bash_progress) | Inline terminal output | Should have |
| `progress` (agent_progress) | Agent status card | Should have |
| `system` | System notice | Should have |
| `file-history-snapshot` | Git state indicator | Nice to have |
| `queue-operation` | Skip/hide | N/A |

**Performance:**
- JSONL files can be 10MB+; stream-parse, keep last N messages in memory
- Index by byte offset for pagination
- `fs.watch` on Windows has ~100-500ms latency (acceptable for conversation updates)

### Tier 2: Take Over / Fork

**What the user sees:**
- "Take Over" button in mirror view
- Confirmation dialog explaining the fork
- Opens new terminal pane running `claude --resume <uuid> --fork-session`
- Full PTY read/write via existing infrastructure

**Technical:**
- `POST /api/sessions/:id/fork` endpoint
- PTY manager: add `--fork-session` flag to command building
- Creates independent session with full history but new UUID
- Original session continues running independently

### Tier 3: Multi-Client PTY Sharing (Myrlin-Spawned Only)

**Backend already supports this.** `pty-manager.js` uses `session.clients = new Set()` and broadcasts to all WebSocket clients. New clients get scrollback replay.

**Work needed is frontend only:**
- "Joining existing terminal" indicator when opening a session with a live PTY
- Shared badge on tab/pane
- Optional: input arbitration (presenter mode vs. shared input)

## Implementation Phases

| Phase | What | Effort | Value |
|-------|------|--------|-------|
| 1 | Live detection (is session running?) | Small | Foundation |
| 2 | JSONL watcher service | Medium | Core |
| 3 | Conversation renderer | Medium | Core |
| 4 | Mirror view integration | Medium | Tier 1 complete |
| 5 | Fork/Take Over | Small | Tier 2 complete |
| 6 | Multi-client PTY sharing UX | Small | Tier 3 complete |

## Files to Create

| File | Purpose |
|------|---------|
| `src/web/jsonl-watcher.js` | JSONL file tailing with byte-offset tracking |
| `src/web/public/conversation-renderer.js` | Structured conversation view component |

## Files to Modify

| File | Changes |
|------|---------|
| `src/web/server.js` | Mirror API endpoints, live detection in discover |
| `src/web/pty-manager.js` | `--fork-session` flag support |
| `src/web/pty-server.js` | Fork session query param |
| `src/web/public/app.js` | Mirror view panel, fork button, shared indicators |
| `src/web/public/index.html` | Mirror view container markup |
| `src/web/public/styles.css` | Conversation renderer styles |

## Dependencies

No new npm packages required. `fs.watch` is built-in. Optional: `chokidar` for more reliable cross-platform watching.

## Open Questions

1. Mirror view location: new panel type, terminal pane variant, or full-screen?
2. Multi-user scope: different browsers/machines, or just multi-pane within one browser?
3. Input to external sessions: read-only acceptable? (Windows has no alternative)
4. macOS /dev/pts approach: pursue for richer experience, or JSONL-only for consistency?

## Key Research Findings

- ConPTY on Windows is strictly 1:1 (host:child). No handle sharing or attachment after creation.
- Claude CLI is single-writer; two `--resume` instances on same session corrupt state.
- `--fork-session` flag exists specifically to avoid conflicts when resuming.
- VS Code terminal sharing (Live Share) uses relay proxying, same concept as our WebSocket approach.
- Existing tools (clog, claude-code-viewer) prove JSONL tailing works well.
- PTY manager already supports multi-client broadcast; Tier 3 is mostly free.
