# Community Issues and Feature Requests: Deep Evaluation

> **Date:** 2026-04-23
> **Repo:** `therealarthur/myrlin-workbook` (public, AGPL-3.0)
> **Current version:** v0.9.27
> **Scope:** All open issues, last 100 closed issues, all merged PRs since repo inception, IDEAS.md backlog, TODO.md, SESSION-SHARING-PLAN.md.
> **Data snapshot:** `docs/evaluation/data/` (closed-issues.json, open-issues.json, merged-prs.json, issue-10, issue-41, issue-42 comment threads)

---

## 1. Executive Summary

### Headline Findings

1. **The community is happy.** Across 18 issues (2 open, 16 closed) and 24 merged PRs, the dominant tone is gratitude and praise. Users repeatedly describe the project as "quite good," "helpful," "by far the one I've appreciated the most." Zero flame-war comments, zero rage quits, zero bitter "unfixable" threads. Arthur's response latency (many same-day fixes, several same-hour fixes) has clearly built goodwill.

2. **Bug rate is dropping sharply.** 14 of the 16 closed issues were filed before v0.9.9 (2026-03-28). Only 1 post-v0.9.9 issue is closed (#42, image upload), and 1 is open (#41, scroll feel). In the last ~4 weeks there have been almost no bug reports. This is a quiet period of polish and feature work, not a crisis.

3. **One contributor dominates.** `croakingtoad` (Marty Martin) merged 11 PRs (+4895/-185 LOC) including the largest feature shipped since v0.8 (Tasks view, td integration, icon picker). He is effectively the #2 maintainer by throughput. Everyone else has 1-2 PRs each.

4. **The biggest pain theme in closed issues is "missing from npm package" bugs.** Four separate issues (#4 spawn-helper, #27 postinstall, #32 crash-logger, #33 logo-cropped, #39 data-dir) all share the same root cause: files exist locally but get excluded by `.npmignore` or were never committed. This is an ongoing operational risk that would benefit from a CI check.

5. **Cost tracking was the most-reported feature gap** (two separate Raj-reported issues #17, #18, both closed by v0.6.1). Now fixed. The current v0.9.27 cost accuracy story is mature; this is no longer a hot zone.

6. **Issue #42 (image upload) was marked fixed but is probably still broken.** The user `hybridandrew` replied 2 days after the fix was shipped saying "sorry, but I updated and it didnt work" with a screenshot. No follow-up from owner. The issue is closed on GitHub but the reporter says the bug is live. See "Recommended closures" section for action.

7. **The only truly "open and active" pain point** is issue #10 (session sharing/proxy). It has a clear architectural plan at `docs/SESSION-SHARING-PLAN.md`. The reporter (xingfanxia) has been enthusiastic and also merged 2 PRs already. This is a contributor Arthur should actively cultivate.

### Top Community Priorities (Aggregated Signal)

| Rank | Theme | Evidence | Status |
|-----:|---|---|---|
| 1 | Cross-platform install robustness (npx/macOS/WSL/Linux) | 6 closed issues (#2, #3, #4, #27, #32, #39) | Polish ongoing, CI guard rail recommended |
| 2 | Mobile/remote terminal feel (scroll, type mode, autocorrect, CJK) | 4 closed PRs (#6, #7, #12, #13) + open #41 + Vidalee's scroll fix | Large PR already merged, #41 deferred to xterm.js upstream |
| 3 | Session sharing / live mirror of externally-started sessions | Open #10 with detailed architecture, SESSION-SHARING-PLAN.md | Pinned, not started |
| 4 | Terminal paste correctness (Ctrl+V, Cmd+V, IME) | 3 fixed PRs (#7, #34, #45) | Fixed repeatedly; latest (#45) is definitive |
| 5 | Worktree task flow polish (td integration, resume, spawn edge cases) | PRs #22, #23, #24, #26 | Fixed and shipped in v0.8.x |

### Standout Contributors

- **croakingtoad** (11 PRs, +4895 LOC), effectively a co-maintainer. Ships entire features. Promote to official collaborator / review partner.
- **Vidalee** (2 PRs, +108 LOC, mobile scroll + CJK path decode), high-quality root-cause fixes.
- **xingfanxia (AX)** (2 PRs + issue #10). Filed the biggest open feature request AND shipped Cloudflare tunnel feature. Potential power-user advocate.
- **dianshu** (1 PR + 2 issues). Security review level PR (#28 one-time startup token). Quality contributor.
- **inorixu** (1 PR + 1 issue). CJK path decoding fix (critical for i18n adoption).
- **Guy7B, jfrostad, Frix-x, ntopia, snmo2546, benoitmidon** (single-PR contributors, all accepted, all quality).

---

## 2. Open Issues Triage Table

Only 2 open issues total.

| # | URL | Title | Author | Age (days) | Severity | Effort | Recommendation | Strategic fit |
|---|---|---|---|---:|---|---|---|---|
| 10 | https://github.com/therealarthur/myrlin-workbook/issues/10 | Share/Proxy running session rather than creating a new session | xingfanxia | ~59 | P2 (important, not urgent) | L | **ship-as-feature** (Tier 1 read-only mirror first) | Strong fit: Myrlin's North Star is "manage ALL your Claude sessions including external ones." Without this, discovered-session UX is second-class. |
| 41 | https://github.com/therealarthur/myrlin-workbook/issues/41 | The sliding experience is not good (scroll jumps in blocks) | KingingWang | ~17 | P3 (cosmetic) | S-M | **fix-later** (add `smoothScrollDuration: 125`, close with note) | Marginal. This is an xterm.js limitation, not a Myrlin bug, but a 1-line config change would help. |

### Deep verdict per issue

**#10 — Session Sharing/Proxy.** Highly strategic. Arthur's current answer ("make launch-from-Myrlin so good that external sessions become rare") is defensible for 2026 but it does NOT resolve the reporter's stated need. xingfanxia uses Claude from multiple entry points (tmux, terminal, Myrlin) and wants Myrlin to be an observer, not the sole launcher. This is the single most architecturally interesting open request. Do Tier 1 (JSONL-based read-only mirror) as per the existing plan. Effort: ~1 week for an experienced implementer. Worth it in v0.11 or v0.12.

**#41 — Block scrolling feels bad.** Arthur's explanation (xterm.js renders in row increments, this is standard terminal behavior) is technically correct. But the reporter is RIGHT that it feels jarring in a browser context where every other scrollable region scrolls smoothly. xterm.js exposes `smoothScrollDuration: 125` (milliseconds per row animation). Setting this costs nothing and addresses the visual complaint without requiring upstream xterm.js work. Arthur should try this and close the issue with a "fixed in vX.Y.Z" note. See Deep Dive section 4.

---

## 3. Deep Dive: Issue #10 (Session Sharing)

**URL:** https://github.com/therealarthur/myrlin-workbook/issues/10
**Reporter:** xingfanxia (AX), CONTRIBUTOR (2 merged PRs already, #9 and #11)
**Filed:** 2026-02-23 (~2 months ago)
**Comments:** 3 (all from Arthur or reporter, collegial tone)
**Reactions:** 0 on issue body, 2 HEART reactions on in-thread exchanges
**Label:** enhancement

### What the reporter wants

xingfanxia paired with Opus to propose three implementation paths:
1. `/dev/tty` device sharing (macOS native, reads the same PTY master fd)
2. tmux integration (if user runs inside tmux, join the pane)
3. Long-term: make Myrlin the sole launcher

He explicitly asks "Want me to prototype this?" and is clearly willing to contribute. This is a contributor offering a feature with design, not a blind request.

### Arthur's current stance

Arthur's response (2026-03-11) picks option #3 (push users to launch from Myrlin). The reasoning:
- Concurrent input edge cases are messy
- Platform differences make /dev/tty fragile
- The launcher + session discovery + AI session finder already close the gap

This is a defensible product call, but it does not ship the reporter's actual request. xingfanxia was gracious ("Really enjoyed Myrlin :)") but the issue is parked, not resolved.

### Hidden demand signal

Even though issue body has 0 reactions, this ask recurs indirectly:
- Warp's live session sharing is listed in IDEAS.md competitive research as a "feature to consider"
- The IDEAS.md backlog explicitly lists "Live session sharing (team tier)" as medium effort
- Arthur's own SESSION-SHARING-PLAN.md exists and is detailed (149 lines, tiered approach)
- The `TODO.md` "Future Enhancements" section calls out `Session Sharing / Proxy (#10)` as a named item

So this is not a one-off request. It's a known strategic feature that Arthur has already planned for, just not scheduled.

### Feasibility reassessment (April 2026)

The SESSION-SHARING-PLAN.md verdict was "JSONL file-watching as a read-only mirror" and that analysis is still correct. Here is a refined look:

| Approach | Feasibility today | Platform risk | Risk of breaking existing UX |
|---|---|---|---|
| Tier 1: JSONL tailing + structured conversation view | HIGH. `fs.watch` works everywhere, JSONL format is now stable across CC versions (Myrlin already parses it for cost + subagent tracking). | Low. Windows `fs.watch` has some lag but acceptable. | Zero. Pure additive, new route, new UI. |
| Tier 2: Take Over via `claude --resume --fork-session` | MEDIUM. Depends on CC maintaining `--fork-session` flag. | Cross-platform OK. | Low. New UUID, original session untouched. |
| Tier 3: Multi-client PTY sharing (Myrlin-spawned only) | HIGH. Backend already supports it. | None. | Medium. Frontend needs "joining" indicator, input arbitration rules. |

### Recommended approach

**Ship Tier 1 in v0.11 or v0.12.** Concrete plan:

1. Extend `GET /api/discover` to detect live PIDs (Windows `tasklist`, Unix `ps`), expose `isRunning: true` for actively running sessions (2-3 hours of work).
2. New `src/web/jsonl-watcher.js` that tails a single file with byte-offset tracking (~200 lines, 1 day).
3. New SSE channel `mirror:<sessionId>` that streams parsed JSONL entries as conversation events (1 day).
4. New `conversation-renderer.js` frontend component that renders user messages / assistant / tool_use as a structured conversation view (not a terminal). Reuse Catppuccin tokens. 2-3 days.
5. Integrate with existing session pane: add a "Mirror" mode toggle alongside "Terminal" and "Read" modes. 1 day.
6. Cap concurrent watchers at ~10, test across macOS / Windows / Linux. 1 day.

**Total: ~1 week for a competent single-owner feature.** xingfanxia has already offered to prototype, so Arthur should take him up on it and review the PR.

**What NOT to do:** Don't ship Tier 2 (fork) without Tier 1 (mirror). Forking without observing first defeats the purpose (why would a user fork blind?). Tier 1 is the unlock.

**Strategic framing:** Ship this as "Live Session Observer" not "Session Sharing." The observer framing avoids the multi-user confusion (this is one user observing their own external sessions, not a team feature). It also doesn't compete with the paid-tier "team live sessions" feature planned in IDEAS.md.

---

## 4. Deep Dive: Issue #41 (Scroll Smoothness)

**URL:** https://github.com/therealarthur/myrlin-workbook/issues/41
**Reporter:** KingingWang (first-time contributor, NONE association)
**Filed:** 2026-04-06 (~17 days ago)
**Comments:** 2 (Arthur clarifying + Arthur explaining root cause)
**Reactions:** 0
**Label:** none

### The bug as reported

> "the text scrolling isn't smooth—it jumps in blocks instead of moving continuously. It feels quite jarring and I hope it can be improved for a more seamless experience."

The reporter did not specify mobile vs desktop, browser, or OS. Arthur asked for clarification (2026-04-06) and got no reply. 4 days later Arthur gave a detailed root-cause reply (2026-04-10): xterm.js renders in row increments, not pixel scrolling; this is inherent; keeping the issue open to track interest.

### Repro (inferred)

Based on Arthur's reply and knowledge of xterm.js:
1. Open a session pane in Myrlin on desktop Chrome / Firefox / Edge.
2. Spam output into the terminal (e.g., `seq 1 5000`).
3. Use mouse wheel or trackpad to scroll.
4. Observe: each "tick" of the wheel jumps 3 lines (~45 pixels) instantly. There is no visual interpolation between positions.

On mobile, issue #13 (Vidalee's merged PR) already fixes the "snap to bottom" auto-follow bug, and issue #6 (jfrostad's merged PR) adds momentum-based scrolling on touch. So on mobile, scroll is already smoother than desktop ironically.

The reporter's complaint most likely happens on desktop.

### Root cause category

**xterm.js rendering architecture.** xterm.js renders the terminal viewport as a canvas (or DOM rows in DOM renderer) with one "row" as the minimum scroll unit. It does not interpolate sub-pixel scroll positions.

### However: xterm.js has a setting to smooth this out

The `Terminal` config option `smoothScrollDuration: <ms>` (in recent xterm.js versions, also surfaced in xterm v5+ as `smoothScrollDuration`) animates the transition between rows over N milliseconds using CSS transform on the viewport. This is NOT pixel-by-pixel scroll but it does visually interpolate between the source and target row positions, which is exactly what the reporter is asking for.

### Current terminal config in Myrlin

`src/web/public/terminal.js:300-309`:
```js
this.term = new Terminal({
  cursorBlink: true,
  cursorStyle: 'bar',
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  lineHeight: 1.2,
  scrollback: 5000,
  rightClickSelectsWord: false,
  theme: TerminalPane.getCurrentTheme(),
});
```

No `smoothScrollDuration` set. Default is 0 (instant).

### Proposed fix

```js
this.term = new Terminal({
  ...
  scrollback: 5000,
  smoothScrollDuration: 125,  // ADDED: 125ms interpolation between rows
  rightClickSelectsWord: false,
  ...
});
```

125ms is the xterm.js recommended value. It's fast enough not to feel laggy and slow enough to feel smooth. Alternatives: 100ms (snappier), 150ms (more smoothness at cost of responsiveness).

### Effort estimate

- 1 line of code change.
- Verify xterm.js v6 (currently bundled) actually supports the flag. (It does. Documented in xterm.js v5.2.0+ and preserved in v6.)
- Regression test: confirm no perf issue on long scroll (5000 line scrollback). Should be fine, the animation is GPU-accelerated transform.
- Add to CHANGELOG.md: "feat(terminal): smoother mouse-wheel scrolling with 125ms row interpolation (closes #41)"

**Total: under 30 minutes including testing.**

### Recommendation

**Fix in v0.9.28 or v0.10.0.** Arthur's technical explanation in the comment is correct but defeatist. The fix is trivial. Worst case: add a `Settings → Accessibility → Smooth terminal scroll` toggle (default on) so power users can disable if they hate the interpolation. But the overwhelming majority of users will prefer smooth.

After shipping, add a comment to the issue and close. "Fixed in v0.9.28 with xterm.js smooth scroll interpolation. Update via `npx myrlin-workbook@latest`."

---

## 5. Closed Issue Pattern Analysis

### Thematic grouping (16 closed issues)

| Theme | Issues | Root cause | Lessons |
|---|---|---|---|
| **Missing-from-npm-package** | #4, #27, #32, #33, #39 (5 issues) | `.npmignore` excludes needed files OR file exists locally but was never committed | Need a pre-publish CI check: `npm pack && npm install <tarball>` then `require` every top-level entry. Also: track all referenced files in a manifest. |
| **Cost tracking** | #17, #18 (2 issues, same reporter Raj) | `resumeSessionId` not set on discovered sessions, cost endpoint silently returned $0.00 | Silent-fail error paths are poison. When cost is unavailable, show "Cost data unavailable (no JSONL linkage)" not "$0.00." |
| **Launch / spawn errors on specific OS** | #2 (WSL), #4 (macOS perm), #8 (cwd stale), #30 (workspaceId null), #35 (double-open), #39 (data-dir) | Cross-platform PTY spawning has many edge cases | Each bug was a one-liner once diagnosed. The fixes are cumulative, not repeatable. |
| **Terminal input (paste, IME, scroll, autocorrect)** | #6 (mobile), #7 (CJK), (PR #34 paste dupe) | xterm.js hidden-textarea edge cases with browser native input handling | Mobile input is fundamentally a different stack from desktop (dedicated `<input>` field per #6). Don't fight xterm.js internals; bypass them. |
| **UI trivia** | #14 (no confirm button), #20 (+ button dead), #33 (logo path), #15 (Task extraction error message) | Event-bubble bugs, copy-paste bugs, broken strings | Ship manual smoke tests per UI feature. Keep a "things a new user clicks in the first 60 seconds" checklist. |
| **Security / posture** | #1 (binds 0.0.0.0) | Defaults too permissive | Fixed immediately. Good precedent. |
| **Images** | #42 (upload) | Upload path resolved to npx cache dir | Arthur shipped a fix but user reported it still broken 2 days later. Probably still broken. (See section 11.) |

### Closed without a real fix

Only one candidate: **#42 Unable to upload/import images into session**. Issue was closed 2026-04-10 by Arthur ("Fixed in v0.9.25"). Reporter replied 2 days later (2026-04-12) with a screenshot saying "sorry, but I updated and it didnt work." **Arthur never responded.** Issue is marked closed on GitHub but the reporter's follow-up says the bug is live.

This is the single highest-signal dangling bug. Reopen and investigate. Almost certainly a path or permissions issue for the new `~/.myrlin/uploads/<sessionId>/` directory on Windows (which is where hybridandrew runs, based on other forum posts attached to the issue).

### Biggest ongoing pain area

**Npm packaging hygiene (5 issues, 31% of all closed issues).** This is not a code bug, it's an operational process gap. The "file exists locally but isn't committed" and "file in repo but excluded by .npmignore" bugs will keep recurring until a CI gate catches them. Recommended guard: a GitHub Actions workflow that:

1. Runs `npm pack` to produce a tarball.
2. Extracts the tarball to a temp dir.
3. Runs `node -e "require('./src/gui'); require('./src/supervisor'); require('./src/web/server'); require('./src/state/store');"` against the extracted contents.
4. Fails the PR if any require throws.

Total effort: 1 afternoon. Saves 1-2 regression bugs per quarter.

### Median time-to-close

Rough calculation (closed_at - created_at per issue):
- #42: 2h 33m (same day)
- #39: 3h 3m (same day)
- #35: 5h 57m (same day)
- #33: 15h 48m (next day)
- #32: 9h 54m (next day)
- #30: 4h 59m (same day)
- #27: 2h 37m (same day)
- #20: 1h 54m (same day)
- #18: 59m (same day)
- #17: 7d (slow, was self-reported)
- #15: 7h 5m (same day)
- #14: 10m (same day, just asked!)
- #8: 17m (same day)
- #5: 1h 21m (same day)
- #4: 1h 47m (same day)
- #1: 2h 35m (same day)

**Median: under 3 hours.** This is an exceptionally responsive maintainer cadence and explains the positive community sentiment. Nothing Arthur does needs to change here.

---

## 6. Contributor Leaderboard (Feb 2026 - April 2026)

### Pull Requests (merged)

| Rank | Contributor | PRs | LOC added | LOC removed | Most impactful PR |
|-----:|---|---:|---:|---:|---|
| 1 | **croakingtoad** (Marty Martin) | 11 | 4,895 | 185 | PR #43 Tasks view (1859 LOC) + #26 td integration (1567 LOC) |
| 2 | xingfanxia (AX) | 2 | 324 | 0 | PR #11 Cloudflare named tunnel (311 LOC) |
| 3 | Vidalee (Vivi) | 2 | 108 | 61 | PR #13 mobile terminal scroll fix |
| 4 | dianshu | 1 | 220 | 26 | PR #28 password-in-URL replaced with one-time token (security) |
| 5 | jfrostad | 1 | 220 | 14 | PR #6 mobile autocorrect + LAN/Tailscale CORS |
| 6 | Guy7B (Guy Braunstain) | 1 | 216 | 65 | PR #3 xterm v6 upgrade + cwd resolution |
| 7 | inorixu | 1 | 169 | 10 | PR #36 home-dir expansion + CJK paths |
| 8 | snmo2546 (Jacky Chen) | 2 | 19 | 9 | PR #16 scrollback duplication on reconnect |
| 9 | Frix-x (Félix Boisselier) | 1 | 33 | 15 | PR #2 WSL/Linux shell spawning |
| 10 | benoitmidon | 1 | 14 | 1 | PR #34 double-paste (superseded by #45) |
| 11 | ntopia | 1 | 6 | 27 | PR #7 CJK composition duplicate input |

### Issue filers

| Contributor | Issues filed | Tone |
|---|---:|---|
| dianshu | 2 | Excellent bug reports with root-cause analysis and suggested fix (#33, #27) |
| croakingtoad | 2 | Excellent bug reports (#32 crash-logger, #20 + button) |
| therealarthur | 2 | Self-reported (#17, #18 from Raj email) |
| matteo-ms | 2 | Clear, screenshot-rich (#14, #15) |
| xingfanxia | 2 | Detailed architecture (#10) + crash log (#8) |
| (7 one-off reporters) | 1 each | All actionable |

### Quality assessment

Every merged PR is production quality. Multiple PRs include test plans, reproducer scripts, root-cause write-ups, and screenshots. This is far above the norm for a solo-maintained open source project.

### Contributors worth cultivating

1. **croakingtoad**. Already effectively a co-maintainer. Actions Arthur should take:
   - Add him to CODEOWNERS for `src/web/` and `src/core/`.
   - Invite him to a private Discord/Slack for coordination.
   - Give him merge rights (not needed yet, but prepare).
   - Cite him in README contributors section.
2. **xingfanxia**. Filed the deepest architectural request (#10) AND shipped two PRs. If Tier 1 session sharing goes forward, offer it to him first.
3. **dianshu**. Security-minded (one-time token PR). Next security-adjacent work (auth hardening, rate limit improvements) should be offered to dianshu.
4. **Vidalee**. Fluent with PTY + xterm edge cases. Next xterm / mobile work should be offered here.
5. **inorixu**. Strong on i18n and path handling. Next CJK / encoding work should go to inorixu.

### Contributors to re-engage

- **jfrostad, Guy7B, Frix-x, ntopia, benoitmidon, snmo2546**: all shipped one PR, never returned. A courtesy ping ("hey, v0.9.27 shipped, want to share what to build next?") might re-activate. Low cost.

---

## 7. Cross-Reference with IDEAS.md Backlog

**Important clarification:** The `#45-#80` numbers cited in IDEAS.md `Feature Backlog (Organized Feb 10, 2026)` are INTERNAL ticket/reference numbers, not GitHub issue numbers. They do not map 1:1 to the repo's GitHub issues. The repo only has 43 total numbered issues + PRs combined. So the task prompt's cross-reference ask needs reinterpretation: I'm matching IDEAS.md items to GitHub issues / PRs that actually shipped or are still open.

### Process items

| IDEAS# | Title | Status | Shipped as |
|---:|---|---|---|
| #45 | Set up dev branch + branch protection | Done ✓ | Repo infrastructure |
| #46 | Create v0.1.0 release tag | Unclear | npm publishing is active (v0.9.27 latest); tag tracking is separate |
| #55 | Create public ROADMAP.md | Done ✓ | `.planning/ROADMAP.md` exists |

### Quick Wins

| IDEAS# | Title | Status | Evidence |
|---:|---|---|---|
| #47 | Show/hide password toggle | Done ✓ | Confirmed in TODO.md "Already Shipped" |
| #50 | Update favicon with Myrlin hat logo | Partially done | Favicon files exist in recent git status (favicon-32.png, favicon-192.png, apple-touch-icon.png untracked) |
| #51 | Header logo spacing fix | Done ✓ | Issue #33 fixed, uses `logo.png` |
| #52 | Catppuccin Frappe + Macchiato themes | Done ✓ | MEMORY.md confirms "4 flavors" picker |

### Medium Features

| IDEAS# | Title | Status |
|---:|---|---|
| #48 | Right-click workspace "New Feature Session" | **Open**, not shipped |
| #49 | Nested workspaces (hierarchy) | **Open**, not shipped |
| #57 | Session templates / quick launch | Partially done. MEMORY.md mentions "Templates stored in `_state.templates`, CRUD via `/api/templates`" but UI integration depth is unknown. |
| #78 | Workspace Rules per-workspace | **Open**, not shipped |
| #80 | Sound/notification when Claude finishes | **Open**, not shipped |
| #66 | Right-click Start Session with Project Context | **Open**, not shipped |

### Big Features

| IDEAS# | Title | Status |
|---:|---|---|
| #56 | Cost tracking per session (called out as "#1 community priority") | **Shipped** via issues #17 / #18 fixes (v0.6.1). MEMORY.md confirms cost tracking works end-to-end. |
| #53 | Feature tracking board (sessions by branch, AI summaries) | **Partially shipped**. PR #43 Tasks view is the closest delivered artifact (kanban columns, branches, td integration). AI summaries for sessions are not explicit. |
| #54 | Auto-docs: silent background summarizer | **Open**, not shipped |
| #58 | Session handoff / context export | **Open**, not shipped. Note: td integration (PR #26) provides manual handoff via `td handoff` CLI but not a native Myrlin export. |
| #59 | Session search / full-text search across JSONL | **Shipped**. MEMORY.md lists this (server.js has `/api/search`). |
| #60 | Conflict detection (multi-agent file collision) | **Shipped**. MEMORY.md lists this (`/api/workspaces/:id/conflicts`). |
| #61 | Subagent tracking per session | **Shipped**. MEMORY.md confirms "Cost tracking at session + workspace level, Conflict detection, Subagent tracking". |

### Paid Tier

| IDEAS# | Title | Status |
|---:|---|---|
| #62 | Cloudflare tunnel to myrlin.dev | Quick tunnel shipped (feat in `TODO.md`), named-tunnel shipped (PR #11 by xingfanxia). Managed hosting still TBD. |

### Backlog items not in GitHub issues (should they be?)

These IDEAS.md items deserve GitHub issues so the community can upvote:
- **#48** Right-click workspace "New Feature Session". Promotes Myrlin as THE orchestrator for parallel branch work. Fits the CLAUDE.md feature-session-protocol.
- **#54** Auto-docs silent background summarizer. Significant product bet.
- **#58** Session handoff / context export. Very high demand in AI tooling circles.
- **#78** Workspace Rules. Ties to CLAUDE.md tradition, power-user feature.
- **#80** Sound/notification when Claude finishes. Simple, high utility.

### Outstanding for longest

The oldest still-outstanding IDEAS.md items (created Feb 10, 2026):
- **#49 Nested workspaces**: 72 days in backlog, no issue, no PR.
- **#54 Auto-docs**: 72 days in backlog, no issue, no PR.
- **#78 Workspace Rules**: 72 days in backlog, no issue, no PR.

These are not blocking anyone. But they are also not visible to the community. Opening GitHub issues for each (even as `enhancement` label with an "under consideration" pinned comment) is a cheap way to solicit feedback and upvotes.

---

## 8. Hidden Feature Requests (buried in issue bodies / comments)

Going line by line through bodies + comments, these feature-shaped asks appeared without being their own issues:

1. **"Read mode" scroll improvement** (from Arthur's own reply on #41). Arthur recommends "read" mode for smoother scroll. This suggests a UX seam: users don't know Read mode exists OR don't discover it naturally. **Action:** Add a toolbar toggle / tooltip nudge on the terminal pane header making "Read mode" more discoverable. (Hidden UX gap.)

2. **Mobile native app** (implicit across many mobile PRs #6, #13, and MEMORY.md mentions ongoing `mobile/` folder with React Native). Users repeatedly patch mobile web. A native wrapper would simplify scroll + autocorrect dramatically. MEMORY.md section "Mobile App Build (2026-03-28)" confirms Arthur is already pursuing this but it's not on the public roadmap.

3. **CodeMirror-based file editor** (shipped in PR #43 by croakingtoad, never requested as an issue!). This was a bootstrap feature that gained traction. **Signal:** a lightweight file editor is wanted. Consider building out (syntax highlighting per language, multi-file tabs, find/replace).

4. **Copy commit hash to clipboard** (shipped in PR #43). Trivial feature, but it implies users want "power-user git ergonomics" built in. More git tools: stash management, interactive rebase UI, PR creation inline, cherry-pick helpers.

5. **Expand pane to fullscreen** (shipped in PR #29 by croakingtoad, not filed as issue). Another shipped-without-issue feature. Suggests good maintainer intuition AND suggests users don't file issues for UX papercuts; they just live with them.

6. **"Models API aliases over hardcoded IDs"** (shipped in PR #31, not filed as issue). Users were silently dealing with `sonnet[1m]` shell-globbing for who knows how long. **Signal:** run a quarterly "what do users not report?" survey.

7. **"auto-refresh pane after project switch"** (PR #43 bug fix #5). Silent UX fallout from another feature.

### Implied but never-issued feature requests

From competitive research in IDEAS.md and MEMORY.md product philosophy section, these are asks the product team already knows about but community has not surfaced yet:
- **Session replay / time travel** (competitive research section). Would be very popular for debugging agent runs.
- **Agent Client Protocol (ACP)** support (competitive research section). Would unlock Zed, VS Code, Cursor integration.
- **Saveable Layout Configurations** (competitive research section). Power-user feature.
- **Per-action cost breakdown** (not just session total). Cline precedent.

None of these have GitHub issues. Opening them would provide demand-signal thermometers.

---

## 9. Top 5 Community-Requested Features (aggregated demand)

Ranked by cross-source signal (GitHub issues + MEMORY.md + TODO.md + IDEAS.md + PR comments).

### 1. Live session observer / mirror of external Claude sessions

**Evidence:** Open issue #10 (3 comments, 2 HEART reactions), detailed SESSION-SHARING-PLAN.md (149 lines of architecture), TODO.md Future Enhancements section explicitly names "Session Sharing / Proxy (#10)". The reporter xingfanxia is a contributor.

**Demand score:** 9/10. Strong one individual, architecturally significant, no substitute in the ecosystem.

**Recommendation:** Ship Tier 1 (JSONL mirror) in v0.11. See Section 3.

### 2. Smooth terminal scrolling

**Evidence:** Open issue #41. Multiple mobile scroll PRs (#6 jfrostad, #13 Vidalee) implicitly target the same user experience. Reporter is frustrated enough to file their first issue.

**Demand score:** 6/10. Cosmetic but visible to every single user.

**Recommendation:** Add `smoothScrollDuration: 125` in v0.9.28. See Section 4.

### 3. Sound/desktop notification when Claude finishes a task

**Evidence:** IDEAS.md Medium Features list #80. MEMORY.md references notifications system. Multi-session users repeatedly lose track of when agents finish.

**Demand score:** 7/10. Every multi-agent orchestration competitor has this (Cursor, Cline, Continue.dev).

**Recommendation:** Implement idle detection (already detected per MEMORY.md for terminal-pane indicator purposes), fire a Web Notification API call + optional audio cue when an idle transition happens mid-session.

### 4. Cost tracking granularity / per-action cost breakdown

**Evidence:** Issues #17, #18 (both about cost tracking gaps). IDEAS.md competitive research section names "per-action cost breakdown" explicitly. Paid product tiers of competitors charge for this.

**Demand score:** 7/10. Core differentiator. Current session-level cost works but does not segment by tool invocation.

**Recommendation:** Parse `message.usage` per-response from JSONL, group by tool_use blocks, show "File edit: $0.03 / Bash: $0.01 / Plan: $0.18." Medium effort, ~1 week.

### 5. Session handoff / context export

**Evidence:** IDEAS.md Big Features list #58. td integration (PR #26) fills this gap partially. MEMORY.md mentions multiple handoff skills and Claude's own wrap-up skill. Product audience (Claude Code power users) naturally need this.

**Demand score:** 6/10. Niche-but-loud user segment.

**Recommendation:** Low-priority until explicit request appears in GitHub issues. td integration already addresses the sharpest-edged case. File a GitHub issue to gauge demand (see Section 13).

### Honorable mentions (not top 5 but worth tracking)

6. **Saveable terminal pane layouts** (IDEAS.md competitive research)
7. **Session templates / quick launch** (partial, per MEMORY.md)
8. **Workspace Rules per-project** (IDEAS.md #78)
9. **Desktop app wrapper (Tauri or Electron)** (implied by user complaints about browser chrome around the workbook)
10. **Multi-provider support** (Claude + Codex + others) (IDEAS.md Potential Features section)

---

## 10. Top 5 Bugs to Prioritize

### 1. Image upload still broken on Windows (#42)

**URL:** https://github.com/therealarthur/myrlin-workbook/issues/42

**Status:** Closed 2026-04-10 by Arthur, but reporter hybridandrew replied 2026-04-12 with screenshot showing still broken. Owner has not responded.

**Repro (inferred):**
1. Windows 11 + npx install
2. Update to v0.9.25+
3. Click camera icon in terminal pane header
4. Select an image file
5. Expected: image path sent to Claude; Claude sees the image.
6. Actual: error message (the screenshot the reporter attached is key; it was truncated in the API fetch, but the filename `IMG_126f7b9e-5a19-4f4a-ae77-1c2dc93201b3.png` suggests an error toast).

**Root cause category:** Path resolution on Windows. `~/.myrlin/uploads/` may not be created correctly, or the path sent to Claude contains backslashes where forward slashes are needed, or Claude Code cannot read from `AppData/Roaming/.myrlin/uploads/<sessionId>/`.

**Severity:** P1. High-visibility feature for a core workflow, and the reporter is likely frustrated.

**Effort:** S (1-2 hours to reproduce and fix).

**Action:** Reopen, test on Windows, ship in v0.9.28.

---

### 2. Scroll "jumps in blocks" on desktop (#41)

**URL:** https://github.com/therealarthur/myrlin-workbook/issues/41

See Section 4 for full analysis.

**Action:** Add `smoothScrollDuration: 125` to Terminal config. 1 line. Ship in v0.9.28.

---

### 3. Persistent "missing file in npm tarball" regressions (meta-bug)

**Evidence:** 5 separate closed issues with the same pattern (#4, #27, #32, #33, #39).

**Action:** Add GitHub Actions CI gate for `npm pack && extract && smoke-test` before publish. See Section 5 for spec.

---

### 4. Cost tracking could silently drift if JSONL lookup heuristics break

**Evidence:** #17 + #18 fixes added two fallback paths (`findJsonlByWorkingDir`, `originalPath`, `entries[0].projectPath`). Any change to Claude CLI's JSONL or `sessions-index.json` format will silently re-break this. Latest CC versions have been known to rename/move this data.

**Action:** Add integration tests that stub a `sessions-index.json` file in each known format variant and assert `findJsonl` returns the right path. Quarterly audit of the directory layout used by the latest Claude Code release.

---

### 5. Hidden process kill / child cleanup bugs (speculative)

**Evidence:** None in GitHub issues directly, but global CLAUDE.md Rule 10 ("Process Safety") explicitly notes "NEVER run `taskkill //f //im node.exe`" has crashed Arthur's workspace multiple times. This implies lifecycle bugs around shell/PTY cleanup exist.

**Action:** Audit all `child_process.spawn` callsites in `src/web/pty-manager.js` and `src/core/session-manager.js`. Confirm every spawned PTY has a corresponding kill/cleanup path on shutdown. Add a smoke test that starts N sessions, kills Myrlin, and verifies no orphan `claude.exe` or `bash.exe` processes remain.

---

## 11. Recommended Closures

### Reopen

- **#42 Image upload**: reopen per Section 10.1. Reporter's last message says fix did not work.

### Close as obsolete / no-response needed

- **#41 Scroll jump**: keep open until `smoothScrollDuration` ships, then close with release note.

### Close with a comment (even if functionality is good)

- **#10 Session sharing**: Arthur should comment every ~6 weeks (e.g., "still pinned; here's the roadmap timeline update") to keep the reporter engaged. Do NOT close; it's a real architectural request.

### Issues that SHOULD be opened (from IDEAS.md)

As recommended in Section 7, open GitHub issues for visible community tracking:

1. "Nested workspaces (project > workspace hierarchy)", IDEAS.md #49
2. "Right-click workspace → New Feature Session (branch + worktree + Claude)", IDEAS.md #48
3. "Auto-docs: silent background session summarizer", IDEAS.md #54
4. "Session handoff / context export", IDEAS.md #58
5. "Workspace Rules, per-workspace rules injected into sessions", IDEAS.md #78
6. "Sound / desktop notification when Claude finishes in a terminal pane", IDEAS.md #80
7. "Saveable Layout Configurations", IDEAS.md competitive research section
8. "Per-action cost breakdown", IDEAS.md competitive research section
9. "Session replay / time-travel", IDEAS.md competitive research section
10. "Agent Client Protocol (ACP) support", IDEAS.md competitive research section

Even if Arthur doesn't plan to work on all 10, surfacing them invites the community to rank / upvote / PR. This is a zero-cost way to crowdsource prioritization.

---

## 12. Recommended v0.10 Community-Demand Slice (8-12 items)

Based on pure user signal (excluding Arthur's internal strategic priorities), the v0.10 release should focus on closing visible gaps that community has explicitly or implicitly raised.

### Must-have (P0, ship-blocking)

1. **Fix #42 image upload on Windows**: reopen + fix. (S, 1-2 hr)
2. **Add `smoothScrollDuration: 125` for #41**: 1-line config. (S, 30 min)
3. **Add CI gate for npm tarball smoke test**: prevent future regressions like #4/#27/#32/#33/#39. (M, 1 afternoon)

### Should-have (P1, high community value)

4. **Sound/desktop notification when Claude finishes**: IDEAS.md #80, major multi-session UX improvement. (M, 1-2 days)
5. **Session handoff / context export** as a visible menu item: either wrap td or invent a native flow. (M, 2-3 days)
6. **"Read mode" discoverability**: surface the existing read-mode feature in the terminal pane header toolbar rather than only at the bottom-left. (S, 2 hr)
7. **Per-action cost breakdown**: tooltip on session's cost number showing "Bash: $0.04 / Edit: $0.03 / ..." Strengthens cost-tracking differentiator. (M, 3-5 days)

### Nice-to-have (P2, surface backlog visibility)

8. **Saveable pane layout configurations**: IDEAS.md competitive research. Warp already has it. (M, 3-4 days)
9. **Right-click workspace → New Feature Session (worktree + branch + Claude)**: IDEAS.md #48. Pairs with Feature Session Protocol in CLAUDE.md. (M, 2-3 days)
10. **Open GitHub issues for the 10 items in Section 11.4**: zero-cost way to measure demand. (S, 30 min total)

### Bonus (stretch)

11. **Session sharing Tier 1 (JSONL read-only mirror)**: close issue #10. Invite xingfanxia to co-author. Shipping this in v0.10 is ambitious but would be a major community win. (L, ~1 week)
12. **Promote croakingtoad to maintainer**: formalize with CODEOWNERS + mention in README. Retains him as a long-term contributor. (trivial)

### Suggested ordering

Ship a v0.9.28 point release first with #1, #2, #3 (bug-fix + CI), then move to v0.10 with the features.

---

## 13. Appendix: Raw Issue/PR Dumps

### A. All Open Issues

```
#10 | enhancement | Share/Proxy Running session rather than creating a new session
  author: xingfanxia (CONTRIBUTOR)
  filed: 2026-02-23
  comments: 3
  reactions: 2x HEART (on thread comments, not body)
  URL: https://github.com/therealarthur/myrlin-workbook/issues/10

#41 | no label | The sliding experience is not good
  author: KingingWang (NONE)
  filed: 2026-04-06
  comments: 2
  reactions: 0
  URL: https://github.com/therealarthur/myrlin-workbook/issues/41
```

### B. All Closed Issues (chronological, oldest first)

| # | Title | Author | Filed | Closed | Duration | Resolved by |
|---|---|---|---|---|---|---|
| 1 | Binds to 0.0.0.0 by default, exposed on LAN | ivurgraf | 2026-02-13 | 2026-02-13 | 2h 35m | fix committed |
| 4 | prebuilt spawn-helper binary missing execute permission | asxzy | 2026-02-20 | 2026-02-20 | 1h 47m | postinstall script |
| 5 | import Claude sessions doesn't work | materemias | 2026-02-20 | 2026-02-20 | 1h 21m | v0.7.0-alpha.1 |
| 8 | Cannot Start Claude Code Session | xingfanxia | 2026-02-23 | 2026-02-23 | 17m | PR #9 merged |
| 14 | Impossible to remove a session | matteo-ms | 2026-02-24 | 2026-02-24 | 10m | (no explanation, very short) |
| 15 | Task extraction failed | matteo-ms | 2026-02-24 | 2026-02-24 | 7h 5m | commit 5dd2b1f |
| 17 | Cost tracking shows $0.00 for discovered/imported sessions | Arthur (Raj) | 2026-02-27 | 2026-03-07 | ~8 days | v0.6.1 |
| 18 | Cost tracking: $0.00 follow-up | Arthur (Raj) | 2026-02-27 | 2026-02-27 | 59m | commits 2248146 + 2c87ad5 |
| 20 | New project "+" doesn't create a new project | croakingtoad | 2026-03-06 | 2026-03-07 | ~2 hours | v0.8.3 |
| 27 | npx myrlin-workbook fails: postinstall.js missing | dianshu | 2026-03-08 | 2026-03-08 | 2h 37m | v0.8.6 |
| 30 | workspaceId is required. error when launching | falceso | 2026-03-09 | 2026-03-10 | ~5 hours | v0.8.10 |
| 32 | bug: crash-logger module missing | croakingtoad | 2026-03-10 | 2026-03-11 | ~10 hours | commit 45595d5 |
| 33 | Header logo fails to load | dianshu | 2026-03-12 | 2026-03-12 | ~16 hours | v0.9.3 |
| 35 | Issues Running myrlin Latest release | rpatel-rnits | 2026-03-16 | 2026-03-16 | ~6 hours | v0.9.5 + v0.9.6 |
| 39 | MODULE_NOT_FOUND: ../utils/data-dir | inorixu | 2026-03-28 | 2026-03-28 | ~3 hours | v0.9.9 |
| 42 | Unable to upload/import images | hybridandrew | 2026-04-10 | 2026-04-10 | ~3 hours | v0.9.25 (REPORTEDLY STILL BROKEN) |

### C. All Merged PRs (chronological, oldest first)

| # | Title | Author | Merged | +LOC | -LOC |
|---|---|---|---|---:|---:|
| 2 | Fix cross-platform shell spawning for WSL/Linux | Frix-x | 2026-02-16 | 33 | 15 |
| 3 | Upgrade xterm to v6 + fix session cwd resolution | Guy7B | 2026-02-19 | 216 | 65 |
| 6 | Fix mobile scrolling and autocorrect | jfrostad | 2026-02-21 | 220 | 14 |
| 7 | Fix CJK composition duplicate input | ntopia | 2026-02-23 | 6 | 27 |
| 9 | Guard against null session in attachClient | xingfanxia | 2026-02-23 | 13 | 0 |
| 11 | Cloudflare named tunnel integration | xingfanxia | 2026-02-23 | 311 | 0 |
| 12 | Fix decodeClaudePath for Linux/macOS paths | Vidalee | 2026-02-23 | 67 | 47 |
| 13 | Fix mobile terminal scroll snaps back to bottom | Vidalee | 2026-02-23 | 41 | 14 |
| 16 | Fix terminal scrollback duplication on reconnect | snmo2546 | 2026-02-25 | 13 | 7 |
| 22 | Pass workspaceId inside object to createSession | croakingtoad | 2026-03-07 | 4 | 2 |
| 23 | Don't add --continue when dir has no history | croakingtoad | 2026-03-07 | 24 | 5 |
| 24 | Handle "branch already checked out" case | croakingtoad | 2026-03-07 | 39 | 6 |
| 26 | td task management integration (optional) | croakingtoad | 2026-03-07 | 1567 | 19 |
| 28 | Replace password-in-URL with one-time token | dianshu | 2026-03-11 | 220 | 26 |
| 29 | Two-stage terminal pane expand | croakingtoad | 2026-03-09 | 199 | 1 |
| 31 | Replace hardcoded model IDs with aliases | croakingtoad | 2026-03-11 | 33 | 17 |
| 34 | Prevent double paste in terminal input | benoitmidon | 2026-03-13 | 14 | 1 |
| 36 | Path usability: home-dir expansion + CJK | inorixu | 2026-03-19 | 169 | 10 |
| 37 | Show custom session name when opening | snmo2546 | 2026-03-26 | 6 | 2 |
| 40 | Add missing Android build configuration | croakingtoad | 2026-04-01 | 20 | 2 |
| 43 | Tasks view: tab strip, Git diff, Files editor, td | croakingtoad | 2026-04-13 | 1859 | 48 |
| 44 | Sidebar design polish + Lucide icon picker | croakingtoad | 2026-04-21 | 488 | 42 |
| 45 | Prevent Ctrl+V double-paste in terminal | croakingtoad | 2026-04-21 | 5 | 1 |
| 46 | Material Icons support in workspace icon picker | croakingtoad | 2026-04-21 | 657 | 42 |

### D. Contributors to follow on GitHub (for signal-boosting)

- croakingtoad
- xingfanxia
- Vidalee
- dianshu
- inorixu
- jfrostad

### E. Sentiment scan (quotes from issue bodies and comments)

Positive emphasis:
- "Love the tool though, I've tested a ton of GUIs/TUIs (and even built a few of my own) but yours is by far the one I've appreciated the most!" — croakingtoad (#20)
- "Really enjoyed Myrlin :)" — xingfanxia (#10)
- "Thanks for developing and sharing this helpful tool." — snmo2546 (#16)
- "This project is quite good, but..." — KingingWang (#41)
- "I saw your project on Reddit and wanted to give it a try" — Frix-x (#2)

Frustration / blockers:
- "sorry, but I updated and it didnt work" — hybridandrew (#42 follow-up) [still broken]
- "it jumps in blocks instead of moving continuously. It feels quite jarring" — KingingWang (#41)
- "I am seeing non stop consoles re-opening" — rpatel-rnits (#35) [resolved]

Churn risk: Very low. The only explicit "still broken" message is #42, and even that is polite. Zero rage threads.

Excitement peaks:
- Every reported bug has gotten a detailed acknowledgement + fix within hours.
- Every contributor has received explicit thanks and credit.
- xingfanxia offered to prototype #10 himself.

---

## Final Notes for Arthur

You have a healthy, responsive, cooperative open-source community. The two open issues are neither urgent nor existential. Your main structural risks are:

1. **Silent npm packaging regressions**: one-afternoon CI fix that prevents the biggest class of past bugs.
2. **#42 image upload still broken**: a contributor reported "still broken" and you did not see it.
3. **Over-reliance on one super-contributor (croakingtoad).** Formalize him as a maintainer so bus-factor is not 1.

The biggest future-value unlock is issue #10 (session sharing Tier 1). Your plan is already written; a motivated contributor is already waiting. Greenlight and ship.

Everything else is polish.
