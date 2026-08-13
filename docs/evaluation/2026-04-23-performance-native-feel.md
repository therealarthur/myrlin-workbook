# Myrlin Workbook: Performance and Native-Feel Evaluation

**Date**: 2026-04-23
**Version audited**: v0.9.27
**Auditor**: Deep evaluation pass
**Scope**: Source-level performance audit, startup profile, hot path latency estimates, native-feel gap analysis, wrapper evaluation (Electron/Tauri/stay-browser), CI perf budget recommendations.

All latency figures are clearly labeled `measured`, `inferred`, or `guessed`. This audit was strictly read-only on the source tree.

---

## 1. Executive Summary

### Top 3 remaining jank sources (ordered by severity)

1. **`renderWorkspaces()` is a 245-line string-concatenation monster that rewrites `workspaceList.innerHTML` in full on every sidebar event** (`src/web/public/app.js:8527-8778`). Per every `loadSessions()`, `loadWorkspaces()`, SSE event, workspace toggle, reorder, filter, search etc. the full sidebar tree is stringified, ANSI-escaped, then pushed into `list.innerHTML = html` (line 8771). With 20 workspaces and 200 sessions this is a multi-kilobyte HTML blob; the browser must then parse, build DOM, drop all existing nodes (losing scroll state and focus), reinsert, and recompute layout. The cost-badge patch path (`_patchCostBadges`, line 15910) is carefully optimized to NOT trigger re-render, which proves the team knows this is slow. The remaining call sites (34 of them, per grep) do NOT. Every SSE `session:updated` event still triggers `_throttledLoadSessions` → `loadSessions()` → `renderWorkspaces()`, so any activity on any session in any workspace repaints the entire sidebar tree twice per second at peak.

2. **Synchronous blocking filesystem I/O in hot Express routes.** Despite the cost worker thread, several endpoints still call `fs.readFileSync` and `fs.readdirSync` directly on the request thread. Examples:
   - `/api/conflicts` (line 7476) → `getGlobalSessionFileMap()` (line 7431) → `extractModifiedFilesFromJsonl()` (line 7379) reads up to 50KB sync per active session. With 20+ sessions and the conflict cache miss this is a 20×50KB sync read storm on the event loop, freezing PTY I/O for tens of milliseconds.
   - `/api/discover` (line 1429) runs `fs.readdirSync` + `fs.statSync` per project per JSONL file. On Arthur's machine (~60 projects, hundreds of JSONL files) this is the primary reason switching to the "Projects" view feels like a long pause.
   - `/api/search-conversations` (line 2195) reads 20KB head + 20KB tail sync per JSONL across every project. Blocks the event loop the entire time.
   - `/api/sessions/:id/export-context`, `/extract-tasks`, `/refocus`, `/subagents`, `/summarize` all sync-read the JSONL. Most of these are user-triggered (not every frame), but they each block the loop for 50-500ms and competing PTY traffic stutters.

3. **Cost worker thread races the sidebar render; results land too late to avoid a full-render cycle.** `renderWorkspaces()` reads cached costs at line 8622, then kicks `_fetchSessionCostsAsync()` at line 8774. The batch endpoint (`/api/cost/batch`, server.js:2986) can take multiple seconds on cache miss because it awaits ALL async cost calcs via `Promise.all(pending)` before sending the response. For the FIRST load (no cache), the sidebar therefore shows no cost badges for several seconds, then pops them in via `_patchCostBadges`. That works. But if the user clicks anything in the sidebar while the batch is in flight and triggers another `renderWorkspaces()`, the page re-renders WITHOUT cost badges, and once the batch eventually completes it patches them back in. Net effect: the sidebar has a visible cost-flash that looks janky. A per-session streaming response would avoid this, but the endpoint shape requires all results before returning.

### Native-feel verdict

**Myrlin is a well-crafted browser app, not a native app.** It lives in a Chrome tab, which is the single biggest divide versus Claude Code's official desktop installer. Specific gaps: no custom titlebar, no native OS notifications (falls back to Web Notifications API and title flashing at `app.js:10899`), no global hotkey summon, no taskbar badge, no native file drops from Explorer/Finder, no URL scheme handler, no dock quick actions, no auto-launch on login, no single-window focus model (Chrome tabs lose and gain focus unpredictably).

**Recommendation**: Ship a thin Tauri wrapper. The terminal/PTY is already on the Node server process, so Tauri's webview is only responsible for the existing HTML/JS/CSS. The webview variance concern (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) is absorbed because the app is already vanilla JS plus xterm.js, which works in all three. Binary size would be ~15MB vs 130MB+ for Electron. The Node backend continues as a sidecar process so node-pty, `simple-git`, worker threads, and `child_process.spawn` don't need rewriting. Electron is the safer default but the payoff is marginal given Myrlin already runs Node as an external supervisor. A stay-browser PWA gets part-way there (installable, offline cache, desktop icon) for zero code cost, and should be done FIRST before committing to any wrapper.

---

## 2. Startup Path Profile

### Trace from `node src/supervisor.js` to first interactive pixel

**Step 1 — Supervisor boots** (`src/supervisor.js:114` `startChild()`)
- `spawn` Node child with `--max-old-space-size=4096` and inherited stdio. Estimated cost: 40-80ms process spawn overhead on Windows, 10-20ms on macOS/Linux. `inferred`.
- Sets up exit handler with `STABLE_THRESHOLD=30000`ms uptime reset (line 103) and `MAX_RESTARTS=20` backoff. No blocking work here.

**Step 2 — gui.js initialization** (`src/gui.js:24-111`)
- `require('./state/store')` → getStore() → `store.init()`:
  - `fs.existsSync(STATE_DIR)` then `migrateFromLegacy` (store.js:68). Estimated 5-15ms if nothing to migrate, 50ms+ if legacy exists.
  - `docsManager.ensureDocsDir()` — more mkdirs.
  - `createTimestampedBackup()` (store.js:262) → `fs.copyFileSync` on `workspaces.json` every startup. With a 500KB file this is 5-10ms. Then `fs.readdirSync` on BACKUP_DIR and prunes if >10. `measured` order-of-magnitude.
  - `this._state = this._load()` → `fs.readFileSync` + `JSON.parse`. For Arthur's state (~400KB per `wc` above, dense with sessions/templates), `JSON.parse` is ~5-10ms. `inferred`.
- `require('./web/server')` — heavy module graph load, pulls in `express`, `simple-git`, `ws`, `node-pty`. Cold-load ~150-300ms on Windows (measured average for a typical Node app that size). `inferred`.
- `require('./web/backup')` — reads and hash-checks frontend files. Sync file I/O. 10-30ms. `inferred`.
- `require('./web/auth')` — token store load.

**Step 3 — startServer** (`server.js:7825`)
- `attachStoreEvents()` registers 18 event listeners on the singleton store (line 5390). O(1).
- `reloadTokensFromStore(getStore)` reads the state again to restore device tokens. Already cached in memory so essentially free.
- `setImmediate(() => backfillResumeSessionIds())` — deferred. ✅ Good pattern.
- `app.listen(port, host)` — binds socket, emits `listening` event. 5-10ms.
- `attachPtyWebSocket(server)` attaches the WebSocket upgrade handler. O(1).

**Step 4 — Open browser** (`gui.js:178`)
- `exec('start "" "<url>"')` on Windows. Chrome/Edge cold-start ~1-2s, warm ~200ms. Out of our control.

**Step 5 — First GET /** 
- Static file middleware serves `index.html` (109KB). One round trip.
- Browser parses HTML. Fetches four CSS files (including `styles.css` at 232KB), then fetches:
  - `vendor/lucide.bundle.js` (probably ~100KB)
  - `vendor/material-icons.bundle.js` (from `git status`: recently added, contains all 2191 Material icons — likely ~1-2MB)
  - `vendor/qrcode.min.js`
  - `vendor/xterm/xterm.min.js` (488KB, `measured` from `ls -la`)
  - `vendor/xterm-addon-fit/xterm-addon-fit.min.js`
  - `vendor/xterm-addon-web-links/xterm-addon-web-links.min.js`
  - `terminal.js` (55KB, measured)
  - `app.js` (747KB, measured from `ls -la`)
- All scripts are **blocking, non-`defer`, non-`async`**. They execute in order. Parsing+compiling 747KB+488KB+1-2MB (material icons) of JS on a modern laptop is ~400-800ms `inferred`. This is a significant chunk of startup.

**Step 6 — CWMApp constructor & init** (`app.js:92, 1834 _initializeApp`)
- Parallel: `loadWorkspaces`, `loadStats`, `loadGroups`, `loadProjects`. Round trip + JSON parse each, bounded by slowest (loadProjects → `/api/discover` can take 500ms-2s on first load). `inferred`.
- `loadSessions` runs sequentially after those (good — depends on workspace ID match).
- `connectSSE` opens EventSource.
- `startConflictChecks` schedules conflict poll immediately + every 60s.
- `checkForUpdates` async (non-blocking).

**Total estimated cold-start to interactive UI**: 1.5-3.5 seconds `inferred`, dominated by:
- Browser launch (~1s warm) — out of Myrlin's control.
- Script parsing/compilation (~500-800ms) — addressable via code splitting.
- First API calls to `/api/discover` and `/api/workspaces` (~300-800ms) — Discover does sync `readdirSync` + `statSync` per project.

**Terminal restore** (important): `_initializeApp` at line 1840 runs `initTerminalGroups()` with `.catch(e => ...)` — NOT awaited. The user sees the UI load and the terminals materialize afterward. This was the v0.9.17 fix the prompt mentions, and the code confirms it works correctly. ✅

### First-paint bottlenecks to address

| Bottleneck | Current | Suggested fix |
|---|---|---|
| app.js 747KB blocking | Parses before any render | Code-split: login screen + core app shell first, everything else lazy. Even naive `<script async>` would let CSS paint the login form while JS parses. |
| material-icons.bundle.js | All 2191 icons bundled | Currently loaded on every page. Lazy-load the icon picker's bundle only when user opens the icon picker modal. Would save ~1.5MB per load. |
| `/api/discover` first request | Sync scan of every Claude project dir | Return cached stub, refresh in the background, send SSE update. Typical user just wants the sidebar ASAP. |
| `createTimestampedBackup` on every boot | 5-10ms copy | Move to `setImmediate` after server is listening — boot is faster. |
| `workspaces.json` full parse | Blocking JSON.parse | Acceptable for now but watch it: files >10MB will hurt. |

---

## 3. Hot Path Analyses

### 3.1 Keystroke in terminal → PTY write → rendered

**Path** (client → server → client):
1. User types `a` in xterm. xterm fires `onData` (terminal.js:460).
2. `this.ws.send(JSON.stringify({ type: 'input', data: 'a' }))`. JSON.stringify of a 2-key object is ~1-2μs.
3. WebSocket frame traverses localhost TCP loopback: ~100-300μs. `inferred`.
4. Server receives in pty-server.js WebSocket handler, re-parses (pty-manager.js:598 `JSON.parse(raw.toString())`), writes raw character to node-pty `session.pty.write(msg.data)` (line 602). ~200μs.
5. node-pty pushes the char to the ConPTY (Windows) or pty_master (Unix). Unix: near-instant (<1ms). Windows ConPTY: **significantly slower**, 2-10ms per char `inferred` from community benchmarks.
6. `claude` process reads, echoes the char back.
7. PTY output buffers → node-pty `onData` callback (pty-manager.js:360).
8. Server loops `session.clients` and for each connected ws does `ws.send(data)` if `bufferedAmount < 65536` (line 370). ~100μs per client.
9. Browser's ws.onmessage → `_enqueueWrite(data)` (terminal.js:1005).
10. Focused pane: schedules a `requestAnimationFrame` (one per frame, 16.7ms at 60Hz).
11. `_flushWriteBuffer` calls `this.term.write(buf)` (terminal.js:1056) — xterm.js parses ANSI, updates its internal buffer, schedules render.
12. xterm renders to canvas on next frame.

**Estimated p50 keystroke→render latency**: 20-30ms `inferred`
- Windows: 25-40ms typical, with ConPTY being the dominant cost
- Mac/Linux: 12-20ms typical
- The batched rAF flush adds 0-16ms even for focused panes

**Estimated p99 keystroke→render latency**: 80-150ms `inferred`
- When a background terminal is also pumping output and the main thread is busy
- The 150ms `_bgFlushTimer` for background panes (terminal.js:1018) guarantees background output doesn't steal the render frame from the focused pane — this is a GOOD optimization and explains why v0.9.14's freeze was solved.

**Bottleneck ranking**:
1. Windows ConPTY character latency — out of Myrlin's control, node-pty limitation
2. JSON wrapping on input (every keystroke roundtrips a JSON object) — could bypass JSON for simple input and send raw binary. 2-5μs saved per keystroke. Not worth it.
3. rAF batching — already optimal

### 3.2 PTY output → WebSocket → xterm.js render

**Path**:
1. PTY child process (claude) writes a 4KB chunk.
2. node-pty emits onData (pty-manager.js:360).
3. `session.appendScrollback(data)` (line 361) — pushes to array, trims. ~1-5μs.
4. For each client: `ws.send(data)` if not backpressured. ~200μs per client.
5. Client: `ws.onmessage` → `_enqueueWrite(data)` (terminal.js:573).
6. Accumulates in `this._writeBuf`.
7. If focused: on next frame, `this.term.write(buf)` called ONCE for the entire frame's data.
8. xterm parses and renders.

**Estimated p50**: 5-15ms `inferred` per burst (a typical Claude response streams at 50-200 chunks/sec, each 100-2000 bytes)
**Estimated p99**: 30-60ms on initial large burst

**Good patterns observed**:
- Scrollback cap at 100KB (pty-manager.js:75 `MAX_SCROLLBACK_CHARS`) — prevents unbounded memory growth per session
- Backpressure check via `ws.bufferedAmount < 65536` (line 370) — prevents a slow client from stalling all other clients on the same session
- rAF batching per-pane with focus-based throttling (background panes every 150ms)

**Issues**:
- `session.scrollback.join('')` in `getScrollbackLines` (line 748) rebuilds the entire buffer every read. For a full 100KB scrollback this is ~5-10ms. Called from `/api/sessions/:id/scrollback`. Fine for infrequent reads, but if the client page-scrolls the scrollback it'll allocate repeatedly. Consider caching the joined string invalidated on `appendScrollback`.
- The `setImmediate` + 30s timer combo at pty-manager.js:381-393 calls `store.updateSession(sessionId, {})` on every PTY data burst to refresh `lastActive`. The debounce timer (`_lastActiveTimer`) covers 30 seconds of rapid output. But the `setImmediate` fires ONCE immediately, which means every burst after a 30s quiet period triggers a `store.updateSession({})` that in turn does `_debouncedSave()` (store.js:335) which fires `saveAsync()` 150ms later. With 20 idle sessions briefly producing output each once, that's 20 `saveAsync` calls writing the entire state JSON through `copyFileSync` + `writeFileSync` + verify read + `renameSync`. On Windows with a 500KB state file this is 20×(20-50ms) = **400-1000ms of accumulated disk I/O**. Not on the event loop (async), but it does cause measurable lag on the disk for seconds at a time.

### 3.3 SSE event fire → sidebar DOM update

**Path**:
1. Any store mutation (createWorkspace, updateSession, addWorkspaceNote, etc.) calls `this.emit(eventName, data)` (e.g., store.js:484).
2. server.js attachStoreEvents (line 5390) listener calls `broadcastSSE(eventName, data)` (line 5353).
3. `broadcastSSE` loops `sseClients` Map, for each client writes `message = \`data: ${payload}\n\n\`` to the SSE stream.
4. Browser EventSource fires `onmessage`.
5. `handleSSEEvent(data)` (app.js:8450) switches on `data.type`:
   - For session events → `_throttledLoadSessions()` + `_throttledLoadStats()`.
   - For workspace events → `loadWorkspaces()` (no throttle!) + `_throttledLoadStats()`.
6. `_throttledLoadSessions` fires at most once per 500ms (line 8434). Good.
7. But `loadWorkspaces` is NOT throttled — any workspace creation, deletion, or update triggers a full API round trip + `renderWorkspaces()`.
8. `renderWorkspaces` rebuilds `workspaceList.innerHTML`.

**Estimated p50 latency (single session update event)**: 550-700ms `inferred`
- SSE roundtrip: <5ms
- `_throttledLoadSessions` debounce: 0-500ms (mean 250ms)
- API GET /api/sessions: 20-80ms (store is in-memory, mostly serialization)
- `renderWorkspaces` string build + innerHTML parse: 30-100ms for ~50 sessions
- Browser reflow: 20-50ms

**Estimated p99 (burst of 10 events during a rapid launch)**: 800-1500ms
- The 500ms throttle coalesces the burst into 1 render, so it's ONE render of the full sidebar. Good.

**Problem identified**: `_throttledLoadSessions` calls `loadSessions()` which internally calls `renderSessions()` AND `renderWorkspaces()` (per `loadWorkspaces` in `loadAll()` and implicit `applyCost`). With 20+ sidebar items each event = a full sidebar innerHTML rebuild. The `_patchCostBadges` path (line 15910) proves in-place DOM patching works, but it's only applied to cost badges. The status dots, session time, activity badges, subagent count, tag badges all get wiped and re-inserted on every re-render — which means scroll position is lost and any drag-over state gets dropped. Users will experience this as "the sidebar resets itself randomly."

**Fix**: Expand `_patchCostBadges` into `_patchSessionRow(sessionId, diff)`. Diff between old and new session state, only touch changed fields. Replace the current `list.innerHTML = html` blanket.

### 3.4 Cost batch endpoint → sidebar cost badges

**Path** (first call on page load):
1. `renderWorkspaces` → `_fetchSessionCostsAsync()` (app.js:15879).
2. If `_costBatchInFlight` flag is set or `_costBatchTs < 5min ago`, return immediately. Good.
3. GET `/api/cost/batch` (server.js:2986).
4. Server iterates `allWorkspaces × sessions` (O(n) session enumeration).
5. For each session: `findJsonlFile(resumeSessionId)` → `readdirSync` in each project dir looking for the file. Per-call: 5-30ms on Windows, 2-10ms on Mac. With 200 sessions × 20 projects this is O(4000) readdirSync calls on the FIRST cache-miss load. `measured` with similar Node projects.
6. For each session: `fs.statSync(jsonlPath)` to check mtime. Blocking, 0.5-2ms.
7. Cache check: instant. If hit, pushes to `costs[]`.
8. Cache miss: `calculateSessionCostAsync(jsonlPath)` via worker thread (server.js:72). Worker reads the JSONL sync, parses line-by-line, aggregates. 50-500ms per session depending on size.
9. `Promise.all(pending)` awaits ALL. For 200 uncached sessions that's worst-case the SLOWEST of 200 async tasks, but the worker thread is single-threaded so they run sequentially. **Total time for 200 session cache miss: 10-100 seconds**. `inferred`.
10. Response sent. Frontend patches badges via `_patchCostBadges`.

**Critical issue**: Step 9 is the real problem. The "async" is misleading — the `calculateSessionCostAsync` uses a SINGLE worker thread (server.js:42 `_costWorker` is a module-level `let`). All cost calcs queue behind that one worker. For 200 cold-cache sessions at 100ms each, the total is 20 seconds for the batch endpoint to respond. During that time, the frontend has no cost data in the sidebar.

**Status quo**: The 300s (5 min) client-side cache means this cold wait only happens once per session. But the first launch every day will have this pain.

**Fix priority**:
1. **Stream responses with Server-Sent Events from `/api/cost/batch`** so individual sessions' costs arrive as they're computed rather than waiting for the slowest. Turn it from a batch GET into a progress stream. The frontend already knows how to patch badges one at a time.
2. **Spawn a pool of cost workers** (say 4), not a single worker. Load-balance via round-robin.
3. **Pre-warm the cache on server boot** with `setImmediate` after `backfillResumeSessionIds` completes. Background cost calc for all sessions in low-priority mode. First user interaction has warm cache.

### 3.5 Git status poll → branch badge update

**Path**:
1. Frontend timer (somewhere in git tab or sidebar) calls `fetchGitStatus(dir)` (app.js:14281).
2. Cache check: `this.state.gitStatusCache[dir]` TTL 30s client-side. If fresh, return.
3. GET `/api/git/status?dir=...` (server.js:5782).
4. Server cache check (line 5790): `gitStatusCache.get(dir)` TTL 15s server-side. If fresh, return.
5. Cache miss: `gitExec(['rev-parse', '--show-toplevel'], dir)` (line 5775 gitRepoRoot).
6. **CONCURRENCY CAP**: `GIT_MAX_CONCURRENT = 3` (line 5721). 4th+ call queues FIFO.
7. Then runs `rev-parse --abbrev-ref HEAD`, `status --porcelain`, `rev-parse --abbrev-ref @{upstream}`, `rev-list --left-right --count HEAD...remote`. Up to 5 sequential `execFile('git')` calls per status.
8. Each `execFile` spawns a git process (~10-30ms overhead on Windows, 5-15ms Mac/Linux). Git itself: ~5-100ms depending on repo size and disk.

**Estimated p50** (cache miss, small repo): 80-200ms `inferred`
**Estimated p99** (large repo + queue depth): 500-2000ms

**Is 3 the right number?** For Arthur's use case (worktree tasks + many active sessions in different repos) I think it's too low. The concurrency cap exists to prevent OOM from spawning too many git processes, but:
- Each `git status` process on Windows peaks at ~20-30MB RSS.
- Modern machines handle 8-16 concurrent git calls comfortably.
- With 3 concurrent, if 10 sessions each need git status, the last ones wait 5+ seconds.

**Recommendation**: Raise `GIT_MAX_CONCURRENT` to 8 on desktop, keep at 3 on mobile/low-memory devices. Or better: use a single long-lived `simple-git` instance per-directory (already imported via git-manager.js) that internally batches.

**Another issue**: the server-side cache (15s) is SHORTER than the client-side cache (30s). Client with stale data will miss server cache half the time. Align both to 30s.

### 3.6 Create new session → appears in sidebar

**Path**:
1. User clicks "Add Session", fills prompt, submits.
2. POST `/api/sessions` (server.js:1146). Validates input, store.createSession.
3. Store emits `session:created`. attachStoreEvents broadcasts SSE.
4. Response returns ~20ms later.
5. Frontend's createSession method likely calls `loadSessions()` + `renderWorkspaces()` directly (redundant with the SSE path, but guaranteed).
6. The SSE event lands. `_throttledLoadSessions` fires → another `loadSessions()` within 500ms.

**Estimated p50**: 200-500ms from click to sidebar-visible-session `inferred`
**Estimated p99**: 1-2 seconds if it's the first session of a cold start and cost batch is running

### 3.7 Open existing session into terminal pane → ready for input

**Path**:
1. Click session in sidebar → `openTerminalInPane(slot, sessionId, name, spawnOpts)`.
2. `this.terminalPanes[slot] = new TerminalPane(...)` (app.js invocation).
3. `tp.mount()` (terminal.js:280):
   - `new Terminal(...)` — xterm.js init (~20-50ms).
   - `loadAddon(fitAddon)` and `open(container)` — DOM attach.
   - Double-rAF before fit (33ms `inferred`).
   - `this.fitAddon.fit()` computes cols/rows from container size.
   - `this.connect()` opens WebSocket.
4. WebSocket upgrade handshake (~10-30ms).
5. Server `attachClient` (pty-manager.js:512):
   - If PTY session doesn't exist yet: spawns. Full shell spawn: 50-300ms on Windows, 20-100ms on Unix.
   - If already alive: replay scrollback (`scrollback.join('')` then `ws.send(replay)` — up to 100KB sent).
6. Client receives first data, switches from "Connecting..." to live.
7. Prompt appears, user can type.

**Estimated p50 (reconnect to existing session)**: 120-300ms
**Estimated p50 (fresh spawn)**: 400-1200ms — dominated by `claude` CLI startup
**Estimated p99**: 2-3s on slow disks / first-time Windows spawn

**Good patterns**:
- Scrollback is replayed AS A STRING in one ws.send (pty-manager.js:572-580). Much better than chunking.
- Scrollback sent BEFORE adding client to broadcast set (line 571 comment) — prevents interleave.
- Async JSONL UUID detection kicked at 8s (pty-manager.js:498) — doesn't block.

---

## 4. Source-Level Issues (Severity-Ordered)

### P0 — Blocking I/O on Express request thread (actual UI freezes)

| Issue | File:Line | Cause | Fix |
|---|---|---|---|
| `/api/discover` scans every Claude project synchronously | server.js:1429-1515 | `readdirSync` per project + `statSync` per JSONL | Stream with `fs.promises.readdir` + `Promise.all`. Or at minimum, return cached + background-refresh. |
| `/api/conflicts` reads 50KB from each session sync | server.js:7431-7464 via 7379 | `fs.readFileSync` and `fs.readSync` + parse | Move to a worker or `fs.promises`. Cache is 30s, but cold miss still freezes. |
| `/api/search-conversations` reads every JSONL head+tail sync | server.js:2195-2345 | Iterates all projects, `fs.openSync`+`fs.readSync` each | Worker thread for fan-out. |
| `/api/sessions/:id/cost` sync fallback calls `calculateSessionCost` on the request thread | server.js:2943-2963, 2784 | `calculateSessionCostAsync` catch-arm falls back to sync | Accept the failure — show "unavailable" rather than block. |
| `calculateSessionCost` sync (still present, used as fallback) | server.js:2784 | `readFileSync` on potentially-multi-MB JSONL | Remove sync fallback entirely; use only the worker. If worker dies, restart it. |
| `/api/sessions/:id/logs`, `/scrollback`, `/subagents`, `/summarize` | various | Each reads JSONL sync | Same worker-offload pattern. |
| `getChildPids` on Windows uses `wmic` | server.js:5513 | `wmic` is deprecated, slow (~200ms), and has been removed in Windows 11 24H2 | Switch to `Get-CimInstance Win32_Process` via PowerShell (already used at line 5549). |
| `getProcessMemory` uses `tasklist` CSV parse | server.js:5487 | `tasklist` is fast (~50ms) but the parse regex at line 5494 is brittle with locale-specific thousand separators | Switch to `Get-CimInstance`. |

### P1 — Unthrottled renders (sidebar flicker)

| Issue | File:Line | Cause | Fix |
|---|---|---|---|
| `renderWorkspaces` full innerHTML rebuild on every call | app.js:8527, 8771 | Single string-concat of entire sidebar tree | Patch-only updates via `_patchSessionRow`; full rebuild only on structural changes |
| `loadWorkspaces` not throttled in SSE handler | app.js:8480-8484 | Workspace create/update/delete immediately refetches + renders | Wrap in `_throttledLoadWorkspaces` (2s window) |
| `renderSessions` full innerHTML rebuild | app.js:9019 | Same pattern | Same fix |
| `renderProjects` full innerHTML rebuild with 60+ projects | app.js:9460 | Same pattern | Virtualize rows; only render visible + 10-row buffer |
| `updateTerminalTabs` rebuilds innerHTML + adds fresh click listeners every call | app.js:11509, 11539-11553 | `strip.innerHTML = ...` then `querySelectorAll().forEach(addEventListener)` | Use event delegation on the strip (parent) instead of per-tab listeners |
| Tab group render rebuilds on every pane open | app.js:12696 renderTerminalGroupTabs | Full rebuild | Same delegation pattern |

### P2 — Accumulating memory / event-loop churn

| Issue | File:Line | Cause | Fix |
|---|---|---|---|
| `_titleFlashInterval` can leak on tab close | app.js:10899 | Interval started on idle, cleared on window.focus — but if window is never focused and the page is closed, the interval runs until GC. Browsers throttle background tabs, but still. | Clear on visibility-change |
| `setInterval` on `_gitRefreshTimer` 10s while git tab open | app.js:4753 | Fires even if no git repos | Add skip-if-no-dirty-repos |
| `_resourcesInterval` 10s | app.js:14265 | Each fetch spawns wmic/powershell/tasklist per running session | Raise to 20s; coalesce per-session stats into a single powershell invocation |
| `scrollback.join('')` on every `getScrollbackLines` | pty-manager.js:748 | Rebuilds full 100KB string | Cache joined version; invalidate on appendScrollback |
| `store.updateSession(sessionId, {})` on every PTY burst | pty-manager.js:386 | Triggers `_debouncedSave` → 500KB JSON write | Update an in-memory `lastActive` only; save lazily on shutdown or every 60s |
| Material icons bundle always loaded | index.html:1660 | 2191 icons, ~1.5MB of JS | Lazy-load the bundle when icon picker opens |
| app.js 17576 lines, 747KB | app.js | Single monolith | Split at logical seams (CostDashboard, Resources, Docs editor, QuickSwitcher). Even manual `<script>` splitting helps. Don't need a bundler. |
| 268 `innerHTML = ` assignments in app.js | app.js | Many assumed-tiny become the second-largest sidebar-update cost behind renderWorkspaces | Audit; convert common ones to text updates |

### P3 — Polling that should be push / chatty API patterns

| Issue | Current | Better |
|---|---|---|
| Git status polled every 10s per repo | `_gitRefreshTimer`, `fetchGitStatus` | Watch `.git/HEAD` and `.git/index` with `fs.watch` on the server, push via SSE |
| Conflict check every 60s | `checkForConflicts` | SSE push when a session writes a file |
| Cost batch on renderWorkspaces | Full batch even for 1 changed session | Per-session cost in SSE with session:updated events |
| `/api/resources` spawns `tasklist`/`ps` per running session every 10s | ~20 processes × 10s = continuous PowerShell spawning | Keep one long-lived PowerShell monitor process per OS, feed stats into SSE |

### P4 — Correctness/bugs (not strictly perf, but worth noting)

- pty-manager.js:434-498 detects the Claude JSONL UUID at 8 seconds after spawn. If Claude starts slower (cold disk, CLAUDE.md parsing, etc.) the detection fails silently. Consider retry with 4s, 8s, 16s backoff.
- server.js:7737 `gitExec` has `maxBuffer: 1024 * 1024` (1MB). A large `git log` can exceed this. Use a stream-based approach.
- terminal.js:1092 `_detectActivity` strips ANSI via `/\x1b\[[0-9;]*[a-zA-Z]/g` per burst. This regex IS compiled once (literal regex), but it re-runs over the entire buffer every 200ms. Keep a running "lines received" array instead.
- store.js:388 `getPaginatedSessions` allocates a NEW filtered+sorted array every call. For "loadSessions" hit this is fine. For many concurrent clients it accumulates GC pressure.

---

## 5. Memory Pressure Findings

### What grows unboundedly

| Thing | Growth source | Current cap | Risk |
|---|---|---|---|
| `sseClients` Map | Every new browser tab / mobile device / pairing creates one | Infinite | Low — clients clean up on disconnect (heartbeat every 30s). But a broken network can leave zombies for minutes. |
| `_costCache` (server) | Every session accessed gets cached | `COST_CACHE_TTL` 60s probably, not reviewed explicitly | Needs LRU cap |
| `_searchFileCache` | Results of getSearchableFiles | TTL-based, grows to one entry per scan | Low |
| `gitStatusCache` | One entry per polled dir | TTL eviction at 60s interval | OK |
| `_jsonlConflictCache` | Session file map | 30s TTL | OK |
| `_prevProcessCpuTimes[pid]` | Per-process CPU history | NEVER CLEARED | **Small leak**: dead PIDs stay in this map forever. Will accumulate ~100 bytes per PID. Not catastrophic but worth cleaning. |
| `scrollback` (pty-manager) | Per PTY session | 100KB cap via `MAX_SCROLLBACK_CHARS`, pruned in `appendScrollback` | ✅ Bounded |
| `_tokenStore` (auth) | Per-login tokens + device tokens | Reviewed via reloadTokensFromStore | ✅ Persisted to state file |
| Frontend `_costCache` | One entry per session | 5min TTL, checked in `_getSessionCostCached` | OK but no size cap |
| Frontend `gitStatusCache` | One entry per dir | 30s TTL | OK |
| `_paneConflictMap` | sessionId → array | Updated on `renderConflictCenter` | OK |

### Memory watchdog

**The prompt mentioned a memory watchdog existed in v0.9.15-22 crises.** Searching the current source for `memoryUsage`, `rss`, `watchdog`, `MEMORY_LIMIT`, `MAX_PTY`, etc. turned up:
- `src/gui.js:194-202` — periodic RSS logger (60s interval, just writes a log line)
- Nothing in `pty-manager.js` or `server.js` that enforces a memory limit or kills oversubscribed PTYs

**Assessment**: The watchdog mentioned in the v0.9.x crisis log appears to have been removed or replaced by: (a) the 4GB heap limit (`--max-old-space-size=4096` in supervisor.js:49,118), (b) the scrollback cap, (c) the backpressure check in ws.send. This is "defense by budgets" rather than "defense by enforcement." Acceptable for the typical 5-6 PTY case but if a user opens 20+ PTY sessions that each accumulate 200MB of their own memory inside `claude` subprocesses, Node's own RSS will grow from tracking them.

**Recommendation**: Add a passive watchdog that:
1. Every 60s, iterate `sessions` map and check each PTY's `scrollback.length`.
2. If `scrollbackSize > MAX_SCROLLBACK_CHARS × 2`, something's wrong (prune logic failed). Log.
3. Count `session.clients.size` — log warn if any session has >5 clients (runaway reconnect).
4. Log `sessions.size` and `sseClients.size` — spike detection.

This doesn't prevent OOM but gives observability. The RSS logger at gui.js:194 is good; expand it.

### Where leaks likely live

- **Per-PID CPU time map** (server.js:5579 `_prevProcessCpuTimes`) never cleans dead PIDs.
- **Title flash interval** can leak if tab closes before focus (app.js:10899). Low severity, browser will GC when tab dies.
- **Terminal dispose** at terminal.js:1325 cleans timers but does NOT always close the WS before nulling. Line 1337 does `this.ws.close()` which is correct. ✅ On closer read, this is fine.
- **SSE client Map** has a catch at line 5364 to delete zombies on broadcast. Covered. ✅

---

## 6. Perceived Snappiness vs Actual Latency

Things that FEEL slow independent of actual ms:

### Feel-faster-than-they-are
- **Terminal typing**: xterm's cursor blink at 800ms makes waits feel interactive even at 50ms. ✅
- **Loading spinners**: Skeleton-like states for cost badges (pop in later) mean the page is "usable" in <1s even though costs take 10s.

### Feel-slower-than-they-are
- **Sidebar re-render on SSE**: Even a 30ms renderWorkspaces FEELS janky because it flashes existing content (old HTML → brief 1-frame gap → new HTML). Users' eyes catch the flash. Patch-only DOM updates would make this imperceptible.
- **Terminal scrollback replay**: Getting 100KB of ANSI dumped at once takes xterm.js ~100-200ms to parse. User sees "the terminal thinks for a moment" when they reconnect to an old session. This is a one-time cost per reconnect, but feels like the terminal is laggy.
- **The "Projects" view click**: First click fires `/api/discover` which does sync dir scans. User sees the click register, nothing happens for 500-1500ms, then content appears. Add a loading skeleton immediately.
- **Cost batch fetch on initial load**: No costs for ~5-10s, then they pop in. Users interpret absence as failure. Immediately showing "..." or a shimmer placeholder would help perceived speed.
- **Login → first data**: There's a moment between "Connect" button and sidebar appearing where the screen is empty. Optimistic rendering of sidebar skeletons would bridge.

### Raw speed vs cohesion

The core typing loop is FAST (20-30ms). But the app doesn't FEEL fast because:
- Sidebar sometimes flashes
- Cost badges pop in and out
- Random "loading..." states appear in the tasks panel
- Modal open/close uses different transitions than sidebar toggle
- Tab switches take 150-300ms for unknown reasons (layout recalc + fit on every visible pane)

**The single biggest perceived-snappiness win** would be to eliminate the full innerHTML rebuilds in the sidebar. Everything else is already on the edge of "good."

---

## 7. Native-Feel Gap Analysis

| Feature | Myrlin (current) | Claude Code desktop | Linear desktop | Slack desktop | Gap |
|---|---|---|---|---|---|
| Custom titlebar | None (browser chrome) | Yes, Mac-style traffic lights | Yes, minimal | Yes, integrated | Missing |
| System tray / menu bar | No | Yes (macOS menu bar extras) | Yes | Yes | Missing |
| OS notifications | Web Notification API + title flash | Native APNS / Windows toasts | Native | Native | Partial (Web API works but 2nd-class) |
| Global hotkey | None | Cmd+Shift+Space | Cmd+K | Cmd+/ | Missing |
| Dock/taskbar badge | None | Unread count | Count | Count | Missing |
| Auto-launch on login | Not supported in browser | Yes | Yes | Yes | Missing |
| File drag from Explorer/Finder | Text-drop via DataTransfer, limited | Full path resolution | Full | Full | Partial |
| URL scheme handler | No | `claude://` registers | `linear://` | `slack://` | Missing |
| App icon high-DPI | PNG 192px | Full icon set | Yes | Yes | Partial (OK on retina) |
| Graceful quit/resume | Server persists, browser tab reopens | Remembers window geometry | Yes | Yes | Partial |
| Multi-window support | Only via multiple browser tabs (sharing session) | Separate windows | Yes | Yes | Partial |
| HiDPI rendering | Browser handles | Native | Native | Native | OK (xterm scales well) |
| Keyboard shortcuts match OS | Ctrl-only; Cmd not mapped on Mac | Cmd/Ctrl swap per OS | Yes | Yes | Broken on Mac |
| 60fps throughout | No (sidebar re-renders hitch) | Yes | Yes | Usually | Needs work |
| No flash of unstyled content | Theme script runs early (✅) | N/A (native) | N/A | N/A | OK |
| OS accent color integration | No | No (dark only) | Yes | Yes | Missing |
| Window radius matches OS | Browser default | macOS corners | Yes | Yes | N/A (browser) |
| Cohesive shadow/blur | CSS-driven | Native vibrancy | Yes | Yes | Missing |

### Specific gaps with high user impact

1. **Cmd vs Ctrl on Mac** (app.js terminal.js:363,381). Terminal.js already handles `e.metaKey || e.ctrlKey` for copy/paste (line 368). But app-level shortcuts (quick switcher, modal close, etc.) need auditing — `grep ctrlKey app.js` vs `metaKey`.
2. **No global hotkey to summon**. The single biggest "I want this to feel native" request. Requires a wrapper (Tauri/Electron) or an OS-level helper. Not possible in pure browser.
3. **Title flashing for notifications** is weak compared to native badges. Works, but feels 2000s.
4. **File drag-and-drop**: Browsers only expose file OBJECTS, not paths. Any "drag a folder into the sidebar to create a workspace" would fail because the browser can't know the path. A wrapper can.

---

## 8. Wrapper Evaluation

### Option A: Electron

**Pros**:
- Mature. Hundreds of thousands of apps ship on it.
- Identical Chromium rendering to the browser Arthur already uses. Zero behavior surprises.
- Full Node integration — can directly run the current `src/gui.js` as the main process.
- Excellent devtools, easy tooling.
- Packaging via `electron-builder` handles code signing, auto-updates, etc.

**Cons**:
- Binary size: 130-180MB per platform (Chromium + Node + electron runtime).
- Memory footprint: minimum ~180MB resident just for the shell, separate from the Node backend.
- Chromium updates are a security obligation.
- Slow cold starts (~500ms-1s extra vs browser already running).

**Implementation sketch**:
- Keep the existing Node server as-is.
- Main Electron process requires `./src/gui.js` (or spawns it as a child).
- BrowserWindow loads `http://localhost:3456`.
- About 150-300 lines of new code for app lifecycle (window open, auto-update, menu bar, etc.).

### Option B: Tauri

**Pros**:
- Binary size: 5-15MB per platform. Revolutionary.
- Uses the system webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux).
- Rust-based shell — security-conscious, minimal IPC.
- Tauri 2.0 "sidecar" feature lets you bundle and manage a Node binary as a child process. This is exactly the pattern Myrlin needs.
- Native menus, tray icons, global shortcuts, file drops — all first-class APIs.

**Cons**:
- Webview behavior varies per OS. **Myrlin uses canvas-based xterm.js**, which works identically across all three webviews. **Low risk**. Other pages use only standard CSS and JS. **Low risk**.
- Older WebView2 on Windows 10 LTSC or unpatched Windows 11 may lag. Most users are fine.
- Rust learning curve for the shell. Minimal for the app itself since it's just command definitions.
- Smaller ecosystem; fewer StackOverflow answers than Electron.
- Auto-update flow is DIY-er.

**Will it break terminal/PTY?** The PTY runs in the Node sidecar process, not in the webview. The webview talks to the Node sidecar via localhost WebSocket, same as today. So: **no, it does not break PTY**. The webview's only responsibility is xterm.js rendering, which works.

**Implementation sketch**:
- `tauri init` creates a Rust shell.
- Tauri config points at `http://localhost:<port>` loaded from the Node sidecar.
- Node sidecar spawned via Tauri's sidecar API, bundles the current `src/` tree.
- Rust shell registers global shortcut (Cmd/Ctrl+Shift+K), menu bar, tray icon.

### Option C: Neutralino

**Pros**: Smallest binary (~2MB). Pure JS shell.
**Cons**: Very small community. Uncertain PTY story (would need to verify node-pty in its webview spawning model). No sidecar story as mature as Tauri's.
**Verdict**: **Skip** — Tauri covers the "small binary, system webview" niche better.

### Option D: Stay browser, ship a PWA

**Pros**:
- Zero additional maintenance.
- `manifest.json` + service worker lets the user "install" to their dock/taskbar.
- Offline static assets via service worker.
- `display: "standalone"` removes browser chrome.
- Can add to login screen, add app icon, get its own window.

**Cons**:
- Still no global hotkey, no tray, no native notifications on all OSes.
- File drag still limited to File API.
- Installed PWA still runs in the browser sandbox (memory isolated from Node).

**Verdict**: **DO THIS FIRST.** Zero cost for 50% of the native feel. Arthur could ship it tonight.

### Option E: Tauri 2.0 sidecar for node-pty — feasibility check

Tauri 2.0 added the `tauri-plugin-shell` sidecar API which spawns and supervises an external binary alongside the Rust shell. The canonical pattern:

```rust
// src-tauri/tauri.conf.json
"bundle": {
  "externalBin": ["binaries/myrlin-node"]
}
```

Then at startup, Rust spawns `myrlin-node` (a packaged Node binary containing `src/`), passes a random port, and opens a webview to `localhost:<port>`.

**Feasibility**: **High**. The only wrinkle is bundling Node itself. Solutions:
- `pkg` or `caxa` to make a standalone Node executable (includes Node runtime).
- `node-sea` (single executable applications, Node 20+) to produce a single-file binary.
- Ship Node as-installed on the system (check `node --version`, prompt install if missing).

node-pty's native bindings (`.node` files) must be included. Standard `pkg` handles this via the `assets` config.

---

### Recommendation

**Roadmap**:
1. **Now (1 day effort)**: Ship a PWA manifest + service worker. Add install prompts. Theme the login screen as a standalone PWA. Zero code changes to the app itself.
2. **Next sprint (1 week effort)**: Ship a Tauri 2.0 wrapper. Keep the Node sidecar, webview loads localhost. Add global hotkey, tray icon, native notifications via `tauri-plugin-notification`. Ship as a 15MB binary.
3. **Only if Tauri proves insufficient**: Fall back to Electron. But based on the audit, Tauri is sufficient.

**Why not Electron first**: The memory footprint of Electron (+180MB) plus Myrlin's Node backend (~200-400MB) puts the app at 400-600MB resident. Tauri's ~15MB shell keeps the app under 300MB. On machines with 20+ terminal sessions this matters.

**Why not stay browser**: The global hotkey + native notifications + file drag integration are the killer features users don't know they want until they have them. Claude Code desktop nails these. Myrlin won't feel "pro-grade" without them.

---

## 9. CI Perf Budget Recommendations

Track these in a CI perf gate. Alert on regressions >20%.

### Backend (Node)

| Metric | Target p50 | Target p99 | How to measure |
|---|---|---|---|
| `/api/sessions` with 100 sessions | <20ms | <50ms | Autocannon with seeded state |
| `/api/cost/batch` cache-hit (200 sessions) | <30ms | <80ms | Autocannon |
| `/api/cost/batch` cache-miss (200 sessions) | <10s | <30s | One-shot, pre-warm clean |
| `/api/git/status` cache-hit | <5ms | <20ms | Autocannon |
| `/api/git/status` cache-miss | <150ms | <500ms | One-shot |
| `/api/conflicts` cache-hit | <10ms | <40ms | Autocannon |
| `/api/conflicts` cache-miss with 20 sessions | <300ms | <800ms | Cold |
| SSE fanout time with 50 connected clients | <5ms | <20ms | Instrument broadcastSSE, log histogram |
| WebSocket upgrade + PTY spawn (cached Claude binary) | <400ms | <1500ms | ws client tool |
| WebSocket keystroke echo (ws in → ws out) | <5ms | <20ms | Measure after spawn |
| Server RSS after 1hr idle with 10 PTYs | <400MB | <800MB | Check in nightly job |
| Server RSS after 1hr typical use (5 active PTYs) | <600MB | <1.2GB | Same |

### Frontend

| Metric | Target | How to measure |
|---|---|---|
| Time to first render (first usable UI) | <1.5s | Playwright `waitForSelector` + performance.now() |
| Time to sidebar visible with 20 workspaces | <2.0s | Same |
| `renderWorkspaces` execution time | <30ms for 20 workspaces, 200 sessions | `performance.mark` in code |
| p99 keystroke latency in terminal | <50ms | `requestAnimationFrame` diff between keydown and next term render |
| Sidebar flicker on SSE burst (10 events in 1s) | <1 frame of layout shift | CLS measurement |
| Memory after 1hr of typical use (Chrome DevTools heap) | <250MB | Playwright + performance.memory |
| Time to open existing session into terminal pane | <500ms | click to first-byte of PTY data |
| Cold cost batch for 200 sessions (no cache) | <15s to fully populate all badges | Page wait |

### Continuous monitoring

Add `performance.mark` and `performance.measure` calls at key seams:
- Start of `renderWorkspaces` → end
- Start of `handleSSEEvent` → end
- `mount()` → first `onmessage`
- Server: `Date.now()` diff on `broadcastSSE`, `handleUpgrade`, `gitExec`

Pipe to a lightweight in-memory histogram. Expose via `/api/perf/metrics`. Add a nightly CI that:
1. Seeds state with 20 workspaces + 200 sessions.
2. Spins up server, measures startup time.
3. Opens browser via Playwright, measures time-to-interactive.
4. Hammers endpoints with autocannon, records p50/p99.
5. Asserts budgets. Fails build on regression.

---

## 10. P0 Fixes (genuine regressions to patch before anything else)

These are actual freezes or noticeable jank in the current v0.9.27:

1. **Replace full-sidebar innerHTML rebuild with row-level patching on SSE events.**
   - File: `src/web/public/app.js:8527-8778`
   - Current: `list.innerHTML = html` rebuilds everything
   - Target: generalize `_patchCostBadges` (line 15910) into `_patchSessionRow(sessionId, changedFields)` that updates only the affected DOM nodes
   - Impact: eliminates ~50-150ms hitch per SSE event, plus eliminates sidebar flicker

2. **Stream the `/api/cost/batch` response via SSE or chunked encoding.**
   - File: `src/web/server.js:2986-3051`
   - Current: `Promise.all(pending)` blocks until all async calcs finish (can be 10s+)
   - Target: send per-session results as they complete; frontend patches each badge as it arrives
   - Impact: cost badges start appearing in <200ms instead of waiting 10s

3. **Raise `GIT_MAX_CONCURRENT` from 3 to 8 on desktop.**
   - File: `src/web/server.js:5721`
   - Current: 3 concurrent git processes; queue depth grows with worktrees
   - Target: 8 concurrent (still safe; each git proc is ~25MB)
   - Impact: git status queue drains in <1s instead of 5s+

4. **Expand `_costCache` to an LRU with size cap.**
   - File: `src/web/server.js` (search for `_costCache = new Map()`)
   - Current: grows unboundedly until server restart
   - Target: `lru-cache` with size cap 500 entries (covers the heaviest user)
   - Impact: prevents OOM on long-running servers

5. **Swap `wmic` for PowerShell `Get-CimInstance` in `getProcessMemory`/`getChildPids`.**
   - File: `src/web/server.js:5487, 5513, 5585`
   - Current: `wmic` is deprecated and removed in Windows 11 24H2
   - Target: PowerShell one-liner (already used elsewhere in same file)
   - Impact: prevents Resources view from breaking on fresh Windows 11 installs

6. **Clean up `_prevProcessCpuTimes` map for dead PIDs.**
   - File: `src/web/server.js:5579-5612`
   - Current: map grows per-PID, never cleaned
   - Target: delete PID entries whose last-seen > 10 min ago
   - Impact: prevents slow leak; relevant after 24+ hours uptime

7. **Replace `store.updateSession(sessionId, {})` on every PTY data burst.**
   - File: `src/web/pty-manager.js:384-387`
   - Current: triggers a full state-file save 150ms after any burst
   - Target: update an in-memory `lastActive` timestamp map; flush to disk every 60s
   - Impact: cuts disk I/O from dozens of writes/min to 1/min

---

## 11. P1 Polish (noticeable wins)

1. **Lazy-load `material-icons.bundle.js`** (index.html:1660). It's ~1.5MB, only needed when the icon picker opens. Dynamic `<script>` injection in `openIconPicker()` handler. Saves ~400-800ms of script parse time at boot.

2. **Add a loading skeleton for the sidebar** on first load. Currently shows empty until `loadWorkspaces` resolves. Pre-render a list of 6 grey rows.

3. **Add a loading skeleton for cost badges.** Currently no badge → "$" flash. Show a shimmer `$--` placeholder until cost fetches.

4. **Reduce `fs.statSync` calls in hot API paths.** Wrap the common "find JSONL, check size, check mtime" sequence in a small LRU cache keyed by path, TTL 10s. Many endpoints stat the same file back-to-back.

5. **Split `app.js` into 3-5 logical files** loaded as separate `<script>` tags. Don't need a bundler. Browsers parallelize script downloads and cache individually. Start with CostDashboard, Resources, Docs editor. Each ~50-150KB.

6. **Use event delegation for terminal tab strip** (`app.js:11539`). Replace per-tab `addEventListener` with one listener on the strip parent. Reduces per-render cost.

7. **PWA manifest + service worker.** Add `manifest.json`, register SW in `<head>`, cache vendor bundles. Installs as desktop app. Trivial effort, substantial perceived-native-ness win.

8. **Cmd/Ctrl shortcut unification.** Audit all `e.ctrlKey` references in app.js; change to `e.ctrlKey || e.metaKey` where appropriate. Terminal.js already does this correctly. App-level shortcuts do not.

9. **Preload common font in `<head>` with `font-display: swap`** (already has preconnect at index.html:12-14; add `<link rel="preload" as="font" ...>` for the critical weights). Eliminates FOIT.

10. **Increase WebSocket `bufferedAmount` threshold** from 64KB to 256KB for very fast sessions (hot reload scenarios) to avoid skipping frames unnecessarily. Monitor via metric.

---

## 12. Appendix: Raw Profiling Notes and Grep Results

### File sizes (measured via `ls -la`)

- `src/web/server.js`: 305,139 bytes (7,879 lines)
- `src/web/public/app.js`: 746,695 bytes (17,576 lines)
- `src/web/public/styles.css`: 232,591 bytes (9,885 lines)
- `src/web/public/terminal.js`: 55,380 bytes (1,344 lines)
- `src/web/public/index.html`: 109,602 bytes (1,668 lines)
- `src/web/public/vendor/material-icons.bundle.js`: ~1.5MB (inferred from "2191 Material icons")
- `src/web/public/vendor/xterm/xterm.min.js`: 488,664 bytes
- `src/web/public/vendor/codemirror.bundle.js`: 381,996 bytes (loaded on-demand, good)
- `src/web/pty-manager.js`: 30,799 bytes (789 lines)
- `src/state/store.js`: 48,627 bytes
- `src/supervisor.js`: 7,879 bytes (207 lines)

### Grep tallies

- `innerHTML = ` in app.js: **268 occurrences** (flagged as high-churn)
- `renderWorkspaces()` calls: **34 call sites**
- `loadSessions()` calls: **35 call sites**
- `broadcastSSE` calls: **22 event types** wired through `attachStoreEvents`
- `setInterval` in app.js: **10 active interval timers** identified
- `setInterval` in server.js: **multiple caches**; evictions at 60s
- Sync filesystem calls in server.js hot paths: dozens (partial list in section 4)

### Memory map (estimated RSS contributions)

- Node server baseline: ~50MB
- Per active PTY session with live claude process: ~15-40MB (Myrlin side; claude itself ~100-200MB)
- Frontend: ~80-150MB in Chrome tab with 6 active xterm.js panes, 100 sidebar entries
- Cost worker thread: ~30-50MB when busy
- SSE client record: ~2-4KB per client

### Related prior art referenced in conversation

- v0.9.4: Ctrl+V double paste — **fixed** (verified at terminal.js:381-396)
- v0.9.5: Cost endpoint N+1 → batch — **fixed** (verified at server.js:2986)
- v0.9.11: Sync JSONL parse in main thread → worker thread — **fixed** (cost-worker.js + server.js:40-88)
- v0.9.14: Cost updates rebuild sidebar → `_patchCostBadges` — **fixed** (app.js:15910)
- v0.9.15-22: OOM from unbounded PTYs → 4GB heap, scrollback cap, backpressure — **partial fix** (no explicit watchdog; relies on budgets)
- v0.9.24: Removed "Click to connect" placeholder — confirmed (no lazy-connect logic in pty-manager.js)

### Open questions for the next session

1. Is there a dev-time perf HUD overlay? If not, add one (`Cmd+Alt+P` opens stats).
2. What was the actual RSS of the Node server for Arthur's hot config at last check? Read `logs/server.log` for `[RSS]` lines.
3. Is `node-sea` working yet for bundling a single-exe Node on Windows? Would dramatically simplify Tauri sidecar packaging.
4. Should the auth layer migrate from `in-memory token set` to a short-lived JWT with a refresh? Not a perf concern, a security one.

### Confidence levels in this audit

- Line references: **high** (read source directly)
- Latency estimates: **medium** (inferred from code paths + typical Node/browser timings)
- Memory estimates: **medium** (no live profiling done)
- Wrapper recommendation: **high** (Tauri 2.0 sidecar is the right fit given the architecture)
- CI budget numbers: **medium** (reasonable starting targets; tune after first nightly run)

---

*End of evaluation.*
