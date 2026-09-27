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
 * Rule 6 of PROTOCOL.md 6.2, measured with Claude Code 2.1.283 in the B2 fix
 * round (test/mobile/fixtures/scratch/claude-2.1.283-live-evidence.json,
 * rule6): a running background session is listed with a pid and a status
 * (an idle one reads status idle, state done); after the stop subcommand or
 * a kill of its process it leaves the default listing within 4 s and shows
 * only under the all flag, without pid and status; a background session whose
 * process is gone while it waits on a person (state blocked) stays in the
 * default listing, again without pid and status. So a live background session
 * is one with a pid or a status, and one that lost them is asleep.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');
const live = require('../../../providers/claude/live-sessions');
const { warn } = require('./common');

const POLL_MS = 2500;
const TIMEOUT_MS = 5000;
const ON_DEMAND_TTL_MS = 10000;
/** How long the poller remembers that a conversation ran as a background session (rule 6). */
const BACKGROUND_MEMORY_MS = 24 * 60 * 60 * 1000;
/** Mirrors pty-manager's sight check: a pane younger than this may not be listed yet. */
const SIGHT_CHECK_MIN_PANE_AGE_MS = 30000;

/**
 * Whether a listing entry is a background session whose process runs (rule 6).
 * @param {object|null} e - a normalised entry
 * @returns {boolean}
 */
function isLiveBackground(e) {
  const has = (v) => v !== null && v !== undefined;
  return !!e && e.kind === 'background' && e.state !== 'stopped' && (has(e.pid) || has(e.status));
}

/**
 * Whether a listing entry is a background session whose process is gone
 * (stopped, killed or reaped by the supervisor): asleep, wakes on send.
 * @param {object|null} e - a normalised entry
 * @returns {boolean}
 */
function isSleepingBackground(e) {
  return !!e && e.kind === 'background' && !isLiveBackground(e);
}

/**
 * The blind listing check pty-manager teaches its own lookup
 * (_registerSightCheck): while this Workbook runs Claude panes that have been
 * up for a while, a successful but EMPTY listing cannot be right, so it is
 * treated as a failed poll instead of "nothing is live" (which would end open
 * turns of background sessions by rule C5).
 * @param {() => (object|null)} getPtyManager
 * @param {() => number} [now]
 * @returns {(entries: object[]) => (true|string)}
 */
function blindListingCheck(getPtyManager, now = Date.now) {
  return (entries) => {
    if (Array.isArray(entries) && entries.length > 0) return true;
    let pm = null;
    try { pm = typeof getPtyManager === 'function' ? getPtyManager() : null; } catch (_) { pm = null; }
    if (!pm || !pm.sessions || typeof pm.sessions.values !== 'function') return true;
    const t = now();
    let own = 0;
    for (const x of pm.sessions.values()) {
      if (x && x.alive && x.claudeTranscriptId && !x.attachShortId && t - (x.createdAt || t) > SIGHT_CHECK_MIN_PANE_AGE_MS) own++;
    }
    return own === 0 ? true : 'empty listing while this Workbook runs ' + own + ' Claude pane(s)';
  };
}

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
 * Run the listing once through live-sessions' runAgentsJsonOnce (PROTOCOL.md
 * 6.1), the same runner as the desktop live gate: the profile variables are
 * filled (withProfileEnv, the blind-listing and stray-config guard), the CLI
 * runs from the account home, CLAUDECODE is scrubbed, a timeout kills the
 * whole process tree by PID (a cmd.exe shim's claude child goes too, the K3
 * case), and the next binary candidate is tried when one fails to start.
 *
 * The raw stdout is kept and parsed here as well, because the shared parser
 * drops waitingFor and the ids of interactive entries, which the phone's
 * states need (rule 3 of PROTOCOL.md 6.2).
 *
 * @param {number} timeoutMs
 * @param {object} [o] - Test seams: {execFileImpl, resolveCandidates, env, platform, homedir, now}.
 * @returns {Promise<{ok: boolean, entries?: object[], error?: string, detail?: string}>}
 */
async function runAgentsListing(timeoutMs, o = {}) {
  const platform = o.platform || process.platform;
  const homedir = o.homedir !== undefined ? o.homedir : os.homedir();
  const baseEnv = o.env || process.env;
  const clock = o.now || Date.now;
  const env = live.withProfileEnv(Object.assign({}, baseEnv), { platform, homedir });
  delete env.CLAUDECODE;
  let cwd;
  try { cwd = homedir && fs.statSync(homedir).isDirectory() ? homedir : undefined; } catch (_) { cwd = undefined; }
  const resolveCandidates = o.resolveCandidates || live.resolveClaudeCandidates;
  let candidates = [];
  try { candidates = resolveCandidates({ env: baseEnv, platform }) || []; } catch (_) { candidates = []; }
  if (!candidates.length) return { ok: false, error: 'not-found', detail: 'no claude binary found' };
  const execFileImpl = o.execFileImpl || childProcess.execFile;
  const deadline = clock() + timeoutMs;
  let last = null;
  for (const bin of candidates) {
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    let stdout = null;
    const capture = (file, args, opts, cb) => execFileImpl(file, args, opts, (err, out, errOut) => {
      if (!err && stdout === null) stdout = out;
      if (typeof cb === 'function') cb(err, out, errOut);
    });
    const r = await live.runAgentsJsonOnce(bin, { timeoutMs: remaining, env, platform, execFileImpl: capture, cwd });
    if (r.ok) {
      try { return { ok: true, entries: parseListing(stdout) }; } catch (_) { return { ok: false, error: 'bad-json', detail: 'no JSON array' }; }
    }
    last = r;
    // A hang is not worth repeating with another copy of the same CLI.
    if (r.error === 'timeout') break;
  }
  return last || { ok: false, error: 'timeout', detail: 'deadline passed before a candidate ran' };
}

/**
 * The poller's default runner.
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function defaultRunOnce(timeoutMs) {
  return runAgentsListing(timeoutMs);
}

/**
 * Create the poller.
 * @param {object} [opts]
 * @param {(timeoutMs: number) => Promise<object>} [opts.runOnce] - Injectable for tests.
 * @param {number} [opts.pollMs]
 * @param {() => number} [opts.now]
 * @param {(entries: object[]) => (true|string)} [opts.sightCheck] - a listing that fails it counts as a failed poll
 * @returns {object}
 */
function createAgentsPoller(opts = {}) {
  const runOnce = opts.runOnce || defaultRunOnce;
  const pollMs = opts.pollMs || POLL_MS;
  const now = opts.now || Date.now;
  const sightCheck = typeof opts.sightCheck === 'function' ? opts.sightCheck : null;
  const watched = new Map();
  const listeners = new Set();
  // Conversations seen running as background sessions, lower case id to when (rule 6).
  const seenBackground = new Map();
  let blindWarned = false;
  let latest = null;
  let inFlight = null;
  let timer = null;
  let stopped = false;

  async function pollOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let r;
      try { r = await runOnce(TIMEOUT_MS); } catch (_) { r = { ok: false, error: 'exception' }; }
      if (r && r.ok && sightCheck) {
        let verdict = true;
        try { verdict = sightCheck(r.entries || []); } catch (_) { verdict = true; }
        if (verdict !== true) {
          if (!blindWarned) { blindWarned = true; warn('claude agents listing treated as failed:', String(verdict)); }
          r = { ok: false, error: 'blind', detail: String(verdict) };
        }
      }
      if (r && r.ok) {
        latest = { at: now(), entries: r.entries || [] };
        for (const e of latest.entries) if (isLiveBackground(e)) seenBackground.set(String(e.sessionId).toLowerCase(), latest.at);
        for (const [k, at] of seenBackground) if (latest.at - at > BACKGROUND_MEMORY_MS) seenBackground.delete(k);
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
    /**
     * Whether a conversation was seen running as a background session (rule 6:
     * one that later leaves the listing is asleep, not ended).
     * @param {string} upstreamId
     * @returns {boolean}
     */
    wasBackground(upstreamId) { return seenBackground.has(String(upstreamId || '').toLowerCase()); },
    /** @param {(l: object) => void} fn */
    onPoll(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Seed a listing (tests and fixtures). */
    _setLatest(l) { latest = l; },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = { createAgentsPoller, parseListing, normaliseEntry, runAgentsListing, isLiveBackground, isSleepingBackground, blindListingCheck, POLL_MS, ON_DEMAND_TTL_MS, BACKGROUND_MEMORY_MS };
