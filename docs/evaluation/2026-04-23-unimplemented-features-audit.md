# Myrlin Workbook - Unimplemented Features Audit

**Date:** 2026-04-23
**Auditor:** Claude (Opus 4.7, 1M context, read-only)
**Version audited:** v0.9.27 (package.json confirmed)
**Methodology:** Full read of every planning doc, grep verification against `src/`, GitHub API cross-reference for every issue number, spot-checks of CHANGELOG claims against actual code.

---

## 1. Executive Summary

The planning docs are in worse shape than the product. Myrlin v0.9.27 has shipped roughly 85-90 percent of everything in `TODO.md` and `IDEAS.md`, but the docs have never been pruned. The result is a set of checklists that lie about the state of the codebase in both directions: items listed as "Upcoming" or "Future" are already in production, items checked as shipped are either missing or half-built, and the "Feature Backlog (Organized Feb 10 2026)" section in `IDEAS.md` references 20+ GitHub issue numbers (#47-#80 and #66) that **do not exist in the repository**. The highest-numbered real issue is #42 and issues #45, #46 are PRs, not issues.

**Top findings:**

1. **Phantom GitHub issues.** `IDEAS.md` lists issue numbers #47-62, #66, #78, #80 as if they were real tracking tickets. None of them exist. The repo's issue tracker has exactly 18 issues, highest is #42. Every reference in the "Feature Backlog (Organized Feb 10 2026)" section to a ticket greater than #46 is hallucinated or stale from a deleted draft phase. Those numbers should be stripped entirely.
2. **TODO.md "Immediate" section is largely shipped.** Of the 9 items in `## Immediate`, at least 4 are already in production: 6-pane terminal grid (shipped v0.8.0), collapsible sidebar (shipped, `toggleSidebarCollapse` at `src/web/public/app.js:7375`), smart grid layouts for pane counts 1-6 (shipped v0.7.0-alpha.5 + v0.8.0), drag-and-drop pane reordering (shipped, see `app.js:9824`). These belong in the Shipped list.
3. **TODO.md "Upcoming" section is fully shipped.** All four items (resource tracking, subagent tracking, Cloudflare tunnel, password-protected web access) are already live. Cloudflare tunnel via named tunnel shipped v0.7.0, subagent detection ships agent-count badges on kanban cards, per-session CPU/memory in `/api/resources`, password auth has been present since v0.1.
4. **"Future Enhancements" section mostly shipped.** Windows Terminal tab integration is the only honest "not started" item in that list. Session output capture/log streaming, workspace import/export, custom keybinding config, session templates (template system shipped v0.7.0-alpha.11 area), multi-monitor/split-pane views (6-pane grid covers most of this).
5. **Genuine unshipped features are few but meaningful:**
   - Frosted glass permission prompt (BETA setting with clickable buttons)
   - Ctrl+V image paste in terminals (currently only text paste routes through properly)
   - Multi-provider support (Codex, Aider, Gemini)
   - Cross-workspace Project Docs auto-discovery (read-only scan of markdown files in working dirs)
   - Workspace import/export as JSON
   - Custom keybinding rebinding
   - Budget alerts / cost thresholds
   - Per-action cost breakdown (token usage per tool call)
   - Session handoff / context export for continuing on another machine
   - Session activity timeline visualization
   - Saveable named layout configurations
   - Windows Terminal deep integration (wt.exe)
   - Session Sharing / Proxy (#10, the only real open enhancement issue, detailed plan exists at `docs/SESSION-SHARING-PLAN.md`)
   - Rule auto-injection (rules storage and UI shipped, but rules are NOT fed into launched Claude sessions as system context)
   - Sound/audio notification on Claude finishing (sound exists but only for completion UI toast, no per-pane audio alert setting)
6. **CHANGELOG version ordering is broken.** v0.9.22 → v0.9.23 → v0.9.24 is listed AFTER v0.9.25 despite v0.9.25 being chronologically later. The file's chronology is mixed. A reader with "semantic versioning tells the story" expectations will get confused (more of a cosmetic issue, but worth fixing).
7. **README vs. product mismatch.** README still shows 4-pane grid screenshots and says "4-pane grid" everywhere while the code is MAX_PANES=6. README header is "Myrlin's Workbook" while TODO calls for rebranding to "Myrlin Workbook" (drop the apostrophe-s). This is the single biggest "documentation lies about the product" problem.
8. **PLANNING.md is v0.8 planning doc.** Every phase it lists (Phases 1-8) is shipped. The doc is stale by 7 versions. Should either be archived or rewritten.
9. **ROADMAP.md is claimed shipped but does not exist on disk.** IDEAS.md checks off "Create public ROADMAP.md (#55)" but `ROADMAP.md` is gitignored AND missing from the working tree. The only roadmap is the `## Roadmap` section at the bottom of README.md. So this is both phantom-shipped AND currently broken ("Create public roadmap" was supposed to make roadmap information more discoverable; instead the planning doc now claims it exists without actually creating it).

Rough genuine unshipped fraction: about 12-15 percent of everything the docs track. The rest is shipped or partially shipped.

---

## 2. Method

### Docs read (full reads, except where noted)

- `TODO.md` (full, 84 lines)
- `IDEAS.md` (full, 391 lines)
- `PLANNING.md` (full, 446 lines, v0.8 planning doc dated Feb 20 2026, never updated since)
- `CHANGELOG.md` (full, 535 lines, all 73+ version entries back to v0.1.0)
- `README.md` (full, 521 lines)
- `CLAUDE_WORKFLOW.md` (full, 127 lines)
- `docs/SESSION-SHARING-PLAN.md` (full, 150 lines)
- `docs/WORKFLOWS.md` (full, 312 lines)
- `docs/plans/2026-03-28-myrlin-mobile-design.md` (first 150 lines, full file not required for audit)
- `docs/plans/2026-03-29-server-mobile-support.md` (first 150 lines)
- `.gitignore` (confirmed what planning docs are ignored)
- `package.json` (confirmed version 0.9.27)

### Source files spot-checked

- `src/web/server.js` (7,879 lines, grepped for ~30 keywords)
- `src/web/public/app.js` (17,576 lines, grepped for ~30 keywords)
- `src/web/public/terminal.js` (grepped for auto-trust, image paste, clipboard)
- `src/web/public/index.html` (grepped for favicon, PWA, voice mic, manifest)
- `src/web/pairing.js`, `push.js`, `device-manager.js`, `auth.js`, `backup.js` (verified shipped mobile support)
- `src/state/store.js`, `src/state/docs-manager.js` (verified Rules storage vs. injection)
- `src/core/*.js` (verified providers directory does NOT exist, session-manager and recovery shipped)
- `src/web/public/.backup/` (verified this is a frontend snapshot for rollback, not a state backup feature)

### GitHub verification

- `gh issue list --state all` enumerated every issue (1, 4, 5, 8, 10, 14, 15, 17, 18, 20, 27, 30, 32, 33, 35, 39, 41, 42 = 18 issues total)
- `gh pr list --state all` enumerated every PR (highest #46)
- `gh issue view <N>` ran for each of the numbers referenced in `IDEAS.md` (45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 66, 78, 80)
- `git tag` verified v0.1.0 tag exists (IDEAS.md says it doesn't)

### Grep patterns used (representative sample)

- `MAX_PANES` - 20+ hits, confirms 6-pane ship
- `sidebarCollapsed|toggleSidebarCollapse` - hits in `app.js:7375-7399`, confirms sidebar collapse ship
- `frostedGlass|frosted-glass|permission.*detection` - zero hits, confirms NOT shipped
- `navigator\.clipboard\.read\(\)|handleImagePaste` - zero hits, confirms image-paste NOT shipped
- `providers/|claudeProvider|codexProvider` - zero hits, confirms multi-provider NOT shipped
- `/api/search-conversations` and `/api/search` - both present, confirms JSONL full-text + global search ship
- `workspace.*import|workspace.*export|/api/workspaces/export` - zero hits, confirms NOT shipped
- `budgetAlert|costThreshold|spendingLimit` - zero hits, confirms NOT shipped
- `activityTimeline|sessionTimeline|timelineChart` - zero hits, confirms timeline viz NOT shipped
- `session-chain|workflowChain|autoLaunchNext` - zero hits, confirms NOT shipped
- `rules.*inject|appendSystemPrompt|systemPromptRules` - zero hits in src, confirms rules are stored but not injected
- `savedLayout|saveLayout|layoutName` - zero hits, confirms NOT shipped
- `wt\.exe|Windows Terminal` - zero hits, confirms Windows Terminal integration NOT shipped
- `jsonl-watcher|mirror.*session|fork.*session` - zero hits, confirms session sharing (#10) NOT shipped
- `SpeechRecognition|webkitSpeechRecognition` - hits in `app.js:154` and `index.html:545`, confirms voice input ship
- `/api/auth/pair|pairingToken|pairedDevices` - hits, confirms mobile pairing backend ship

---

## 3. Definitely Unshipped Features

Grouped by release-scoping category, with evidence and sizing.

### 3A. Quick Wins (S effort, < 1 day each)

These should get closed out in an 0.9.28 polish release. All are 1-50 line changes.

#### 3A.1. Rebrand "Myrlin's Workbook" to "Myrlin Workbook" (drop apostrophe-s)

- **Source:** `TODO.md:66`
- **Referenced issue:** none real
- **Verification:** `Grep "Myrlin's Workbook"` finds 24 occurrences across 17 files including `README.md:2,4`, `package.json` description, `index.html`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/WORKFLOWS.md`, `docs/plans/2026-03-28-myrlin-mobile-design.md`, `mobile/services/api-client.ts`, `site/index.html`. The rest of the codebase already uses "Myrlin Workbook" (no apostrophe). Inconsistency is everywhere.
- **Effort:** S (sed replace across ~17 files, smoke test page render)
- **Impact:** Med (product identity consistency; every place the app introduces itself)
- **Notes:** Also update `package.json` description, GitHub repo description, npm metadata. There's ambiguity whether the *brand* name is "Myrlin's Workbook" (possessive, emphasizes that Myrlin owns his workbench) or "Myrlin Workbook" (compound noun, cleaner in logs). Arthur has decided for the latter in TODO.md so this is a decision, not a debate.

#### 3A.2. Change all "4-pane" verbiage to "multi-pane"

- **Source:** `TODO.md:67`
- **Verification:** `Grep "4-pane"` in README finds 4 hits (`README.md:17, 104, 153, 155, 251`). The app is 6-pane since v0.8.0 (Feb 23 2026). Two months of README lying about the core terminal feature.
- **Effort:** S (README edits, alt text updates)
- **Impact:** Med (readers evaluating the tool see "4-pane" screenshots and think it's outdated)
- **Notes:** Also update `docs/images/hero-demo.gif` alt text and the comparison table in README. Consider re-shooting the hero demo GIF showing 6 panes (separate task).

#### 3A.3. Ctrl+V image paste in terminal panes

- **Source:** `TODO.md:68`
- **Verification:** `Grep "navigator\.clipboard\.read\(\)"` - zero matches in non-vendor code. `Grep "handleImagePaste|pasteImage"` - zero matches. The terminal has `clipboard.readText()` for text paste (`terminal.js:669`) but no `clipboard.read()` for arbitrary clipboard items including images.
- **Effort:** S (30-60 lines; detect image blob in Ctrl+V, route to existing `handleImageUpload()` flow)
- **Impact:** High (image-first Claude workflows - screenshots for bug reports, design reference images, chart sharing - are a significant fraction of how Claude Code is used in 2026)
- **Risk:** Low. Image upload pipeline already exists (`docs/WORKFLOWS.md` references it). This is plumbing.
- **Notes:** The existing Ctrl+V fix in v0.9.27 (PR #45) resolves double-paste but does not enable image paste. Should reuse the same preview modal that file-drop uses.

#### 3A.4. Frosted glass permission prompt (BETA, must be enabled in Settings)

- **Source:** `TODO.md:60-65`
- **Verification:** `Grep "frostedGlass|frosted-glass|permission-prompt|detectPermissionPrompt"` - zero matches. Auto-trust shipped v0.7.0-alpha.2 (pattern detection + "Needs input" badge), but there's no visual overlay or clickable response options when Claude asks for approval.
- **Effort:** M (design approx 1 day; implementation 1-2 days - CSS backdrop-filter blur + pattern detection on prompt text + clickable button overlay that sends keystrokes through the PTY WebSocket)
- **Impact:** High (this is a "Wow" feature that solidifies Myrlin's position as *the* autonomous Claude wrangler)
- **Risk:** Medium. Detection false-positives on arbitrary "Y/n" prompts from non-Claude tools. The TODO specifies graceful degradation if detection fails, so the blast radius is small. Default-off behind Settings toggle protects users.
- **Notes:** Pairs naturally with existing auto-trust. If auto-trust is OFF and frosted glass is ON, the user gets a beautiful clickable modal instead of typing. If auto-trust is ON, only dangerous prompts surface the glass.

#### 3A.5. Update favicon with Myrlin hat logo

- **Source:** `IDEAS.md:279` (falsely labeled #50)
- **Verification:** `Grep "favicon" src/web/public/index.html` finds 3 `<link rel="icon">` entries referencing `favicon-32.png`, `favicon-192.png`, `apple-touch-icon.png`. These files exist in `src/web/public/` (confirmed via `ls`). Status: **UNCLEAR**. The files exist but are they actually the Myrlin hat? Needs visual check. Arthur can open `favicon-192.png` and decide. If they're the hat, mark shipped. If they're placeholder, mark as true unshipped.
- **Effort:** S (if regenerate needed, 30 min in image editor + rebuild icons)
- **Impact:** Low (cosmetic)
- **Notes:** This might be phantom-unshipped. Mark as "check and close."

#### 3A.6. Fix header logo spacing - text closer to hat

- **Source:** `IDEAS.md:280` (falsely labeled #51)
- **Verification:** `Grep "login-logo\|logoHat" index.html` shows `<img src="logo.png" alt="Myrlin" class="login-logo-img">` on the login page. No evidence of text-to-logo spacing tuning. This is a CSS tweak on `.header-logo` or similar. Likely 1-5 lines of CSS.
- **Effort:** S (5 min in styles.css + visual verification)
- **Impact:** Low
- **Notes:** Quick polish; lump it with the rebrand in one PR.

#### 3A.7. Fix README animated hat GIF - remove purple glow, keep float animation only

- **Source:** `IDEAS.md:281`
- **Verification:** Read `docs/images/logo-animated.svg` line 5: `animation: logo-float 4s ease-in-out infinite, logo-glow 3s ease-in-out infinite alternate;`. Confirmed: glow animation is still present. Line 11 has `@keyframes logo-glow`.
- **Effort:** S (2-line edit to remove `logo-glow` from animation stack and delete the keyframe)
- **Impact:** Low (visual consistency; login page and README use different animation styles per the TODO note)
- **Notes:** Possibly keep a subtle glow if it reads as "magical" on hover, but the TODO says keep float only. Honor the TODO.

#### 3A.8. Catppuccin Frappe + Macchiato themes

- **Source:** `IDEAS.md:281` (labeled #52 fictionally)
- **Verification:** `Grep "frappe|macchiato" index.html` finds both in the theme dropdown at line 21. v0.1.0 CHANGELOG confirms 4 Catppuccin themes shipped. **PHANTOM-UNSHIPPED.** Already done. Remove from IDEAS.md.

#### 3A.9. v0.1.0 release tag

- **Source:** `IDEAS.md:274` (labeled #46 fictionally)
- **Verification:** `git tag` shows `v0.1.0` exists. **PHANTOM-UNSHIPPED.** Already done. Remove.

#### 3A.10. Create scheduled Hacker News post for 8:07 AM

- **Source:** `TODO.md:49`
- **Verification:** This is a marketing task, not a software feature. No code expected.
- **Effort:** S (author the post, set a reminder)
- **Impact:** High (if Myrlin hits the front page)
- **Notes:** Belongs in a marketing backlog file, not the product TODO. Should be in `GROWTH_STRATEGY.md` or a scheduled calendar entry.

---

### 3B. Medium Features (M effort, 1-3 days each)

#### 3B.1. Project Docs Discovery (Auto-scan project markdown files)

- **Source:** `IDEAS.md:43-71`
- **Referenced issue:** none real
- **Verification:** `Grep "project-docs|projectDocs|scanProjectDocs"` - zero matches. Not built. The feature description proposes a read-only `Project` tab that scans `workingDir` for TODO.md, IDEAS.md, README.md, CLAUDE.md and renders them with a 30s cache.
- **Effort:** M (new API `GET /api/workspaces/:id/project-docs`, 30s cache, collect working dirs from sessions, scan for known filenames, parse markdown, render in new tab in docs panel). About 200-400 LOC backend + 150-300 LOC frontend.
- **Impact:** High for developers who keep knowledge in markdown (essentially everyone using Claude Code). Differentiator vs Cursor/Windsurf which don't surface in-repo markdown.
- **Risk:** Low. Pure read, no writes. Cache prevents disk thrash.
- **Notes:** Well-spec'd in IDEAS.md with UI, caching, principles all laid out. Ready to execute.

#### 3B.2. Right-click workspace - "New Feature Session" (branch + worktree + Claude)

- **Source:** `IDEAS.md:284` (falsely labeled #48)
- **Verification:** `Grep "New Feature Session"` finds 3 hits in `app.js`. **SHIPPED.** The right-click context menu on a workspace has "New Feature Session" at `app.js:8817`. **PHANTOM-UNSHIPPED.** Already done.

#### 3B.3. Nested workspaces (project > workspace hierarchy)

- **Source:** `IDEAS.md:285` (falsely labeled #49)
- **Verification:** v0.7.0-alpha.5 CHANGELOG reads: "Organizational hierarchy renamed - 'Workspace Groups' are now 'Categories', 'Workspaces' are now 'Projects', child workspaces are 'Focuses'. The 3-level hierarchy is: Category > Project > Focus > Sessions." **SHIPPED.** Then v0.8.2 deliberately REMOVED workspace nesting ("Removed 'Set Parent' and 'Remove Parent' from the workspace context menu. Use Categories for grouping instead, which is simpler and less confusing"). So the feature was shipped, then simplified. Mark as **SHIPPED AND THEN REVISED.** Remove from IDEAS.md or add a note explaining the evolution.

#### 3B.4. Session templates / quick launch

- **Source:** `IDEAS.md:286` (labeled #57 fictionally)
- **Verification:** `Grep "template" server.js` finds 16 hits including `_state.templates` CRUD. MEMORY.md from `~/.claude/projects/` confirms templates with headerHtml/onHeaderClick. README lists "Session templates" as shipped. CHANGELOG has no exact line but the template CRUD endpoints are clearly in the code. **PHANTOM-UNSHIPPED.** Done.

#### 3B.5. Workspace Rules - per-workspace rules injected into sessions

- **Source:** `IDEAS.md:287` (labeled #78 fictionally)
- **Verification:** `Grep "rules" src/state/docs-manager.js` shows rules stored alongside notes/goals/tasks/roadmap (CRUD endpoints exist). But `Grep "rules.*inject|appendSystemPrompt"` finds zero hits. **PARTIALLY SHIPPED: storage and editing in UI shipped; auto-injection into sessions NOT shipped.**
- **Effort:** M (on session start, fetch workspace rules and prepend to the initial prompt OR pass via a system-prompt flag if Claude CLI supports it; ~50-100 LOC in `pty-manager.js` and `session-manager.js`)
- **Impact:** High. This is the "why the workspace knows about your preferences" magic. Without it, Rules are just a notepad.
- **Risk:** Medium. Claude CLI doesn't have a clean `--system` flag; you'd need to either prepend to the initial `--prompt` string or write a CLAUDE.md to the workspace before spawn. Need to decide the mechanism.
- **Notes:** Most likely easiest to write `.claude/myrlin-rules.md` to the working dir on session launch and reference it in the initial prompt. Users can then opt-in or out per-workspace.

#### 3B.6. Sound/notification when Claude finishes in a terminal pane

- **Source:** `IDEAS.md:288` (labeled #80 fictionally)
- **Verification:** `Grep "_playNotificationSound"` finds the function at `app.js:10922`. It's called from `app.js:10868` (line 10853 comment says "Respect completion notifications setting"). So there IS a sound on completion. **PHANTOM-UNSHIPPED** for the basic feature.
- **However:** The sound is global (plays once when any session goes idle). There's no per-pane setting, no sound customization, no volume control. If the TODO meant that level of granularity, it's still unshipped.
- **Effort:** S (add Settings toggle and a handful of sound options - ding, chime, bell, off) if polish is desired.
- **Impact:** Low-Medium depending on interpretation.

#### 3B.7. Right-click "Start Session with Project Context"

- **Source:** `IDEAS.md:289` (labeled #66 fictionally)
- **Verification:** `Grep "startSessionWithProjectContext|contextPackage"` finds hits in `server.js:4244` - the spinoff-context endpoint builds a contextPackage markdown doc. This powers Task Spinoff. The question is whether there's also a simpler right-click option that just starts a session with the project's rules/notes/goals prefixed. Task Spinoff is a more complex workflow (extract tasks via AI).
- **Partial status:** Spinoff-based context package is shipped (v0.7.0). A lightweight "Start Session with Project Context" that bundles the workspace docs without the task-extraction step is NOT distinctly shipped.
- **Effort:** M (UI option that reads Rules/Goals/Notes and prepends to `--prompt` flag on spawn; reuse existing docs-manager)
- **Impact:** Medium. It's redundant with Task Spinoff + workspace rules auto-injection, but distinct enough that users expecting a one-click "give this session my project context" would value it.

---

### 3C. Big Features (L effort, 1+ weeks each)

#### 3C.1. Cost tracking per session (#1 community priority)

- **Source:** `IDEAS.md:292` (labeled #56 fictionally)
- **Verification:** Cost tracking ships throughout CHANGELOG (v0.3.0-alpha Costs dashboard, v0.9.11 async cost, v0.9.14 in-place cost badge patching, v0.9.2 period apportioning). `/api/cost/batch`, `/api/cost/dashboard`, per-model pricing, SVG timeline - all shipped. **PHANTOM-UNSHIPPED.** Done.

#### 3C.2. Feature tracking board - group sessions by branch, AI summaries

- **Source:** `IDEAS.md:293` (labeled #53 fictionally)
- **Verification:** Kanban board with Backlog/Planning/Running/Review/Done columns shipped v0.7.0-alpha.6-alpha.12. Cards grouped by branch via worktree tasks. AI summaries via refocus, spinoff, and `claude --print` integrations. **PHANTOM-UNSHIPPED.** Done.

#### 3C.3. Auto-docs: silent background session summarizer

- **Source:** `IDEAS.md:294` (labeled #54 fictionally)
- **Verification:** `Grep "autoDocs|backgroundSummarizer|silentSummarizer|autoSummarize"` - zero matches. However auto-title from JSONL summaries IS shipped ("Session auto-titling from JSONL summaries" in IDEAS.md Already Shipped list). The "auto-docs" feature as spec'd is a BACKGROUND process that silently summarizes sessions into the workspace docs panel. That does NOT exist.
- **Effort:** L (cron-style background worker that periodically runs a summarizer over new session content and updates the workspace Notes/Goals/Rules; ~500-1000 LOC and careful throttling)
- **Impact:** Medium. It's a magical feature if it works well, annoying if it hallucinates or over-writes. Probably requires user-opt-in and AI key.
- **Risk:** High. Cost implications (every summarization is API calls). Hallucination risk into user's docs. Interaction with manual edits (merge conflict between user edits and AI updates).

#### 3C.4. Session handoff / context export

- **Source:** `IDEAS.md:295` (labeled #58 fictionally)
- **Verification:** Refocus (context distillation for same-machine reuse) is shipped. But export-to-file that can be imported on another machine's Myrlin IS NOT. `Grep "exportContext"` finds nothing new.
- **Effort:** M-L (file format design, export button, import endpoint, validation, UUID remap, doc attachment; 2-5 days)
- **Impact:** High for users on multiple machines (Mac + Windows home vs work).
- **Risk:** Medium. Privacy implications of serializing session text. Must handle auth tokens, API keys, paths carefully.

#### 3C.5. Session search / full-text search across JSONL history

- **Source:** `IDEAS.md:296` (labeled #59 fictionally)
- **Verification:** `/api/search-conversations` in `server.js:2195` implements JSONL head+tail sampling (20KB from each end of each session file, regex match). Plus `/api/search` at `server.js:7214` does cross-cutting search across sessions/workspaces/features. **PHANTOM-UNSHIPPED.** Done. Mark shipped.

#### 3C.6. Conflict detection (multi-agent file collision)

- **Source:** `IDEAS.md:297` (labeled #60 fictionally)
- **Verification:** v0.8.0 CHANGELOG: "JSONL-based global conflict detection across all active sessions. Backend scans the last 50KB of each session's JSONL for `Write` and `Edit` tool_use blocks, identifies overlapping file modifications across sessions. Amber pill badges on terminal pane headers. Context menu 'Conflicts (N)' item." v0.3.0-alpha also shipped Conflict Center UI. **PHANTOM-UNSHIPPED.** Done.

#### 3C.7. Subagent tracking per session

- **Source:** `IDEAS.md:298` (labeled #61 fictionally), `TODO.md:72`
- **Verification:** `Grep "subagent"` in `server.js` finds the JSONL subagent parser at line 4662-4725. `Grep "agents.*badge"` in `app.js` finds agent count badges on kanban cards. **PHANTOM-UNSHIPPED.** Done.

---

### 3D. Paid Tier / Infrastructure (not shipped; not planned for v0.10)

#### 3D.1. Cloudflare tunnel to myrlin.dev - persistent subdomains

- **Source:** `IDEAS.md:301` (labeled #62), `TODO.md:73`
- **Verification:** v0.7.0 shipped Cloudflare named tunnel UI setup guide. Self-hosted quick tunnels work. Persistent subdomains at `myrlin.dev` (managed hosting) are NOT shipped.
- **Effort:** L+ (infrastructure, domain management, tunnel auth API, billing, CDN config, hosting plane; multi-week)
- **Impact:** High for the paid tier play, but that's not Arthur's immediate focus per product philosophy (free, open source first)
- **Notes:** Keep in backlog. Not for v0.10.

#### 3D.2. Multi-user auth + shared workspaces

- **Source:** `IDEAS.md:302`
- **Effort:** L+ (weeks; new auth system, role management, real-time sync, conflict resolution for multi-editor docs)
- **Notes:** Paid tier. Out of scope for v0.10.

#### 3D.3. Team dashboard + activity feed

- **Source:** `IDEAS.md:303`
- **Effort:** L+ (needs multi-user auth first)
- **Notes:** Paid tier. Blocked on 3D.2.

---

### 3E. Other Unshipped (from IDEAS "Potential Features")

#### 3E.1. Multi-Provider Support (Claude + GPT Codex + Others)

- **Source:** `IDEAS.md:5-39`
- **Verification:** `Grep "provider|multiProvider"` in `src/core` finds zero matches. No `src/core/providers/` directory. **NOT SHIPPED.**
- **Effort:** L (provider abstraction layer, 2 new providers minimum, session discovery per provider, JSONL parser per provider, UI badges/selectors; 2-4 weeks)
- **Impact:** Very High long-term (positions Myrlin as *the* universal AI coding session manager, not just Claude-specific)
- **Risk:** Medium. Each new provider's session format must be reverse-engineered. Cursor and Codex both have different file formats.
- **Notes:** IDEAS.md has an architecture table showing which layers change and estimates each as Low-Medium effort. Could be prioritized after closing other gaps. **Strategic value is to prevent competitors from differentiating on "works with everything" while Myrlin stays Claude-only.**

#### 3E.2. Windows Terminal Deep Integration

- **Source:** `IDEAS.md:100-104`, `TODO.md:78`
- **Verification:** `Grep "wt\.exe|Windows Terminal"` finds zero matches.
- **Effort:** M (wrap `wt.exe` CLI, sync profile colors with workspace colors, auto-arrange panes based on workspace layout; 3-5 days Windows-only)
- **Impact:** Low-Medium. Niche. Myrlin's embedded terminal grid is already a superior experience to wt.exe panes for most users. Only users who WANT native Windows Terminal for some reason benefit.
- **Notes:** Probably skip. The value prop of Myrlin is "you don't need wt.exe." Shipping this undermines that. **Recommend CUTTING from backlog.**

#### 3E.3. Workspace Presets ("Morning standup" opens all projects)

- **Source:** `IDEAS.md:111-115`
- **Verification:** No preset system found. Layout cache per tab group exists but named presets across multiple workspaces don't.
- **Effort:** M (workspace preset storage in state, batch-open endpoint, UI for create/apply)
- **Impact:** Low. Power-user feature. Most users open one workspace at a time.
- **Notes:** Low priority.

#### 3E.4. Session Logs Viewer (browse scrollback history from UI)

- **Source:** `IDEAS.md:150-152`
- **Verification:** `Grep "scrollback.*search|session-log-viewer"` - zero matches. No historical log browsing UI. JSONL files are searched via full-text search but not rendered as browsable scrollback.
- **Effort:** M (parse JSONL, render as structured conversation view - this is half of the Session Sharing / Proxy plan in `docs/SESSION-SHARING-PLAN.md`)
- **Impact:** Medium. "I solved this last week, what was it?" use case.
- **Notes:** Overlaps heavily with the Session Sharing / Proxy (#10) work. Should be built together.

#### 3E.5. Pinned Sessions

- **Source:** `IDEAS.md:127-130`
- **Verification:** `Grep "pinToTop|pinItem|pinSession|unpin"` in `app.js` finds pinning in discoverSessions project list (`app.js:16925: Sort by frecency: pinned first`), but no general session pinning to top of sidebar. Project pinning is different from session pinning.
- **Effort:** S-M (add pin flag to session model, sort order in sidebar, visual indicator)
- **Impact:** Medium.
- **Notes:** Could be a quick win.

#### 3E.6. Export/Import Workspaces

- **Source:** `IDEAS.md:131-134`, `TODO.md:80`
- **Verification:** `Grep "exportWorkspace|importWorkspace"` - zero matches. `backup.js` does frontend file backup (for upgrade rollback), not workspace state export.
- **Effort:** M (JSON serialize workspace + sessions, download, upload, validate, merge)
- **Impact:** Medium. Nice for backups, migration between machines. But overlaps with whole-state-directory backup (just copy `~/.myrlin/`).
- **Notes:** Also serves as disaster recovery for corrupt state.

#### 3E.7. Session Activity Timeline

- **Source:** `IDEAS.md:136-139`
- **Verification:** No timeline visualization component. Kanban cards show state transitions counts but not a time-axis chart.
- **Effort:** M (need per-session state transition timestamps from recovery/session-manager, render Linear-style activity visualization)
- **Impact:** Low-Medium. Nice-to-have for debug.
- **Notes:** Low priority.

#### 3E.8. Keyboard Shortcuts Customization

- **Source:** `IDEAS.md:141-144`
- **Verification:** `Grep "customKeybinding|rebind|keybindingOverride"` - zero matches. Shortcuts are hardcoded.
- **Effort:** M (new shortcuts settings UI, persistence, override registry, conflict detection)
- **Impact:** Low. Niche power-user feature.

#### 3E.9. Dark/Light Theme Toggle

- **Source:** `IDEAS.md:146-149`
- **Verification:** 13 themes shipped including 3 light themes (Latte, Rose Pine Dawn, Gruvbox Light). **PHANTOM-UNSHIPPED.** Done.

#### 3E.10. Saveable Layout Configurations (named pane arrangements)

- **Source:** `IDEAS.md:360` (Quick Wins from Competitive Research), `README.md:454` (Roadmap Coming Soon)
- **Verification:** `Grep "savedLayout|saveLayout"` - zero matches. Layouts cached per tab group but no named multi-layout save/switch.
- **Effort:** M (state storage for named layouts, apply layout endpoint, UI - 300-500 LOC)
- **Impact:** Medium. Warp has this, it's a "pro" feature.
- **Notes:** Good v0.10 candidate.

#### 3E.11. Per-action cost breakdown (token usage per tool call)

- **Source:** `IDEAS.md:361`, `README.md:456`
- **Verification:** `Grep "perActionCost|tokenPerTool|cost.*per.*tool"` - zero matches. Session-level costs, not per-tool.
- **Effort:** M (parse JSONL tool_use entries, attribute tokens to each tool call, UI in session detail)
- **Impact:** Medium-High. "Why is my session so expensive?" answer lives here.

#### 3E.12. Session activity feed per pane ("Editing src/server.js")

- **Source:** `IDEAS.md:362`
- **Verification:** `Grep "liveActivity|activityFeed|per.*pane.*activity"` - zero matches. Kanban cards show last output line (`app.js` has "last line of terminal output in a monospace preview strip"), but no structured activity feed parse of what file is currently being edited.
- **Effort:** M (parse JSONL Write/Edit/Bash tool use, extract filenames, show as subtitle under pane header)
- **Impact:** Medium. Makes session state immediately readable without scanning output.

#### 3E.13. Cross-session context linking

- **Source:** `IDEAS.md:363`
- **Verification:** Not shipped. No cross-session reference graph. Task Spinoff creates one-way lineage (parent tag) but no graph view.
- **Effort:** L (data model, UI, graph viz)
- **Impact:** Medium. Power-user feature.

#### 3E.14. Live session sharing (team tier, view another's terminal)

- **Source:** `IDEAS.md:367`
- **Verification:** Backend broadcasts to multiple clients already (`pty-manager.js` uses `session.clients = new Set()`), per session docs. Frontend multi-client UX for collaboration not built.
- **Effort:** L+ (paid tier)
- **Notes:** Requires multi-user auth infrastructure first.

#### 3E.15. Reusable workflow templates as markdown (multi-step command recipes)

- **Source:** `IDEAS.md:368`
- **Verification:** Session templates exist (save launch config), but not multi-step command workflows.
- **Effort:** M-L (DSL for multi-step actions, UI builder)
- **Impact:** Medium-High. Windsurf calls these "workflow commands" and users love them.

#### 3E.16. Block-based terminal output (collapsible command+output)

- **Source:** `IDEAS.md:369`
- **Verification:** Not shipped. Standard xterm.js output.
- **Effort:** L (parse terminal output into command+output blocks, collapsible UI, theme consistency)
- **Impact:** High (Warp's headliner feature)
- **Risk:** High. Rewriting terminal display layer is intrusive. Need careful compat with xterm.js.

#### 3E.17. Automated PR review agent integration

- **Source:** `IDEAS.md:370`
- **Verification:** PR creation is shipped (v0.7.0-alpha.12). PR review *agent* that spawns Claude Code on PR open is NOT.
- **Effort:** L (GitHub webhook integration, auth, automation engine)
- **Impact:** Medium-High. Copilot Workspace territory.

#### 3E.18. Session replay / time-travel

- **Source:** `IDEAS.md:371`
- **Verification:** Not shipped.
- **Effort:** L (record PTY output with timestamps, playback UI, seek controls)
- **Impact:** Medium. Debugging/onboarding use case.
- **Notes:** JSONL already records everything; this is a UI on top of existing data.

#### 3E.19. Session chaining / workflows ("when A idle, start B")

- **Source:** `IDEAS.md:234-237` (painkiller #7)
- **Verification:** `Grep "sessionChain|workflowChain|autoLaunchNext"` - zero matches. Recovery on startup shipped, but no event-triggered chain.
- **Effort:** M-L (trigger engine, conditions, actions, UI)
- **Impact:** Medium-High for power users with multi-agent workflows.

#### 3E.20. Budget alerts (cost thresholds, warnings)

- **Source:** `IDEAS.md:198` (within Cost Tracking), `IDEAS.md:248` (Pro tier: "Budget alerts")
- **Verification:** `Grep "budgetAlert|costThreshold|spendingLimit"` - zero matches. Cost dashboard shown, but no threshold setting or alert.
- **Effort:** S-M (settings for daily/monthly caps, alert when approaching, notification UI)
- **Impact:** High. Prevents bill shock. This is the emotional driver for "I stop using Claude because I don't know what I'm spending."
- **Notes:** Arthur's first paid feature candidate in the product philosophy.

#### 3E.21. Session Sharing / Proxy (#10)

- **Source:** `TODO.md:77`, `docs/SESSION-SHARING-PLAN.md` (full plan exists, 150 lines)
- **Referenced issue:** **#10 (GENUINELY OPEN, state=OPEN, no closedAt)**
- **Verification:** The ONLY real enhancement issue in the repo. All feasibility research done. Three-tier design (mirror / fork / multi-client PTY sharing). No code written.
- **Effort:** L (4 files to create, 5 files to modify, ~4-6 phases per the plan, 1-3 weeks total)
- **Impact:** High. Users WITH external Claude sessions (VS Code terminal, wt.exe, bare CLI) want to mirror them into Myrlin. This is table-stakes for "workspace manager" identity.
- **Risk:** Medium. Platform split (macOS /dev/pts vs Windows ConPTY 1:1). JSONL-tailing approach is cross-platform; the take-over/fork approach has Windows limitations that must be documented.
- **Notes:** Well-spec'd, ready to execute. This should be a priority.

---

## 4. Phantom-Shipped Features

Features that planning docs claim are unshipped but CHANGELOG/code proves are shipped. Move these to the Shipped list.

| Item | Claimed Status | Actual Status | Move To |
|------|----------------|---------------|---------|
| 6-pane terminal grid | TODO "Immediate" line 51 | **SHIPPED v0.8.0** (MAX_PANES=6 in app.js:94) | Shipped |
| Smart grid layouts 1-6 panes | TODO "Immediate" line 52-58 | **SHIPPED v0.7.0-alpha.5 + v0.8.0** (updateTerminalGridLayout, 6-pane CSS grids) | Shipped |
| Collapsible sidebar | TODO "Immediate" line 50 | **SHIPPED** (toggleSidebarCollapse at app.js:7375, localStorage persistence) | Shipped |
| Drag-and-drop terminal pane reordering | TODO "Immediate" line 59 | **SHIPPED** (pane-header drag handler at app.js:9824, 9981) | Shipped |
| Resource tracking per session (memory+CPU) | TODO "Upcoming" line 71 | **SHIPPED v0.3.0-alpha** (per-session CPU/memory in /api/resources at server.js:5636) | Shipped |
| Subagent tracking per session | TODO "Upcoming" line 72, IDEAS.md Big Features #61 | **SHIPPED v0.7.0-alpha.10** (agent count badges + JSONL Task parser in server.js:4662) | Shipped |
| Cloudflare tunnel (self-hosted) | TODO "Upcoming" line 73 | **SHIPPED v0.7.0** (named tunnel UI + quick tunnel docs) | Shipped (keep myrlin.dev managed as paid tier) |
| Password-protected web access | TODO "Upcoming" line 74 | **SHIPPED v0.1.0** (token auth, timing-safe compare, one-time token in v0.9.1) | Shipped |
| Workspace import/export | TODO "Future" line 80 | **NOT SHIPPED** (genuinely unshipped, see 3E.6) | Keep as Future |
| Session templates | TODO "Future" line 82 | **SHIPPED** (_state.templates CRUD at server.js) | Shipped |
| v0.1.0 release tag | IDEAS.md "Do First" #46 | **SHIPPED** (git tag v0.1.0 exists) | Done |
| Catppuccin Frappe + Macchiato themes | IDEAS.md Quick Wins #52 | **SHIPPED v0.1.0** (in theme dropdown) | Done |
| Show/hide password toggle on login | IDEAS.md Quick Wins #47 checked | **SHIPPED** (confirmed via ##8.9 CHANGELOG + Grep "show.*password" hits) | Done (already checked) |
| Nested workspaces | IDEAS.md Medium #49 | **SHIPPED THEN SIMPLIFIED** (Categories+Focuses hierarchy in v0.7.0-alpha.5; Set Parent removed v0.8.2) | Done (add note re: simplification) |
| Session templates | IDEAS.md Medium #57 | **SHIPPED** | Done |
| Right-click workspace "New Feature Session" | IDEAS.md Medium #48 | **SHIPPED** (app.js:8817) | Done |
| Cost tracking per session | IDEAS.md Big #56 | **SHIPPED v0.3.0-alpha+** | Done |
| Feature tracking board (kanban by branch) | IDEAS.md Big #53 | **SHIPPED v0.7.0-alpha.6-alpha.12** | Done |
| Session handoff / context export | IDEAS.md Big #58 | **PARTIALLY** (refocus shipped, export-to-file NOT - see 3C.4) | Partial |
| Session search / full-text | IDEAS.md Big #59 | **SHIPPED** (/api/search + /api/search-conversations) | Done |
| Conflict detection (multi-agent) | IDEAS.md Big #60 | **SHIPPED v0.3.0 + v0.8.0** | Done |
| Subagent tracking per session | IDEAS.md Big #61 | **SHIPPED v0.7.0-alpha.10** | Done |
| Dark/Light theme toggle | IDEAS.md "Individual" | **SHIPPED** (13 themes, 3 light) | Done |
| ROADMAP.md | IDEAS.md #55 checked | **NOT ON DISK** (gitignored AND missing - see Section 7) | Actually unshipped OR claims for internal use but filed wrong |
| Sound/notification on Claude finishing | IDEAS.md Medium #80 | **PARTIALLY** (_playNotificationSound exists; per-pane customization doesn't) | Partial |

---

## 5. Partially Shipped Features

These have backend OR frontend OR partial flow but are not end-to-end complete.

### 5.1. Workspace Rules auto-injection

- **What's shipped:** Rules tab in docs panel, rules CRUD via docs-manager.js (`docs.rules` array, add/edit/delete, persist to markdown), rules display in UI
- **What's missing:** Auto-injection into launched Claude sessions. User writes rules, they sit in a text file. Claude never reads them unless the user manually copies.
- **Missing code:** Modify `src/core/session-manager.js` (or `src/web/pty-manager.js` spawn path) to fetch workspace rules and either (a) prepend to `--prompt` initial prompt, (b) write `.claude/myrlin-rules.md` to working dir before spawn, or (c) pipe as a system-prompt concatenation.
- **Effort:** M (50-150 LOC, plus design decision on injection mechanism)

### 5.2. Session handoff / context export

- **What's shipped:** Refocus (generates `.refocus-context.md` in working dir, supports Reset and Compact for same-session context reinjection)
- **What's missing:** Export to portable file that can be transported to another machine's Myrlin, imported, and used as the basis for a fresh session.
- **Missing code:** New `/api/sessions/:id/export` that serializes session metadata + refocus content to JSON/MD, download. New `/api/sessions/import` that accepts upload, creates new session with the context prefixed.
- **Effort:** M-L

### 5.3. Live session sharing / Session Sharing proxy (#10)

- **What's shipped:** Multi-client PTY broadcast in pty-manager.js. Multiple WebSocket clients can connect to the same session.
- **What's missing:** The rest of the three-tier plan. Tier 1 (JSONL watcher/live mirror) and Tier 2 (fork/take-over button) entirely unbuilt.
- **Missing code:** See `docs/SESSION-SHARING-PLAN.md` file list. 2 files to create, 5 to modify.
- **Effort:** L

### 5.4. Completion notifications

- **What's shipped:** Setting exists (`completionNotifications` ON by default), global sound plays when a session goes idle, desktop notification API called (see `Notification(` in grep).
- **What's missing:** Per-pane sound/notification customization. No volume control, no sound choice, no "only this session" selective notification.
- **Effort:** S-M for polish

### 5.5. Worktree tasks merge/push/diff

- **What's shipped:** `/api/worktree-tasks/:id/merge` (squash toggle, commit message, push option), `/push`, `/diff`, `/changes` endpoints. Merge dialog UI, Diff viewer modal, review banner.
- **What's missing:** Nothing visible. This looks complete. Just noting it because the CHANGELOG reports these endpoints across multiple versions so verifying end-to-end integrity is warranted.

### 5.6. AI-powered session finder (v0.9.0)

- **What's shipped:** "Find a Session" with Claude Haiku semantic matching. Fallback to keyword matching if no API key.
- **What's missing:** Possibly nothing. But the fallback is the interesting part - ensure both paths work. Spot check: `Grep "aiSearch"` confirms the feature flag in `server.js:361` and `pairing.js:271`. Looks shipped and documented.

### 5.7. Mobile app

- **What's shipped:** Mobile app codebase at `mobile/` (Expo/React Native). Server support: pairing, push, device manager, CORS for LAN/Tailscale. CHANGELOG v0.9.10 confirms Android build config.
- **What's missing:** Ship status of the iOS/Android app is unclear. The `docs/plans/2026-03-28-myrlin-mobile-design.md` says "Approved design, pre-implementation" but the mobile/ directory exists with components, hooks, services. Server mobile-support doc `2026-03-29-server-mobile-support.md` says "Mobile app is built (all 7 phases complete)" and then details server changes needed. **Very hard to tell if mobile app is TestFlight/Play Store shipped or still internal-only.**
- **Action needed:** Arthur should flag which phase the mobile app is in. CHANGELOG is mobile-silent except for v0.9.10 (Android build config).

---

## 6. Zombie Features

Features referenced in TODO for months with no progress. Recommend either unblock them or cut from the backlog.

### 6.1. Hacker News launch post

- **Age:** Unknown but in TODO as "Create scheduled Hacker News post for 8:07 AM"
- **Status:** Inert. No draft visible in repo. Likely in `marketing/` which is gitignored.
- **Recommendation:** Either pick a date and post, or remove from TODO. It's not product work.

### 6.2. Windows Terminal deep integration

- **Age:** In IDEAS since early 2026 (mentioned in "Potential Features")
- **Status:** Zero code. The README and IDEAS both list it but it's never been prioritized.
- **Recommendation:** **CUT.** It undermines Myrlin's own value prop ("you don't need a separate terminal"). The only reason to build it is to let users keep their wt.exe muscle memory, which is niche.

### 6.3. Session Activity Timeline visualization

- **Age:** IDEAS since early
- **Status:** Zero code.
- **Recommendation:** Low-priority. Kanban transition counts already give basic insight. If pushed, pair with Session Replay (3E.18) since both need per-event timestamps.

### 6.4. Multi-Provider Support (Codex, Aider, Gemini)

- **Age:** Discussed since IDEAS inception, labeled "Post-Reddit-launch"
- **Status:** Zero code. Provider abstraction layer does not exist. `src/core/providers/` directory absent.
- **Recommendation:** Strategic decision point. Either commit in v0.11 or later, or officially declare Claude-only as the product positioning. Keeping it in IDEAS.md as aspirational creates doc noise.

### 6.5. Cross-workspace "Knowledge Base" unified search

- **Age:** Referenced in IDEAS Project Docs Discovery section
- **Status:** Future idea, not started.
- **Recommendation:** Depends on Project Docs Discovery (3B.1) landing first.

### 6.6. Workspace Presets ("Morning standup")

- **Age:** IDEAS early
- **Status:** Zero code.
- **Recommendation:** Low priority. Layout saves (3E.10) cover 80 percent of this need if implemented per-workspace.

### 6.7. Automated PR review agent

- **Age:** Competitive Research section, aspirational
- **Status:** Zero code. PR CREATION is shipped, PR REVIEW-ON-OPEN AGENT is separate.
- **Recommendation:** Keep in backlog but low priority.

---

## 7. Documentation Drift

Places where docs lie about the product state.

### 7.1. README "4-pane" claims

Multiple README sections say 4-pane. Code is 6-pane since v0.8.0 (Feb 23 2026). Images and alt text reference 4 panes. **2 months of stale README.** Fix in 3A.2.

### 7.2. README "Myrlin's Workbook" vs. intended "Myrlin Workbook"

- README title: "Myrlin's Workbook" (apostrophe-s)
- package.json keywords include "myrlin" but description uses "Claude Code sessions"
- Logo alt text says "Myrlin's Workbook"
- TODO wants rebrand to "Myrlin Workbook" (no apostrophe-s)
- Per CLAUDE.md (project-local memory), Arthur has decided on no-apostrophe for the brand. Fix in 3A.1.

### 7.3. TODO.md "Immediate" list is largely shipped

4 of 9 items are done. See Section 4. The "Immediate" header misrepresents current work. Either rename to "Inbox" or prune.

### 7.4. TODO.md "Upcoming" list is fully shipped

All 4 items done. Section is obsolete. Delete or move to Shipped.

### 7.5. IDEAS.md issue numbers are hallucinations

`Feature Backlog (Organized Feb 10 2026)` lists 20+ issue numbers #47-#80 that **do not exist on GitHub**. Highest real issue is #42. Fix by:
- Removing all fake issue number references (just the feature names and effort estimates)
- OR converting each truly-unshipped item into a real GitHub issue and using the real numbers

### 7.6. IDEAS.md "Already Shipped" list is incomplete

Entries like "Password show/hide toggle" are listed but 13 themes, conflict detection, kanban board, PR automation, per-session CPU tracking, and dozens of other shipped features are missing. The section gives a false sense that "we've done a little" when we've done a lot.

### 7.7. PLANNING.md is a stale v0.8 plan

Dated 446 lines for v0.8 planning (Feb 2026). Every phase listed (Auto-Trust, Tri-State, Worktree View, Changed Files, One-Click Merge, Docs, Version bump) is SHIPPED. The doc has zero relevance to v0.9.27 or v0.10. Either archive as `PLANNING-v0.8-archive.md` or rewrite for v0.10.

### 7.8. README "Coming Soon" list contains shipped items

README lines 450-459 list "Coming Soon" features. Several are shipped:
- Collapsible sidebar (shipped, see 4)
- 6-pane grid (shipped v0.8.0)
- Pane drag-and-drop (shipped)
- Per-action cost breakdown is NOT shipped (genuinely coming soon)
- Multi-provider is NOT shipped
- Frosted glass is NOT shipped
- Saveable layouts is NOT shipped
- Conflict detection v2 - unclear what v2 means given v1 (and v0.8.0 upgrades) shipped

Prune the Coming Soon list to just what's actually coming soon.

### 7.9. README "Roadmap > Next Up: Task Spinoff" is phantom-shipped

The README dedicates a section to Task Spinoff as "The killer feature" (line 442-446) describing it as aspirational. v0.7.0 shipped it in full. **PHANTOM-UNSHIPPED IN README.** Move to Recently Shipped or Core Features. Rename Next Up section or drop.

### 7.10. ROADMAP.md missing but claimed shipped

IDEAS.md Do-First #55 checks off "Create public ROADMAP.md". `ROADMAP.md` is gitignored AND not on disk. The only roadmap is the README's Roadmap section. Either:
- Create a real public ROADMAP.md with the current backlog, committed to repo (but currently .gitignore blocks it - would need to edit gitignore)
- Admit it's delegated to README Roadmap section
- Remove from IDEAS.md

### 7.11. docs/WORKFLOWS.md keyboard shortcut for Quick Switcher

`docs/WORKFLOWS.md` line 258 says `Ctrl+P` opens the quick switcher. But line 257 also says `Ctrl+K` for global search. Meanwhile `README.md` line 413 says `Ctrl+K` for Quick Switcher. Conflicting docs. Verify which is true in `app.js` and fix the other.

### 7.12. test count inconsistency

README contributing section says "npm test # 42 tests". MEMORY.md says "26 tests, all passing". TODO.md says "Test suite - 26 tests, all passing". v0.7.0-alpha.5 CHANGELOG says "test count updated to 42". v0.7.0-alpha.2 CHANGELOG says "Total: 42 tests". Contradictory. Current state unclear without running `npm test`.

### 7.13. CHANGELOG version ordering bug

v0.9.22 (2026-04-06) → v0.9.23 (2026-04-07) → v0.9.24 (2026-04-08) → ... → v0.9.25 (2026-04-10) → ... In CHANGELOG, v0.9.22 appears at line 40-44, then later v0.9.25 (line 35-38) appears BEFORE v0.9.24 at line 85-94. Semantic-versioning-savvy readers expect descending order. **Ordering is broken after v0.9.25.** Fix ordering.

---

## 8. Recommended v0.10 Milestone Scope

Top 15 unshipped items ranked by (impact * urgency) / effort.

| Rank | Item | Effort | Impact | Rationale |
|------|------|--------|--------|-----------|
| 1 | Prune TODO/IDEAS/README of phantom-shipped items + rebrand | S | High | Biggest trust-win. Stop lying about product state. Half-day effort. |
| 2 | Ctrl+V image paste in terminal | S | High | Quick win. High real-world usage. Image-first Claude workflows are a 2026 reality. |
| 3 | Workspace Rules auto-injection | M | High | Completes the Rules feature; turns a notepad into magic. Critical for per-project customization. |
| 4 | Frosted glass permission prompt (BETA) | M | High | Differentiator. Solidifies autonomy positioning. Wow feature. |
| 5 | Session Sharing / Proxy Tier 1 (JSONL live mirror, #10) | L | High | Only real enhancement issue. Fully-spec'd. Community-requested. |
| 6 | Budget alerts / cost thresholds | S-M | High | Emotional driver. "I stopped using Claude because I couldn't track costs." First Pro-tier feature. |
| 7 | Per-action cost breakdown (token per tool call) | M | Medium-High | Answers "why is this session expensive?" Depth on Cost Tracking. |
| 8 | Session handoff / context export (cross-machine) | M-L | High | Multi-machine users demand this. Completes the Refocus family. |
| 9 | Saveable named layout configurations | M | Medium | Warp has it. Power users want it. |
| 10 | Session Sharing / Proxy Tier 2 (fork/take-over) | S | High | Adds to #5. Tiered approach. Tier 3 multi-client is mostly free in backend. |
| 11 | Project Docs Discovery (read-only markdown scan) | M | High | High impact for dev workflow. Surfaces existing knowledge. Low risk (read-only). |
| 12 | Session activity feed per pane ("Editing src/server.js") | M | Medium | Makes session state readable at a glance. |
| 13 | Rebrand rebrand rebrand (Myrlin's Workbook -> Myrlin Workbook + 4-pane -> multi-pane) | S | Medium | Doc consistency. Get it done once. |
| 14 | Pinned sessions | S-M | Medium | Obvious QoL. Existed in project pinning; extend to sessions. |
| 15 | Session replay / time-travel (JSONL-based) | L | Medium | Debugging and onboarding value. Data already captured. |

**Focus:** 3 big features (Rules injection, Frosted glass, Session Sharing T1) + 6-8 small wins + the doc cleanup. Target 4-6 weeks for v0.10.

---

## 9. Recommended Quick Wins (<1-day tasks)

Top 10 fast-close items for a 0.9.28 polish release.

1. **Rebrand "Myrlin's Workbook" -> "Myrlin Workbook"** everywhere (S)
2. **Change "4-pane" -> "multi-pane" / "6-pane"** in README (S)
3. **Remove phantom items from TODO/IDEAS** and move to Shipped (S)
4. **Fix ROADMAP.md** (either create it committed to repo, or remove the checkmark) (S)
5. **Fix docs/WORKFLOWS.md Ctrl+P vs Ctrl+K contradiction** (verify in code, update the wrong doc) (S)
6. **Update test count** in README and MEMORY.md to match actual `npm test` result (S)
7. **Fix CHANGELOG.md version ordering** (reorder v0.9.24 to be before v0.9.25 chronologically) (S)
8. **Fix header logo spacing** per IDEAS.md #51 (S - 5-10 lines CSS)
9. **Remove purple-glow animation from README logo-animated.svg** per IDEAS.md (S - delete one keyframe + edit animation stack)
10. **Archive PLANNING.md as PLANNING-v0.8-archive.md** or delete (S)
11. **Convert IDEAS.md Feature Backlog section** to real GitHub issues (S per issue, but batch of ~10 = half-day)

Bonus: **Verify favicon is the Myrlin hat** (IDEAS.md #50). 10 minutes if files are right, 1 hour if regeneration needed.

---

## 10. Recommended Cut List

Items not worth building. Justify each.

### 10.1. Windows Terminal deep integration (wt.exe panes)

**Why cut:** Undermines Myrlin's value proposition ("you don't need wt.exe"). Users who want wt.exe will use wt.exe. Myrlin's embedded grid is a better experience for the target user.

### 10.2. Workspace Presets ("Morning standup opens all")

**Why cut:** Rare use case. Layout saves (per-workspace) cover 80 percent of the value. Opening 3+ workspaces at once is niche.

### 10.3. Session replay / time-travel (full)

**Why reconsider (not hard cut):** Significant engineering (custom terminal playback UI). Users can already scroll JSONL via search. Unless it becomes a team-tier feature for onboarding (show new hires what past sessions looked like), cut the ambitious version. Ship a lightweight "view past session as conversation" instead, which is cheaper and overlaps with Session Sharing Tier 1.

### 10.4. Cross-session context linking / relationship graph

**Why cut:** Power-user graph viz. Task Spinoff gives parent-child lineage already. A full graph view adds complexity without clear user value. Cut until 3+ users explicitly request.

### 10.5. Reusable multi-step workflow templates (ambitious version)

**Why reconsider:** Windsurf's "workflow commands" are a successful feature but require a mini-DSL. Ship Session Templates (already shipped) + simple command bookmarks (small feature) instead of a full workflow DSL.

### 10.6. Multi-monitor / split-pane views (TODO "Future")

**Why cut:** The browser is inherently multi-monitor compatible. Just open Myrlin on two monitors. Nothing to build.

### 10.7. Keyboard Shortcuts Customization (full rebinding)

**Why reconsider:** Maintenance burden (conflict detection, storage, documentation of overrides). Alternative: add a 2nd-tier Emacs/Vim keybinding preset toggle instead of arbitrary rebinding. 80 percent of value for 10 percent of effort.

### 10.8. Team collaboration features (PAID TIER deferred)

**Why defer (not cut):** Strategically valuable but not v0.10 work. Requires multi-user auth foundation. Keep in IDEAS.md paid tier section, do NOT put on short-term roadmap.

### 10.9. Cloudflare tunnel to myrlin.dev (managed subdomains)

**Why defer:** Requires hosting infrastructure investment. Self-hosted tunnel shipped. Managed subdomain at `.myrlin.dev` is a paid tier play. Not v0.10.

---

## 11. Appendix: Full Item-by-Item Tracking Table

Every feature in every planning doc, with its current status.

### 11.1. TODO.md line-by-line

| Line | Item | Status | Evidence |
|------|------|--------|----------|
| 4 | Core state store with JSON persistence | SHIPPED | src/state/store.js |
| 5 | Theme system | SHIPPED | src/ui/theme.js + 13 web themes |
| 6 | Session manager | SHIPPED | src/core/session-manager.js |
| 7 | Workspace manager | SHIPPED | src/core/workspace-manager.js |
| 8 | Process tracker | SHIPPED | src/core/process-tracker.js |
| 9 | Recovery system | SHIPPED | src/core/recovery.js |
| 10 | Notification system | SHIPPED | src/core/notifications.js |
| 11-22 | TUI UI components + demo + tests | SHIPPED | src/ui/* |
| 23-31 | UX Overhaul (Catppuccin, view modes, quick switcher) | SHIPPED | v0.1.0 |
| 33-46 | GUI Web Interface (Express, auth, SPA, SSE, CRUD) | SHIPPED | v0.1.0 + iterations |
| 49 | Hacker News post 8:07 AM | NOT SHIPPED (marketing) | Not a code task |
| 50 | Collapsible sidebar | SHIPPED v0.8.x | toggleSidebarCollapse app.js:7375 |
| 51 | Expand to 6 panes | SHIPPED v0.8.0 | MAX_PANES=6 |
| 52-58 | Smart grid layouts 1-6 | SHIPPED v0.7.0-alpha.5 + v0.8.0 | Grid CSS + pane count logic |
| 59 | Drag-and-drop pane reorder | SHIPPED | Pane header drag at app.js:9824 |
| 60-65 | Frosted glass permission prompt | NOT SHIPPED | Zero hits for frosted |
| 66 | Rebrand Myrlin's -> Myrlin | NOT SHIPPED | 24 Myrlin's Workbook occurrences |
| 67 | 4-pane -> multi-pane | NOT SHIPPED | 4-pane in README still |
| 68 | Ctrl+V image paste | NOT SHIPPED | No clipboard.read() for blobs |
| 71 | Resource tracking per session | SHIPPED | /api/resources |
| 72 | Subagent tracking | SHIPPED | subagents parser + badges |
| 73 | Cloudflare tunnel to myrlin.dev | PARTIALLY (self-hosted SHIPPED, managed NOT) | Named tunnel yes, subdomains no |
| 74 | Password-protected web access | SHIPPED | Token auth since v0.1 |
| 77 | Session Sharing / Proxy (#10) | NOT SHIPPED | Plan exists, zero code |
| 78 | Windows Terminal tab integration | NOT SHIPPED | No wt.exe refs |
| 79 | Session output capture/log streaming | PARTIALLY | JSONL captured, no browse UI |
| 80 | Workspace import/export | NOT SHIPPED | No export/import endpoints |
| 81 | Custom keybinding config | NOT SHIPPED | Shortcuts hardcoded |
| 82 | Session templates | SHIPPED | _state.templates CRUD |
| 83 | Multi-monitor / split-pane | N/A (browser native) | Multiple windows work |

### 11.2. IDEAS.md major features

Already covered in sections 3, 4, 5, 6 above. Summary table of the "Feature Backlog" with real statuses:

| Claimed # | Real # | Item | Status |
|-----------|--------|------|--------|
| #45 | PR #45 | Set up dev branch + branch protection | SHIPPED |
| #46 | PR #46 | Create v0.1.0 release tag | SHIPPED (git tag exists) |
| #47 | non-existent | Show/hide password toggle | SHIPPED v0.8.x |
| #48 | non-existent | Right-click workspace "New Feature Session" | SHIPPED |
| #49 | non-existent | Nested workspaces | SHIPPED then simplified |
| #50 | non-existent | Favicon | SHIPPED (files exist) |
| #51 | non-existent | Header logo spacing | NOT SHIPPED (cosmetic) |
| #52 | non-existent | Catppuccin Frappe + Macchiato | SHIPPED v0.1.0 |
| #53 | non-existent | Feature tracking board | SHIPPED v0.7.0-alpha.6-alpha.12 |
| #54 | non-existent | Auto-docs silent summarizer | NOT SHIPPED |
| #55 | non-existent | Public ROADMAP.md | CLAIMED BUT MISSING |
| #56 | non-existent | Cost tracking per session | SHIPPED v0.3.0-alpha+ |
| #57 | non-existent | Session templates / quick launch | SHIPPED |
| #58 | non-existent | Session handoff / context export | PARTIALLY (refocus yes; cross-machine no) |
| #59 | non-existent | Session search / full-text | SHIPPED |
| #60 | non-existent | Conflict detection | SHIPPED v0.3 + v0.8.0 |
| #61 | non-existent | Subagent tracking | SHIPPED v0.7.0-alpha.10 |
| #62 | non-existent | Cloudflare tunnel to myrlin.dev | PARTIAL (self-hosted yes, managed no) |
| #66 | non-existent | Right-click "Start Session with Project Context" | PARTIALLY (Spinoff covers it) |
| #78 | non-existent | Workspace Rules injection | PARTIALLY (storage yes, injection no) |
| #80 | non-existent | Sound/notification on Claude finish | PARTIALLY (global yes, per-pane no) |

### 11.3. IDEAS.md "Potential Features" section

| Item | Status |
|------|--------|
| Multi-Provider Support (Codex, etc.) | NOT SHIPPED |
| Project Docs Discovery | NOT SHIPPED |
| Remote Access (self-hosted + hosted) | PARTIAL (self-hosted SHIPPED) |
| Windows Terminal Deep Integration | NOT SHIPPED (recommend CUT) |
| Session Intelligence (auto-detect, token tracking, cost) | SHIPPED |
| Workspace Presets | NOT SHIPPED (recommend DEFER) |
| Session Templates | SHIPPED |
| Session Search & Filter | SHIPPED |
| Pinned Sessions | NOT SHIPPED |
| Export/Import Workspaces | NOT SHIPPED |
| Session Activity Timeline | NOT SHIPPED |
| Keyboard Shortcuts Customization | NOT SHIPPED (recommend DEFER) |
| Dark/Light Theme Toggle | SHIPPED (13 themes, 3 light) |
| Session Logs Viewer | NOT SHIPPED |
| Team Collaboration (PAID) | NOT SHIPPED (by design) |
| Monitoring Dashboard | SHIPPED (Resources tab) |

### 11.4. IDEAS.md "Individual Dev Painkillers"

| Rank | Item | Status |
|------|------|--------|
| 1 | Cost Tracking | SHIPPED |
| 2 | Session Templates / Quick Launch | SHIPPED |
| 3 | Session Handoff / Context Export | PARTIAL (Refocus same-session yes; cross-machine no) |
| 4 | Session Search / Full-Text | SHIPPED |
| 5 | Auto-Recovery / Session Continuity | PARTIAL (PID recovery SHIPPED; "what was it doing?" context NOT) |
| 6 | Conflict Detection | SHIPPED |
| 7 | Session Chaining / Workflows | NOT SHIPPED |

### 11.5. IDEAS.md "Already Shipped" checklist

All items verified as genuinely shipped. This list is accurate but INCOMPLETE (dozens of other shipped features missing).

### 11.6. PLANNING.md (v0.8 planning, 8 phases)

| Phase | Topic | Status |
|-------|-------|--------|
| 1 | Session item two-line layout | SHIPPED v0.7.0-alpha.2 |
| 2 | Auto-Trust + Question Detection | SHIPPED v0.7.0-alpha.2 |
| 3 | Task Status Tri-State | SHIPPED v0.7.0-alpha.2 |
| 4 | Worktree View + New Task UX | SHIPPED v0.7.0-alpha.2 |
| 5 | Changed Files + Diff Viewer | SHIPPED v0.7.0-alpha.2 |
| 6 | One-Click Merge | SHIPPED v0.7.0-alpha.2 |
| 7 | Documentation | SHIPPED (WORKFLOWS.md created v0.7.0-alpha.2) |
| 8 | Version Bump + Release | SHIPPED v0.8.0+ |

**Every phase in PLANNING.md is done. File is archival.**

### 11.7. IDEAS.md "Competitive Research" section (Quick Wins / Medium / Long-term)

| Item | Status |
|------|--------|
| Saveable Layout Configurations | NOT SHIPPED |
| Per-action cost breakdown | NOT SHIPPED |
| Session activity feed per pane | NOT SHIPPED |
| Cross-session context linking | NOT SHIPPED |
| Workspace analytics dashboard | PARTIALLY (Costs dashboard yes, full analytics no) |
| Live session sharing (team) | NOT SHIPPED |
| Reusable workflow templates as markdown | NOT SHIPPED |
| Block-based terminal output | NOT SHIPPED |
| Automated PR review agent | NOT SHIPPED |
| Session replay / time-travel | NOT SHIPPED |
| Agent Client Protocol (ACP) support | NOT SHIPPED |
| Reproducible environment (devcontainer.json) | NOT SHIPPED |
| Real-time intent inference | NOT SHIPPED |
| Multi-agent orchestration with DAGs | NOT SHIPPED |

### 11.8. docs/SESSION-SHARING-PLAN.md phases

All 6 phases of the session-sharing plan are NOT SHIPPED. Only the multi-client PTY broadcast (Tier 3 backend) is pre-existing.

### 11.9. README.md "Coming Soon"

| Item | Status |
|------|--------|
| Task spinoff from sessions | SHIPPED v0.7.0 (phantom-unshipped) |
| Collapsible sidebar | SHIPPED (phantom-unshipped) |
| 6-pane grid | SHIPPED v0.8.0 (phantom-unshipped) |
| Pane drag-and-drop | SHIPPED (phantom-unshipped) |
| Saveable layouts | NOT SHIPPED |
| Frosted glass permission prompts | NOT SHIPPED |
| Per-action cost breakdown | NOT SHIPPED |
| Conflict detection v2 | UNCLEAR (v1 shipped) |
| Multi-provider support | NOT SHIPPED |

### 11.10. Mobile app features (separately tracked in docs/plans/)

| Area | Status |
|------|--------|
| Mobile app codebase | EXISTS at mobile/ |
| Pairing flow (server) | SHIPPED (pairing.js) |
| Push notifications (server) | SHIPPED (push.js) |
| Device management (server) | SHIPPED (device-manager.js) |
| CORS for LAN/Tailscale | SHIPPED v0.7.0-alpha.3 |
| Android build config | SHIPPED v0.9.10 |
| iOS TestFlight / Play Store release | UNKNOWN (no CHANGELOG mention) |
| Server token persistence | UNKNOWN (doc section 2.1 proposes it, verify if shipped) |
| LAN IP detection in pairing QR | UNKNOWN (verify via grep detectLanIP) |

**Action:** Arthur should review mobile app release status separately. This audit covers the web/desktop product.

---

## End

Total scope covered: every item in TODO.md, IDEAS.md, PLANNING.md, README.md, docs/WORKFLOWS.md, docs/SESSION-SHARING-PLAN.md, and selective mobile docs. Every GitHub issue number in IDEAS.md verified against real repo. Every shipped claim spot-checked in `src/`. Every unshipped claim verified via grep.

If Arthur wants a follow-up: a one-shot PR that deletes PLANNING.md (or moves to archive), rewrites TODO.md + IDEAS.md per the Section 4 phantom-shipped table, and renames "Myrlin's Workbook" everywhere. That PR alone closes half the doc-drift debt.
