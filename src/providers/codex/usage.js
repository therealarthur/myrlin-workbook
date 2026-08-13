/**
 * Codex token accounting.
 *
 * BUILD-CONTRACT P9.3 / CODEX-PARITY B10.
 *
 * ===========================================================================
 * What this module exists to stop
 * ===========================================================================
 *
 * `/api/sessions/:id/cost` runs a Claude-shaped parser over whatever transcript
 * it is handed: it matches `entry.type === 'assistant' && message.usage`. A
 * Codex rollout yields ZERO matches against 618 `event_msg/token_count` entries
 * in the file CODEX-PARITY measured, so the route returned a fully-formed cost
 * object of zeroes and the UI rendered `$0.00`.
 *
 * A false zero is worse than a blank. It says "this session cost nothing", which
 * is a claim, and the claim is wrong: the same session had 226 million tokens
 * against it. This module produces the real numbers, and the route it feeds
 * says plainly that dollars are not available rather than inventing them.
 *
 * ===========================================================================
 * Why there is no dollar figure, and why that is the honest answer
 * ===========================================================================
 *
 * Codex desktop bills against a ChatGPT plan, not per token. The rollouts carry
 * `rate_limits.plan_type` ("pro" on the reference machine) and a credits block;
 * they carry no price. There is no per-token rate that could be applied without
 * inventing one, and an invented rate would be the same failure as the zero,
 * only harder to notice.
 *
 * So the split is explicit:
 *
 *   supportsCost()      dollars. Stays FALSE for Codex.
 *   supportsTokenUsage() tokens. TRUE, and this module is what backs it.
 *
 * Recorded as a deviation from the contract's literal "flip supportsCost to
 * true", taken because the contract's own done criterion is "Codex cost is
 * real, or honestly absent, never a false zero", and flipping the flag with no
 * price model would have produced exactly the false zero it forbids: the
 * frontend renders `$` + `cost.total` for every provider whose flag is true.
 *
 * ===========================================================================
 * The two sources, and why both exist
 * ===========================================================================
 *
 * 1. `threads.tokens_used` from the SQLite store. O(1), no file read, and the
 *    number the desktop app itself keeps. Total only, no breakdown.
 * 2. The last `event_msg.token_count` line in the rollout. Carries the full
 *    breakdown, the context window and the rate-limit snapshot, at the price of
 *    a bounded tail read.
 *
 * MEASURED, on the reference machine, for thread 019ff6f9: `tokens_used` is
 * 226,420,778 and the rollout's last `total_token_usage.total_tokens` is
 * 226,420,778. The same number. So the fast path is not an approximation of the
 * slow one, it is the same value with less detail, and a caller that only needs
 * a total never has to open a 9 MB file.
 *
 * `total_token_usage` was verified to be cumulative and monotonic across the
 * whole file: 1725 samples on that session, zero decreases, across 12
 * `session_meta` lines, so a resume does NOT reset it and the last line in the
 * file is the session total.
 *
 * Field semantics, derived from the numbers rather than assumed:
 *
 *   total_tokens        = input_tokens + output_tokens
 *   cached_input_tokens is a SUBSET of input_tokens
 *   reasoning_output_tokens is a SUBSET of output_tokens
 *   cache_write_input_tokens sits outside the total
 *
 * That is not Claude's accounting, where `input_tokens` excludes the cache read.
 * `toComparableTokens` performs the conversion so the existing token-bar maths
 * in the UI keeps working, and the untranslated numbers ride along under
 * `raw` so nothing is lost to the conversion.
 *
 * Safety: never writes, never throws, returns null when it has nothing.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/usage
 */

'use strict';

const fs = require('fs');

const stateDb = require('./state-db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The envelope and payload types that carry usage. Named rather than inlined so
 * the drift story is greppable alongside parse.js's emit table.
 */
const TOKEN_COUNT_ENVELOPE = 'event_msg';
const TOKEN_COUNT_PAYLOAD = 'token_count';

/**
 * Escalating tail windows, in bytes.
 *
 * `token_count` is the most frequent line in a rollout by a wide margin (1709
 * of 7310 lines on the measured session), so the first window finds one
 * essentially always. The second exists for a long session that went quiet: a
 * file can end with a large tool result and no usage line for a while. Beyond
 * the second window the DB total answers, so there is never an unbounded read.
 */
const TAIL_WINDOWS = Object.freeze([512 * 1024, 4 * 1024 * 1024]);

/**
 * Refuse to open anything larger than this. A rollout is an append-only log and
 * the largest on the reference machine is under 40 MB; this is headroom, not a
 * limit anyone should meet. The tail read means file size does not drive cost,
 * but a ceiling keeps a pathological file from being touched at all.
 */
const MAX_ROLLOUT_BYTES = 2 * 1024 * 1024 * 1024;

/** Machine-readable reasons a cost figure is absent. */
const COST_UNAVAILABLE = Object.freeze({
  /** The provider has token accounting but no price model. Codex today. */
  NO_PRICE_MODEL: 'provider-has-no-price-model',
  /** The provider does not report usage at all. */
  NO_USAGE: 'provider-reports-no-usage',
  /** Usage exists but this session's artifact could not be found. */
  NO_ARTIFACT: 'no-transcript-artifact',
});

/** Where a usage report's numbers came from. */
const USAGE_SOURCES = Object.freeze({
  STATE_DB: 'state-db',
  ROLLOUT: 'rollout',
  BOTH: 'state-db+rollout',
  NONE: 'none',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce anything to a non-negative finite integer, or 0.
 *
 * Every number here came from a schema this project does not own, so a string,
 * a null or a float is a shape to absorb rather than a reason to fail.
 *
 * @param {*} v
 * @returns {number}
 */
function toCount(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Read the last `windowBytes` of a file and drop the leading partial line.
 *
 * Asynchronous and positional: a synchronous whole-file read of a multi-megabyte
 * rollout inside a server is event-loop time nobody agreed to spend, and the
 * whole point of reading the tail is that the answer is at the end.
 *
 * @param {string} filePath
 * @param {number} fileSize - Size from a fresh stat.
 * @param {number} windowBytes
 * @returns {Promise<string>} Whole lines only; '' on any failure.
 */
async function readTail(filePath, fileSize, windowBytes) {
  const length = Math.min(windowBytes, fileSize);
  if (length <= 0) return '';
  const start = Math.max(0, fileSize - length);
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      // The window almost certainly opened mid-line; that fragment is not JSON.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch (_) {
    return '';
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Normalise one `token_count.info` block into the module's native shape.
 *
 * Tolerates two layouts: the current one, where the totals live under
 * `total_token_usage`, and a flattened one where they sit directly on `info`.
 * The second has not been observed, but the cost of accepting it is three lines
 * and the cost of refusing it would be a silent zero on an older CLI.
 *
 * @param {object} info - `payload.info`.
 * @returns {{totals: object, lastTurn: (object|null), contextWindow: (number|null)}|null}
 */
function normalizeTokenCountInfo(info) {
  if (!info || typeof info !== 'object') return null;

  const totalsSource =
    info.total_token_usage && typeof info.total_token_usage === 'object'
      ? info.total_token_usage
      : (typeof info.input_tokens !== 'undefined' ? info : null);
  if (!totalsSource) return null;

  const readUsage = (u) => ({
    inputTokens: toCount(u.input_tokens),
    cachedInputTokens: toCount(u.cached_input_tokens),
    cacheWriteInputTokens: toCount(u.cache_write_input_tokens),
    outputTokens: toCount(u.output_tokens),
    reasoningOutputTokens: toCount(u.reasoning_output_tokens),
    totalTokens: toCount(u.total_tokens),
  });

  const totals = readUsage(totalsSource);
  // A file that carries the parts but not the sum still deserves a sum.
  if (totals.totalTokens === 0) totals.totalTokens = totals.inputTokens + totals.outputTokens;

  const lastTurn =
    info.last_token_usage && typeof info.last_token_usage === 'object'
      ? readUsage(info.last_token_usage)
      : null;

  const contextWindow =
    typeof info.model_context_window === 'number' && info.model_context_window > 0
      ? info.model_context_window
      : null;

  return { totals: totals, lastTurn: lastTurn, contextWindow: contextWindow };
}

/**
 * Normalise the `rate_limits` block that rides alongside every token_count.
 *
 * This is the feed BUILD-CONTRACT P9.6 wants for the account usage popover, and
 * it is carried here rather than in a second reader because it arrives on the
 * same line the totals do: extracting it costs nothing extra.
 *
 * Only the fields the meters need are lifted, in a stable shape, so the popover
 * never has to know the vendor's key names.
 *
 * @param {object} rateLimits - `payload.rate_limits`.
 * @returns {object|null}
 */
function normalizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;

  const window = (w) => {
    if (!w || typeof w !== 'object') return null;
    const usedPercent = typeof w.used_percent === 'number' ? w.used_percent : null;
    const windowMinutes = typeof w.window_minutes === 'number' ? w.window_minutes : null;
    const resetsAt = w.resets_at === null || w.resets_at === undefined ? null : w.resets_at;
    if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;
    return { usedPercent: usedPercent, windowMinutes: windowMinutes, resetsAt: resetsAt };
  };

  const credits =
    rateLimits.credits && typeof rateLimits.credits === 'object'
      ? {
          balance: typeof rateLimits.credits.balance === 'number' ? rateLimits.credits.balance : null,
          hasCredits: rateLimits.credits.has_credits === true,
          unlimited: rateLimits.credits.unlimited === true,
        }
      : null;

  return {
    planType: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : null,
    limitId: typeof rateLimits.limit_id === 'string' ? rateLimits.limit_id : null,
    limitName: typeof rateLimits.limit_name === 'string' ? rateLimits.limit_name : null,
    primary: window(rateLimits.primary),
    secondary: window(rateLimits.secondary),
    individual: window(rateLimits.individual_limit),
    credits: credits,
    reachedType:
      typeof rateLimits.rate_limit_reached_type === 'string'
        ? rateLimits.rate_limit_reached_type
        : null,
    spendControlReached: rateLimits.spend_control_reached === true,
  };
}

/**
 * Scan a block of JSONL text for the LAST usable token_count line.
 *
 * Walks forward and keeps overwriting rather than walking backward, because the
 * cheap pre-filter (`indexOf`) is what makes this fast and a backward walk with
 * the same filter is the same work in a less readable order.
 *
 * @param {string} text - Whole JSONL lines.
 * @returns {{info: object, rateLimits: (object|null), samples: number}|null}
 */
function findLastTokenCount(text) {
  if (!text) return null;
  let found = null;
  let rateLimits = null;
  let samples = 0;

  for (const line of text.split('\n')) {
    // token_count is the most common line in the file, but the pre-filter still
    // pays: it skips the JSON.parse on tool results measured at 671 KB each.
    if (!line || line.indexOf(TOKEN_COUNT_PAYLOAD) === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      continue; // a torn line inside a tail window is expected
    }
    if (!parsed || parsed.type !== TOKEN_COUNT_ENVELOPE) continue;
    const payload = parsed.payload;
    if (!payload || payload.type !== TOKEN_COUNT_PAYLOAD) continue;
    const normalized = normalizeTokenCountInfo(payload.info);
    if (!normalized) continue;
    found = normalized;
    samples++;
    if (payload.rate_limits) rateLimits = normalizeRateLimits(payload.rate_limits);
  }

  if (!found) return null;
  return { info: found, rateLimits: rateLimits, samples: samples };
}

/**
 * Convert Codex's native counters into the field names and semantics the rest
 * of the workbook already speaks, which are Claude's.
 *
 * The conversion that matters: Codex's `input_tokens` INCLUDES the cached
 * reads, Claude's excludes them. Reporting Codex's raw input as `input` would
 * overstate fresh input by 98 percent on the measured session (222 million of
 * its 226 million input tokens were cache reads).
 *
 * @param {object} totals - Native totals from normalizeTokenCountInfo.
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number, reasoning:number, total:number}}
 */
function toComparableTokens(totals) {
  const cacheRead = toCount(totals.cachedInputTokens);
  const rawInput = toCount(totals.inputTokens);
  // Clamped rather than trusted: if a future schema stops nesting cached inside
  // input, a negative here would poison every downstream percentage.
  const input = Math.max(0, rawInput - cacheRead);
  const output = toCount(totals.outputTokens);
  const cacheWrite = toCount(totals.cacheWriteInputTokens);
  return {
    input: input,
    output: output,
    cacheRead: cacheRead,
    cacheWrite: cacheWrite,
    reasoning: toCount(totals.reasoningOutputTokens),
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * The empty-but-well-formed token block, so a caller never has to null-check
 * before doing arithmetic.
 *
 * @returns {object}
 */
function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CodexUsageReport
 * @property {string} provider        Always 'codex'.
 * @property {string} source          One of USAGE_SOURCES.
 * @property {boolean} priced         Always false: there is no price model.
 * @property {string|null} currency   Always null, for the same reason.
 * @property {object} tokens          Claude-comparable counts, always present.
 * @property {object|null} raw        Codex-native counters, untranslated.
 * @property {object|null} lastTurn   Claude-comparable counts for the last turn.
 * @property {number|null} tokensUsed `threads.tokens_used`, the app's own total.
 * @property {number|null} contextWindow
 * @property {object|null} rateLimits Normalised plan and window snapshot (P9.6).
 * @property {number} samples         token_count lines seen in the read window.
 * @property {string|null} artifactPath Rollout the numbers came from, if any.
 */

/**
 * Token usage for one Codex thread.
 *
 * Never throws. Returns null only when NOTHING is available, which a caller
 * should report as "unknown" rather than as zero.
 *
 * @param {string} ref - Thread id, or an absolute path to a rollout .jsonl.
 * @param {Object} [opts]
 * @param {string} [opts.artifactPath] - Skip resolution, read this file.
 * @param {boolean} [opts.totalsOnly=false] - Answer from the SQLite store alone
 *   when it can, with no file read at all. The batch path wants this.
 * @returns {Promise<CodexUsageReport|null>}
 */
async function parseUsage(ref, opts) {
  try {
    const options = opts && typeof opts === 'object' ? opts : {};
    const reference = typeof ref === 'string' ? ref.trim() : '';

    // A reference that looks like a path is one. Thread ids are UUIDs and can
    // never contain a separator or the extension.
    const looksLikePath =
      reference.length > 0 &&
      (reference.toLowerCase().endsWith('.jsonl') ||
        reference.indexOf('/') !== -1 ||
        reference.indexOf('\\') !== -1);

    const threadId = looksLikePath ? null : (reference || null);
    let artifactPath =
      (typeof options.artifactPath === 'string' && options.artifactPath) ||
      (looksLikePath ? reference : null);

    // ── Source 1: the store. O(1), and on the measured machine it agrees with
    // the rollout exactly. ────────────────────────────────────────────────
    let tokensUsed = null;
    let model = null;
    if (threadId) {
      try {
        const threads = await stateDb.listThreads({
          includeArchived: true,
          includeSpawnChildren: true,
          includeHidden: true,
        });
        if (threads) {
          const row = threads.find((t) => t.id === threadId.toLowerCase());
          if (row) {
            tokensUsed = typeof row.tokensUsed === 'number' ? row.tokensUsed : null;
            model = row.model || null;
          }
        }
      } catch (_) {
        // state-db is contractually non-throwing; the guard costs the fast path
        // rather than the whole report if that contract ever breaks.
      }
      if (!artifactPath) {
        try {
          artifactPath = await stateDb.resolveRolloutPath(threadId);
        } catch (_) {
          artifactPath = null;
        }
      }
    }

    if (options.totalsOnly === true) {
      if (tokensUsed === null) return null;
      return {
        provider: 'codex', // gsd:provider-literal-allowed (own provider tag)
        source: USAGE_SOURCES.STATE_DB,
        priced: false,
        currency: null,
        // The store carries a total and nothing else, so the breakdown is
        // honestly empty and only `total` is populated.
        tokens: Object.assign(zeroTokens(), { total: tokensUsed }),
        raw: null,
        lastTurn: null,
        tokensUsed: tokensUsed,
        contextWindow: null,
        rateLimits: null,
        samples: 0,
        model: model,
        artifactPath: artifactPath || null,
      };
    }

    // ── Source 2: the rollout tail, for the breakdown and the rate limits ──
    let fromRollout = null;
    if (artifactPath) {
      let stat = null;
      try {
        stat = await fs.promises.stat(artifactPath);
      } catch (_) {
        stat = null;
      }
      if (stat && stat.isFile() && stat.size > 0 && stat.size <= MAX_ROLLOUT_BYTES) {
        for (const window of TAIL_WINDOWS) {
          const text = await readTail(artifactPath, stat.size, window);
          const hit = findLastTokenCount(text);
          if (hit) {
            fromRollout = hit;
            break;
          }
          // No point widening past the file itself.
          if (window >= stat.size) break;
        }
      }
    }

    if (!fromRollout && tokensUsed === null) return null;

    if (!fromRollout) {
      return {
        provider: 'codex', // gsd:provider-literal-allowed (own provider tag)
        source: USAGE_SOURCES.STATE_DB,
        priced: false,
        currency: null,
        tokens: Object.assign(zeroTokens(), { total: tokensUsed }),
        raw: null,
        lastTurn: null,
        tokensUsed: tokensUsed,
        contextWindow: null,
        rateLimits: null,
        samples: 0,
        model: model,
        artifactPath: artifactPath || null,
      };
    }

    return {
      provider: 'codex', // gsd:provider-literal-allowed (own provider tag)
      source: tokensUsed === null ? USAGE_SOURCES.ROLLOUT : USAGE_SOURCES.BOTH,
      priced: false,
      currency: null,
      tokens: toComparableTokens(fromRollout.info.totals),
      raw: fromRollout.info.totals,
      lastTurn: fromRollout.info.lastTurn ? toComparableTokens(fromRollout.info.lastTurn) : null,
      tokensUsed: tokensUsed,
      contextWindow: fromRollout.info.contextWindow,
      rateLimits: fromRollout.rateLimits,
      samples: fromRollout.samples,
      model: model,
      artifactPath: artifactPath || null,
    };
  } catch (_) {
    // Never throws, by contract.
    return null;
  }
}

/**
 * Synchronous total from the warm SQLite cache only.
 *
 * `/api/cost/batch` iterates every session on the machine and cannot await once
 * per row without becoming a waterfall. This answers from the cache discovery
 * already populated, and returns null when it is cold, at which point the
 * caller reports "unknown" rather than zero.
 *
 * @param {string} threadId
 * @returns {number|null}
 */
function totalTokensSync(threadId) {
  try {
    if (!threadId || typeof threadId !== 'string') return null;
    return stateDb.totalTokensSync ? stateDb.totalTokensSync(threadId) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  parseUsage,
  totalTokensSync,
  COST_UNAVAILABLE,
  USAGE_SOURCES,
  TAIL_WINDOWS,
  MAX_ROLLOUT_BYTES,
  /**
   * Test introspection surface, mirroring the `_internal` pattern the other
   * codex modules use. The pure helpers are the interesting ones: every
   * semantic claim in this file's header is a property of one of them.
   */
  _internal: {
    toCount,
    readTail,
    normalizeTokenCountInfo,
    normalizeRateLimits,
    findLastTokenCount,
    toComparableTokens,
    zeroTokens,
    TOKEN_COUNT_ENVELOPE,
    TOKEN_COUNT_PAYLOAD,
  },
};
