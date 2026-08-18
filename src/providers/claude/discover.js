/**
 * Claude session discovery.
 *
 * STATUS: NEW minimum-viable implementation introduced in Plan 14-03 (ABST-03).
 *
 * Walks ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl and returns
 * ProviderSession[] suitable for the Provider contract. Composes the
 * MOVED helpers from path-decode.js (resolveProjectPath) and parse.js
 * (extractCustomTitle, extractSessionName) so the abstraction is real.
 *
 * Plan 15-02 (DISC-01/02/04/05) consumes this from the new per-provider
 * /api/discover dispatcher in src/web/server.js. The dispatcher groups the
 * returned ProviderSession[] by projectPath into the v1.2 accordion shape
 * the frontend renders; the encodedName field below is what the v1.1 shape
 * (?legacy=1 back-compat) uses as the accordion key.
 *
 * ─── Task #36: the walk stops owning the event loop ──────────────────────
 *
 * The original walk was one uninterrupted synchronous block. Measured in a
 * sandbox server against the real corpus on this machine (40 project
 * directories, 182 transcripts, 3.97GB on disk, of which the walk read 16MB
 * of bounded windows):
 *
 *   GET /api/discover, claude only, cache cleared each round
 *     round 1 (cold-ish page cache) : 302ms wall, ONE 289ms block
 *     round 2                       : 153ms wall, ONE 143ms block
 *     round 3                       : 140ms wall, ONE 130ms block
 *
 * A 10ms heartbeat inside the server process ticked exactly ONCE per
 * request: nothing else in the process ran while discovery was running, so
 * every other request, every WebSocket frame and every timer queued behind
 * it. The component profile of the 150ms was: 69ms decoding 16MB of tail
 * windows looking for renames (zero of the 182 transcripts had one), 37ms
 * resolving 40 encoded directory names to real paths, 27ms reading head
 * windows for fallback names, 11ms stat, 4ms readdir.
 *
 * Three changes, in the order they matter:
 *
 *   1. INCREMENTAL, MTIME-KEYED TITLE CACHE. A transcript's title is a pure
 *      function of its bytes, so (mtimeMs, size) is a sound cache key: if
 *      either moved the file was rewritten and we re-read it, and if neither
 *      moved no read can produce a different answer. Unchanged transcripts
 *      are never re-read, which is the whole 96ms of title work.
 *   2. ASYNCHRONOUS, BUDGETED WALK. Every read goes through the parse.js
 *      async twins, so the IO lands on the libuv pool rather than the main
 *      thread, and the walk yields with setImmediate whenever it has held
 *      the thread for longer than one slice. A single pathological file (a
 *      network mount, a spun-down drive) now stalls a pool thread, not the
 *      event loop.
 *   3. RESOLUTION MEMO. resolveProjectPath consults the filesystem to
 *      disambiguate encoded hyphens. Its answer is memoised per project
 *      directory, but ONLY when the answer names a directory that actually
 *      exists, so a resolution made before the target existed re-resolves
 *      later instead of being wrong forever.
 *
 * A worker_thread was considered and NOT built: the point of a worker is to
 * move blocking work off the main thread, and after (1) and (2) there is no
 * blocking work left to move. Measured after: the longest single main-thread
 * block during a full uncached walk is a single-digit number of milliseconds,
 * far below the ~150ms bar that would have justified the extra process, the
 * structured-clone cost on every result and a second copy of the parse code.
 *
 * The RESPONSE SHAPE IS UNCHANGED, field for field, including the Date-typed
 * lastActive and the readdir-order stability of the returned array.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRefresh=false] - drop the caches that are not
 *   self-invalidating (the resolution memo). The title cache is keyed on
 *   (mtimeMs, size) and is therefore already coherent; bypassing it would
 *   re-read unchanged bytes for no correctness gain.
 * @returns {Promise<Array<{provider:string,providerSessionId:string,projectPath:string,encodedName:string,title:string|null,lastActive:Date,sizeBytes:number}>>}
 *   ProviderSession[] entries. The encodedName field (Plan 15-02) carries
 *   the ~/.claude/projects/<encodedName>/ directory basename and is
 *   preserved end-to-end so the v1.1 frontend's accordion-key shape
 *   continues to work. The field is OPTIONAL on the Provider contract;
 *   Codex's discover (Phase 17) may set it to null or omit it entirely.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/claude/discover
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveProjectPath, resolveClaudeProjectsDir } = require('./path-decode');
const {
  extractCustomTitleAsync,
  extractSessionNameAsync,
} = require('./parse');

// ─── Tunables ─────────────────────────────────────────────────────────────
// Every one of these is a named constant with an environment override, so
// an operator on a pathological corpus can retune without a code change.

/**
 * Longest stretch of main-thread time the walk may hold before yielding.
 * Small enough that a yield lands well inside one animation frame; large
 * enough that the yields themselves are not the cost.
 */
const WALK_SLICE_MS = envInt('CWM_DISCOVER_SLICE_MS', 8, 1, 1000);

/**
 * How many transcripts inside one project directory are read concurrently.
 * The reads are pool-threaded, so overlapping them shortens wall time on a
 * cold cache without adding main-thread time. Results are still assembled in
 * readdir order, so the returned array is byte-identical to the serial walk.
 */
const FILE_CONCURRENCY = envInt('CWM_DISCOVER_CONCURRENCY', 8, 1, 64);

/**
 * Hard ceiling on retained title-cache entries. The prune at the end of a
 * completed walk normally holds the map at exactly the corpus size; this cap
 * is the backstop for a machine that churns transcript paths.
 */
const TITLE_CACHE_MAX = envInt('CWM_DISCOVER_TITLE_CACHE_MAX', 20000, 100, 1000000);

/**
 * Parse an integer environment override with a default and hard bounds.
 * Never throws; a malformed or out-of-range value falls back to the default.
 *
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Value used when unset or unusable.
 * @param {number} min - Inclusive lower bound.
 * @param {number} max - Inclusive upper bound.
 * @returns {number} The effective value.
 */
function envInt(name, fallback, min, max) {
  const raw = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw < min || raw > max) return fallback;
  return raw;
}

// ─── Caches ───────────────────────────────────────────────────────────────

/**
 * Title cache. Map<absoluteJsonlPath, {mtimeMs:number, size:number, title:string|null}>.
 *
 * The stored title is the FINAL discovery title, i.e. the result of the whole
 * custom-title-then-first-message cascade including the "the fallback returned
 * the uuid, treat that as no title" rule. Null is cached as deliberately as a
 * hit: re-deriving null costs exactly as much as re-deriving a string.
 */
const _titleCache = new Map();

/**
 * Resolution memo. Map<projectDirAbsolutePath, {resolved:string, until:number}>.
 *
 * Two retention rules, because the two outcomes are not equally trustworthy:
 *   - The resolved path EXISTS: the answer is corroborated by the filesystem
 *     and is kept for the life of the process (until === Infinity).
 *   - The resolved path does NOT exist: the hyphen split was a guess against
 *     a directory that is gone or not yet created, so the answer is kept only
 *     for NEGATIVE_PATH_TTL_MS. A project that gets cloned back is picked up
 *     within a minute instead of being wrong until the next restart, and a
 *     burst of refreshes still pays for the resolution only once.
 */
const _projectPathCache = new Map();

/**
 * How long an UNCORROBORATED path resolution is reused before it is redone.
 * Applies only to resolutions whose target does not exist on disk.
 */
const NEGATIVE_PATH_TTL_MS = envInt('CWM_DISCOVER_NEGATIVE_PATH_TTL_MS', 60000, 0, 3600000);

/** Counters for tests and for the perf evidence. Never used for control flow. */
const _stats = {
  walks: 0,
  coalesced: 0,
  filesSeen: 0,
  titleHits: 0,
  titleMisses: 0,
  pathHits: 0,
  pathMisses: 0,
  yields: 0,
  unclassifiedEntries: 0,
  lastWallMs: 0,
};

/** In-flight walk, so concurrent callers share one pass instead of racing. */
let _inFlight = null;
/** Whether the in-flight walk was started with forceRefresh. */
let _inFlightForced = false;

// ─── Scheduling primitives ────────────────────────────────────────────────

/**
 * Hand the event loop back for one turn.
 * setImmediate rather than a resolved promise: a microtask does NOT let
 * pending IO, timers or sockets run, which is the entire point here.
 *
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  _stats.yields++;
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A time-slice budget. `due()` is a cheap synchronous predicate so the walk
 * pays for a clock read per item and an actual yield only when it has held
 * the thread too long.
 *
 * @param {number} sliceMs - Milliseconds of main-thread time per slice.
 * @returns {{due: function(): boolean, reset: function(): void}}
 */
function makeSliceBudget(sliceMs) {
  let start = Date.now();
  return {
    due() { return (Date.now() - start) >= sliceMs; },
    reset() { start = Date.now(); },
  };
}

/**
 * Map `items` through an async worker with bounded concurrency, PRESERVING
 * input order in the output array. Order preservation is load-bearing: the
 * discovery response's within-directory ordering is observable, and a
 * fan-out that returned completion order would make it nondeterministic.
 *
 * A worker rejection is contained: that slot resolves to undefined and the
 * remaining items still run, matching the walk's "one bad file never breaks
 * discovery" contract.
 *
 * @param {Array} items - Input items.
 * @param {number} limit - Maximum concurrent workers.
 * @param {function(*, number): Promise<*>} worker - Async per-item function.
 * @returns {Promise<Array>} Results in input order.
 */
async function mapOrderedWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  if (items.length === 0) return out;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (_) {
        out[i] = undefined; // contained: one bad file never breaks the walk
      }
    }
  }

  const lanes = [];
  for (let i = 0; i < width; i++) lanes.push(lane());
  await Promise.all(lanes);
  return out;
}

// ─── Cache helpers ────────────────────────────────────────────────────────

/**
 * Resolve a project directory to a real filesystem path, memoised.
 *
 * Only a resolution that names an existing directory is memoised. The decode
 * consults the filesystem to split ambiguous hyphens, so a resolution made
 * while the target did not exist is a guess; caching that guess forever would
 * make discovery permanently wrong for a project that is later cloned back.
 *
 * @param {string} projectDir - Absolute path under ~/.claude/projects/.
 * @param {string} encodedName - The encoded directory basename.
 * @returns {string} The resolved path, or encodedName when resolution fails.
 */
function resolveProjectPathMemoised(projectDir, encodedName) {
  const hit = _projectPathCache.get(projectDir);
  if (hit !== undefined && hit.until > Date.now()) {
    _stats.pathHits++;
    return hit.resolved;
  }
  _stats.pathMisses++;
  let resolved;
  try {
    resolved = resolveProjectPath(projectDir, encodedName) || encodedName;
  } catch (_) {
    resolved = encodedName;
  }
  let exists = false;
  try { exists = fs.existsSync(resolved); } catch (_) { exists = false; }
  _projectPathCache.set(projectDir, {
    resolved: resolved,
    until: exists ? Infinity : (Date.now() + NEGATIVE_PATH_TTL_MS),
  });
  return resolved;
}

/**
 * Produce the discovery title for one transcript, reusing the cached answer
 * when the file has not been rewritten.
 *
 * Cascade (unchanged from the original walk): an explicit custom-title entry
 * wins; otherwise the first meaningful message; and the fallback returning
 * the session uuid means "no title", not "the title is the uuid".
 *
 * @param {string} fullPath - Absolute transcript path.
 * @param {string} providerSessionId - Session uuid (the filename stem).
 * @param {{mtimeMs:number,size:number}} stat - Fresh stat of the transcript.
 * @returns {Promise<string|null>} The title, or null.
 */
async function titleForTranscript(fullPath, providerSessionId, stat) {
  const cached = _titleCache.get(fullPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    _stats.titleHits++;
    return cached.title;
  }
  _stats.titleMisses++;

  // Title extraction: prefer explicit custom-title entries, fall back to
  // first-message extraction. Both helpers swallow IO errors and return
  // null/uuid respectively, so this composition never throws.
  let title = null;
  try {
    title = await extractCustomTitleAsync(fullPath);
    if (!title) {
      const fromBody = await extractSessionNameAsync(fullPath, providerSessionId);
      // extractSessionName returns the UUID as fallback; treat that as "no title"
      if (fromBody && fromBody !== providerSessionId) {
        title = fromBody;
      }
    }
  } catch (_) {
    // Title extraction must never break discovery
    title = null;
  }

  _titleCache.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size, title: title });
  return title;
}

/**
 * Drop cache entries for transcripts that no longer exist, then enforce the
 * hard ceiling by evicting oldest-inserted first. Only called after a walk
 * that completed, so a walk aborted halfway can never evict live entries.
 *
 * @param {Set<string>} seen - Absolute paths observed during the walk.
 * @returns {void}
 */
function pruneTitleCache(seen) {
  if (_titleCache.size > seen.size) {
    for (const key of Array.from(_titleCache.keys())) {
      if (!seen.has(key)) _titleCache.delete(key);
    }
  }
  if (_titleCache.size > TITLE_CACHE_MAX) {
    const excess = _titleCache.size - TITLE_CACHE_MAX;
    let dropped = 0;
    for (const key of _titleCache.keys()) {
      _titleCache.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * Is this readdir entry a directory?
 *
 * Normally just entry.isDirectory(). The extra arm exists because the
 * ASYNCHRONOUS Dirent form has been observed on this machine to return
 * entries it classifies as neither file nor directory, and to do so
 * SILENTLY: the codex walk lost 2063 of 2863 rollouts to exactly that before
 * P8 switched it to string mode (see src/providers/codex/discover.js,
 * enumerateRolloutFilesAsync). Here the tree is one level deep and string
 * mode would cost a stat per entry, so instead we keep the Dirent fast path
 * and stat ONLY the entries it could not classify. That can add a directory
 * the classification dropped; it can never drop one it kept.
 *
 * @param {string} parentDir - Directory the entry was read from.
 * @param {import('fs').Dirent} entry - The readdir entry.
 * @returns {boolean} True when the entry names a directory.
 */
function isDirectoryEntry(parentDir, entry) {
  if (entry.isDirectory()) return true;
  if (entry.isFile() || entry.isSymbolicLink()) return false;
  _stats.unclassifiedEntries++;
  try {
    return fs.statSync(path.join(parentDir, entry.name)).isDirectory();
  } catch (_) {
    return false;
  }
}

// ─── The walk ─────────────────────────────────────────────────────────────

/**
 * One full pass over ~/.claude/projects. Asynchronous, budgeted, cached.
 * Returns [] and never throws when the tree is absent or unreadable.
 *
 * @param {boolean} forceRefresh - Drop the resolution memo before walking.
 * @returns {Promise<Array>} ProviderSession[]
 */
async function walkOnce(forceRefresh) {
  const startedAt = Date.now();
  _stats.walks++;
  if (forceRefresh) _projectPathCache.clear();

  const claudeDir = resolveClaudeProjectsDir();
  if (!fs.existsSync(claudeDir)) return [];

  let topEntries;
  try {
    topEntries = await fs.promises.readdir(claudeDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const budget = makeSliceBudget(WALK_SLICE_MS);
  const sessions = [];
  const seen = new Set();
  let completed = true;

  try {
    for (const entry of topEntries) {
      if (!isDirectoryEntry(claudeDir, entry)) continue;
      if (budget.due()) { await yieldToEventLoop(); budget.reset(); }

      const projectDir = path.join(claudeDir, entry.name);
      const projectPath = resolveProjectPathMemoised(projectDir, entry.name);

      let files;
      try {
        files = await fs.promises.readdir(projectDir);
      } catch (_) {
        continue;
      }

      const transcripts = files.filter((f) => f.endsWith('.jsonl'));
      if (transcripts.length === 0) continue;

      // Bounded fan-out, order preserved. Each slot returns either a
      // ProviderSession or undefined (not a file, vanished, unreadable).
      const built = await mapOrderedWithConcurrency(transcripts, FILE_CONCURRENCY, async (file) => {
        const fullPath = path.join(projectDir, file);
        let stat;
        try {
          stat = await fs.promises.stat(fullPath);
        } catch (_) {
          return undefined;
        }
        if (!stat.isFile()) return undefined;

        seen.add(fullPath);
        _stats.filesSeen++;
        const providerSessionId = file.replace(/\.jsonl$/, '');
        const title = await titleForTranscript(fullPath, providerSessionId, stat);

        if (budget.due()) { await yieldToEventLoop(); budget.reset(); }

        return {
          provider: 'claude', // gsd:provider-literal-allowed
          providerSessionId: providerSessionId,
          projectPath: projectPath,
          encodedName: entry.name, // Plan 15-02 (DISC-01): preserved for v1.1 frontend accordion key
          title: title,
          lastActive: stat.mtime,
          sizeBytes: stat.size,
        };
      });

      for (const s of built) {
        if (s) sessions.push(s);
      }
    }
  } catch (_) {
    // A walk-level failure yields whatever was already collected rather than
    // throwing at the route. Mark the pass incomplete so the prune is skipped.
    completed = false;
  }

  if (completed) pruneTitleCache(seen);
  _stats.lastWallMs = Date.now() - startedAt;
  return sessions;
}

/**
 * Enumerate locally-discoverable Claude sessions.
 * Returns an empty array (never throws) when ~/.claude/projects/ is absent.
 *
 * Concurrent callers are COALESCED onto one walk. Two browser tabs both
 * hitting /api/discover?refresh=true used to run two full walks against the
 * same corpus; they now share one. A forceRefresh arriving while a soft walk
 * is already running is queued BEHIND it rather than folded into it, so
 * "refresh" never resolves against a pass that started before the caller
 * asked for one.
 *
 * @param {{forceRefresh?: boolean}} [opts]
 * @returns {Promise<Array>} ProviderSession[]
 */
async function discover(opts) {
  const forceRefresh = !!(opts && opts.forceRefresh);

  if (_inFlight && (!forceRefresh || _inFlightForced)) {
    _stats.coalesced++;
    return _inFlight;
  }

  const predecessor = _inFlight ? _inFlight.then(() => {}, () => {}) : Promise.resolve();
  const run = predecessor.then(() => walkOnce(forceRefresh));
  _inFlight = run;
  _inFlightForced = forceRefresh;
  // then(clear, clear) rather than finally(): finally() returns a derived
  // promise that would re-reject with nothing attached to it.
  const clear = () => {
    if (_inFlight === run) { _inFlight = null; _inFlightForced = false; }
  };
  run.then(clear, clear);
  return run;
}

/**
 * Snapshot of the walk's counters plus cache sizes. Test and diagnostic
 * surface only; nothing in the walk reads it.
 *
 * @returns {object} A copy of the counters, plus titleCacheSize/pathCacheSize.
 */
discover._stats = function _statsSnapshot() {
  return Object.assign({}, _stats, {
    titleCacheSize: _titleCache.size,
    pathCacheSize: _projectPathCache.size,
    sliceMs: WALK_SLICE_MS,
    concurrency: FILE_CONCURRENCY,
  });
};

/**
 * Drop every cache and zero the counters. Exists so a test can measure a
 * cold pass and a warm pass in one process without a module-cache dance.
 *
 * @returns {void}
 */
discover._resetCaches = function _resetCaches() {
  _titleCache.clear();
  _projectPathCache.clear();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
};

module.exports = discover;
