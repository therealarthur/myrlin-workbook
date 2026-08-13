# Codex Provider Parity: Gap Analysis and Implementation Spec

> Scope: make Codex (ChatGPT desktop / OpenAI Codex CLI) sessions first-class peers of Claude
> sessions in the Notion restyle, and make the workbook inherit the same folders and sessions the
> ChatGPT desktop app shows, grouped the same way, with titles the user recognizes.
>
> Status: investigation complete, decision-grade. Nothing in this document has been implemented.
> Every number below was measured on Arthur's live `C:\Users\Arthur\.codex` on 2026-08-13.
>
> Method note: all databases were copied to a scratch directory and queried read-only. No Codex
> file was modified, no server was started, no port was touched. `auth.json` was never opened;
> only its file name is referenced.

---

## 0. The one-paragraph verdict

The workbook's Codex provider reads the wrong source of truth. It reconstructs the session list by
walking `~/.codex/sessions/**/rollout-*.jsonl` and reading `session_index.jsonl` for titles. The
ChatGPT desktop app does not use either as its list; it uses a SQLite store, `~/.codex/state_5.sqlite`,
whose `threads` table carries the cwd, the archived flag, the visibility flag, the spawn graph, the
model, and the token totals. Measured result: **`discover()` returns 52 sessions where the desktop
app shows about 125, and only 27 of those 52 carry a title.** Roughly 58 percent of the user's Codex
conversations are invisible in the workbook, and half of what does appear is untitled. Everything
needed to fix this is already on disk. The fix is a new SQLite-backed discovery path, not new
plumbing in the UI.

---

# (A) The on-disk truth

## A.1 What actually lives under `~/.codex`

Enumerated from `C:\Users\Arthur\.codex`. Only entries relevant to sessions, folders, and titles are
listed; the directory has other content (skills, memories, pets, visualizations, browser, plugins).

| Path | Kind | Size / count | Role |
|---|---|---|---|
| `sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` | append-only JSONL | **796 files** | Per-thread event log. The transcript. |
| `archived_sessions/rollout-*.jsonl` | append-only JSONL, flat | present | Ended threads moved out of `sessions/`. |
| `session_index.jsonl` | JSONL | 129 lines, **118 unique ids** | `{id, thread_name, updated_at}`. Partial title log. |
| **`state_5.sqlite`** (+ `-wal`, `-shm`) | SQLite | 24 MB + 4 MB WAL | **The desktop app's thread store. 3002 threads.** |
| `sqlite/codex-dev.db` | SQLite | 98 KB | `local_thread_catalog` (sidebar projection), automations, inbox. |
| `sqlite/codex-history-snapshots-dev.db` | SQLite | 16 KB | Not investigated. |
| `.codex-global-state.json` | JSON | 31 KB | Electron UI state. Holds the **project id format**. |
| `config.toml` | TOML | 4.8 KB | CLI config. Not read for this analysis. |
| `auth.json` | (name only) | n/a | Active account credential file. **Never opened.** Referenced by the account switcher via file name only. |
| `logs_2.sqlite` | SQLite | **2.1 GB** | Application logs. Deliberately not opened. Do not touch at runtime. |
| `version.json` | JSON | 105 B | `latest_version: 0.144.4` (update-check marker, not the running version). |

## A.2 The `threads` table: the real session list

`state_5.sqlite` tables: `threads` (3002 rows), `thread_sections` (1), `thread_spawn_edges` (2874),
`thread_dynamic_tools`, `backfill_state`, `external_agent_config_imports`,
`remote_control_enrollments`, `_sqlx_migrations`.

Real column names on `threads`:

```
id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms,
updated_at_ms, thread_source, preview, recency_at, recency_at_ms, history_mode,
name, is_pinned, thread_section_id, section_position, section_entered_at_ms
```

The columns that matter for parity:

| Column | Meaning | Measured |
|---|---|---|
| `id` | Thread UUID, same value as the rollout filename suffix and `session_index.id`. | 3002 distinct |
| `rollout_path` | **Direct absolute path to the JSONL.** No date-guessing needed. | see A.6 |
| `cwd` | Working directory. **This is the folder association.** | 22 distinct (visible set) |
| `title` | **Not a title.** Raw first user message, verbatim. | 21 of 38 user threads exceed 200 chars; one is a 12 KB prompt |
| `name` | User-assigned custom name. | **0 rows populated** |
| `preview` | First ~60 chars of the first user message. Doubles as the visibility flag. | `preview <> ''` on 2497 rows |
| `archived` / `archived_at` | Archive state. | 60 archived |
| `thread_source` | `user` / `subagent` / empty. | subagent 2931, user 38, empty 33 |
| `is_pinned`, `thread_section_id` | Pin and user-created section. | **0 rows use either** on this machine |
| `recency_at_ms` | The app's sort key. Distinct from `updated_at`. | populated |
| `tokens_used` | **Cumulative token total.** | up to 113,895,429 on one thread |
| `model`, `reasoning_effort` | Per-thread model config. | see A.7 |
| `git_branch`, `git_sha`, `git_origin_url` | Repo context. | populated |
| `cli_version` | Codex version that wrote the thread. | 0.144.0 through 0.147.0-alpha.6.6 |

## A.3 What "the folders the ChatGPT app shows" means in data terms

**Verified.** The folders are `cwd` groups, and the app assigns each a stable synthetic id.

`.codex-global-state.json` contains keys of the form:

```
sidebar-project-expanded-v1-codex:local-96dac46ed15428c0b9d16938cd85d65b
sidebar-project-expanded-v1-codex:local-486f6e5611d625d523f3e79cacd28dce
```

I brute-forced these hashes against every distinct `cwd` in the database across md5, sha1, and
sha256, over raw / UNC-stripped / lowercased / forward-slash variants. Two exact matches:

```
96dac46ed15428c0b9d16938cd85d65b = sha256("C:\Users\Arthur\Documents\test workday")[:32]
486f6e5611d625d523f3e79cacd28dce = sha256("C:\Users\Arthur\Documents\test blockbench")[:32]
```

Therefore the project identity rule is:

> **`projectId = "codex:" + hostId + "-" + sha256(normalizedCwd).hex[:32]`**
>
> where `normalizedCwd` is the cwd with the Windows `\\?\` extended-length prefix stripped,
> original case preserved, backslashes preserved.

`hostId` is `local` here. `codex-dev.db` confirms hosts are first class:

```sql
CREATE TABLE local_thread_catalog_hosts (
  host_id TEXT PRIMARY KEY,
  host_kind TEXT NOT NULL CHECK (host_kind IN ('local','ssh','wsl','remote-control'))
);
```

There is **no folder-name table**. The app has no stored display name for a project. It synthesizes
the label from the path. The workbook should do the same (basename of the normalized cwd), which is
exactly what `app.js` already does at `src/web/public/app.js:2322` and `:4295`.

`thread_sections` is a separate, user-created grouping concept. It contains exactly one row on this
machine, `{id: 01984de2-..., name: "Pinned"}`, and **zero threads reference it**. Sections and pins
are schema-present but unused. Treat them as a P2 nicety, not part of "inherit the folders".

## A.4 The visible-thread rule

**High-confidence inference, not read from app source.** Marked as such.

`threads` has partial indexes that name the concept explicitly:

```sql
CREATE INDEX idx_threads_visible_created_at_ms ON threads(archived, created_at_ms DESC) WHERE preview <> '';
CREATE INDEX idx_threads_visible_recency_at_ms ON threads(archived, recency_at_ms DESC, id DESC) WHERE preview <> '';
```

So visibility is `archived = 0 AND preview <> ''`. That yields 2441 rows, which is far too many for a
sidebar. The remaining filter is the spawn graph: `thread_spawn_edges(parent_thread_id,
child_thread_id, status)` has 2874 edges, and every one of the 2874 child ids is a real thread.
Excluding spawn children:

```sql
SELECT * FROM threads
WHERE archived = 0 AND preview <> ''
  AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges);
-- 125 rows
```

**125.** That is a plausible sidebar. Corroborating evidence: `session_index.jsonl` holds 118 unique
ids, the same order of magnitude, and it is the file the app maintains for its own sidebar per the
comment at `src/providers/codex/discover.js:8-9`.

Caveat, stated plainly: I did not read the desktop app's query. The exact predicate is
**UNCONFIRMED**. What is confirmed is that the three filters exist as first-class schema concepts and
that their conjunction produces a sane number. Note also that 55 of the 125 have
`thread_source = 'subagent'` yet are not spawn children (these are the `{"subagent":{"other":"guardian"}}`
threads), so filtering on `thread_source` alone would be wrong. Filter on the **spawn edge**, not on
`thread_source`.

## A.5 Where titles live, and the honest coverage number

There is no single title field. Six candidate sources, measured against the 125-thread top-level set:

| Rank | Source | Shape | Coverage |
|---|---|---|---|
| 1 | `codex-dev.db` `local_thread_catalog.display_title` | Exact sidebar title, e.g. `"Study Hytale model style"` | **1 row total** |
| 2 | `threads.name` | User rename | **0 rows** |
| 3 | `session_index.jsonl.thread_name` | AI-generated short title, e.g. `"Plan complete MacBook migration"` | **55 of 125** |
| 4 | `event_msg.thread_name_updated.thread_name` in the rollout | AI title event | **2 of 796 files** |
| 5 | `threads.title` | Raw first user message | 44 of 125 happen to be under 80 chars |
| 6 | `threads.preview` | First ~60 chars | all 125 |

**Cascade coverage (1 through 4): 55 of 125, i.e. 44 percent.** The other 68 threads have no
human-authored or AI-authored title anywhere on disk and must be labelled from `preview` with
truncation.

`local_thread_catalog` deserves attention despite having one row. Its schema is exactly the
projection the redesign needs:

```sql
CREATE TABLE local_thread_catalog (
  host_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  display_title TEXT NOT NULL,             -- the sidebar title
  source_created_at REAL NOT NULL, source_updated_at REAL NOT NULL,
  cwd TEXT NOT NULL,                       -- NO \\?\ prefix here
  source_kind TEXT NOT NULL, source_detail TEXT, model_provider TEXT NOT NULL,
  git_branch TEXT, observation_sequence INTEGER NOT NULL,
  missing_candidate INTEGER NOT NULL DEFAULT 0,
  thread_source TEXT, source_recency_at REAL NOT NULL DEFAULT 0,
  pending_observed_title INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (host_id, thread_id)
);
```

Read it opportunistically as title source rank 1, but never depend on it. It is a sync cache
governed by `local_thread_catalog_metadata.catalog_revision` and is empty in practice here.
Why it is empty is **UNCONFIRMED**.

Concrete illustration of why `threads.title` must never be shown raw: thread
`019ff6f9-8b5f-7fb1-acef-874b662c6bc8` has a `title` that is the user's entire multi-paragraph
migration request, while `session_index.thread_name` for the same id is
`"Plan complete MacBook migration"`. That is the title the user recognizes.

## A.6 Rollout paths are not all under `~/.codex`

`rollout_path` roots across all 3002 threads:

| Root | Count |
|---|---|
| `...\.codex\sessions\...` | 2940 |
| `...\.codex\archived_sessions\...` | 60 |
| **`\\?\D:\CodexArchive\sessions\...`** | **2** |

`D:\CodexArchive` exists on this machine. Current discovery walks only `$CODEX_HOME/sessions` and
`$CODEX_HOME/archived_sessions` (`src/providers/codex/index.js:270-275`), so those threads are
unreachable by `findArtifactPath` even though the database knows exactly where they are. Trusting
`rollout_path` fixes this for free.

Prefix inconsistency is real and load-bearing. Distinct `rollout_path` prefixes:

```
C:\Users\Arthur\.codex\archived_...
C:\Users\Arthur\.codex\sessions\...
\\?\C:\Users\Arthur\.codex\sessi...
\\?\D:\CodexArchive\sessions\202...
```

The same inconsistency hits `cwd`. On the 125-thread set, 19 distinct raw `cwd` values collapse to
**18** after stripping `\\?\` and case-folding. The concrete collision:

```
'C:\Users\Arthur\Documents\New project 2'
'\\?\C:\Users\Arthur\Documents\New project 2'
```

Unnormalized, that renders as two separate folders with the same name in the sidebar. Note the
rollout JSONL's `session_meta.cwd` is always clean (`C:\Users\Arthur\Documents\test workday`), and
`local_thread_catalog.cwd` is also clean. Only `threads.cwd` and `threads.rollout_path` carry the
prefix. **Normalization is mandatory the moment the DB becomes a source.**

## A.7 Rollout JSONL schema, from real files

Envelope: `{type, timestamp, payload}`. Line 0 is always `session_meta`.

`session_meta.payload` keys as of CLI 0.147.0-alpha.6.6:

```
session_id, id, forked_from_id, parent_thread_id, timestamp, cwd, originator,
cli_version, source, thread_source, agent_nickname, agent_path, model_provider,
base_instructions, dynamic_tools, history_mode, multi_agent_version,
context_window, git
```

Note `forked_from_id`, which contradicts the current `supportsForkResume: false` assumption (see D.4).
`originator` is `"Codex Desktop"`. `source` is either a bare string (`"vscode"`, `"exec"`) or a JSON
object `{"subagent": {...}}`. A rollout can contain **multiple `session_meta` lines** (9 in the sampled
file), one per resume; discovery reads only line 0, which is correct for start metadata but means
later cwd changes are invisible.

Payload-type histogram for a representative 2465-line user thread:

| Count | `type` / `payload.type` |
|---|---|
| 599 | `event_msg` / `token_count` |
| **536** | `response_item` / **`custom_tool_call`** |
| **536** | `response_item` / **`custom_tool_call_output`** |
| 303 | `response_item` / `reasoning` |
| 109 | `event_msg` / `agent_reasoning` |
| 101 | `response_item` / `message` |
| 84 | `event_msg` / `agent_message` |
| 55 | `response_item` / `function_call` |
| 55 | `response_item` / `function_call_output` |
| 9 | `session_meta` |
| 8 | `turn_context` |

`token_count.info` is the cost payload and it is complete:

```json
{"total_token_usage":{"input_tokens":65151443,"cached_input_tokens":63733504,
 "cache_write_input_tokens":0,"output_tokens":103488,
 "reasoning_output_tokens":27383,"total_tokens":65254931},
 "last_token_usage":{...},"model_context_window":258400}
```

It also carries `rate_limits` with `plan_type`, `used_percent`, `window_minutes`, `resets_at`, and a
`credits` block. That is a direct feed for the account usage popover described in Feature Inventory
line 12.

`turn_context.payload` carries per-turn `cwd`, `workspace_roots`, `model`, `approval_policy`,
`sandbox_policy`, `personality`, `collaboration_mode`.

Real enum values, which matter because the spawn allow-lists disagree with them:

| Field | Observed values |
|---|---|
| `reasoning_effort` | **`ultra` (2849)**, **`xhigh` (90)**, `high` (36), `low` (20), `medium` (2), **`max` (1)** |
| `model` | `gpt-5.6-sol` (2875), `gpt-5.5` (105), `codex-auto-review` (17), `gpt-5.6-terra` (2), `gpt-5.4` (1) |
| `approval_mode` | `never` (2971), `on-request` (31) |
| `sandbox_policy` | `{"type":"disabled"}` (2904), `{"type":"managed",...}` (~55), `{"type":"danger-full-access"}` (33), `{"type":"workspace-write",...}` (4) |

## A.8 Verifiable versus synthesized: the honest split

| Claim | Status |
|---|---|
| Folders are `cwd` groups | **Verified** (threads.cwd + catalog.cwd + the sha256 project-id proof) |
| Project id = `codex:<host>-<sha256(cwd)[:32]>` | **Verified** by exact hash match on two independent folders |
| Folder display name is synthesized from the path basename | **Verified negatively**: no folder-name table exists anywhere |
| Visible set = `archived=0 AND preview<>'' AND NOT spawn-child` | **UNCONFIRMED inference.** Schema and counts support it; the app's query was not read |
| `session_index.thread_name` is the AI-generated sidebar title | **Verified** by direct comparison against `threads.title` for the same id |
| AI title coverage is only 44 percent | **Verified** by measurement |
| Multi-host (`ssh`/`wsl`/`remote-control`) sessions appear in the same catalog | Schema **verified**; no non-local rows exist here, so behavior is **UNCONFIRMED** |
| `local_thread_catalog` is the app's live sidebar projection | Schema strongly implies it; the 1-row population is **UNCONFIRMED** |
| Nothing relevant lives in `logs_2.sqlite` | **UNCONFIRMED.** 2.1 GB, deliberately not opened |

---

# (B) Gap table

Capability rows are taken from `docs/design/notion-import/Feature Inventory.md`. Status is measured,
not assumed. All paths are relative to `C:/Users/Arthur/Desktop/cwm-restyle/`.

| # | Capability | Codex status today | Evidence | Fix shape |
|---|---|---|---|---|
| B1 | **Discovery** | **Broken.** Returns 52 of ~125. Takes 5.5 s. | `src/providers/codex/discover.js:429-598`. Measured live. | Add SQLite-first discovery from `threads`; keep the walk as fallback. |
| B2 | **Grouping into folders** | **Partial.** Groups by raw `projectPath` string. | `src/web/server.js:2011-2023`, key is `s.projectPath` verbatim. | Normalize cwd (strip `\\?\`, case-fold for the key, keep original for display). Emit the `codex:<host>-<sha>` project id. |
| B3 | **Titles** | **Broken.** 27 of 52 titled; walk-recovered rows hardcode `title: null`. | `discover.js:487` (index path) vs `discover.js:527` (walk path). | Title cascade: catalog, `threads.name`, `session_index`, `thread_name_updated`, then truncated `preview`. |
| B4 | **Status model** | **Claude-shaped.** `isIdleSignal` is a guessed regex, never validated against Codex output. | `src/providers/codex/index.js:55-79`, JSDoc admits "defensive default until Phase 19". | Validate against real PTY output; add `archived`, `is_pinned`, and spawn-parent as status inputs. |
| B5 | **Resume** | **Works, with caveats.** `codex resume <id>` is correct. | `src/providers/codex/spawn.js:180-208`. | Keep. But `EFFORT_VALUES` (`spawn.js:66-71`) omits `ultra`/`xhigh`/`max`, which is 98 percent of real usage, and `SANDBOX_VALUES` (`:53-57`) omits `disabled`/`managed`. Both silently drop. Widen. |
| B6 | **Stop / restart** | **Works.** Provider-agnostic PTY lifecycle. | `src/web/pty-manager.js:477-546`. | None. |
| B7 | **Mirror / live view** | **Partial.** `mirror.parseLine` mapped 7 of 40 sampled lines. | `src/providers/codex/index.js:370`; measured. | Extend `parseLine` to `custom_tool_call*`; see B8. |
| B8 | **Transcript / Copy full transcript** | **Broken in a silent, data-losing way.** `parseTranscript` returns 217 messages from a 2465-line file. It emits `function_call`/`function_call_output` but has **no case for `custom_tool_call` or `custom_tool_call_output`**, which is 1072 of those lines. | `src/providers/codex/parse.js:466-496` emit-set JSDoc; `grep custom_tool_call parse.js` returns nothing. | Add both payload types to the emit set. **This is a correctness bug, not cosmetics: 43 percent of the session is dropped without warning.** |
| B9 | **Search** | **Likely degraded.** Search greps rollouts and scans for `thread_name_updated` for titles, which exists in 2 of 796 files. | `src/providers/codex/search.js:311-337`. | Feed titles from the same cascade as B3; index from the DB. |
| B10 | **Cost** | **Broken and mis-reported as $0.00, not as unsupported.** The Claude parser matches `entry.type === 'assistant' && message.usage`; a Codex rollout yields **0 matches** against **618** `event_msg/token_count` entries. `/api/sessions/:id/cost` never checks `supportsCost()`. | `src/web/server.js:3484-3520` (parser), `:3603-3682` (route, no gate), `src/providers/codex/index.js:107-109` (`supportsCost: false`), used only at `server.js:2407-2411`. | Add `provider.parseUsage(jsonlPath)`; read `token_count.info.total_token_usage`, or read `threads.tokens_used` for an O(1) total. Flip `supportsCost` to true. Gate the route on the flag. |
| B11 | **Auto-title** | **Claude-shaped. Hard 404.** Hardcodes `~/.claude/projects` and never dispatches through the registry. | `src/web/server.js:2662-2693`, literal at `:2673`. | Route through `provider.findArtifactPath` + a provider-specific message extractor. |
| B12 | **Summarize** | **Claude-shaped. Hard 404.** Same hardcoded walk. **Plus a live routing bug:** two `POST /api/sessions/:id/summarize` handlers are registered, at `:2800` and `:5660`. Express serves the first. The provider-aware one at `:5660` is **unreachable dead code**. | `server.js:2800` and `server.js:5660`; `generateSessionSummary` at `:5554`. | Delete the shadowing is NOT permitted under the code-preservation rule; instead make `:2800` dispatch through the provider, or reorder registration deliberately. Flag to the Orchestrator. |
| B13 | **Notes** | **Works.** Provider-agnostic, keyed by session id. | Peek Notes, Feature Inventory line 83. | None. |
| B14 | **Move to project** | **Works, but wrong grain.** Moves a workbook session between workbook workspaces; it does not reflect Codex's cwd-derived folders. | Feature Inventory line 88. | Decide: Codex folders are derived from cwd and are **not user-movable**. Hide or disable for Codex rows. |
| B15 | **Hide** | **Works.** Frontend-only. | Feature Inventory line 36. | None. |
| B16 | **Templates** | **Works.** | Feature Inventory line 108. | Widen the effort/sandbox enums per B5 so saved templates round-trip. |
| B17 | **Launcher defaults** | **Partial.** Model and effort pickers cannot express `gpt-5.6-sol` + `ultra`, the actual default. | `spawn.js:66-71`, `:53-57`. | Source the option lists from observed values, not a frozen literal set. |
| B18 | **Subagents** | **Claude-shaped, returns empty.** Path resolution is provider-aware, but `parseSubagents` looks for `entry.type === 'assistant'` with a `Task` `tool_use` block. Codex has none. | `server.js:5485-5502` (dispatch ok), `:5398-5428` (parser). | **Big opportunity.** Codex has a real spawn graph: `thread_spawn_edges` (2874 edges) plus `agent_nickname` / `agent_role` (`Linnaeus`/`explorer`, `Rawls the 2nd`, `Euler`). Richer than Claude's. Implement `provider.getSubagents()`. |
| B19 | **Export context** | **Partial.** Provider-dispatched path, Claude-shaped reader. | `server.js:4413-4430` (dispatch ok), `:4639-4661` (`readConversationForExtraction`, Claude-shaped). | Share the B8 transcript normalizer. |
| B20 | **Extract tasks** | **Partial and coupled.** Provider-dispatched path, but Claude-shaped reader **and** it shells out to the Claude CLI (`resolveClaudeCli()`), 400ing if Claude is absent. | `server.js:4721-4740`. | Acceptable to keep Claude as the summarizing LLM; must fix the reader. Document the coupling. |
| B21 | **Spinoff context** | **Mostly provider-neutral.** Reads files from disk, not the transcript. | `server.js:4847+`. | Low priority. |
| B22 | **Account switcher** | **Exists and is Codex-specific.** | `src/providers/codex/accounts.js:44` (`CODEX_AUTH_FILE_NAME`), `:207-223` (`accountsCapability`), consumed by `src/web/provider-account-manager.js`. | None. See D.5. |
| B23 | **Watcher / live refresh** | **Partial.** Watches only `$CODEX_HOME/sessions`. Misses `archived_sessions`, misses `state_5.sqlite`, misses `D:\CodexArchive`. | `src/providers/codex/index.js:149-152`. | Add a WAL-aware poll on `state_5.sqlite` mtime. |
| B24 | **Artifact lookup performance** | **O(n) full walk per call.** `findArtifactPath` walks all 796 files for every lookup; `/api/cost/batch` calls it per session. | `index.js:288-299`, `:270-275`. Measured 5.5 s for one discover pass. | Replace with an indexed `SELECT rollout_path FROM threads WHERE id = ?`. |
| B25 | **cwd fallback + JSONL watcher on spawn** | **Claude-only by explicit gate.** | `src/web/pty-manager.js:572` and `:840`, both `providerId === 'claude'`. | Add a Codex equivalent that resolves cwd from `threads.cwd`. |

---

# (C) Implementation spec for the redesign build

## C.1 New module: `src/providers/codex/state-db.js`

A read-only accessor over `state_5.sqlite` and `sqlite/codex-dev.db`. This is the single new backend
component that closes B1, B2, B3, B10, B18, and B24 at once.

Hard requirements, all of them safety properties:

1. **Open read-only.** Use `file:...?mode=ro&immutable=0` or copy-then-read. The desktop app writes to
   this DB continuously; a write handle risks corrupting the user's session history.
2. **Never open `logs_2.sqlite`.** 2.1 GB.
3. **Tolerate absence.** No DB, unreadable DB, schema drift, or a locked WAL must degrade to the
   existing filesystem walk, never throw. The current provider's never-throw discipline
   (`discover.js:25-30`) is the standard to hold.
4. **No new native dependency without approval.** `better-sqlite3` is not currently in
   `node_modules`. Options: add it (native build, Windows toolchain risk), use `node:sqlite`
   (Node 22+), or shell out to a bundled `sqlite3`. **This is a dependency decision for the
   Orchestrator, not for the implementer.** It is the single biggest execution risk in this plan.

Proposed surface:

```js
listThreads({ includeArchived = false, includeSubagents = false })
  // -> [{ id, rolloutPath, cwd, cwdNormalized, projectId, title, preview,
  //       archived, isPinned, sectionId, recencyAtMs, createdAtMs,
  //       tokensUsed, model, reasoningEffort, cliVersion, gitBranch,
  //       threadSource, agentNickname, agentRole }]
resolveRolloutPath(threadId)   // O(1), replaces the O(n) walk
listSpawnEdges(parentThreadId) // powers B18
getDisplayTitle(threadId)      // the cascade
isAvailable()                  // cheap probe for graceful degradation
```

## C.2 Normalization helpers (shared, exported, unit-tested)

```js
normalizeCodexPath(p)  // strip leading \\?\ ; collapse separators ; strip trailing sep
projectKeyFor(cwd)     // normalizeCodexPath(cwd).toLowerCase()   <- grouping key
projectIdFor(cwd, hostId = 'local')
  // "codex:" + hostId + "-" + sha256(normalizeCodexPath(cwd)).hex.slice(0, 32)
```

`projectKeyFor` is the grouping key so `\\?\C:\...\New project 2` and `C:\...\New project 2` collapse.
Display name stays the basename of the **non-lowercased** normalized path so casing the user chose is
preserved. `projectIdFor` must hash the **non-lowercased** normalized path, because that is what
reproduced the app's hashes exactly.

## C.3 Title cascade

```
1. local_thread_catalog.display_title        (best; rarely present)
2. threads.name                              (user rename; empty today)
3. store.getProviderSessionTitle(...)        (workbook rename, already wired at server.js:2049-2050)
4. session_index.jsonl thread_name           (55 of 125)
5. event_msg.thread_name_updated (last wins) (2 of 796 files; search.js:311-337 already does this)
6. truncate(threads.preview, 60)             (always available)
7. "Untitled session"                        (never reached in practice)
```

Steps 1, 2, 4, 6 are O(1) from the DB and the index; step 5 requires a file scan and should run lazily,
only for rows still unresolved after step 4, and only on demand.

**Design consequence for the UI:** 68 of 125 rows will show a truncated first message rather than a
crafted title. The Sessions table must therefore treat the title cell as `text-overflow: ellipsis`
single-line with a `title` attribute for the full string, and the side peek must show the full
`preview` as a separate property. Do not assume titles are short.

## C.4 How Codex surfaces in the new shell

Per `DESIGN-SPEC.md` and Feature Inventory lines 14 and 32, provider **tabs** are gone and provider
**chips** appear per row. Concretely:

| Region | Treatment |
|---|---|
| **Sidebar, Projects tree** (`DESIGN-SPEC.md` 3.4) | One unified tree. Codex folders and Claude folders merge when `projectKeyFor(cwd)` matches, so `C:\Users\Arthur\Documents\test workday` is **one** row with both providers' sessions under it. This is a behavior change from today, where `/api/discover` returns `projects[providerId]` as separate namespaces (`server.js:2158`). |
| **Sidebar, Discovered** (3.5) | Codex threads that have no workbook store record land here, tagged `archived` where applicable. |
| **Sessions table** (6) | Provider chip per row: `<span class="nt-chip nt-chip-green">Codex</span>`, matching the v2 mock's `nt-chip {{ r.providerCls }}` binding and `--provider-codex-accent: var(--green)`. Beware the chip-dot trap in 6.1. |
| **Side peek** (7) | 8 properties. For Codex, populate: Folder, Model (`gpt-5.6-sol`), Effort (`ultra`), Tokens (`tokens_used`), CLI version, Git branch, Started, Last active. Hide fork-resume affordances. |
| **Pane header** (5.4) | `<span class="nt-chip nt-chip-green">Codex</span>` per `DESIGN-SPEC.md:586`. |
| **Attention** | Reason string `Codex is waiting for command approval` already specified at `DESIGN-SPEC.md:842`. |

**Actions to hide or alter for Codex rows:**

| Action | Codex treatment | Why |
|---|---|---|
| Fork / resume-at-checkpoint | **Hide** | `supportsForkResume: false` (`index.js:122-124`). But see D.4: `forked_from_id` exists in `session_meta`, so revisit. |
| Move to project | **Disable with tooltip** | Codex folders are derived from cwd. Moving is meaningless. |
| Auto-title | **Enable only after B11** | Currently a hard 404. |
| Summarize | **Enable only after B12** | Currently a hard 404. |
| Subagents | **Show, and show more than Claude** | Codex has the richer graph. |
| Cost | **Show after B10** | Today it silently shows `$0.00`, which is worse than hiding it. |

## C.5 Frontend-only versus backend work

**Frontend-only (no backend change needed):** provider chip rendering, hiding fork-resume, disabling
move-to-project, ellipsis handling for long titles, archived styling, the peek property grid layout.

**Backend required:** B1, B2, B3, B7, B8, B9, B10, B11, B12, B18, B19, B23, B24, B25. This is the bulk
of the work and it is why "Codex parity" is not a restyle task.

**Contract note for parallel agents:** `groupProviderSessionsForUI` (`server.js:2011`) emits
`claudeSessionId` as the id key for every provider (`:2057`), and
`findArtifactByWorkingDir` returns `{jsonlPath, claudeSessionId}` for Codex too
(`src/providers/codex/index.js:320-342`). These legacy names are load-bearing across the frontend.
**Do not rename them as part of the restyle.** Add aliases if clarity is wanted; do not remove.

## C.6 Priority order

### P0: inherit the folders and sessions, with titles, and resume correctly

The literal user mandate. Nothing here is optional.

| ID | Work | Gaps |
|---|---|---|
| P0-1 | Dependency decision: how to read SQLite. **Blocks everything else.** | C.1 |
| P0-2 | `state-db.js` read-only accessor with graceful degradation | B1, B24 |
| P0-3 | Path normalization helpers plus unit tests, including the `New project 2` collision | B2 |
| P0-4 | SQLite-first `discover()`, filesystem walk as fallback, union not replacement | B1 |
| P0-5 | Title cascade | B3 |
| P0-6 | Cross-provider folder merge by `projectKeyFor` | B2 |
| P0-7 | Widen `EFFORT_VALUES` and `SANDBOX_VALUES` to observed reality | B5, B16, B17 |
| P0-8 | `resolveRolloutPath` from `threads.rollout_path`, including `D:\CodexArchive` | B24, A.6 |

### P1: transcript, search, cost

| ID | Work | Gaps |
|---|---|---|
| P1-1 | `custom_tool_call` and `custom_tool_call_output` in the transcript emit set | B8, B7 |
| P1-2 | `provider.parseUsage()` reading `token_count.info`; flip `supportsCost`; gate the cost route | B10 |
| P1-3 | Search titles from the cascade | B9 |
| P1-4 | Watcher covers `state_5.sqlite` mtime and `archived_sessions` | B23 |
| P1-5 | Rate-limit and plan data from `token_count.rate_limits` into the account popover | A.7 |

### P2: the Claude-shaped extras

| ID | Work | Gaps |
|---|---|---|
| P2-1 | Auto-title through the provider registry | B11 |
| P2-2 | Summarize through the provider registry, and resolve the shadowed-route bug | B12 |
| P2-3 | `provider.getSubagents()` from `thread_spawn_edges` | B18 |
| P2-4 | Export-context and extract-tasks readers share the normalizer | B19, B20 |
| P2-5 | Pins and sections | A.3 |
| P2-6 | Codex cwd fallback and post-spawn id capture in pty-manager | B25 |

---

# (D) Risks

## D.1 Rollout format drift is active, and it has already broken us

`custom_tool_call` is the proof. The parser handles `function_call`, a shape that accounts for 55
lines in a file where `custom_tool_call` accounts for 536. Codex moved to freeform tool calling and
the parser silently dropped 43 percent of the transcript with no error, no warning, no log. The
`cli_version` spread on disk is 0.144.0 through 0.147.0-alpha.6.6 across ten-plus versions, and this
user runs alpha builds.

Mitigations, all cheap:
- Add an **unknown-payload-type counter** to `parseTranscript` and surface it. A transcript that drops
  40 percent of its lines should say so, not render short.
- Treat the emit set as an allow-list with a logged else-branch, never a silent default.
- Add a fixture test per observed `cli_version` family.
- Never assume `payload.type` is stable; assume additive drift.

## D.2 SQLite coupling to an undocumented, moving schema

`threads` already shows migration scars: `created_at` alongside `created_at_ms`, `updated_at`
alongside `recency_at_ms`, and a trailing block of `ALTER TABLE`-added columns (`cli_version`,
`preview`, `name`, `is_pinned`, `thread_section_id`). `_sqlx_migrations` exists, so the schema will
keep moving.

Mitigations:
- `SELECT` named columns only, never `SELECT *`.
- Probe `PRAGMA table_info(threads)` and degrade per-column: a missing `is_pinned` should cost the
  pin feature, not the whole discovery path.
- Keep the filesystem walk permanently as a fallback. **Do not delete it.** It is also the only path
  that works when the desktop app has never run.
- Read-only handles only. A write to this DB damages the user's real session history.

## D.3 Multi-machine and multi-host paths

Three distinct problems, only the first of which is solved by normalization.

1. **UNC prefix drift** on the same machine. Solved by `normalizeCodexPath`. Verified: one real
   collision today.
2. **Off-`CODEX_HOME` rollout roots.** `D:\CodexArchive` holds 2 threads. Trusting `rollout_path`
   solves it, but that path is absolute and machine-specific. If the workbook syncs state between the
   PC and the Mac Mini, a stored `D:\...` path is meaningless on macOS. Store the thread id as the
   key; resolve the path at read time on the local machine.
3. **Non-local hosts.** `local_thread_catalog_hosts.host_kind` allows `ssh`, `wsl`, `remote-control`.
   Only `local` exists here, so behavior for the others is **UNCONFIRMED**. The project id already
   namespaces by host (`codex:local-<sha>`), so the format tolerates it. Do not hardcode `local`;
   read it. Feature Inventory line 15 already flags the machines strip as needing a multi-machine
   model, and this is the same gap.

## D.4 `supportsForkResume: false` may be wrong

`index.js:122-124` returns false, and `session_meta.payload` contains **`forked_from_id`** and
**`parent_thread_id`**. That strongly suggests Codex does support forking. Whether the CLI exposes it
(`codex resume` semantics, a fork flag) is **UNCONFIRMED**; I did not execute the CLI, per the
no-servers constraint.

Consequence for the redesign: hiding fork affordances on Codex rows is the correct **default today**,
but treat it as provisional. Do not bake `provider.id === 'codex'` checks into the frontend; keep
gating on the capability flag so flipping it is a one-line backend change. Worth a follow-up
`codex resume --help` check before the P0 build starts.

## D.5 Account switcher interplay

The Codex account switcher is real and lives at `src/providers/codex/accounts.js`, exposing
`accountsCapability` (`:207-223`) and `authFilePath()` (`:214`), consumed generically by
`src/web/provider-account-manager.js`. It identifies the active account by reading the auth file
whose name is `CODEX_AUTH_FILE_NAME` (`:44`). **No credential content was read during this
investigation, and none is needed for parity work.**

Two interactions the redesign must respect:

1. **Switching accounts does not partition local history.** `threads` has no account column. Every
   thread from every account appears in one list. If the user switches accounts expecting the sidebar
   to change, it will not. Whether the desktop app filters by account is **UNCONFIRMED**; nothing in
   the schema would let it. Surface this honestly rather than implying isolation.
2. **The account file lives in a busy directory.** `accounts.js:42` and `:222` already note that
   `CODEX_HOME` churns constantly from SQLite WAL activity and that the watcher must do a cheap
   name check first. Any new watcher added for P1-4 must follow the same discipline or it will fire
   continuously; `state_5.sqlite-wal` alone changed size during this investigation.

Per Feature Inventory line 14 and `DESIGN-SPEC.md:1547`, the redesign replaces provider tabs in the
account panel with a single credential list carrying provider chips. That is compatible with the
existing capability; no backend change is required for the account surface itself.

## D.6 Performance and the busy-directory problem

`discover()` measured **5.5 seconds**, reading up to 256 KB per file (`discover.js:355`) across 796
files. `findArtifactPath` repeats a full walk **per call**, and `/api/cost/batch` calls it once per
session. The SQLite path replaces both with indexed lookups and should bring discovery well under
100 ms. Conversely, adding a naive `fs.watch` on `CODEX_HOME` would fire constantly because of WAL
churn. Poll `state_5.sqlite` mtime on an interval instead, and keep the existing 5-minute fallback
poll (`index.js:139`).

---

## Appendix: reproduction commands

All read-only. Copy the DB before querying so the live WAL is never touched.

```bash
# folder-id proof
python -c "import hashlib;print(hashlib.sha256(r'C:\Users\Arthur\Documents\test workday'.encode()).hexdigest()[:32])"
# -> 96dac46ed15428c0b9d16938cd85d65b   (matches .codex-global-state.json)

# the visible top-level thread set
sqlite3 state_5.sqlite "SELECT count(*) FROM threads
  WHERE archived=0 AND preview<>''
    AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges);"   # -> 125

# what the workbook returns today
node -e "require('./src/providers/codex/discover.js')().then(s=>
  console.log(s.length, s.filter(x=>x.title).length))"                 # -> 52 27

# the dropped-transcript bug
grep -c custom_tool_call ~/.codex/sessions/2026/08/12/rollout-*-019ff6f9-*.jsonl
node -e "require('./src/providers/codex/parse.js')
  .parseTranscript('019ff6f9-8b5f-7fb1-acef-874b662c6bc8')
  .then(m=>console.log(m.length))"                                     # -> 217, from 2465 lines
```
