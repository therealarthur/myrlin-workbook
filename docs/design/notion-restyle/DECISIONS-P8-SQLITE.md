# P8.1 decision: how the workbook reads the Codex SQLite thread store

| Field | Value |
|---|---|
| Work package | `BUILD-CONTRACT.md` P8.1, the spike that gates all of phase P8 |
| Decision | **`sql.js` (WASM), plus a WAL overlay** |
| Status | Implemented in `src/providers/codex/state-db.js` |
| Date | 2026-08-13 |
| Measured on | Node v22.16.0, win32 x64, against the real 23.3 MB `state_5.sqlite` with a live 4.0 MB WAL |

> **Filing note for the orchestrator.** The contract says to record this in
> `docs/design/notion-restyle/DECISIONS.md`, which is created by P0.3 and did
> not exist when P8 ran. This file is deliberately separate so it cannot race
> P0's writer. Fold it into `DECISIONS.md` when that file lands.

---

## 1. The decision

`sql.js` is the production engine. `node:sqlite` is used in exactly one place: as
a **test oracle**, guarded so it is skipped on runtimes that lack it.

This matches decision D2's stated default ("Default to `sql.js` if the spike is
ambiguous"), and the spike did not show `sql.js` unfit. It showed one real
weakness, WAL blindness, which is closed below.

## 2. The numbers

Both engines against the real store, five to eight runs each.

| Measure | `sql.js` (WASM) | copy + `node:sqlite` |
|---|---|---|
| Snapshot / copy | 12 ms | 17 ms |
| Open | 5 ms | 23 ms (WAL recovery) |
| Visible-set SELECT | 19 ms | 17 ms |
| Rows returned | 125 | 125 |
| Steady-state RSS over 8 cycles | 105 MB | 82 MB |
| Memory growth across cycles | none | none |
| Runtime warning | none | `ExperimentalWarning` on require |
| Native build | none | none |

**The two engines returned identical results on every query.** Performance did
not decide this.

## 3. What actually decided it

1. **Runtime coverage.** `package.json` declares `engines.node >= 20`.
   `node:sqlite` did not exist before Node 22.5. Choosing it would mean the
   headline Codex parity feature silently does nothing on a supported runtime,
   with no error and no signal, and the user would simply see the old 52
   sessions. `sql.js` behaves identically on every supported version.
2. **API stability.** `node:sqlite` is experimental, and Node states plainly
   that it "might change at any time". This code ships to users who upgrade Node
   on their own schedule.
3. **Warning containment.** On v22.16 `node:sqlite` is unflagged but emits a
   process-wide `ExperimentalWarning` on require. It *can* be suppressed, and
   the spike proved it (a child process required it with clean stderr), but only
   by monkeypatching `process.emitWarning`, a global mutation in a shared
   process. That is the kind of hidden coupling this codebase avoids.

`node:sqlite` was **not disqualified on the flag criterion**: it needs no flag on
this Node version. It lost on portability and stability.

### The cost of choosing sql.js, and how it is paid

A byte-image engine reads the main database file only, so anything committed to
the `-wal` and not yet checkpointed is invisible to it. This was **measured, not
assumed**: sampling the live database while the Codex app was running showed the
main-file view disagreeing with the main-plus-WAL view on real committed data
(`sum(tokens_used)` and `max(updated_at_ms)` both differed).

`applyWalOverlay` in `state-db.js` closes it by replaying the WAL the way
SQLite's own recovery does, gated on three checks that each abort the overlay and
return the untouched image:

- the WAL header checksum must verify, which also fixes the checksum byte order
  (`sqlite3 wal.c` derives it as `magic & 1`, the opposite of what a careless
  reading of the file-format page suggests);
- each frame's salt must match the header's, ending the checkpoint generation;
- each frame's cumulative checksum must verify, rejecting a torn frame.

Only frames up to and including the **last valid commit frame** are applied, so
an in-flight transaction is never half-applied.

**Validation against `node:sqlite` as an oracle, on the real database:** 723
frames applied, **zero** query mismatches across eight probes including a
20-row id ordering, and `PRAGMA quick_check` returns `ok`. The main-file-only
view failed two of those same eight probes. The equivalent check runs
hermetically in `test/codex-state-db.test.js` against a 60-row database whose
WAL is deliberately left uncheckpointed, and is skipped with a message on
runtimes without `node:sqlite`.

## 4. Consequences the rest of the build should know

- **One new dependency: `sql.js`, MIT, pure JS, no native build.** Loaded
  lazily and behind a containment guard, so a workbook user who only runs Claude
  never loads the WASM, and a failed install degrades to the filesystem walk
  rather than breaking the server.
- **The engine is an implementation detail of `state-db.js`.** Nothing else
  imports it. Swapping engines later is one file.
- **Reads are asynchronous and single-shot.** A synchronous 23 MB read was
  observed taking 6.2 seconds under real disk contention, which in a server is
  6.2 seconds of blocked event loop. `fs.promises.readFile` costs 188 ms because
  it chunks. One positional `handle.read` costs 18 ms and never blocks; that is
  what ships.
- **`logs_2.sqlite` (2.1 GB) can never be opened**, enforced by a filename
  allow-list and an independent size ceiling, both checked on every read.
- **Nothing under `~/.codex` is ever written.** `sql.js` has no filesystem write
  path, so this is structural rather than merely intended. Proven by a mtime and
  size audit around a full discovery run, with a control showing the `-wal`
  mtime advances by itself while the process does nothing.
- **A kill switch exists**: `CWM_CODEX_STATE_DB=0` disables the whole SQLite
  path and sends every caller down the walk, without a code change.

## 5. Follow-up left open

Cold discovery re-reads the 23 MB main file. Because a WAL-mode database only
rewrites the main file at checkpoint, that read could be cached on
`(size, mtime)` and only the 4 MB WAL re-read, which would cut a cold pass to
roughly 20 ms. It costs 23 MB of resident memory and a second cache layer, so it
was not taken now: the existing TTL cache already puts the common path at 22 ms.
Revisit in P9 only if cold discovery latency proves to matter.
