# DECISIONS: the Notion restyle decision log

| Field | Value |
| --- | --- |
| Status | Living. Opened in phase P0 (work package P0.3), appended every phase. |
| Opened | 2026-08-13 |
| Owner | The orchestrator. Implementation agents append facts and record resolved ambiguities; they do not settle open questions. |
| Authority | `BUILD-CONTRACT.md` section 0.1. This file records decisions; it never overrides the contract. |

This file answers `PROCEDURE.md` 0.4, step 12 and 5.3, records the five open questions from
`BUILD-CONTRACT.md` section 7, carries the P0.1 measured baseline, and logs every ambiguity an
implementation agent had to resolve to keep moving.

---

## 1. The P0.1 baseline

### 1.1 How it was measured

```bash
cd C:/Users/Arthur/Desktop/cwm-restyle
npm test                             # node test/run.js, exit 0
node scripts/test-assertion-count.js <transcript>   # per-file table and total
```

`npm test` has no grand-total line of its own: `test/run.js` runs an inline suite and then spawns 76
standalone files, each printing its own summary in one of five formats. `scripts/test-assertion-count.js`
normalises those five formats into one table so later phases can compare like for like. The
standing gate in `BUILD-CONTRACT.md` 5.1 ("assertion count must be at or above the P0.1 baseline")
is meaningless without a fixed counting method, so the counter is part of the baseline, not a
convenience.

### 1.2 Totals, on unmodified source at commit `7eac21e`

| Measure | Value |
| --- | --- |
| Test files executed | **77** (1 inline suite in `test/run.js` plus 76 standalone files) |
| Assertions passed | **1158** |
| Assertions failed | **0** |
| `npm test` exit code | **0** |

`grep-gate.test.js` prints a single aggregate line rather than per-assertion output and counts as 1.
Every other file reports its own count.

### 1.3 Per-file breakdown

| File | Assertions |
| --- | --- |
| (inline suite in `test/run.js`) | 63 |
| pty-watcher.test.js | 6 |
| scheduler.test.js | 24 |
| scheduler-api.test.js | 8 |
| instance-colors.test.js | 13 |
| providers-registry.test.js | 11 |
| migration.test.js | 23 |
| pty-passthrough.test.js | 8 |
| cost-worker-via-claude.test.js | 1 |
| grep-gate.test.js | 1 (aggregate) |
| find-jsonl-refactor.test.js | 6 |
| providers-endpoints.test.js | 9 |
| discover-route.test.js | 9 |
| search-dispatch.test.js | 14 |
| codex-parse.test.js | 10 |
| codex-discover.test.js | 12 |
| codex-schema.test.js | 3 |
| codex-spawn.test.js | 17 |
| codex-search.test.js | 14 |
| css-tokens.test.js | 10 |
| data-provider-attr.test.js | 11 |
| provider-tabs.test.js | 24 |
| settings-providers.test.js | 15 |
| cost-display.test.js | 13 |
| search-render.test.js | 8 |
| dragdrop-provider.test.js | 14 |
| layout-provider-persist.test.js | 7 |
| pty-codex-spawn.test.js | 5 |
| idle-signal-dispatch.test.js | 9 |
| keybindings-dispatch.test.js | 8 |
| idle-signal-parity.test.js | 6 |
| bracketed-paste-isolation.test.js | 7 |
| paste-secure-context-fallback.test.js | 9 |
| codex-settings-route.test.js | 13 |
| pane-context-menu.test.js | 9 |
| project-session-resume-provider.test.js | 11 |
| adhoc-pane-menu.test.js | 8 |
| provider-label-pill.test.js | 8 |
| workspace-group-ux.test.js | 9 |
| codex-status-strip.test.js | 11 |
| codex-discover-watcher.test.js | 2 |
| settings-nav-rail.test.js | 11 |
| pty-resize-ownership.test.js | 7 |
| codex-artifact-path.test.js | 8 |
| idle-notification-gating.test.js | 19 |
| mobile-ux-fixes.test.js | 26 |
| focused-shell.test.js | 28 |
| theme-registry.test.js | 12 |
| experience-model.test.js | 14 |
| experience-ux-contract.test.js | 9 |
| workspace-race.test.js | 10 |
| phantom-tokens.test.js | 8 |
| smooth-scroll.test.js | 20 |
| credential-manager.test.js | 57 |
| credential-deadlock.test.js | 14 |
| credential-routes.test.js | 21 |
| mac-bridge.test.js | 18 |
| usage-meter.test.js | 20 |
| credential-delete-ui.test.js | 12 |
| credential-expiry-ui.test.js | 16 |
| codex-accounts-capability.test.js | 19 |
| provider-account-manager.test.js | 29 |
| provider-account-routes.test.js | 11 |
| provider-account-tabs.test.js | 16 |
| windows-hide-sweep.test.js | 3 |
| git-conflict-cache.test.js | 11 |
| jsonl-tailer.test.js | 14 |
| claude-mirror-parse.test.js | 12 |
| codex-mirror-parse.test.js | 12 |
| mirror-service.test.js | 12 |
| mirror-routes.test.js | 10 |
| mirror-view-state.test.js | 3 |
| copy-secure-context-fallback.test.js | 23 |
| terminal-select-mode.test.js | 23 |
| terminal-host-ownership.test.js | 15 |
| pty-degrade.test.js | 12 |
| terminal-select-v2.test.js | 134 |

P0 adds two files to this list, `notion-token-parity.test.js` and `do-not-break-gates.test.js`, so
the post-P0 baseline is higher. The number that matters for every later phase is the one recorded in
`gate-baseline.json` under `suite`, which is updated only when a phase legitimately adds tests.

### 1.3.1 Where P0 left the suite

| Measure | P0.1 baseline | End of P0 | Delta |
| --- | --- | --- | --- |
| Test files | 77 | **82** | +5 |
| Assertions passed | 1158 | **1308** | +150 |
| Assertions failed | 0 | **0** | 0 |
| `npm test` exit code | 0 | **0** | |

Only 2 files and 30 assertions of that delta belong to P0: `notion-token-parity.test.js` (13) and
`do-not-break-gates.test.js` (17). The other 3 files and 120 assertions belong to the **concurrent**
Codex and terminal tracks, which the contract's parallelisation matrix runs at the same time as the
frontend track: `codex-paths.test.js` (22) and `codex-state-db.test.js` (64) from P8, and
`vt-sidecar.test.js` (34) from P6. P0 and those tracks share `test/run.js` and nothing else, so each
agent appended one line to the `standaloneTests` array and no other file was contended.

Anyone comparing a later phase against this table must therefore compare against 1308 and not against
1158, and must expect the number to keep moving underneath them while P6 and P8 are in flight. The
invariant that matters is the one the standing gate states: **the count never goes down**.

### 1.4 Drift counters, contract claim against measurement

Every counter the contract states was re-measured on unmodified source. All of them match, which is
worth recording: it means `CURRENT-UI.md` and the contract's census can be trusted for the rest of
the program.

| Counter | Contract | Measured | Verdict |
| --- | --- | --- | --- |
| Hex literals, `styles.css` | 316 | 316 | match |
| Hex literals, `styles-mobile.css` | 5 | 5 | match |
| Hex literals, `focused-shell.css` | 1 | 1 | match |
| `border-radius:` numeric literals, `styles.css` | 199 | 199 | match |
| `linear-gradient`, `styles.css` | 5 | 5 | match |
| `backdrop-filter`, `styles.css` | 5 | 5 lines, 6 occurrences (one line carries the prefixed and unprefixed property) | match |
| `translateY`, `styles.css` | 21 | 21 | match |
| JS-coupled classes (DO-NOT-BREAK B.1) | 278 | 278 extracted, 278 present in source | match |
| Verbatim ID list (DO-NOT-BREAK A.3) | 336 | 340 backticked names in A.3; 346 ids authored in `index.html`; 32 A.3 ids are built by JS rather than authored | see 5.4 |

Additional counters measured in P0 because a gate needs them and the contract does not state them:

| Counter | Measured on unmodified source |
| --- | --- |
| Rules carrying a `[hidden]` guard, four stylesheets | 22 after comment stripping (30 raw grep lines) |
| Catppuccin `var()` consumption outside the 13 palette blocks | 1259 after comment stripping (1262 raw) |
| `text-transform: uppercase` across the four stylesheets | 56 |
| Raw colours in `semantic-theme.css` | 0 |
| Hex literals outside a `:root` block | 5 (`styles.css` 1 of 313, `styles-mobile.css` 4 of 4, `focused-shell.css` 0 of 0) |
| `rgba()` and `hsla()` literals outside a `:root` block | 128 |
| Em dashes (U+2014) and horizontal bars (U+2015) in `src/`, `test/`, `scripts/`, `docs/design/notion-restyle/` | **147 occurrences across 30 files**, see 5.8 |
| Prose double hyphens in the frontend and the restyle docs | 11 pre-existing sites, see 5.8 |
| Inline `style="` in `index.html` and `app.js` | not re-measured in P0; the contract's 63 and 182 stand until P4 touches them |

Every number in this second table is recorded in machine-readable form in
`gate-baseline.json` and is enforced as a ratchet by `scripts/do-not-break-gates.js`.
Counts taken after CSS comment stripping differ from a raw `grep -c`, which counts lines rather than
occurrences and counts commented-out code; the gate script's numbers are the authoritative ones
because they are what the ratchet compares against.

---

## 2. Settled decisions carried from the contract

These are the orchestrator's, recorded here so an implementation agent never has to reopen them.
Full text in `BUILD-CONTRACT.md` 0.2.

| # | Decision | One-line form |
| --- | --- | --- |
| D1 | Chrome theming | Notion light and dark on a root attribute, `data-surface="app"` permanent, the 13 Catppuccin palettes become terminal-surface palettes through one `terminalSurface` projection. |
| D2 | Codex SQLite | No new native module. `sql.js` by default, read only, copy before read, filesystem walk stays as a permanent union fallback. |
| D3 | Terminal history | Semantic transcript history with a deliberate one-turn overlap seam. All Select v1, v2, v3 code and tests preserved additively. |
| D4 | Mobile | The 44px touch floor beats mock fidelity. Tablet breakpoint 900px as a flagged constant. |
| D5 | Phase gate | `npm test` green, Playwright screenshots at 1280x800 and 390x844, DO-NOT-BREAK grep gates. Nothing deploys live before the user sees screenshots. |
| D6 | Process | `1.3.0-alpha.N` per phase, `CHANGELOG.md` per phase, one commit per work package with the `Co-Authored-By` trailer, implementation agents never push. |

---

## 3. The questions `PROCEDURE.md` asks, answered

### 3.1 PROCEDURE 0.4, theme count

**Answer: reduced to two chrome themes, Notion Light and Notion Dark, with the 13 existing palettes
retained in full as terminal-surface palettes.** This is decision D1 and it is stronger than the
recommendation `PROCEDURE.md` 0.4 offers: rather than remapping the extra flavours to accent-only
themes, the flavours keep every one of their 24 values and move to the surface where a
Catppuccin palette is actually appropriate, which is the terminal. Chrome stops consuming them.
Nothing is deleted, the picker keeps its component and its `cwm_theme` persistence contract, and
`theme-registry.test.js` keeps passing untouched.

Confirmed before step 2 as `PROCEDURE.md` requires: yes, by D1.

### 3.2 PROCEDURE step 12, art direction

**Answer: adopt the icon and texture half in full; restrict figurative hand-inked illustration to
the login screen and the workbench empty state.** This is the contract's OQ-3 default and it takes
the `CONVERSION.md` section 7 escape hatch for developer products. Everywhere else: no art rather
than placeholder art. One monoline family at one stroke weight, and no icon inside a rounded-square
badge.

Status: **provisional**, see 4.1. It is the default that ships if the user says nothing, and it
carries a measurable cost against the three-second test that the user may want to weigh.

### 3.3 PROCEDURE 5.3, the terminal font

**Answer: `--font-code` for the terminal**, which resolves to
`SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace`; iA Writer Mono for code blocks,
IDs, branch names and diff hunks. This is the contract's OQ-2 default. It is a real captured Notion
token used for exactly this job, it keeps the terminal on native metrics, and it needs no
`DEVIATIONS.md` row. It costs one sanctioned test edit, SE-4.

Status: **provisional**, see 4.1.

---

## 4. Open questions, their defaults, and their status

All five ship on their default if the user says nothing. None of them blocks P0 or P1.

| OQ | Question | Default that ships | Status |
| --- | --- | --- | --- |
| OQ-1 | Chrome theme attribute name | New `data-chrome="light\|dark"` on `<html>`, persisted as `cwm_chrome`, every dark block written as `:root[data-chrome="dark"], :root[data-theme="dark"]` | provisional, needed by P1.4 |
| OQ-2 | Terminal font | `--font-code` | provisional, needed by P5 |
| OQ-3 | Figurative illustration | Icons and texture in full; hand-inked illustration only on login and the workbench empty state | provisional, needed by P12 |
| OQ-4 | Default mobile landing tab | Home | provisional, needed by P10 |
| OQ-5 | Codex P2 scope | Ship P0 and P1 (phases P8 and P9), defer P2, make the first `summarize` handler dispatch through the provider registry rather than deleting the shadowed one | provisional, needed by P9 |

OQ-1 is the only one with a migration cost if it is answered late: changing the attribute name after
P1 ships means a persisted-preference migration for every existing user. It is safe to defer past
P0 and expensive to defer past P2.

### 4.1 What "provisional" means here

The P0 agent recorded these; it did not decide them. Each is the contract's own stated default,
copied verbatim so that a later agent reading only this file behaves identically to one reading the
contract. The user or the orchestrator can overturn any of them at no cost until the phase that
consumes it starts.

---

## 5. Ambiguities resolved during P0, and how

Every entry here is a place where the contract, the brief or the repository disagreed, or where the
contract named an outcome without naming a mechanism. The resolution is recorded so P1 does not have
to re-derive it.

### 5.1 Where the baseline screenshots live

**Tension.** `BUILD-CONTRACT.md` 5.1 says "screenshots go to the session scratchpad, never into the
repository". The P0 brief says the baseline PNGs live at `screenshots/notion-restyle/baseline/`.

**Resolution: `screenshots/notion-restyle/baseline/`, which is already in `.gitignore`.** The
directory is on disk and therefore survives across phases and sessions, which is what "the before
pictures for every later phase" requires, and it is not in the repository in the sense the contract
cares about, because `screenshots/` has been git-ignored since long before this program. A scratchpad
path would be deleted with the session and the comparison corpus would be gone by P2. The harness
takes `--out <dir>` and honours `NOTION_SHOT_DIR`, so a caller who wants the scratchpad can still
have it.

### 5.2 The screenshot harness is a plain Node script, not a Playwright-runner spec

**Tension.** The contract's gate block 4 says `npx playwright test test/browser/notion-shell.spec.js`,
and the file plan names the file `test/browser/notion-shell.spec.js`. The repository has no
`playwright.config.*`. Without a config, `npx playwright test` defaults its `testDir` to the current
directory and its `testMatch` to `**/*.@(spec|test).?(c|m)[jt]s?(x)`, which would sweep up all 77
Node test files in `test/` and try to run them as Playwright specs.

**Resolution: keep the contract's file name, use the repository's existing harness idiom.**
`test/browser/notion-shell.spec.js` is a standalone Node script in the same shape as
`test/browser/workbook-shell.test.js`: it imports `chromium` from `@playwright/test`, spawns its own
sandboxed server child on an ephemeral port, and stops only what it started. It is run with
`node test/browser/notion-shell.spec.js` or `npm run test:notion-shell`. Introducing a Playwright
config in P0 would change how every existing browser test is discovered, which is out of scope and
is exactly the kind of blast radius the contract's phase discipline exists to prevent.

### 5.3 The gates are ratchets, not absolutes

**Tension.** P0's done criterion is "all gates pass on unmodified source, proving they are not
vacuous". But G5 targets "hex literals outside the `:root` block and the theme blocks: 0", G6 targets
"radius literals: 199 to 0", G7 targets "exactly 1 uppercase rule" and G9 targets "5 and 5 down to
0". None of those can be true today, by construction: they describe the end state of P2 to P4.

**Resolution: every countable gate is a ratchet with three numbers**, a baseline measured today, a
target, and the phase the target is due. The gate fails if the measured value moves **away** from the
target relative to the recorded baseline, and reports progress otherwise. Baselines live in
`docs/design/notion-restyle/gate-baseline.json` and are ratcheted down by the phase that improves
them, never up. `--strict` turns the phase targets into hard failures, which is what the final
acceptance sweep in P12 runs.

This preserves the contract's intent exactly: a gate that cannot regress and that must eventually
reach its target, rather than a gate that is red for eleven phases and therefore ignored.

### 5.4 The ID snapshot is sectioned

**Tension.** The contract's G1 diffs `grep -oE 'id="..."' index.html | sort -u` against
`id-snapshot.txt`, while the file plan describes that file as "the 336 pinned IDs". Those are two
different sets: 346 ids are authored in `index.html`, and 32 of the ids `DO-NOT-BREAK.md` A.3 pins
are not authored there at all because JS builds them at runtime (`named-tunnel-*`, `costs-chart-*`,
`modal-field-*`, `wt-review-banner` and 28 more). A snapshot of the A.3 list alone would report 32
removals on unmodified source and the gate would be red from the first run.

**Resolution: one file, two sections.** `[static]` holds the 346 ids authored in `index.html`, each
of which must keep appearing there. `[dynamic]` holds the 32 A.3 ids that JS builds, each of which
must keep appearing as a literal in `app.js`, `terminal.js`, `mirror-view.js` or `schedules.js`.
Lines starting with `#` are comments. Both halves are checked by G1, additions are allowed anywhere,
removals fail. The result is a strictly larger protected set than either reading of the contract
gives on its own: 378 ids rather than 336 or 346.

### 5.5 The parity test scopes what it compares, and to which theme

**Three problems with a naive "every token in `styles.css` must equal the bundle" comparison:**

1. **Five names already collide.** `--border`, `--radius-sm`, `--radius-md`, `--radius-lg` and
   `--font-mono` exist in both the project's `styles.css` and the vendored bundle **with different
   values**, today, before anything is touched. They are not the same tokens; they are the project's
   legacy names that happen to share a spelling with Notion's. Table C of the contract re-points them
   to bundle-derived values through `var()`, which is deliberately not the same thing as adopting the
   bundle's raw value for that name. A naive comparator fails on all five on unmodified source.
2. **170 bundle names carry two values**, one light and one dark. A flat name-to-value map is wrong.
3. **Three tokens are inventions** and by definition are not in the bundle: `--app-on-accent`,
   `--app-scrim`, `--app-terminal-gutter`.

**Resolution.** `test/notion-token-parity.test.js` builds two maps from the bundle, light and dark,
by classifying each block by its selector and at-rule context. It compares only names in the
`--app-*`, `--radius-*`, `--duration-*`, `--ease-*`, `--motion-*` and `--font-*` families, only
outside the 13 palette blocks, and it excludes two documented lists: `LEGACY_COLLIDING_NAMES` (the
five above, frozen in P0, which may only shrink) and `INVENTED_TOKENS` (the three above, which must
appear in `INVENTIONS.md`). Today that leaves zero comparisons, so the test passes trivially exactly
as the contract requires, while the parts that are load-bearing today (bundle integrity, and every
`var()` in the vendored `components.css` resolving) do real work: 258 distinct custom properties are
resolved on every run.

A separate assertion enforces that the five legacy names stay **defined** in `styles.css`, so the
exclusion list can never be used as a route to deleting a token.

### 5.6 Verification that the contract's token names exist

All 71 `--app-*`, `--radius-*`, `--font-*`, `--duration-*`, `--ease-*` and `--motion-*` names the
contract's token map cites were checked against the vendored bundle in P0. Exactly three are absent,
and they are precisely the three the contract already declares as inventions. Every other name the
contract promises P1 is real and spelled correctly. P1 can trust the token map.

### 5.7 A thirteenth gate, for the `data-*` contract

Rule 4 of `BUILD-CONTRACT.md` 0.4 is "never drop a `data-*` attribute", and no gate in 5.3 enforces
it. G13 does: the 46 attribute names `DO-NOT-BREAK.md` B.2 calls out must each still appear in the
five frontend sources, in either attribute form (`data-view-mode`) or `dataset` form (`viewMode`).
Three of them (`data-td-id`, `data-theme-appearance`, `data-view-mode`) only ever appear in
`dataset` form today, which is why the gate accepts both. This raises the floor and lowers nothing,
per authority rule 0.1 item 4.

### 5.8 The scope of the em-dash gate, and a correction

**A first measurement of this was wrong and is corrected here.** A `grep -rlP "\x{2014}"` from Git
Bash returned no hits, which looked like a clean tree. It was a false negative: the same scan in
Node finds **147 em dashes across 30 files**, including `styles.css`, `app.js`, `schedules.js`,
`store.js` and `supervisor.js`. Most are in code comments, but not all: `schedules.js:336` builds
the user-facing string `Skipped ${count} - ${reason}` with a real em dash, and `app.js:13090`
renders `&mdash;` as the content of the no-cost session badge. Do not trust a `grep -P` for a
non-ASCII codepoint on this machine.

So G12 has two halves, because a single repo-wide zero rule cannot pass today.

**G12a** counts em dashes and horizontal bars across `src/`, `test/`, `scripts/` and
`docs/design/notion-restyle/`. Baseline 147, and the number may **never grow**. It carries no phase
target, because removing the existing 147 is a copy change rather than a restyle change and belongs
to the copy pass in `PROCEDURE.md` step 11.

**G12b** is the contract's actual gate, "scan changed files: 0". It scans only the lines this
program **adds** relative to the recorded baseline commit, and fails on an em dash, a horizontal
bar, or a double hyphen used as prose punctuation. Currently 0.

One implementation note worth keeping: the gate script originally tripped its own scan, because the
character class in its own regex literal counted as two em dashes in `scripts/`. The regex is
written with `\u2014` and `\u2015` escapes for that reason. A scanner that matches itself is a
scanner that can never reach zero.

The 11 pre-existing prose double hyphens, recorded so nobody re-discovers them: `app.js` lines 7711,
7723, 7776, 7797, 7948, 16701, 20570, and `index.html` lines 1629, 1630, 1631. Four of those are
user-facing strings (`index.html` 1629 to 1631 in the agent-teams help text, `app.js` 7711 and 7797
in kanban card copy). Same disposition: the copy pass owns them, not a gate.

---

## 6. Pre-existing defects found during P0, not fixed here

An implementation agent that finds a broken thing outside its work package reports it rather than
fixing it, per `BUILD-CONTRACT.md` 4.1 item 7.

| # | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| F1 | **CLOSED in P1.6.** The orchestrator blessed the fix as SE-11 and the two assertions were brought to the current values inside the same atomic cachebuster bump. `npm run test:workbook-shell` now passes, and gate G10b reports clean. Original finding follows. The browser lane is red before the restyle touches anything. `test/browser/workbook-shell.test.js` lines 366 and 367 assert `terminal.js?v=20260727-copy-native8` and `app.js?v=20260727-copy-native8`, but `index.html` serves `terminal.js?v=20260806-selectv3` and `app.js?v=20260805-mobile-select1`. The assertions were not updated when the Select v3 and mobile-select cachebusters landed. | `grep -n "copy-native8" test/browser/workbook-shell.test.js src/web/public/index.html` | This is a fourth file in the G10 atomic set that the contract's list does not name. Gate G10 reports it as a warning rather than failing, because failing would make an unmodified-source gate red. The orchestrator should either fix those two lines (a one-line-each test edit outside the sanctioned list, so it needs an explicit blessing) or add the file to SE-7. Until then `npm run test:workbook-shell` cannot pass. |
| F2 | The `--text-tertiary` Latte-only override at `focused-shell.css:30` is already inert and is pinned verbatim by `focused-shell.test.js`. | contract 1.3 | No action. Recorded so P1 does not "fix" it. |

---

## 7. Deferrals

Nothing is deferred yet. Rows that reach `5.5.1` as `○` without a route land here, one per row, with
a reason.

---

## 8. What P0 shipped, and what P1 inherits

### 8.1 Artifacts

| Path | What it is |
| --- | --- |
| `src/web/public/design/notion/**` | The vendored bundle. Tokens, provenance JSON, the `nt-*` paint layer, both font families, and a README stating the not-linked rule. Nothing links to it yet. |
| `test/notion-token-parity.test.js` | Bundle integrity, `components.css` `var()` resolution, and the `styles.css` to bundle value diff. 13 assertions. |
| `test/do-not-break-gates.test.js` | Runs the gates inside `npm test`. 17 assertions. |
| `scripts/do-not-break-gates.js` | G1 to G13. `--strict`, `--json`, `--record`. Also available as `npm run gates`. |
| `scripts/test-assertion-count.js` | Normalises the suite's five summary formats into one comparable number. |
| `docs/design/notion-restyle/gate-baseline.json` | Every recorded baseline, target and target phase. |
| `docs/design/notion-restyle/id-snapshot.txt` | 346 static plus 32 dynamic ids. |
| `docs/design/notion-restyle/class-snapshot.txt` | 278 JS-coupled class names. |
| `test/browser/notion-shell.spec.js` | The screenshot and metric harness. `npm run test:notion-shell`. |
| `screenshots/notion-restyle/baseline/` | 8 before pictures plus `manifest.json`. Git-ignored, on disk. |

### 8.2 The numbers P1 and P2 have to move

Measured on the baseline screenshots, so these are what the restyle actually has to change, not what
a stylesheet claims:

| Metric | Baseline (P0) | Target | Due |
| --- | --- | --- | --- |
| Header height, desktop | 58px | 44px | P2 |
| Header height, phone | 50px | 44px | P2, P10 |
| Sidebar width | 264px | 240px, with an inset right edge rather than a border | P2 |
| Body ink, dark | `rgb(205, 214, 244)` | `#f0efed` | P1 |
| Body ink, light | `rgb(76, 79, 105)` | `#2c2c2b`, never `#000000` | P1 |
| Body font | `"Plus Jakarta Sans", system-ui, ...` | starts with `ui-sans-serif` | P1.2 |
| `.btn` radius | 10px | 6px, and chips at 4px must measure differently from cards at 10px | P2, P3 |
| External origins requested | `fonts.googleapis.com` | none | P1.2 |

### 8.3 Three traps P1 should not have to rediscover

1. **The parity test compares per chrome theme.** Author light values in `:root` and dark values in
   a block whose selector carries `[data-chrome="dark"]` or `[data-theme="dark"]`. A dark value
   authored anywhere else is read as a light value and the diff will fail.
2. **The eight pre-existing project tokens are excluded from the diff and must stay defined.**
   Re-point them per table C. Do not delete `--radius-xl`; retire it by alias.
3. **A cachebuster bump is a five-file atomic change**, and G10 checks four of them.
   `test/browser/workbook-shell.test.js` is the fifth and is already stale, see F1.

All three traps were hit and cleared in P1. Trap 1 cost one design decision (the reduced-motion
block, 9.2.2); trap 2 cost nothing, the eight names were re-pointed as written; trap 3 cost the
SE-11 authorisation and closed F1.

---

## 9. Phase P1, the token foundation

### 9.1 What shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| P1.1 | `fff6747` | `styles.css`, `test/css-tokens.test.js` | The Notion `:root` token block, the reduced-motion block, the dark chrome block, and the alias flip for tables B, C and D. Sanctioned edit SE-1. |
| P1.2 | `973ea9b` | `design/notion/fonts.css` (new), `index.html`, `terminal.js`, `test/terminal-select-v2.test.js` | Five self-hosted `@font-face` blocks, the Google Fonts link and both preconnects gone, three terminal font strings on tokens. Sanctioned edit SE-4. |
| P1.3 | `a437a2a` | `semantic-theme.css` | Table E, every right-hand side onto the chrome layer. No test edit needed. |
| P1.4 | `cca5d4a` | `index.html`, `app.js` | `data-surface="app"`, `data-chrome`, pre-paint stamping, `cwm_chrome`, `setChrome()`, `syncThemeColorMeta()`, the `theme-color` pair. No test edit needed. |
| P1.6 | `e7a1c88` | `index.html`, four test files | `components.css` linked before `styles.css`, cachebusters bumped atomically to `20260813-notion-p1`. Sanctioned edits SE-7 and SE-11. |

There is no P1.5 commit. Its content, the sanctioned test edits, shipped inside the commits that
made the source changes those edits describe, which is what contract 5.4 requires. See 9.3.3.

Two corrections to the commit messages themselves, recorded here because rewriting six unpushed
commits would invalidate the hashes this table cites. The `fff6747` message states that `styles.css`
grew to 12784 lines; the measured figure is **12773**, and the table in 9.4 is authoritative. The
same message states the file grew "from 12202", which is correct. And P1.1's parent is `c5cf7c1`
rather than `fe06712`: the concurrent Codex track committed four times into this branch while P1 was
in progress. None of those four touches a frontend file.

### 9.2 Ambiguities resolved during P1

#### 9.2.1 The bundle's numeric radius ramp cannot be copied at all

**Tension.** Table C re-points `--radius-lg` to `var(--radius-popover)`, and the bundle defines
`--radius-popover: var(--radius-12)`. `phantom-tokens.test.js` then requires `--radius-12` to be
defined in `styles.css`, and the parity gate requires whatever is authored to equal the bundle's
value for that name. The bundle's value for `--radius-12`, read the way the parity gate reads it, is
`0`: its own `.mkt-theme-academic, .mkt-theme-serif` block re-declares all ten ramp names as zero,
and last definition in source order wins.

So all three of the obvious moves fail. Authoring `0.75rem` fails the parity diff. Authoring `0`
ships square corners. Authoring `--radius-popover: 12px` fails the diff too, because the bundle's
value for that name is the string `var(--radius-12)`, not `12px`.

**Resolution: author neither.** The ramp and the twelve aliases built on it are not authored. The
project consumes the capture's literal-valued semantic radii, which cover the whole Notion editor
set (3.5, 4, 6, 10, 100 percent), and `--radius-lg` carries a literal `12px` with a comment at the
definition site. Recorded as `DEVIATIONS.md` DV-4. Sixteen bundle names were found to carry this
last-wins hazard; the other six are handled in 9.2.2.

**P2 consequence:** the radius sweep has every token it needs. It does **not** have
`--radius-popover`, `--radius-card`, `--radius-menu-item` or `--radius-button`. Use
`--radius-callout` (10px) for cards and callouts, `--radius-app-button` (6px) for buttons,
`--radius-property-chip` (4px) for chips, and `--radius-lg` (12px) where the popover radius is
wanted.

#### 9.2.2 Four motion tokens are only correct if the reduced-motion block is authored too

The same last-wins hazard hits `--motion-card-hover`, `--motion-illustration-enter`,
`--motion-marquee` and `--motion-long-fade`, whose winning bundle value comes from the bundle's own
`@media (prefers-reduced-motion: reduce)` block. Here, unlike the radius case, reproducing the
cascade is the *right* thing rather than a workaround: `PROCEDURE.md` step 10 requires decorative
motion to be authored so that reduced motion removes it. So `styles.css` carries the full value in
`:root` and the reduced value in a `@media (prefers-reduced-motion: reduce) { :root { ... } }` block,
exactly as the capture does. The parity diff reads the same last definition and matches. Flattening
to the reduced value would have passed the gate and shipped four dead animation tokens.

Three further names, `--font-body`, `--font-display` and `--font-features`, have a benign version of
the same conflict: their winner comes from the bundle's `[data-surface="app"]` block, which is the
surface this project is on, so the winner is what should be authored anyway.

#### 9.2.3 Contract 1.7's premise about the terminal font strings is not true of this source

1.7 says `terminal.js:4047` carries `font: 11px/1.4 'Plus Jakarta Sans'` "with **no fallback**", and
warns that deleting the Google Fonts link "leaves those two strings with no fallback family and both
surfaces fall back to Times. This is a real bug the font step would otherwise introduce."

Measured: all three strings already carry fallbacks (`system-ui, sans-serif` on the two sans sites,
`'Cascadia Code', Consolas, monospace` on the mono site). The bug does not exist and removing the
link was safe with or without the change. The three edits were made anyway, because the contract
specifies them and `DECISIONS.md` 3.3 fixes the terminal on `--font-code`, but they are **fidelity,
not a bug fix**, and no phase should treat the removal of a webfont link as blocked on them.

Six further `'Plus Jakarta Sans'` strings exist in `terminal.js` (lines near 4372, 4393, 4410, 4426
and 5169) and one xterm `fontFamily` at 1233. None is named by 1.7 and none was touched. All six
carry `system-ui, sans-serif` fallbacks so none regressed. The xterm one at 1233 is the actual
terminal font and belongs to P5 with the `terminalSurface` projection, because changing it changes
column metrics.

#### 9.2.4 Table E gives the running state two different hues

`--status-running` keeps `var(--color-info)`, which resolves to `--app-text-blue`, while table E
gives `--status-running-surface` the value `var(--app-bg-green)`. A blue ink on a green wash is
incoherent, and 1.9 C5's supporting sentence ("Green is running") suggests the intended end state is
a green running ink.

**Not settled here**, because it belongs to the phase that builds the status system, and because it
is currently inert: of the five `--status-*-surface` tokens only `--status-needs-input-surface` has
a consumer anywhere in the source (`focused-shell.css:687`), and that one is coherent (yellow on
yellow). P1 shipped table E exactly as written. **P3 or P4 must decide** whether running is blue
(and its wash becomes `--app-bg-blue`) or green (and `--status-running` stops pointing at
`--color-info`). Either is a one-line change in `semantic-theme.css`.

#### 9.2.5 The chrome default reads the palette's signal, not its own

1.1.2 says `data-chrome` defaults "from `prefers-color-scheme`", which admits two implementations.
The bootstrap already computes `prefersLight` for the palette default, so the chrome default reuses
**that same variable** rather than querying `(prefers-color-scheme: dark)` separately.

The difference only shows up on a browser that supports neither query, where both queries return
false: a separate dark query would give light chrome while the palette default gives Mocha, which is
a dark palette. That is precisely the combination that looks worst between P1 and P4, because it
puts the new dark ink on the un-swept Catppuccin dark surfaces. Sharing the signal makes chrome and
palette agree on every fresh profile by construction.

### 9.3 Scope decisions, and what was deliberately left alone

#### 9.3.1 `focused-shell.css` was not touched, and it re-derives two of the flipped aliases

Table B says the `--border-subtle` and `--text-muted` re-derivations in `focused-shell.css` "also
re-point". The file plan (3.2) assigns that file to **P2**, and the P1 work-package table gives it to
no one. It was left alone.

The consequence is concrete and P2 owns it: `:root[data-ui-shell="focused"]` at `focused-shell.css:24-26`
overrides `--text-muted` and `--border-subtle` with palette-derived `color-mix()`, and
`data-ui-shell` is always set, so those two aliases stay Catppuccin for **95 consumption sites**
(36 and 59) despite the `:root` re-point. `focused-shell.css:38` likewise still paints the header
with `color-mix(in srgb, var(--mantle) 94%, var(--base))`, which is why the header band in the P1
screenshots is still the palette colour rather than the chrome ground.

#### 9.3.2 The twelve palette blocks still override four chrome tokens

File-plan rule 6 freezes the 12 `:root[data-theme="<id>"]` blocks through P1 and P2. Each of them
re-declares `--border-subtle` and all four `--shadow-*` tokens with literals, so on any non-Mocha
palette those five re-points are shadowed. On Mocha, which is the base `:root`, all five hold. This
is C7's "retire in place" work and it lands with the elevation sweep.

#### 9.3.3 Four of the six sanctioned edits P1.5 lists were not made

SE-2, SE-3, SE-5 and SE-6 retarget assertions over **call sites** in `styles.css`, not over token
definitions. P1 changed no call site, so all four tests pass unedited, and making the edits would
have asserted values that do not exist yet. Contract 5.4 requires each sanctioned edit to ship in the
same commit as its source change, and 4.1 item 7 forbids editing a test that is not broken. Recorded
as `DEVIATIONS.md` DV-6, with the phase each edit moves to.

### 9.4 The numbers

| Measure | Before P1 | After P1 |
| --- | --- | --- |
| Bundle-family tokens compared by `notion-token-parity.test.js` | **0** (trivially passing) | **319** |
| `styles.css` lines | 12202 | 12773 |
| `semantic-theme.css` lines | 93 | 137 |
| `index.html` lines | 2006 | 2102 |
| `terminal.js` lines | 5275 | 5286 |
| `app.js` lines | 25695 | 25771 |
| Gate G4, Catppuccin `var()` in chrome | 1259 | **1229** |
| Gate G10b, stale browser-lane pins | 1 (WARN) | **0** (PASS) |
| G3, G5a, G5b, G6, G7, G8, G9a, G9b, G11, G12a, G12b | unchanged | unchanged |
| External origins requested on a cold load | `fonts.googleapis.com` | **none** |
| Test files / assertions | 82 / 1315 | 82 / **1317** |

The +2 assertions are **not** P1's: they come from the concurrent Codex track
(`codex-state-db.test.js`, 64 to 66). P1's own delta is **zero added and zero removed**. It retargeted
13 existing assertions in five files (SE-1 six, SE-4 one, SE-7 four, SE-11 two) and deleted none.

Measured against the P1 gate additions in contract 5.2:

| Gate addition | Result |
| --- | --- |
| `getComputedStyle(document.body).fontFamily` starts with `ui-sans-serif` | yes, all 8 shots |
| Zero requests to `fonts.googleapis.com` or `fonts.gstatic.com` | yes, `manifest.externalRequests` is `[]` |
| Body ink `#2c2c2b` light | yes, `rgb(44, 44, 43)`, was `rgb(76, 79, 105)` |
| Body ink `#f0efed` dark | yes, `rgb(240, 239, 237)`, was `rgb(205, 214, 244)` |
| Never `#000000` | yes |
| Toggling `data-chrome` leaves no orphaned surface | see 9.5 |
| **Reverting this phase alone restores the previous appearance completely** | **verified by reverting, not assumed.** On a scratch branch, `git revert --no-commit` of all six P1 commits produced a tree whose `src/web/public/` is **byte-identical** to `fe06712`: a `git diff` of the reverted tree against that commit, scoped to `src/web/public/`, returns nothing. `fe06712` is four commits behind P1.1 because the concurrent Codex track committed in between, but those four touch `src/providers/`, `src/web/server.js`, `package.json`, two of their own tests and one of their own docs, and not one frontend file, so the comparison is exact. Since appearance is a pure function of those files, the restoration is exact rather than approximate. The scratch branch was deleted and the working tree restored; the concurrent tracks' uncommitted work was untouched throughout. |

Every file P1 touched grew. No file shrank, in line with the code-preservation rule: the three
removed `<link>` tags in `index.html` are recorded in a comment rather than dropped, and
`--radius-xl` and `--shadow-md` are RETIRED-with-alias rather than deleted.

### 9.5 The P1 screenshots, and an honest reading of them

`screenshots/notion-restyle/p1/`, eight shots plus `manifest.json`, same matrix as the baseline.
The harness now reports `chrome=light` and `chrome=dark` rather than falling back to the appearance
choice, so from P1 the matrix captures the real chrome themes.

What is right: the ground and the ink are Notion's in both chromes, the type is the OS UI stack, code
and paths are iA Writer Mono, layout is byte-identical to the baseline (header 58px, sidebar 264px,
no horizontal overflow at either width), and nothing is unreadable in any of the eight.

What is still Catppuccin, all of it expected and all of it owned by a later phase: the header band
(9.3.1), the primary button fill, the tab underline, the sidebar project accents and the session
badges. These are direct `var(--mauve)` and friends at call sites, which is the 1229 that G4 still
counts and which P2 to P4 sweep.

One observation that is **not** a P1 defect: in the light workbench shot the sidebar "New Session"
button and the active "Workbench" nav pill read as low-contrast grey on grey. The P0 baseline shot
shows the identical rendering, so it predates the restyle. Worth fixing when P2 reaches those two
components.

### 9.6 What P2 inherits

1. A complete chrome token layer in `styles.css` `:root`: 319 bundle-verbatim tokens plus 3 documented
   inventions, light values in `:root`, dark values under `:root[data-chrome="dark"], :root[data-theme="dark"]`,
   and a parity gate that fails on any drift. Add a token by adding it to the generated block **with
   the bundle's value**; the gate will tell you immediately if you paraphrase.
2. The alias layer already pointing at it. `--bg-primary`, `--text-primary`, `--accent`, `--border`,
   `--radius-sm`, `--transition-fast`, `--shadow-lg` and the rest resolve to Notion values with no
   call-site change, so P2 can restyle a region by editing its rule bodies alone.
3. `data-chrome` live, persisted, defaulted, stamped pre-paint, and switchable at runtime through
   `window.cwm.setChrome(chrome, { persist })`. The screenshot harness already drives it.
4. Two files P2 must touch early, because they currently shadow the chrome layer:
   `focused-shell.css:24-26` (95 sites, 9.3.1) and `focused-shell.css:38` (the header band).
5. The five radius tokens re-pointed and ready for the 199-literal sweep, with the caveat in 9.2.1
   about which names exist.
6. `design/notion/components.css` linked before `styles.css`. Its `.nt-*` classes are inert because no
   markup carries them yet, and the non-bundle-family tokens it consumes (`--space-*`, `--text-*-size`,
   `--mkt-*`) are **not** authored in `styles.css`. P2 authors whichever of those it actually uses.
7. One open decision handed forward: 9.2.4, the running-state hue.
## 10. Phase P2, the Notion shell

### 10.1 What shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| P2.1 | `e43ee76` | `styles.css`, `focused-shell.css`, `INVENTIONS.md` | The 44px topbar, the focused-shell chrome-token reconciliation (9.3.1), the four geometry tokens onto the chrome layer, the view-tab pill recipe, `--radius-pill` and `--radius-pane-frame`. |
| P2.2 | `743857c` | `styles.css`, `focused-shell.css` | The 240px warm sidebar, the inset edge, 27px rows, sentence-case section labels, and four accent bars removed. |
| P2.3 | `a2badb2` | `styles.css`, `focused-shell.css` | The radius sweep. Gate G6 199 to 0. |
| P2.4 | `3692d34` | `styles.css` | The elevation sweep, plus the 48-rule per-theme literal tail retired in place (contract C7). |
| P2.5 | `6fb6ef0` | `styles.css`, `focused-shell.css` | The motion sweep, and the two named motion patterns. |
| P2.6 | `046475a` | `styles.css` | Selection, focus ring, focus coverage, the 7px scrollbar, the application type scale. |
| P2.6b | `6e33783` | `styles.css`, `focused-shell.css`, `DEVIATIONS.md` | What looking at the eight screenshots found: the muted-ink re-pairing, the sidebar tab strip, the mobile tab inks, and the five P2 deviation rows. |

There is no P2.7 commit. See 10.3.1.

### 10.2 Ambiguities resolved during P2

#### 10.2.1 `--text-muted` was mapped to a token no call site wanted

Contract table B maps `--text-muted` to `--app-text-disabled`. P1 shipped that at `:root`, but
`focused-shell.css:25` re-derived the token from the palette and `data-ui-shell` is always set, so
the mapping had **never rendered**. P2.1 removed the mask and the value reached all 29 consumption
sites at once, at which point it was obviously wrong: every one of the 29 is meta, hint or label copy
on a live interactive surface and not one is a disabled control, and `#bcbab6` on `#ffffff` measures
about 1.9:1 against a 4.5:1 floor.

Resolved by re-pairing the token onto `--app-text-tertiary`, which is what contract 1.2's own
analysis predicts ("Notion collapses this project's four ink steps onto three") and what
`PROCEDURE.md` 4.2 requires (re-pair, never darken). Recorded as `DEVIATIONS.md` DV-10.

**This is the general shape of the risk P1 left behind.** Any table-B mapping that
`focused-shell.css` was shadowing had been unverified until now. `--border-subtle` was the only other
one and it is correct at `--app-border-secondary`.

#### 10.2.2 The universal focus ring cannot be a box-shadow

`DESIGN-SPEC.md` 1.5 gives three box-shadow ring tokens. A universal `:focus-visible` box-shadow
would replace the box-shadow every card, menu, pane and popover already carries the moment it took
focus, and the two focus rules the suite PINS are outlines, so it would also ship two competing
idioms. The universal ring stays an outline, re-pointed and tightened to a 1px offset; the captured
ring tokens are used per component, starting with `--app-input-focus-ring` on `.input:focus`.
`DEVIATIONS.md` DV-8.

The more valuable half of P2.6 was coverage, not colour: **seventeen controls carried a bare
`outline: none`**, several on the resting rule rather than on `:focus`, so they had no keyboard ring
at all. The new `:is(...)` rule scores (0,1,1), which outranks a single-class `outline: none` and
still loses to any control with its own focus treatment at (0,2,0).

#### 10.2.3 The mock's scrollbar line would have disabled the mock's scrollbar

`DESIGN-SPEC.md` 1.5 ends the scrollbar recipe with a bare universal `scrollbar-width: thin` next to
five `::-webkit-scrollbar` rules. Chromium ignores every `::-webkit-scrollbar` declaration as soon as
`scrollbar-width` is set to anything but `auto`, so shipping both verbatim would have silently
dropped the 7px thumb on this application's primary engine. It ships inside
`@supports not selector(::-webkit-scrollbar)`. `DEVIATIONS.md` DV-7.

#### 10.2.4 `ctx-in` was a real positioning bug, not only an off-brand entrance

`app.js:18568` unhides the context menu and reads `getBoundingClientRect()` immediately to clamp it
against the viewport. `getBoundingClientRect()` returns the **transformed** box, and `ctx-in` started
the menu at 95 percent scale, so the clamp had always been computing from a rect 5 percent smaller
than the menu would settle at. Contract 2.4's 4px limit is the fix and it is why the limit is not
merely aesthetic. Every entrance in the sheet is now opacity plus a translate of at most 4px, with no
scale anywhere.

#### 10.2.5 Two dynamic tokens needed new homes when their bars were removed

`phantom-tokens.test.js` asserts allow-list hygiene: every `DYNAMIC_TOKENS` entry must still be
consumed. `--ws-color` had exactly one consumption site, the 3px left bar on the selected workspace
row, and `--ws-group-color` had one, a 4px inset left bar. Both bars are the idiom 2.12 removes.

`--ws-color` moved to `.workspace-color-dot`, where `renderWorkspaces` already writes the identical
value inline, so the custom property is now the declared default and the inline style is the instance
value. `--ws-group-color` moved into a full 1px hairline at a 35 percent mix, which is the pane-frame
idiom from 2.12 applied to a row: the hue identifies rather than brackets. Neither token lost its
consumption site and neither bar survived.

### 10.3 Scope decisions, and what was deliberately left alone

#### 10.3.1 P2.7 and the `app.js` half of P2.1 and P2.5 did not ship

This agent's ownership set for the phase was `styles.css`, `focused-shell.css`, the screenshot
harness and the gate baseline, with a second agent working in the same worktree. `app.js` and
`instance-colors.js` were not in it. Three contract items therefore did not ship: the header stats
popover (P2.1), the `nt-enable-hover` scroll and drag strip (P2.5), and **the whole of P2.7**.

P2.7 is the significant one. `TAB_COLORS`, `PANE_SLOT_COLORS`, `_tagColor`, `FOLDER_COLORS` and
`colorMap` still build palette `var()` strings by concatenation, so tab dots, pane tints, folder
tints, workspace accents and user tags all render in the **terminal theme's** hues, which
`DESIGN-SPEC.md` 10.4 forbids. This is risk R11, it is visible in every P2 screenshot as the mauve
and teal workspace dots and the coloured tag chips, and gate G4 still counts it. It is a
self-contained change (keep the pinned arrays byte-identical, add a name-to-token map used only at
string-build time) and it is the largest single item P3 inherits. `DEVIATIONS.md` DV-9.

#### 10.3.2 `styles-mobile.css` was swept and then reverted

The radius sweep initially included it. It was reverted: the file belongs to the mobile track (P10
and P11), gate G6 does not measure it, and `mobile-ux-fixes.test.js` pins a literal zero radius
inside it. Sweeping another track's file to satisfy a gate that does not cover it is exactly the
collision contract 4.1 item 4 exists to prevent.

#### 10.3.3 Two tab families moved early, four did not

`.view-tab` and `.sidebar-tab` took the pill recipe in P2 because both sit inside a region P2 had to
re-geometry and both carried a rejection-list idiom that would have dominated this phase's
screenshots. The other four families are untouched and P4.4 still owns them. `DEVIATIONS.md` DV-11.

#### 10.3.4 The page measure was not applied

`--focused-content-max` is re-pointed to the 1100px Sessions and Costs measure and currently has zero
consumers. Applying it is a region change that belongs to P4, and at the capture width it would make
no visible difference anyway: 1280 minus the 240px sidebar leaves a 1040px main column, already inside
the measure. The only visible part would be the page padding, which is region work.

### 10.4 The numbers

| Measure | After P1 | After P2 |
| --- | --- | --- |
| `styles.css` lines | 12773 | **13168** |
| `focused-shell.css` lines | 1391 | **1477** |
| Gate G6, numeric `border-radius` literals | 199 | **0** |
| Gate G8, `translateY` occurrences | 21 | **17** (7 centring, 10 entrance, zero hover lifts) |
| Gate G5b, raw `rgba()` outside `:root` | 128 | **82** |
| Gate G4, Catppuccin `var()` in chrome | 1229 | **1127** |
| Gate G7, uppercase labels | 56 | **52** |
| Literal (non-token) `box-shadow` values in `styles.css` | 43 | **0** |
| Test files / assertions | 82 / 1317 | 82 / **1317** |

P2's own assertion delta is **zero added, zero removed and zero retargeted**. No sanctioned test edit
was needed: every change was a rule body, and the anchors the suite reads (selectors, single-line
rules, cachebusters, the two pinned focus rules, the three frozen templates) were all preserved.
Both stylesheets grew; neither shrank.

Measured against the P2 gate additions in contract 5.2:

| Gate addition | Result |
| --- | --- |
| Topbar measures 44px | **yes**, all four desktop shots. Phone is 50px, which is the focused shell's own mobile override and P10's to revisit. |
| Sidebar measures 240px | **yes**, all four desktop shots |
| Its right edge is an inset shadow, **not** a border | **yes**, machine-checked: `border-right-width` computes to `0px` and `box-shadow` carries `--app-sidebar-edge`. The harness now reports both. |
| The drag still works and still persists | unchanged by construction: `#sidebar` is still an element whose `width` property controls its size, the inline style the drag writes still wins, and the 180 to 600 clamp and `cwm_sidebarWidth` were not touched |
| `border-radius:` literal count is 0 | **yes**, G6 |
| Shadow-carrying elements on the default screen are in single digits | **yes**, machine-checked: **1** on the Sessions view and **2** on the Workbench. The sidebar's own edge hairline, plus `.workbench-empty-icon`, which is the rounded-square icon container P4.5 and P12.4 remove. |
| Fade in 150ms and fade out 200ms, in that asymmetry | **yes**, `--transition-fast` is 150ms with `--ease-out` and `--transition-normal` is 200ms with `--ease-in`, both from P1 and both unchanged |
| Nothing animates on scroll | **yes**, no scroll-triggered animation exists in the sheet |
| No block moves, scales or lifts on hover | **yes**, both hover lifts removed; G8's 17 survivors are 7 centring translates and 10 overlay entrance steps |
| Hover washes do not flash under the cursor while a list scrolls | **NO.** This needs the `nt-enable-hover` strip, which is app.js work. DV-9. |
| Nothing scrolls horizontally at 320, 768, 1024, 1440 | **yes**, machine-checked: the harness now probes all four widths and asserts zero overflow |
| The terminal grid, sessions table and kanban board are **not** capped at 720px | **yes**, no measure was applied to any of them (10.3.4) |

### 10.5 The P2 screenshots, and an honest reading of them

`screenshots/notion-restyle/p2/`, eight shots plus `manifest.json`, the same matrix as the baseline
and P1.

**What reads as Notion now.** The chrome stack is gone: there is one 44px bar with no ground of its
own, one hairline, and then content. The sidebar is a warm sheet a half-step off the canvas with an
inset edge, 27px rows, sentence-case section labels and quiet inline counts. Selection and active
state are a wash plus ink weight, consistently, in both the top bar and the sidebar. There is not a
single coloured bar, underline or left stripe left in the shell. The canvas is genuinely flat: two
shadowed elements on the busiest default screen, one of which is the sidebar's own edge. Corners are
coherent, scrollbars are hairlines, and the type is the OS UI stack on the application scale.

**What still reads as the old design**, top deltas first, each with the phase that owns it:

1. **The primary buttons are still Catppuccin mauve.** "Start session" and "+ New" are the loudest
   colour on every one of the eight shots and the single biggest remaining tell. **P3.1.**
2. **Tag chips are palette-coloured 9px mono pills.** Two owners: the chip recipe is **P3.2**, and
   the hue comes from `_tagColor`, which is the unshipped **P2.7** (DV-9).
3. **Tab dots, pane tints, folder tints and workspace accents all still read the terminal palette.**
   The mauve and teal workspace dots in the sidebar are the visible instance. **P2.7**, unshipped,
   DV-9. This is risk R11.
4. **The terminal group tab is a bordered pill with a coloured dot and a coloured underline.**
   **P4.4**, with its dot colour from P2.7.
5. **The empty-state art slot is a line icon in a rounded square**, which 2.12 names explicitly as
   the thing never to do. It is also the only non-sidebar shadow on the default screen. **P4.5** and
   **P12.4.**
6. **The topbar has no breadcrumb.** `DESIGN-SPEC.md` 4 draws breadcrumb, spacer, account chip, two
   icon buttons. What ships is logo, account chip, centred view tabs, search icon. The geometry is
   right and the contents are the old ones; changing them needs `index.html` and `app.js`. **P4**, or
   the orchestrator.
7. **The Sessions view is a bespoke list, not the measured database table** (36px header, 32px rows,
   `--app-table-cell-border` hairlines, the 2.4 percent row wash). **P4.3.**
8. **Project rows in the tree are italic monospace grey**, which is neither a section label nor a row
   in this system. **P4.**
9. **The phone is still the old IA**: a 50px header with a hamburger, four bottom tabs rather than
   five, and no Home screen. **P10.**
10. **The scrolled-topbar shadow never appears** and hover washes can still flash during a scroll.
    Both need app.js listeners. **DV-9.**

Counted rather than eyeballed, the remaining chrome debt is: 1127 Catppuccin consumptions, 82 raw
`rgba()` literals outside `:root`, 52 uppercase labels, 5 gradients and 6 backdrop filters. All five
are P3 and P4 targets and all five moved in the right direction this phase.

### 10.6 What P3 inherits

1. **A shell that is done and a set of interiors that are not.** Every region boundary, ground,
   hairline, radius, shadow and motion value is now a chrome token. What is left inside the regions
   is components: buttons, chips, inputs, menus, tables, cards.
2. **P2.7, unshipped and self-contained.** The five JS colour maps still leak the terminal palette
   into chrome. Keep the pinned arrays byte-identical and add a name-to-token map used only at
   string-build time (contract 1.8). This is the highest-value single item available and it is not
   blocked by anything.
3. **Two named motion patterns ready to consume**, `mwFadein` and `mwPulse`, the second already
   inside `prefers-reduced-motion: no-preference`.
4. **Two new radius tokens**, `--radius-pill` and `--radius-pane-frame`, both with INVENTIONS rows.
   The full set P3 can reach for: 3.5, 4, 6, 8, 10, 12, 999px and 100 percent. There is still no
   `--radius-popover`, `--radius-card`, `--radius-menu-item` or `--radius-button` (DV-4).
5. **Four sanctioned test edits still unspent**: SE-2, SE-3, SE-5 and SE-6, all blessed in DV-6 and
   all still unmade, because P2 changed none of their call sites either. SE-2 (the 4px pane accent)
   and SE-3 (the provider tint gradient) land with the pane frame; SE-5 with the Codex status ink;
   SE-6 with the meter thresholds.
6. **One open decision still handed forward**: 9.2.4, whether the running state is blue or green.
   P2 did not touch it.
7. **A harness that now measures three more things**: the count and identity of every shadowed
   element on screen, the sidebar's computed `border-right-width` and `box-shadow`, and horizontal
   overflow at 320, 768, 1024 and 1440. Later phases get those numbers for free.

---

## 10.7 P2.7, and the app.js halves of P2.1 and P2.5, shipped after the phase

Recorded by the agent that shipped them, in the same section as the phase they belong to, because
BUILD-CONTRACT 4.4 assigns them to P2 and 5.2 gives P2 one version. `DEVIATIONS.md` DV-9
Resolutions carries the per-gap state.

### 10.7.1 The projection lives in `instance-colors.js`, not in `app.js`

Contract 1.8 names `TAB_COLOR_TOKENS` in the `instance-colors.js` row and says "same pattern" for
the four `app.js` rows, which reads as four more local maps. It shipped as one table in
`instance-colors.js` with thin resolvers in `app.js` instead, for three reasons.

`instance-colors.js` is the only frontend module that is both a browser `<script>` and requireable
from Node, so the mapping is the only part of this work that can be unit-tested at all; four
literals inside a 25000-line browser class cannot. Four tables would also have had to agree with
each other by hand, and `mauve` appears in three of them, so the first divergence would have shown
up as a tab dot and a workspace dot disagreeing about what purple is, which is precisely the class
of bug risk R11 describes. And a single table makes the whole projection greppable: one file
answers "what does a persisted colour name paint".

The contract's own export name is preserved, derived rather than hand-written, so its text stays
findable in the source it describes.

### 10.7.2 The resolvers in `app.js` exist for the degradation policy, not for indirection

`_hueVar`, `_hueBgVar` and `_hueWash` add one thing the shared module cannot: what happens when
the shared module is not there. `index.html` loads `instance-colors.js` with **no cachebuster**
(`index.html:2089`, next to `app.js?v=...`), so a browser can hold a stale copy of it across a
deploy while running the current `app.js`. The resolvers fall back to `--app-text-gray`, warn once
on the console, and never emit a palette token, because `DESIGN-SPEC.md` 10.4 has no exception for
error paths. Adding a cachebuster to that `<script>` is `index.html` work and is listed in 10.7.6.

### 10.7.3 Tags took the block PAIR, not a mix of one ink

The three tag-chip sites were `background: color-mix(in srgb, var(--<palette>) 15%, transparent)`
with `color: var(--<palette>)`. Contract 2.3 row 3 makes a user-authored tag a **content label**,
which is `--app-bg-<hue>` behind `--app-text-<hue>`, so both halves moved rather than only the ink.
The old 15 percent mix of a mid-tone ink was close to invisible on dark chrome and muddy on light;
the captured pairing is measured to work on both. `blockHueWash` still exists and is tested,
because contract 2.3's **property** chips are explicitly translucent so they composite on a hovered
row, and that is the P3 chip work's to consume.

### 10.7.4 The five names with no Notion equivalent

`sky` to teal, `lavender` to purple, `sapphire` to blue, `flamingo` and `rosewater` to brown, per
contract 1.8 row 3. Eight tag names therefore collapse onto six block hues and thirteen persistable
workspace colours onto nine. That collapse is intended: the block palette has ten colours and the
Catppuccin ramp has fourteen, and 1.9 rule C1 says map on role rather than on hue. The visible cost
is that two tags which used to be distinguishable, one hashing to `sky` and one to `teal`, are now
the same colour. The hash is unchanged, so no tag changed colour relative to itself.

### 10.7.5 One scroll observer, two consumers

The topbar toggle and the hover gate both need to know that something is scrolling, so there is one
capture-phase listener rather than two. The gate is stripped **before** the animation-frame throttle
and the header is updated inside it: a hover wash that appears for one frame is the exact bug the
gate exists to prevent, while a topbar shadow that appears one frame late is invisible behind a
700ms transition.

### 10.7.6 What this work package could not reach, and who owns it

1. **The `nt-enable-hover` gate has nothing to gate.** No rule in `styles.css` is written as
   `.nt-enable-hover .thing:hover`. The mechanism is correct and the class is stripped and restored
   correctly; until the stylesheet's hover rules are rewritten behind it, DV-3's promise is still
   unkept. **P3 or P4 stylesheet owner.**
2. **`styles.css:6319-6336` hardcodes the pane slot ramp a second time**, as
   `border-left: 3px solid var(--mauve)` through `var(--pink)` per `[data-slot]`. It is the same six
   colours as `PANE_SLOT_COLORS`, so the sidebar pip and the pane header now disagree, and it is a
   3px left bar, which 2.12 calls the single most important idiom to remove. Replacing it with
   2.12's 35 percent mix into the pane-frame hairline closes both. **P4.**
3. **`.terminal-group-tab` still paints its name and a 2px underline slab from `--tab-color`**
   (`styles.css:6689-6726`), and its ground is `var(--surface0)`. The hue is now a chrome token, but
   the recipe is the underlined tab 2.7 rejects. **P4.4.**
4. **The status dots write their fill inline from `app.js`**: `renderSessionItem` emits
   `style="background: var(--green|--peach|--blue|--overlay0)"`. An inline style beats every rule,
   so 2.3's `.status-dot` recipe cannot land until that emitter moves too. Not one of DV-9's five
   maps, so out of this package's scope, but it is a **blocker for the P3.2 or P4 status work** and
   whoever owns that recipe must take the `app.js` emitter with it.
5. **115 palette `var()` references remain in `app.js`**, all outside the five maps: ad hoc inline
   styles on settings rows, task badges, analytics cards, meters, the resources view and the
   Costs chart ramp `barColors` (`app.js:21908`, an eight-entry map in the same shape as the five,
   just not listed in 1.8). These are contract 1.10's census, **P3 and P4**.
6. **`instance-colors.js` has no cachebuster** in `index.html`. Every other frontend script that
   this program has touched carries one. **Orchestrator or P4**, as a five-file atomic bump per
   gate G10.
7. **The header stats popover**, DV-9's remaining P2.1 item, needs `index.html`. **P4 or the
   orchestrator.**
