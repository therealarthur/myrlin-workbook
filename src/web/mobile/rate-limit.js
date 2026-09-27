/**
 * rate-limit.js: the limiters of PROTOCOL.md section 2.12.
 *
 * WHY: Tailscale Serve proxies from loopback, so no limit may key on a client
 * address (critic F8 item e). Every limiter here keys on an offer, a device
 * key, a device id, a pair id or a global bucket, and hello and session for a
 * known device never share a bucket with pairing, so a flood of bad pair
 * attempts cannot lock a paired phone out.
 *
 * All limiters take an injectable clock so tests can move time.
 */
'use strict';

/** One minute in ms. */
const MINUTE_MS = 60 * 1000;
/** One hour in ms. */
const HOUR_MS = 60 * MINUTE_MS;
/** Ten minutes in ms. */
const TEN_MINUTES_MS = 10 * MINUTE_MS;
/** Idle buckets are forgotten after this long without a hit. */
const BUCKET_IDLE_FORGET_MS = 2 * HOUR_MS;
/** Sweep idle buckets at most this often. */
const SWEEP_EVERY_MS = 5 * MINUTE_MS;

/** The numbers of PROTOCOL.md 2.12. */
const LIMITS = Object.freeze({
  identityPerMinute: 120,
  pairPerKeyPerHour: 10,
  pairGlobalFailuresPer10Min: 30,
  pairOfferFailuresBurn: 5,
  pairPendingMax: 3,
  pairPollPerMinute: 120,
  helloPerDevicePerMinute: 30,
  helloGlobalPerMinute: 600,
  sessionPerDevicePerMinute: 30,
  sessionSigFailuresPer10Min: 10,
  sessionSigBlockMs: TEN_MINUTES_MS,
  deviceRatePerSecond: 20,
  deviceBurst: 100,
  sendPerMinute: 60,
  searchPerMinute: 30,
  uploadPerMinute: 600,
});

/**
 * A sliding window counter per key: at most `max` events in `windowMs`.
 */
class SlidingWindow {
  /**
   * @param {number} max - Events allowed per window.
   * @param {number} windowMs - Window length.
   * @param {Function} now - Clock.
   */
  constructor(max, windowMs, now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
    this.lastSweep = now();
  }

  /** Drop timestamps outside the window for one key. */
  _prune(key) {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = this.now() - this.windowMs;
    while (list.length && list[0] <= cutoff) list.shift();
    if (!list.length) this.hits.delete(key);
    return list;
  }

  /** Forget idle keys now and then so the maps stay small. */
  _sweep() {
    const t = this.now();
    if (t - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = t;
    for (const key of Array.from(this.hits.keys())) this._prune(key);
  }

  /**
   * How many events the key has in the current window.
   *
   * @param {string} key - Bucket key.
   * @returns {number}
   */
  count(key) {
    return this._prune(key).length;
  }

  /**
   * Whether the key is at its limit, without recording anything.
   *
   * @param {string} key - Bucket key.
   * @returns {{limited: boolean, retryAfterMs: number}}
   */
  peek(key) {
    const list = this._prune(key);
    if (list.length < this.max) return { limited: false, retryAfterMs: 0 };
    return { limited: true, retryAfterMs: Math.max(1, list[0] + this.windowMs - this.now()) };
  }

  /**
   * Record one event unless the key is at its limit.
   *
   * @param {string} key - Bucket key.
   * @returns {{limited: boolean, retryAfterMs: number}}
   */
  hit(key) {
    this._sweep();
    const state = this.peek(key);
    if (state.limited) return state;
    if (!this.hits.has(key)) this.hits.set(key, []);
    this.hits.get(key).push(this.now());
    return state;
  }

  /**
   * Record one event with no limit check (failure counters).
   *
   * @param {string} key - Bucket key.
   */
  record(key) {
    this._sweep();
    if (!this.hits.has(key)) this.hits.set(key, []);
    this.hits.get(key).push(this.now());
  }

  /** @param {string} key - Forget a key. */
  reset(key) {
    this.hits.delete(key);
  }
}

/**
 * A token bucket per key: `ratePerSecond` sustained, `burst` at once.
 */
class TokenBucket {
  /**
   * @param {number} ratePerSecond - Refill rate.
   * @param {number} burst - Capacity.
   * @param {Function} now - Clock.
   */
  constructor(ratePerSecond, burst, now) {
    this.rate = ratePerSecond;
    this.burst = burst;
    this.now = now;
    this.buckets = new Map();
  }

  /**
   * Take one token.
   *
   * @param {string} key - Bucket key.
   * @returns {{limited: boolean, retryAfterMs: number}}
   */
  hit(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { limited: false, retryAfterMs: 0 };
    }
    return { limited: true, retryAfterMs: Math.max(1, Math.ceil(((1 - b.tokens) / this.rate) * 1000)) };
  }
}

/**
 * Build every limiter of section 2.12.
 *
 * @param {object} [opts]
 * @param {Function} [opts.now] - Clock.
 * @returns {object} Limiters plus check(className, key) for the router.
 */
function createLimiters(opts) {
  const now = (opts && opts.now) || Date.now;
  const L = LIMITS;
  const lim = {
    now,
    identity: new SlidingWindow(L.identityPerMinute, MINUTE_MS, now),
    pairPerKey: new SlidingWindow(L.pairPerKeyPerHour, HOUR_MS, now),
    pairGlobalFailures: new SlidingWindow(L.pairGlobalFailuresPer10Min, TEN_MINUTES_MS, now),
    pairPoll: new SlidingWindow(L.pairPollPerMinute, MINUTE_MS, now),
    helloPerDevice: new SlidingWindow(L.helloPerDevicePerMinute, MINUTE_MS, now),
    helloGlobal: new SlidingWindow(L.helloGlobalPerMinute, MINUTE_MS, now),
    sessionPerDevice: new SlidingWindow(L.sessionPerDevicePerMinute, MINUTE_MS, now),
    sessionSigFailures: new SlidingWindow(L.sessionSigFailuresPer10Min, TEN_MINUTES_MS, now),
    sessionBlockedUntil: new Map(),
    device: new TokenBucket(L.deviceRatePerSecond, L.deviceBurst, now),
    send: new SlidingWindow(L.sendPerMinute, MINUTE_MS, now),
    search: new SlidingWindow(L.searchPerMinute, MINUTE_MS, now),
    upload: new SlidingWindow(L.uploadPerMinute, MINUTE_MS, now),
  };

  /**
   * The router's check for a route's limiter class. Classes whose order of
   * checks lives inside a handler (pair, hello, session) pass here.
   *
   * @param {string} className - Limiter class from the scope table.
   * @param {string} key - deviceId, pairId or "global".
   * @returns {{limited: boolean, retryAfterMs: number}}
   */
  lim.check = function check(className, key) {
    switch (className) {
      case 'identity': return lim.identity.hit('global');
      case 'pairPoll': return lim.pairPoll.hit(key);
      case 'device': return lim.device.hit(key);
      case 'send': {
        // Send routes also spend a device token: every authenticated route is
        // a device route first (the device bucket bounds the whole device).
        const d = lim.device.hit(key);
        if (d.limited) return d;
        return lim.send.hit(key);
      }
      case 'search': {
        const d = lim.device.hit(key);
        if (d.limited) return d;
        return lim.search.hit(key);
      }
      case 'upload': return lim.upload.hit(key);
      default: return { limited: false, retryAfterMs: 0 };
    }
  };

  /**
   * Whether a device's session route is blocked after signature failures.
   *
   * @param {string} deviceId - Device.
   * @returns {{limited: boolean, retryAfterMs: number}}
   */
  lim.sessionBlocked = function sessionBlocked(deviceId) {
    const until = lim.sessionBlockedUntil.get(deviceId) || 0;
    const t = now();
    if (until > t) return { limited: true, retryAfterMs: until - t };
    if (until) lim.sessionBlockedUntil.delete(deviceId);
    return { limited: false, retryAfterMs: 0 };
  };

  /**
   * Count a session signature failure; returns true when this failure
   * started a block (the caller writes the audit line).
   *
   * @param {string} deviceId - Device.
   * @returns {boolean}
   */
  lim.recordSessionSigFailure = function recordSessionSigFailure(deviceId) {
    lim.sessionSigFailures.record(deviceId);
    if (lim.sessionSigFailures.count(deviceId) >= L.sessionSigFailuresPer10Min) {
      lim.sessionBlockedUntil.set(deviceId, now() + L.sessionSigBlockMs);
      lim.sessionSigFailures.reset(deviceId);
      return true;
    }
    return false;
  };

  return lim;
}

module.exports = { LIMITS, SlidingWindow, TokenBucket, createLimiters, MINUTE_MS, HOUR_MS, TEN_MINUTES_MS };
