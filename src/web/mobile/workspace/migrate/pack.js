/**
 * migrate/pack.js: the migration pack (R08 sections 4.2 to 4.8): the
 * snapshot of the source, the deterministic index built in a worker thread
 * (and reused for the same snapshot), the reading plan by tier, and the
 * pack folder the takeover reads: index files, standards/, git.md,
 * FOCUS.md, ranges.json, READER.md, the charter (CHARTER.md, START.md) and
 * the raw access helpers in tools/.
 *
 * WHY: deterministic first, model second (R08 section 4.1). Everything that
 * can be computed without a model is computed here, in about a minute for
 * the largest history, so the new session reads the history as evidence
 * instead of raw bytes. The index is keyed by the source path, the snapshot
 * length, head and tail hashes and the indexer version, so a preview starts
 * it in the background and the start reuses it (R08:512). The pack lives
 * under <dataDir>/migrations/<migrationId>/, outside every repository, and
 * never holds credentials.md or an unredacted secret (R08 section 4.7).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { redact } = require('./redact');
const charter = require('./charter');
const { INDEXER_VERSION } = require('./indexer-worker');

/** Bytes hashed at the head and at the tail of the snapshot (R08 section 4.2). */
const HASH_WINDOW_BYTES = 1024 * 1024;
/** Tier rules (R08 section 4.4): S reads it all up to a quarter of the context. */
const TIER_S_SHARE = 0.25;
/** Tier M holds up to 40 ranges of about 80K tokens. */
const TIER_M_RANGES = 40;
const RANGE_TOKENS = 80000;
/** Readers at a time (R08 section 4.5). */
const MAX_READERS = 6;
/** Tier L ranges join this many chunks. */
const TIER_L_CHUNKS_PER_RANGE = 2;
/** Tier L era size in ranges (R08 section 4.4: synthesizers per about 10 reports). */
const ERA_RANGES = 10;
/** Estimate factors (R08 section 9.2). */
const READER_OVERHEAD = 1.3;
const M_READER_TOKENS = 85000;
const L_READER_TOKENS = 48000;
const M_LEAD_TOKENS = 400000;
const L_LEAD_TOKENS = 650000;
const L_ERA_TOKENS = 300000;
const S_ORIENTATION_TOKENS = 20000;
const REPORT_TOKENS_PER_RANGE = 3000;
const ESTIMATE_LOW = 0.85;
const ESTIMATE_HIGH = 1.15;
/** Rough L2 share of raw bytes before the index exists (R08 section 4.3 measured 1.5 to 2.5 percent on large files). */
const L2_SHARE_LARGE = 0.03;
const L2_SHARE_SMALL = 0.4;
const SMALL_SOURCE_BYTES = 1024 * 1024;
/** Arthur's per action rule for API billing (R08:585). */
const COST_CONFIRM_USD = 100;
/** Git calls are short; each has this timeout. */
const GIT_TIMEOUT_MS = 5000;
/** Git log lines kept in git.md. */
const GIT_LOG_LINES = 30;
/** How far above the working directory standards are searched. */
const STANDARDS_MAX_DEPTH = 12;
/** List prices per million tokens, input and output (R08 section 3). */
const PRICES = Object.freeze({
  'claude-fable-5-1': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5], 'claude-opus-5': [5, 25],
  'gpt-6-astra': [10, 50], 'gpt-5.6-sol': [4, 20],
});
/** The price used when a model's price is not known. */
const DEFAULT_PRICE = Object.freeze({ claude: [4, 20], codex: [10, 50] }); // gsd:provider-literal-allowed (mobile v2 migration pack)
/** The reader model for a Claude lead (R08 decision D3). */
const CLAUDE_READER_MODEL = 'claude-sonnet-5';
/** Index cache folder under <dataDir>/migrations/. */
const INDEX_CACHE_DIR = 'index-cache';

/** key -> {state, promise, manifest, error} for index builds in this process */
const builds = new Map();

/**
 * SHA-256 of a byte range of a file.
 *
 * @param {number} fd - Open file.
 * @param {number} start - Offset.
 * @param {number} length - Bytes.
 * @returns {string}
 */
function hashRange(fd, start, length) {
  const h = crypto.createHash('sha256');
  const buf = Buffer.alloc(Math.max(0, length));
  if (length > 0) fs.readSync(fd, buf, 0, length, start);
  h.update(buf);
  return h.digest('hex');
}

/**
 * Snapshot a source transcript: its length at this instant (or the cut),
 * and SHA-256 of the first and last MiB within that length (R08 4.2).
 *
 * @param {string} file - Transcript.
 * @param {number|null} cut - End offset for a fromMessageId start, else null.
 * @returns {{path: string, bytes: number, mtimeMs: number, headSha: string, tailSha: string}}
 */
function snapshotSource(file, cut) {
  const st = fs.statSync(file);
  const bytes = Number.isInteger(cut) && cut >= 0 ? Math.min(cut, st.size) : st.size;
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(HASH_WINDOW_BYTES, bytes);
    const tailLen = Math.min(HASH_WINDOW_BYTES, bytes);
    return { path: file, bytes, mtimeMs: st.mtimeMs, headSha: hashRange(fd, 0, headLen), tailSha: hashRange(fd, bytes - tailLen, tailLen) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The index cache key of a snapshot (R08 section 4.8).
 *
 * @param {object} snap - snapshotSource().
 * @returns {string}
 */
function indexKey(snap) {
  return crypto.createHash('sha256').update([path.resolve(snap.path), snap.bytes, snap.headSha, snap.tailSha, INDEXER_VERSION].join('\n')).digest('hex').slice(0, 32);
}

/**
 * Start or reuse the index of a snapshot, in a worker thread.
 *
 * @param {object} o - {dataDir, provider, snap, onProgress, useWorker}
 * @returns {{key: string, state: string, promise: Promise<object>, dir: string}}
 */
function ensureIndex(o) {
  const key = indexKey(o.snap);
  const dir = path.join(o.dataDir, 'migrations', INDEX_CACHE_DIR, key);
  const cached = builds.get(key);
  if (cached && cached.state !== 'failed') return cached;
  const manifestFile = path.join(dir, 'index-manifest.json');
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const entry = { key, dir, state: 'ready', manifest, promise: Promise.resolve(manifest) };
      builds.set(key, entry);
      return entry;
    } catch (_) { /* rebuild below */ }
  }
  const tmp = dir + '.tmp-' + crypto.randomBytes(4).toString('hex');
  const entry = { key, dir, state: 'building', manifest: null, error: null, progress: { bytes: 0, total: o.snap.bytes } };
  entry.promise = runWorker({ provider: o.provider, source: o.snap.path, outDir: tmp, end: o.snap.bytes, onProgress: (p) => { entry.progress = p; if (o.onProgress) o.onProgress(p); } }, o.useWorker !== false)
    .then((manifest) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(tmp, dir);
      entry.state = 'ready';
      entry.manifest = manifest;
      return manifest;
    })
    .catch((err) => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      entry.state = 'failed';
      entry.error = err;
      throw err;
    });
  entry.promise.catch(() => {});
  builds.set(key, entry);
  return entry;
}

/**
 * Run the indexer in a worker thread (or inline when workers are off).
 *
 * @param {object} data - {provider, source, outDir, end, onProgress}
 * @param {boolean} useWorker - Worker thread (production) or inline.
 * @returns {Promise<object>} manifest
 */
function runWorker(data, useWorker) {
  if (!useWorker) {
    return require('./indexer-worker').runIndex(data);
  }
  return new Promise((resolve, reject) => {
    const { Worker } = require('worker_threads');
    const worker = new Worker(path.join(__dirname, 'indexer-worker.js'), {
      workerData: { __myrlinIndexer: true, provider: data.provider, source: data.source, outDir: data.outDir, end: data.end },
    });
    let settled = false;
    worker.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'progress' && data.onProgress) data.onProgress(m);
      else if (m.type === 'done') { settled = true; resolve(m.manifest); worker.terminate().catch(() => {}); }
      else if (m.type === 'error') { settled = true; reject(new Error(m.message)); worker.terminate().catch(() => {}); }
    });
    worker.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    worker.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('indexer stopped with code ' + code)); } });
  });
}

/**
 * The reading plan of an index for a target (R08 section 4.4).
 *
 * @param {object} o - {chunkChars, chunks, targetProvider, targetModel, depth, readerModel}
 * @returns {{tier: string, ranges: number, maxReaders: number, readerModel: (string|null), rangeList: object[]}}
 */
function planFor(o) {
  const context = charter.CONTEXT_TOKENS[o.targetProvider] || charter.CONTEXT_TOKENS.claude;
  const l2Tokens = (o.chunkChars || 0) / charter.CHARS_PER_TOKEN;
  let tier = 'L';
  if (l2Tokens <= TIER_S_SHARE * context) tier = 'S';
  else if (l2Tokens <= TIER_M_RANGES * RANGE_TOKENS) tier = 'M';
  const chunks = Array.isArray(o.chunks) ? o.chunks : [];
  const rangeList = [];
  const per = tier === 'L' ? TIER_L_CHUNKS_PER_RANGE : 1;
  for (let i = 0; i < chunks.length; i += per) {
    const group = chunks.slice(i, i + per);
    const n = rangeList.length + 1;
    rangeList.push({
      id: 'R' + String(n).padStart(3, '0'),
      fromTurn: group[0].fromTurn,
      toTurn: group[group.length - 1].toTurn,
      chunkFiles: group.map((c) => c.file),
      era: tier === 'L' ? 'E' + (Math.floor((n - 1) / ERA_RANGES) + 1) : null,
    });
  }
  const ranges = tier === 'S' ? Math.max(1, rangeList.length) : rangeList.length;
  let readerModel = null;
  if (tier !== 'S') readerModel = o.readerModel || (o.targetProvider === 'codex' ? (o.targetModel || null) : CLAUDE_READER_MODEL); // gsd:provider-literal-allowed (mobile v2 migration pack)
  return { tier, ranges, maxReaders: tier === 'S' ? 0 : MAX_READERS, readerModel, rangeList };
}

/**
 * Rough L2 size before the index exists.
 *
 * @param {number} bytes - Raw bytes.
 * @returns {number} Characters.
 */
function estimateChunkChars(bytes) {
  return Math.round(bytes * (bytes < SMALL_SOURCE_BYTES ? L2_SHARE_SMALL : L2_SHARE_LARGE));
}

/**
 * Token, time and list price estimates (R08 section 9.2).
 *
 * @param {object} o - {plan, chunkChars, depth, targetProvider, targetModel}
 * @returns {object} The plan fields of MigrationPreview.
 */
function estimate(o) {
  const plan = o.plan;
  const l2 = (o.chunkChars || 0) / charter.CHARS_PER_TOKEN;
  let input;
  let output;
  let minutes;
  if (o.depth === 'exhaustive') {
    input = l2 * READER_OVERHEAD + L_LEAD_TOKENS;
    output = plan.ranges * REPORT_TOKENS_PER_RANGE + 100000;
    minutes = [Math.max(30, plan.ranges * 2), Math.max(60, plan.ranges * 4)];
  } else if (o.depth === 'quick' || plan.tier === 'S') {
    input = (o.depth === 'quick' ? Math.min(l2, RANGE_TOKENS) : l2) + S_ORIENTATION_TOKENS;
    output = 10000;
    minutes = [3, 8];
  } else if (plan.tier === 'M') {
    input = plan.ranges * M_READER_TOKENS * READER_OVERHEAD + M_LEAD_TOKENS;
    output = plan.ranges * REPORT_TOKENS_PER_RANGE + 40000;
    minutes = [15, Math.max(30, Math.ceil(plan.ranges / MAX_READERS) * 5 + 15)];
  } else {
    input = plan.ranges * L_READER_TOKENS * READER_OVERHEAD + L_ERA_TOKENS + L_LEAD_TOKENS;
    output = plan.ranges * REPORT_TOKENS_PER_RANGE + 100000;
    minutes = [60, Math.max(120, Math.ceil(plan.ranges / MAX_READERS) * 6 + 30)];
  }
  const price = PRICES[o.targetModel] || DEFAULT_PRICE[o.targetProvider] || DEFAULT_PRICE.claude;
  const readerPrice = plan.readerModel && PRICES[plan.readerModel] ? PRICES[plan.readerModel] : price;
  const readerShare = plan.tier === 'S' || o.depth === 'quick' ? 0 : 0.75;
  const usd = (tokensIn, tokensOut) => (tokensIn * ((1 - readerShare) * price[0] + readerShare * readerPrice[0]) + tokensOut * price[1]) / 1e6;
  const mid = usd(input, output);
  return {
    tier: plan.tier,
    ranges: plan.ranges,
    maxReaders: plan.maxReaders,
    readerModel: plan.readerModel,
    estInputTokens: { low: Math.round(input * ESTIMATE_LOW), high: Math.round(input * ESTIMATE_HIGH) },
    estOutputTokens: Math.round(output),
    estMinutes: { low: minutes[0], high: minutes[1] },
    estQuota: null,
    estUsdListPrice: { low: Math.max(0, Math.floor(mid * ESTIMATE_LOW)), high: Math.max(1, Math.ceil(mid * ESTIMATE_HIGH)) },
  };
}

/** @returns {boolean} whether an estimate needs the second confirmation (R08:585) */
function needsCostConfirm(depth, est) {
  return depth === 'exhaustive' || (est && est.estUsdListPrice && est.estUsdListPrice.high > COST_CONFIRM_USD);
}

/**
 * Run git with a timeout; resolves stdout or null.
 *
 * @param {string} cwd - Working directory.
 * @param {string[]} args - Arguments (never free text).
 * @returns {Promise<string|null>}
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * The git state of a working directory: top level, branch, HEAD, porcelain
 * status, stashes, a hash of the diff, recent log, worktrees and remotes with
 * credentials stripped (R08 section 4.3 git.md, section 5.1 tripwire).
 *
 * @param {string} cwd - Working directory.
 * @param {number|null} sinceMs - First turn time for the log.
 * @returns {Promise<object|null>} null when cwd is not in a repository.
 */
async function gitState(cwd, sinceMs) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const [head, branch, status, stash, diff, log, worktrees, remotes] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain=v2', '--branch']),
    git(cwd, ['stash', 'list']),
    git(cwd, ['diff']),
    git(cwd, sinceMs ? ['log', '--oneline', '-n', String(GIT_LOG_LINES), '--since=' + new Date(sinceMs).toISOString()] : ['log', '--oneline', '-n', String(GIT_LOG_LINES)]),
    git(cwd, ['worktree', 'list']),
    git(cwd, ['remote', '-v']),
  ]);
  const statusLines = String(status || '').split('\n').filter((l) => l && !l.startsWith('#'));
  return {
    top: top.trim(),
    head: head ? head.trim() : null,
    branch: branch ? branch.trim() : null,
    status: status || '',
    dirty: statusLines.length,
    stash: stash || '',
    diffSha: crypto.createHash('sha256').update(diff || '').digest('hex'),
    log: log || '',
    worktrees: worktrees || '',
    remotes: String(remotes || '').replace(/\/\/[^/@\s]+@/g, '//'),
  };
}

/**
 * Compare git state now with the snapshot's (the tripwire, R08 section
 * 5.1): any change to HEAD, the status, the stashes or the diff is flagged,
 * with a diff stat against the snapshot's HEAD.
 *
 * @param {string} cwd - Working directory.
 * @param {object|null} before - gitState at snapshot.
 * @returns {Promise<{changed: boolean, diffStat: (object|null)}>}
 */
async function tripwire(cwd, before) {
  if (!before) return { changed: false, diffStat: null };
  const now = await gitState(cwd, null);
  if (!now) return { changed: false, diffStat: null };
  const changed = now.head !== before.head || now.status !== before.status || now.stash !== before.stash || now.diffSha !== before.diffSha;
  if (!changed) return { changed: false, diffStat: null };
  const numstat = await git(cwd, before.head ? ['diff', '--numstat', before.head] : ['diff', '--numstat']);
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of String(numstat || '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files += 1;
    added += m[1] === '-' ? 0 : Number(m[1]);
    removed += m[2] === '-' ? 0 : Number(m[2]);
  }
  // A file the takeover created is untracked, so the numstat above misses
  // it; count the untracked paths that were not there at the snapshot.
  const untracked = (s) => new Set(String(s || '').split('\n').filter((l) => l.startsWith('? ')));
  const wasUntracked = untracked(before.status);
  for (const l of untracked(now.status)) if (!wasUntracked.has(l)) files += 1;
  return { changed: true, diffStat: { added, removed, files } };
}

/**
 * Standards the source ran under (R08 section 6.2): the global CLAUDE.md,
 * every CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md from the working
 * directory up, the project memory index, the Codex AGENTS.md files. Never
 * credentials.md. Contents are redacted.
 *
 * @param {object} o - {cwd, claudeDir, codexHome, stopAt}
 * @returns {Array<{from: string, name: string, text: string}>}
 */
function collectStandards(o) {
  const out = [];
  const seen = new Set();
  const add = (file, name) => {
    try {
      const real = path.resolve(file);
      if (seen.has(real) || /credentials/i.test(path.basename(real))) return;
      if (!fs.statSync(real).isFile()) return;
      seen.add(real);
      out.push({ from: real, name, text: redact(fs.readFileSync(real, 'utf8')) });
    } catch (_) { /* missing */ }
  };
  if (o.claudeDir) add(path.join(o.claudeDir, 'CLAUDE.md'), 'global-CLAUDE.md');
  if (o.codexHome) add(path.join(o.codexHome, 'AGENTS.md'), 'global-AGENTS.md');
  let cur = o.cwd ? path.resolve(o.cwd) : null;
  const stop = o.stopAt ? path.resolve(o.stopAt) : null;
  for (let i = 0; cur && i < STANDARDS_MAX_DEPTH; i++) {
    const tag = String(i).padStart(2, '0');
    add(path.join(cur, 'CLAUDE.md'), 'up' + tag + '-CLAUDE.md');
    add(path.join(cur, '.claude', 'CLAUDE.md'), 'up' + tag + '-dot-claude-CLAUDE.md');
    add(path.join(cur, 'CLAUDE.local.md'), 'up' + tag + '-CLAUDE.local.md');
    add(path.join(cur, 'AGENTS.md'), 'up' + tag + '-AGENTS.md');
    if (stop && cur.toLowerCase() === stop.toLowerCase()) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (o.claudeDir && o.cwd) {
    try {
      const enc = require('../../../../providers/claude/path-decode').encodeClaudeProjectDir(o.cwd);
      add(path.join(o.claudeDir, 'projects', enc, 'memory', 'MEMORY.md'), 'project-memory-MEMORY.md');
    } catch (_) { /* no memory index */ }
  }
  return out;
}

/** The source of tools/slice.js (reads records at a byte offset, redacted). */
const SLICE_JS = [
  '#!/usr/bin/env node',
  '// tools/slice.js: print raw transcript records from a byte offset, pretty,',
  '// long strings cut, base64 removed, secrets redacted (R08 section 4.6).',
  '// Usage: node slice.js <raw.jsonl> <byteOffset> [count]',
  "'use strict';",
  "const fs = require('fs');",
  "const { redact } = require('./redact');",
  'const [, , file, offArg, countArg] = process.argv;',
  "if (!file || offArg === undefined) { console.error('usage: node slice.js <raw.jsonl> <byteOffset> [count]'); process.exit(2); }",
  'const count = Math.max(1, Number(countArg) || 5);',
  'const CUT = 2000;',
  "const cut = (v) => { if (typeof v === 'string') { if (/^[A-Za-z0-9+/=]{2000,}$/.test(v)) return '[base64 removed]'; return v.length > CUT ? v.slice(0, CUT) + ' [+' + (v.length - CUT) + ' chars]' : v; } if (Array.isArray(v)) return v.map(cut); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = cut(x); return o; } return v; };",
  "const fd = fs.openSync(file, 'r');",
  'let pos = Number(offArg);',
  'let base = pos;',
  'let printed = 0;',
  'let carry = Buffer.alloc(0);',
  'const buf = Buffer.alloc(4 * 1024 * 1024);',
  'while (printed < count) {',
  '  const n = fs.readSync(fd, buf, 0, buf.length, pos);',
  '  if (n <= 0) break;',
  '  const data = Buffer.concat([carry, buf.subarray(0, n)]);',
  '  pos += n;',
  '  let start = 0;',
  '  for (;;) {',
  '    const nl = data.indexOf(10, start);',
  '    if (nl === -1) break;',
  '    const lineOffset = base + start;',
  "    const line = data.subarray(start, nl).toString('utf8');",
  '    start = nl + 1;',
  '    if (!line.trim()) continue;',
  "    let text; try { text = JSON.stringify(cut(JSON.parse(line)), null, 2); } catch (_) { text = line.slice(0, CUT); }",
  "    console.log('@' + lineOffset);",
  '    console.log(redact(text));',
  '    printed += 1;',
  '    if (printed >= count) break;',
  '  }',
  '  base += start;',
  '  carry = Buffer.from(data.subarray(start));',
  '}',
  'fs.closeSync(fd);',
  '',
].join('\n');

/** The source of tools/find.js (search chunks, or the raw file with "raw"). */
const FIND_JS = [
  '#!/usr/bin/env node',
  '// tools/find.js: search the chunks (turn ids in results), or the raw',
  '// transcript when the second word is raw (byte offsets in results).',
  '// Usage: node find.js <pattern> [raw]',
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const { redact } = require('./redact');",
  'const [, , pattern, mode] = process.argv;',
  "if (!pattern) { console.error('usage: node find.js <pattern> [raw]'); process.exit(2); }",
  "const re = new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'i');",
  "const pack = path.join(__dirname, '..');",
  "if (mode === 'raw') {",
  "  const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));",
  "  const fd = fs.openSync(manifest.rawPath, 'r');",
  '  const buf = Buffer.alloc(4 * 1024 * 1024);',
  '  let pos = 0; let carry = Buffer.alloc(0); let lineStart = 0; let hits = 0;',
  '  while (pos < manifest.snapshot.bytes && hits < 200) {',
  '    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, manifest.snapshot.bytes - pos), pos);',
  '    if (n <= 0) break;',
  '    const data = Buffer.concat([carry, buf.subarray(0, n)]);',
  '    let start = 0;',
  '    for (;;) {',
  '      const nl = data.indexOf(10, start);',
  '      if (nl === -1) break;',
  "      const line = data.subarray(start, nl).toString('utf8');",
  "      if (re.test(line)) { const i = line.search(re); console.log('@' + lineStart + ': ' + redact(line.slice(Math.max(0, i - 150), i + 250))); hits += 1; }",
  '      lineStart += nl - start + 1;',
  '      start = nl + 1;',
  '    }',
  '    carry = Buffer.from(data.subarray(start));',
  '    pos += n;',
  '  }',
  '  fs.closeSync(fd);',
  '} else {',
  "  const dir = path.join(pack, 'chunks');",
  '  for (const f of fs.readdirSync(dir).sort()) {',
  "    let turn = '';",
  "    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\\n')) {",
  "      const m = /^## (T\\d+)/.exec(line); if (m) turn = m[1];",
  "      if (re.test(line)) console.log(f + ' ' + turn + ': ' + line.slice(0, 400));",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

/**
 * Build the pack folder of a migration from its index (R08 section 4.3).
 *
 * @param {object} o - {packDir, indexDir, manifest, snap, provider, targetProvider, sourceName, rawPath, cwd, focus, git, plan, depth, standards, cutAtMessage, charterPath}
 * @returns {{detail: string, files: number}}
 */
function writePack(o) {
  const dir = o.packDir;
  fs.mkdirSync(dir, { recursive: true });
  // The index layer (deterministic), copied from the index cache.
  for (const name of fs.readdirSync(o.indexDir)) {
    const from = path.join(o.indexDir, name);
    const to = path.join(dir, name === 'index-manifest.json' ? 'index-manifest.json' : name);
    fs.cpSync(from, to, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(dir, 'readers'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'standards'), { recursive: true });
  const m = o.manifest || {};
  const cwds = Object.keys(m.cwds || {});
  const manifest = {
    migrationPack: 1,
    rawPath: o.rawPath,
    provider: o.provider,
    source: { name: o.sourceName, bytes: o.snap.bytes },
    snapshot: { bytes: o.snap.bytes, headSha: o.snap.headSha, tailSha: o.snap.tailSha, cutAtMessage: o.cutAtMessage || null },
    counts: { turns: m.turns || 0, toolCalls: m.toolCalls || 0, toolErrors: m.toolErrors || 0, checkpoints: m.checkpoints || 0, decisions: m.decisions || 0, agentReports: m.agentReports || 0, images: m.images || 0 },
    span: { firstTs: m.firstTs || null, lastTs: m.lastTs || null },
    models: m.models || {},
    cwds,
    gitBranches: m.gitBranches || {},
    coverage: { recognizedLines: m.coverage, badLines: m.badLines || 0, oversizeLines: m.oversizeLines || 0, unknownTypes: m.unknownTypes || {}, formatDrift: !!m.formatDrift },
    subagents: o.subagents || { count: 0, bytes: 0 },
    humanTokens: Math.ceil((m.humanChars || 0) / charter.CHARS_PER_TOKEN),
    plan: { tier: o.plan.tier, ranges: o.plan.ranges, maxReaders: o.plan.maxReaders, readerModel: o.plan.readerModel, depth: o.depth },
    redactions: m.redactions || {},
    indexerVersion: m.indexerVersion,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'ranges.json'), JSON.stringify(o.plan.rangeList, null, 2));
  fs.writeFileSync(path.join(dir, 'READER.md'), charter.fillReader(dir));
  fs.writeFileSync(path.join(dir, 'FOCUS.md'), o.focus ? '# Focus from the user\n\nQuestion this first:\n\n' + redact(o.focus) + '\n' : '# Focus from the user\n\nNone given.\n');
  // git.md
  const g = o.git;
  const gitMd = g
    ? ['# Git state at the snapshot', '', 'Repository: ' + g.top, 'Branch: ' + g.branch, 'HEAD: ' + g.head, 'Changed paths: ' + g.dirty, '', '## Status', '```', redact(g.status).trim(), '```', '', '## Commits since the first turn', '```', redact(g.log).trim(), '```', '', '## Stashes', '```', redact(g.stash).trim() || '(none)', '```', '', '## Worktrees', '```', redact(g.worktrees).trim(), '```', '', '## Remotes (credentials removed)', '```', redact(g.remotes).trim(), '```', ''].join('\n')
    : '# Git state at the snapshot\n\nThe working directory is not inside a git repository, or git is not installed.\n';
  fs.writeFileSync(path.join(dir, 'git.md'), gitMd);
  // standards/
  const index = ['# Standards the source ran under', ''];
  for (const s of o.standards || []) {
    fs.writeFileSync(path.join(dir, 'standards', s.name), s.text);
    index.push('- ' + s.name + ' (from ' + s.from + ')');
  }
  if (!(o.standards || []).length) index.push('None were found.');
  fs.writeFileSync(path.join(dir, 'standards', 'INDEX.md'), index.join('\n') + '\n');
  // tools/
  fs.copyFileSync(path.join(__dirname, 'redact.js'), path.join(dir, 'tools', 'redact.js'));
  fs.writeFileSync(path.join(dir, 'tools', 'slice.js'), SLICE_JS);
  fs.writeFileSync(path.join(dir, 'tools', 'find.js'), FIND_JS);
  // The charter (CHARTER.md; START.md is the same text for a Codex lead).
  const lastRange = o.plan.rangeList.length ? o.plan.rangeList[o.plan.rangeList.length - 1] : null;
  const coverageText = 'recognized ' + Math.round((m.coverage || 0) * 100) + ' percent of lines' + (m.formatDrift ? ', and the conversation format drifted, so lean on tools/find.js with raw' : '');
  const lastAsk = lastHumanMessage(path.join(dir, 'user-messages.md'));
  const charterText = charter.fillCharter({
    provider: o.targetProvider,
    sourceName: o.sourceName,
    sourceProvider: o.provider === 'codex' ? 'Codex' : 'Claude', // gsd:provider-literal-allowed (mobile v2 migration pack)
    manifest: m,
    rawPath: o.rawPath,
    snapshotBytes: o.snap.bytes,
    cwd: o.cwd,
    otherCwds: cwds.filter((c) => c !== o.cwd),
    packDir: dir,
    charterPath: o.charterPath,
    tier: o.plan.tier,
    depth: o.depth,
    ranges: o.plan.ranges,
    maxReaders: o.plan.maxReaders,
    readerModel: o.plan.readerModel,
    coverage: coverageText,
    gitSummary: g ? ('branch ' + g.branch + ', HEAD ' + String(g.head || '').slice(0, 12) + ', ' + g.dirty + ' changed paths') : null,
    lastAsk,
    lastRange,
    cutAtMessage: o.cutAtMessage || null,
  });
  fs.writeFileSync(path.join(dir, 'CHARTER.md'), charterText);
  fs.writeFileSync(path.join(dir, 'START.md'), charterText);
  const claudeMd = (o.standards || []).filter((s) => /CLAUDE/.test(s.name)).length;
  const memory = (o.standards || []).some((s) => /MEMORY/.test(s.name));
  const detail = claudeMd + ' CLAUDE.md' + (memory ? ' · memory' : '') + ' · ' + (g ? (g.branch + ', ' + g.dirty + ' dirty') : 'no git');
  return { detail };
}

/**
 * The last human message in user-messages.md (for the glance block).
 *
 * @param {string} file - user-messages.md.
 * @returns {string|null}
 */
function lastHumanMessage(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const i = text.lastIndexOf('\n### T');
    if (i === -1) return null;
    const body = text.slice(i).split('\n').slice(2).join('\n').trim();
    return body || null;
  } catch (_) {
    return null;
  }
}

/**
 * Subagent transcripts of a Claude session (R08 section 1.5): count and bytes.
 *
 * @param {string} rawPath - Main transcript.
 * @returns {{count: number, bytes: number}}
 */
function subagentsOf(rawPath) {
  const out = { count: 0, bytes: 0 };
  const dir = rawPath.replace(/\.jsonl$/, '');
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { out.count += 1; try { out.bytes += fs.statSync(p).size; } catch (_) { /* gone */ } }
    }
  };
  walk(path.join(dir, 'subagents'), 0);
  return out;
}

/** @returns {string} the Claude config folder (sandboxed by CWM_CLAUDE_DIR in tests) */
function claudeDir() {
  return process.env.CWM_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

/** @returns {string} the Codex home */
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** For tests: forget the in process index builds. */
function _resetForTests() {
  builds.clear();
}

module.exports = {
  snapshotSource,
  indexKey,
  ensureIndex,
  planFor,
  estimate,
  estimateChunkChars,
  needsCostConfirm,
  gitState,
  tripwire,
  collectStandards,
  writePack,
  subagentsOf,
  claudeDir,
  codexHome,
  _resetForTests,
  COST_CONFIRM_USD,
  PRICES,
};
