/**
 * push/payloads.js: APNs payload, header and collapse id builders.
 *
 * WHY: PROTOCOL.md 10.3 and 10.4 fix every word, category, header and
 * collapse id, and DESIGN-SPEC 19.1 is binding for the copy. Callers (B2, B3)
 * never build payloads; they hand notify() an event and this module turns it
 * into exactly what Apple receives. Payloads carry no message text unless the
 * device turned showMessageText on (A18).
 */
'use strict';

const crypto = require('crypto');

/** The app's bundle id and push topics (A22, PROTOCOL.md 10.4). */
const BUNDLE_ID = 'io.myrlin.workbook';
const TOPIC_ALERT = BUNDLE_ID;
const TOPIC_LIVE_ACTIVITY = BUNDLE_ID + '.push-type.liveactivity';
const TOPIC_WIDGETS = BUNDLE_ID + '.push-type.widgets';
/** Expiration windows. */
const HOUR_SECONDS = 3600;
const URGENT_EXPIRY_SECONDS = HOUR_SECONDS;
const NORMAL_EXPIRY_SECONDS = 6 * HOUR_SECONDS;
/** Priorities. */
const PRIORITY_HIGH = 10;
const PRIORITY_LOW = 5;
/** Characters of message text allowed in a body (DESIGN-SPEC 19.1). */
const MESSAGE_TEXT_MAX = 178;
/** Collapse id hash characters, and the byte cap. */
const COLLAPSE_HASH_CHARS = 22;
const COLLAPSE_MAX_BYTES = 64;
/** Live Activity limits (PROTOCOL.md 10.4, R07:238). */
const ACTIVITY_MAX_SESSIONS = 4;
const ACTIVITY_MAX_BYTES = 4096;
const ACTIVITY_STALE_SECONDS = 15 * 60;
/** Waiting states come first in a Live Activity. */
const WAITING_STATES = new Set(['needsAnswer', 'needsApproval']);
const RUNNING_STATES = new Set(['thinking', 'working', 'streaming', 'queued']);
/** Milliseconds per unit. */
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** Category per kind (PROTOCOL.md 10.2). */
const CATEGORY = Object.freeze({
  question: 'MYRLIN_QUESTION',
  approval: 'MYRLIN_APPROVAL',
  plan: 'MYRLIN_APPROVAL',
  finished: 'MYRLIN_FINISHED',
  limit: 'MYRLIN_LIMIT',
  swap: 'MYRLIN_SWAP',
  migration: 'MYRLIN_MIGRATION',
});

/** The wire enum Provider (defs.json) to the word DESIGN-SPEC 19.1 prints. */
const PROVIDER_WORDS = Object.freeze({ claude: 'Claude', codex: 'Codex' });

/** Kinds that wait on a person. */
const NEEDS_YOU = new Set(['question', 'approval', 'plan']);

/**
 * Provider word for the copy.
 *
 * @param {string} provider - claude or codex.
 * @returns {string}
 */
function providerWord(provider) {
  return PROVIDER_WORDS[provider] || PROVIDER_WORDS.claude;
}

/**
 * The collapse id: "<prefix>:" plus 22 characters of
 * base64url(SHA-256(cid + LF + key)), at most 64 bytes.
 *
 * @param {string} prefix - needs, done, limit, swap or mg.
 * @param {string} computerId - cid.
 * @param {string} key - Per kind key.
 * @returns {string}
 */
function collapseId(prefix, computerId, key) {
  const hash = crypto.createHash('sha256').update(computerId + '\n' + key).digest('base64url').slice(0, COLLAPSE_HASH_CHARS);
  return (prefix + ':' + hash).slice(0, COLLAPSE_MAX_BYTES);
}

/**
 * Glass's countdown format (DESIGN-SPEC 9.13): "3d 4h", "2h 05m", "12m",
 * "9m 41s", "41s"; seconds only in the last ten minutes.
 *
 * @param {number} ms - Remaining time.
 * @returns {string}
 */
function countdown(ms) {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (total >= 600) return m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

/**
 * Cut text to the body limit on a character boundary.
 *
 * @param {string} text - Text.
 * @returns {string}
 */
function cut(text) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return chars.length > MESSAGE_TEXT_MAX ? chars.slice(0, MESSAGE_TEXT_MAX - 1).join('') + '…' : chars.join('');
}

/**
 * The title for a session push, honouring hideSessionNames.
 *
 * @param {string} sessionTitle - Session name.
 * @param {object} prefs - Device preferences.
 * @param {string} computerName - Computer display name.
 * @returns {string}
 */
function sessionTitleFor(sessionTitle, prefs, computerName) {
  const hidden = 'A session on ' + computerName;
  if (prefs && prefs.privacy && prefs.privacy.hideSessionNames) return hidden;
  const t = String(sessionTitle || '').trim();
  return t || hidden;
}

/**
 * Whether the device's preferences allow a push of this kind.
 *
 * @param {object} event - notify event.
 * @param {object} prefs - Preferences.
 * @returns {boolean}
 */
function allowedByPreferences(event, prefs) {
  const n = (prefs && prefs.notifications) || {};
  switch (event.kind) {
    case 'question': return n.question !== false;
    case 'approval':
    case 'plan': return n.approval !== false;
    case 'finished':
      return n.finished !== false && Number(event.durationMs) >= (Number(n.finishedMinMinutes) || 2) * MS_PER_MINUTE;
    case 'limit': return n.accountThresholds !== false;
    case 'swap': return n.agentSwaps !== false;
    case 'migration': return n.migrationReady !== false;
    default: return true;
  }
}

/**
 * Build an alert push for one device (PROTOCOL.md 10.3). Returns null when the
 * device's preferences exclude it.
 *
 * @param {object} event - notify event.
 * @param {object} env - {computerId, computerName, prefs, badge, nowMs}.
 * @returns {{payload: object, pushType: string, topic: string, priority: number, expiration: number, collapseId: string|null}|null}
 */
function buildAlert(event, env) {
  const prefs = env.prefs || {};
  if (!allowedByPreferences(event, prefs)) return null;
  const nowMs = env.nowMs;
  const computer = env.computerName;
  const cid = env.computerId;
  const showText = !!(prefs.privacy && prefs.privacy.showMessageText);
  let title;
  let subtitle;
  let body;
  let collapse = null;
  let threadKey;
  const m = { v: 1, k: event.kind, cid, sid: null, pid: null, mid: null, acc: null, prov: null, ts: nowMs };

  switch (event.kind) {
    case 'question':
    case 'approval':
    case 'plan': {
      title = sessionTitleFor(event.sessionTitle, prefs, computer);
      subtitle = providerWord(event.provider) + ' on ' + computer;
      if (event.kind === 'question') body = showText && event.detailText ? cut(event.detailText) : 'Needs your answer.';
      else body = showText && event.detailText && event.kind === 'approval' ? cut(event.detailText) : 'Needs your approval.';
      collapse = collapseId('needs', cid, event.sessionId);
      m.sid = event.sessionId || null;
      m.pid = event.promptId || null;
      m.prov = event.provider || null;
      threadKey = event.sessionId;
      break;
    }
    case 'finished': {
      title = sessionTitleFor(event.sessionTitle, prefs, computer);
      subtitle = providerWord(event.provider) + ' on ' + computer;
      if (event.status === 'failed') {
        const words = String(event.errorWords || 'the turn failed').replace(/\.\s*$/, '');
        body = providerWord(event.provider) + ' stopped: ' + words + '.';
      } else {
        const minutes = Math.max(1, Math.round(Number(event.durationMs || 0) / MS_PER_MINUTE));
        body = 'Finished after ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.');
      }
      collapse = collapseId('done', cid, event.sessionId);
      m.sid = event.sessionId || null;
      m.prov = event.provider || null;
      threadKey = event.sessionId;
      break;
    }
    case 'limit': {
      title = providerWord(event.provider) + ' usage';
      subtitle = (event.accountDisplayName || 'Account') + ' on ' + computer;
      const left = countdown(Number(event.resetsAtMs || 0) - nowMs);
      const label = event.windowLabel || 'Usage';
      body = event.limited
        ? label + ' limit reached, resets in ' + left + '.'
        : label + ' limit at ' + Math.round(Number(event.percent || 0)) + '%, resets in ' + left + '.';
      collapse = collapseId('limit', cid, (event.provider || '') + ':' + (event.windowKey || ''));
      m.acc = event.accountId || null;
      m.prov = event.provider || null;
      threadKey = 'limit';
      break;
    }
    case 'swap': {
      title = providerWord(event.provider) + ' account switched';
      subtitle = 'on ' + computer;
      const who = event.agent || 'An agent';
      const reason = event.reason ? ': ' + String(event.reason).replace(/\.\s*$/, '') : '';
      body = who + ' switched ' + providerWord(event.provider) + ' to ' + (event.accountDisplayName || 'another account') + reason + '.';
      collapse = collapseId('swap', cid, event.provider || '');
      m.acc = event.accountId || null;
      m.prov = event.provider || null;
      threadKey = 'swap';
      break;
    }
    case 'migration': {
      title = sessionTitleFor(event.targetTitle, prefs, computer);
      subtitle = providerWord(event.provider) + ' on ' + computer;
      if (event.state === 'awaitingApproval') {
        body = 'Takeover report ready: ' + Number(event.claimsFailed || 0) + ' claims did not hold.';
      } else {
        body = 'Migration stopped: ' + (event.failedStepLabel || 'a step') + ' failed.';
      }
      collapse = collapseId('mg', cid, event.migrationId || '');
      m.sid = event.targetSessionId || null;
      m.mid = event.migrationId || null;
      m.prov = event.provider || null;
      threadKey = event.targetSessionId || 'migration';
      break;
    }
    case 'test': {
      title = 'Test from ' + computer + '.';
      subtitle = '';
      body = '';
      threadKey = 'test';
      m.k = 'finished';
      break;
    }
    default:
      return null;
  }

  const urgent = NEEDS_YOU.has(event.kind);
  const aps = {
    alert: { title, subtitle, body },
    sound: 'default',
    badge: Math.max(0, Number(env.badge) || 0),
    'thread-id': cid + ':' + threadKey,
    'interruption-level': urgent ? 'time-sensitive' : 'active',
  };
  if (CATEGORY[event.kind]) aps.category = CATEGORY[event.kind];
  return {
    payload: { aps, m },
    pushType: 'alert',
    topic: TOPIC_ALERT,
    priority: urgent ? PRIORITY_HIGH : PRIORITY_LOW,
    expiration: Math.floor(nowMs / MS_PER_SECOND) + (urgent ? URGENT_EXPIRY_SECONDS : NORMAL_EXPIRY_SECONDS),
    collapseId: collapse,
  };
}

/**
 * The background push that follows a resolved prompt (PROTOCOL.md 10.3).
 *
 * @param {object} event - {sessionId, promptId}.
 * @param {object} env - {computerId, badge, nowMs}.
 * @returns {object}
 */
function buildResolved(event, env) {
  return {
    payload: {
      aps: { 'content-available': 1, badge: Math.max(0, Number(env.badge) || 0) },
      m: { v: 1, k: 'resolved', cid: env.computerId, sid: event.sessionId || null, pid: event.promptId || null, mid: null, acc: null, prov: null, ts: env.nowMs },
    },
    pushType: 'background',
    topic: TOPIC_ALERT,
    priority: PRIORITY_LOW,
    expiration: Math.floor(env.nowMs / MS_PER_SECOND) + NORMAL_EXPIRY_SECONDS,
    collapseId: null,
  };
}

/**
 * Order and cut the Live Activity session list (PROTOCOL.md 10.4): running or
 * waiting only, waiting first, then by enteredAtMs, at most 4.
 *
 * @param {object[]} sessions - [{sessionId, title, provider, state, enteredAtMs}].
 * @param {object} prefs - Device preferences.
 * @param {string} computerName - Computer name.
 * @returns {object[]}
 */
function activitySessions(sessions, prefs, computerName) {
  return (sessions || [])
    .filter((s) => s && (WAITING_STATES.has(s.state) || RUNNING_STATES.has(s.state)))
    .sort((a, b) => (Number(WAITING_STATES.has(b.state)) - Number(WAITING_STATES.has(a.state))) || (a.enteredAtMs - b.enteredAtMs))
    .slice(0, ACTIVITY_MAX_SESSIONS)
    .map((s) => ({
      sessionId: s.sessionId,
      title: sessionTitleFor(s.title, prefs, computerName),
      provider: s.provider,
      state: s.state,
      enteredAtMs: s.enteredAtMs,
    }));
}

/**
 * Build a Live Activity push (start, update or end), kept under 4 KB by
 * shortening titles when needed.
 *
 * @param {'start'|'update'|'end'} kind - Activity event.
 * @param {object} event - The activity notify event.
 * @param {object} env - {computerId, computerName, prefs, nowMs}.
 * @returns {object}
 */
function buildActivity(kind, event, env) {
  const nowSec = Math.floor(env.nowMs / MS_PER_SECOND);
  let sessions = activitySessions(event.sessions, env.prefs, env.computerName);
  const urgent = sessions.length ? sessions[0].sessionId : null;
  const make = () => {
    const aps = {
      timestamp: nowSec,
      event: kind,
      'content-state': {
        computerName: env.computerName,
        sessions,
        urgentSessionId: kind === 'end' ? null : urgent,
        updatedAtMs: env.nowMs,
      },
      'stale-date': nowSec + ACTIVITY_STALE_SECONDS,
    };
    if (kind === 'end') aps['dismissal-date'] = nowSec + ACTIVITY_STALE_SECONDS;
    if (kind === 'start') {
      aps['attributes-type'] = 'MyrlinActivityAttributes';
      aps.attributes = { computerId: env.computerId };
    }
    return { aps };
  };
  let payload = make();
  let maxTitle = 120;
  while (Buffer.byteLength(JSON.stringify(payload)) >= ACTIVITY_MAX_BYTES && maxTitle > 8) {
    maxTitle = Math.floor(maxTitle / 2);
    sessions = sessions.map((s) => Object.assign({}, s, { title: Array.from(s.title).slice(0, maxTitle).join('') }));
    payload = make();
  }
  return {
    payload,
    pushType: 'liveactivity',
    topic: TOPIC_LIVE_ACTIVITY,
    priority: event.needsYouChanged ? PRIORITY_HIGH : PRIORITY_LOW,
    expiration: nowSec + NORMAL_EXPIRY_SECONDS,
    collapseId: null,
  };
}

/**
 * The WidgetKit reload push (PROTOCOL.md 10.4).
 *
 * @param {object} env - {nowMs}.
 * @returns {object}
 */
function buildWidgets(env) {
  return {
    payload: { aps: { 'content-changed': true } },
    pushType: 'widgets',
    topic: TOPIC_WIDGETS,
    priority: PRIORITY_LOW,
    expiration: Math.floor(env.nowMs / MS_PER_SECOND) + NORMAL_EXPIRY_SECONDS,
    collapseId: null,
  };
}

module.exports = {
  BUNDLE_ID,
  TOPIC_ALERT,
  TOPIC_LIVE_ACTIVITY,
  TOPIC_WIDGETS,
  CATEGORY,
  NEEDS_YOU,
  ACTIVITY_MAX_BYTES,
  collapseId,
  countdown,
  providerWord,
  allowedByPreferences,
  buildAlert,
  buildResolved,
  buildActivity,
  buildWidgets,
  activitySessions,
};
