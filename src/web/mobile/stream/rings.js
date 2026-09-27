/**
 * Per topic sequence numbers, replay rings and the replay decision for the
 * mobile v2 stream (PROTOCOL.md 5.2, 5.3 and 5.5).
 *
 * What: every published event gets the next seq of its topic (1, 2, 3 ...
 * within one epoch, never reused) and is kept in a bounded ring (size per
 * topic kind, and at most 15 minutes old). decide() answers a subscribe with
 * live, replay (plus the events to resend) or resync (plus its reason).
 *
 * Why: the phone resumes a topic with sinceSeq after a reconnect and must
 * miss nothing inside the ring and learn explicitly when it cannot (critic
 * F12). Keeping this pure and separate from the socket layer makes the rules
 * of 5.5 testable without a WebSocket.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

/** Ring sizes by topic kind, PROTOCOL.md 5.2. */
const RING_SIZES = Object.freeze({
  computer: 64,
  device: 128,
  sessions: 512,
  session: 1024,
  tabs: 64,
  accounts: 32,
  migrations: 256,
});

/** Events older than this are dropped from every ring (PROTOCOL.md 5.2). */
const RING_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * The ring kind of a topic key ("session:cl_x" is "session", "device:d_x" is "device").
 * @param {string} key
 * @returns {string}
 */
function kindOf(key) {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
}

class TopicRings {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]
   * @param {object} [opts.sizes] - Override ring sizes (tests).
   * @param {number} [opts.maxAgeMs]
   */
  constructor({ now = Date.now, sizes = null, maxAgeMs = RING_MAX_AGE_MS } = {}) {
    this._now = now;
    this._sizes = Object.assign({}, RING_SIZES, sizes || {});
    this._maxAgeMs = maxAgeMs;
    /** @type {Map<string, {seq: number, events: Array<{seq:number, ts:number, type:string, data:object}>}>} */
    this._topics = new Map();
  }

  /**
   * @private
   * @param {string} key
   */
  _topic(key) {
    let t = this._topics.get(key);
    if (!t) {
      t = { seq: 0, events: [] };
      this._topics.set(key, t);
    }
    return t;
  }

  /**
   * Drop events beyond the ring size or older than the age limit.
   * @private
   * @param {string} key
   * @param {{events: Array}} t
   */
  _prune(key, t) {
    const size = this._sizes[kindOf(key)] || 256;
    while (t.events.length > size) t.events.shift();
    const cutoff = this._now() - this._maxAgeMs;
    while (t.events.length > 0 && t.events[0].ts < cutoff) t.events.shift();
  }

  /**
   * Store one event and return it with its seq.
   * @param {string} key - Topic key.
   * @param {string} type
   * @param {object} data
   * @returns {{seq: number, ts: number, type: string, data: object}}
   */
  append(key, type, data) {
    const t = this._topic(key);
    t.seq += 1;
    const ev = { seq: t.seq, ts: this._now(), type, data };
    t.events.push(ev);
    this._prune(key, t);
    return ev;
  }

  /**
   * Current seq of a topic (0 when nothing was published).
   * @param {string} key
   * @returns {number}
   */
  currentSeq(key) {
    const t = this._topics.get(key);
    return t ? t.seq : 0;
  }

  /**
   * Oldest seq still in the ring, or currentSeq + 1 when the ring is empty.
   * @param {string} key
   * @returns {number}
   */
  oldestSeq(key) {
    const t = this._topics.get(key);
    if (!t) return 1;
    this._prune(key, t);
    return t.events.length ? t.events[0].seq : t.seq + 1;
  }

  /**
   * The PROTOCOL.md 5.5 decision for one topic of a subscribe command.
   * @param {string} key
   * @param {{epochMatches: boolean|null, sinceSeq: (number|null)}} req
   *   epochMatches null means the phone sent no epoch.
   * @returns {{mode: 'live'|'replay'|'resync', reason: (string|null), events: Array, currentSeq: number}}
   */
  decide(key, { epochMatches, sinceSeq }) {
    const currentSeq = this.currentSeq(key);
    if (epochMatches === null || sinceSeq === null || sinceSeq === undefined) {
      return { mode: 'live', reason: null, events: [], currentSeq };
    }
    if (epochMatches === false) {
      return { mode: 'resync', reason: 'EPOCH_CHANGED', events: [], currentSeq };
    }
    if (sinceSeq === currentSeq) return { mode: 'live', reason: null, events: [], currentSeq };
    if (sinceSeq > currentSeq) return { mode: 'resync', reason: 'SEQ_AHEAD', events: [], currentSeq };
    const oldest = this.oldestSeq(key);
    if (sinceSeq < oldest - 1) return { mode: 'resync', reason: 'RING_EXPIRED', events: [], currentSeq };
    const t = this._topics.get(key);
    const events = t ? t.events.filter((e) => e.seq > sinceSeq) : [];
    return { mode: 'replay', reason: null, events, currentSeq };
  }
}

module.exports = { TopicRings, RING_SIZES, RING_MAX_AGE_MS, kindOf };
