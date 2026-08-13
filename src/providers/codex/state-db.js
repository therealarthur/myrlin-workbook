/**
 * Read-only accessor over the Codex desktop app's SQLite thread store.
 *
 * BUILD-CONTRACT P8.2 / CODEX-PARITY C.1 (gaps B1, B2, B3, B24).
 *
 * ===========================================================================
 * Why this module exists
 * ===========================================================================
 *
 * The workbook's Codex provider has been reading the wrong source of truth. It
 * reconstructs the session list by walking `$CODEX_HOME/sessions/**` and reads
 * `session_index.jsonl` for titles. The desktop app uses neither as its list:
 * it uses `$CODEX_HOME/state_5.sqlite`, whose `threads` table carries the cwd,
 * the archived flag, the visibility flag, the spawn graph, the model and the
 * token totals.
 *
 * Measured on a live machine: the walk returns 52 sessions of which 27 carry a
 * title, where the database's top-level visible set is 125. Roughly 58 percent
 * of the user's Codex conversations are invisible in the workbook and half of
 * what does appear is untitled. Everything needed to fix that is already on
 * disk.
 *
 * ===========================================================================
 * Safety properties, all of which are hard requirements
 * ===========================================================================
 *
 * 1. NEVER WRITE. No write handle is ever opened against anything under
 *    CODEX_HOME. The engine is sql.js, which operates on a byte image held in
 *    memory and has no filesystem write path at all, so this property is
 *    structural rather than merely intended. A write to this database would
 *    damage the user's real session history.
 *
 * 2. NEVER OPEN `logs_2.sqlite`. It is 2.1 GB on the measured machine.
 *    Enforced twice: an explicit filename allow-list (assertPermittedDatabase)
 *    and a maximum-size guard (MAX_DATABASE_BYTES). Both are checked on every
 *    read, not once at startup.
 *
 * 3. NEVER THROW. Absence, an unreadable file, a locked WAL, schema drift, a
 *    missing engine, a corrupt image: every one of them returns null and lets
 *    the caller fall back to the filesystem walk. This holds the same
 *    never-throw discipline discover.js already documents.
 *
 * 4. NEVER DELETE THE WALK. This module is a fast, rich, additional source. It
 *    is not a replacement. A machine where the desktop app has never run has no
 *    database at all, and the walk is the only path that works there.
 *
 * ===========================================================================
 * Engine choice: sql.js, decided by the P8.1 spike
 * ===========================================================================
 *
 * Measured on this machine, Node v22.16.0, against the real 23.3 MB
 * `state_5.sqlite` with a 4.0 MB live WAL:
 *
 *   sql.js (WASM)         copy 12ms, open 5ms, full visible-set SELECT 19ms,
 *                         125 rows, steady-state RSS 105 MB across 8 cycles
 *   copy + node:sqlite    copy 17ms, open 23ms, full SELECT 17ms,
 *                         125 rows, steady-state RSS 82 MB across 8 cycles
 *
 * Both return identical results. sql.js wins on the criteria that actually
 * decide it:
 *
 *   - `package.json` declares `engines.node >= 20`. `node:sqlite` does not
 *     exist before Node 22.5, so choosing it would mean this flagship feature
 *     silently does nothing for a slice of supported runtimes. sql.js behaves
 *     identically everywhere.
 *   - `node:sqlite` is experimental and emits a process-wide runtime warning on
 *     require. Suppressing it means monkeypatching `process.emitWarning`, which
 *     is exactly the hidden global coupling this codebase avoids.
 *   - `node:sqlite`'s API is explicitly allowed to change between minor Node
 *     releases. sql.js is a stable, MIT, pure-JS artifact with no native build.
 *
 * The one real cost of a byte-image engine is WAL blindness, and it is measured
 * rather than assumed: sampling the live database showed the main file lagging
 * the WAL by real committed data (token totals and updated_at_ms both differed).
 * That is closed by applyWalOverlay below, which is validated against
 * `node:sqlite` as an oracle: 723 frames applied, zero query mismatches,
 * `PRAGMA quick_check` clean.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/state-db
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describeProject, normalizeCodexPath } = require('./paths');

// ---------------------------------------------------------------------------
// Constants. No magic values at call sites.
// ---------------------------------------------------------------------------

/** The desktop app's thread store, relative to CODEX_HOME. */
const STATE_DB_FILENAME = 'state_5.sqlite';

/**
 * The sidebar projection cache, relative to CODEX_HOME. Schema-wise this is
 * exactly the projection the workbook wants, but it held one row on the
 * measured machine and why it is empty is unconfirmed. Read it opportunistically
 * as the best title source; never depend on it.
 */
const DEV_DB_RELATIVE_PATH = path.join('sqlite', 'codex-dev.db');

/**
 * Hard allow-list of database files this module may ever open. Anything not
 * named here is refused before a single byte is read. `logs_2.sqlite` is 2.1 GB
 * and is the specific file this guard exists to keep out.
 */
const PERMITTED_DATABASE_FILENAMES = new Set([STATE_DB_FILENAME, 'codex-dev.db']);

/**
 * Second, independent guard against reading something enormous. Chosen an order
 * of magnitude above the observed 23.3 MB state database and an order of
 * magnitude below the 2.1 GB log database, so it separates them decisively
 * without being tight enough to reject natural growth.
 */
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

/**
 * How long a parsed result stays warm. The WAL churns constantly, so a
 * content-keyed cache alone would miss on nearly every call; the TTL is what
 * actually bounds the cost. Short enough that a new thread appears promptly,
 * long enough that a burst of route handlers costs one read.
 */
const CACHE_TTL_MS = 2000;

/** Truncation length for a preview used as a title. CODEX-PARITY C.3 step 6. */
const PREVIEW_TITLE_MAX_CHARS = 60;

/**
 * Server-side bound on the `title` column.
 *
 * `threads.title` is documented as "the raw first user message", and on the
 * measured machine the 125 visible rows carry 1.9 MB of it between them, with a
 * single row at 80 KB. Selecting it whole cost 57ms of the read; bounding it in
 * SQL cut the same SELECT to 18ms. Nothing downstream can use more than
 * PREVIEW_TITLE_MAX_CHARS of it, because it is only ever a truncated fallback,
 * so this bound is generous headroom rather than a limitation.
 */
const TITLE_SELECT_MAX_CHARS = 240;

/**
 * Server-side bound on the `preview` column.
 *
 * Documented as "first ~60 chars", measured at 19 KB average across the visible
 * set, 2.4 MB in total. The side peek shows the preview as a property, so this
 * bound is set far above anything a property row can display while still
 * capping the read at a fraction of a megabyte.
 */
const PREVIEW_SELECT_MAX_CHARS = 2000;

/**
 * Columns bounded in SQL rather than in JavaScript, mapped to their limit.
 * Bounding in the query is what keeps the bytes off the wire in the first
 * place; truncating after the fact would already have paid for them.
 */
const BOUNDED_TEXT_COLUMNS = Object.freeze({
  title: TITLE_SELECT_MAX_CHARS,
  preview: PREVIEW_SELECT_MAX_CHARS,
  first_user_message: PREVIEW_SELECT_MAX_CHARS,
});

/** Last-resort label when every cascade step is empty. Never reached in practice. */
const UNTITLED_LABEL = 'Untitled session';

/** Ordered title-source names, exported so callers can report provenance. */
const TITLE_SOURCES = Object.freeze({
  CATALOG: 'catalog',
  NAME: 'name',
  SESSION_INDEX: 'session-index',
  ROLLOUT_EVENT: 'rollout-event',
  PREVIEW: 'preview',
  TITLE_FALLBACK: 'title',
  NONE: 'none',
});

// SQLite WAL format constants. Reference: https://sqlite.org/fileformat2.html
const WAL_MAGIC_A = 0x377f0682;
const WAL_MAGIC_B = 0x377f0683;
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const DB_HEADER_PAGE_SIZE_OFFSET = 16;
const DB_HEADER_MIN_BYTES = 100;
const MAX_SQLITE_PAGE_SIZE = 65536;

/**
 * Columns wanted from `threads`, in the order they are selected. Every one is
 * optional: the actual SELECT is the intersection of this list with what
 * `PRAGMA table_info(threads)` reports, so a column the app removes costs one
 * field rather than the whole discovery path (CODEX-PARITY D.2).
 */
const WANTED_THREAD_COLUMNS = Object.freeze([
  'id',
  'rollout_path',
  'cwd',
  'title',
  'preview',
  'name',
  'archived',
  'archived_at',
  'is_pinned',
  'thread_section_id',
  'recency_at_ms',
  'created_at_ms',
  'updated_at_ms',
  'created_at',
  'updated_at',
  'tokens_used',
  'model',
  'model_provider',
  'reasoning_effort',
  'approval_mode',
  'sandbox_policy',
  'cli_version',
  'git_branch',
  'git_sha',
  'git_origin_url',
  'thread_source',
  'source',
  'agent_nickname',
  'agent_role',
]);

/**
 * The only column without which the table is unrecognisable. Its absence means
 * the schema has drifted past what this module can interpret, and the correct
 * response is to degrade wholesale to the walk.
 */
const REQUIRED_THREAD_COLUMN = 'id';

/**
 * Recency ordering preference. The desktop app sorts on `recency_at_ms`, which
 * is deliberately distinct from `updated_at`. The rest are fallbacks for a
 * schema that has not grown that column yet.
 */
const RECENCY_COLUMN_PREFERENCE = Object.freeze([
  'recency_at_ms',
  'updated_at_ms',
  'created_at_ms',
]);

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * Resolve CODEX_HOME at call time, not at module load, so a test or a user can
 * change the variable between calls.
 *
 * Deliberately duplicated from discover.js rather than imported: discover.js
 * consumes this module, and importing back would create a require cycle whose
 * failure mode is a half-initialised module object rather than a clean error.
 * Two lines of duplication is the cheaper risk.
 *
 * @returns {string} Absolute path to the Codex home directory.
 */
function getCodexHome() {
  // gsd:provider-literal-allowed (default Codex home directory name)
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Absolute path to the thread store.
 * @returns {string}
 */
function getStateDbPath() {
  return path.join(getCodexHome(), STATE_DB_FILENAME);
}

/**
 * Absolute path to the sidebar projection cache.
 * @returns {string}
 */
function getDevDbPath() {
  return path.join(getCodexHome(), DEV_DB_RELATIVE_PATH);
}

/**
 * Gate every database open through one predicate.
 *
 * Two independent checks, because one of them protects against a coding mistake
 * and the other against an unexpected file on disk:
 *   - the basename must be on the allow-list, which is what keeps
 *     `logs_2.sqlite` out even if a future caller passes its path;
 *   - the file must be under MAX_DATABASE_BYTES, which is what keeps any
 *     enormous file out even if it were somehow allow-listed.
 *
 * @param {string} filePath - Candidate database path.
 * @returns {boolean} True when this module is permitted to read it.
 */
function assertPermittedDatabase(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const base = path.basename(filePath).toLowerCase();
  if (!PERMITTED_DATABASE_FILENAMES.has(base)) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size > MAX_DATABASE_BYTES) return false;
  if (stat.size < DB_HEADER_MIN_BYTES) return false;
  return true;
}

/**
 * Environment kill switch. Setting it to `0` or `false` makes this module
 * report itself unavailable, which sends every caller down the filesystem walk.
 *
 * Two reasons it exists rather than being a code change:
 *   - operations: if the Codex app ever ships a schema this module misreads,
 *     the user can turn the whole path off without waiting for a release;
 *   - measurement: the before-and-after discovery numbers for this phase were
 *     produced from ONE build by toggling this, rather than by comparing two
 *     builds and hoping nothing else moved.
 */
const STATE_DB_ENABLED_ENV = 'CWM_CODEX_STATE_DB';

/**
 * Whether the SQLite path is enabled at all. Read at call time so a test or an
 * operator can flip it between calls.
 *
 * @returns {boolean}
 */
function isEnabled() {
  const raw = process.env[STATE_DB_ENABLED_ENV];
  if (raw === undefined || raw === null || raw === '') return true;
  const normalized = String(raw).trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
}

/**
 * Cheap synchronous probe used by callers to decide whether the SQLite path is
 * worth attempting at all. Touches metadata only; opens nothing.
 *
 * @returns {boolean} True when the path is enabled AND a readable, permitted
 *   thread store exists.
 */
function isAvailable() {
  if (!isEnabled()) return false;
  return assertPermittedDatabase(getStateDbPath());
}

// ---------------------------------------------------------------------------
// The WAL overlay
// ---------------------------------------------------------------------------

/**
 * SQLite's cumulative WAL checksum.
 *
 * Processes the buffer as pairs of 32-bit words:
 *   s0 += x[i]   + s1
 *   s1 += x[i+1] + s0
 * with 32-bit wraparound, where the word byte order comes from the WAL header
 * magic. All intermediate sums stay below 2^53, so plain addition followed by
 * ToUint32 via `>>> 0` is exact.
 *
 * @param {Buffer} buf - Range to checksum. Trailing bytes past the last whole
 *   8-byte word are ignored, matching SQLite.
 * @param {boolean} bigEndian - Word byte order.
 * @param {number} s0 - Running checksum, part 1.
 * @param {number} s1 - Running checksum, part 2.
 * @returns {[number, number]} Updated running checksum.
 */
function walChecksum(buf, bigEndian, s0, s1) {
  let a = s0 >>> 0;
  let b = s1 >>> 0;
  for (let i = 0; i + 8 <= buf.length; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    a = (a + x0 + b) >>> 0;
    b = (b + x1 + a) >>> 0;
  }
  return [a, b];
}

/**
 * Read the page size out of a SQLite main-database header. The stored value 1
 * is the documented encoding of 65536.
 *
 * @param {Buffer} dbImage
 * @returns {number|null} Page size in bytes, or null when the header is not a
 *   SQLite header.
 */
function readDbPageSize(dbImage) {
  if (!Buffer.isBuffer(dbImage) || dbImage.length < DB_HEADER_MIN_BYTES) return null;
  const raw = dbImage.readUInt16BE(DB_HEADER_PAGE_SIZE_OFFSET);
  if (raw === 1) return MAX_SQLITE_PAGE_SIZE;
  if (raw < 512) return null;
  if ((raw & (raw - 1)) !== 0) return null; // must be a power of two
  return raw;
}

/**
 * Apply committed WAL frames onto a database byte image.
 *
 * In WAL mode the main database file is only modified during a checkpoint, so
 * between checkpoints every recent commit lives exclusively in the `-wal` file.
 * A byte-image engine that reads the main file alone therefore sees a stale
 * database. This function closes that gap by replaying the WAL the same way
 * SQLite's own recovery does.
 *
 * Correctness rests on three checks, any of which aborting leaves the caller
 * with exactly the pre-overlay image, which is the safe outcome:
 *   - the WAL header checksum must verify, proving the header is intact and
 *     fixing the checksum byte order (sqlite3 wal.c derives it as `magic & 1`);
 *   - each frame's salt must match the header's, which is what ends the current
 *     checkpoint generation;
 *   - each frame's cumulative checksum must verify, which is what rejects a
 *     torn frame from a copy taken mid-write.
 * Only frames up to and including the LAST valid commit frame are durable, so a
 * transaction that was still being written is never half-applied.
 *
 * @param {Buffer} dbImage - Main database bytes. Not mutated.
 * @param {Buffer} walImage - `-wal` file bytes. May be empty.
 * @returns {{image: Buffer, applied: number, reason: string}} `reason` is 'ok'
 *   on success and a short diagnostic tag on every bail-out.
 */
function applyWalOverlay(dbImage, walImage) {
  const bail = (reason) => ({ image: dbImage, applied: 0, reason: reason });
  try {
    if (!Buffer.isBuffer(dbImage)) return { image: dbImage, applied: 0, reason: 'no-db-image' };
    if (!Buffer.isBuffer(walImage) || walImage.length < WAL_HEADER_BYTES) {
      return bail('wal-absent-or-too-small');
    }

    const magic = walImage.readUInt32BE(0);
    if (magic !== WAL_MAGIC_A && magic !== WAL_MAGIC_B) return bail('bad-magic');
    // sqlite3 wal.c: pWal->hdr.bigEndCksum = (u8)(magic & 0x00000001)
    const bigEndian = (magic & 1) === 1;

    const dbPageSize = readDbPageSize(dbImage);
    if (!dbPageSize) return bail('db-page-size-unreadable');
    const walPageSizeRaw = walImage.readUInt32BE(8);
    const walPageSize = walPageSizeRaw === 1 ? MAX_SQLITE_PAGE_SIZE : walPageSizeRaw;
    if (walPageSize !== dbPageSize) return bail('page-size-mismatch');

    const salt1 = walImage.readUInt32BE(16);
    const salt2 = walImage.readUInt32BE(20);
    const headerChecksum1 = walImage.readUInt32BE(24);
    const headerChecksum2 = walImage.readUInt32BE(28);

    let [running0, running1] = walChecksum(walImage.subarray(0, 24), bigEndian, 0, 0);
    if (running0 !== headerChecksum1 || running1 !== headerChecksum2) {
      return bail('header-checksum-mismatch');
    }

    const frameStride = WAL_FRAME_HEADER_BYTES + dbPageSize;
    /** @type {Array<{page:number, dataOffset:number}>} */
    const frames = [];
    let lastCommitIndex = -1;
    let dbSizeInPagesAfterCommit = 0;

    for (let off = WAL_HEADER_BYTES; off + frameStride <= walImage.length; off += frameStride) {
      const pageNumber = walImage.readUInt32BE(off);
      const commitSizeInPages = walImage.readUInt32BE(off + 4);
      if (walImage.readUInt32BE(off + 8) !== salt1) break; // next checkpoint generation
      if (walImage.readUInt32BE(off + 12) !== salt2) break;
      const frameChecksum1 = walImage.readUInt32BE(off + 16);
      const frameChecksum2 = walImage.readUInt32BE(off + 20);

      // The frame checksum covers the first 8 bytes of the frame header and
      // then the whole page payload, continuing the running checksum.
      let [next0, next1] = walChecksum(walImage.subarray(off, off + 8), bigEndian, running0, running1);
      [next0, next1] = walChecksum(
        walImage.subarray(off + WAL_FRAME_HEADER_BYTES, off + frameStride),
        bigEndian,
        next0,
        next1
      );
      if (next0 !== frameChecksum1 || next1 !== frameChecksum2) break; // torn frame

      running0 = next0;
      running1 = next1;
      if (pageNumber < 1) break;
      frames.push({ page: pageNumber, dataOffset: off + WAL_FRAME_HEADER_BYTES });
      if (commitSizeInPages > 0) {
        lastCommitIndex = frames.length - 1;
        dbSizeInPagesAfterCommit = commitSizeInPages;
      }
    }

    if (lastCommitIndex < 0) return bail('no-committed-frames');

    const durable = frames.slice(0, lastCommitIndex + 1);
    const targetBytes = dbSizeInPagesAfterCommit * dbPageSize;
    const out = Buffer.allocUnsafe(Math.max(targetBytes, dbImage.length));
    dbImage.copy(out, 0, 0, Math.min(dbImage.length, out.length));
    if (out.length > dbImage.length) out.fill(0, dbImage.length);

    for (const frame of durable) {
      const dest = (frame.page - 1) * dbPageSize;
      if (dest < 0 || dest + dbPageSize > out.length) return bail('page-out-of-range');
      walImage.copy(out, dest, frame.dataOffset, frame.dataOffset + dbPageSize);
    }

    const image = targetBytes > 0 && targetBytes <= out.length ? out.subarray(0, targetBytes) : out;
    return { image: image, applied: durable.length, reason: 'ok' };
  } catch (err) {
    // A malformed WAL must cost the overlay, never the read.
    return { image: dbImage, applied: 0, reason: 'overlay-threw:' + (err && err.message) };
  }
}

// ---------------------------------------------------------------------------
// Snapshotting: copy before read
// ---------------------------------------------------------------------------

/**
 * Take a point-in-time snapshot of a database, WAL included.
 *
 * "Copy before read" is satisfied primarily by copying into memory: a plain
 * read takes no lock, holds no handle, and cannot write, which dodges the WAL
 * lock problem more completely than a file copy does while avoiding tens of
 * megabytes of disk churn per discovery pass. If the in-memory read fails for
 * any reason (a sharing violation on Windows, for instance), the function falls
 * back to a temp-file copy and reads that, then deletes it in a finally block.
 *
 * Consistency: because the main file only changes during a checkpoint, a torn
 * main-file read is unlikely; a torn WAL read is both likely and harmless,
 * because applyWalOverlay stops at the first frame whose checksum fails.
 *
 * @param {string} dbPath - Path to a permitted database.
 * @returns {{image: Buffer, walFrames: number, walReason: string}|null} Null on
 *   any failure.
 */
async function snapshotDatabase(dbPath) {
  if (!assertPermittedDatabase(dbPath)) return null;

  /**
   * Read a file into memory, returning null rather than throwing.
   *
   * ASYNCHRONOUS on purpose, and single-shot on purpose. Both halves were
   * measured on this machine against the real 23 MB store:
   *
   *   fs.readFileSync          median  18ms, but it BLOCKS the event loop, and
   *                            it was observed taking 6.2 seconds under real
   *                            disk contention while the Codex app wrote its
   *                            2.1 GB log database. Six seconds of a blocked
   *                            loop stalls every terminal, every SSE stream and
   *                            every route in the server.
   *   fs.promises.readFile     median 188ms. It reads a large file in many
   *                            small chunks, so it pays roughly fifty
   *                            threadpool round trips for one 23 MB file.
   *   open + one handle.read   median  18ms, one single read syscall for the
   *                            whole file, and it never blocks the loop.
   *
   * The third is the only option that is both fast and non-blocking, so it is
   * the primary path. The loop around the read is there because a short read is
   * legal, not because it is expected: it needed exactly one syscall in
   * practice. fs.promises.readFile remains the fallback so an exotic
   * filesystem that refuses positional reads still works, slowly.
   */
  const readOrNull = async (p) => {
    let handle = null;
    try {
      handle = await fs.promises.open(p, 'r');
      const stat = await handle.stat();
      if (!stat.size) return null;
      const buffer = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
        if (bytesRead <= 0) break; // short read: the file shrank under us
        offset += bytesRead;
      }
      return offset === stat.size ? buffer : buffer.subarray(0, offset);
    } catch (_) {
      try {
        return await fs.promises.readFile(p);
      } catch (_ignored) {
        return null;
      }
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (_) {
          /* a leaked handle on a failing read is not worth failing discovery */
        }
      }
    }
  };

  let dbImage = await readOrNull(dbPath);
  let tempDir = null;
  try {
    if (!dbImage) {
      // Fallback: copy to a private temp directory, then read the copy. Reached
      // when a direct read is refused, for instance by a Windows sharing
      // violation. Copying first is what "copy before read" is literally about.
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cwm-codex-statedb-'));
      const copyPath = path.join(tempDir, path.basename(dbPath));
      await fs.promises.copyFile(dbPath, copyPath);
      dbImage = await readOrNull(copyPath);
      if (!dbImage) return null;
      const walCopy = await readOrNull(copyPath + '-wal');
      const overlaid = applyWalOverlay(dbImage, walCopy || Buffer.alloc(0));
      return { image: overlaid.image, walFrames: overlaid.applied, walReason: overlaid.reason };
    }

    const walImage = await readOrNull(dbPath + '-wal');
    const overlaid = applyWalOverlay(dbImage, walImage || Buffer.alloc(0));
    return { image: overlaid.image, walFrames: overlaid.applied, walReason: overlaid.reason };
  } catch (_) {
    return null;
  } finally {
    if (tempDir) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (_) {
        /* a leftover temp dir is not worth failing discovery over */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Engine loading, contained
// ---------------------------------------------------------------------------

/**
 * Memoised engine promise. Holds the resolved sql.js factory, or null when the
 * dependency is absent or failed to initialise. Never rejects.
 * @type {Promise<object|null>|null}
 */
let _enginePromise = null;

/** Diagnostic for the most recent engine load failure. Exposed via getDiagnostics. */
let _engineError = null;

/**
 * Load sql.js lazily and exactly once.
 *
 * Contained the same way pty-manager contains node-pty: a require failure is a
 * degraded capability, not a crashed server. A workbook user who only runs
 * Claude never loads the WASM at all, because nothing calls in here until a
 * Codex state database is found on disk.
 *
 * @returns {Promise<object|null>} The sql.js module namespace, or null.
 */
function loadEngine() {
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    let initSqlJs;
    try {
      // eslint-disable-next-line global-require
      initSqlJs = require('sql.js');
    } catch (err) {
      _engineError = 'require failed: ' + (err && err.message);
      return null;
    }
    try {
      // Resolve the .wasm next to the loader we actually resolved, so a hoisted
      // or nested node_modules layout both work.
      const distDir = path.dirname(require.resolve('sql.js'));
      return await initSqlJs({ locateFile: (file) => path.join(distDir, file) });
    } catch (err) {
      _engineError = 'init failed: ' + (err && err.message);
      return null;
    }
  })();
  return _enginePromise;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Run a statement and map sql.js's columnar result into plain objects.
 *
 * @param {object} db - An open sql.js Database.
 * @param {string} sql - The statement.
 * @param {Array} [params] - Optional bound parameters.
 * @returns {Array<object>} Rows, or [] on any failure.
 */
function selectRows(db, sql, params) {
  try {
    const result = params && params.length ? db.exec(sql, params) : db.exec(sql);
    if (!Array.isArray(result) || result.length === 0) return [];
    const { columns, values } = result[0];
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const row = {};
      for (let c = 0; c < columns.length; c++) row[columns[c]] = values[i][c];
      out[i] = row;
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * Probe the real column set of a table.
 *
 * The `threads` table already carries migration scars: `created_at` alongside
 * `created_at_ms`, `updated_at` alongside `recency_at_ms`, and a trailing block
 * of ALTER-TABLE-added columns. `_sqlx_migrations` exists, so the schema will
 * keep moving. Probing rather than assuming is what turns a future column
 * removal into one missing field instead of a broken feature.
 *
 * @param {object} db
 * @param {string} table
 * @returns {Set<string>} Column names, empty when the table is absent.
 */
function probeColumns(db, table) {
  const rows = selectRows(db, 'PRAGMA table_info(' + table + ')');
  const names = new Set();
  for (const row of rows) {
    if (row && typeof row.name === 'string') names.add(row.name);
  }
  return names;
}

/**
 * List the table names present in the database.
 *
 * @param {object} db
 * @returns {Set<string>}
 */
function probeTables(db) {
  const rows = selectRows(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
  const names = new Set();
  for (const row of rows) {
    if (row && typeof row.name === 'string') names.add(row.name);
  }
  return names;
}

/**
 * Coerce a SQLite value to a finite number, or null.
 * @param {*} v
 * @returns {number|null}
 */
function toNumberOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce a SQLite value to a non-empty trimmed string, or null. Empty strings
 * are normalised to null so callers never have to test both.
 * @param {*} v
 * @returns {string|null}
 */
function toStringOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// Title cascade
// ---------------------------------------------------------------------------

/**
 * Truncate a preview into a title-shaped label.
 *
 * Collapses whitespace first, because a preview is the head of a raw user
 * message and frequently starts with a newline-heavy block. Breaks on a word
 * boundary when one is close to the limit so the label does not end mid-word.
 *
 * @param {*} preview - Raw preview text.
 * @param {number} [maxChars]
 * @returns {string|null}
 */
function truncatePreview(preview, maxChars) {
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : PREVIEW_TITLE_MAX_CHARS;
  const text = toStringOrNull(String(preview == null ? '' : preview).replace(/\s+/g, ' '));
  if (!text) return null;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour a word boundary if it is not so early that the label becomes
  // uselessly short.
  const body = lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.replace(/[\s.,;:!?-]+$/, '') + '\u2026';
}

/**
 * Resolve one thread's display title from every candidate source.
 *
 * Pure function so the cascade is testable without a database. The order is
 * CODEX-PARITY C.3, with one deliberate omission: step 3 of that document is
 * the workbook's own rename, which server.js already applies at read time in
 * groupProviderSessionsForUI and which must keep winning over anything a
 * provider produces. Applying it here too would move a user-facing precedence
 * rule into two places.
 *
 * The measured reality this exists to handle: only 55 of 125 threads have a
 * human-authored or AI-authored title anywhere on disk. `threads.title` is not
 * a title at all, it is the raw first user message, and 21 of 38 user threads
 * exceed 200 characters with one reaching 12 KB. So `title` is used only as a
 * late fallback and only after truncation, never raw.
 *
 * @param {Object} parts
 * @param {string|null} [parts.catalogTitle] - local_thread_catalog.display_title
 * @param {string|null} [parts.name] - threads.name, a user rename
 * @param {string|null} [parts.indexTitle] - session_index.jsonl thread_name
 * @param {string|null} [parts.rolloutTitle] - thread_name_updated from the rollout
 * @param {string|null} [parts.preview] - threads.preview
 * @param {string|null} [parts.title] - threads.title, the raw first message
 * @returns {{title: string, source: string}}
 */
function resolveTitle(parts) {
  const p = parts || {};
  const catalog = toStringOrNull(p.catalogTitle);
  if (catalog) return { title: catalog, source: TITLE_SOURCES.CATALOG };

  const name = toStringOrNull(p.name);
  if (name) return { title: name, source: TITLE_SOURCES.NAME };

  const indexTitle = toStringOrNull(p.indexTitle);
  if (indexTitle) return { title: indexTitle, source: TITLE_SOURCES.SESSION_INDEX };

  const rolloutTitle = toStringOrNull(p.rolloutTitle);
  if (rolloutTitle) return { title: rolloutTitle, source: TITLE_SOURCES.ROLLOUT_EVENT };

  const fromPreview = truncatePreview(p.preview);
  if (fromPreview) return { title: fromPreview, source: TITLE_SOURCES.PREVIEW };

  // threads.title is the raw first user message. It is a poor label and it can
  // be enormous, so it sits below preview and is always truncated.
  const fromTitle = truncatePreview(p.title);
  if (fromTitle) return { title: fromTitle, source: TITLE_SOURCES.TITLE_FALLBACK };

  return { title: UNTITLED_LABEL, source: TITLE_SOURCES.NONE };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Open a snapshot of a permitted database, hand it to a callback, and always
 * close it.
 *
 * Closing matters: sql.js holds the whole image in the WASM heap, so a leaked
 * handle is tens of megabytes that never come back. The finally block is the
 * point of this helper.
 *
 * @param {string} dbPath
 * @param {(db: object, meta: {walFrames:number, walReason:string}) => *} fn
 * @returns {Promise<*|null>} Whatever `fn` returns, or null on any failure.
 */
async function withDatabase(dbPath, fn) {
  const engine = await loadEngine();
  if (!engine) return null;
  const snapshot = await snapshotDatabase(dbPath);
  if (!snapshot) return null;

  let db = null;
  try {
    db = new engine.Database(snapshot.image);
    return fn(db, { walFrames: snapshot.walFrames, walReason: snapshot.walReason });
  } catch (_) {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Read the opportunistic title cache from `sqlite/codex-dev.db`.
 *
 * Best title source when populated and completely absent otherwise: it held one
 * row on the measured machine. Everything about this function is best-effort;
 * a failure returns an empty map and the cascade simply moves on.
 *
 * @returns {Promise<Map<string, string>>} threadId -> display title.
 */
async function readCatalogTitles() {
  const devDbPath = getDevDbPath();
  if (!assertPermittedDatabase(devDbPath)) return new Map();
  const result = await withDatabase(devDbPath, (db) => {
    const tables = probeTables(db);
    if (!tables.has('local_thread_catalog')) return new Map();
    const columns = probeColumns(db, 'local_thread_catalog');
    if (!columns.has('thread_id') || !columns.has('display_title')) return new Map();
    const rows = selectRows(
      db,
      'SELECT thread_id, display_title FROM local_thread_catalog WHERE display_title IS NOT NULL'
    );
    const map = new Map();
    for (const row of rows) {
      const id = toStringOrNull(row.thread_id);
      const title = toStringOrNull(row.display_title);
      if (id && title) map.set(id.toLowerCase(), title);
    }
    return map;
  });
  return result instanceof Map ? result : new Map();
}

/**
 * Map one raw `threads` row into the record shape the rest of the workbook
 * consumes. Every field is defensively coerced, because the row came from a
 * schema this project does not own.
 *
 * @param {object} row - Raw row keyed by real column names.
 * @param {Map<string,string>} catalogTitles - thread id -> display title.
 * @param {string} hostId - Host namespace for the project id.
 * @returns {object|null} Normalised thread record, or null when unusable.
 */
function mapThreadRow(row, catalogTitles, hostId) {
  const id = toStringOrNull(row.id);
  if (!id) return null;
  const idLower = id.toLowerCase();

  const rawCwd = toStringOrNull(row.cwd);
  const project = describeProject(rawCwd || '', hostId);
  const rawRolloutPath = toStringOrNull(row.rollout_path);

  const titleParts = {
    catalogTitle: catalogTitles ? catalogTitles.get(idLower) || null : null,
    name: toStringOrNull(row.name),
    indexTitle: null, // filled by discover.js, which owns session_index.jsonl
    rolloutTitle: null, // lazy, on demand only
    preview: toStringOrNull(row.preview),
    title: toStringOrNull(row.title),
  };

  return {
    id: idLower,
    // Both the raw and the normalised rollout path, because the raw one is what
    // the database said and the normalised one is what the filesystem wants.
    rolloutPath: rawRolloutPath ? normalizeCodexPath(rawRolloutPath) : null,
    rolloutPathRaw: rawRolloutPath,

    cwd: project.path || null,
    cwdRaw: rawCwd,
    projectKey: project.key || null,
    projectId: project.id || null,
    projectDisplayName: project.displayName || null,

    // Title parts are carried through rather than resolved here, so discover.js
    // can fold in session_index.jsonl before the cascade runs exactly once.
    titleParts: titleParts,
    preview: titleParts.preview,
    rawFirstMessage: titleParts.title,
    name: titleParts.name,

    archived: row.archived === 1 || row.archived === true,
    archivedAtMs: toNumberOrNull(row.archived_at),
    isPinned: row.is_pinned === 1 || row.is_pinned === true,
    sectionId: toStringOrNull(row.thread_section_id),

    recencyAtMs: toNumberOrNull(row.recency_at_ms),
    createdAtMs: toNumberOrNull(row.created_at_ms),
    updatedAtMs: toNumberOrNull(row.updated_at_ms),

    tokensUsed: toNumberOrNull(row.tokens_used),
    model: toStringOrNull(row.model),
    modelProvider: toStringOrNull(row.model_provider),
    reasoningEffort: toStringOrNull(row.reasoning_effort),
    approvalMode: toStringOrNull(row.approval_mode),
    sandboxPolicy: toStringOrNull(row.sandbox_policy),
    cliVersion: toStringOrNull(row.cli_version),
    gitBranch: toStringOrNull(row.git_branch),
    gitSha: toStringOrNull(row.git_sha),
    gitOriginUrl: toStringOrNull(row.git_origin_url),
    threadSource: toStringOrNull(row.thread_source),
    sourceRaw: toStringOrNull(row.source),
    agentNickname: toStringOrNull(row.agent_nickname),
    agentRole: toStringOrNull(row.agent_role),
  };
}

/**
 * Build the SELECT for the visible thread set, degrading per missing column.
 *
 * The visible-set predicate is `archived = 0 AND preview <> '' AND NOT a spawn
 * child`. That predicate is an inference rather than a reading of the app's own
 * query, but it is a well-supported one: `threads` carries two partial indexes
 * that name the concept explicitly,
 *
 *   ON threads(archived, created_at_ms DESC) WHERE preview <> ''
 *   ON threads(archived, recency_at_ms DESC, id DESC) WHERE preview <> ''
 *
 * and adding the spawn-edge exclusion takes 2441 rows down to 125, which is a
 * plausible sidebar and the same order of magnitude as the 118 unique ids in
 * session_index.jsonl.
 *
 * The exclusion is on the SPAWN EDGE, never on thread_source: 55 of the 125
 * carry thread_source = 'subagent' yet are not spawn children, so filtering on
 * that column would delete real user threads.
 *
 * @param {Set<string>} columns - Present columns of `threads`.
 * @param {Set<string>} tables - Present tables.
 * @param {Set<string>} spawnColumns - Present columns of `thread_spawn_edges`.
 * @param {{includeArchived: boolean, includeSpawnChildren: boolean, includeHidden: boolean}} opts
 * @returns {{sql: string, capabilities: object}|null}
 */
function buildThreadQuery(columns, tables, spawnColumns, opts) {
  if (!columns.has(REQUIRED_THREAD_COLUMN)) return null;

  // Bounded columns are wrapped in substr() and aliased back to their own name,
  // so every consumer downstream still reads `row.title` and `row.preview` and
  // has no idea the bound exists.
  const selected = WANTED_THREAD_COLUMNS.filter((c) => columns.has(c)).map((c) => {
    const limit = BOUNDED_TEXT_COLUMNS[c];
    return limit ? 'substr(' + c + ', 1, ' + limit + ') AS ' + c : c;
  });
  const where = [];
  const capabilities = {
    archivedFilter: false,
    previewFilter: false,
    spawnFilter: false,
    orderColumn: null,
    missingColumns: WANTED_THREAD_COLUMNS.filter((c) => !columns.has(c)),
  };

  if (!opts.includeArchived && columns.has('archived')) {
    where.push('archived = 0');
    capabilities.archivedFilter = true;
  }
  if (!opts.includeHidden && columns.has('preview')) {
    where.push("preview IS NOT NULL AND preview <> ''");
    capabilities.previewFilter = true;
  }
  if (
    !opts.includeSpawnChildren &&
    tables.has('thread_spawn_edges') &&
    spawnColumns.has('child_thread_id')
  ) {
    where.push('id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)');
    capabilities.spawnFilter = true;
  }

  const orderColumn = RECENCY_COLUMN_PREFERENCE.find((c) => columns.has(c)) || null;
  capabilities.orderColumn = orderColumn;

  const sql =
    'SELECT ' +
    selected.join(', ') +
    ' FROM threads' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    (orderColumn ? ' ORDER BY ' + orderColumn + ' DESC' : '');

  return { sql: sql, capabilities: capabilities };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Warm result cache. Holds the last successful read so a burst of route
 * handlers costs one snapshot, and so the synchronous rollout-path lookup has
 * something to answer from.
 */
let _cache = {
  key: null,
  at: 0,
  threads: null,
  /**
   * Projection key -> { at, rows }. Keyed rather than single-slot so a
   * discovery that asks for archived threads does not permanently miss a cache
   * that only ever held the default projection.
   * @type {Map<string, {at:number, rows:Array<object>}>}
   */
  projections: new Map(),
  rolloutById: null,
  cwdById: null,
  knownIds: null,
  capabilities: null,
  walFrames: 0,
  walReason: 'not-read',
};

/**
 * Content key for the cache: the identity of the database plus its WAL. A
 * change in either invalidates immediately; the TTL bounds how often an
 * unchanged pair is re-read.
 *
 * @returns {string|null}
 */
function currentCacheKey() {
  const dbPath = getStateDbPath();
  let key = '';
  try {
    const s = fs.statSync(dbPath);
    key += s.size + ':' + s.mtimeMs;
  } catch (_) {
    return null;
  }
  try {
    const w = fs.statSync(dbPath + '-wal');
    key += '|' + w.size + ':' + w.mtimeMs;
  } catch (_) {
    key += '|nowal';
  }
  return key;
}

/**
 * Drop the warm cache. Exported for tests and for a caller that knows the
 * database changed.
 * @returns {void}
 */
function invalidate() {
  _cache = {
    key: null,
    at: 0,
    threads: null,
    projections: new Map(),
    rolloutById: null,
    cwdById: null,
    knownIds: null,
    capabilities: null,
    walFrames: 0,
    walReason: 'not-read',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List threads from the desktop app's store.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.includeArchived=false] - Include archived threads.
 * @param {boolean} [opts.includeSpawnChildren=false] - Include threads that are
 *   the child end of a spawn edge, that is, agent fan-outs the user never
 *   opened directly.
 * @param {boolean} [opts.includeHidden=false] - Include threads with an empty
 *   preview, which the app's own partial indexes treat as not visible.
 * @param {string} [opts.hostId='local'] - Host namespace for project ids.
 * @param {boolean} [opts.force=false] - Bypass the warm cache.
 * @returns {Promise<Array<object>|null>} Thread records, or null when the store
 *   is unavailable for ANY reason. Null means "use the walk".
 */
async function listThreads(opts) {
  const options = opts || {};
  const includeArchived = options.includeArchived === true;
  const includeSpawnChildren = options.includeSpawnChildren === true;
  const includeHidden = options.includeHidden === true;
  const hostId = typeof options.hostId === 'string' && options.hostId ? options.hostId : undefined;
  const force = options.force === true;

  // The cache is keyed by projection, not restricted to one.
  //
  // It used to serve only the default projection, which looked harmless until
  // discovery started asking for archived threads by default: every discovery
  // then missed the cache and paid a full 78ms read. A caller must never be
  // handed rows computed for a different projection, so the projection is part
  // of the key rather than something the cache hopes about.
  const isDefaultProjection = !includeArchived && !includeSpawnChildren && !includeHidden;
  const projectionKey =
    'a' + (includeArchived ? 1 : 0) +
    's' + (includeSpawnChildren ? 1 : 0) +
    'h' + (includeHidden ? 1 : 0) +
    '|' + (hostId || '');

  if (!force) {
    const entry = _cache.projections.get(projectionKey);
    if (entry) {
      const fresh = Date.now() - entry.at < CACHE_TTL_MS;
      if (fresh || _cache.key === currentCacheKey()) return entry.rows;
    }
  }

  if (!isAvailable()) return null;

  const catalogTitles = await readCatalogTitles();

  const result = await withDatabase(getStateDbPath(), (db, meta) => {
    const tables = probeTables(db);
    if (!tables.has('threads')) return null;
    const columns = probeColumns(db, 'threads');
    const spawnColumns = tables.has('thread_spawn_edges')
      ? probeColumns(db, 'thread_spawn_edges')
      : new Set();

    const query = buildThreadQuery(columns, tables, spawnColumns, {
      includeArchived: includeArchived,
      includeSpawnChildren: includeSpawnChildren,
      includeHidden: includeHidden,
    });
    if (!query) return null;

    const rows = selectRows(db, query.sql);
    const threads = [];
    for (const row of rows) {
      const mapped = mapThreadRow(row, catalogTitles, hostId);
      if (mapped) threads.push(mapped);
    }

    // Census of EVERY thread the store knows about, visible or not, taken in
    // the SAME snapshot so it costs one extra cheap query rather than a second
    // 24 MB read.
    //
    // Two consumers, both of which need the full set rather than the visible
    // projection:
    //
    //   - Discovery needs the id set to tell two very different situations
    //     apart: "the store knows this thread and deliberately excluded it",
    //     which is an authoritative verdict, versus "the store has never heard
    //     of this thread", which is the case the walk exists to cover.
    //   - findArtifactPath needs the rollout map to be O(1) for ANY thread id,
    //     including archived threads and spawn children. Restricting it to the
    //     visible projection would silently push those back onto the O(n) walk,
    //     which measured 330ms per lookup.
    const knownIds = new Set();
    const censusRollouts = new Map();
    const censusCwds = new Map();
    const censusColumns = ['id'];
    if (columns.has('rollout_path')) censusColumns.push('rollout_path');
    if (columns.has('cwd')) censusColumns.push('cwd');
    for (const row of selectRows(db, 'SELECT ' + censusColumns.join(', ') + ' FROM threads')) {
      const id = toStringOrNull(row.id);
      if (!id) continue;
      const idLower = id.toLowerCase();
      knownIds.add(idLower);
      const rollout = toStringOrNull(row.rollout_path);
      if (rollout) censusRollouts.set(idLower, normalizeCodexPath(rollout));
      const cwd = toStringOrNull(row.cwd);
      if (cwd) censusCwds.set(idLower, normalizeCodexPath(cwd));
    }

    return {
      threads: threads,
      knownIds: knownIds,
      rolloutById: censusRollouts,
      cwdById: censusCwds,
      capabilities: query.capabilities,
      meta: meta,
    };
  });

  if (!result || !Array.isArray(result.threads)) return null;

  // The census is projection-independent, so it is refreshed on EVERY
  // successful read. The row list is projection-specific and is stored under
  // its own key. A content-key change invalidates every projection at once,
  // because they were all computed from the same snapshot.
  const key = currentCacheKey();
  if (_cache.key !== key) _cache.projections = new Map();
  _cache.key = key;
  _cache.at = Date.now();
  _cache.rolloutById = result.rolloutById instanceof Map ? result.rolloutById : _cache.rolloutById;
  _cache.cwdById = result.cwdById instanceof Map ? result.cwdById : _cache.cwdById;
  _cache.knownIds = result.knownIds instanceof Set ? result.knownIds : _cache.knownIds;
  _cache.capabilities = result.capabilities;
  _cache.walFrames = result.meta ? result.meta.walFrames : 0;
  _cache.walReason = result.meta ? result.meta.walReason : 'unknown';
  _cache.projections.set(projectionKey, { at: Date.now(), rows: result.threads });
  if (isDefaultProjection) _cache.threads = result.threads;

  return result.threads;
}

/**
 * Resolve a thread's rollout transcript path, asynchronously and exactly.
 *
 * This is the O(1) replacement for the O(n) filesystem walk that
 * findArtifactPath performs today, once per call, across 796 files. It also
 * recovers threads whose rollout lives outside CODEX_HOME entirely: two threads
 * on the measured machine sit under `D:\CodexArchive`, which the walk can never
 * reach because it only ever looks under `$CODEX_HOME`.
 *
 * The path is resolved at read time from the thread id, never stored. A stored
 * absolute path would be meaningless on another machine, which matters because
 * workbook state is synced between the PC and the Mac Mini.
 *
 * Looks across ALL threads including archived and spawn children, because the
 * question "where is this transcript" is independent of whether the thread
 * belongs in the sidebar.
 *
 * @param {string} threadId
 * @returns {Promise<string|null>} Absolute path that exists on disk, or null.
 */
async function resolveRolloutPath(threadId) {
  const id = toStringOrNull(threadId);
  if (!id) return null;
  const idLower = id.toLowerCase();

  const cached = resolveRolloutPathSync(idLower);
  if (cached) return cached;

  if (!isAvailable()) return null;
  const found = await withDatabase(getStateDbPath(), (db) => {
    const tables = probeTables(db);
    if (!tables.has('threads')) return null;
    const columns = probeColumns(db, 'threads');
    if (!columns.has('rollout_path') || !columns.has('id')) return null;
    const rows = selectRows(
      db,
      'SELECT rollout_path FROM threads WHERE lower(id) = ? LIMIT 1',
      [idLower]
    );
    if (!rows.length) return null;
    return toStringOrNull(rows[0].rollout_path);
  });

  if (!found) return null;
  const normalized = normalizeCodexPath(found);
  if (!normalized) return null;
  try {
    return fs.existsSync(normalized) ? normalized : null;
  } catch (_) {
    return null;
  }
}

/**
 * Synchronous rollout-path lookup, answered from the warm cache only.
 *
 * findArtifactPath is called synchronously by server route handlers, so it
 * cannot await. This gives it an O(1) answer whenever discovery has run
 * recently, and null otherwise, at which point the caller does what it has
 * always done and walks. Never triggers IO beyond one existence check.
 *
 * @param {string} threadId
 * @returns {string|null}
 */
function resolveRolloutPathSync(threadId) {
  const id = toStringOrNull(threadId);
  if (!id || !_cache.rolloutById) return null;
  const candidate = _cache.rolloutById.get(id.toLowerCase());
  if (!candidate) return null;
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch (_) {
    return null;
  }
}

/**
 * Spawn edges for one parent thread, or for the whole graph when no parent is
 * given.
 *
 * Codex has a real spawn graph, 2874 edges on the measured machine, alongside
 * `agent_nickname` and `agent_role`. That is richer than Claude's Task-block
 * inference and is the foundation for a genuine subagent view later.
 *
 * @param {string} [parentThreadId] - Optional filter.
 * @returns {Promise<Array<{parentThreadId:string, childThreadId:string, status:(string|null)}>|null>}
 */
async function listSpawnEdges(parentThreadId) {
  if (!isAvailable()) return null;
  const parent = toStringOrNull(parentThreadId);
  return withDatabase(getStateDbPath(), (db) => {
    const tables = probeTables(db);
    if (!tables.has('thread_spawn_edges')) return null;
    const columns = probeColumns(db, 'thread_spawn_edges');
    if (!columns.has('parent_thread_id') || !columns.has('child_thread_id')) return null;
    const selected = ['parent_thread_id', 'child_thread_id'];
    if (columns.has('status')) selected.push('status');
    const sql =
      'SELECT ' +
      selected.join(', ') +
      ' FROM thread_spawn_edges' +
      (parent ? ' WHERE lower(parent_thread_id) = ?' : '');
    const rows = parent ? selectRows(db, sql, [parent.toLowerCase()]) : selectRows(db, sql);
    return rows
      .map((row) => ({
        parentThreadId: (toStringOrNull(row.parent_thread_id) || '').toLowerCase() || null,
        childThreadId: (toStringOrNull(row.child_thread_id) || '').toLowerCase() || null,
        status: columns.has('status') ? toStringOrNull(row.status) : null,
      }))
      .filter((e) => e.parentThreadId && e.childThreadId);
  });
}

/**
 * Resolve one thread's display title through the cascade.
 *
 * Steps that are O(1) from the database run here. Step 5 of the cascade, the
 * `thread_name_updated` event inside the rollout, is a file scan and is
 * therefore NOT performed: it exists in 2 of 796 files, so paying a scan for
 * every row to recover two titles is the wrong trade. Callers that want it pass
 * the value in through `extras.rolloutTitle` after doing the scan lazily, on
 * demand, only for rows still unresolved.
 *
 * @param {string} threadId
 * @param {Object} [extras] - Additional cascade inputs, notably `indexTitle`
 *   from session_index.jsonl and `rolloutTitle` from a lazy scan.
 * @returns {Promise<{title: string, source: string}|null>}
 */
async function getDisplayTitle(threadId, extras) {
  const id = toStringOrNull(threadId);
  if (!id) return null;
  const threads = await listThreads({ includeArchived: true, includeSpawnChildren: true, includeHidden: true });
  if (!threads) return null;
  const idLower = id.toLowerCase();
  const found = threads.find((t) => t.id === idLower);
  if (!found) return null;
  return resolveTitle(Object.assign({}, found.titleParts, extras || {}));
}

/**
 * Every thread id the store knows about, visible or not.
 *
 * Discovery unions the SQLite view with the filesystem walk, and this set is
 * what makes that union principled rather than additive-by-accident. A walk
 * result whose id appears here was seen by the store and deliberately left out
 * of the visible set, which is an authoritative verdict from the app's own
 * model. A walk result whose id does NOT appear here is a thread the store has
 * never recorded, and the walk is the only source that can surface it.
 *
 * Populated as a by-product of listThreads, so it costs one cheap query inside
 * an existing snapshot rather than a second read of the whole database.
 *
 * @returns {Promise<Set<string>|null>} Lowercased ids, or null when the store
 *   is unavailable.
 */
async function getKnownThreadIds() {
  if (_cache.knownIds) return _cache.knownIds;
  const listed = await listThreads();
  if (!listed) return null;
  return _cache.knownIds || null;
}

/**
 * Synchronous form of getKnownThreadIds, answered from the warm cache only.
 *
 * @param {string} threadId
 * @returns {boolean} True only when the cache is warm AND it contains the id.
 *   A cold cache answers false, which correctly means "no authoritative verdict
 *   available, treat the walk as truth".
 */
function isKnownThreadSync(threadId) {
  const id = toStringOrNull(threadId);
  if (!id || !_cache.knownIds) return false;
  return _cache.knownIds.has(id.toLowerCase());
}

/**
 * Working directory for one thread, answered from the warm cache only.
 * Used by the spawn path to give a Codex pane the right cwd without an await.
 *
 * @param {string} threadId
 * @returns {string|null}
 */
function resolveCwdSync(threadId) {
  const id = toStringOrNull(threadId);
  if (!id || !_cache.cwdById) return null;
  return _cache.cwdById.get(id.toLowerCase()) || null;
}

/**
 * Diagnostics for logging and for the state-db tests. Deliberately carries no
 * user content: counts, flags and reason tags only.
 *
 * @returns {object}
 */
function getDiagnostics() {
  return {
    available: isAvailable(),
    stateDbPath: getStateDbPath(),
    engineLoaded: _enginePromise !== null,
    engineError: _engineError,
    cachedThreadCount: _cache.threads ? _cache.threads.length : 0,
    knownThreadCount: _cache.knownIds ? _cache.knownIds.size : 0,
    cacheAgeMs: _cache.at ? Date.now() - _cache.at : null,
    capabilities: _cache.capabilities,
    walFrames: _cache.walFrames,
    walReason: _cache.walReason,
  };
}

module.exports = {
  // Availability and lifecycle
  isAvailable,
  isEnabled,
  invalidate,
  getDiagnostics,

  // Reads
  listThreads,
  getKnownThreadIds,
  isKnownThreadSync,
  resolveRolloutPath,
  resolveRolloutPathSync,
  resolveCwdSync,
  listSpawnEdges,
  getDisplayTitle,

  // Title cascade, pure and independently testable
  resolveTitle,
  truncatePreview,
  TITLE_SOURCES,

  // Paths
  getCodexHome,
  getStateDbPath,
  getDevDbPath,

  // Constants callers should reference rather than re-type
  STATE_DB_FILENAME,
  DEV_DB_RELATIVE_PATH,
  PERMITTED_DATABASE_FILENAMES,
  MAX_DATABASE_BYTES,
  CACHE_TTL_MS,
  PREVIEW_TITLE_MAX_CHARS,
  TITLE_SELECT_MAX_CHARS,
  PREVIEW_SELECT_MAX_CHARS,
  UNTITLED_LABEL,
  WANTED_THREAD_COLUMNS,
  STATE_DB_ENABLED_ENV,

  /**
   * Test introspection surface. Mirrors the `_internal` pattern parse.js and
   * discover.js already use. Not part of the provider contract.
   */
  _internal: {
    applyWalOverlay,
    walChecksum,
    readDbPageSize,
    snapshotDatabase,
    assertPermittedDatabase,
    buildThreadQuery,
    probeColumns,
    probeTables,
    selectRows,
    mapThreadRow,
    withDatabase,
    loadEngine,
    currentCacheKey,
    toNumberOrNull,
    toStringOrNull,
  },
};
