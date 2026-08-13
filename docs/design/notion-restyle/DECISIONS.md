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

## 11. Phase P3, primitives and chips

### 11.1 What shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| P3.1 | `5c0c2d0` | `styles.css`, `focused-shell.css` | The `.btn` family rebuilt on two CTA weights and one hue. The mauve primary retired. Icon buttons, the small scale, the coarse-pointer 44px floor, the password toggle. |
| P3.2 | `bcdce01` | `styles.css`, `semantic-theme.css`, `test/codex-status-strip.test.js` | The two chip systems split. Status dots at 7px, chip dots at 8px. The running-is-green ruling. The last coloured halo removed. Sanctioned edit SE-5. |
| P3.3 | `a610ea8` | `styles.css`, `test/usage-meter.test.js` | The 28px field on fourteen call sites, the native checkbox, the captured switch, one 5px meter across five consumers, the two borderless editors. Sanctioned edit SE-6. |
| P3.4, P3.5 | `7d58827` | `styles.css`, `semantic-theme.css` | The inset focus ring for controls inside clipping ancestors, and the forced-colors block extended from four selectors to thirty-eight. |

P3.4 and P3.5 ship in one commit because P3.5's whole content is "give every component P3 drew a
boundary", which is not meaningful until P3.4's coverage pass has decided which controls exist as
controls. Splitting them would have produced one commit that could not be reviewed without the other.

### 11.2 Ambiguities resolved during P3

#### 11.2.1 The running state is green, and the role token is not what the call sites read

`9.2.4` handed P3 an open decision: table E gave `--status-running` a blue ink (`--color-info`) and a
green wash (`--app-bg-green`). The orchestrator ruled **green**, so `semantic-theme.css` now resolves
`--status-running` to `--app-text-green` and the two halves finally agree. It points at the block
palette directly rather than at `--color-success`, because a session that is running has not
succeeded at anything and collapsing the two roles would make that distinction unsayable later.

The second half of this is less obvious and cost a failed gate to find. The four `.status-dot-*`
rules in `styles.css` cannot consume the `--status-*` role tokens at all:
`phantom-tokens.test.js` reads token DEFINITIONS out of `styles.css` and `styles-mobile.css` only,
and the roles are defined in `semantic-theme.css`, so every role reference from `styles.css` counts
as a phantom and the rule is reported as one that "silently does nothing". The contract anticipates
this without saying so: 2.3 spells the recipe as `background: var(--app-text-<hue>)`, the block
palette, not the role. So the call sites name the block palette and the role layer keeps its job as
the choke point for `.attention-state`, `focused-shell.css` and anything else that reads a state
rather than a colour. The two agree by construction and the gate is what enforces it.

#### 11.2.2 `.btn-ghost` stops meaning ghost, and `.btn-icon` has to take the ground back off

Contract 2.2 maps `.btn-ghost` onto `nt-btn-app-secondary`, which is a FILLED control:
`--app-bg-elevated` plus `--app-shadow-button`, an inset hairline and a 1px drop. The class name
therefore stops describing its own recipe, which is uncomfortable and is nonetheless correct:
`DO-NOT-BREAK.md` rule 2 freezes all 278 JS-coupled class names, and this is one of them.

The complication is that 82 of the 131 `btn-ghost` usages also carry `btn-icon`, and
`terminal-select-v2.test.js` pins the string `btn btn-ghost btn-icon btn-sm` character for character
on the injected pane-header buttons. A filled, shadowed pane-header icon button would be wrong twice
over: it is not the captured icon-button recipe, and it would put a shadow on up to eleven elements
inside a single pane header, against P2.4's single-digit shadow budget for the whole screen.

Resolved by ordering rather than by a new class. `.btn-icon` is authored AFTER `.btn-ghost` at equal
specificity and re-declares `background: transparent` and `box-shadow: none`, so the shared string
resolves to a bare 26px glyph while a plain `.btn-ghost` stays the secondary weight. No class was
renamed, no markup changed, and the pinned string still passes unedited.

#### 11.2.3 The chip is 14px, and DESIGN-SPEC says two different things

`DESIGN-SPEC.md` 1.3's type table lists "Section labels, counts, meta, descriptions, chips" at 12px.
The same section's closing paragraph says "`nt-chip` and `nt-table` pull 14px from `--app-chip-size`
and `--app-property-size`", the captured token is 14px, and `BUILD-CONTRACT.md` P3.2's done criterion
is explicit and measurable: "chips measure 20px tall at 4px radius with `0 6px` padding and
14px/16.8px/500".

Shipped at 14px, because the contract's number is the one a gate can check and the 12px row is a
prose summary that also covers section labels and counts, which are genuinely 12px. The consequence
is visible in the P3 screenshots and is recorded in 11.5 as a delta rather than silently corrected:
in the sidebar tree the tag chip's 14px is one step LARGER than the 13px session name above it, so a
property renders louder than its subject. The mock never draws a chip in a sidebar, so it has no
opinion; what it does hold is "chip type equals row type", and the sidebar is the one surface in this
app where those two numbers differ. Changing it means either a second chip scale or a 13px scoped
override inside a region P4 owns, and neither is P3's call to make alone.

#### 11.2.4 The status chip's leading dot needs markup that P3 does not own

Contract 2.3 gives the status chip a leading dot and `DESIGN-SPEC.md` 6 draws it as
`<span class="nt-chip-dot">`. Delivering that from CSS would mean a `::before` on `.status-badge`,
and both of its consumers already put something in that position: `renderSessionDetail` emits
`statusIcons[status]` ahead of the label, and the two pane-detail flag badges carry their own inline
styles. A pseudo-element dot would sit next to a glyph on one and alone on the others.

`.nt-chip-dot` therefore ships as a real class, 8px and `currentColor`, and nothing carries it yet.
Adding it is a one-span change in the templates, which live in `index.html` and `app.js`.

#### 11.2.5 The focus ring was being clipped, and the fix is an offset sign

P2.6 gave every native focusable a 2px outline at `+1px`. An outline at a positive offset paints
outside the border box, so any ancestor that clips gets to cut it. Five containers in `styles.css`
clip, measured rather than assumed: `.sidebar` (`overflow: hidden`), `.settings-nav`, `.qs-results`
and `.kanban-column-body` (`overflow-y: auto`) and `.codex-pane-status` (`overflow-x: auto`). A
sidebar row spans the full width of a container with `overflow: hidden`, so at `+1px` its ring keeps
two horizontal lines and loses both vertical edges: the keyboard user sees two dashes and no control.

Twenty selectors inside those five now draw at `-2px`, inside their own border box, where nothing
upstream can reach them. Outline follows `border-radius`, so an inset ring on a 6px pill is still a
6px pill, and all twenty score (0,2,0), which outranks the universal (0,1,1) rule and is outranked by
nothing else in the sheet. The five pinned `:focus-visible` rules are in other regions and other
files and were not touched.

#### 11.2.6 `outline: none` on a borderless editor is not an accessibility exception

The docs raw editor and the notes textarea are the two surfaces contract 2.9 calls "the strongest
Notion idiom in the whole app": no border, no ground, page content rather than a form field. Both
carry `outline: none`, which looks like an A3 violation and is not: the declaration scores (0,1,0)
and the universal `:is(...):focus-visible` rule scores (0,1,1), so a keyboard user gets the ring and
a pointer user gets the clean document surface. That asymmetry is the entire point of
`:focus-visible` and it is worth stating because the next reader will otherwise "fix" it.

### 11.3 Scope decisions, and what was deliberately left alone

#### 11.3.1 `app.js` and `index.html` were not in this phase's ownership set

Two concurrent agents were working in the same worktree, one on `pty-manager.js` and `vt-sidecar.js`
and one on `app.js` and `instance-colors.js`. This phase owned `styles.css`, `semantic-theme.css`,
`focused-shell.css`, its two sanctioned test edits and the gate and screenshot baselines. Three
contract items therefore shipped as CSS only:

1. **P3.1's markup half.** `#create-session-btn` still contains an inline SVG plus button, and
   contract 2.2 says "no icon inside the primary button". One template line in `index.html`.
2. **P3.2's `app.js` chip render region.** The `.nt-chip-dot` span (11.2.4), and the
   `renderSessionItem` emitter that writes `style="background: ..."` onto `.ws-session-dot`, which
   10.7.6 item 4 already flagged as a blocker for the status recipe. An inline style beats every
   rule, so the sidebar tree's dots take their hue from `app.js` and not from `.status-dot-*`.
   `.status-dot`, `.detail-status-dot` and `.subagent-dot` are class-driven and did land.
3. **P3.4's markup half.** Eleven custom controls render as `div` or `span` with no `tabindex`
   (`.sidebar-tab`, `.ws-session-item`, `.workspace-item`, `.project-session-item`, `.session-item`,
   `.qs-result`, `.search-result`, `.context-menu-item`, `.kanban-card`, `.task-item`,
   `.codex-status-chip`), so they cannot take focus at all and their new rings never fire. The rings
   ship anyway, so the fix is one attribute rather than an attribute plus a rule.
   `.sidebar-tab` is the sharp case: it is one of the three attribute-frozen templates in 2.1, so
   whoever adds `tabindex` there has to re-pin `provider-tabs.test.js` or add the attribute in a
   position the existing regex tolerates.

#### 11.3.2 The hover gate is live and reaches nothing, and closing it is not a primitives job

The P2.7 agent shipped the `nt-enable-hover` strip on `#app` and recorded, honestly, that it changes
nothing on screen because no rule in `styles.css` is written as `.nt-enable-hover .thing:hover`. That
note names "the P3 or P4 stylesheet owner" as the fix.

Not done here, deliberately. Gating only the primitives P3 owns would leave the sidebar rows, the
table rows and the menu rows, which are the surfaces that actually flash under a scrolling pointer,
ungated. A half-gated sheet is harder to reason about than an ungated one, and it would collide with
P4's region work rule by rule. The recommendation is one dedicated pass, all rules at once, in P4.

#### 11.3.3 Region-bespoke buttons were left to their regions

The `.btn` family, the field family, the chip family, the switch, the checkbox and the meter are
shared primitives and all of them moved. Buttons that name their own class inside one region
(`.wt-review-btn` and its three variants, `.settings-scale-btn`, `.notes-toolbar-btn`,
`.find-convo-search-btn`, `.tasks-td-refresh`, the account panel's own controls) did not. They are
region work and P4 owns their surfaces; restyling them now would mean touching six regions to deliver
a primitives phase, and the shared classes those regions also carry already moved underneath them.

#### 11.3.4 Two of the four unspent sanctioned edits stay unspent

SE-5 and SE-6 were spent here, each in the same commit as its source change, which is what 5.4
requires. SE-2 and SE-3 are still unmade: SE-2 retargets the 4px pane-top accent and the 8 percent
whole-pane tint, and SE-3 retargets the provider tint gradient. Both belong to the PANE FRAME, which
is P4 and P5 work, and neither call site was touched here. The provider pill half of SE-2 did not
need the edit either: `provider-label-pill.test.js` pins the pill's `::before` as referencing
`--provider-claude-accent` and `--provider-codex-accent`, and the restyled chip keeps both.

### 11.4 The numbers

| Measure | After P2 | After P3 |
| --- | --- | --- |
| `styles.css` lines | 13168 | **13728** |
| `semantic-theme.css` lines | 137 | **273** |
| `focused-shell.css` lines | 1477 | **1488** |
| Gate G4, Catppuccin `var()` in chrome | 1127 | **1021** |
| Gate G5b, raw `rgba()` outside `:root` | 82 | **71** |
| Gate G7, uppercase labels | 52 | **49** |
| Gate G8, `translateY` occurrences | 17 | **16** |
| Selectors inside `@media (forced-colors: active)` | 5 | **38** |
| Test files / assertions | 82 / 1317 | 82 / **1368** |

The G4 figure is not all P3's: the concurrent P2.7 track landed between P3.2 and P3.3 and took its
own share. P3's own contribution is the button, chip, dot, field, switch and meter call sites.

The assertion delta is **+51 and none of it is P3's**. All 51 land in `instance-colors.test.js`,
which went from 13 to 64 when the P2.7 agent shipped its projection. P3's own delta is **zero added,
zero removed and two retargeted**: SE-5 in `codex-status-strip.test.js` and SE-6's three
whitespace-exact lines in `usage-meter.test.js`.

Measured against the P3 gate additions in contract 5.2:

| Gate addition | Result |
| --- | --- |
| Chips are 4px and cards are 10px, measured, and not the same number | **yes.** `--radius-property-chip` is 4px and every chip rule names it; `--radius-callout` and `--radius-collection-card` are 10px. Status chips are a third number, `--radius-status-chip` 10px at a 20px height, which is a pill rather than a card. |
| Buttons, inputs and chips match their metrics in DevTools | **yes.** Button 28px / `0 8px` / 6px / 14px / 16.8px, small 24px, pane-header icon 26px. Field 28px / `0 8px` / 6px, search variant 32px. Chip 20px / `0 6px` / 4px / 14px / 16.8px / 500. Switch 26 by 16 with a 12px knob. Meter track 5px. |
| Keyboard tab sweep shows a visible ring at every stop, both themes | **partially, and the gap is markup.** Every NATIVE focusable has a ring, and the twenty controls inside a clipping ancestor now have one that survives the clip. The eleven `div` and `span` controls in 11.3.1 item 3 are not tab stops at all today, so there is no stop to show a ring at. The ring measures 3.88:1 on the light canvas and 4.53:1 on the dark one. |
| No class was renamed | **yes.** G1 378/378 ids and G2 278/278 classes, both unchanged. Two classes were ADDED, `.nt-chip-dot` and the `.input.is-invalid` state hook. |

### 11.5 The P3 screenshots, and an honest reading of them

`screenshots/notion-restyle/p3/`, eight shots plus `manifest.json`, the same matrix as P0 through P2.

**What changed, and it is the thing the phase existed for.** The mauve is gone from every CTA.
`Start session` and `+ New` are the Notion blue at 28px, `Browse sessions`, `Discover` and
`Show hidden` are the hairline-inset secondary, and the two weights are one hue apart and nothing
else. That was DECISIONS 10.5's number one delta and it is closed. The tag chips are Notion property
chips in Notion hues rather than 9px palette-coloured mono pills, which was delta two, and the hue
half of it closed at the same time through the concurrent P2.7 track. The session status dots are
7px rather than 8px and carry no halo.

**What still reads as the old design**, top deltas first, each with the phase that owns it:

1. **The sidebar tag chips are louder than the session names.** 14px chip type above a 13px row
   title, on its own line, in a 240px sidebar. The chip metric is the contract's measured number
   (11.2.3) and the sidebar row is P2.2's; reconciling them is a region decision. **P4**, or the
   orchestrator ruling on 11.2.3.
2. **User tag chips pair block ink with block wash, and that pairing measures 2.41:1 to 3.85:1.**
   The contract's own recipe for a named block colour is `--app-text-<hue>` on `--app-bg-<hue>`, and
   Notion's actual callout does not do this: a coloured Notion callout carries DEFAULT ink on a
   coloured ground, and the coloured ink is for text on the plain page. The pair that clears the
   floor already exists in the system, `--app-chip-<hue>-ink` on `--app-chip-<hue>-fill` at 5.98:1
   to 7.26:1. The hue arrives inline from `_hueVar`, so the fix is one line in the projection rather
   than a stylesheet change. **The `instance-colors.js` owner**, with contract 2.3 to re-read.
3. **The terminal group tab is still a bordered pill with a coloured underline.** Its hue is a
   chrome token now, but the recipe is the underlined tab 2.7 rejects. **P4.4.**
4. **The empty-state art is still a line icon in a rounded square**, which 2.12 names explicitly as
   the thing never to do, and it is still the only non-sidebar shadow on the default screen.
   **P4.5** and **P12.4.**
5. **The Sessions view is still a bespoke list, not the measured database table.** **P4.3.**
6. **The secondary button has almost no boundary in dark chrome.** `--app-bg-elevated` `#202020` on
   the `#191919` canvas with a near-black inset hairline is about 1.1:1, so it reads as a bare label
   until the pointer enters it. This is the capture's own dark secondary. **DV-15**, ruled at P12.
7. **Project rows in the tree are still italic monospace grey.** **P4.**
8. **The phone is still the old IA.** **P10.**
9. **The topbar still has no breadcrumb.** **P4** or the orchestrator.

### 11.6 What P4 inherits

1. **A complete primitive layer.** Buttons, icon buttons, fields, selects, textareas, checkboxes,
   the switch, the meter, both chip systems and both dot systems are single recipes on shared
   classes. A region that carries `.btn`, `.input`, `.session-badge` or `.status-dot` is already
   correct; a region that rolls its own control is not, and 11.3.3 lists the ones that do.
2. **Two chip systems that must not be re-merged.** Property chip is `--app-chip-<hue>-fill` plus
   `--app-chip-<hue>-ink` at 4px. Named block colour is `--app-bg-<hue>` plus `--app-text-<hue>` at
   10px, is for user-authored content only, and does not clear the contrast floor (11.5 item 2).
   Status dots are 7px block palette, chip dots are 8px `currentColor`.
3. **A focus ring that survives a clipping ancestor**, and a list of the five containers that clip.
   Any new scrolling region needs its controls added to that rule or they lose their ring silently.
4. **Eleven controls that are not keyboard reachable** (11.3.1 item 3). The rings are already
   written; the templates need `tabindex`, and one of the eleven is an attribute-frozen template.
5. **A forced-colors block covering thirty-eight selectors.** Every new component drawn with a fill
   needs a row added to it, or it vanishes in High Contrast. That is now a habit rather than an
   afterthought, and P3.5's comment says which system colour to reach for.
6. **Two sanctioned test edits still unspent**, SE-2 and SE-3, both waiting on the pane frame.
7. **The hover gate, live and reaching nothing** (11.3.2). One dedicated pass, all rules at once.
8. **Four new deviation rows**, DV-12 to DV-15, all of them contrast, all of them captured values,
   and all of them pointing at the same owner: 5.5.4's full reckoning at P12. The measurements are
   already in the rows, so that pass does not have to re-derive them.

---

## 12. Phase P4, composites, regions and recency

### 12.1 What shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| P4.1 | `d22530f` | `styles.css`, `app.js` | Context menus and five popovers on one shadow, one radius, one entrance. The menu row at 28px in a 240px card. The `.ctx-label` span. The hover gate mirrored onto `<body>`. |
| P4.2 | `7ed481d` | `styles.css` | The scrim, `backdrop-filter` to zero, the modal card recipe, and the whole Quick Find region including the one sanctioned uppercase label. |
| P4.3 | `5accc8c` | `styles.css`, `app.js`, `instance-colors.js`, `test/instance-colors.test.js`, `DEVIATIONS.md` | The Sessions database table, seven columns, persisted sort. Both orchestrator rulings. The tri-state attribute bug. DV-16 and DV-17. |
| P4.8, P4.9 | `beca785` | `app.js`, `index.html`, `styles.css`, `focused-shell.css`, `test/recency-surfaces.test.js` | The recency system: one merged list, four surfaces, the measured sidebar split, the reduced-precision rule. |
| P4.4 | `140f01e` | `styles.css` | The remaining four tab families plus the filter pills. The terminal group tab's underline slab. |
| P4.5 | `3af2daa` | `styles.css`, `test/provider-label-pill.test.js`, `test/css-tokens.test.js` | The pane frame with SE-2 and SE-3 spent, the slot ramp's second copy, the board, the toast, the drop slot, the skeleton and its double declaration, the login graph paper. |
| P4.10 CSS | `53ce7e5` | `styles.css`, `focused-shell.css` | Forty-six uppercase rules and their tracking. |
| DV-3 | `c41b62e` | `styles.css`, `focused-shell.css` | The hover gate sweep, 126 rules. |
| inherited | `40d4791` | `app.js`, `styles.css`, `index.html`, four test files | tabindex and keyboard activation, the sixth colour map, the five-file cachebuster bump, the italic mono project row. |
| DV-9 | `270574a` | `index.html`, `app.js`, `styles.css` | The topbar breadcrumb. |

Ten commits, each revertable on its own. The order is deliberate: the two that
are hardest to revert, the table rewrite and the recency wiring, ship after the
pure-CSS region work and before the sweeps, so reverting either takes no token
work with it.

### 12.2 Ambiguities resolved during P4

#### 12.2.1 The hover gate could never have worked, and the reason is in `index.html`

`BUILD-CONTRACT` 2.1 puts `nt-enable-hover` on `#app` and DV-3 promised the
strip. Both are right about the mechanism and wrong about the DOM. `index.html`
closes `#app` at line 1531 and then opens every modal, the quick switcher, the
toast stack, the action sheet and `#context-menu` as **siblings** of it. A rule
written `.nt-enable-hover .context-menu-item:hover`, which is the form the
contract and `DESIGN-SPEC` 1.7 both prescribe, therefore matches nothing inside
an overlay: the ancestor carrying the class is not on that branch of the tree.

`_setHoverGate` now mirrors the class onto `<body>` as well. One selector reaches
both branches, `#app` keeps the class so nothing already keyed to the shell
changed, and the line `instance-colors.test.js` pins is untouched. Without this,
gating the menu rows would have silently deleted their hover states.

#### 12.2.2 What a hover gate must never gate

The sweep gates 126 rules and deliberately leaves nine. Each of the nine shares
its selector with `:focus-visible`, `.active` or an `[aria-*]` state:

- the two resize handles pair `:hover` with `.active`, which is the DRAGGING
  state, and the gate is stripped by `dragstart`. Gating those would remove the
  drag feedback at exactly the moment the user is dragging.
- the other seven pair `:hover` with `:focus-visible`. A keyboard user who
  scrolls must not lose their focus ring, so suppressing that rule mid-scroll
  would trade an accessibility regression for a cosmetic one.

Rules that only REVEAL a control (`opacity`, `visibility`, `display`) are also
ungated: hiding an affordance mid-scroll is worse than showing it.

#### 12.2.3 The table is a real `<table>`, and that is what saved the delegation

`#session-list`'s rows carry `data-id`, `draggable`, `.active` and
`.attention-state`, and six delegated handlers resolve through
`closest('.session-item')`. A grid of divs would have needed `display: contents`
on the row to make its cells grid items, which destroys the row's own box and
with it the hover wash, the selected fill and the drag image. Keeping the row as
one element is what let the whole region change with zero handler edits, and the
real `<table>` gets genuine column headers and `border-collapse` hairlines for
free.

#### 12.2.4 The tri-state dots have never rendered, and it is a quoting bug

`renderSessionItem` emitted `class="ws-session-dot${tristateAttr}"` with
`tristateAttr` holding a leading-space `data-tristate="busy"`. Interpolated
inside the class attribute's own quotes, the markup came out as
`class="ws-session-dot data-tristate="` and the parser never saw a
`data-tristate` attribute at all. The three CSS rules keyed on it have been dead
since they were written. Moving the interpolation outside the quotes is what
makes the busy pulse, the waiting fade and the ready tick visible for the first
time; this phase also had to take the emitter's inline `background` with it,
which is 10.7.6 item 4's blocker for the `.status-dot` recipe.

#### 12.2.5 The capture has no dark table hairline, and shipping its silence ships an invisible grid

`--app-table-cell-border` is `rgba(42,28,0,0.07)`: correct on a white page and
identical to the ground on the `#191919` dark canvas. The vendored `colors.css`
has no dark override for it, nor for `--app-divider`; both dark blocks were read
to confirm it. The token keeps its captured value, because re-authoring it would
fail the parity diff and would assert something about the capture that is not
true, and the dark CALL SITE re-points to `--app-border-secondary`.
`DEVIATIONS.md` DV-16.

#### 12.2.6 The snackbar keyframe was not authored, and the reason is a gate

`BUILD-CONTRACT` 2.8 names `nt-snackbar-slide-in-bottom`, an 8px rise. The toast
takes `mwFadein` at the snackbar's 200ms instead. 2.4 says one entrance for every
overlay in the app; authoring a second to differ by 4px of travel on a 200ms
animation buys nothing visible, and gate G8 ratchets `translateY` occurrences
DOWN because that counter exists to keep hover lifts out of the sheet. Spending a
seventeenth on an invisible difference is not what the budget is for.

#### 12.2.7 Two of the eleven unreachable controls were never unreachable

`DECISIONS` 11.3.1 item 3 lists eleven controls with no `tabindex`. Two of them,
`.sidebar-tab` and `.context-menu-item`, are real `button` elements and have
always been tab stops, so their P3 rings already fired. Two more, `.qs-result`
and `.search-result`, are deliberately NOT made tab stops: both live in a modal
whose text input must keep focus for typing, and both already have arrow-key
navigation with Enter to activate. Making them tab stops would break the faster
interaction to satisfy a rule about the slower one. The remaining six took
`role="button"` and `tabindex="0"` plus a shared Enter and Space handler, because
a tab stop that cannot be activated is half a fix.

#### 12.2.8 The Model column was the wrong home for the topic

The first cut of the table put a session's topic in the Model cell when there was
no model. It rendered, and it was mislabelled: a topic under a `Model` header is
a lie the column header tells. The topic moved into the Name cell as a tertiary
secondary, which is where it belongs and which also keeps the `.session-topic`
class alive on real data rather than as a placeholder.

### 12.3 Scope decisions, and what was deliberately left alone

#### 12.3.1 Four regions did not ship, and each is a package rather than a leftover

P4's contract scope is ten work packages plus the accumulated handoff items from
three previous phases. These four did not fit, and are named here with what they
need so the next agent starts from a specification rather than a rediscovery:

1. **P4.6, the docs panel as a document surface.** `.nt-layout`, the block box
   model, the 720px measure with 375px gutters, and the list collapse.
   `BUILD-CONTRACT` 6 calls this the hardest step to revert, which is also why it
   is the right one to leave for a commit of its own.
2. **The side peek** (`#session-detail-panel`, `DESIGN-SPEC` 7). It is currently
   an overlay and 2.12 makes it a layout SIBLING that narrows the main column:
   eight properties in a `minmax(80px,110px) 1fr` grid, a 44px header mirroring
   the topbar, and the borderless notes editor P3 already built.
3. **The Costs view interiors and the settings shell.** The sixth colour map
   shipped; the cards, the tables and the `Share` column meter did not.
4. **The attention popover and the account/usage popover interiors.** Both shells
   took the popover recipe in P4.1; their rows, meters and credential lines are
   still the old treatment.

#### 12.3.2 `styles-mobile.css` was not touched, again

Gate G7's target is 1 and it lands at 3. The two survivors are
`.action-sheet-header` and `.action-sheet-sep-labeled .as-sep-label` in
`styles-mobile.css`, the phone analogues of the context-menu header this phase
fixed. `DECISIONS` 10.3.2 records the precedent and the reasoning: P2 swept that
file and reverted, because sweeping another track's file to satisfy a gate that
does not cover it is exactly the collision `BUILD-CONTRACT` 4.1 item 4 exists to
prevent. The same logic put the phone collapse for `.session-table` inside a
`@media (max-width: 768px)` block in `styles.css` rather than in the mobile
sheet: the table is this phase's, so its phone floor is this phase's too.

#### 12.3.3 The `app.js` inline palette census is not finished

Contract 1.10 counts 115 palette `var()` references in `app.js` outside the five
maps. The sixth map (`barColors`) shipped and the tag chips moved to the chip
pair, leaving about 68 on settings rows, task badges, analytics cards, meters and
the resources view. They do not count against G4, which measures the stylesheets,
and each is an inline style on a surface whose region has not been restyled yet.
They should move with their regions rather than as a sweep, which is how the five
maps were handled.

### 12.4 The numbers

| Measure | After P3 | After P4 |
| --- | --- | --- |
| `styles.css` lines | 13728 | **14788** |
| `focused-shell.css` lines | 1488 | **1626** |
| Gate G3, `[hidden]` guards (up is better) | 22 | **25** |
| Gate G4, Catppuccin `var()` in chrome | 1021 | **902** |
| Gate G5b, raw `rgba()` outside `:root` | 71 | **46** |
| Gate G7, uppercase labels | 49 | **3** |
| Gate G9a, `linear-gradient` | 5 | **1** |
| Gate G9b, `backdrop-filter` | 6 | **0** |
| Test files / assertions | 82 / 1368 | 83 / **1402** |
| `app.js` lines | 26127 | **27085** |

The assertion delta is **+34**, of which +33 is P4's (28 in the new
`recency-surfaces.test.js`, 5 in `instance-colors.test.js` for the chip
projection) and +1 is the concurrent P6 track's `vt-sidecar.test.js`. Three
existing assertions were retargeted: the tag-chip pair under the orchestrator's
ruling, and sanctioned edits SE-2 and SE-3, each in the same commit as its source
change, which is what 5.4 requires.

Measured against the P4 gate additions in contract 5.2:

| Gate addition | Result |
| --- | --- |
| Menus and popovers all use one shadow token and one radius | **yes.** Six surfaces on `--app-shadow-menu` at 6px or 10px, one entrance. |
| `grep -c backdrop-filter styles.css` down from 5 to 0 | **yes,** from 6; the contract undercounted by one. |
| Header row 36px, body rows 32px, hairlines, row hover the faint wash and not a solid fill | **yes,** with DV-16 on the dark hairline. |
| No underline slab and no pill-less text tab anywhere | **yes,** in `styles.css`. The pinned tab markup is byte-identical. |
| Every content loading state is a shimmer skeleton, not a spinner | **partially.** The skeleton is the shimmer and the double declaration is fixed; `.btn-loader` still spins where it was already used, which 2.2 explicitly retains for genuinely indeterminate operations. |
| `grep -rnE "text-transform:\s*uppercase"` returns exactly 1 | **no, it returns 3.** 12.3.2 names the two and their owner. |
| `test/recency-contract.test.js` green | **renamed and green.** `recency-surfaces.test.js`, 28 assertions, eleven executing the merge. The server endpoint P4.7 specifies was not in this agent's ownership set; the merge is client-side and the endpoint has exactly one place to land when it ships. |
| `Ctrl+K` then `Enter` opens the most recent session | **yes.** |
| All four surfaces agree on the first session | **yes, by construction.** One function, one sort, one tie-break. |
| The sidebar split arithmetic constant is measured, not guessed | **yes.** `measureSidebarChromeHeight` measures the complement of the two lists, so a section added later counts automatically. |

### 12.5 Recency acceptance criteria, against 2.13.7

1. **Two keystrokes from a cold load.** Yes. `Ctrl+K` renders the eight most
   recent with index 0 highlighted, and `Enter` opens it.
2. **Four surfaces, same first session.** Yes, by construction: all four call
   `getRecentSessions`, which sorts once and breaks ties once.
3. **Five seconds over SSE, no polling.** Yes, structurally. Every path that
   changes a session already calls `renderWorkspaces`, including the SSE
   handlers, and both recency renders hang off it. No timer was added. Not yet
   measured end to end against a live session; that belongs to the acceptance
   sweep.
4. **Codex and Claude interleave by time.** Yes, and it is executed in the test
   rather than asserted from the source: a Codex row a minute old sorts above a
   Claude row an hour old.
5. **One formatter.** Yes. `relativeTime` is the only one, and it now returns
   `just now` under a minute per the reduced-precision rule.
6. **Hidden sessions never appear.** Yes, all three exclusion sets, executed.
7. **Under five seconds on the phone.** Not measured; the phone's Home IA is
   P10's and the section G.5 human script runs at acceptance.

### 12.6 The P4 screenshots, and an honest reading of them

`screenshots/notion-restyle/p4/`, eight shots plus `manifest.json`, the same
matrix as P0 through P3. All eight were looked at, and two shipped fixes came out
of looking: the phone Sessions view was a seven-column smear before the table
collapse was written, and the phone topbar rendered the breadcrumb as a bare
slash against the account chip. A third, the project-group caret rendering as a
blue emoji square, was caught the same way.

**What changed, and it is the thing the phase existed for.** The Sessions view is
a database table: seven columns, about eighteen rows where six cards used to fit,
sorted by last activity with the sort marked in the header. The sidebar opens
with `Recent`. The empty workbench offers four sessions to resume instead of a
dashed box. The topbar says `Myrlin / Workbench · Main`. The terminal group tab
is a pill with a dot. Nothing on the default screen is uppercase.

**What still reads as the old design**, top deltas first, each with its owner:

1. **The side peek is still the old overlay panel.** It is the largest region the
   restyle has not touched. **P4 remainder, 12.3.1 item 2.**
2. **The docs panel is not a document surface yet.** **P4.6.**
3. **The Costs and settings interiors are untouched**, so switching to either
   still lands on the old design. **P4 remainder, 12.3.1 item 3.**
4. **The `.session-badge-cost-na` chip renders as an em dash in a bordered box**
   in the sidebar, which reads as an empty control rather than as "not tracked".
   The markup is pinned character-for-character by `cost-display.test.js`, so the
   fix is CSS-only and needs a decision about what "no cost" should look like.
   **P4 remainder or P12.**
5. **The account chip is still the old pill.** `DESIGN-SPEC` 4 gives it an avatar
   and a usage percentage. **P4 remainder.**
6. **The two contrast families from P3 are unchanged**, DV-12 through DV-15.
   **P12's 5.5.4.**
7. **The phone is still the old IA**, now with a correct table collapse under it.
   **P10.**

### 12.7 What P5 and P10 inherit

1. **A pane frame that is finished on the outside.** A 1px hairline at a 35
   percent hue mix, an 8px radius, the flat provider tint on the header band, and
   both sanctioned edits spent. The terminal SURFACE inside it is untouched: no
   xterm internals, no Select machinery and no part of the write pipeline was
   read or modified by this phase.
2. **A hover gate that works**, with the `<body>` mirror that makes it reach the
   overlay layer. Any new hover wash should be written
   `.nt-enable-hover .thing:hover` from the start.
3. **A recency system with one entry point.** `getRecentSessions(limit)` returns
   rows already shaped for a surface. The mobile Home tab (2.13.6) is a render
   away, and `recentRowInnerHtml` is the shared row.
4. **A phone floor, not a phone design.** `.session-table` collapses to cards
   under 768px and the breadcrumb hides. Both are holding measures inside
   `styles.css`; P10 owns the real IA and may replace either.
5. **Two uppercase rules in `styles-mobile.css`** that keep G7 off its target
   (12.3.2).
6. **Four regions specified but not built** (12.3.1), each with its contract
   section and its measurements already gathered.
7. **A cachebuster that is now atomic across six files**, including
   `instance-colors.js`, which had none. A bump is `index.html` plus the three
   pinning tests plus the browser lane.

### 12.8 Contrast, measured for every composite this phase drew

Thirty-nine pairings, computed from the shipped token values in both chromes,
with translucent grounds composited over their page ground before the ink is
composited over them. `PROCEDURE.md` 4.2's floors: 4.5:1 for text, 3:1 for a
boundary or a graphic.

**Every ink this phase put on a ground clears its floor, or fails only in a
family already recorded.** There is no new deviation row for contrast, and that
is a measurement rather than an assertion:

| Composite | Light | Dark |
| --- | --- | --- |
| Table row title on the canvas | 13.98 | 15.30 |
| Table row title on a hovered row | 13.41 | 13.23 |
| Menu row ink on the elevated ground | 13.98 | 14.18 |
| Menu row ink, hovered | 13.04 | 12.11 |
| Toast ink on the inverted ground | 12.16 | 15.30 |
| Toast close glyph | 5.98 | 5.65 |
| Breadcrumb leaf | 13.98 | 15.30 |
| Sidebar Recent row title | 13.18 | 14.18 |
| Workbench continue card title | 13.98 | 15.30 |
| Board card title | 13.98 | 14.18 |
| Quick Find row title | 13.98 | 14.18 |
| Provider chip, Claude | 7.17 | 6.17 |
| Provider chip, Codex | 6.77 | 5.72 |
| Status chip, on the canvas | 7.26 | 5.62 |
| Status chip, on a hovered sidebar row | 6.86 | 5.22 |

**The orchestrator's tag-chip ruling is measured, and it was right.** The block
pair P3 shipped measures **3.49:1 light and 2.87:1 dark** for brown on brown.
The chip pair it moved to measures **6.62 and 5.73** for the same hue, **5.71
and 4.69** for the worst of the ten (yellow), and **6.54 and 5.56** for blue.
Every one of the twenty pairs clears 4.5:1 in both chromes, on the canvas and on
the sidebar ground alike, which is what the translucent fill buys.

**Twenty-one pairings sit below their floor, and every one of them is a
consumption of a token family already recorded.** Two families, no more:

- `--app-text-tertiary` at **2.67:1** light and **4.11:1** dark. This is DV-10's
  recorded 2.6:1 exactly, and it is the ink for every piece of meta copy in the
  system: the Last active cell, the menu hint, the breadcrumb separator, the
  Recent row's timestamp, the See all row, the card meta, the drop-slot copy and
  the Quick Find detail. P4 did not choose it; P4 consumed the token the capture
  gives for exactly this role. `--app-text-secondary` at **4.27:1** light is the
  same family one step up and misses by 0.23.
- The boundary family at **1.15 to 2.71**: the table hairline, the card border
  and the drop slot's dashed edge. This is DV-15 verbatim, whose own note says
  the capture's neutral ramp is compressed at both ends.

Both families point at the same owner and the same decision:
`BUILD-CONTRACT.md` 5.5.4's full contrast reckoning at P12, which is the right
place to decide once whether this product keeps the capture's neutral ramp or
ships an accessible delta. Deciding it per-composite here would mean nineteen
uncoordinated darkenings of the same two tokens.

One measurement is worth flagging for that pass specifically: **the Quick Find
group label measures 3.16:1** in light chrome. It is the single sanctioned
uppercase label in the design, it is 11px, and it is the only label in the app
whose whole job is to be read before the rows under it.

---

## 13. Phase P4 remainder, the static status mark and the four unbuilt regions

This section is the P4 remainder's log. It opens with a new standing design
rule that arrived after P4 shipped and that overrides both the mocks and the
contract wherever they disagree, and then records the four regions 12.3.1 named
as specifications rather than leftovers.

### 13.1 The static-status rule, and the mapping that replaces the pulse

**The rule, verbatim from the user, in force from 2026-08-13:** blinking or
pulsing dot indicators in status pills, badges, or as status marks are BANNED.
Status marks must be STATIC shapes.

It bans motion this program deliberately shipped. `BUILD-CONTRACT` 2.3 and
`DESIGN-SPEC` 6.1 both draw the live states with a pulse, P2.5 authored `mwPulse`
as one of the two named motion patterns for exactly that purpose, P3.2 wired it
to the status dots, and P4 fixed the quoting bug that made the tri-state pulse
render for the first time. `DEVIATIONS.md` DV-14 then leaned on it in writing:
its stated mitigation for the yellow dot at 2.68:1 is "the needs-input dot also
pulses (`mwPulse`, a motion channel that survives greyscale)". Removing the
pulse without replacing that channel would have quietly falsified a recorded
deviation, which is why this work package is a re-ENCODING and not a deletion.

#### The test this sweep applied

A mark is a STATUS MARK, and must be static, when it answers *what is this
thing doing right now* about a state the system can sit in indefinitely.
A mark is an ACTIVITY indicator, and may move, when it exists only for the
duration of one operation the user just started and disappears when that
operation resolves. An activity indicator may still never be a dot: the survivor
list below contains no moving circles that are not rotations.

#### The mapping table

Two shapes carry what one animation used to. `DISC` is the captured 7px filled
circle. `RING` is the same circle with a transparent centre and a 2px inset
stroke, which is the boundary idiom P3 already shipped on the switch off-track
(DV-15), not the coloured glow `DESIGN-SPEC` 1.5 rejects.

| State | Shape | Hue | Where it is drawn |
| --- | --- | --- | --- |
| running, busy, live | **DISC** | `--app-text-green` | `.status-dot-running`, `.ws-session-dot.is-running`, `.ws-session-dot[data-tristate="busy"]`, `.subagent-dot-running`, `.task-item-dot.busy`, `.kanban-column-dot.running`, `.session-live-dot`, `.mirror-live-dot[data-live="true"]`, `.terminal-group-tab.tab-notify::after` |
| needs input, idle, waiting | **RING** | `--app-text-yellow`, orange on the tri-state | `.status-dot-idle`, `.ws-session-dot[data-tristate="waiting"]`, `.task-item-dot.waiting`, and by attention state through `focused-shell.css` |
| booting, waiting on a process | **RING** | `--app-text-tertiary` | `.terminal-pane-loading .terminal-pane-title::after` |
| failed, error | **DISC** | `--app-text-red` | `.status-dot-error` |
| complete | **DISC** | `--app-text-teal` | `.subagent-dot-completed` |
| ready | **rounded square with a tick** | `--app-text-blue` | `.ws-session-dot[data-tristate="ready"]`, `.task-item-dot.ready` |
| stopped, stale, inert, unknown | **DISC**, low emphasis | `--app-text-gray` | `.status-dot-stopped`, `.ws-session-dot`, `.mirror-live-dot`, `.task-item-dot.completed`, `.activity-dot-idle` |
| needs input, as a word | **static chip** | yellow chip pair | `.terminal-pane-header[data-needs-input="true"]::after` |
| conflict count | **static chip** | yellow chip pair | `.pane-conflict-badge` |
| checking, applying | **static low emphasis** | tertiary ink, 45 percent avatar | `.machine-pill-mac.is-checking`, `.account-chip.is-applying` |

**Why the RING is spent on needs-input rather than on running.** It is a
measurement. DV-14 records the yellow dot at 2.68:1 on the light canvas, the
only one of the ten below the 3:1 graphic floor, and nine of the ten clear it.
The one dot whose HUE cannot be relied on is therefore the one dot given a
unique SHAPE, so the channel that is weakest and the channel that is strongest
land on the same mark. A 2px stroke on a 7px circle keeps about 82 percent of
the disc's ink, so DV-14's measured per-pixel ratio is unchanged; what changes
is that colour has stopped being the only channel. This is a deliberate
departure from the shape ordering a naive reading would pick (filled equals on,
hollow equals off), and it is why `.mirror-live-dot`'s inert state stays a muted
DISC rather than becoming a second ring.

**The ring has to be re-asserted twice, and both places are load-bearing.**
`focused-shell.css` re-colours a row's dot from the attention layer at a higher
specificity than any `styles.css` shape rule can reach, so without the four
selectors added there a needs-input row would be re-filled into a plain disc and
the shape channel would survive everywhere except the rows that need it most.
And `semantic-theme.css`'s forced-colours block fills every dot with
`CanvasText`, which under Windows High Contrast is the only place where hue is
gone entirely and the shape is therefore not merely the strongest channel but
the only one.

#### What was swept, seventeen sites

Thirteen CSS rules across `styles.css`, plus the three inline spinoff loading
dots in `index.html`, plus the machine pill. Every one is listed in the mapping
table above or in the survivor list below. Two collateral corrections came with
the sweep because they were inside the rules being rewritten: twenty-eight
Catppuccin `var()` consumptions moved to the block palette (gate G4, 902 to
874), and the needs-input badge's hand-mixed translucent peach became the yellow
chip pair (gate G5b, 46 to 45).

#### The survivors, and why each one is not a status mark

Eleven distinct animations remain in the four stylesheets. Every one was looked
at individually.

| Animation | Consumer | Why it survives |
| --- | --- | --- |
| `spin` | `.btn-loader`, `.resources-refresh-btn.refreshing svg`, `.update-step-running .update-step-icon::after` | Action loaders for one operation the user started. `BUILD-CONTRACT` 2.2 retains them by name for genuinely indeterminate operations. All three are rotations, which gate G14 exempts structurally. |
| `ai-spin` | `.ai-loading-spinner`, `#docs-ai-refresh.ai-loading svg` | The same, on the docs AI refresh. Rotations. |
| `skeleton-shimmer` | `.skeleton` | The sanctioned loading placeholder (DV-20). A skeleton stands in for content that has not arrived; it is not a mark on a thing that exists. |
| `skeleton-pulse` | `.ai-insight-skeleton` | The same, on the insight card. |
| `mirror-skeleton-pulse` | `.mirror-skeleton-row` | The same, on the mirror's initial open. |
| `mic-pulse` | `.terminal-pane-mic.mic-active` | The microphone listening indicator, named as allowed. It reports that the app is capturing audio RIGHT NOW, which is a live physical activity rather than a session state, and a listening indicator that stops moving reads as a microphone that stopped listening. |
| `dropPulse` | `.drop-indicator` | Drag feedback. It exists only while a pointer is down and mid-drag. `DECISIONS` 12.2.2 already protects drag feedback from the hover gate for the same reason. |
| `drag-merge-pulse` | `.terminal-group-tab.tab-drag-merge` | The same, on the tab merge target. |
| `pane-nav-pulse` | `.pane-nav-pulse::after` | A one-shot 700ms wayfinding flash after a jump from a sidebar pip. `forwards`, so it ends. |
| `rename-flash` | `.rename-flash` | A one-shot confirmation flash after a rename. |
| `pane-done-flash` | `.terminal-pane-done` | A one-shot 4s completion flash on the pane FRAME, not a dot. It marks the moment a run finished rather than the state of having finished. |
| `rgb-border-glow` | `.terminal-pane-loading` | The only uncomfortable survivor, and it is left deliberately. It is the pane FRAME rather than a mark, so the ban does not reach it, and its four keyframe stops are byte-identical after P2.7 flattened them, so it animates nothing at all. Removing a dead 3s infinite animation from the pane frame is P5's call, in the phase that owns that region. Its title DOT, which did move, was swept. |
| `mwFadein`, `overlay-in`, `modal-in`, `sheet-up`, `toast-out`, `fade-in`, `mirror-msg-in` | overlays and cards | Entrances and exits. A thing arriving is not a thing reporting its state. |

`mwPulse`, `subagent-pulse`, `activityPulse`, `tristate-pulse`, `pulse-needs-input`,
`loading-dot-pulse`, `conflict-pulse`, `session-live-pulse`, `machinePillPulse`,
`account-chip-pulse`, `pulse-green` and `spinoff-dot` all remain DECLARED and
have zero consumers. Code preservation keeps the declarations; the ban is on
consumption, and that is what the gate measures.

### 13.2 Gate G14, and why it is structural rather than a grep

A gate that greps for `mwPulse` protects against the one mistake nobody is going
to make. The mistake that will actually happen is a new keyframe for a new dot,
six months from now, by somebody who never read this section. G14 therefore
measures CONSUMPTION on status-mark surfaces, three ways:

1. **By name.** A rule whose selector has an identifier segment of `dot`,
   `badge`, `pill`, `chip`, `tristate`, `notify`, `liveness` or `status`, or
   which keys off `data-tristate`, `data-live`, `data-needs-input` or
   `data-attention-state`. Segments rather than substrings, so `.drop-indicator`
   and `.terminal-pane-mic` never trip.
2. **By shape.** Any rule that draws a circle or a capsule
   (`--radius-avatar`, `--radius-pill`, or a literal fifty percent) and animates
   it, whatever it is called. This is the prong that caught the booting-pane
   dot, whose selector says nothing about dots.
3. **Inline.** A `style` attribute in the authored markup or in a renderer that
   does both at once. No stylesheet scan would ever have seen the three spinoff
   loading dots.

**Rotation is the one exempt motion, and it is exempt by construction rather
than by favour.** A circle rotating about its own centre is invisible unless it
is a partial arc, so a rotating mark is a spinner, and a spinner is an activity
indicator for one operation. The exemption requires that EVERY declaration in
the keyframes be a bare rotation, so a keyframe that rotates and fades is still
a blink. `animation: none` is not consumption either, which is what lets the
reduced-motion guards that outlived their animations stay in the sheet under
code preservation.

The gate opens with a baseline of **0**, not with its pre-sweep count of 17,
because the rule that created it is standing rather than a phase target and the
sweep that empties it ships in the same commit. Both prongs were verified
non-vacuous before the commit: a probe rule (a circle consuming `mwPulse`) and a
probe inline style each turned it red, and removing them turned it green.

### 13.3 What the P4 remainder shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| A, the static-status sweep | `e7fff57` | `styles.css`, `index.html`, `focused-shell.css`, `semantic-theme.css`, `scripts/do-not-break-gates.js`, `gate-baseline.json` | Seventeen sites re-encoded from motion to shape. Gate G14. DV-21 and the DV-14 resolution note. |
| B1, the side peek | `bc81ca3` | `styles.css`, `app.js`, `index.html`, `test/side-peek.test.js` | The fixed-measure peek, the `display: contents` property grid, the two properties it gained, the borderless notes editor. |
| P4.6, the docs panel | `5cf5d65` | `styles.css`, `index.html`, `test/docs-document-surface.test.js` | `.nt-layout`, the block box model, the list collapse, the callout. |
| B2, Costs and Settings | `4977054` | `styles.css`, `app.js`, `index.html`, five test files | The Costs interiors, the Settings shell, the account chip, the unset cost, SE-12, the cachebuster. |
| Visual QA | `7fdaa2d` | `styles.css`, `app.js`, `index.html`, `test/browser/notion-shell.spec.js`, `test/side-peek.test.js` | Five defects the p4r capture caught, including the peek's own layout regression. |

Five commits, each revertable on its own, and the order is deliberate: the
sweep and the gate ship first because everything after them is measured against
G14; the peek and the docs panel ship before the two interiors because both are
structural and the interiors are colour and metric work on top; and the visual
QA commit ships last because it can only be written after the pictures exist.

### 13.4 Ambiguities resolved during the P4 remainder

#### 13.4.1 The peek was never beside anything, and a fixed width is what exposed it

`.main-content` is `flex-direction: column`. The detail panel was a sibling of
the session list INSIDE it, so the two split the column's HEIGHT at `flex: 1`
each and the panel had never once been beside the list. That was survivable
while both were elastic and it is not survivable with a measure: a `width` on a
vertically stacked flex item applies while the list's `flex: 1` shrinks to zero,
and the first p4r capture showed a peek alone on the page with 620px of void
next to it.

`DESIGN-SPEC` 7 opens with "a flex sibling of the main column" and `.app-body`
is the only flex ROW in this shell, so the panel moved there in `index.html`.
Every id, handler and query in the subtree is unchanged; only the parent moved.
This is the one markup move in the phase and it is the one the whole region
depended on.

#### 13.4.2 `display: contents` is right here and was wrong for the table

`DECISIONS` 12.2.3 rejected `display: contents` for the sessions table because
it destroys the row's own box, and with it the hover wash, the selected fill and
the drag image. The peek's property rows are the mirror image of that argument:
no handler resolves through `.meta-row`, it carries no hover wash and is not
draggable, and its box existed only to paint the striped card this work package
removes. So the same mechanism that would have broken the table is what lets
twelve label and value pairs align on one column with zero markup change.

#### 13.4.3 The table has to give up columns under a peek, not squeeze them

Opening the peek takes 420px off the main column. Seven fixed percentage columns
in the remainder resolve small enough at a 1280 viewport to CLIP the property
chips: the capture shows `Claude` cut to `Claud` and `Stopped` to `Stop`.
Notion's answer to a narrowed page is to drop columns, so Project and Model
collapse while the peek is open and the remaining five percentages are re-cut.
Project is the one column the sidebar tree already answers and Model is empty on
most rows; both are IN the peek that caused the narrowing.

The hook is a `cwm-peek-open` class on `<body>`, set by `_setPeekOpen`, rather
than a `:has(#session-detail-panel:not([hidden]))` selector. Two reasons: the
peek is a LATER sibling of the main column so no combinator reaches backwards
from it to the table, and four `[hidden]` occurrences in a selector would
inflate gate G3, which counts guards paired with display rules and would then be
describing a rule that is not one.

#### 13.4.4 The account chip's percentage would have been eaten by a timer

`DESIGN-SPEC` 4 draws the chip as `{name} · {n}%`; it showed a reset countdown.
Swapping the text is a one-line change and it hides a real bug:
`_tickAccountCountdowns` rewrites the `textContent` of every `[data-reset-at]`
element inside `.account-switcher` once a minute. Leaving the attribute on a
percentage would have silently replaced `42%` with `Resets in 2 hr 14 min` after
sixty seconds, on a timer, with no user action to correlate it with. The
attribute is removed in the percentage branch and stays where the countdown
actually lives, in the panel rows and the usage meter.

#### 13.4.5 The unset cost is blank, not outlined

`DECISIONS` 12.6 item 4 left this open and `CODEX-PARITY` B10 answers it: the
state is "no value was recorded", not "the value is zero" and not "a control is
disabled". Notion draws an unset property as blank. The dashed bordered box was
an honest attempt at "deliberately empty" that read as its exact opposite, a
form field nobody has typed in, offering an affordance on a row where there is
nothing to click. The dash keeps the tertiary ink, `cursor: help` and the title;
the box goes. CSS only, so the markup `cost-display.test.js` pins character for
character is untouched.

#### 13.4.6 Sanctioned edit SE-12, and why it was taken rather than avoided

`settings-nav-rail.test.js` pinned `--mauve` inside the active rail item's rule.
Three contract rules pull against that pin and none of them is taste: `--mauve`
is a Catppuccin token, so the rail's selected state changed hue with the
TERMINAL theme, which `DESIGN-SPEC` 10.4 forbids and gate G4 counts; mauve is
the brand primary P3.1 retired; and the same rule carried a 2px left accent bar,
which is the rejection-list item that took the sidebar's bars in P2.2 and the
tab underlines in P4.4. The assertion's INTENT, that the active rail item is
visibly distinguished by a rule of its own, is preserved and retargeted to
`--app-sidebar-item-selected`, with a new negative assertion that the bar does
not come back. Shipped in the same commit as its source change, per 5.4.

It is recorded as SE-12 rather than smuggled in, because it is not on the
contract's SE-1 to SE-11 list and the orchestrator can revert it alone.

#### 13.4.7 The 720px column's gutters are a container measurement, not a viewport one

`BUILD-CONTRACT` P4.6's done criterion says "at 1440 the docs text column
measures exactly 720px with 375px gutters". Gutters resolve against the
CONTAINER, and in this shell the docs panel sits inside `.main-content` beside a
240px sidebar. At a 1440 viewport with the sidebar open the column measures 720
with about 239px gutters; 375px arrives at a 1911px container, or at 1440 with
the sidebar collapsed. The grid is the capture's grid verbatim either way. What
the criterion is protecting is the 720px column and the untinted, unbordered
gutter, and both hold; reproducing the literal 375 would mean hiding the
sidebar, which is not what it is asking for.

### 13.5 Scope decisions, and what was deliberately left alone

1. **The peek has no drag-resize and no `Open in Workbench` button.**
   `DESIGN-SPEC` 7 gives both. The resize handle needs a drag controller and a
   persisted width, and the button needs the pane-spawn path, which belongs to
   the terminal region P5 owns. The peek's measure is a token change away from
   being draggable when somebody wants it.
2. **The peek has no `Last output` block** (spec item 6). It needs a transcript
   read per selection, which is a data path rather than a style, and the mirror
   pane already renders exactly that content one click away.
3. **The Costs breakdown keeps its eight-hue categorical ramp.**
   `DESIGN-SPEC` 9.2 gives the Share meter a single `--app-text-blue` fill, and
   this app's breakdown is categorical (by project, by model) rather than a
   single share. P2.7 deliberately shipped that ramp through the chrome hue
   projection as the sixth colour map. Overriding it here would undo another
   work package to satisfy a spec line written for a different chart.
4. **`.terminal-pane-loading`'s `rgb-border-glow` survives**, and 13.1 records
   why: it is the pane FRAME rather than a mark, and its four keyframe stops are
   byte-identical, so it animates nothing. Deleting a dead animation from the
   pane frame is P5's call in the phase that owns that region.
5. **`styles-mobile.css` was not touched, for the third phase running.** G7 sits
   at 3 for the reason DV-19 records.
6. **The `app.js` inline palette census is still not finished.** 12.3.3 counted
   about 68; this phase moved the Costs card hues, the analytics running count
   and the three spinoff dots, and the rest still belong to their regions.

### 13.6 The numbers

| Measure | After P4 | After the P4 remainder |
| --- | --- | --- |
| `styles.css` lines | 14788 | **15565** |
| `focused-shell.css` lines | 1626 | **1651** |
| `semantic-theme.css` lines | 273 | **291** |
| Gate G3, `[hidden]` guards (up is better) | 25 | **25** |
| Gate G4, Catppuccin `var()` in chrome | 902 | **751** |
| Gate G5b, raw `rgba()` outside `:root` | 46 | **41** |
| Gate G7, uppercase labels | 3 | **3** |
| Gate G9a, `linear-gradient` | 1 | **1** |
| **Gate G14, animated status marks (new)** | 17 before the sweep | **0** |
| Test files / assertions | 83 / 1402 | **85 / 1465** for this track's own runs |

The assertion delta this track owns is **+63**: 35 in the new
`side-peek.test.js`, 27 in the new `docs-document-surface.test.js`, and 1 from
gate G14 joining the `do-not-break-gates.test.js` loop. One existing assertion
was retargeted, SE-12, in the same commit as its source change. Concurrent
tracks (P6, P8, P9) added further files and assertions to the same suite between
runs; the final `npm test` on this branch reports **90 files and 1536 assertions,
zero failures**, which is why the totals in this row are stated as "for this
track's own runs".

G4's 151-point drop is the largest single-phase fall the counter has recorded,
and none of it was a sweep: every one came out of a rule this phase was
rewriting for another reason. That is the pattern 12.3.3 asked for, colour
moving with its region rather than as a separate pass.

### 13.7 The p4r screenshots, and an honest reading of them

`screenshots/notion-restyle/p4r/`, the same frozen eight-shot matrix as P0
through P4, plus a new opt-in `regions/` set of eight.

**The region set exists because of a hole this phase fell into.** Four of the
regions the restyle changes are not reachable from either of the two standard
routes: the side peek needs a selected session, and Docs, Costs and Settings are
their own views. They were being shipped without anybody looking at them, which
is exactly how the peek's layout regression got as far as a commit.
`--regions` captures them at desktop in both chromes into their own directory
under their own manifest key, so the standard matrix stays frozen and any two
phases remain comparable.

**All sixteen were looked at, and five shipped fixes came out of looking.** They
are listed in the `7fdaa2d` commit message: the peek stacking below the list
rather than beside it, the table clipping its chips under the peek, five blue
emoji squares where the docs section carets should be, the Costs title lining up
with nothing, and the Sessions section label inset 16px from its neighbours.

**What changed, and it is what the phase existed for.** Nothing in the
application blinks. The peek is a Notion peek: a 44px band mirroring the topbar,
a 22px page title, and twelve properties on one aligned column with no card
around them. The docs panel is a document: a 720px measure in a 1040px panel,
headings at the captured H3, list items on a 40px rhythm that collapses to 1px
inside a run. Costs is a page of sections rather than eight raised tiles.
Settings is a list on hairlines rather than a list of buttons.

**What still reads as the old design**, top deltas first, each with its owner:

1. **The phone is still the old IA.** Every region this phase touched has a
   desktop-scoped ladder and a phone floor, and none of them has a phone
   DESIGN. **P10.**
2. **The terminal surface inside the pane frame is untouched.** No xterm
   internals, no Select machinery and no part of the write pipeline was read or
   modified. **P5.**
3. **The settings search field's focus ring spans the full row.** It is the
   universal `:focus-visible` outline (DV-8) on a borderless 100 percent wide
   input, so it reads as a blue slab across the dialog on open. Correct and
   accessible; heavy. **P12's 5.5.4 focus and contrast reckoning.**
4. **The Costs timeline's empty state is 180px of nothing** under a section
   label, which is the largest void on any page in the app. It is an empty-state
   copy problem rather than a layout one. **P12.**
5. **Two uppercase rules survive in `styles-mobile.css`**, DV-19. **P10.**
6. **The two contrast families from P3 are unchanged**, DV-10 and DV-12 through
   DV-15. **P12's 5.5.4.**

### 13.8 Contrast, measured for every surface this phase drew

Fifty-four pairings, computed from the shipped token values in both chromes,
with translucent grounds composited over their page ground before the ink is
composited over them. `PROCEDURE.md` 4.2's floors: 4.5:1 for text, 3:1 for a
boundary or a graphic.

**Every ink this phase put on a ground clears its floor, or fails only in a
family already recorded.** No new deviation row is incurred for contrast, and
one pairing was re-cut rather than recorded, which is the difference between
this table and P4's.

| Composite | Light | Dark |
| --- | --- | --- |
| Peek page title and property values | 13.98 | 15.30 |
| Peek notes ink on its focus wash | 13.04 | 13.23 |
| Docs section title and item text | 13.98 | 15.30 |
| Docs item text on the hover box | 13.04 | 13.23 |
| Docs callout ink on the yellow ground | 12.57 | 8.33 |
| Docs callout ICON on the yellow ground, after the re-cut | 12.57 | 8.33 |
| Roadmap active chip, yellow pair | 5.98 | 4.95 |
| Roadmap done chip, green pair | 6.77 | 5.72 |
| Subagent count chip, gray pair | 7.26 | 5.62 |
| Costs card value | 13.98 | 15.30 |
| Costs table cell ink | 13.98 | 15.30 |
| Costs table cell on a hovered row | 13.41 | 13.23 |
| Costs chart series against the canvas | 4.25 | 4.14 |
| Costs tooltip ink on the elevated ground | 13.98 | 14.18 |
| Settings row title on the modal card | 13.98 | 14.18 |
| Settings rail active item ink | 12.34 | 12.11 |
| Settings rail item on the rail ground | 4.03 | 6.97 |
| Account chip avatar, purple chip pair | 7.17 | 6.17 |
| Needs-input badge, yellow chip pair | 5.98 | 4.95 |
| Conflict badge, yellow chip pair | 5.98 | 4.95 |
| Running DISC on the canvas | 3.62 | 4.86 |
| Waiting RING stroke, orange | 3.18 | 5.54 |
| Activity dot, purple | 4.09 | 4.30 |

**One pairing was re-cut rather than recorded.** The docs callout ICON was
`--app-text-yellow` on `--app-bg-yellow` and measured **2.41:1** in light chrome
against a 3:1 graphic floor. This is DV-13's counterexample repeating itself: a
light wash raises the ground without darkening the ink, so re-pairing hue onto
its own wash makes a pairing WORSE rather than better. The GROUND is what
carries the hue in a callout, which is also what `PROCEDURE` 6.3's recipe says,
so the icon took the primary ink and the pairing went from 2.41 to 12.57.

**Twenty-eight pairings sit below their floor and every one is a consumption of
a family already recorded.** Four families, no more:

- `--app-text-tertiary` at **2.67:1** light and **4.11:1** dark, DV-10's
  recorded number exactly. It is the ink for the peek's property labels and
  placeholder, the docs timestamps, the Costs table header and percentages, the
  account chip's usage figure and the unset-cost dash. On the transcript's
  raised ground it falls further, to **2.32:1** light, because the ground rises
  and the ink does not.
- `--app-text-secondary` at **4.27:1** light, DV-10's "same family one step up
  and misses by 0.23". It is the ink for every section label this phase drew.
- The boundary family at **1.15 to 1.50**: the peek's left hairline, the
  Costs card hairline, the Settings row separator and the chart grid line. DV-15
  verbatim, whose own note says the capture's neutral ramp is compressed at both
  ends.
- The yellow and orange block hues at **2.36 to 3.18** light: the needs-input
  RING on the canvas and on a hovered sidebar row, and the Costs share meter
  against its dark track. DV-14 verbatim. **The ring measures 2.68 on the canvas,
  which is the DISC's own recorded number**, and that is the point 13.1 makes:
  the shape channel is added at no contrast cost, because a 2px stroke and a
  filled circle are the same pixels at the same ratio.

All four point at the same owner and the same decision, `BUILD-CONTRACT.md`
5.5.4's full contrast reckoning at P12, which is where this product decides once
whether it keeps the capture's neutral ramp or ships an accessible delta.

### 13.9 What P5, P10 and P12 inherit

1. **A standing rule and a gate that enforces it.** G14 is a permanent gate with
   a zero target and no phase, and it measures consumption structurally rather
   than grepping for one keyframe name. Any new dot, pill or badge that animates
   turns the suite red on the commit that adds it. Rotation is the one exemption
   and it is exempt by construction.
2. **A peek that is a real layout sibling.** `#session-detail-panel` is now a
   child of `.app-body`. Anything P10 does to the phone shell has to keep it
   `position: fixed` under 768px, which `styles-mobile.css` already does, and
   the desktop ladder is scoped to `min-width: 769px` so the two never fight.
3. **`.nt-layout`, authored and ready for four more surfaces.** `PROCEDURE`
   step 6 item 3 names modal bodies, settings panes and empty states alongside
   the docs panel. Only the docs panel takes it today; the other three are one
   class each, and the four modifiers are already in the sheet.
4. **A `cwm-peek-open` body class**, which is the first responsive hook in this
   app that is driven by application state rather than by viewport width. The
   phone IA will want the same idiom.
5. **A screenshot harness that can reach four more regions.** `--regions` is
   opt-in and its route list is a four-line array; adding the mirror pane, the
   agent board or the attention popover is one entry each.
6. **A contrast reckoning that is now four families wide**, with every number
   measured and every family owned by 5.5.4. Nothing in the P4 remainder needs a
   per-composite decision; it needs one decision about the neutral ramp.
7. **Sanctioned edit SE-12**, taken but revertable alone, and the precedent that
   an implementation agent records a new SE number rather than editing a pin
   quietly.
---

## 14. Phase P5, terminal input correctness and the surface projection

This section is P5's log. The phase has three halves rather than two, and they
are independent: the input path (P5.1 to P5.3), the colour projection (P5.4),
and the region restyle (P5.5). Any one of the three commits reverts without the
other two.

### 14.1 What shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| P5.1, P5.2, P5.3 | `f82a946` | `terminal.js`, `styles.css`, `test/paste-input-preparation.test.js` (new), `test/bracketed-paste-isolation.test.js`, `test/paste-secure-context-fallback.test.js`, `test/run.js`, `INVENTIONS.md` | `prepareInputForPty`, the DEC 2004 gate, CRLF normalisation, the embedded end-marker sanitiser, the 9.4 confirm, `Ctrl+Shift+C`, `Ctrl+Shift+A`, scrollback 5000 to 10000, `--font-terminal`. Sanctioned edit SE-13. |
| P5.4 | `c888920` | `terminal-surface.js` (new), `terminal.js`, `theme-registry.js`, `index.html`, `test/terminal-surface.test.js` (new), four pinning tests, `test/run.js` | The projection, the xterm `ITheme` builder, the `--term-*` publication, the registry accessor, the font read, the `document.fonts.ready` refit, the cachebuster bump. Sanctioned edit SE-14. |
| P5.5 | `50be81b` | `styles.css`, `test/phantom-tokens.test.js`, `test/browser/notion-shell.spec.js` | The pane frame, the gutter, the 38px header, the terminal surface and its padding, the terminal scrollbar, the input row's palette contract, the booting pane, the phone floor, two live-PTY region shots. |

### 14.2 Ambiguities resolved during P5

#### 14.2.1 The bracket gate has three sources and may depend on none of them

`TERMINAL-ARCHITECTURE` D1 says to gate on `term.modes.bracketedPasteMode`.
P6.3 then shipped a server-side `mode` frame carrying the same fact, measured
by a headless VT that sees every byte including the ones this client was not
attached for, and put it behind `CWM_VT_SIDECAR`, which **defaults off**.

`isBracketedPasteMode()` therefore reads three sources in falling order of
authority: the mode frame when one has arrived, xterm's own public `IModes`
reader otherwise, and `false` underneath. The frame is an UPGRADE, never a
dependency, which is what the constraint "nothing you ship may hard-depend on
the mode frame" requires and what the executed test asserts by running the
reader with the frame absent.

`false` is the right floor in both directions, and that is not symmetric
reasoning: a missing bracket pastes the text literally, which is mildly wrong,
while a spurious bracket prints `[200~` into the user's shell, which is
visibly broken. The safe default is the one that degrades quietly.

#### 14.2.2 Ctrl+A is not touched, and that is the architecture's ruling

The brief asked whether select-all should be wired to `Ctrl+A` when the
terminal has focus. It is not, and `TERMINAL-ARCHITECTURE` 8.4 rules for the
Shift form explicitly. `Ctrl+A` is beginning-of-line in readline and therefore
in every shell, editor and agent CLI this application spawns, and it is the
default tmux and screen prefix. Intercepting it would break the terminal to
add a convenience.

`Cmd+A` on macOS is left alone too: xterm 6 already maps it to its own
`SELECT_ALL` action, so it works today and adding a handler would shadow it.

#### 14.2.3 Three suites read the Ctrl+C branch out of the source, so the two new shortcuts sit above it

`copy-secure-context-fallback.test.js` slices from `if (mod && shortcutKey === 'c'`
to the next `return false;` and asserts the slice contains no `preventDefault`
and no `copyTextToClipboard`. `terminal-select-mode.test.js` slices the same
branch to the `// Ctrl+V / Cmd+V` comment and asserts the same two absences.
`terminal-select-v2.test.js` extracts it by balanced braces and asserts it does
not unfreeze Select mode.

Both new branches use `preventDefault` and one uses `copyTextToClipboard`, so
their PLACEMENT is load bearing twice over. They are spelled
`if (mod && e.shiftKey && shortcutKey === 'c')`, which does not begin with the
anchor string, and they sit ABOVE the plain branch, which is also what the
behaviour needs: `mod && shortcutKey === 'c'` is true with Shift held, so the
plain branch would otherwise swallow `Ctrl+Shift+C` and hand it to a native
copy Chromium has bound to Inspect Element.

#### 14.2.4 The projection is data, and the direction of flow is the decision

`CURRENT-UI` 6.2 frames the problem as eight palettes being unreachable FROM
CSS, which reads as an instruction to make the terminal read CSS. P5.4 does the
opposite: the projection is a static table and it PUBLISHES seven `--term-*`
custom properties into CSS.

Three reasons, each of which rules out the other direction. A CSS read needs a
resolved stylesheet, so a pane constructed before first paint would get a
half-resolved palette, which is the failure the eight static palettes were
written to prevent. `_colorWithAlpha` parses six-digit hex only and silently
returns its fallback for anything else, so a custom property re-authored as
`oklch()` or `color-mix()` would take the terminal's selection colour with it
without an error (risk R5); a data table can guarantee the format, a token
cannot. And the pane chrome has to paint the SAME value the canvas paints:
publishing makes that true by construction, while reading leaves two systems
free to disagree, which `TERMINAL-ARCHITECTURE` 10.1 calls the highest risk
item for perceived quality.

What makes a static table safe is the drift gate, not care.
`test/terminal-surface.test.js` re-derives all thirteen palettes from the real
per-theme blocks in `styles.css` through the real `_buildThemePalette` in
`terminal.js` and compares key for key. It was verified non-vacuous by editing
`--base` for Nord and watching it fail.

#### 14.2.5 The drift gate found eleven pre-existing divergences on its first run

None is visible today, because the eight static palettes never went through the
builder. All eleven keep their SHIPPED value, because P5.4's done criterion is
that nobody's terminal changes colour, and in each case the shipped value is
also the better one:

| Divergence | styles.css derives | The palette ships | Why the shipped value stays |
| --- | --- | --- | --- |
| `mocha.brightWhite` | `#cdd6f4` (`--text`) | `#a6adc8` | Catppuccin's own subtext0 mapping for ANSI 15, and the mock's `dim` for this theme. The builder's generic rule collapses ANSI 15 onto the foreground and loses a step. |
| `macchiato.selectionBackground`, `frappe.selectionBackground` | alpha `0.25` | alpha `0.3` | Two palettes authored a slightly stronger wash. Both are legible; changing one would move a colour for no reason. |
| `cherry`, `ocean`, `amber`, `mint`: `.cursor` and `.selectionBackground` | `--rosewater` and `--mauve` | each theme's signature colour | All four invented dark themes chose a signature cursor and derived the wash from it. The cursor is the most identity-carrying pixel in a terminal and it moves on every keystroke. |

The exemption list is itself gated: a second check asserts every entry is STILL
a real divergence, so a future edit that reconciles one fails rather than
leaving a stale licence behind.

#### 14.2.6 Six of the mock's dim and accent values do not clear the floor on the ground this application ships

`DESIGN-SPEC` 10.2's table is the source for `dim`, `rule` and `accent`, and it
is taken verbatim in seven of the thirteen. Six values were re-paired, each
onto another step of the SAME palette, because `PROCEDURE` 4.2 forbids
darkening a captured value and prescribes re-pairing:

| Slot | Mock | Measured | Shipped | Measured | Source |
| --- | --- | --- | --- | --- | --- |
| `dracula.dim` | `#6272a4` | 3.03 | `#b8b8b0` | 7.13 | `--subtext0` |
| `tokyo-night.dim` | `#565f89` | 2.76 | `#9aa5ce` | 7.04 | `--subtext0` |
| `latte.dim` | `#8c8fa1` | 2.83 | `#5c5f77` | 5.53 | `--subtext1` |
| `rose-pine-dawn.dim` | `#9893a5` | 2.73 | `#6e6a86` | 4.73 | `--subtext0` |
| `gruvbox-light.dim` | `#7c6f64` | 4.29 | `#504945` | 7.78 | `--subtext0` |
| `rose-pine-dawn.accent` | `#b4637a` | 3.84 | `#286983` | 5.59 | `--blue`, Rose Pine's own `pine` |

The rule is mechanical rather than a taste: walk `--subtext0`, `--subtext1`,
`--text`, take the first that clears 4.5:1. In every one of these palettes that
order is quietest first, so "the first that clears" and "the quietest that
clears" are the same value, which is what `dim` wants to be.

`TERMINAL-ARCHITECTURE` 10.5 makes this a gate for the three light themes only
(verification gate VG-7). It is applied to all thirteen, because a floor that
holds for three of thirteen is a floor somebody steps off, and because two of
the five failures were dark themes. **VG-7 is closed**: `dim` on `bg` measures
4.64 to 7.78 across the set, and `latte`, `rose-pine-dawn` and `gruvbox-light`
measure 5.53, 4.73 and 7.78.

`rule` is NOT substituted anywhere. It is a 1px divider, so its floor is the
3:1 boundary floor rather than the text floor, and it measures 1.27 to 1.80.
That is the same compressed-neutral-ramp family `DEVIATIONS` DV-15 already
records, with the same owner: 5.5.4's contrast reckoning at P12. Raising it per
theme here would be thirteen uncoordinated answers to one question.

#### 14.2.7 The terminal padding is safe for the PTY, and that had to be checked rather than assumed

`DESIGN-SPEC` 5.5 puts 12px by 14px of padding on the pane body. Padding on the
element xterm mounts INTO would ordinarily be a column-count bug: the terminal
would be fitted to a box larger than the space it has and would clip.

The vendored FitAddon reads `getComputedStyle(parentElement)`'s `height` and
`width`, and the CSSOM resolves both to USED values, which are content-box
figures. The padding is therefore already excluded from the area it fits into.
Measured on the captured pane rather than reasoned about: the terminal's first
column lands 14px inside the frame and there is no horizontal overflow at any
of the four probed widths.

The cost is real and bounded: 28px of width is about four columns at this cell
size, which is why the two numbers are tokens and why the phone floor halves
them.

#### 14.2.8 A webfont terminal face needs a second fit, and the first one is not enough

`--font-terminal` resolves to a self-hosted face declared with
`font-display: swap`. On a cold load the browser can measure the FALLBACK face,
hand xterm a cell width, and swap the real face in underneath it. The symptom
is column drift: a pane that fitted 96 columns reflows to 92 a moment later,
and the CLI on the other end has already drawn for 96.

`mount()` now also refits on `document.fonts.ready`, which settles once every
pending face has loaded or failed. It is additive to the existing 200ms safety
refit rather than a replacement, because the two answer different questions:
one is "the face arrived", the other is "the layout settled".

### 14.3 Scope decisions, and what was deliberately left alone

1. **The Select v1, v2 and v3 machinery is untouched.** Not one identifier was
   renamed, moved or reformatted. `terminal-select-v2.test.js` (134
   assertions), `terminal-select-mode.test.js` and `terminal-host-ownership.test.js`
   all pass unedited. P7 rescopes Select mode; P5 only added.
2. **`Ctrl+Shift+A` selects the terminal buffer, not a history document.**
   Stage 3 upgrades it. Today it selects everything that exists.
3. **The grid padding `DESIGN-SPEC` 5.2 specifies is not applied.** `app.js`
   positions the drag splitter with `left: calc(pct% - 3px)`, and a percentage
   on an absolutely positioned child resolves against the PADDING box, so a
   16px pad would move the handle 16px away from the seam it drags. The 12px
   gap alone is safe: at a 50/50 split the seam centre and the percentage point
   coincide exactly, and the worst case at the 25/75 clamp is 6px against a
   22px hit area. Applying the padding is two lines in `app.js`, which this
   phase does not own. `DEVIATIONS` DV-27.
4. **The desktop pane input row is not created.** `DESIGN-SPEC` 5.6 draws one;
   this application has an input row in the markup for all six panes and it is
   `display: none` above the phone breakpoint. Making it visible on the desktop
   is an IA decision with a wiring cost (the send path, the history, a row of
   vertical space in every pane) and it belongs with the composer P10 and P12
   own, not with a region restyle. What P5 does ship is the palette CONTRACT
   for it, so whoever turns it on gets a correct row rather than a chrome
   coloured one. `DEVIATIONS` DV-26.
5. **The mobile sheet was not swept, for the fourth phase running.** The input
   row's geometry, its field and its send button stay in `styles-mobile.css`.
   P5 takes only the four properties `DESIGN-SPEC` 5.6 makes a palette
   contract, one of which (the typed text's colour) is a bug fix rather than a
   style: `--text-primary` on a `--term-bg` ground is near-black ink on a
   near-black ground the moment the row moves into the palette.
6. **`app.js` was not touched at all.** The theme change re-themes live panes
   through the loop it already has, because `getCurrentTheme()` publishes the
   CSS variables as a side effect. The `data-theme` observer covers the case
   that loop cannot see, which is a theme change with zero panes open.

### 14.4 The numbers

| Measure | After the P4 remainder | After P5 |
| --- | --- | --- |
| `terminal.js` lines | 5286 | **5928** |
| `styles.css` lines | 15565 | **15877** |
| `theme-registry.js` lines | 141 | **187** |
| `terminal-surface.js` lines | did not exist | **553** |
| Gate G4, Catppuccin `var()` in chrome | 751 | **747** |
| Gate G6, numeric radius literals | 0 | **0** |
| Gate G8, `translateY` | 16 | **16** |
| Gate G14, animated status marks | 0 | **0** |
| Animations consumed on the pane frame | 1 (dead) | **0** |
| Test files / assertions | 90 / 1541 | **94 / 1642** |

P5's own assertion delta is **+64**: 37 in the new
`paste-input-preparation.test.js`, 24 in the new `terminal-surface.test.js`,
2 added to `bracketed-paste-isolation.test.js` because the architecture asks
for the mode gate by name, and 1 added to
`paste-secure-context-fallback.test.js` for the shell-pane case that could not
be expressed before the bracket was gated. Two new files, two sanctioned edits
(SE-13 and SE-14), each in the same commit as its source change. The remaining
delta against 94 files is the concurrent P10 track's two files.

G4's four-point fall is smaller than it looks in both directions. Ten palette
consumptions were removed from the pane header, the pane title, the active
header, the grid ground and the reduced-motion guard; seven were ADDED, and
every one of them is a `var(--term-x, var(--palette))` FALLBACK on a terminal
surface. Those seven are the one place in the sheet where a Catppuccin token is
the correct value: `DESIGN-SPEC` 10.4 says the palette paints the terminal, and
the fallback's whole job is to be right in the window before the projection has
published. G4 cannot tell the two cases apart, which is worth knowing before
somebody drives it to zero by deleting them.

### 14.5 Contrast, measured for every palette

Computed from the shipped values, ink against its own terminal ground, all
thirteen.

| theme | ink | dim | accent | rule | ANSI worst | ANSI best |
| --- | --- | --- | --- | --- | --- | --- |
| `mocha` | 11.34 | 7.37 | 8.07 | 1.80 | 1.80 black | 12.91 yellow |
| `macchiato` | 9.92 | 6.62 | 6.84 | 1.77 | 1.77 black | 10.20 yellow |
| `frappe` | 8.06 | 5.55 | 5.60 | 1.72 | 1.72 black | 8.06 brightWhite |
| `nord` | 10.84 | 4.64 | 6.24 | 1.45 | 1.45 black | 10.84 brightWhite |
| `dracula` | 13.36 | 7.13 | 5.90 | 1.56 | 1.56 black | 13.36 brightWhite |
| `tokyo-night` | 10.59 | 7.04 | 6.79 | 1.74 | 1.74 black | 10.59 brightWhite |
| `cherry` | 13.16 | 4.95 | 5.35 | 1.39 | 1.74 black | 13.16 brightWhite |
| `ocean` | 12.96 | 5.63 | 6.97 | 1.56 | 1.65 black | 12.96 brightWhite |
| `amber` | 13.62 | 5.42 | 7.70 | 1.55 | 1.73 black | 13.62 brightWhite |
| `mint` | 13.69 | 6.30 | 7.98 | 1.69 | 1.77 black | 13.69 brightWhite |
| `latte` | 7.06 | 5.53 | 4.79 | 1.61 | 1.61 brightWhite | 5.53 black |
| `rose-pine-dawn` | 6.66 | 4.73 | 5.59 | 1.27 | 1.27 brightWhite | 5.59 brightBlue |
| `gruvbox-light` | 10.22 | 7.78 | 5.40 | 1.51 | 1.92 brightWhite | 9.24 black |

**Every ink, every dim and every accent clears 4.5:1 in every palette.** That
is the part this phase could deliver and it is delivered for all thirteen
rather than for the three the gate names.

**The ANSI set does not, and cannot without redesigning the palettes.** 55 of
the 208 ANSI pairings measure below 4.5:1, which is `BUILD-CONTRACT` P5.5's
done criterion unmet, and the shape of the failure is the reason it is unmet
rather than unfinished:

- **21 are ANSI black and bright black.** Slot 0 is the background-adjacent
  colour by ECMA-48 convention: it is what an application paints BEHIND text,
  and what box-drawing and dim rules reach for. Every terminal emulator ever
  shipped has it near the ground. 1.27 to 2.61 here.
- **6 are ANSI white and bright white on the three light themes.** Same
  argument at the other end: slot 7 is the light end of the ramp and a light
  theme's ground is at the light end too.
- **28 are genuine hues**, and all but four are on the three light palettes,
  where a saturated mid-tone on a near-white ground is inherently a hard
  pairing (`latte` yellow 2.31, `rose-pine-dawn` yellow 2.05). The four dark
  ones are Nord's red and magenta at 3.05 and 4.41.

Fixing these means re-authoring Catppuccin, Nord, Dracula, Tokyo Night, Rose
Pine and Gruvbox, which would change every existing user's terminal, break the
thirteen palettes `DESIGN-SPEC` 10.5 calls invariant DATA, and re-open the
`theme-registry.test.js` background pins. Recorded rather than done, as
`DEVIATIONS` DV-24, with the numbers, for 5.5.4's reckoning at P12.

### 14.6 The p5 screenshots, and an honest reading of them

`screenshots/notion-restyle/p5/`, the frozen eight plus eleven region shots.

**The region set gains two, and both spawn a live PTY**, because a terminal
pane with nothing attached is a drop slot and shows none of what this phase
changed: not the ground, not the padding, not the ANSI palette, not the new
face, not the scrollbar. `desktop-light-terminal` and `desktop-dark-terminal`
spawn the provider CLI, which is the pane P5.5's acceptance criterion is
actually about; `desktop-light-terminal-mocha-on-light` spawns a bare shell
because its one job is a proof and it should not depend on a CLI's cold start
to make it.

**The two-axis proof is measured rather than eyeballed**, and it had to be:
looking at that PNG in a viewer suggested the whole page had gone dark, and the
pixels say otherwise. Sampled from the file: sidebar `#f1f0ef`, topbar
`#ffffff`, terminal ground `#1e1e2e`. The chrome is Notion light while the
terminal palette is Mocha, which is `DESIGN-SPEC` 10.1's two independent axes
working, and it is a picture that could not have been taken before P5.4.

The harness now records the live `data-chrome`, `data-theme`, the sidebar and
terminal grounds and the `--term-*` values per region shot, so the next reader
does not have to sample pixels to find that out.

**What the pictures show that is new.** The pane is a card: an 8px frame on a
hairline over a canvas gutter, with 12px between panes instead of a 2px seam.
The terminal has room, 14px of it, so the first column no longer touches the
frame. The face is iA Writer Mono at the same 13px and the same 1.2 line
height, so the cell metrics are the terminal's own. The header is a 38px band
with the provider tint, the pill, the title and the icon row, and nothing in
it is mauve.

**What still reads as the old design**, each with its owner:

1. **The pane input row is invisible on the desktop.** Its palette contract
   ships; the row itself is `display: none` above 768px. **P10 or P12.**
2. **The first-run Copy hint pops over the top right of the pane** and lands in
   two of the region shots. It is a one-time hint on a fresh profile and every
   capture run gets a fresh profile, so it will be in every future p-set too.
   Worth suppressing in the harness. **The harness owner.**
3. **The pane's active ring is a 2px inset blue** inside a 1px hairline, so a
   focused pane carries two borders one pixel apart. `DESIGN-SPEC` 5.3
   specifies exactly that, and it reads heavier than the mock does at this
   scale. **P12.**
4. **The terminal scrollbar is only visible while scrolling** in the shots,
   which is xterm's own overlay behaviour rather than the new rule.
5. **The phone terminal is a floor, not a design.** **P10.**

### 14.7 What P7 inherits

1. **`terminalSurface(themeId)`**, returning
   `{ id, appearance, bg, ink, dim, rule, accent, cursor, cursorAccent, selectionBg, selectionInk, fontFamily, ansi{16} }`
   for all thirteen ids and `null` for anything else. Stage 3's history layer
   reads `bg`, `ink`, `dim`, `rule` and `accent` from exactly here, and 10.3's
   typography table reads `fontFamily` from the same object.
2. **Seven `--term-*` custom properties on the document root**, republished on
   every theme change by three overlapping triggers. Anything the history layer
   draws in CSS can name them instead of measuring the terminal.
3. **The seam is already closed for colour.** `.terminal-container` paints
   `--term-bg`, which IS the value xterm paints, so a layer that occupies the
   pane body rect over that ground is invisible at its edges by construction.
   What stage 3 still has to derive from the live instance is METRICS, per 10.3.
4. **`prepareInputForPty` and `isBracketedPasteMode`**, both module level or
   stateless, both executed by tests. Stage 4's paste paths route through the
   same function.
5. **`Ctrl+Shift+A` wired and ready to be upgraded.** It calls
   `term.selectAll()` today; P7.6 replaces the body, not the binding.
6. **A drift gate that will fail on P7's behalf.** If P7 adds a slot to the
   projection it must add it to `CSS_VARIABLES` or to the exemption list, and
   the phantom-token allow-list asserts CSS consumption in both directions.
7. **Two live-PTY region shots and a harness that kills its own probes.**
   Adding a history-layer shot is one entry in `REGION_ROUTES`.

---

## 15. Phase P10, mobile IA and viewport

This section is P10's log. It covers work packages P10.1 through P10.7 plus
the two P9 frontend contracts nobody had picked up.

### 15.1 What P10 shipped, and where

| WP | Commit | Files | What |
| --- | --- | --- | --- |
| P10.1, P10.2 | `5a22ded` | `index.html`, `app.js`, `styles-mobile.css`, `test/mobile-ia-contract.test.js`, `test/focused-shell.test.js`, `test/mobile-ux-fixes.test.js`, `test/run.js` | The five-tab bar, the Home screen, the Attention tab, the Search tab, the capability route markers, and sanctioned edits SE-8, SE-9 and SE-10. |
| P10.3, P10.4, P10.7 | `8d650b8` | `mobile-viewport.js` (new), `app.js`, `index.html`, `styles-mobile.css`, `test/mobile-viewport.test.js`, `test/terminal-select-mode.test.js`, `test/copy-secure-context-fallback.test.js` | The viewport driver, the CSS contract, the safe-area sweep, the toast anchor, and SE-7 for the app.js cachebuster. |
| P10.5 | `2dff26a` | `app.js`, `styles-mobile.css`, `test/mobile-ia-contract.test.js` | The permanent input row, the microphone, the image button, Raw keys, and the pane overflow sheet. |
| P10.6 tokens | `b45cd7f` | `styles-mobile.css`, `gate-baseline.json` | The Catppuccin, hex, rgba and uppercase sweep of the phone stylesheet. |
| P9 consumption | `a44e695` | `app.js` | The `toDocs` flag and the token-usage cost badges. |
| P10.6 targets | `54113de` | `styles-mobile.css`, `app.js`, `test/browser/notion-shell.spec.js` | The measured 44px sweep, the targets it found, and the mobile capture matrix. |

### 15.2 The A.3 capability map, walked

Every row of MOBILE-EXPERIENCE A.3 and where it now lives.
`test/mobile-ia-contract.test.js` asserts the marker for each; this table is
the human-readable form of the same manifest, and it is what "zero orphans"
means in practice.

| Capability | Route now | Marker |
| --- | --- | --- |
| Switch primary view | Five-tab bottom bar | the five `data-mw-route` nav ids |
| Workspace switch | Home header tile, opens a workspace sheet | `openMobileWorkspaceSheet` |
| Project list | Workspace sheet, Projects row; the drawer is still reachable | `label: 'Projects'` |
| Discovered sessions | `showMoreMenu` Discover row, retained | `label: 'Discover sessions'` |
| Back from a detail surface | Injected header chevron, shown for the five Home destinations | `dataset.mwRoute = 'nav-back'` |
| Sign out | `showMoreMenu` Account group, retained | `label: 'Sign out'` |
| Session list | Sessions tab | `case 'sessions-all':` |
| Session open | Home card or Recent row tap | `data-mw-route="session-open"` |
| New session | Injected header plus, opens the launcher | `dataset.mwRoute = 'session-new'` |
| Session manager, bulk | `toggleSessionManager`, retained; Attention overflow "All sessions" | `toggleSessionManager(` |
| Restart all | `showMoreMenu`, retained | `label: 'Restart all sessions'` |
| Attention queue and count | Attention tab, badge on the tab | `data-mw-route="attention-queue"`, `#mobile-attention-badge` |
| Needs input, failed, finished, stale | Attention list groups | the `renderMobileAttention` group table |
| Held prompts | Declared group, no producer yet (15.4.3) | `{ state: 'held', label: 'Held' }` |
| File conflicts | Attention list, conditional Conflicts group | `data-conflict-row="true"` |
| Stop all | Attention header overflow, danger | `label: 'Stop all'` |
| Quick switcher | Search tab, default scope | `this.openQuickSwitcher()` |
| Command palette | Search, Commands chip | `scope === 'commands'` |
| Global transcript search | Search, Conversations chip | `this.openGlobalSearch()` |
| Help | Search, Help chip | `this.openQuickSwitcher('help')` |
| Agent tasks | Home > Workspace | `case 'tasks-board':` |
| Project notes | Home > Workspace | `case 'docs-notes':` |
| Costs | Home > Workspace | `case 'costs':` |
| System resources | Home > Workspace | `case 'resources':` |
| Paired devices | Home > Workspace, with the count | `case 'pair-device':` |
| Settings | Home > Workspace | `case 'settings':` |
| Appearance | Inside Settings on a phone; the dialog stays wired for desktop | `openAppearance` retained |
| Recent activity view | Home > Recent, and the Sessions default sort | `HOME_DESTINATION_MODES` includes `recent` |
| Account chip, usage meters | Header avatar, existing bottom sheet, unchanged | `id="account-chip"` |
| The full command list | Home > Workspace, "All commands" | `data-mw-route="more-menu"` on `#mobile-more-tab` |
| Pane switching | Chip strip, unchanged | `.terminal-tab` |
| Pane overflow | Pinned chip at the end of the strip | `data-mw-route="pane-overflow"` |
| Voice input | Input row microphone | `mobile-mic-btn` |
| Image attach | Input row image button | `mobile-image-btn` |
| Type and send | Permanent input row | `.terminal-mobile-input-row` always flex |
| Raw per-keystroke input | Pane overflow, Raw keys | `label: 'Raw keys'` |
| Reader, Select mode, Copy view | Pane overflow, Text group; toolbar keys retained | `label: 'Reader'`, `'Select mode'`, `'Copy view'` |
| Paste | Pane overflow, with the insecure-origin branch | `clipboardReadable` |
| Ctrl+D | Pane overflow, Keys group | `label: 'Send Ctrl+D'` |
| Send without Enter, Shift+Enter | Pane overflow, Keys group | `_sendMobileInput` |
| Scheduled messages | Pane overflow, with the count | `'Scheduled messages'` |
| Pinned notes | Pane overflow | `_showPinnedNotesModal(slot)` |
| Move to tab group | Pane overflow submenu | `label: 'Move to tab group'` |
| Fix terminal | Pane overflow, Troubleshoot | `label: 'Fix terminal (reset)'` |
| Restart session | Pane overflow, Troubleshoot, danger | `label: 'Restart session'` |
| Pane expand and collapse | Not applicable. One pane is always full height on a phone (A.3.3). | none, by design |

Three rows are deliberately NOT closed by P10 and are named here rather than
left to be discovered: the Sessions filter pill row and its bulk-select mode
(A.3.2), the priority-plus key toolbar (B.7), and the long-press zone model
(B.2). All three are P11 work packages.

### 15.3 The version, and what alpha.23 contains

P10 ships as **1.3.0-alpha.23**. The contract assigns alpha.21 to P10, which
the P4 remainder took (DV-22), and alpha.22 went to P5 while this work was in
flight. See DV-P10-6.

### 15.4 Ambiguities resolved during P10

#### 15.4.1 The More tab is dissolved, but `#mobile-more-tab` is not

Gate G1 diffs the element ids in `index.html` against `id-snapshot.txt` and
permits ADDITIONS ONLY, zero removals. `mobile-more-tab` is in that snapshot.
SE-8 simultaneously requires the `.mobile-tab` list to be exactly the five new
ids, and `showMoreMenu` is retained by SE-9 for the classic shell.

All three hold at once: the id moves onto the "All commands" row at the foot of
Home > Workspace. It is not a `.mobile-tab`, so the SE-8 filter does not see
it; it is still an id in the markup, so G1 is satisfied; and `showMoreMenu`
keeps a phone route, which code preservation wants anyway. The row is not the
canonical home of anything, because every item that sheet carried has its own
row above it or its own tab.

#### 15.4.2 Search is a destination whose field escalates

A.2 says Search is "a destination, not a modal". The Search tab is a real
screen: a field, five scope chips, and the recency rows as its empty state.
Typing escalates into the existing full-screen Quick Find overlay rather than
into a second search engine written for the phone.

The alternative was re-implementing `renderQuickSwitcherResults`, which is 200
lines of scoring across sessions, workspaces, a feature catalogue and settings,
plus its own result routing. Two engines answering the same question is how
they drift. On a phone the overlay covers the viewport, so the two read as one
surface. Recorded as DV-P10-2.

#### 15.4.3 The "Held" group has no producer

A.3.4 lists auto-trust held prompts as an Attention group. Reading the source:
`terminal.js` either auto-accepts a safe prompt when `_autoTrustEnabled` is on,
or flags it as needs-input when it is not. Nothing is ever HELD.

The group is declared in the grouping table keyed on a `held` state and is not
drawn while it is empty, so the moment a producer exists the rows appear with
no further work in the renderer. Building the producer is a behaviour change to
the auto-trust path, which is not P10's.

#### 15.4.4 The phone screens are view modes, not a second navigation system

`home`, `attention` and `search` are ordinary view modes driven by
`setViewMode`, hidden by the same `hidden` property idiom as every other panel.
The alternative, a parallel `_mobileTab` state, would have meant two things
deciding what is on screen and two places to keep in step.

The cost is that a wider layout can be asked for a mode whose panel is
`display: none`. That is guarded in `setViewMode` itself, which is the one
place all four paths (a rotation, a resize, a restored `cwm_viewMode`, a direct
call) pass through. Measured at 900px: before the guard the main column was
empty under a breadcrumb reading Home.

#### 15.4.5 The tab bar height needed a specificity qualifier, not `!important`

`focused-shell.css` authors the tab bar at 60px under
`:root[data-ui-shell="focused"] .mobile-tab-bar` and loads AFTER
`styles-mobile.css`, so an identical selector loses the tie. `!important` would
have made the height unoverridable by anything downstream, including P11 and
P12. One element qualifier, `nav.mobile-tab-bar`, settles it at 64px, which is
the mock's number and C.7's.

The same fight, with the same resolution, applies to `.account-chip`, whose
existing 44px rule is inside a `pointer: coarse` block. A narrow desktop window
gets the phone layout with a mouse attached and that block never fires, so the
floor is asserted at phone WIDTH instead.

#### 15.4.6 The sweep had to learn two things before it could be trusted

A naive 44px sweep is wrong twice. It under-reports, because the project idiom
for a small visual with a legal target is a transparent `::before`, so the
element's own rect is not its hit rect. And it over-reports, because a sticky
section header legitimately overlaps the rows beneath it and that is z-order
working, not a dead edge.

Both are handled: the hit rect is the union with the `::before` inset, DISCOUNTED
when an ancestor clips (which is exactly the chip strip's case, and is why the
tab-close button's `inset: -13px` has never done anything), and the adjacency
check skips pairs where either element is deliberately layered.

### 15.5 The numbers

| Counter | Before P10 | After P10 |
| --- | --- | --- |
| Suite files | 92 | 94 |
| Suite assertions | 1591 | 1648 |
| Gates passing | 18/18 | 18/18 |
| Gates short of a later target | 5 | 4 |
| G4 Catppuccin consumption | 747 (mobile 48) | 699 (mobile 0) |
| G5a hex literals | 5 (mobile 4) | 1 (mobile 0) |
| G5b rgba literals | 41 (mobile 3) | 38 (mobile 0) |
| G7 uppercase rules | 3 | 1, at target |
| G12a em dashes in the scanned trees | 146 | 118 |
| Touch targets under 44px at 390px | 16 to 19 per screen | 0 |
| Expanded hit rects intersecting | 7 | 0 |
| `100vh` in `styles-mobile.css` | 2 | 0 |
| Phone capabilities with no route | 6 | 0 |
| `styles-mobile.css` lines | 1315 | 2296 |

The suite figures are this track's own arithmetic. `npm test` reported 90 files
and 1543 assertions when P10 began and 94 files and 1648 when it finished; two
of the four new files and 75 of the assertions are the concurrent P5 track's,
which registered `terminal-surface.test.js` and `paste-input-preparation.test.js`
between the two runs. P10 contributed `mobile-ia-contract.test.js` (18) and
`mobile-viewport.test.js` (23), plus three retargeted assertions in the two
sanctioned mobile-test edits and the new assertions inside them.

### 15.6 The P10 screenshots, and an honest reading of them

Thirty shots, `screenshots/notion-restyle/p10/mobile/`: five tabs at 390x844,
768x1024 and 900x1200, in both chromes. Every one is dimension-checked before
it can be read.

**What is right.** Home draws the mock's composition, in order, and the two
lists carry the semantic BUILD-CONTRACT 2.13.6 asks for: bordered cards for
live things, borderless rows for history. The attention banner is the wash and
ink pairing, and its dot is a static RING. The active cards are a static green
DISC for running and a yellow RING for needs input, with the state repeated as
a word on the second line, so hue is never the only channel. The badge sits on
the Attention tab in wash and ink. The Terminal tab shows the chip strip, the
pinned overflow chip, the key toolbar and the permanent input row with its
image and microphone buttons, which is the mock's bottom stack exactly.

**What diverges from the mock, and why.**

1. The mock's active-card second line is an emoji, a project name and a live
   activity string. Ours is the project label and the attention word. There is
   no per-project emoji in this product's data model and no per-session
   activity string outside the pane header. Recorded as DV-P10-3.
2. Both mock dots animate. Ours do not, per DV-21 and gate G14.
3. The mock's badge is white on solid red. Ours is wash and ink, per D.4 row 1
   and DV-P10-1.
4. The key toolbar still scrolls horizontally and shows six keys plus part of a
   seventh at 390px. B.7's priority-plus layout is P11.4; this phase raised
   every key to 44px and removed two, which is as far as it goes without
   rebuilding a toolbar another work package owns.

**What is honestly not finished.** The Sessions tab is still the P4 phone
floor: the desktop session panel with its table collapsed to cards. A.3.2's
filter pills, the header overflow, bulk select and the row swipe actions are
not built. The screenshots show that plainly and it is the largest single item
P11 inherits.

**What the pictures cannot show.** Everything in G.4: momentum feel, native
selection handles, real keyboard geometry, IME and autocorrect, safe-area
insets (`env()` resolves to 0 in the emulator, so C.7's eight surfaces are
asserted structurally and are unverified visually), haptics, standalone PWA
chrome, and touch latency under live output. The G.5 seventeen-step device
script is the only thing that verifies those and it has not been run.

### 15.7 What P11 and P12 inherit

1. **A five-tab IA with zero orphans and a test that proves it.** Adding a
   capability means adding a manifest row and a marker; forgetting the marker
   turns the suite red on the commit that adds it.
2. **One owner of viewport geometry**, with every `MW_*` constant published on
   `window.MyrlinMobileViewport.constants`. P11's long-press, swipe and edge
   guards read their numbers from there rather than inventing a second set.
3. **A settle subscription.** `onSettle` is where P11.6's geometry-claim
   suppression belongs: it already fires exactly once per settle window.
4. **A pane overflow sheet with a tappable host.** P11.1 moves the pane action
   sheet off the pane container and onto a chip long-press; the sheet, its
   fifteen rows and its first host already exist.
5. **A measured 44px gate.** `--mobile` on the capture harness reports every
   target under the floor and every pair of intersecting expanded rects. It is
   at zero; any P11 control that lands under the floor shows up as a row.
6. **A tablet answer that is now safe either way.** `setViewMode` redirects a
   phone-only mode on a wider layout, so H.3 item 6's 900px breakpoint can be
   adopted or declined without a blank screen either way. The 768 and 900
   captures are the evidence for that decision.
7. **The mobile stylesheet at zero drift** on G4, G5a and G5b, and at target on
   G7. Anything P11 adds to it should keep it there.
8. **Three named gaps**: the Sessions tab surface (A.3.2), the priority-plus
   toolbar (B.7), and the long-press zone model (B.2).

## 16. Phase P7, the Unified Scrollback Surface

This section is P7's log. The phase is `TERMINAL-ARCHITECTURE.md` stages 3 and
4 shipped together, because stage 3 without stage 4 is a surface with nothing
in it for the pane the whole architecture exists for.

### 16.1 What shipped, and where

| WP | Files | What |
| --- | --- | --- |
| P7.1 | `terminal-history.js` (new), `terminal.js` | The layer DOM, open and close by scroll boundary in both directions, `Shift`+wheel, `Shift+PageUp`/`PageDown`, `Ctrl+Shift+Home`/`End`, `Escape`, printable-key dismissal, and the wheel escalation of 8.2 behind `settings.terminalWheelEscalation`. |
| P7.2 | `terminal-history.js` | Typography and geometry derived from the LIVE instance at open time: family and size read off `.xterm-screen`, row height MEASURED from a rendered row, letter spacing, the ground and ink from `terminalSurface()`, the horizontal padding measured from the live screen's offset, and the rect measured from `.terminal-container`. |
| P7.3 | `terminal-history.js`, `terminal.js` | The mirror freeze: a non-collapsed selection inside the layer pauses the live segment's `textContent` swap and nothing else. `_enqueueWrite` and `_flushWriteBuffer` gained one notification call each and no gate. |
| P7.4 | `styles.css`, `terminal-history.js` | The 6px overlay scrollbar at 40 percent `--app-border-secondary`, fading after 900ms, sized to the whole document, hidden when there is nothing above the current screen, with a 2px indeterminate shimmer while paging. |
| P7.5 | `server.js`, `terminal.js`, `terminal-history.js` | `GET /api/sessions/:id/history`, the transcript segment paged by `beforeOffset`, the deep segment paged by `beforeLine`, the source router re-evaluated on `onBufferChange` and on every mode frame, and the one-turn overlap seam. |
| P7.6 | `terminal.js` | `Ctrl+Shift+A` upgraded to the whole document, the Select-mode strip demoted to the first plain drag under mouse tracking, and every v1/v2/v3 identifier preserved verbatim. |

New files: `src/web/public/terminal-history.js` (2096 lines),
`test/terminal-history.test.js` (46 assertions),
`test/browser/terminal-history-e2e.test.js` (14 checks),
`test/browser/fake-agent-cli.js` (the alternate-screen fixture).

### 16.2 Ambiguities resolved during P7

#### 16.2.1 The live segment is not "the screen", it is "everything since the layer opened"

7.4's table says the `screen` segment is "the current visible screen, refreshed
on a rAF throttle". Taken literally on a NORMAL-buffer pane that is wrong in a
way that only shows up while the user is reading: output arriving while the
layer is open pushes lines out of the viewport into the client ring, so a
literal `screen` segment would silently lose them, and re-reading the ring on
every refresh would grow the document ABOVE the reader and yank the viewport on
every frame.

The segment is therefore anchored: at open, `buffer.baseY` is captured, and the
live segment is everything from that row to the end of the buffer. New output
extends the BOTTOM of the document, so nothing above the reader ever moves, and
nothing is lost. On the alternate buffer the anchor is 0 and the segment is the
frame, which is the literal reading, because there the two are the same thing.

The segment is bounded at `HISTORY_LIVE_SEGMENT_MAX_LINES` (4000) and rebalances
its overflow into the segment above it. That move is invisible by construction:
the same lines in the same order, in a different text node.

One bound is worth stating because it is reachable rather than theoretical: if
xterm trims its 10000-line ring while the layer is open, every index shifts and
the anchor no longer means what it meant. That is detected (the buffer length
falls) and the anchor is reset, which costs one visible discontinuity after
10000 lines of output during a single reading session.

#### 16.2.2 The deep segment's alignment is an assumption, and it is the honest one

The client's ring and the server's line log are two records of the same byte
stream, and nothing links them: the log has absolute indices, the ring has none.
The first deep page therefore probes for `total` and pages backwards from
`total - <lines the client already holds>`, which is `deepStartCursor`.

That is an assumption, and it can be wrong by a bounded amount when the client
was reset by a resync or the server reflowed. It fails toward a VISIBLE
DUPLICATE at the seam and never toward a deletion, which is the same trade 7.4
makes for the transcript seam and the same one `vt-sidecar.js` makes for its own
resize seams. The dedupe that trims it is bounded by the sidecar's OWN reflow
counter, published by the new route: at zero reflows the window is zero, so a
monotonic log is never deduped at all and a genuinely repeated prompt or build
warning cannot be eaten.

#### 16.2.3 The transcript is a snapshot, and "live-appending" means the live segment

The brief asks for a live-appending transcript segment. Section 12's robustness
matrix rules the other way for a reason that outranks it: the mirror service
allows ten concurrent watchers, and a pane the user is merely READING must not
consume one. So the transcript is snapshotted on open and paged backwards on
demand, exactly as the Copy view's own snapshot does, and what stays live is the
LIVE segment, which is the only part of the document that can change while the
user is looking at it.

The consequence is precise and small: a turn that completes while the surface is
open appears in the live segment (it is on screen) and not in the transcript
segment until the surface is next opened. Nothing is missing and nothing is
stale; the newest turn is simply on the live side of the seam, which is where
the overlap ruling already puts it.

#### 16.2.4 Ctrl+C over a history selection needed its own branch, and its spelling is load bearing

Plain `Ctrl+C` deliberately does nothing but `return false`, leaving the copy to
Chromium's trusted `copy` event, which xterm answers on the terminal element
with ITS OWN selection. There is one reachable case where that is wrong:
`Ctrl+Shift+A` selects the history document while keyboard focus is still on the
terminal, so the trusted copy would answer with an empty xterm selection and the
user would get nothing.

The new branch sits ABOVE the plain one and is spelled
`if (this._historyOwnsSelection() && mod && !e.shiftKey && shortcutKey === 'c')`.
Both facts are load bearing: three suites locate the plain branch by an
`indexOf` of its exact if-header text, so a branch beginning with those same
characters would be extracted as part of it. **The first draft of this phase put
that header literal in a COMMENT above the branch and broke all three suites;
the P7 suite caught it before it left the working tree.** The comment now
describes the anchor without quoting it.

#### 16.2.5 ConPTY consumes the mouse-tracking DECSETs, which changes which routing case a Windows pane is in

Measured while building the browser fixture, and it was not predicted by section
2. Under ConPTY on this machine, conhost CONSUMES DECSET 1000, 1002, 1003 and
1006 and does not forward them to the terminal, with or without raw mode on the
child and with or without win32 input mode. It forwards 1049, 2004, 1004 and
9001 unchanged.

So a child that enters the alternate buffer and asks for the mouse can arrive at
the client as an alternate-buffer pane with `mouseTrackingMode === 'none'`. That
is 8.1's THIRD row rather than its fourth, and the routing degrades in the right
direction: plain wheel up opens the surface immediately, which is correct,
because xterm will not be forwarding the wheel to an application that never
asked for mouse reports.

Two consequences worth recording. The client-side fallback and the P6 mode frame
AGREE here rather than disagreeing, because the sidecar parses the same bytes
the client does, so nothing is inconsistent. And section 2.2's measurement of
real sessions did observe the mouse sequences in the byte ring, so the real CLI
reaches the client differently from this fixture; the difference is not
understood and is recorded rather than guessed at. Nothing in P7 depends on the
answer, because the routing is by buffer mode and the wheel decision has a
guaranteed Shift path underneath it.

#### 16.2.6 The metrics gate compares against the rendered ROW, not against `.xterm-screen`

P7.2's done criterion is that the layer's computed `font-size`, `line-height`
and `background-color` EQUAL the live `.xterm-screen` values. Two of those three
are read literally. The third cannot be: xterm's own CSS sets `line-height:
normal` on the screen element and puts the real metric on the rendered row
divs, and `.xterm-screen` paints no background at all (the ground belongs to
`.terminal-container`, which is what P5.5 made paint `--term-bg`).

So the executed gate compares font size and family against `.xterm-screen`, the
line height against the measured height of a rendered row, and the ground
against `.terminal-container`. Measured in the browser proof: identical family,
identical size, row height within 0.5px, identical ground, and a layer rect
within 0.5px of the container rect on both axes.

### 16.3 Scope decisions, and what was deliberately left alone

1. **`app.js` was not touched at all.** The surface is reachable from the pane
   (`openHistory`, `closeHistory`, `toggleHistory`, `isHistoryOpen`,
   `selectAllHistory`) and announces itself on the EXISTING
   `cwm:select-chrome` event with a new `historyOpen` field, so the app shell's
   single delegated listener picks it up with no new wiring. The mobile track
   was editing `app.js` throughout this phase.
2. **The Copy view is untouched and still reachable.** It remains the explicit
   "terminal bytes" fallback and the phone-friendly full-screen reader, exactly
   as 13.2 asks. Its `_loadTranscriptSnapshot`, `_loadEarlierTranscript` and
   `_renderTranscriptIntoOverlay` are byte-identical; the surface reuses
   `_copyViewIdentity`, `_copyViewApi` and `_copyViewDeviceId` instead.
3. **Select mode v1, v2 and v3 are preserved verbatim.** Not one identifier was
   renamed, moved or reformatted; the suite asserts a list of 45 of them. The
   only behavioural change is WHEN the strip is shown, gated at the call site
   (`DEVIATIONS` DV-31).
4. **No closed-state affordance.** `DEVIATIONS` DV-30.
5. **Touch is not preclued but not polished.** The layer scrolls natively with
   `-webkit-overflow-scrolling: touch` and `overscroll-behavior: contain`, the
   mobile touch engine gained the same exemption the Copy view has, and the
   chrome event carries the state the phone toolbar needs. The momentum
   carry-through, the selection handles and the toolbar mirror are P11's.
6. **The sidecar stays off by default.** The deep segment is empty without
   `CWM_VT_SIDECAR=1`, and everything else works exactly the same, which is
   what "nothing may hard-depend on the mode frame" requires.

### 16.4 The numbers

| Measure | After P5 | After P7 |
| --- | --- | --- |
| `terminal.js` lines | 5928 | **6510** |
| `terminal-history.js` lines | did not exist | **2096** |
| `styles.css` lines | 15877 | **16012** |
| `server.js` lines | 9388 | **9513** |
| Gate G4, Catppuccin `var()` in chrome | 747 | **699** (unchanged by P7; the new rules use `--app-*` fallbacks) |
| Gate G14, animated status marks | 0 | **0** |
| Test files / assertions | 94 / 1642 | **95 / 1693** |
| Gates | 18/18 | **18/18** |

P7's own assertion delta is **+46**, all in the new
`test/terminal-history.test.js`, plus 14 browser checks in
`test/browser/terminal-history-e2e.test.js` and three new region screenshots.
One test file was edited (`test/phantom-tokens.test.js`, one allow-list row for
`--term-dim`, which P5.4's own comment reserved for "the phase that first writes
`var(--term-dim)` into a stylesheet").

### 16.5 The p7 screenshots, and an honest reading of them

`screenshots/notion-restyle/p7/`, the frozen eight plus sixteen region shots,
three of which are new and all three spawn a REAL PTY running an
alternate-screen child with a REAL transcript on the sandbox disk.

**What the pictures show.** `desktop-dark-history` and `desktop-light-history`
are the surface mid-scroll at the seam: conversation above, a hairline, the
frame the CLI is painting below, in one document, on one ground, in the
terminal's own face and rhythm. `desktop-*-history-selection` is the money
shot: one selection highlight that starts inside "Turn 14 reply" and runs down
across the hairline into `LIVE-SCREEN-ROW-1` through `-6`. There is no seam in
the highlight because there is no boundary in the document.

**Measured rather than eyeballed**, which matters because a viewer can lie about
this file: `desktop-light-history` samples `#eff1f5` in the pane body, which is
Latte's ground and the same value the live terminal paints in
`desktop-light-terminal`. `desktop-light-history-mocha-on-light` samples
`#1e1e2e` in the pane body against a `#f1f0ef` sidebar, which is the two-axis
proof holding on the history surface as well as on the terminal.

**What is inherited rather than new.** In the mocha-on-light shot the pane
HEADER samples `#2a253b`, a dark band under light chrome. The identical value
appears in P5's own `desktop-light-terminal-mocha-on-light`, so it is the
provider tint following the terminal palette rather than the chrome, and it is
P12's to reconcile.

**What the pictures do not show.** The quiet scrollbar has faded in two of the
three history shots, because it fades after 900ms and the harness settles for
longer than that before it captures. It is visible in
`desktop-light-history-mocha-on-light`. That is the affordance behaving as
specified rather than a capture defect, and it is the same thing P5 recorded
about xterm's own scrollbar.

### 16.6 What P11 and P12 inherit

1. **A surface that is already a text zone.** `.terminal-history` scrolls
   natively, contains its overscroll, and is exempt from the pane's touch
   engine. P11 owns momentum through the boundary, the platform selection
   handles and pull-to-refresh suppression at the top.
2. **`historyOpen` on `cwm:select-chrome`.** The phone chrome can mirror the
   third state with no new event and no per-pane hook.
3. **A shipped wheel-escalation heuristic** with an off switch and VG-6 still
   open (`DEVIATIONS` DV-29).
4. **A closed-state affordance decision** (`DEVIATIONS` DV-30).
5. **`GET /api/sessions/:id/history`**, bounded, authenticated, never throwing,
   publishing `reflows`, `lostLines` and the mode alongside the page.
6. **A fixture that reproduces an agent CLI's terminal behaviour**
   (`test/browser/fake-agent-cli.js`) and a sandbox recipe that seeds a real
   transcript, so any later phase can test against an alternate-screen pane
   without credentials or a network.
7. **One measured Windows finding** that changes which routing case a pane is
   in (16.2.5).

---

## 17. Phase P11, mobile interaction and touch

This section is P11's log. It covers MOBILE-EXPERIENCE section B in full, the
Sessions surface A.3.2 asks for (which 15.6 named as the largest single item
P11 inherited), and the three `app.js` items P5 and P10 left behind.

### 17.1 What P11 shipped, and where

| WP | Files | What |
| --- | --- | --- |
| P11.1 | `app.js`, `index.html`, `styles-mobile.css` | The three-zone allowlist, the shared delegated binder, one timing constant at every site, the pane container demoted to chrome on a phone, the chip long-press host, the tab-bar quick actions, the Ctrl+A to Ctrl+Z modifier sheet, and the Send and image long-press sheets. |
| P11.2 | `app.js`, `styles-mobile.css` | The toast contract: `.toast-notice`, the `:has()` companion, the three durations, the two-toast phone cap, and an optional action button. |
| P11.3 | verified only | Both FABs already compute to `display: none` at phone widths: P10 shipped the schedule rule under DV-P10-4, and the upload FAB has been suppressed in `styles.css` since before the restyle. Asserted rather than re-shipped. |
| P11.4 | `app.js`, `styles-mobile.css` | The priority-plus toolbar: a measured fit, a pinned sticky overflow with an unseen dot, no horizontal scrolling, and a Keys group in the sheet that clicks the real buttons. |
| P11.5 | `app.js` | `data-mw-dnd`, `draggable="false"` on phone rows, the guarded pane swipe (96px travel, both edges excluded, inert on a selection), and the retired edge-swipe drawer. |
| P11.6 | `app.js`, `styles-mobile.css` | The claim gate, the settle-window suppression, the per-session Follow this device switch, and the shared-width notice. |
| A.3.2 | `app.js`, `styles-mobile.css` | The Sessions tab surface: filter pills with counts, the header overflow, bulk select with its action bar, and the row swipe actions. |
| Inherited | `app.js`, `styles-mobile.css` | DV-26 (the desktop pane composer, turned on and made typeable) and DV-27 (the splitter arithmetic, made padding-correct). |
| SE-16 | `test/browser/workbook-shell.test.js` | The obsolete `#mobile-more-tab` bottom-tab block rewritten to the five-tab IA, and the two stale 58px header assertions retargeted to the 44px truth. |

New file: `test/mobile-touch-model.test.js`, 58 assertions, three of them
executed algorithms rather than source greps.

### 17.2 The zone model, as built

B.2 specifies an allowlist keyed on `data-mw-zone`. What shipped is that, plus
one addition the specification does not name and one subtraction it does.

**The addition: a structural allowlist for surfaces this track does not
author.** `.xterm-screen`, `.terminal-copyview`, `.terminal-reader-content`
and the scrollback-history surface are created by xterm, by `terminal.js` and
by `terminal-history.js`. Putting an attribute on them means editing another
track's file, which BUILD-CONTRACT 4.1 item 4 forbids while that track is
live. `CWMApp.MW_TEXT_ZONE_SELECTOR` names them instead. It is the same
allowlist with a different spelling: a surface has to be NAMED to be a text
zone, and anything unnamed falls through to `chrome`, where nothing happens.
`.terminal-history` is in that list before P7's surface reached the phone,
which is B.4 rule 3 satisfied in advance rather than in arrears.

**The subtraction: the four legacy long-press sites keep their own timers.**
B.2 asks for "one delegated listener per list container". Four already exist
(the workspace list, the session list, the projects list and the tab-group
strip) and `test/mobile-ux-fixes.test.js` P1-2(b) and P1-3 pin them down to
their timer VARIABLE NAMES and their `dragstart` handlers. Moving them onto
the shared binder would have meant editing four pinned assertions this phase
was not sanctioned to touch, and TEST-CONSTRAINTS is explicit that a pin is
never edited to suit an implementation. They take what actually decides how
the gesture feels instead: the one duration, the 8px slop and the haptic. The
shared binder owns the five NEW hosts.

**Resolution order.** `_mwZoneOf` returns the NEAREST declaration, which is
the case that makes the model work for composed surfaces: a notes field inside
a session peek card is a text zone inside an affordance, and the field is the
closer ancestor, so a long press there selects a word rather than opening a
sheet. Executed in `test/mobile-touch-model.test.js`.

**The failure mode is inverted, which is the whole point.** A denylist that
forgets a surface silently steals a selection and offers a destructive action
in its place. An allowlist that forgets a surface produces no menu. One is
discoverable and harmless; the other is what was reported.

### 17.3 The toolbar arithmetic, measured rather than worked

B.7 works an example and concludes "five to six keys on a 390px phone". The
capture harness now measures the real algorithm against the real boxes, in
both chromes:

| Width | Fitted | Overflowed | Strip scrolls |
| --- | --- | --- | --- |
| 390px | **5** | 6 | **no** |

The budget at 390px is 390, minus 16px of padding, minus the 44px pinned
overflow, minus one 4px gap: 326px. The five that fit are Enter, Ctrl+C, Esc,
Up and Down. B.7's own worked example predicted five or six and named Copy and
Tab as the first to go; the measurement agrees, with the caveat that the
algorithm measures drawn widths rather than assuming the example's, so the
answer moves with the font and the theme rather than being frozen at authoring
time.

The six that overflow are Tab, Copy, Ctrl+D, Select mode, Copy view and
Reader. Four of those six already have a row in the pane sheet below, so the
Keys group lists only Tab and Copy (17.4.1).

This is a documented departure from DESIGN-SPEC 14.3, which draws seven. Seven
requires 40px keys and the touch floor is 44. The floor wins, per PROCEDURE
section 4. Recorded as DV-P11-2.

### 17.4 Ambiguities resolved during P11

#### 17.4.1 The toolbar overflow and the pane overflow are ONE sheet

B.7 sends overflowed keys to "the overflow sheet" and A.3.3 sends fifteen pane
capabilities to "the pane overflow sheet". Two sheets reachable from two
controls eight pixels apart is a puzzle, not an affordance, so the keys are a
group at the top of the sheet that already exists.

The first p11 capture then showed what that decision costs if it is taken
naively: "Reader" appeared under Keys and again under Text, eight rows apart,
along with Select mode, Copy view and Ctrl+D. The Keys group now lists only
the overflowed keys that have no other row in the same sheet.

#### 17.4.2 A phone row tap opens the session; the peek moves to the sheet

A.3.2 makes the row tap "open in the current pane and switch to Terminal", and
B.8 removes the drag that used to be the alternative. The desktop's tap
behaviour (select, which opens the detail peek) is retained above the
breakpoint and stays reachable on a phone from the row's long-press sheet,
"View Details". `selectSession` is deliberately NOT called on the phone path:
it opens the peek, which `setViewMode('terminal')` would close in the same
frame, so the user would see it flash.

#### 17.4.3 The row swipe uses one shared action layer, not per-row markup

`styles-mobile.css` has carried `.session-item-wrapper` and `.swipe-action`
rules since long before this phase, and nothing has ever built that markup. It
could not be built as those rules assume: they want a wrapper element around
the row, and since P4 the row is a `<tr>`, which cannot legally be wrapped in
a div. `renderSessions` also rewrites the whole table on every SSE tick, so
per-row buttons would be rebuilt several times a minute and the open row's
state would go with them.

One absolutely positioned layer inside the list, moved to the row being
swiped, has neither problem: the list is the positioned ancestor, so the layer
scrolls with the rows for free, and only one row can be open at a time anyway.
The pre-existing rules are RETAINED untouched.

#### 17.4.4 "Stop all" was wired to restart everything

A.3.4 gives the Attention overflow exactly one item, "Stop all", in the danger
group. P10 wired it to `restartAllSessions`. A user asking a queue of stuck
sessions to stop would have restarted every session in the workbook instead.
The row now calls a new `stopAllSessions`, which confirms once and stops
sequentially; `restartAllSessions` keeps its own truthfully labelled routes in
`showMoreMenu` and in the new Sessions header overflow.

#### 17.4.5 The claim gate is published, not injected

B.9 rules 1 to 3 belong inside `_requestActivate`, which lives in
`terminal.js`. That file is P7's this phase. The gate is therefore a published
predicate, `window.MyrlinClaimGate.canClaim`, consulted by the app-layer claim
paths, and the one-line read inside `_requestActivate` is named in this
phase's report as post-P7 mop-up.

What is already effective without that line: the ambient visibility and focus
claim path is gated on all four conditions, the focus-on-click claim respects
Follow this device, and the suppression window opens on the FIRST frame of a
viewport change rather than on the settle. The driver publishes a trailing
edge subscription, which is right for expensive work and wrong for a guard:
by the time it fires, the claim that caused the jank has already gone out.

#### 17.4.6 The desktop composer needed one focus fix to be typeable

DV-26 is closed by a display rule and a box, but the row would still have been
unusable. The pane's capture-phase `mousedown` listener calls
`setActiveTerminalPane`, which ends in `tp.focus()` on xterm's hidden
textarea, so a click on the composer would have activated the pane and handed
focus straight past the field: the caret would appear and vanish on every
click. `_focusTerminalPaneFromPointer` now treats the composer the way the
zone model treats any text zone, and the pane is still made active when it was
not.

#### 17.4.7 The comment stripper in the new test runs line comments FIRST

`app.js` contains a line comment reading "(MIME /* types to avoid
conflicts)". A block-comment pass that runs first treats that `/*` as the
start of a comment and silently swallows the next twenty thousand characters
of real code, up to the next `*/`. Anything asserted inside that region then
passes or fails for the wrong reason, which is exactly what happened to the
first draft of `mobile-touch-model.test.js`. The order is reversed there, and
the `[^:]` guard is what keeps `https://` inside a string safe from the line
pass. The sibling harnesses in `mobile-viewport.test.js` still strip blocks
first; their assertions happen to fall outside the swallowed region, which is
luck rather than design, and is flagged here for whoever touches them next.

### 17.5 The numbers

| Counter | Before P11 | After P11 |
| --- | --- | --- |
| Suite files | 95 | 96 (measured 97) |
| Suite assertions | 1694 | 1752 (measured 1769) |
| Suite failures | 0 | 0 |
| Gates passing | 18/18 | 18/18 |
| Touch targets under 44px at 390px | 0 | 0 |
| Expanded hit rects intersecting | 0 | 0 |
| Toolbar keys past the fold with no affordance | 6 | 0 |
| Horizontally scrolling key strips at 390px | 1 | 0 |
| Distinct long-press durations in `app.js` | 3 (400, 500, 600) | 1 (400) |
| Controls a visible toast can swallow | 16 probed | 0 |
| A.3.2 capabilities with no phone route | 4 | 0 |
| `styles-mobile.css` lines | 2382 | 2873 |

The before column is measured at commit `36208bd`, which is P7's release. The
measured column is this track's own arithmetic against the branch: `npm test`
reports 97 files and 1769 assertions because a concurrent Codex-track commit
registered `claude-discover-budget.test.js` (17 assertions) between the two
runs. P11 contributed one file and 58 assertions and retargeted five
assertions in the browser lane under SE-16, none of them in `npm test`.

**Two red runs during this phase belonged to other tracks, and both are worth
recording because the next phase will see the same shape.** A run mid-phase
reported five failures in `copy-secure-context-fallback.test.js`: P7's
in-flight `terminal.js` had introduced an earlier occurrence of the string
that test anchors its Ctrl+C extraction on, so the harness sliced the wrong
branch. They were green again at P7's commit. A run at the end reported one
failure in `credential-routes.test.js`, which pins `arthurs-mac-mini` as the
default Mac host while an untracked `src/web/mac-host.js` in another agent's
working tree changes that default to `alloy`. Neither is P11's, and neither
touches a file P11 owns. A third failure, `find-jsonl-refactor.test.js`,
appeared once and passed on every re-run: it writes a fixture into the REAL
`~/.claude/projects` and searches it, which is the non-hermetic corpus scan
that project memory already has open.

### 17.6 The p11 screenshots, and an honest reading of them

Forty-two shots in `screenshots/notion-restyle/p11/`: the four frozen
comparison shots, the thirty-shot P10 mobile matrix at three widths in both
chromes, and eight this phase added (a toolbar overflow, a long-press state
and a DV-26 desktop composer, in each chrome, plus the two phone standards).
Every one is dimension-checked before it can be read, and every one was
looked at.

**What the measurements say.** The 44px sweep returns zero rows and zero
intersections on every phone route in both chromes; the one row it did report
mid-phase was this phase's own filter pill at 39.5 x 44, and it was fixed
rather than excused. The long-press probe synthesises a real 450ms hold and
reports affordance to a sheet, text to no sheet, chrome to no sheet, which is
BUILD-CONTRACT's P11.1 done criterion verbatim. The toast probe puts sixteen
controls under a visible toast and swallows none of them, which is P11.2's.
The toolbar reports five fitted, six overflowed and no horizontal scrolling,
which is P11.4's.

**What the pictures show.** The Sessions tab now opens on a pill row with live
counts, a header overflow beside Discover and New, and the P4 cards below it.
The Terminal tab shows five keys and a pinned overflow carrying its unseen
dot, with the permanent input row under it and nothing scrolling sideways. The
long-press shot is the session context sheet over a dimmed list, reached by a
hold rather than by a method call. The DV-26 shot is a desktop pane with a
prompt, a field, an image button, a microphone and Send, on the terminal
ground, 45px tall.

**What is honestly not right yet, and is not this phase's.** The session
context sheet still draws platform emoji as its row icons, which P12.4's art
direction bans. The Sessions panel title is drawn at the desktop's size and
eats a third of the first phone screen. The tablet widths still get the phone
IA with no tab bar, which is H.3 item 6's open question and deliberately still
open.

**What the pictures cannot show.** Everything in G.4, unchanged from 15.6:
momentum feel, native selection handles, real keyboard geometry, IME and
autocorrect, safe-area insets, haptics, standalone PWA chrome, and touch
latency under live output. The synthesised hold proves the ROUTING of a long
press, not how one feels under a real finger. The G.5 seventeen-step device
script remains the only thing that verifies those, and it has still not been
run.

### 17.7 What P12 inherits

1. **A zone model with an inverted failure mode**, and a resolver with
   executed proofs. Classifying a new surface is one attribute; forgetting to
   classify one is a missing menu rather than a stolen selection.
2. **A measured toolbar.** Adding a key means adding it to
   `MW_TOOLBAR_PRIORITY`; the fit re-measures itself and the overflow sheet
   picks it up with no second edit.
3. **A toast that is a notice unless it is a control**, with an action API
   that nothing yet uses. P12.3's service-worker update toast is its first
   real consumer, and B.5 rule 3 already says it must be the indefinite kind
   that never reloads under the user's fingers.
4. **A published claim gate**, waiting on one line inside `terminal.js`
   `_requestActivate` once P7's track releases the file.
5. **The Sessions surface closed against A.3.2**, so the phone IA has no named
   gaps left from section A.
6. **Three items that need a real device**, not an emulator: P11.7's touch
   polish, P11.8's performance budget, and the G.5 script. All three are named
   in this phase's report as explicitly unshipped rather than quietly skipped.

---

## 18. Phase P11b, the post-P7 touch and performance mop-up

This section is P11b's log. It is the list 17.7 item 4 and 17.4.5 left behind,
plus BUILD-CONTRACT P11.7 and P11.8, plus MOBILE-EXPERIENCE B.4 in full.

### 18.1 What P11b shipped, and where

| Item | Files | What |
| --- | --- | --- |
| DV-P11-3's line | `terminal.js` | The claim gate read inside `_requestActivate`, above the freeze branch, typeof-guarded and try-wrapped. |
| P11.7 | `terminal.js`, `terminal-history.js`, `styles.css` | The touch boundary in both directions with its momentum carry-through, the two jump pills, native selection and pull-to-refresh suppression as stylesheet contract, reduced motion asked of the platform. |
| B.4 | `terminal-history.js`, `styles.css` | Rules 1 to 4, with rule 2 read as DV-P11b-1 records. |
| P11.8 | `terminal.js`, `terminal-history.js`, `app.js` | The 2000-line phone ring, the two-pane phone budget, the three flush cadences, the 200k tail-biased Reader cap, and the windowed renderer. |
| Item 5 | `terminal.js` | The long press reads its three numbers from `MyrlinMobileViewport.constants`. |

New file: `test/terminal-touch-window.test.js`, 39 assertions, 24 of them
executed against fakes rather than source greps.

### 18.2 Ambiguities resolved during P11b

#### 18.2.1 The crossing gesture cannot be native, and the specification's own reason says why

B.4 rule 2 argues for native scrolling from compositor-thread performance, and
it is right about the surface. It does not address the crossing, because when
it was written the surface did not open on touch at all.

A touch sequence belongs to the element hit at `touchstart` for its whole life.
When the boundary is crossed mid-gesture the layer appears UNDER a finger that
is already down, and no API hands the in-flight sequence to it. So the engine
keeps applying that one gesture, to `doc.scrollTop`, until the finger lifts and
the tail decays. Recorded as DV-P11b-1. The scope is exactly one gesture: every
gesture that starts inside the surface is native, and the surface's own three
touch listeners are passive and never write `scrollTop`, which the suite pins.

The finger path and the momentum path go through ONE router. A boundary that
only the slow gesture can cross is worse than no boundary, because it teaches
the user that flicking is broken.

#### 18.2.2 Ctrl+Shift+Home had no touch route at all, and B.4 does not mention it

B.4 rule 4 names a "Jump to live" pill, which is Ctrl+Shift+End. 8.4 gives the
surface Ctrl+Shift+Home as well, and a phone has neither key. Shipping only the
named pill would have left one of the two capabilities simply absent on touch.

Both ship, as one group inside the layer, with different visibility rules
because they answer different questions: "Jump to live" follows B.4 rule 4
literally (more than one viewport above the bottom), while "Oldest" appears
whenever anything is above the viewport, INCLUDING at the bottom, which is
where the reader is when the surface opens and the only position from which
"go to the oldest" is useful at all.

They are not the floating buttons B.6 bans. B.6's rule is about controls that
land on the key toolbar and the input row; this group is inside a layer whose
rect is measured from `.terminal-container` and therefore stops above both. It
also clears every other test B.6 applies: 44px measured rather than 32, visible
at rest rather than on a hover a phone never delivers, and present only when it
has somewhere to go.

#### 18.2.3 E.3's window was specified against a renderer this surface never had

E.3 asks for "200 rows in DOM, recycled". P7 renders each segment as one `<pre>`
holding one text node, so a 50000-line document was already four ELEMENTS, and a
literal reading would have meant ADDING 200 elements where there was one. The
real cost is the other half of the same problem: one text node of several
megabytes in a box hundreds of thousands of pixels tall. Recorded as DV-P11b-2.

The invariant that makes windowing safe on a surface whose entire promise is
"the reader's position never moves": a chunk is only ever collapsed AFTER it has
been rendered and MEASURED, and is pinned to that measured height. The document
is `pre-wrap`, so `lines x rowHeight` is a guess, and a windowed list that
guesses heights moves the reader. A chunk that cannot be measured stays
hydrated forever, which costs memory and moves nobody. Chunk boundaries are cut
from the END of each segment, because the archive grows at the top, so a
prepended page reuses every existing chunk byte for byte.

Three things sit outside the window deliberately. The live segment, because it
is the mirror and is already bounded at 4000 lines. A held selection, which
freezes collapsing exactly as it freezes the mirror, while still permitting
hydration, because a drag that auto-scrolls into a collapsed region has to find
text there or it selects a blank band. And select-all, which hydrates the whole
document and HOLDS it: a Range cannot select text that is not in the DOM, and
copying a few visible screens while looking like it copied 50000 lines is the
silent-wrong-answer class of failure this surface exists to remove.

#### 18.2.4 Dormancy is a READ of the host-ownership model, never a writer to it

E.3's dormancy wants the socket closed, the buffer released and a "tap to
reconnect" chip. All three live in `app.js`, and the detach itself is the app
layer's: `detachHostBindings()` is called BY the code that owns which panes are
hosted, and `terminal-host-ownership.test.js` exists precisely to pin that
coherence. A pane that detached itself would leave `app.js` believing it was
mounted, and the wake path would become a second owner of the same state.

So dormancy is a predicate rather than an action. A pane is dormant when
`_getOwnedContainer()` returns null, which is exactly what a cached tab group
leaves behind and is the host-ownership model's own definition of detached, or
when it is past the two-pane phone budget. What dormancy changes is a cadence,
not a socket: output is still consumed, nothing is dropped, the queue cannot
grow without bound, and a swipe back shows real output rather than a reconnect.
The suite asserts that `_isDormantPane` reads `_getOwnedContainer` and never
calls `detachHostBindings`.

#### 18.2.5 The reduced-motion proxy had two holes, and one of them was silent

P7's `_animateIn` inferred reduced motion from
`TerminalPane.getSmoothScrollDuration() === 0`. That is also 0 when the user
merely turned smooth scrolling off, so an accessibility behaviour was being
driven by an unrelated preference; and it answers nothing at all when the layer
is loaded without `window.TerminalPane`, so a page in that state animated
regardless of what the platform asked for. The query is now asked of
`matchMedia` directly, with the proxy KEPT as a second condition rather than
replaced, because a user who turned smooth scrolling off has expressed the same
preference in the same region. `close()` strips its inline transition, so there
is no exit animation to skip on any path.

#### 18.2.6 A harness that binds `window` as a parameter cannot be reached by `global.window`

`terminal.js` is compiled with `new Function('window', 'document', ...)`, so
those names are PARAMETERS and shadow the real globals for the whole file. The
first draft of `terminal-touch-window.test.js` set `global.window` and three
checks passed while asserting nothing at all. The sandbox now returns its own
`win` and `doc` and the tests mutate those. Flagged here because the same
harness shape is used by four other suites and the trap is invisible: a test
that reaches nothing passes.

The sibling finding, from the browser pass: the first draft of the capture
harness booted a second layer without destroying the first, so every
`querySelector` read the stale, closed surface and the pass reported three
product failures that were entirely its own. Both are the same lesson, which is
that a measurement harness needs its own teardown as much as the code does.

### 18.3 The numbers

| Counter | Before P11b | After P11b |
| --- | --- | --- |
| Suite files | 97 | 99 |
| Suite assertions | 1792 | 1854 |
| Suite failures | 0 | 0 |
| Gates passing | 18/18 | 18/18 |
| Pinned terminal suites edited | 0 | **0**, verified by blob hash |
| `terminal.js` lines | 6510 | 7025 |
| `terminal-history.js` lines | 2096 | 2843 |
| `styles.css` lines | 16012 | 16103 |
| DOM characters, 50000-line history | roughly 3,400,000 | **14,599** |
| Chunk elements, same document | not applicable | 250, of which 1 hydrated |

The before column is measured at commit `412fdff`, which is P11's release. Two
notes on the arithmetic. First, 17.5 reports 1769 for that same commit; the
counter used here reads 1792 on it, because 17.5's counter missed
`mobile-viewport.test.js`'s 23 markers. The DELTA is what is comparable, and
this track's delta is +1 file and +39 assertions. Second, the run after this
phase also picked up `credential-protections-gate.test.js` (+1 file, +23
assertions), which belongs to the concurrent backend track and not to this one.

### 18.4 The p11b capture, and an honest reading of it

Two shots in `screenshots/notion-restyle/p11b/`, plus an 18-observation touch
pass in a real Chromium at 390x844 with touch emulation on.

**What was measured rather than eyeballed**, which is the point of this
particular capture: on a real 50000-line document the surface builds 250 chunk
elements and holds 14599 characters in the DOM against roughly 3.4 million
unwindowed, while the document's scroll extent stays at its full 1600012px and
`scrollTop` is bit-identical across a collapse. The pills measure 94x44 and
64x44. A real touch tap on "Jump to live" closes the surface and pins the
terminal back to live. A pull past the bottom exits; the same gesture
mid-document does not. The computed styles are `touch-action: pan-y`,
`user-select: text` and `overscroll-behavior-y: contain`.

**What the pictures show.** The surface at 390px mid-document, with both pills
in the lower right, over the history text.

**One artefact worth naming so nobody reads it as a defect.** The harness page
does not load `theme-registry.js` and does not set `data-theme` on the root, so
`--term-bg` is undefined and both the surface and the pills fall back to
`--app-bg-primary`, which is the light default. The picture is therefore white
where a real pane would be Mocha. That the pills take the SAME ground as the
surface is the contract, and that is what the picture shows; the value of that
ground is the harness's, not the product's.

**What emulation cannot prove, unchanged from 15.6 and 17.6.** Momentum feel.
The platform's own selection handles, magnifier and callout bar: a synthetic
touch is untrusted and never raises them, so what the pass proves is that the
text is selectable DOM text and that a held selection freezes the window, not
that iOS draws its handles over it. Haptics. Real keyboard geometry. Safe-area
insets. Touch latency under live output. The G.5 seventeen-step device script
remains the only thing that verifies those, and it has still not been run.

### 18.5 What P12 inherits

1. **Nothing terminal-side except the device script.** Every item on 17.7's
   mop-up list is closed. What remains is G.5's seventeen-step script, which is
   the same thing as P11.7's own "manual matrix on a real phone".
2. **A published window with published numbers.** `windowStats()` returns chunk,
   hydration and character counts, so "the window is working" stays a claim
   about measurable numbers rather than an assertion in a commit message.
3. **E.4's seven module splits**, none of them shipped, recorded as DV-P11b-3
   with the reason and the ownership. The largest is xterm plus `terminal.js`
   deferred to the first Terminal navigation.
4. **`alpha.27` is P12's number**, per DV-P11b-4.
5. **Two harness traps worth knowing before writing another suite** (18.2.6).
