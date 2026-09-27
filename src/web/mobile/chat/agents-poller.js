/**
 * The shared `claude agents` poller for the mobile v2 turn service
 * (PROTOCOL.md 6.1, A5, critic F26).
 *
 * What: one poll of the CLI's JSON listing every 2.5 s (5 s timeout), and
 * only while at least one phone watches a Claude session whose owner is
 * external or background; plus an on demand read cached 10 s for ownership.
 * Entries keep the fields the phone's states need (status, waitingFor,
 * state, kind), which the desktop gate's parser drops.
 *
 * Why: each call costs 0.8 to 1.4 s of CLI start up (R04:51), so polling must
 * be shared and stop when nobody is looking.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const childProcess = require('child_process');
const live = require('../../../providers/claude/live-sessions');
const { warn } = require('./common');

const POLL_MS = 2500;
const TIMEOUT_MS = 5000;
const ON_DEMAND_TTL_MS = 10000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Normalise one raw listing entry, keeping waitingFor.
 * @param {object} raw
 * @returns {object|null}
 */
function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string') return null;
  return {
    sessionId: raw.sessionId,
    id: typeof raw.id === 'string' ? raw.id : null,
    kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
    status: typeof raw.status === 'string' ? raw.status : null,
    waitingFor: typeof raw.waitingFor === 'string' ? raw.waitingFor : null,
    state: typeof raw.state === 'string' ? raw.state : null,
    pid: Number.isFinite(raw.pid) ? raw.pid : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    name: typeof raw.name === 'string' ? raw.name : null,
  };
}

/**
 * Parse the CLI's stdout into entries.
 * @param {string} stdout
 * @returns {object[]}
 */
function parseListing(stdout) {
  const text = String(stdout || '').trim();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = live.findJsonArray(text); }
  if (!Array.isArray(data)) throw new Error('no JSON array');
  return data.map(normaliseEntry).filter(Boolean);
}

/**
 * Run the listing once with the first working claude binary.
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, entries?: object[], error?: string}>}
 */
async function defaultRunOnce(timeoutMs) {
  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;
  let candidates = [];
  try { candidates = live.resolveClaudeCandidates({ env, platform: process.platform }) || []; } catch (_) { candidates = []; }
  if (!candidates.length) return { ok: false, error: 'not-found' };
  const bin = candidates[0];
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child = null;
    const timer = setTimeout(() => { try { if (child) child.kill(); } catch (_) {} finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    const onDone = (err, stdout) => {
      if (err) return finish({ ok: false, error: 'exit-code' });
      try { finish({ ok: true, entries: parseListing(stdout) }); } catch (_) { finish({ ok: false, error: 'bad-json' }); }
    };
    try {
      if (bin.viaCmd) {
        const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
        child = childProcess.execFile(comspec, ['/d', '/s', '/c', '""' + bin.path + '" agents --json"'], { env, windowsHide: true, windowsVerbatimArguments: true, maxBuffer: MAX_BUFFER }, onDone);
      } else {
        child = childProcess.execFile(bin.path, ['agents', '--json'], { env, windowsHide: true, maxBuffer: MAX_BUFFER }, onDone);
      }
      try { if (child && child.stdin) child.stdin.end(); } catch (_) {}
    } catch (_) {
      finish({ ok: false, error: 'not-found' });
    }
  });
}

/**
 * Create the poller.
 * @param {object} [opts]
 * @param {(timeoutMs: number) => Promise<object>} [opts.runOnce] - Injectable for tests.
 * @param {number} [opts.pollMs]
 * @param {() => number} [opts.now]
 * @returns {object}
 */
function createAgentsPoller(opts = {}) {
  const runOnce = opts.runOnce || defaultRunOnce;
  const pollMs = opts.pollMs || POLL_MS;
  const now = opts.now || Date.now;
  const watched = new Map();
  const listeners = new Set();
  let latest = null;
  let inFlight = null;
  let timer = null;
  let stopped = false;

  async function pollOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let r;
      try { r = await runOnce(TIMEOUT_MS); } catch (_) { r = { ok: false, error: 'exception' }; }
      if (r && r.ok) {
        latest = { at: now(), entries: r.entries || [] };
        for (const fn of listeners) {
          try { fn(latest); } catch (err) { warn('agents listener failed', err && err.message); }
        }
      }
      return latest;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }

  function schedule() {
    if (timer || stopped || watched.size === 0) return;
    timer = setTimeout(async () => {
      timer = null;
      if (watched.size === 0 || stopped) return;
      await pollOnce();
      schedule();
    }, pollMs);
    if (timer.unref) timer.unref();
  }

  return {
    /**
     * Start watching an upstream Claude session id; returns the unwatch function.
     * @param {string} upstreamId
     * @returns {() => void}
     */
    watch(upstreamId) {
      watched.set(upstreamId, (watched.get(upstreamId) || 0) + 1);
      schedule();
      return () => {
        const n = (watched.get(upstreamId) || 0) - 1;
        if (n <= 0) watched.delete(upstreamId); else watched.set(upstreamId, n);
        if (watched.size === 0 && timer) { clearTimeout(timer); timer = null; }
      };
    },
    /** @returns {boolean} */
    isPolling() { return watched.size > 0; },
    /** @returns {{at: number, entries: object[]}|null} */
    latest() { return latest; },
    /**
     * Entry for one upstream id from the latest listing.
     * @param {string} upstreamId
     * @returns {object|null}
     */
    entryFor(upstreamId) {
      if (!latest) return null;
      const want = String(upstreamId || '').toLowerCase();
      return latest.entries.find((e) => String(e.sessionId).toLowerCase() === want) || null;
    },
    /**
     * A listing no older than the on demand TTL (ownership, the no screen send gate).
     * @param {number} [maxAgeMs]
     * @returns {Promise<{at: number, entries: object[]}|null>}
     */
    async onDemand(maxAgeMs = ON_DEMAND_TTL_MS) {
      if (latest && now() - latest.at <= maxAgeMs) return latest;
      return pollOnce();
    },
    /** Kick one background refresh without waiting. */
    refreshSoon() { if (!latest || now() - latest.at > ON_DEMAND_TTL_MS) pollOnce().catch(() => {}); },
    /** @param {(l: object) => void} fn */
    onPoll(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Seed a listing (tests and fixtures). */
    _setLatest(l) { latest = l; },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = { createAgentsPoller, parseListing, normaliseEntry, POLL_MS, ON_DEMAND_TTL_MS };
