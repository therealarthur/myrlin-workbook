/**
 * The mobile chat track's own cache of provider discovery (BUILD-CONTRACT 3.2).
 *
 * What: holds the last discover() result of each provider (Claude
 * transcripts, Codex threads), refreshes in the background with a 30 s time
 * to live and when Workbook's provider change callback fires, and never
 * blocks a request on a cold walk (PROTOCOL.md 4.4.1: a cold cache answers
 * with what it has and partial true).
 *
 * Why: a cold Claude walk blocked the event loop for 130 to 290 ms per call
 * (R02:345); the phone's list routes must answer from memory.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const { warn } = require('./common');

const TTL_MS = 30000;
const PROVIDERS = ['claude', 'codex']; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)

/**
 * @param {object} opts
 * @param {object} opts.registry - src/providers registry ({getProvider(id)}).
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 * @returns {object}
 */
function createDiscoveryCache({ registry, now = Date.now, ttlMs = TTL_MS } = {}) {
  const state = new Map();
  const listeners = new Set();
  for (const p of PROVIDERS) state.set(p, { entries: [], at: 0, warm: false, inFlight: null });

  /**
   * Refresh one provider's entries.
   * @param {string} provider
   * @param {boolean} force
   * @returns {Promise<void>}
   */
  function refreshOne(provider, force) {
    const s = state.get(provider);
    if (!s) return Promise.resolve();
    if (s.inFlight) return s.inFlight;
    let prov = null;
    try { prov = registry && registry.getProvider ? registry.getProvider(provider) : null; } catch (_) { prov = null; }
    if (!prov || typeof prov.discover !== 'function') {
      s.warm = true;
      s.at = now();
      return Promise.resolve();
    }
    s.inFlight = (async () => {
      try {
        const res = await prov.discover({ forceRefresh: !!force });
        s.entries = Array.isArray(res) ? res : [];
        s.at = now();
        s.warm = true;
        for (const fn of listeners) {
          try { fn(provider); } catch (_) { /* listener errors are theirs */ }
        }
      } catch (err) {
        warn('discovery refresh failed for', provider, err && err.message);
      } finally {
        s.inFlight = null;
      }
    })();
    return s.inFlight;
  }

  return {
    /**
     * Cached entries of a provider; starts a background refresh when stale.
     * @param {string} provider
     * @returns {Array<object>}
     */
    entries(provider) {
      const s = state.get(provider);
      if (!s) return [];
      if (!s.inFlight && now() - s.at > ttlMs) refreshOne(provider, false);
      return s.entries;
    },
    /** @param {string} provider @returns {boolean} */
    isWarm(provider) { const s = state.get(provider); return !!(s && s.warm); },
    /** @returns {boolean} true when any provider has never loaded */
    isPartial() { return PROVIDERS.some((p) => !state.get(p).warm); },
    /**
     * Refresh now.
     * @param {{provider?: string, force?: boolean}} [o]
     * @returns {Promise<void>}
     */
    refresh(o = {}) {
      const list = o.provider ? [o.provider] : PROVIDERS;
      return Promise.all(list.map((p) => refreshOne(p, !!o.force))).then(() => {});
    },
    /** Provider change callback from Workbook (B1's onProviderChange). */
    onProviderChange(provider) {
      // Mark the provider stale only; the next read refreshes it in the
      // background without forcing a full walk (the provider's own warm cache
      // answers). WHY: Workbook reports provider changes constantly while
      // sessions write transcripts, and a forced Codex rediscovery reads the
      // head of every rollout synchronously; run back to back it froze the
      // desktop's main thread for seconds at a time (2026-09-28 live profile).
      const list = provider && state.has(provider) ? [provider] : PROVIDERS;
      for (const p of list) {
        const s = state.get(p);
        if (s) s.at = 0;
      }
    },
    /** @param {(provider: string) => void} fn */
    onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Seed entries (tests). */
    _seed(provider, entries) { const s = state.get(provider); s.entries = entries; s.at = now(); s.warm = true; },
  };
}

module.exports = { createDiscoveryCache, TTL_MS };
