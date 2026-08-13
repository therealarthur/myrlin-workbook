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
| `backdrop-filter`, `styles.css` | 5 | 5 | match |
| `translateY`, `styles.css` | 21 | 21 | match |
| JS-coupled classes (DO-NOT-BREAK B.1) | 278 | 278 extracted, 278 present in source | match |
| Verbatim ID list (DO-NOT-BREAK A.3) | 336 | 340 backticked names in A.3; 346 ids authored in `index.html`; 32 A.3 ids are built by JS rather than authored | see 4.3 |

Additional counters measured in P0 because a gate needs them and the contract does not state them:

| Counter | Measured on unmodified source |
| --- | --- |
| Rules carrying a `[hidden]` guard, four stylesheets | 30 (21 + 6 + 3 + 0) |
| Catppuccin `var()` consumption outside the 13 palette blocks | 1262 (1176 + 50 + 26 + 10) |
| `text-transform: uppercase` across `src/web/public/*.css` | 56 (50 + 4 + 2) |
| Raw colours in `semantic-theme.css` | 0 |
| Em dashes (U+2014) and horizontal bars (U+2015) in `src/`, `test/`, `scripts/`, `docs/design/notion-restyle/` | 0 |
| Prose double hyphens in the frontend and the restyle docs | 11 pre-existing sites, see 5.2 |
| Inline `style="` in `index.html` and `app.js` | not re-measured in P0; the contract's 63 and 182 stand until P4 touches them |

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

### 5.8 The scope of the em-dash gate

G12 has two halves because a single repo-wide rule cannot pass today. G12a scans `src/`, `test/`,
`scripts/` and `docs/design/notion-restyle/` for U+2014 and U+2015 and requires **zero**, which
passes today and catches every em dash regardless of who wrote it. G12b scans only the lines this
program **adds** relative to the recorded baseline commit for a prose double hyphen, because 11 such
sites already exist and predate the restyle.

The 11 pre-existing sites, recorded so nobody re-discovers them: `app.js` lines 7711, 7723, 7776,
7797, 7948, 16701, 20570, and `index.html` lines 1629, 1630, 1631. Four of those are user-facing
strings (`index.html` 1629 to 1631 in the agent-teams help text, `app.js` 7711 and 7797 in kanban
card copy). Cleaning them is a copy change, not a restyle change, and it belongs to P11's copy pass
under `PROCEDURE.md` step 11 rather than to a gate.

---

## 6. Pre-existing defects found during P0, not fixed here

An implementation agent that finds a broken thing outside its work package reports it rather than
fixing it, per `BUILD-CONTRACT.md` 4.1 item 7.

| # | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| F1 | The browser lane is red before the restyle touches anything. `test/browser/workbook-shell.test.js` lines 366 and 367 assert `terminal.js?v=20260727-copy-native8` and `app.js?v=20260727-copy-native8`, but `index.html` serves `terminal.js?v=20260806-selectv3` and `app.js?v=20260805-mobile-select1`. The assertions were not updated when the Select v3 and mobile-select cachebusters landed. | `grep -n "copy-native8" test/browser/workbook-shell.test.js src/web/public/index.html` | This is a fourth file in the G10 atomic set that the contract's list does not name. Gate G10 reports it as a warning rather than failing, because failing would make an unmodified-source gate red. The orchestrator should either fix those two lines (a one-line-each test edit outside the sanctioned list, so it needs an explicit blessing) or add the file to SE-7. Until then `npm run test:workbook-shell` cannot pass. |
| F2 | The `--text-tertiary` Latte-only override at `focused-shell.css:30` is already inert and is pinned verbatim by `focused-shell.test.js`. | contract 1.3 | No action. Recorded so P1 does not "fix" it. |

---

## 7. Deferrals

Nothing is deferred yet. Rows that reach `5.5.1` as `○` without a route land here, one per row, with
a reason.
