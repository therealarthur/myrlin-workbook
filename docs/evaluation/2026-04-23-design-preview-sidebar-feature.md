# Live Preview Sidebar - Deep Feature Design

Date: 2026-04-23
Author: Claude (Opus 4.7, 1M context) in design research mode
Status: Design proposal, no code changes
Target version: v0.10 alpha (6 week MVP) with phased rollout to v0.12+

---

## 1. Executive Summary

### The pitch

Myrlin Workbook today is the best way to run multiple Claude Code sessions in a browser. But when a developer uses Claude Code to build a web app, the actual UI they are building lives in a completely separate browser window. The workflow fragments: type in Claude's terminal, tab to another window, reload, squint, tab back, type again. Every design iteration costs a context switch.

The Live Preview Sidebar puts the running app **inside** Myrlin, next to the Claude terminal that is building it. The dev server's port is already auto-detected (v0.9.x ships `getProcessPorts()` per session). We just need to wire an iframe to it, give it a proper toolbar, add device presets, add an element inspector that can talk back to Claude, and auto-reload on Edit. This is a small surface area change with massive leverage: the editor sees what is being built, and the agent can see it too.

If we ship this, Myrlin stops being "a terminal multiplexer for Claude" and becomes "the AI-first IDE for design" - a flanking position against Cursor (text-editor-first), v0.dev (generator-only, can't bring your own code), and Bolt.new (browser-sandboxed, can't use your local toolchain). Windsurf has been shipping exactly this feature (in-IDE local preview with element inspector connected to Cascade) - their public reception has been strongly positive. We can do the same for Claude Code.

### Phase 1 MVP (ships in v0.10, ~6 weeks)

- Iframe-based preview panel that occupies right half of the terminal grid
- URL bar with manual override, reload button, open-in-browser button
- Auto-populate URL from the active pane's detected port (reuses `getProcessPorts`)
- Layout toggle: "terminal only" / "split 50/50" / "preview only"
- Persists per tab group (integrated with existing `/api/layout` contract)
- Keyboard shortcut: Cmd+Shift+P toggles preview visibility
- No element inspector, no responsive modes, no CSS tweakback. Just a panel, an iframe, a URL bar, a reload button. Deliberately narrow.

Why this scope is right for v0.10: it removes the context switch immediately (the "context-switch killer" feature) without any of the hard problems (cross-origin script injection, sourcemap mapping, CSS override round-tripping). It also validates the layout system can handle non-terminal panes, which unlocks phases 2-7.

---

## 2. Competitor Analysis

### 2.1 Comparison table

| Tool | Preview model | Hot reload | Element inspector | Responsive modes | Device preview | AI integration | Dogfooding approach |
|---|---|---|---|---|---|---|---|
| **VS Code Live Preview** (ms-vscode.live-server) | Embedded WebView panel pointing at local HTTP server spawned by extension | WebSocket server injects reload script into HTML; saves trigger ws message | None (relies on user opening VS Code DevTools for WebView) | None built-in | No | None | Extension team uses it to preview docs / HTML; not the primary VS Code workflow |
| **VS Code Browser Preview** (auchenberg) | Full headless Chrome via CDP, rendered in WebView | Full browser - uses the site's own HMR | Yes (full DevTools) | Yes (DevTools emulation) | No | No | Deprecated / unmaintained by 2024, but proved the CDP-in-editor pattern |
| **WebStorm Live Edit** | Browser extension + JetBrains IDE daemon, modifies DOM in real browser | Live edit - patches CSS/JS without reload, reloads for structural changes | Uses JetBrains' own inspector panel | No | No | None (as of 2025) | Shipped in 2015; was JetBrains' answer before browsers had hot reload |
| **Chrome DevTools** | N/A (DevTools IS the inspector) | N/A | Yes - the canonical implementation. Pick element, hover, inspect, overrides | Yes - Device toolbar with presets, custom sizes, throttling, DPR | Yes - "throttle to mobile" presets | None | N/A |
| **Cursor** | No built-in preview pane as of v0.48 (Mar 2026). Users run dev server in terminal and external browser | N/A | External browser DevTools only | External | External | Composer can take screenshot attachments but does not drive preview | No self-preview; Cursor team dogfoods with browser-side |
| **Windsurf / Codeium** | **Has built-in preview pane with element inspector since Wave 13** (early 2026) | Uses dev server's HMR via iframe | Yes - "click to select" feeds selector + HTML + screenshot into Cascade agent | Yes - device presets | Yes - some | **Best-in-class: element selection -> agent edit loop is the headline feature** | The entire Cascade workflow is designed around see-preview + pick-element + prompt |
| **Zed** | No preview as of April 2026 | N/A | N/A | N/A | N/A | None | Terminal / editor focus; they punt on preview |
| **v0.dev** (Vercel) | Iframe in the chat UI that renders the generated React/HTML code via Vercel's sandboxed preview server | Full rebuild on every prompt edit; they version snapshots | Hover highlights in the preview; click -> scrolls to code | Viewport toggle (mobile / tablet / desktop) built into the chat UI | Responsive breakpoint toggle only, no real device spoofing | **THE gold standard for AI + preview**. Every message is "edit this preview" | v0 itself is built with v0 (confirmed in their marketing) |
| **Bolt.new** (StackBlitz) | Full Node.js runtime INSIDE the browser tab via WebContainer. Preview is iframe pointing at in-browser HTTP server. | Runs actual Vite HMR; Service Worker bridges WebSocket to WebContainer TCP stack | Basic (click-to-select wired to prompt) | Yes - device preview sidebar | Limited | Prompts mutate the filesystem, which triggers Vite HMR | StackBlitz dogfoods WebContainers for their entire product stack |
| **Replit** | Iframe connected to their hosted container dev server | Hot reload per framework | No deep inspector | Mobile preview frame | Simulator only | Ghostwriter can reference preview content but no element-pick | Replit Core team uses Replit; preview is first-class |
| **Storybook** | Iframe per story at a managed URL (`/iframe.html?args=...`) | Webpack / Vite HMR via `@storybook/preview-api` postMessage bridge | Addons: a11y, measure, outline, viewport | **Viewport addon** with named presets | Yes - Storybook is the de facto tool for this | None native; plugins exist | Storybook is the component preview gold standard; Myrlin should borrow their postMessage bridge pattern |
| **Figma Dev Mode** | Not a preview - shows design specs alongside code. Inspector UX only. | N/A | Pick a layer, see its CSS + code suggestions. Excellent UX for the pick-and-see-props loop. | N/A (designs not live apps) | N/A | Limited (Figma AI is generator-only) | Figma product team uses Dev Mode; borrow their inspector panel layout |

### 2.2 Actionable observations

1. **Windsurf is the closest competitor and the clearest proof of demand.** They shipped element-inspector-to-agent in Wave 13 (early 2026) and lead their marketing with it. Cursor has visibly not matched this, which is an opening. Myrlin can occupy the "best-of-breed design inspector for Claude Code" position.

2. **Element-to-agent is the single highest-leverage feature.** Every tool that has it (Windsurf, v0, Bolt) makes it the headline. Tools without it (Cursor, Zed) get reviewed as "great editor, but I still switch to Chrome to inspect."

3. **v0.dev is generator-only.** You cannot point v0 at your existing Vite project and have it mutate your source. That is Myrlin's flanking move: "v0.dev experience on your own codebase."

4. **Bolt.new's WebContainer is impressive but over-engineered for Myrlin.** Bolt runs Node in the browser because Bolt users do not have local dev environments. Myrlin users already have their dev server running (Claude Code ran `npm run dev` in the pane). We just need to point an iframe at it.

5. **Storybook's postMessage bridge (parent Myrlin <-> iframe) is the cleanest same-origin inspector pattern.** Adopt their API shape: `window.postMessage({ type: 'myrlin:pick', ... }, '*')` with a script injected only when the dev server is on localhost. For cross-origin (rare in Myrlin's target use case), fall back to CDP via the existing Visual QA MCP.

6. **VS Code Live Preview's "WebSocket-injected reload script" pattern is load-bearing.** For file-watcher-triggered reload (phase 5), we need either the dev server's own HMR (preferred) or a reload script we inject into HTML responses. Since Myrlin does not proxy HTTP responses, we will prefer option A.

7. **Chrome DevTools' device presets (iPhone 15, iPad, Galaxy S24, etc.) are copy-pasteable.** No need to invent our own list - ship theirs. Nominally MIT-ish since they are just dimension tuples.

---

## 3. Technical Architecture

### 3.A Port detection

**What exists today (v0.9.27):** `src/web/server.js:5543 getProcessPorts(pid)` runs per-session to find listening TCP ports on Windows (via `Get-NetTCPConnection`) or Unix (via `lsof`). Traverses child PIDs so it catches `npm run dev` -> `node` -> `vite`. Result surfaces as `session.ports` in `GET /api/resources` and renders as a badge in the session list (see `app.js:8605` "Port badge"). This is a solid foundation.

**Gaps to close for preview:**

1. **Cadence.** `GET /api/resources` is called on-demand by the resource panel; it does not push. Preview needs instant notification when a new port opens (within ~1 second of `npm run dev` booting). Two options:
   - **Option A (pull):** Preview panel polls `GET /api/sessions/:id/ports` every 2 seconds when URL is unset. Simplest, acceptable latency.
   - **Option B (push):** Add a port-watcher to the existing memory watchdog interval (already running every 15s per v0.9.19). Broadcast SSE event `ports:changed` when the set mutates. More work, zero extra poll.
   - **Recommendation: Option A for MVP, Option B for v0.11.**

2. **PTY output scanning as a fallback / speedup.** The `lsof/Get-NetTCPConnection` approach takes ~100-300ms and requires the port to already be listening. Vite prints `Local: http://localhost:5173/` to stdout before the server is fully ready. By scanning PTY output for a URL regex we get the port ~50ms earlier and we learn the path too (some frameworks use `/dashboard`). Pattern library to match:
   - Vite: `Local:   http://localhost:5173/`
   - Next.js: `- Local:        http://localhost:3000` and `started server on http://localhost:3000`
   - Next.js 15 (experimental): `┌ Ready in 2.3s` then `│ Local: ...`
   - Express/Nest: usually just `listening on 3000` (partial match)
   - Django: `Starting development server at http://127.0.0.1:8000/`
   - Flask: `Running on http://127.0.0.1:5000`
   - SvelteKit/Astro/Remix: mostly follow Vite
   - Rails: `Listening on http://127.0.0.1:3000`
   - Go `net/http` apps: whatever log line they print (no standard) - fall back to lsof

   Proposed regex: `/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?(?:\/\S*)?/`

   Where to hook: `pty-manager.js` line ~430 (data handler). Add a non-allocating match per chunk, debounced. Cache hits in `sessionPortsFromOutput.set(sessionId, { url, port, matchedAt })`.

3. **Automatic URL selection.** When the preview panel is visible and no URL is set, auto-pick. Priority: (1) URL parsed from PTY output (includes path), (2) lowest-numbered port from `getProcessPorts`, (3) manual override, (4) empty state "waiting for dev server...".

4. **Hot-swap on port change.** When a user restarts the dev server (common: Next.js config change forces restart) the port may change (Vite picks 5174 if 5173 is taken). The preview panel should notice and either silently hot-swap (if the old port is gone and a new one appeared) or show a pill "dev server moved to :5174, switch?" (if ambiguous).

5. **Manual URL field per workspace/session.** Persist `previewUrl` on the workspace object. Overrides auto-detect. Useful for:
   - Running multi-service apps where auto-detect finds the wrong port
   - Previewing deployed sites (staging URL)
   - Previewing a local non-dev-server route (e.g., `/admin`)

**Recommended code structure:**

```
src/web/
  preview-manager.js          NEW  central port discovery + URL state
  server.js                   MOD  add /api/preview/:sessionId route
  pty-manager.js              MOD  emit 'output-url-detected' event
  public/preview.js           NEW  frontend PreviewPane class (analog to TerminalPane)
  public/styles-preview.css   NEW  scoped CSS for preview panel
```

### 3.B Preview render technology - tradeoffs table

| Technology | Same-origin script injection | Cross-origin support | Reload | CPU/RAM cost | Code complexity | Verdict for Myrlin |
|---|---|---|---|---|---|---|
| `<iframe src=localhost:5173>` | Yes if we inject a `<script>` via the dev server (Vite plugin) or mutate HTML. Yes natively via postMessage if both sides cooperate. | Limited - cannot read iframe DOM, cannot pick elements without user opt-in | `iframe.src = iframe.src` forces full reload | Low | Low | **Primary approach. Phase 1-7.** |
| `<webview>` (Electron only) | Yes full. Webview API exposes `executeJavaScript`, `openDevTools`, etc. | Full | Reliable | Medium | Myrlin would need to become an Electron app OR offer Electron as "Myrlin Desktop" | **Deferred. Would require an Electron build.** |
| CDP via headless Chrome (extending `visual-qa.js`) | Yes full | Full | Reliable | Medium-High (extra Chrome process) | Medium - reuse `chrome-remote-interface` from Visual QA MCP | **Fallback for cross-origin inspect (phase 3). Not primary.** |
| Tauri WebView / Electron BrowserView | Yes full (platform WebView) | Full | Fast | Medium | High - another app shell to maintain | **Deferred. Consider for Myrlin Desktop v2.** |
| Server-side screenshot capture (Puppeteer on backend) | N/A - static | N/A | On request only | Low when idle, spike on capture | Low | **Useful for "screenshot-to-Claude" (phase 5). Not a live preview.** |
| Figma-style bitmap stream (render remotely, stream pixels) | N/A | N/A | Full redraw | High bandwidth | Very high | **Out of scope.** |

**Recommendation: primary = `<iframe>` with localhost URLs. Fallback for inspector = CDP via existing Visual QA MCP when iframe is cross-origin. Phase 3 adds a `<script>` injection path that works for localhost dev servers only.**

Iframe security flags:
- `sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"` - allow-same-origin is required for cookie-based auth flows to work in the previewed app. allow-top-navigation is deliberately omitted so the app cannot hijack Myrlin's window location.
- `referrerpolicy="no-referrer"` - do not leak Myrlin URLs to the previewed app if it has external images.
- `loading="eager"` (when visible), `loading="lazy"` (when hidden in a non-active tab group).

### 3.C Hot reload strategy

Four layers, from cheapest to most invasive:

**Layer 1: trust the dev server (primary, 95% of cases).**
Modern dev servers (Vite, Next fast refresh, Webpack HMR, Rollup, Parcel, Remix) run their own WebSocket HMR. If we just `<iframe src=http://localhost:5173>`, any file edit the user or Claude makes fires HMR inside the iframe and the preview updates in tens of milliseconds. Myrlin does nothing. This is how Bolt.new works (per the WebContainer research).

**Layer 2: Claude-edit detection (additive, 3% of cases).**
The dev server might not run (user is previewing static HTML) or HMR might be broken. We detect when Claude has finished an edit, via:
- PTY output scanning - match `Wrote N lines to file`, `Edited file X`, or tool result markers from Claude's tool_use events surfaced in the stream.
- Filesystem watcher (`chokidar`) rooted at the session's `workingDir`.

Either triggers `iframe.src = iframe.src`. With a 500ms debounce.

Risk: reload-storm on a multi-file refactor (Claude edits 10 files in 5 seconds). Debounce solves it. Stricter: max 1 reload per 2 seconds while a "claude is working" indicator is visible.

**Layer 3: save-triggered reload (for manual file edits in the Files tab).**
When the user edits a file in the in-Myrlin CodeMirror editor (added in v0.9.26), reload on save. Already have the save hook.

**Layer 4: injected reload script (explicit opt-in, phase 5 only).**
If a dev server does NOT have its own HMR (raw Express serving plain HTML), we offer to inject a tiny `<script src=/__myrlin_reload.js>` via our own middleware, IF the user hosts behind a Myrlin proxy endpoint. This is heavy (we proxy all requests) and conflicts with the app's own static routing. Deferred to phase 5 with a clear "experimental" label.

**Recommendation: layers 1-3 for phase 5. Layer 4 is opt-in, experimental, phase 7.**

### 3.D Element inspector

This is the hardest sub-problem. Three approaches ranked by practicality for Myrlin:

**Approach A: same-origin postMessage bridge (localhost-only).**
When the iframe URL is on `localhost` or `127.0.0.1`, the Same-Origin Policy allows us to access iframe.contentDocument from Myrlin (same protocol, same host `localhost`, same port is NOT required for Myrlin-to-iframe reads? Actually it IS required - localhost:3456 and localhost:5173 are different origins per SOP). Correction: they are different origins because the port differs.

So the accurate reality: **localhost-to-localhost iframes are still cross-origin if the ports differ.** Every real-world case is cross-origin. Approach A as described does NOT work for Vite (5173) preview inside Myrlin (3456). This is the crucial constraint.

Workaround: postMessage bridge. Both sides can still postMessage freely. Send the picker script to be injected as an adjacent `<script>` if the target app cooperates (by including a `/__myrlin_companion.js` during dev mode).

Option A-1: Ship a tiny `myrlin-preview-companion` npm package or Vite plugin that auto-injects the picker script when NODE_ENV=development. Users add one line to their `vite.config.ts`. When installed, Myrlin gets full element-pick.

Option A-2: Ship a browser extension. Downside: every user needs to install it.

**Approach B: CDP via Visual QA MCP (cross-origin, always works).**
We already have `src/mcp/visual-qa.js` that connects to Chrome via CDP on port 9222. For inspect, we can:
1. Launch a hidden Chromium tab pointing at the preview URL.
2. Attach CDP.
3. Use `DOM.getDocument`, `DOM.getBoxModel`, `Runtime.evaluate` to pick elements.
4. Stream screenshots to the Myrlin preview panel (effectively a CDP-driven mirror, like VS Code Browser Preview did).

Downsides:
- Heavy: extra Chrome process, extra screenshot streaming, ~200MB RAM.
- The preview would feel slightly laggier than a direct iframe (decode + render latency).

Upside: full inspector works everywhere including staging URLs, internal apps, whatever.

**Approach C: overlay pointer events on iframe (minimal, degraded).**
When user enables "pick mode", Myrlin puts an absolutely-positioned transparent `<div>` over the iframe. On hover, Myrlin cannot see what is under the pointer (cross-origin forbids it) but can still display a crosshair. On click, Myrlin can:
- Read mouse coordinates relative to iframe rect.
- Ask the backend Visual QA MCP via CDP to do the actual element picking at those coordinates.
- Receive selector + outerHTML + computedStyles.
- Display in a side panel.

This is the pragmatic compromise: local rendering (iframe is fast, direct) + remote inspection (CDP is authoritative).

Downside: requires a Chrome instance with CDP running. For MVP we skip this and fall back to "request the element's info from Claude directly - Claude inspects via `execute_js`." Already works today.

**Recommendation ladder:**
- **Phase 1-2:** no inspector. Just the iframe.
- **Phase 3 (v0.11):** Approach C (overlay + CDP). Requires `npm run gui:cdp` (existing flag) to be active.
- **Phase 3.5 (v0.11.x):** ship an optional Vite plugin `@myrlin/preview-companion` that enables Approach A for Vite users. Fastest inspector experience.
- **Phase 7:** browser extension (Approach A-2) for universal coverage.

### 3.E CSS tweakback-to-source

Tweakback is the step AFTER element inspection: user picks a button, changes its color, the change persists in the source file. Four strategies:

**S1: ad-hoc style tag (preview-only).**
User changes color -> Myrlin injects `<style>.btn-primary { color: ... }</style>` into the iframe. Change is NOT in source; persists only during the session. "Send to Claude" button converts it into a prompt: "Please update the source CSS for `.btn-primary` so `color: #abc123`."

**S2: directly mutate source file.**
Requires a map from (selector, stylesheet URL) to (source file path, line number). In practice: sourcemaps. Chrome DevTools' "CSS overrides" panel does this. Implementation complexity: high - we would need to parse sourcemaps, handle build tool quirks (Tailwind is a PITA because utilities don't map back to a single rule).

**S3: Claude-mediated file edit.**
User changes color in Myrlin's CSS panel. Myrlin sends a prompt to Claude: "Update `.btn-primary` to `color: #abc123` in the appropriate source file." Claude uses its Read/Edit tools with the Claude Code's existing knowledge of the project. Dev server HMRs the change. Loop time: 2-5 seconds. Accuracy: very high because Claude already knows the codebase.

**S4: direct write via knowing the file layout.**
If the user tags their stylesheet at build time (e.g., Tailwind `@apply`, CSS modules), we know the file. Write directly. Complex per-framework.

**Recommendation: S1 (preview-only) + S3 (Claude-mediated) in phase 4. Skip S2/S4 as too framework-specific.**

Workflow:
1. User picks element in inspector (phase 3 already shipped).
2. Right-side "Style Tweak" panel shows relevant computed styles.
3. User drags a color, adjusts a slider for padding/margin/font-size.
4. Changes apply live via S1 (ad-hoc style tag).
5. "Send to Claude" button bundles:
   - Selector + path-to-element as a querySelectorPath (like `body > main > section.hero > button.btn-primary`)
   - Diff of changed properties: `{color: {from:'#fff', to:'#abc'}, padding:{from:'8px', to:'12px'}}`
   - Current screenshot (small thumbnail)
   - Plain-English prompt: "Please update the CSS for this element to match these changes. The element is found at ... its current file is likely ..."
6. Claude edits, dev server reloads, ad-hoc style tag is removed.

### 3.F Responsive testing

Device presets (port these exactly from Chrome DevTools):
- Phone: iPhone SE (375x667), iPhone 15 (393x852), iPhone 15 Pro Max (430x932), Galaxy S24 (384x832), Pixel 8 (412x915)
- Tablet: iPad Mini (768x1024), iPad Pro 11 (834x1194), iPad Pro 13 (1024x1366)
- Desktop: Laptop small (1280x800), Laptop (1440x900), Desktop (1920x1080), Desktop wide (2560x1440)
- Custom: user can type arbitrary `WxH` into a field

UI: dropdown in the preview toolbar. Selected preset sets the iframe's `width` and `height` with centered absolute positioning inside the panel, scrollable overflow. Device chrome (the bezel graphic) is an optional "Show device frame" toggle for screenshots.

User-agent switching: in phase 4 we add a UA selector that sets the iframe via `sandbox` + CDP `Network.setUserAgentOverride`. Gated behind "use CDP preview" mode to avoid complexity.

Rotate: landscape/portrait button swaps W and H.

Zoom: 25%, 50%, 75%, 100%, 125%, 150%. Applied as CSS `transform: scale()` on the iframe.

### 3.G Mobile preview bridge

Three mechanisms:

**M1: QR code with Tailscale URL.** Myrlin already knows the Tailscale IP (see `pairing.js:detectTailscaleIP`). Get the detected port. Compose `http://100.x.y.z:5173`. Render QR code (we have `qrcode` or similar already in the mobile pairing flow). Phone scans, opens. Same-device Wi-Fi is fine too - render the LAN URL as the QR. Works today with zero backend changes beyond exposing `/api/preview/qr`.

**M2: Cloudflare tunnel for the dev server port.** v0.9.x ships `POST /api/tunnels` that creates a tunnel. Right-click preview URL -> "Create tunnel to this port" -> we get a `https://xxx.trycloudflare.com` URL that an external device can reach. This is the "share my WIP with a client on their phone" flow.

**M3: Remote desktop preview.** The `scripts/remote-desktop-rs/` code (see `MEMORY.md`) can stream a remote browser. Could host a "tablet previewer" on a Mac Mini and screenshare it. Overkill for now; listed for completeness.

**Recommendation: M1 as default, M2 as a button, M3 out of scope.**

### 3.H Multi-preview

User story: "I want to see my app on desktop AND iPhone at the same time."

Two implementations:

**Multi-preview-A: side-by-side in the preview panel.**
Preview panel splits in two (vertical split). Both iframes load the same URL. Each has its own device preset. Shared reload - when one reloads, both reload.
Complexity: medium. Two iframes = 2x RAM (each can be 100-300MB for a big app).
Performance mitigation: when not visible, pause the iframe (`iframe.src = 'about:blank'` saves ~200MB per hidden iframe; restore on reveal). Downside: state resets on hide/show.

**Multi-preview-B: preview-only tab group, multiple slots.**
Treat preview as "just another pane" in the existing 6-pane grid. Tab group can hold: 1 terminal + 3 previews, or 6 previews. This unifies the architecture. Complexity: low once phase 1 has added the "preview pane type."
Cost: the existing grid's constraint of 6 panes needs to carry over. A preview pane eats one of the 6 slots.

**Recommendation: go all-in on Multi-preview-B.** The preview panel is just a new kind of pane slot, same grid, same tab groups. This is a much cleaner architecture and unlocks every subsequent feature. Rename `terminal-pane` to `pane` internally, keep class for backward compat, add `pane-type: terminal | preview`.

### 3.I Security

Iframe sandboxing (already covered in 3.B):
- `sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"` - NO allow-top-navigation, NO allow-pointer-lock.
- `referrerpolicy="no-referrer"`.

Origin allowlist for the URL field:
- **Allow by default:** `localhost`, `127.0.0.1`, `0.0.0.0`, RFC1918 private IPs (`10.*`, `192.168.*`, `172.16-31.*`), Tailscale CGNAT range (`100.64.0.0/10`), and the hostnames from `/api/server-info`'s `lan` and `tailscale` URLs.
- **Warn before loading:** Any other hostname. Show "this URL is external - are you sure?" once per hostname.
- **Deny by default:** `file://` URLs (cannot load anyway in iframe).

Auth token protection:
- Myrlin's auth token lives in localStorage of the Myrlin origin (`localhost:3456`). The previewed app at `localhost:5173` is a different origin and cannot read it. Safe by default.
- But: Myrlin sometimes embeds the token in URLs for SSE (see `app.js:8386`). Never render these URLs in a way the preview can see them. Preview must not reflect referrer headers (hence `referrerpolicy`).
- Never pass Myrlin's cookies into the iframe (default browser behavior already enforces this per-origin).

Inspector script injection risks:
- If we inject a companion script into the preview app (phase 3.5), that script runs with the previewed app's privileges. We trust the user's own app. Clear docs: the companion is for localhost dev only; do NOT enable it in production.

CSP considerations:
- Myrlin's own CSP (server.js line ~264) already has `frame-src` rules implicitly via `default-src`. Need to explicitly allow `frame-src http://localhost:* http://127.0.0.1:* http://100.64.0.0/10 http://10.* http://192.168.* http://172.16.0.0/12` (or equivalent).

### 3.J State coupling

Persistence model - what lives where:

**Per tab group, stored in `layout.tabGroups[i]`:**
- `panes: [{ slot, type: 'terminal'|'preview', sessionId, previewUrl, devicePreset, zoom }]`
- Adding `type` and preview-specific fields is backward-compatible (absent = terminal).

**Per workspace, stored in workspace record:**
- `defaultPreviewUrl` (override for all preview panes in this workspace unless the pane has its own URL)

**User-level preference, localStorage:**
- Last-used device preset (defaults to "Desktop 1440")
- Preview visibility toggle state
- Inspector mode default (off)
- `cwm_previewAutoReload` (default true)

**Ephemeral, in-memory only:**
- Injected style overrides (S1 in 3.E)
- Inspector selection state
- Screenshot capture queue

---

## 4. UX Design

### 4.1 Layout modes

Below, `T` = terminal pane, `P` = preview pane, `S` = sidebar, `H` = header. Dimensions are approximations for a 1920x1080 viewport.

**Mode 1: current behavior (terminal only, no preview) - baseline, unchanged.**
```
+--+-----------------------+
|S |H                      |
|S |[tab groups bar]       |
|S |+---------+-----------+|
|S ||   T0    |    T1     ||
|S |+---------+-----------+|
|S ||   T2    |    T3     ||
|S |+---------+-----------+|
+--+-----------------------+
```

**Mode 2: Claude-sidebar + big preview (the design workflow).**
```
+--+-----------------------+
|S |H                      |
|S |[tab groups] [preview*]|
|S |+-----+-----------------+
|S ||     |                 |
|S ||  T0 |      Preview    |
|S ||     |      1440x900  |
|S |+-----+                 |
|S ||     |                 |
|S ||  T1 |                 |
|S ||     |                 |
|S |+-----+-----------------+
+--+-----------------------+
```
`T0` + `T1` stack at 30% width. Preview takes 70%. This is the magnet layout.

**Mode 3: preview-only (hide terminals entirely, Cmd+Shift+T to bring back).**
```
+--+-----------------------+
|S |H                      |
|S |[tab groups] [preview*]|
|S |+---------------------+|
|S ||                     ||
|S ||                     ||
|S ||     Preview         ||
|S ||     iPhone 15       ||
|S ||     393x852         ||
|S ||     (centered)      ||
|S ||                     ||
|S ||                     ||
|S |+---------------------+|
+--+-----------------------+
```

**Mode 4: dual-preview (desktop + mobile).**
```
+--+-----------------------+
|S |H                      |
|S |+---+-----------+-----+|
|S |   |            |     ||
|S |T0 | Preview    | iPh ||
|S |   | Desktop    |  15 ||
|S |   | 1440x900   |     ||
|S |   |            |     ||
|S |+--+------------+-----+|
+--+-----------------------+
```
Slot 0 = terminal, slot 1 = preview desktop, slot 2 = preview mobile.

**Mode 5: inspect mode overlay on preview.**
```
+--+-----------------------+
|S |H                      |
|S |+-----+-----------------+
|S ||     | [INSPECT ACTIVE]|
|S ||  T0 |  -----          |
|S ||     | | prv|  <- cursor on a button
|S ||     |  -----          |
|S |+-----+                 |
|S |Info panel (bottom):   |
|S | Tag: <button>         |
|S | Class: btn-primary    |
|S | Size: 120x40          |
|S | [Send to Claude]      |
+--+-----------------------+
```

**Mode 6: CSS edit mode (element selected).**
```
+--+-----------------------+
|S |H                      |
|S |+-----+-----------+-----+
|S ||     |           | Styles|
|S ||  T0 |  Preview  |      |
|S ||     |  (selected| color|
|S ||     |   button  | #3b82|
|S ||     |   has box)| pad  |
|S |+-----+           | 8px  |
|S |               | pad+|
|S |               | [Send] |
|S |               +------+
+--+-----------------------+
```

### 4.2 Preview toolbar

Full toolbar design (inside the preview pane header):

```
+-----------------------------------------------------------------------+
| :5173 ^ | http://localhost:5173/            | R  O  I  D:[Desktop v] F |
+-----------------------------------------------------------------------+
```

Left to right:
- **`:5173 ^`** - port badge + auto-detect dropdown (lists all detected ports for this session, or from other sessions in the same workspace). Click to override.
- **URL input** - editable URL bar. Enter to navigate. Autocompletes from previously used URLs.
- **`R`** - reload button (Cmd+R when preview focused).
- **`O`** - open-in-external-browser (Cmd+Shift+O).
- **`I`** - toggle inspect mode (Cmd+Shift+I).
- **`D:[Desktop v]`** - device preset dropdown (Cmd+Shift+D opens).
- **`F`** - toggle device-frame graphic (on/off).

Second row (only when inspect mode is active OR device preset is non-fullscreen):
```
+-----------------------------------------------------------------------+
| [<-] [->]   [Zoom: 100% v]   [UA: Default v]   [Rotate] [QR] [Tunnel] |
+-----------------------------------------------------------------------+
```
- **Back / forward** - for navigating inside the iframe (history API).
- **Zoom** - 25/50/75/100/125/150%.
- **UA** - user-agent override (phase 4).
- **Rotate** - swap W/H for current device preset.
- **QR** - show QR code with Tailscale/LAN URL (phase 6).
- **Tunnel** - create a Cloudflare tunnel for this port.

### 4.3 Empty state (no port detected)

```
+-----------------------------------------------------------------------+
| Preview                                                       [closex]|
+-----------------------------------------------------------------------+
|                                                                       |
|                           [dev server icon]                           |
|                                                                       |
|              No dev server detected in this session.                  |
|                                                                       |
|        Run npm run dev (or similar) in the terminal pane.             |
|                                                                       |
|                    [ Or enter URL manually ]                          |
|                                                                       |
|              Common ports to try:                                     |
|               :3000 (Next.js, Express)                                |
|               :5173 (Vite)                                            |
|               :8080 (http-server, webpack-dev-server)                 |
|               :4321 (Astro)                                           |
|                                                                       |
|              +-----------------+    +-------+                         |
|              | http://localhost:|    | Go    |                         |
|              +-----------------+    +-------+                         |
+-----------------------------------------------------------------------+
```

### 4.4 Keyboard shortcuts

**Global (while Myrlin focused):**
- `Cmd+Shift+P` - toggle preview visibility
- `Cmd+Shift+[` / `Cmd+Shift+]` - cycle preview layout modes
- `Cmd+Shift+R` - reload preview (alt: `Cmd+R` when preview focused)

**When preview is focused:**
- `Cmd+R` - reload
- `Cmd+Shift+I` - toggle inspect mode
- `Cmd+Shift+D` - device preset picker
- `Cmd+0` - 100% zoom
- `Cmd++` / `Cmd+-` - zoom in / out
- `Cmd+Shift+O` - open in external browser
- `Cmd+Shift+M` - toggle mobile device preset (iPhone 15)
- `Cmd+L` - focus URL bar
- `Esc` - exit inspect mode (before it takes other escape actions)

**Inspector mode active:**
- `Esc` - exit inspector (priority 1 in the escape cascade)
- Click - pick element
- Cmd+C - copy selector of picked element
- Cmd+Enter - send picked element to Claude

### 4.5 Settings panel

New category "Preview" in Settings:
- `Auto-reload on Claude edit` (default: true)
- `Default device preset` (default: Desktop 1440x900)
- `Preview zoom default` (default: 100%)
- `Inspector mode default` (default: off)
- `Allow preview companion script` (default: false, gated for phase 3.5)
- `Remember last URL per session` (default: true)
- `Open external URLs` (default: "warn once per domain")
- `Hide preview when dev server dies` (default: false - show offline state)

### 4.6 Pane type interaction with tab groups

Per 3.H, the proposed architecture unifies "preview pane" with "terminal pane" at the layout level. This means:
- A tab group can hold any mix of 1-6 panes, each either terminal or preview.
- The existing drag-and-drop works identically: drop a workspace on a pane slot -> becomes terminal. Drop a URL -> becomes preview.
- The pane header is always the same shape; only the content differs (xterm vs iframe) and the toolbar varies by type.
- Save/restore of `layout.tabGroups` already carries the `panes` array; we just add `type` to each pane object.

### 4.7 Tab group tab rendering with previews

When a tab group has mixed panes, show it visually:
```
+-------+----------+---------+-----+
| Main  | Design T1 | Test A | +  |
| (2t)  | (1t+1p)   | (3t)   |    |
+-------+----------+---------+-----+
```
Sub-counts "2t" = 2 terminals, "1t+1p" = 1 terminal + 1 preview. Or use icons.

---

## 5. Claude-Native Features (ranked by impact)

Ranked by "how much better is this than a browser tab + DevTools?"

### Tier S: transformative

**S1. Send element to Claude (inspect -> agent).**
Right-click picked element -> "Send to Claude as edit request" -> Myrlin composes a rich prompt:
```
I'm looking at this element in the preview (screenshot attached):
- Selector: body > main.container > section.hero > button.btn-primary
- Current HTML: <button class="btn-primary">Get started</button>
- Computed styles: color: #3b82f6, padding: 12px 24px, border-radius: 6px
- Screenshot: [attached]
[User-typed request:] "Make this button more prominent, maybe with a subtle gradient."
```
Claude reads the styles, decides which source file owns them, Edits, dev server HMRs, preview updates. Closes the loop.

**S2. Auto-reload preview when Claude finishes an Edit.**
Detect `tool_use` completion in the PTY stream (we already parse Claude output for activity indicators, v0.9.14). When Claude reports a successful Edit tool call with a file path under the session's workingDir, trigger preview reload with 500ms debounce (or trust HMR and don't reload at all).

### Tier A: very high value

**A1. Screenshot-to-Claude with annotations.**
Press Cmd+Shift+S while preview is visible. Myrlin captures the current preview iframe (via CDP screenshot or html2canvas as fallback). Shows an annotation mode with circles, arrows, text. "Ask Claude about this screenshot" composes a multimodal message with the image + the annotations rendered on top.

**A2. "Regenerate this component" button.**
Right-click an element -> "Regenerate component" -> Myrlin traces upward to find the component root (via framework hints: React DevTools hooks, Vue devtools, etc., or by asking Claude "what React component owns this selector"). Sends the component source + screenshot + request to Claude.

**A3. DOM state as an MCP tool.**
Expose a new tool via Visual QA MCP: `get_preview_state(selector)`. Claude can call it during a coding session to check "is the button I just added actually visible?". Currently Claude has to ask the user; with this it can check itself.

**A4. Before/after view.**
Claude proposes a change -> Myrlin splits the preview into "current" (left) and "proposed" (right, which loads the output of Claude's edit applied to a sandboxed branch). User approves, we fast-forward. Uses the existing worktree infrastructure.

### Tier B: strong differentiators

**B1. A/B preview across git branches.**
"Show me main vs feat/redesign side by side." Two iframes, each pointing at a dev server running in its respective worktree. Requires two dev servers running (sharing port is impossible); could auto-port-shift.

**B2. Live coordination (agentic testing).**
Claude clicks the preview button via CDP, waits for response, checks the DOM. Useful for "did my form submission handler work?" style verification. Rate-limited and behind a toggle.

**B3. Context bridge: preview -> Claude answer.**
User asks "why isn't the button working?" in the terminal. Claude sees the question, knows a preview is active, can query current DOM / network errors / console logs from the preview via MCP, and responds informed. This requires the inspector stack from phase 3 + phase 7.

### Tier C: nice-to-have

- Lighthouse run on preview, report to Claude.
- Axe accessibility scan, send findings to Claude.
- Network tab summary: "these calls took >2s," prompt Claude to investigate.
- Console log tail in the preview panel.

---

## 6. Phased Implementation Plan

### Phase 0: groundwork (1 week)

**User story:** As a Myrlin architect I want the pane system to support non-terminal pane types so subsequent phases can add preview panes without refactoring.

**Scope:**
- Add `type: 'terminal' | 'preview'` to pane objects in `layout.tabGroups[].panes[]`.
- Migration on first load: any existing pane gets `type='terminal'`.
- Rename internal variable `terminalPanes` -> `panes` in `app.js` (keep as alias for 0.9.x backward compat).
- Add pane-type-specific render branches in `openTerminalInPane` -> split into `openPane(slot, type, config)`.

Files:
- `src/web/public/app.js` (refactor panes abstraction)
- `src/web/server.js` (tolerate `type` in PUT /api/layout)
- `src/state/store.js` (no schema change needed, JSON passes through)

**Risks:** Breaking existing layout persistence. Mitigation: test with several real tab group configs, ship behind a silent migration.

**Effort:** 5 person-days (1 senior dev, parallelizable with phase 1 foundation).

**Demo criteria:** Layout save/restore works identically to 0.9.27. `localStorage.clear()` + fresh load still produces the same UI. Regression tests pass.

### Phase 1: MVP iframe preview (3 weeks, ships in v0.10)

**User story:** When I'm running `npm run dev` in a Claude Code terminal, I want to see my app live next to the terminal without opening another browser tab.

**Scope:**
- New `PreviewPane` class in `src/web/public/preview.js`.
- Preview pane HTML template in `index.html` (mirrors terminal pane structure).
- CSS for preview pane + toolbar in `styles.css` (or new `styles-preview.css`).
- New endpoint `GET /api/preview/:sessionId` returns `{ ports: [...], pickedUrl: '...' }`.
- Port auto-detection: polls `/api/preview/:sessionId` every 2s when URL unset.
- URL bar with manual override.
- Reload button.
- Open-in-browser button.
- Layout toggle in a new header button: "Preview (Cmd+Shift+P)".
- Persist previewUrl per pane in `layout.tabGroups`.

Files:
- `src/web/public/preview.js` (NEW, ~400 lines)
- `src/web/public/index.html` (add preview pane template)
- `src/web/public/styles.css` (add `.preview-pane`, `.preview-toolbar`, `.preview-iframe`)
- `src/web/public/app.js` (pane-type branching, preview layout toggle, key binding)
- `src/web/server.js` (add `/api/preview/:sessionId` route)
- `src/web/preview-manager.js` (NEW, port lookup helper; wraps getProcessPorts)

**Risks:**
- Cross-origin iframe refresh quirks (browser sometimes caches). Mitigation: append `?_=<timestamp>` on forced reload.
- Dev server taking >2s to start -> empty state flicker. Mitigation: show "searching for dev server..." skeleton, not a blank.
- Performance of 6 panes + iframes. Mitigation: pause hidden panes, prefetch only the active tab group.

**Effort:** 12 person-days (1 backend + 1 frontend, parallel).

**Demo criteria:**
- Open a Vite project in a terminal pane, `npm run dev`, within 5 seconds the preview pane auto-populates with `http://localhost:5173`.
- Edit a file in the project, save, see HMR update inside the Myrlin preview within ~200ms.
- Close preview, re-open Myrlin, preview URL and layout persist.
- Works on Windows + Mac + Linux with no additional setup.

### Phase 2: device presets + zoom + open-in-real-browser (1 week)

**User story:** I want to see how my app looks on an iPhone and a 4K desktop without resizing my browser.

**Scope:**
- Device preset dropdown with 12 presets (phone/tablet/desktop).
- Custom WxH input.
- Zoom slider (25/50/75/100/125/150).
- Rotate button.
- Optional device frame graphic (off by default).
- Open-in-browser uses platform-specific `open` / `xdg-open` / `start`.

Files:
- `src/web/public/preview.js` (extend with device state)
- `src/web/public/styles-preview.css` (device frame CSS, centered-in-pane layout)
- `src/web/public/index.html` (device dropdown markup)

**Risks:** iframe with very large zoom lags. Mitigation: warn user at >150%.

**Effort:** 5 person-days (1 frontend).

**Demo criteria:** Switch through Desktop 1440 -> iPhone 15 -> iPad Pro -> custom 1200x800 with a single click each. Page inside iframe responds correctly to the viewport width.

### Phase 3: element inspector (2 weeks)

**User story:** I want to click a button in the preview and see its selector and styles so I can tell Claude what to change.

**Scope:**
- Inspect mode toggle (Cmd+Shift+I).
- Overlay pointer events approach (Approach C from 3.D).
- Backend: spawn a headless Chromium via the existing Visual QA MCP if not running (or require `npm run gui:cdp`).
- When user clicks in inspect mode, overlay captures coordinates, CDP picks the element, returns selector + HTML + computed styles + screenshot.
- Info panel at the bottom of the preview pane shows the picked element.
- "Send to Claude" button composes and sends the rich prompt (Tier S1 feature).

Files:
- `src/web/public/preview.js` (inspect mode state, overlay rendering)
- `src/web/public/inspector-panel.js` (NEW, the info panel)
- `src/mcp/visual-qa.js` (add `pick_element_at_coords(x, y)` tool)
- `src/web/server.js` (`/api/preview/inspect` proxy that talks to CDP)
- `src/web/public/app.js` (keyboard binding, "Send to Claude" integration)

**Risks:**
- CDP connection drops -> inspector dies. Mitigation: reconnect logic, clear error message.
- CDP requires browser with `--remote-debugging-port`. Mitigation: Myrlin's `--cdp` flag already starts Chrome right; but if user is using Firefox/Safari, inspector is disabled. Clear messaging.
- Cross-origin iframes: CDP needs to attach to the inner frame's target. Target switching is non-trivial.

**Effort:** 15 person-days (1 backend with CDP experience + 1 frontend).

**Demo criteria:**
- Click inspect mode button. Hover over a button in the preview - see a blue outline.
- Click. See the selector, HTML, and key styles pop up in a panel.
- Click "Send to Claude" with a message "make this more prominent." Claude reads files, edits CSS, button updates in preview.

### Phase 3.5: Vite companion plugin (optional, 1 week, v0.11.x)

**User story:** I want a zero-latency inspector, not the 200ms CDP roundtrip.

**Scope:**
- Ship `@myrlin/preview-companion` as an npm package.
- Single Vite plugin that injects a small script (< 5KB) into dev HTML.
- Script listens for postMessage from Myrlin ("pick on"), attaches hover listeners, posts back element data.
- Same for Next.js (webpack plugin).
- Rollup plugin for other build systems.
- Auto-disables in production.

Files:
- `packages/preview-companion/` (NEW, separate package)
- `src/web/public/preview.js` (detect companion via postMessage handshake)

**Risks:** Maintaining N framework plugins. Mitigation: start with Vite only, add Next later on user demand.

**Effort:** 6 person-days.

**Demo criteria:** Install `@myrlin/preview-companion` as a devDep in a Vite project, add one line to `vite.config.ts`, Myrlin detects it, inspector switches from CDP mode to companion mode with < 50ms response time.

### Phase 4: live CSS tweak panel (2 weeks, v0.11)

**User story:** I want to tweak a button's color in the preview, see it change live, then commit the tweak to source when I'm happy.

**Scope:**
- CSS tweak panel (right side of preview when element is picked).
- Color picker, padding/margin/font-size sliders, font picker.
- Apply changes via ad-hoc style tag (S1 from 3.E).
- "Send to Claude" composes a prompt with the diff (S3 from 3.E).
- Temporary tweaks are cleared on reload.

Files:
- `src/web/public/inspector-panel.js` (add tweak UI)
- `src/web/public/preview.js` (inject ad-hoc style tag via postMessage or CDP)
- `src/web/public/styles-preview.css`

**Risks:** Specificity wars with Tailwind. Mitigation: inject with `!important` and inline styles on the element directly if needed.

**Effort:** 10 person-days (1 frontend with strong CSS chops).

**Demo criteria:** Pick a button. Drag the color picker from blue to purple. See the change live. Click "Send to Claude" with message "commit this color change." Claude edits the Tailwind config / CSS, preview HMRs, tweaks clear.

### Phase 5: auto-reload on Claude edit + screenshot-to-chat (1 week, v0.11.x)

**User story:** Claude finishes an Edit, preview reloads automatically. I can screenshot the preview to share back with Claude.

**Scope:**
- PTY output scanner watches for Edit tool completion markers.
- 500ms debounce + hard cap of 1 reload per 2 seconds.
- Screenshot button in preview toolbar (Cmd+Shift+S).
- Annotation overlay (circles, arrows, text).
- "Send to Claude" attaches image + annotations.

Files:
- `src/web/public/preview.js`
- `src/web/public/annotation-overlay.js` (NEW)
- `src/web/public/app.js` (key binding)
- `src/web/preview-manager.js` (PTY scan logic)

**Risks:**
- False positives on Edit detection. Mitigation: be specific about matching.
- Screenshot of cross-origin iframe needs CDP. Mitigation: reuse phase 3's CDP path.

**Effort:** 6 person-days.

**Demo criteria:** Type into the terminal pane: "Add a login button to the header." Claude edits files. Within 1 second of the edit, preview auto-reloads. Click screenshot, draw a circle around the button, write "make this red," click send. Claude edits, preview updates, loop repeats.

### Phase 6: mobile preview (1 week, v0.12)

**User story:** I want to test on my physical iPhone over Tailscale without typing the URL into the phone.

**Scope:**
- QR code modal (URL encoded to the LAN/Tailscale URL).
- Offer Cloudflare tunnel creation for the detected port (reuses `/api/tunnels`).
- "Open on phone" button in toolbar.

Files:
- `src/web/public/preview.js` (QR modal)
- `src/web/public/qrcode-modal.js` (NEW, or use existing mobile-pairing modal pattern)
- `src/web/server.js` (confirm `/api/preview/qr` returns the right URL)

**Risks:** User's dev server only listens on localhost (default for Next.js). Mitigation: detect, offer "restart with --host" hint, or use tunnel mode automatically.

**Effort:** 4 person-days.

**Demo criteria:** Click "QR" in preview toolbar. Phone scans. Phone browser opens the site. User can interact on phone.

### Phase 7: advanced agentic features (ongoing, v0.12+)

**User stories:** Various (A/B preview, DOM state as MCP tool, live coordination).

**Scope:** Defined per feature. Not a single sprint; a feature drumbeat spanning 4+ versions.

**Risks:** Over-engineering. Mitigation: ship one feature at a time, judge by adoption before starting the next.

**Effort:** 3-8 person-days per feature, ongoing.

---

## 7. Risks and Mitigations

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Cross-origin iframe blocks script injection | High | Certain | Approach C (overlay + CDP) for phase 3 universal, Approach A (companion plugin) for opt-in phase 3.5 |
| Dev server not running / wrong port | High | Common | Empty state with manual URL override; port auto-detect via both lsof AND PTY scanning for faster first-detect |
| Reload storm during Claude multi-file edits | Medium | Occasional | 500ms debounce + 1 reload / 2s cap; visual pulse indicator so user sees reload is happening |
| Mobile testing latency on Tailscale | Low | Common | Tailscale is usually <50ms on LAN; for remote, offer Cloudflare tunnel fallback |
| Electron dependency for `<webview>` | N/A | N/A | Deferred indefinitely; iframe + CDP covers 95% of cases |
| Auth token leak via preview | Medium | Rare | Token is origin-scoped, iframe is different origin; `referrerpolicy=no-referrer` prevents referrer leak |
| Preview iframe memory bloat (6 panes of heavy apps) | High | Occasional | Pause (src=about:blank) hidden panes; cap at 3 active preview iframes with "too many" warning |
| Hot reload cascades in Vite with >1000 modules already lag | Medium | Rare (large apps) | Debounce reload, respect framework's existing HMR (don't compound), expose "disable auto-reload" toggle |
| Preview companion plugin breaks user's build | Medium | Possible | Ship as optional, heavily-tested, feature-flagged plugin; clear docs; easy to uninstall |
| CDP attach fails on Firefox/Safari users | Low | Common for non-Chrome users | Clear messaging: "Inspector requires Chrome/Chromium with `--remote-debugging-port=9222`"; fall back to "ask Claude to inspect" workflow |
| Inspector in iframe stacking / z-index issues | Low | Occasional | CSS `position: fixed; z-index: 99999; pointer-events: auto;` on overlay; careful testing with modal-heavy apps |
| Preview URL has auth that expires | Medium | Some apps | Show login state via HTTP status monitoring; offer "open in external browser to log in, then copy cookies" workflow (phase 7) |
| User hits the wrong iframe sandbox flag and their app breaks | Low | Rare | Clear docs; default flags are the most-permissive-safe combination |
| Large responsive viewport scroll lag | Medium | At 4K presets | Use CSS `contain: strict` on iframe wrapper, limit DPR |

### Non-obvious pitfalls

**1. Mixed content.** User's dev server on `http://localhost:5173` loads assets from `https://cdn.example.com`. Modern Chrome blocks mixed content. Our preview is over `http://` (Myrlin's own origin), so this is the same behavior they get in a normal browser. No extra issue.

**2. Local API calls.** User's app at `localhost:5173` calls `localhost:5173/api/*` for backend. This works in iframe. But if the app uses absolute URLs like `http://localhost:3000/api`, it still works because it's the same domain as viewed from inside the iframe. Good.

**3. Service workers.** Some apps register service workers that cache aggressively. Hard reload (Cmd+Shift+R, which Chrome uses as "bypass cache") should pass `Cache-Control: no-cache` somehow. Iframes don't have this directly; we force-refresh via `iframe.src = iframe.src` with query cache-buster.

**4. WebSocket connections in the app.** User's app uses WebSocket for chat/realtime. Our iframe is a different origin than the preview, but WebSocket connections originate from the iframe itself, which is at `localhost:5173`. They work identically to a standalone browser.

**5. The app does `window.top.location = foo`.** `sandbox` without `allow-top-navigation` will block this. Most apps don't try; SPA apps use history API. If user reports "my OAuth redirect breaks in preview," tell them to use `allow-top-navigation-by-user-activation` or open-in-external-browser.

**6. localStorage / cookies.** The app's localStorage is isolated per origin, so per-port. User's dev app's localStorage is at `localhost:5173`. Previews are at the same URL, so same localStorage. State persists between reloads. Good.

---

## 8. Strategic Framing

### Myrlin's current positioning (v0.9.27)

"A browser-based Claude Code session manager. Run up to 6 Claude terminals in a grid, switch tabs, drag sessions around." This is a commodity; tmux-for-Claude. The features are excellent, the moat is thin.

### After the Live Preview Sidebar ships

"The AI-first IDE for design." Cursor positions as "AI-first code editor" (text focus). v0.dev is "AI-first UI generator" (generate-only, no local code). Bolt.new is "AI-first app builder" (browser-sandboxed, no local toolchain). Myrlin can claim an uncontested slot: **the only tool where you can run multiple Claude Code sessions against your own local codebase AND see the apps they are building AND drive edits via visual element selection.**

This is a more compelling value prop:
- For the indie dev: "see your design iterate live as Claude codes it."
- For the designer-shifted-to-code: "pick the button, ask Claude to fix it, done."
- For the agency: "run 6 client projects in parallel, each with its own preview."

### Competitive landscape shift

The IDE+AI wars have two fronts:
1. **Editor experience:** Cursor won the text-editor front. Windsurf chased. Zed is the third.
2. **Visual / design front:** v0.dev, Bolt.new, and Lovable.dev are all hosted-only. Myrlin's opportunity is "local + visual." Windsurf has element-inspect-to-agent but lacks session multiplexing.

Myrlin's unique combination:
- Local (your codebase, your toolchain, your IDE)
- Multi-session (6 Claude sessions running in parallel, each a different feature branch)
- Visual preview (new, this doc)
- Element-to-agent (new, phase 3)
- CSS tweakback (new, phase 4)

No other product combines all five.

### Pricing implications

Per `MEMORY.md` product philosophy:
- Preview itself is FREE (local feature, local compute, no infrastructure cost).
- Device presets, inspector, CSS tweak, screenshot-to-Claude: FREE.
- Cloudflare tunnel integration: FREE (user runs their own cloudflared).
- Team tier (paid) could add:
  - **Shared live preview sessions** - stakeholder joins your preview over web, sees it update as Claude edits. Requires a WebSocket relay we run.
  - **Preview recording** - record a video of the design iteration flow for PR review. Storage is our cost.
  - **Managed tunnels** - `yourname.myrlin.dev` persistent subdomain pointing to your local preview. Our infra.
- Frees: the entire local experience.
- Paid: collaboration + hosting.

This aligns with existing product philosophy and doesn't gate the core feature.

### Marketing angle

"See what Claude builds, as Claude builds it." (the tagline)

"Stop alt-tabbing. Your preview lives in Myrlin now, next to Claude."

Launch campaign:
- Loom / video of the inspector-to-agent loop (the "wow" demo).
- Reddit post to r/ClaudeAI: "Myrlin v0.10 just shipped live preview. Here's the before/after of my workflow."
- X / Twitter: a 30-second video of picking a button, typing "make this a gradient," pressing Enter, and watching Claude update the CSS.
- The "see-preview" muscle is underused; users instantly understand the value.

---

## 9. Integration with Existing Myrlin Systems

### 9.1 Tab groups

Preview is a pane type that lives in the existing tab group system (phase 0 change). `layout.tabGroups[i].panes[j]` gains a `type` field. No new top-level API; `PUT /api/layout` keeps its shape.

Tab group operations (create, close, rename, reorder, folder) apply uniformly to preview panes.

Drag-and-drop:
- Drop a URL into a pane slot -> convert to preview. (New)
- Drop a workspace into a pane slot -> convert to terminal. (Existing)
- Drop a session onto a preview pane -> swap pane to terminal with that session. (New, with confirmation)
- Drag a preview pane to another tab group -> move it. (Existing flow)

### 9.2 Layout save/restore

Preview state saved per pane:
```json
{
  "slot": 1,
  "type": "preview",
  "previewUrl": "http://localhost:5173/",
  "devicePreset": "desktop-1440",
  "zoom": 1.0,
  "inspectorMode": false,
  "showDeviceFrame": false
}
```
Restored on layout load. Backward-compat: panes without `type` default to `terminal`.

### 9.3 Keyboard shortcuts

New bindings (non-conflicting with existing per app.js review):
- `Cmd+Shift+P` - toggle preview (currently unused)
- `Cmd+Shift+I` - inspect mode (conflicts with "open DevTools"; we prevent default only when a preview pane is focused)
- `Cmd+Shift+D` - device picker
- `Cmd+L` - focus URL bar (only when preview focused)

Escape cascade update:
- Priority 0: modal open -> close modal.
- Priority 1 (NEW): inspect mode active -> exit inspect mode.
- Priority 2 (existing): expanded pane -> collapse.
- Priority 3 (existing): focused popup -> close.

### 9.4 Themes

Preview pane uses the same CSS custom properties as terminal panes. Catppuccin Mocha/Macchiato/Frappe/Latte -> automatic. Test in all four during QA.

Some previews may look bad with certain theme backgrounds (dark Myrlin wrapping a light user app). Ship a `padding` + subtle border so the iframe is visually distinct from Myrlin chrome.

### 9.5 Auth

Preview URL field passes through no auth. The iframe loads `http://localhost:5173` with the browser's normal origin handling. Myrlin's Bearer token is never in the iframe's context.

When the user previews a Myrlin-authenticated URL (e.g., `localhost:3456/app`), the iframe shares cookies with the parent (same origin). Works correctly.

When the user previews a URL requiring different auth (e.g., their company's staging), they would need to log in inside the iframe. Normal browser flow.

### 9.6 Cost tracking

Preview adds zero Claude cost. It's pure infrastructure. The cost tracker does not need changes.

"Send to Claude" features DO use Claude tokens. Users should see the cost grow in the existing cost panel naturally.

### 9.7 Session recovery

On Myrlin restart, previous preview panes are restored with their URL and state. If the underlying dev server is no longer running, the preview shows the empty state. User can restart the dev server in the adjacent terminal pane and the preview will hot-swap.

### 9.8 Notifications

New notification types (following v0.9 NotificationCenter pattern):
- `preview-server-ready` (low priority, toast): "Dev server ready at localhost:5173"
- `preview-server-died` (medium priority, toast): "Preview target unreachable"
- `preview-inspect-error` (medium priority, toast): "Inspector connection lost"
- `preview-reload-applied` (very low priority, silent unless user has enabled): "Preview reloaded"

### 9.9 Mobile app

The mobile companion (per `mobile-app-orchestration.md`) should support:
- Viewing the preview (stream the iframe via CDP screenshot feed)
- NOT running an iframe directly (mobile viewport is its own preview)
- "Open in browser" action on iPhone -> opens Safari with the tunnel URL

This is a later v0.12+ concern.

### 9.10 Settings panel

New "Preview" category with the toggles from 4.5. Follows existing settings rendering patterns.

### 9.11 MCP servers

Visual QA MCP gets a new tool: `pick_element_at_coords(x, y)` for phase 3. Optionally more: `get_preview_url(session_id)`, `set_preview_url(session_id, url)`, `get_preview_state(session_id)`.

These become available to Claude. Claude can, for example, look at what's in the preview before answering a question.

---

## 10. MVP Scope for v0.10 Alpha (6-Week Plan)

### What ships

**Week 1-2: Phase 0 (foundation).**
- Refactor pane system to support pane types.
- Migration testing.
- Layout backward-compat verified.

**Week 3-5: Phase 1 (iframe preview).**
- PreviewPane class.
- URL bar + reload + open-in-browser.
- Port auto-detect (2s poll).
- Preview visibility toggle.
- Layout persistence.
- Catppuccin theme integration.

**Week 6: Hardening + release candidate.**
- Screenshot tests across themes.
- Memory profiling (6 terminals + preview).
- Cross-platform verification (Windows + Mac + Linux).
- Documentation (README update, in-app help).
- Changelog entry.

### What does NOT ship in v0.10

- Device presets (Phase 2, v0.10.1 or v0.10.2 follow-up).
- Inspector (Phase 3, v0.11).
- CSS tweak (Phase 4, v0.11).
- Auto-reload on Claude edit (Phase 5, v0.11.x).
- Mobile QR (Phase 6, v0.12).

### Why this is the right MVP

The "context-switch killer" benefit lands with JUST the iframe. Everything else is incremental polish. If the MVP ships and users don't adopt it, no amount of polish will save it; if the MVP ships and users love it, every subsequent feature is low-risk compounding. Ship the narrow thing first.

### Success metrics for v0.10

- 60%+ of v0.10 users enable preview at least once in the first week.
- 30%+ continue using preview daily after 4 weeks.
- Reddit / X sentiment measurable: look for "I no longer tab out to Chrome" testimonials.
- Zero crashes introduced on v0.9.x regression tests.
- Memory footprint < +50MB per preview iframe average.

### Acceptance criteria for v0.10 release

- [ ] Preview pane loads a Vite app in < 1s after port is available.
- [ ] HMR from Vite works inside the preview iframe.
- [ ] Preview URL persists across Myrlin restart.
- [ ] Cmd+Shift+P toggles visibility.
- [ ] Open-in-browser opens the system default browser with the preview URL.
- [ ] Empty state is informative (not just blank).
- [ ] Works on Windows 11, macOS 14, Ubuntu 24.04.
- [ ] No regressions to existing terminal pane system.
- [ ] All 26+ test suite passes.
- [ ] Screenshot tests captured for docs/screenshots/.

---

## 11. Post-MVP Roadmap

| Version | Approx ETA from v0.10 | Features |
|---|---|---|
| v0.10.1 | +2 weeks | Phase 2: device presets, zoom, rotate. Open-in-browser works on all platforms. |
| v0.10.2 | +4 weeks | UX polish based on v0.10 feedback. Edge cases (multi-port apps, backend-first apps like Rails, Django). Manual URL override per workspace. |
| v0.11 | +8 weeks | Phase 3: element inspector (overlay + CDP). Phase 4: CSS tweak panel + "Send to Claude" with computed style diff. |
| v0.11.x | +10 weeks | Phase 3.5: optional Vite companion plugin. Phase 5: auto-reload on Claude edit, screenshot-to-chat with annotations. |
| v0.12 | +14 weeks | Phase 6: mobile QR + Cloudflare tunnel integration. Shared preview (paid tier foundation). |
| v0.12+ | Ongoing | Phase 7: A/B preview across branches, DOM-state MCP tool, live coordination for agentic testing, Lighthouse integration. |

### Decision point at v0.11

After phase 3 ships, measure adoption. If the inspector + Send-to-Claude loop is heavily used, it confirms the "AI-first IDE for design" positioning and we double down. If not, we retreat to "Myrlin for local devs" and deprioritize phase 4+.

---

## 12. Appendix: Detailed Technical Notes on Element Inspector Approaches

### 12.A Why same-origin is rarer than expected

In the proposed architecture, Myrlin runs on `localhost:3456` and the user's dev server runs on `localhost:5173`. These are different origins by the Same-Origin Policy (host part `localhost` is the same, scheme `http` is the same, but port differs). Every cross-origin restriction applies:
- Cannot read `iframe.contentDocument`.
- Cannot call `iframe.contentWindow.postMessage` - wait, yes we can. postMessage works cross-origin by design.
- Cannot read/set cookies of the iframe's origin.
- Cannot use JavaScript to click things inside the iframe.
- Cannot observe events inside the iframe.

So, reliably, the ONLY thing we can do without explicit cooperation is:
1. Set `iframe.src`.
2. Use postMessage to send messages. The inside of the iframe has to listen and respond - and that requires our script to be running inside.

Getting our script running inside requires either:
- (A) The dev server to include it (Vite plugin approach).
- (B) CDP to inject it after load.

### 12.B CDP injection approach

Using CDP's `Page.addScriptToEvaluateOnNewDocument`, we can inject a script that runs before any page script on every load. Structure:

```js
async function ensureInspectorInjected(targetId) {
  const client = await CDP({ target: targetId, port: 9222 });
  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();

  await Page.addScriptToEvaluateOnNewDocument({
    source: `(function() {
      if (window.__myrlinInspector) return;
      window.__myrlinInspector = {
        pick(x, y) {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          return {
            selector: window.__myrlinInspector.selectorOf(el),
            outerHTML: el.outerHTML.slice(0, 2000),
            computedStyles: (() => {
              const s = getComputedStyle(el);
              return {
                color: s.color,
                backgroundColor: s.backgroundColor,
                fontSize: s.fontSize,
                padding: s.padding,
                margin: s.margin,
                borderRadius: s.borderRadius,
                display: s.display,
                width: s.width,
                height: s.height,
              };
            })(),
            rect: el.getBoundingClientRect(),
          };
        },
        selectorOf(el) {
          if (el.id) return '#' + el.id;
          const parts = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && cur !== document.body) {
            let s = cur.tagName.toLowerCase();
            if (cur.className && typeof cur.className === 'string') {
              s += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
            }
            const siblings = Array.from(cur.parentElement?.children || []).filter(c => c.tagName === cur.tagName);
            if (siblings.length > 1) {
              s += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
            }
            parts.unshift(s);
            cur = cur.parentElement;
          }
          return parts.join(' > ');
        },
      };
    })();`,
  });
}
```

From Myrlin, to pick an element at a given coordinate:
```js
await Runtime.evaluate({
  expression: `window.__myrlinInspector.pick(${x}, ${y})`,
  returnByValue: true,
});
```

The coordinates must be relative to the iframe's viewport, not Myrlin's window. So the front-end calculates `evt.clientX - iframeRect.left` then scales by zoom.

Downside: CDP requires Chrome. Firefox has its own debugging protocol but is less stable. Safari does not expose CDP.

### 12.C Companion plugin approach (Vite example)

```js
// packages/preview-companion/vite-plugin.js
export function myrlinPreviewCompanion(options = {}) {
  return {
    name: 'myrlin-preview-companion',
    apply: 'serve',
    transformIndexHtml(html) {
      if (process.env.NODE_ENV !== 'development') return html;
      const script = `<script>${SCRIPT_CONTENT}</script>`;
      return html.replace('</body>', script + '</body>');
    },
  };
}
```

Where `SCRIPT_CONTENT` is a self-contained script that:
1. Listens for `message` events from `window.top` (or the first ancestor Myrlin frame).
2. Shakes hands: on receiving `{type: 'myrlin:handshake'}`, responds `{type: 'myrlin:ready', version: '1'}`.
3. On `{type: 'myrlin:pick-on'}`, starts hover tracking.
4. On `{type: 'myrlin:pick-off'}`, stops.
5. Sends `{type: 'myrlin:element', data: {selector, html, styles}}` on click.

Myrlin side:
```js
iframe.contentWindow.postMessage({type: 'myrlin:handshake'}, '*');
window.addEventListener('message', (e) => {
  if (e.source !== iframe.contentWindow) return;
  if (e.data.type === 'myrlin:ready') {
    // companion detected, use fast path
  }
});
```

If handshake times out (300ms), fall back to CDP.

### 12.D Inspector visual design

Inspector overlay mode has three visible states:

**1. Hover (no element picked yet):**
- A blue 1px solid outline around the element under the cursor.
- A label at the top-right of the element: its tag + id (if any) + first class.
- Semi-transparent fill (background rgba(59, 130, 246, 0.1)).

**2. Selected (element picked, still in inspect mode):**
- A persistent purple 2px outline around the picked element.
- Hovering still shows the blue outline (can pick another).
- Side panel shows details of selected element.

**3. Sent to Claude (pending response):**
- Pulse the selected outline briefly.
- Show a toast "sent to Claude."

### 12.E Screenshot capture approaches

Three ways to screenshot the preview:

**1. CDP Page.captureScreenshot.** Best quality. Requires CDP connection. Handles full-page and clip regions. Uses this for phase 5.

**2. html2canvas in the iframe.** Requires companion script. Works for same-origin-emulated cases. Degraded fidelity (some CSS features fail).

**3. Parent-side screenshot using DOM-to-image.** Impossible cross-origin.

**4. getDisplayMedia (capture tab).** Browser API, requires user permission every time. Not usable for silent screenshot.

**Recommendation: option 1 (CDP). Fall back to user-facing "right-click, save image" if CDP unavailable.**

### 12.F MCP tool additions for Claude to drive the preview

To let Claude drive the preview end-to-end, extend the Visual QA MCP with:

```json
[
  {
    "name": "preview_navigate",
    "description": "Navigate the Myrlin preview iframe to a URL.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {"type": "string", "description": "URL to load"},
        "sessionId": {"type": "string", "description": "Optional session ID to route to correct preview"}
      },
      "required": ["url"]
    }
  },
  {
    "name": "preview_reload",
    "description": "Force a reload of the Myrlin preview iframe."
  },
  {
    "name": "preview_screenshot",
    "description": "Take a screenshot of the current preview. Clips to the iframe viewport by default."
  },
  {
    "name": "preview_pick_element",
    "description": "Query the element at given coordinates in the preview iframe. Returns selector, outerHTML, and computed styles.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"}
      },
      "required": ["x", "y"]
    }
  },
  {
    "name": "preview_set_device",
    "description": "Change the preview device preset (e.g., iphone-15, desktop-1440).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "preset": {"type": "string"}
      },
      "required": ["preset"]
    }
  }
]
```

Claude Code sessions running in Myrlin terminals have access to these via the Visual QA MCP. This enables workflows like:
- "Claude, take a screenshot of the current preview, then make the header blue."
- "Claude, switch to the iPhone preset and check if the menu fits."
- "Claude, reload the preview, then verify that the button at position (400, 200) has text 'Submit'."

### 12.G Performance measurements to track

For future optimization work, instrument these and log:
- Port discovery latency (PTY scan ms, lsof ms).
- First-preview-load latency (from port-detected to iframe.onload).
- Reload time (from edit trigger to iframe reload complete).
- RAM usage per preview iframe (sample every 30s).
- CDP round-trip time for inspect calls.
- Handshake success rate for companion plugin.
- False-positive rate for Claude-edit detection.

### 12.H Open questions for v0.10

1. Should the preview pane share the tab group bar, or have its own? **Proposed:** share - treat as generic pane type.
2. Should device presets be user-editable? **Proposed:** yes, but in v0.11. Ship canonical Chrome DevTools list in v0.10.
3. Should we ship the Vite companion plugin as part of Myrlin or a separate package? **Proposed:** separate `@myrlin/preview-companion` package for clean lifecycle.
4. How do we handle apps that require HTTPS (e.g., things using `navigator.geolocation`)? **Proposed:** document "use external browser for these flows" in v0.10, revisit in v0.11.
5. What about iframes inside the previewed app? Nested cross-origin gets tricky; CDP target switching works but is non-trivial. **Proposed:** v0.10 handles top-level only; nested frames silently ignored in inspector.

---

## Recommended approach (one-paragraph summary)

Ship a live preview pane as a new pane type inside the existing tab group system. MVP (v0.10, 6 weeks) is an iframe pointing at the auto-detected dev server port, with URL bar, reload button, and layout persistence - nothing more. This removes the context switch today and validates the layout changes. Then ladder up through device presets (v0.10.1), element inspector via CDP overlay (v0.11), CSS tweak panel + "Send to Claude" prompt bridge (v0.11), optional Vite companion plugin for zero-latency inspect (v0.11.x), auto-reload on Claude edit + annotated screenshots (v0.11.x), mobile QR + Cloudflare tunnel (v0.12), and advanced agentic features (v0.12+). The transformative feature is Tier-S element-to-agent: pick a button in the preview, click "send to Claude," get a rich prompt including selector, HTML, computed styles, and screenshot - closing the design loop inside Myrlin. This positions Myrlin as "the AI-first IDE for design," an uncontested spot against Cursor (text-first), v0.dev (generator-only), and Bolt.new (browser-sandboxed), while Windsurf has validated the demand for exactly this feature. Every phase is shippable independently, every phase is backward-compatible with existing layouts, and the whole stack reuses already-shipped Myrlin infrastructure: port discovery (v0.9.x), CDP (Visual QA MCP), Cloudflare tunnels (`/api/tunnels`), Tailscale URLs (pairing.js), and the tab group system.
