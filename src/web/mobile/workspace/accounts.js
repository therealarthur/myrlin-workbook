/**
 * workspace/accounts.js: the phone's accounts and usage (PROTOCOL.md 3.11,
 * 4.11; decision A10; critic F18, F11, F30): snapshot building from Glass
 * or Workbook's own rosters, refresh with Glass's floors, swaps through
 * Workbook's apply paths with the Codex running confirm and Undo, sign in
 * through Glass, labels, the swap log, accounts.updated, limit and agent
 * swap pushes, and widgets notify events.
 *
 * WHY: Glass is the single usage poller (R01:404) and its /v1/status is the
 * phone's model; when Glass's API is not installed (today, E10) its
 * state.json and then Workbook's rosters stand in, translated with Glass's
 * own rules (severity at 75, 90, 100; rings; chips; Codex windows labelled
 * by their length in seconds, never by position, R01:312). Swaps go through
 * Workbook's existing apply transactions, as A10 decides, with Glass's
 * prechecks for Claude (Credential Manager flag, unreadable login files,
 * the renewal guard around the token expiry) and Glass's exact words for
 * every outcome (swap-words.js).
 *
 * Sandbox fixture mode (BUILD-CONTRACT 3.7.1 item 6): when CWM_DATA_DIR is
 * set to something other than the default data folder and
 * CWM_MOBILE_ACCOUNTS_FIXTURE names a JSON file holding an AccountsSnapshot
 * plus {"codexRunning": true|false}, the service serves and mutates that
 * snapshot in memory instead of calling Glass or the managers.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const common = require('./common');
const words = require('./swap-words');
const { createGlassClient } = require('./glass-client');

/** Severity thresholds (R01:154, DESIGN-SPEC 9.14). */
const WARN_AT = 75;
const CRITICAL_AT = 90;
const LIMITED_AT = 100;
/** Glass's stall rule: no publish for 3 minutes (R01:101). */
const STALL_MS = 3 * 60 * 1000;
/** accounts.updated at most this often (PROTOCOL.md 14). */
const PUBLISH_MIN_MS = 2000;
/** How often the rosters are checked for changes Workbook made. */
const WATCH_TICK_MS = 10 * 1000;
/** A built snapshot is reused this long by GET /accounts. */
const SNAPSHOT_TTL_MS = 2000;
/** Undo stays offered this long (PROTOCOL.md 4.11). */
const UNDO_MS = 5000;
/** Swap log length (PROTOCOL.md 3.11). */
const SWAP_LOG_MAX = 20;
/** clientRequestId idempotency window (PROTOCOL.md 0.7). */
const IDEMPOTENCY_MS = 10 * 60 * 1000;
/** An apply that runs longer than this answers SWAP_TIMEOUT. */
const APPLY_TIMEOUT_MS = 20 * 1000;
/** Glass's Claude renewal guard: 6 minutes each side of the expiry (swap.rs). */
const CLAUDE_EXPIRY_GUARD_MS = 6 * 60 * 1000;
/** Refresh floors (R01:168-173). */
const CLAUDE_GLOBAL_FLOOR_MS = 30 * 1000;
const CLAUDE_ACCOUNT_FLOOR_MS = 60 * 1000;
const CODEX_ACCOUNT_FLOOR_MS = 15 * 1000;
/** Workbook cache older than this counts as stale (two Claude poll intervals). */
const USAGE_STALE_MS = 20 * 60 * 1000;
/** Sign in flows are kept this long (PROTOCOL.md 4.11). */
const FLOW_KEEP_MS = 30 * 60 * 1000;
/** Codex window lengths in seconds. */
const FIVE_HOURS_S = 18000;
const WEEK_S = 604800;
/** Slack when inferring a Codex window from its reset horizon. */
const HORIZON_SLACK_S = 600;
/** Seconds per unit for window labels. */
const DAY_S = 86400;
const HOUR_S = 3600;
const MINUTE_S = 60;
/** Last active marks are written at most this often. */
const ACTIVITY_SAVE_MS = 60 * 1000;
/** Percent change that counts for a widgets push (PROTOCOL.md 10.4). */
const WIDGET_PERCENT_STEP = 1;
/**
 * How long a phone label change overrides Glass's copy: Glass re-reads the
 * pool files on its own schedule (publishes at least every 60 s, R01:178).
 */
const LABEL_OVERLAY_MS = 2 * 60 * 1000;
/** Default Codex process in fixture mode when the fixture names none. */
const FIXTURE_CODEX_PROCESS = Object.freeze({ pid: 4120, name: 'codex.exe', path: 'C:\\Program Files\\Codex\\codex.exe' });

/** Glass's swap effect words (PROTOCOL.md 3.11). */
const SWAP_EFFECT = Object.freeze({
  claude: 'Running Claude Code sessions follow within about a second.', // gsd:provider-literal-allowed (mobile v2 accounts)
  codex: 'New Codex processes use it; running ones keep the old account until restarted.', // gsd:provider-literal-allowed (mobile v2 accounts)
});
const PASSIVE_REASON = 'Workbook passive, switching paused';
/**
 * The reason a computer whose Glass runs monitor only shows (PROTOCOL.md
 * 4.11, critic F30), and how Glass words that mode (login.rs
 * monitor_only_reason, model.rs "no credential owner on this Mac").
 */
const MONITOR_ONLY_REASON = 'Swaps are not available on this computer.';
const GLASS_MONITOR_ONLY_RE = /monitor-only|no credential owner/i;
const ACCOUNT_STATES = ['ok', 'needsLogin', 'blocked', 'noSubscription', 'suspect', 'stale', 'expiring', 'unknown'];
const STALE_REASONS = ['usageOld', 'tokenRenewing', 'tokenExpired'];
const DATA_SOURCES = ['endpoint', 'statusline', 'workbookCache', 'none'];
const SWAP_SOURCES = ['ui', 'tray', 'agent', 'phone', 'workbook'];
const LOGIN_PHASES = ['starting', 'waitingForBrowser', 'importing', 'done', 'failed', 'cancelled'];

/**
 * Severity of a percent (R01:154).
 *
 * @param {number} percent - 0 to 100.
 * @param {boolean} [notAllowed] - The provider says not allowed.
 * @returns {string}
 */
function severityOf(percent, notAllowed) {
  if (notAllowed || percent >= LIMITED_AT) return 'limited';
  if (percent >= CRITICAL_AT) return 'critical';
  if (percent >= WARN_AT) return 'warn';
  return 'normal';
}

/**
 * Codex window label from its length (PROTOCOL.md 3.11): 18000 "5h",
 * 604800 "Weekly", else "Nd", "Nh" or "Nm".
 *
 * @param {number} seconds - Window length.
 * @returns {string}
 */
function labelForSeconds(seconds) {
  if (seconds === FIVE_HOURS_S) return '5h';
  if (seconds === WEEK_S) return 'Weekly';
  if (seconds % DAY_S === 0) return (seconds / DAY_S) + 'd';
  if (seconds % HOUR_S === 0) return (seconds / HOUR_S) + 'h';
  return Math.max(1, Math.round(seconds / MINUTE_S)) + 'm';
}

/**
 * Clamp and round a percent to an integer 0 to 100.
 *
 * @param {*} v - Number.
 * @returns {number}
 */
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Assign rings (PROTOCOL.md 3.11): Claude session outer and weekly inner;
 * otherwise the shortest window outer and the longest inner; one ring window
 * is "single"; scoped weeklies and every other window are "none".
 *
 * @param {string} provider - Provider.
 * @param {object[]} windows - Windows without ring (mutated).
 * @returns {object[]}
 */
function assignRings(provider, windows) {
  for (const w of windows) w.ring = 'none';
  let ringed;
  if (provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 accounts)
    ringed = windows.filter((w) => w.key === 'session' || w.key === 'weekly');
    if (ringed.length === 1) ringed[0].ring = 'single';
    else for (const w of ringed) w.ring = w.key === 'session' ? 'outer' : 'inner';
    return windows;
  }
  ringed = windows.filter((w) => !String(w.key).includes(':scoped'));
  if (ringed.length === 1) { ringed[0].ring = 'single'; return windows; }
  if (ringed.length > 1) {
    const sorted = ringed.slice().sort((a, b) => (a.windowSeconds || 0) - (b.windowSeconds || 0));
    sorted[0].ring = 'outer';
    sorted[sorted.length - 1].ring = 'inner';
  }
  return windows;
}

/**
 * A window's percent judged at now: past its reset it counts as 0.
 *
 * @param {object} w - Window.
 * @param {number} nowMs - Now.
 * @returns {number}
 */
function effectivePercent(w, nowMs) {
  if (w.resetsAtMs && w.resetsAtMs <= nowMs) return 0;
  return w.percent;
}

/**
 * 100 minus the worst ring window percent at now, or null with no windows.
 *
 * @param {object[]} windows - Windows with rings.
 * @param {number} nowMs - Now.
 * @returns {number|null}
 */
function headroomOf(windows, nowMs) {
  const ringed = windows.filter((w) => w.ring !== 'none');
  const pool = ringed.length ? ringed : windows;
  if (!pool.length) return null;
  return Math.max(0, 100 - Math.max(...pool.map((w) => effectivePercent(w, nowMs))));
}

/**
 * Glass's chip rule (R01:162).
 *
 * @param {string} state - Account state.
 * @param {string|null} staleReason - Stale reason.
 * @returns {string}
 */
function chipOf(state, staleReason) {
  if (state === 'blocked') return 'blocked';
  if (state === 'needsLogin' || (state === 'stale' && staleReason === 'tokenExpired')) return 'signIn';
  return 'usable';
}

/**
 * The display name: label, else the email's local part, else "Account".
 *
 * @param {string|null} label - Label.
 * @param {string|null} email - Email.
 * @returns {string}
 */
function displayNameOf(label, email) {
  if (label && String(label).trim()) return String(label).trim();
  if (email && String(email).includes('@')) return String(email).split('@')[0] || 'Account';
  if (email) return String(email);
  return 'Account';
}

/**
 * Claude plan words from subscriptionType and rateLimitTier (Glass pool.rs):
 * "max" plus "default_claude_max_20x" is "Max 20x"; others title cased.
 *
 * @param {string|null} sub - subscriptionType.
 * @param {string|null} tier - rateLimitTier.
 * @returns {string|null}
 */
function claudePlanName(sub, tier) {
  const s = typeof sub === 'string' ? sub.trim().toLowerCase() : '';
  if (!s) return null;
  if (s === 'max' && typeof tier === 'string') {
    const seg = tier.split(/[_-]/).reverse().find((x) => x.length >= 2 && /^[0-9]+x$/i.test(x));
    if (seg) return 'Max ' + seg.toLowerCase();
  }
  return s.split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Codex plan words (Glass pool.rs): "prolite" is "Pro Lite".
 *
 * @param {string|null} plan - plan_type.
 * @returns {string|null}
 */
function codexPlanName(plan) {
  const p = typeof plan === 'string' ? plan.trim().toLowerCase() : '';
  if (!p) return null;
  if (p === 'prolite') return 'Pro Lite';
  if (p === 'promax') return 'Pro Max';
  return p.split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Create the accounts service.
 *
 * @param {object} deps - {ctx, now, env, glass}
 * @returns {object}
 */
function createAccounts(deps) {
  const ctx = deps.ctx;
  const now = deps.now || Date.now;
  const env = deps.env || process.env;
  const log = common.logger(ctx);
  const glass = deps.glass || createGlassClient({ env, now, log });
  const dir = common.mobileDir(ctx);
  const swapLogFile = path.join(dir, 'swap-log.json');
  const activityFile = path.join(dir, 'accounts-activity.json');
  const alertsFile = path.join(dir, 'limit-alerts.json');

  let phoneLog = common.readJson(swapLogFile, { entries: [] }).entries || [];
  const activity = common.readJson(activityFile, {}) || {};
  let activitySavedAt = 0;
  const alertsDoc = common.readJson(alertsFile, null);
  const alerts = new Map(Object.entries((alertsDoc && alertsDoc.alerts) || {}));
  let alertsBaseline = !!alertsDoc;
  let lastSnapshot = null;
  let lastBuiltAt = 0;
  let lastPublished = null;
  let lastPublishAt = 0;
  let publishTimer = null;
  let pendingReason = null;
  let swapping = false;
  const done = new Map();
  const flows = new Map();
  const refreshMarks = new Map();
  /** provider:accountId -> {label, atMs}: phone renames Glass has not published yet. */
  const labelOverlay = new Map();
  let lastClaudeRefreshAt = 0;
  let seenAgentSwaps = null;
  const stops = [];

  // ── Fixture mode ────────────────────────────────────────────────────────

  const fixture = loadFixture();

  /**
   * The sandbox fixture, when fixture mode applies (never on the default
   * data folder).
   *
   * @returns {object|null} {snapshot, codexRunning, codexProcesses}
   */
  function loadFixture() {
    const file = env.CWM_MOBILE_ACCOUNTS_FIXTURE;
    const dataDir = env.CWM_DATA_DIR;
    if (!file || !dataDir) return null;
    const defaultDir = path.join(os.homedir(), '.myrlin');
    if (common.normalizePath(path.resolve(dataDir)) === common.normalizePath(defaultDir)) {
      log('accounts fixture refused: CWM_DATA_DIR is the default data folder');
      return null;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const snap = raw && raw.accounts && raw.accounts.providers ? raw.accounts : raw;
      if (!snap || !Array.isArray(snap.providers)) throw new Error('no providers');
      log('accounts fixture mode on');
      return {
        snapshot: JSON.parse(JSON.stringify(snap)),
        codexRunning: raw.codexRunning === true,
        codexProcesses: Array.isArray(raw.codexProcesses) ? raw.codexProcesses : [FIXTURE_CODEX_PROCESS],
      };
    } catch (err) {
      log('accounts fixture unreadable: ' + (err && err.message));
      return null;
    }
  }

  // ── Normalization of Glass accounts ─────────────────────────────────────

  /**
   * An Account from a Glass AgentAccount (R01 section 4.4).
   *
   * @param {object} a - AgentAccount.
   * @param {number} nowMs - Now.
   * @returns {object}
   */
  function fromGlassAccount(a, nowMs) {
    const provider = a.provider === 'codex' ? 'codex' : 'claude'; // gsd:provider-literal-allowed (mobile v2 accounts)
    const windows = (Array.isArray(a.windows) ? a.windows : []).map((w) => {
      const percent = pct(w.percent);
      return {
        key: String(w.key || 'window'),
        label: String(w.label || 'Window'),
        percent,
        resetsAtMs: Number.isFinite(w.resetsAtMs) ? w.resetsAtMs : common.toMs(w.resetsAt),
        windowSeconds: Number.isFinite(w.windowSeconds) ? w.windowSeconds : null,
        severity: ['normal', 'warn', 'critical', 'limited'].includes(w.severity) ? w.severity : severityOf(percent),
      };
    });
    assignRings(provider, windows);
    const state = ACCOUNT_STATES.includes(a.state) ? a.state : 'unknown';
    const staleReason = STALE_REASONS.includes(a.staleReason) ? a.staleReason : null;
    const email = typeof a.email === 'string' && a.email ? a.email : null;
    const label = typeof a.label === 'string' && a.label ? a.label.slice(0, 60) : null;
    return {
      provider,
      accountId: String(a.id),
      email,
      label,
      displayName: displayNameOf(label, email),
      plan: typeof a.plan === 'string' && a.plan ? a.plan : null,
      active: a.active === true,
      state,
      stateDetail: typeof a.stateDetail === 'string' ? a.stateDetail : null,
      staleReason,
      windows,
      asOfMs: Number.isFinite(a.asOfMs) ? a.asOfMs : common.toMs(a.asOf),
      dataSource: DATA_SOURCES.includes(a.source) ? a.source : 'none',
      reloginInDays: Number.isFinite(a.reloginInDays) ? Math.max(0, Math.floor(a.reloginInDays)) : null,
      headroom: Number.isFinite(a.headroom) ? pct(a.headroom) : headroomOf(windows, nowMs),
      swappable: state !== 'needsLogin' && state !== 'blocked',
      chip: chipOf(state, staleReason),
      lastActiveAtMs: null,
    };
  }

  // ── Workbook rosters (fallback) ─────────────────────────────────────────

  /**
   * Claude windows from Workbook's cached usage: limits[] first, else the
   * five_hour, seven_day and per model weekly windows.
   *
   * @param {object|null} usage - Stored usage.
   * @returns {object[]}
   */
  function claudeWindows(usage) {
    const out = [];
    if (!usage || typeof usage !== 'object') return out;
    const push = (key, label, percent, resetsAt, seconds) => {
      if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) return;
      const pc = pct(percent);
      out.push({ key, label, percent: pc, resetsAtMs: common.toMs(resetsAt), windowSeconds: seconds, severity: severityOf(pc) });
    };
    if (Array.isArray(usage.limits) && usage.limits.length) {
      for (const l of usage.limits) {
        if (l.kind === 'session') push('session', 'Session', l.percent, l.resets_at, FIVE_HOURS_S);
        else if (l.kind === 'weekly_all') push('weekly', 'Weekly', l.percent, l.resets_at, WEEK_S);
        else if (l.kind === 'weekly_scoped' && (l.model || l.scope)) push('weekly:' + (l.model || l.scope), 'Weekly ' + (l.model || l.scope), l.percent, l.resets_at, WEEK_S);
      }
      if (out.length) return out;
    }
    const w = (x) => (x && typeof x === 'object' ? x : null);
    if (w(usage.five_hour)) push('session', 'Session', usage.five_hour.utilization, usage.five_hour.resets_at, FIVE_HOURS_S);
    if (w(usage.seven_day)) push('weekly', 'Weekly', usage.seven_day.utilization, usage.seven_day.resets_at, WEEK_S);
    if (w(usage.seven_day_opus)) push('weekly:Opus', 'Weekly Opus', usage.seven_day_opus.utilization, usage.seven_day_opus.resets_at, WEEK_S);
    if (w(usage.seven_day_sonnet)) push('weekly:Sonnet', 'Weekly Sonnet', usage.seven_day_sonnet.utilization, usage.seven_day_sonnet.resets_at, WEEK_S);
    return out;
  }

  /**
   * The length of a cached Codex window in seconds, never by position:
   * an explicit length on the cached window when present; else, for the
   * live account, the window_minutes Codex wrote in its newest rollout;
   * else the reset horizon (a reset further away than 5 hours cannot be the
   * 5 hour window); two windows are the 5 hour and the weekly windows.
   *
   * @param {object} win - Cached window {utilization, resets_at, ...}.
   * @param {string} slot - five_hour or seven_day (the cache's position).
   * @param {object} usage - The whole cached usage.
   * @param {object|null} live - The live rollout rate limits of this account.
   * @returns {number}
   */
  function codexSeconds(win, slot, usage, live) {
    for (const k of ['limit_window_seconds', 'window_seconds', 'windowSeconds']) {
      if (Number.isFinite(win[k]) && win[k] > 0) return win[k];
    }
    if (live) {
      const lw = slot === 'five_hour' ? live.primary : live.secondary;
      if (lw && Number.isFinite(lw.windowMinutes) && lw.windowMinutes > 0) return lw.windowMinutes * MINUTE_S;
    }
    const both = usage.five_hour && usage.seven_day;
    if (both) return slot === 'five_hour' ? FIVE_HOURS_S : WEEK_S;
    const fetched = common.toMs(usage.fetchedAt) || now();
    const reset = common.toMs(win.resets_at);
    if (reset && (reset - fetched) / 1000 > FIVE_HOURS_S + HORIZON_SLACK_S) return WEEK_S;
    return slot === 'seven_day' ? WEEK_S : FIVE_HOURS_S;
  }

  /**
   * Codex windows from Workbook's cache, labelled by length (A10).
   *
   * @param {object|null} usage - Stored usage.
   * @param {object|null} live - Live rollout rate limits (active account only).
   * @returns {object[]}
   */
  function codexWindows(usage, live) {
    const out = [];
    if (!usage || typeof usage !== 'object') return out;
    for (const slot of ['five_hour', 'seven_day']) {
      const win = usage[slot];
      if (!win || typeof win !== 'object' || !Number.isFinite(Number(win.utilization))) continue;
      const seconds = codexSeconds(win, slot, usage, live);
      const percent = pct(win.utilization);
      out.push({ key: 'codex:' + seconds, label: labelForSeconds(seconds), percent, resetsAtMs: common.toMs(win.resets_at), windowSeconds: seconds, severity: severityOf(percent) });
    }
    return out;
  }

  /**
   * The live Codex rollout rate limits (window lengths), or null.
   *
   * @returns {object|null}
   */
  function liveCodexLimits() {
    try {
      const reg = ctx.registry;
      const prov = reg && typeof reg.get === 'function' ? reg.get('codex') : null; // gsd:provider-literal-allowed (mobile v2 accounts)
      const snap = prov && typeof prov.getUsageSnapshot === 'function' ? prov.getUsageSnapshot() : null;
      if (snap && typeof snap.then === 'function') return null;
      return snap && snap.rateLimits ? snap.rateLimits : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Account state from a roster row (Glass's first match wins, R01:158).
   *
   * @param {object} row - Safe roster row.
   * @param {object[]} windows - Its windows.
   * @param {number} nowMs - Now.
   * @param {boolean} codex - Codex row.
   * @returns {{state: string, staleReason: (string|null), stateDetail: (string|null)}}
   */
  function rosterState(row, windows, nowMs, codex) {
    const err = row.lastRefreshError || row.lastError || null;
    const kind = err && typeof err === 'object' ? String(err.kind || err.code || '') : String(err || '');
    if (row.tokenDead === true || row.tokenState === 'needs_login') return { state: 'needsLogin', staleReason: null, stateDetail: null };
    if (/blocked|org_disabled|organization/i.test(kind)) return { state: 'blocked', staleReason: null, stateDetail: null };
    if (codex && /^free$/i.test(String(row.plan || ''))) return { state: 'noSubscription', staleReason: null, stateDetail: null };
    if (/no.?sub/i.test(String(row.label || ''))) return { state: 'noSubscription', staleReason: null, stateDetail: null };
    if (row.health === 'suspect' || row.health === 'auth_suspect') return { state: 'suspect', staleReason: null, stateDetail: null };
    if (codex && row.accessExpired === true && !row.isActive) return { state: 'stale', staleReason: 'tokenExpired', stateDetail: null };
    const fetched = row.usage && row.usage.fetchedAt ? common.toMs(row.usage.fetchedAt) : null;
    if (!windows.length || !fetched) return { state: 'unknown', staleReason: null, stateDetail: null };
    if (nowMs - fetched > USAGE_STALE_MS) return { state: 'stale', staleReason: 'usageOld', stateDetail: null };
    return { state: 'ok', staleReason: null, stateDetail: null };
  }

  /**
   * An Account from a Workbook roster row.
   *
   * @param {string} provider - Provider.
   * @param {object} row - Safe roster row.
   * @param {number} nowMs - Now.
   * @param {object|null} live - Live Codex limits.
   * @returns {object}
   */
  function fromRoster(provider, row, nowMs, live) {
    const codex = provider === 'codex'; // gsd:provider-literal-allowed (mobile v2 accounts)
    const id = codex ? row.accountId : row.profileId;
    const windows = codex ? codexWindows(row.usage, row.isActive ? live : null) : claudeWindows(row.usage);
    assignRings(provider, windows);
    const st = rosterState(row, windows, nowMs, codex);
    const email = typeof row.email === 'string' && row.email ? row.email : null;
    const label = typeof row.label === 'string' && row.label ? row.label.slice(0, 60) : null;
    return {
      provider,
      accountId: String(id),
      email,
      label,
      displayName: displayNameOf(label, email),
      plan: codex ? codexPlanName(row.plan || (row.usage && row.usage.plan_type)) : claudePlanName(row.subscriptionType, row.rateLimitTier),
      active: row.isActive === true,
      state: st.state,
      stateDetail: st.stateDetail,
      staleReason: st.staleReason,
      windows,
      asOfMs: row.usage && row.usage.fetchedAt ? common.toMs(row.usage.fetchedAt) : null,
      dataSource: windows.length ? 'workbookCache' : 'none',
      reloginInDays: null,
      headroom: headroomOf(windows, nowMs),
      swappable: st.state !== 'needsLogin' && st.state !== 'blocked',
      chip: chipOf(st.state, st.staleReason),
      lastActiveAtMs: null,
    };
  }

  /** @returns {object|null} the Claude safe roster, or null */
  function claudeRoster() {
    const m = ctx.credentialManager;
    try { return m && typeof m.getSafeList === 'function' ? m.getSafeList() : null; } catch (err) { log('claude roster failed: ' + (err && err.code)); return null; }
  }

  /** @returns {object|null} the Codex safe roster, or null */
  function codexRoster() {
    const m = ctx.codexAccountManager;
    try { return m && typeof m.getSafeList === 'function' ? m.getSafeList() : null; } catch (err) { log('codex roster failed: ' + (err && err.code)); return null; }
  }

  /** @returns {boolean} Workbook's credential pool is in passive, read only mode */
  function passive() {
    const m = ctx.credentialManager;
    try { return !!(m && typeof m.isCredentialPoolReadOnly === 'function' && m.isCredentialPoolReadOnly()); } catch (_) { return false; }
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /**
   * Accounts sorted (PROTOCOL.md 3.11): active first, then last active
   * descending (nulls last), then email.
   *
   * @param {object[]} list - Accounts.
   * @returns {object[]}
   */
  function sortAccounts(list) {
    return list.sort((a, b) => Number(b.active) - Number(a.active) || ((b.lastActiveAtMs || -1) - (a.lastActiveAtMs || -1)) || String(a.email || a.accountId).localeCompare(String(b.email || b.accountId)));
  }

  /**
   * Record when accounts are active (the phone's "3 most recent" chips).
   *
   * @param {object[]} accounts - Accounts.
   * @param {number} nowMs - Now.
   */
  function noteActive(accounts, nowMs) {
    let changed = false;
    for (const a of accounts) {
      if (!a.active) continue;
      const k = a.provider + ':' + a.accountId;
      if (!activity[k] || nowMs - activity[k] > ACTIVITY_SAVE_MS) { activity[k] = nowMs; changed = true; }
    }
    if (changed && nowMs - activitySavedAt > ACTIVITY_SAVE_MS) {
      activitySavedAt = nowMs;
      try { common.writeJson(activityFile, activity); } catch (_) { /* best effort */ }
    }
    for (const a of accounts) {
      const k = a.provider + ':' + a.accountId;
      a.lastActiveAtMs = a.active ? nowMs : (activity[k] || null);
    }
  }

  /**
   * Swap log entries from Glass (R01:106) merged with the phone's own.
   *
   * @param {object[]} glassLog - Glass SwapLogEntry list.
   * @returns {object[]}
   */
  function mergedSwapLog(glassLog) {
    const fromGlass = (Array.isArray(glassLog) ? glassLog : []).filter((e) => e && Number.isFinite(e.atMs) && e.slot == null).map((e) => ({
      atMs: e.atMs,
      provider: e.provider === 'codex' ? 'codex' : 'claude', // gsd:provider-literal-allowed (mobile v2 accounts)
      accountId: String(e.toId || e.to || 'account'),
      accountLabel: e.to ? String(e.to) : null,
      source: SWAP_SOURCES.includes(e.source) ? e.source : 'ui',
      requester: e.requester ? String(e.requester) : null,
      reason: e.reason ? String(e.reason) : null,
      ok: e.ok === true,
    }));
    return fromGlass.concat(phoneLog).sort((a, b) => b.atMs - a.atMs).slice(0, SWAP_LOG_MAX);
  }

  /**
   * Services (read only, PROTOCOL.md 3.11) from Glass's services state.
   *
   * @param {object|null} sv - Glass ServicesState.
   * @returns {object|null}
   */
  function servicesOf(sv) {
    if (!sv || sv.configured !== true || !Array.isArray(sv.slots) || !sv.slots.length) return null;
    const parked = sv.vault && Number.isFinite(sv.vault.parked) ? sv.vault.parked : 0;
    const warnN = Array.isArray(sv.warnings) ? sv.warnings.length : 0;
    const summary = parked + ' parked' + (warnN ? ' \u00b7 ' + warnN + ' warning' + (warnN === 1 ? '' : 's') : '');
    const nowMs = now();
    const slots = sv.slots.filter((s) => s && s.slotId).map((s) => {
      const windows = (Array.isArray(s.windows) ? s.windows : []).map((w) => {
        const percent = pct(w.percent);
        return { key: String(w.key || 'window'), label: String(w.label || 'Window'), percent, resetsAtMs: Number.isFinite(w.resetsAtMs) ? w.resetsAtMs : null, windowSeconds: Number.isFinite(w.windowSeconds) ? w.windowSeconds : null, severity: severityOf(percent), ring: 'none' };
      });
      const worst = windows.length ? Math.max(...windows.map((w) => effectivePercent(w, nowMs))) : null;
      return { slotId: String(s.slotId), name: String(s.displayName || s.slotId), severity: worst === null ? 'normal' : severityOf(worst), percent: worst, windows, detail: s.healthText || s.consumers || null };
    });
    return { summary, slots };
  }

  /**
   * Build the snapshot from whichever source is available.
   *
   * @param {object|null} status - A fresh Glass /v1/status, if fetched.
   * @returns {object} AccountsSnapshot.
   */
  function build(status) {
    const nowMs = now();
    if (fixture) {
      // Fixture mode: the fixture's snapshot, as the swaps left it.
      const snap = JSON.parse(JSON.stringify(fixture.snapshot));
      snap.generatedAtMs = nowMs;
      snap.swapLog = (Array.isArray(snap.swapLog) ? snap.swapLog : []).slice().sort((a, b) => b.atMs - a.atMs).slice(0, SWAP_LOG_MAX);
      return snap;
    }
    let source = 'workbook';
    let payload = status;
    let stateAge = glass.stateFileAgeMs();
    if (!payload) {
      const st = glass.readStateFile();
      if (st) { payload = st.payload; stateAge = st.ageMs; }
    }
    const byProvider = { claude: [], codex: [] }; // gsd:provider-literal-allowed (mobile v2 accounts)
    let swapsEnabled = !passive();
    let swapsDisabledReason = swapsEnabled ? null : PASSIVE_REASON;
    let stalledSinceAtMs = null;
    let glassLog = [];
    let services = null;
    if (payload) {
      source = 'glass';
      for (const a of payload.accounts) {
        if (!a || !common.AGENT_PROVIDERS.includes(a.provider)) continue;
        byProvider[a.provider].push(fromGlassAccount(a, nowMs));
      }
      glassLog = payload.swapLog || [];
      services = servicesOf(payload.services);
      if (Number.isFinite(payload.generatedAtMs) && nowMs - payload.generatedAtMs > STALL_MS) stalledSinceAtMs = payload.generatedAtMs;
      if (swapsEnabled && payload.swapsEnabled === false && payload.swapsDisabledReason && !/^Workbook (offline|is in passive|passive)/.test(payload.swapsDisabledReason)) {
        swapsEnabled = false;
        // A monitor only Glass (the Mac) cannot swap on this computer at all.
        swapsDisabledReason = GLASS_MONITOR_ONLY_RE.test(String(payload.swapsDisabledReason)) ? MONITOR_ONLY_REASON : String(payload.swapsDisabledReason);
      }
    } else {
      const live = liveCodexLimits();
      const cr = claudeRoster();
      for (const row of (cr && cr.profiles) || []) if (row && row.profileId) byProvider.claude.push(fromRoster('claude', row, nowMs, null)); // gsd:provider-literal-allowed (mobile v2 accounts)
      const xr = codexRoster();
      for (const row of (xr && xr.accounts) || []) if (row && row.accountId) byProvider.codex.push(fromRoster('codex', row, nowMs, live)); // gsd:provider-literal-allowed (mobile v2 accounts)
    }
    if (source === 'glass') applyLabelOverlay(byProvider, nowMs);
    const providers = ['claude', 'codex'].map((provider) => { // gsd:provider-literal-allowed (mobile v2 accounts)
      const accounts = byProvider[provider];
      noteActive(accounts, nowMs);
      sortAccounts(accounts);
      const active = accounts.find((a) => a.active) || null;
      return { provider, activeAccountId: active ? active.accountId : null, swapEffect: SWAP_EFFECT[provider], recommendation: null, accounts };
    });
    return {
      source,
      generatedAtMs: nowMs,
      stalledSinceAtMs,
      swapsEnabled,
      swapsDisabledReason,
      glass: { apiAvailable: glass.apiUp(), stateFileAgeMs: stateAge === null || stateAge === undefined ? null : Math.round(stateAge) },
      providers,
      swapLog: mergedSwapLog(glassLog),
      services,
      _glassPayload: payload || null,
    };
  }

  /**
   * Apply phone renames Glass has not published yet (Glass reads the pool
   * files on its own schedule). An entry ends when Glass shows the same
   * label or after LABEL_OVERLAY_MS.
   *
   * @param {object} byProvider - {claude: Account[], codex: Account[]} (mutated).
   * @param {number} nowMs - Now.
   */
  function applyLabelOverlay(byProvider, nowMs) {
    for (const [k, o] of labelOverlay) {
      const cut = k.indexOf(':');
      const provider = k.slice(0, cut);
      const accountId = k.slice(cut + 1);
      const acc = (byProvider[provider] || []).find((a) => a.accountId === accountId);
      if (nowMs - o.atMs > LABEL_OVERLAY_MS || (acc && acc.label === o.label)) { labelOverlay.delete(k); continue; }
      if (acc) { acc.label = o.label; acc.displayName = displayNameOf(o.label, acc.email); }
    }
  }

  /**
   * Add Glass's recommendation where it applies: source glass and the
   * provider's active account at warn or worse (PROTOCOL.md 3.11).
   *
   * @param {object} snap - Snapshot (mutated).
   * @returns {Promise<void>}
   */
  async function addRecommendations(snap) {
    if (snap.source !== 'glass' || !glass.apiUp()) return;
    const nowMs = now();
    for (const pr of snap.providers) {
      const active = pr.accounts.find((a) => a.active);
      if (!active) continue;
      const worst = active.windows.filter((w) => w.ring !== 'none').reduce((m, w) => Math.max(m, effectivePercent(w, nowMs)), 0);
      if (worst < WARN_AT && active.state !== 'blocked') continue;
      const rec = await glass.recommend(pr.provider).catch(() => null);
      if (rec && rec.best && rec.best.id && rec.best.id !== active.accountId) {
        pr.recommendation = { accountId: String(rec.best.id), displayName: displayNameOf(rec.best.label, rec.best.email), reason: String(rec.reason || '') };
      }
    }
  }

  /**
   * Build (or reuse) the current snapshot; asks Glass when installed.
   *
   * @param {boolean} [force] - Ignore the reuse window.
   * @returns {Promise<object>} AccountsSnapshot (with private fields).
   */
  async function refreshSnapshot(force) {
    if (!force && lastSnapshot && now() - lastBuiltAt < SNAPSHOT_TTL_MS) return lastSnapshot;
    let status = null;
    if (!fixture) status = await glass.status().catch(() => null);
    const snap = build(status);
    await addRecommendations(snap).catch(() => {});
    observe(snap);
    lastSnapshot = snap;
    lastBuiltAt = now();
    return snap;
  }

  /**
   * The snapshot without private fields (the wire shape).
   *
   * @param {object} snap - Snapshot.
   * @returns {object}
   */
  function publicSnapshot(snap) {
    const out = Object.assign({}, snap);
    delete out._glassPayload;
    return out;
  }

  /**
   * workspace.accounts.snapshot (BUILD-CONTRACT 3.4.4): the latest built
   * snapshot, built at once from the files when none exists yet.
   *
   * @returns {object} AccountsSnapshot.
   */
  function snapshot() {
    if (!lastSnapshot) {
      lastSnapshot = build(null);
      lastBuiltAt = now();
    }
    return publicSnapshot(lastSnapshot);
  }

  // ── Change detection: accounts.updated, pushes ──────────────────────────

  /**
   * A comparable key of a snapshot (time fields removed).
   *
   * @param {object} snap - Snapshot.
   * @returns {string}
   */
  function keyOf(snap) {
    const s = publicSnapshot(snap);
    return JSON.stringify(Object.assign({}, s, { generatedAtMs: 0, glass: { apiAvailable: s.glass.apiAvailable, stateFileAgeMs: null }, providers: s.providers.map((p) => Object.assign({}, p, { accounts: p.accounts.map((a) => Object.assign({}, a, { lastActiveAtMs: a.active ? 0 : a.lastActiveAtMs })) })) }));
  }

  /**
   * Make sure a baseline snapshot was observed, so the next change is
   * published (a phone action may come before the first watcher tick).
   */
  function ensureBaseline() {
    if (lastPublished) return;
    const snap = build(null);
    observe(snap);
    lastSnapshot = snap;
    lastBuiltAt = now();
  }

  /**
   * React to a new snapshot: limit pushes, agent swap pushes and notices,
   * widgets pushes (the change rules of PROTOCOL.md 10), accounts.updated.
   *
   * @param {object} snap - Snapshot.
   */
  function observe(snap) {
    limitAlerts(snap);
    agentSwaps(snap);
    const prev = lastPublished;
    const key = keyOf(snap);
    if (prev && prev.key === key) return;
    if (prev && widgetWorthy(prev.snap, snap)) common.notify(ctx, { kind: 'widgets' });
    lastPublished = { key, snap };
    if (prev) schedulePublish(pendingReason || 'other');
  }

  /**
   * Whether a change is worth a widgets push: any percent moved by at least
   * 1, or any account state changed (PROTOCOL.md 10.4).
   *
   * @param {object} a - Previous snapshot.
   * @param {object} b - New snapshot.
   * @returns {boolean}
   */
  function widgetWorthy(a, b) {
    const index = (s) => {
      const m = new Map();
      for (const p of s.providers) for (const acc of p.accounts) m.set(p.provider + ':' + acc.accountId, acc);
      return m;
    };
    const ia = index(a);
    const ib = index(b);
    if (ia.size !== ib.size) return true;
    for (const [k, acc] of ib) {
      const old = ia.get(k);
      if (!old || old.state !== acc.state || old.active !== acc.active) return true;
      for (const w of acc.windows) {
        const ow = old.windows.find((x) => x.key === w.key);
        if (!ow || Math.abs(ow.percent - w.percent) >= WIDGET_PERCENT_STEP) return true;
      }
    }
    return false;
  }

  /**
   * Publish accounts.updated at most once per 2 s (PROTOCOL.md 5.4).
   *
   * @param {string} reason - refresh, swap, agentSwap, login, label or other.
   */
  function schedulePublish(reason) {
    pendingReason = reason;
    if (publishTimer) return;
    const wait = Math.max(0, PUBLISH_MIN_MS - (now() - lastPublishAt));
    publishTimer = setTimeout(() => {
      publishTimer = null;
      lastPublishAt = now();
      const r = pendingReason || 'other';
      pendingReason = null;
      common.publish(ctx, 'accounts', 'accounts.updated', { accounts: snapshot(), reason: r });
    }, wait);
    if (publishTimer.unref) publishTimer.unref();
  }

  /**
   * Limit pushes: the active account's ring window crosses 75, crosses 90
   * or becomes limited, once per window per threshold per reset period
   * (PROTOCOL.md 10.2 MYRLIN_LIMIT). The first run records a baseline.
   *
   * @param {object} snap - Snapshot.
   */
  function limitAlerts(snap) {
    const nowMs = now();
    let changed = false;
    for (const pr of snap.providers) {
      const active = pr.accounts.find((a) => a.active);
      if (!active) continue;
      for (const w of active.windows) {
        if (w.ring === 'none') continue;
        const p = effectivePercent(w, nowMs);
        const level = w.severity === 'limited' || p >= LIMITED_AT ? 3 : (p >= CRITICAL_AT ? 2 : (p >= WARN_AT ? 1 : 0));
        const k = pr.provider + ':' + active.accountId + ':' + w.key + ':' + (w.resetsAtMs || 0);
        const had = alerts.has(k) ? alerts.get(k) : 0;
        if (level > had) {
          alerts.set(k, level);
          changed = true;
          if (alertsBaseline) {
            common.notify(ctx, { kind: 'limit', provider: pr.provider, accountId: active.accountId, accountDisplayName: active.displayName, windowKey: w.key, windowLabel: w.label, percent: p, resetsAtMs: w.resetsAtMs || null, limited: level === 3 });
          }
        }
      }
    }
    // Forget alerts of windows that reset.
    for (const k of Array.from(alerts.keys())) {
      const reset = Number(k.split(':').pop());
      if (reset && reset < nowMs) { alerts.delete(k); changed = true; }
    }
    if (changed || !alertsBaseline) {
      alertsBaseline = true;
      const out = {};
      for (const [k, v] of alerts) out[k] = v;
      try { common.writeJson(alertsFile, { alerts: out }); } catch (_) { /* best effort */ }
    }
  }

  /**
   * Agent swaps seen in Glass's log: a MYRLIN_SWAP push and an AGENT_SWAP
   * notice for each new one (PROTOCOL.md 3.13, 10.2). The first log seen is
   * the baseline.
   *
   * @param {object} snap - Snapshot.
   */
  function agentSwaps(snap) {
    const payload = snap._glassPayload;
    const entries = payload && Array.isArray(payload.swapLog) ? payload.swapLog.filter((e) => e && e.source === 'agent' && e.slot == null) : [];
    const keys = new Set(entries.map((e) => e.atMs + ':' + (e.toId || e.to)));
    if (seenAgentSwaps === null) { seenAgentSwaps = keys; return; }
    for (const e of entries) {
      const k = e.atMs + ':' + (e.toId || e.to);
      if (seenAgentSwaps.has(k)) continue;
      seenAgentSwaps.add(k);
      if (e.ok !== true) continue;
      const provider = e.provider === 'codex' ? 'codex' : 'claude'; // gsd:provider-literal-allowed (mobile v2 accounts)
      common.notify(ctx, { kind: 'swap', provider, accountId: String(e.toId || e.to || ''), accountDisplayName: String(e.to || 'an account'), agent: e.requester || 'an agent', reason: e.reason || null });
      const hub = ctx.mobile && ctx.mobile.hub;
      if (hub && typeof hub.publishNotice === 'function') {
        try {
          hub.publishNotice({ noticeId: 'n_swap_' + common.sha8(k), level: 'info', code: 'AGENT_SWAP', message: words.agentSwapNotice({ provider, to: e.to, requester: e.requester, reason: e.reason }), accountId: String(e.toId || e.to || '') || null });
        } catch (_) { /* notice is best effort */ }
      }
      pendingReason = 'agentSwap';
    }
  }

  // ── Swap ────────────────────────────────────────────────────────────────

  /**
   * Throw a swap failure in Glass's words (swap-words.js).
   *
   * @param {string} code - Outcome code.
   * @param {object} vars - Words variables.
   * @param {object} [extra] - Extra body fields.
   * @returns {never}
   */
  function refuse(code, vars, extra) {
    const o = words.outcome(code, Object.assign({ computerName: computerName() }, vars));
    let more = extra;
    // SWAPS_PAUSED always names its reason (PROTOCOL.md 13), also when the
    // pause came back from an apply call rather than from the snapshot.
    if (o.code === 'SWAPS_PAUSED' && !(more && typeof more.reason === 'string')) more = Object.assign({}, more || {}, { reason: o.message.replace(/\.$/, '') });
    common.fail(o.code || 'SWAP_FAILED', o.message, more);
  }

  /** @returns {string} this computer's name for sentences */
  function computerName() {
    try {
      const m = ctx.mobile || {};
      if (typeof m.computerName === 'function') return m.computerName();
    } catch (_) { /* fall through */ }
    return os.hostname();
  }

  /**
   * Glass's Claude prechecks (swap.rs claude_swap_block_reason): the
   * Credential Manager flag, unreadable login files, a missing token file,
   * and the renewal guard around the live token's expiry.
   *
   * @param {string} name - Target display name.
   */
  function claudePrechecks(name) {
    const m = ctx.credentialManager;
    if (!m) return;
    let claudeJson = null;
    let jsonState = 'missing';
    try {
      if (m.claudeJsonPath && fs.existsSync(m.claudeJsonPath)) {
        jsonState = 'unreadable';
        const text = fs.readFileSync(m.claudeJsonPath, 'utf8').replace(/^\uFEFF/, '');
        claudeJson = JSON.parse(text);
        jsonState = 'ok';
      }
    } catch (_) {
      jsonState = 'unreadable';
    }
    const credman = !!(claudeJson && claudeJson.cachedGrowthBookFeatures && claudeJson.cachedGrowthBookFeatures.tengu_windows_credman === true);
    if (credman) refuse('CREDMAN', { name, provider: 'claude' }); // gsd:provider-literal-allowed (mobile v2 accounts)
    if (jsonState === 'unreadable') refuse('FILES_BUSY', { name, provider: 'claude' }, { retryAfterMs: 5000 }); // gsd:provider-literal-allowed (mobile v2 accounts)
    const credFile = m.claudeDir ? path.join(m.claudeDir, '.credentials.json') : null;
    if (credFile && !fs.existsSync(credFile)) {
      common.fail('SWAP_REFUSED', 'No ~/.claude/.credentials.json on ' + computerName() + ', so Claude swaps are off.');
    }
    let live = null;
    try { live = typeof m.readActiveCredential === 'function' ? m.readActiveCredential() : null; } catch (_) { live = null; }
    if (credFile && fs.existsSync(credFile) && !live) refuse('FILES_BUSY', { name, provider: 'claude' }, { retryAfterMs: 5000 }); // gsd:provider-literal-allowed (mobile v2 accounts)
    const exp = live && live.oauth ? Number(live.oauth.expiresAt) : NaN;
    if (Number.isFinite(exp)) {
      const t = now();
      if (t >= exp - CLAUDE_EXPIRY_GUARD_MS && t < exp + CLAUDE_EXPIRY_GUARD_MS) {
        const waitMs = exp + CLAUDE_EXPIRY_GUARD_MS - t;
        refuse('RENEWAL_GUARD', { name, provider: 'claude', minutes: Math.max(1, Math.ceil(waitMs / 60000)) }, { retryAfterMs: waitMs }); // gsd:provider-literal-allowed (mobile v2 accounts)
      }
    }
  }

  /**
   * Run a promise with a timeout that rejects with code TIMEOUT.
   *
   * @param {Promise} p - Work.
   * @param {number} ms - Timeout.
   * @returns {Promise}
   */
  function withTimeout(p, ms) {
    let timer;
    const t = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); if (timer.unref) timer.unref(); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  /**
   * Append to the phone swap log (source phone, requester phone:<deviceId>).
   *
   * @param {object} e - {provider, accountId, accountLabel, requester, reason, ok}.
   */
  function logSwap(e) {
    phoneLog.unshift(Object.assign({ atMs: now(), source: 'phone' }, e));
    phoneLog = phoneLog.slice(0, SWAP_LOG_MAX);
    try { common.writeJson(swapLogFile, { entries: phoneLog }); } catch (_) { /* best effort */ }
  }

  /**
   * POST /accounts/swap (PROTOCOL.md 4.11).
   *
   * @param {object} body - SwapRequest.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {Promise<object>} SwapResult.
   */
  async function swap(body, who) {
    const b = body && typeof body === 'object' ? body : {};
    if (!common.AGENT_PROVIDERS.includes(b.provider)) common.fail('INVALID_FIELD', 'provider is claude or codex.', { field: 'provider' });
    if (typeof b.accountId !== 'string' || !b.accountId) common.fail('INVALID_FIELD', 'accountId is required.', { field: 'accountId' });
    if (b.force !== undefined && typeof b.force !== 'boolean') common.fail('INVALID_FIELD', 'force is true or false.', { field: 'force' });
    const reason = ['user', 'undo', 'best'].includes(b.reason) ? b.reason : 'user';
    const idem = typeof b.clientRequestId === 'string' ? 'swap|' + b.clientRequestId : null;
    if (idem && done.has(idem) && now() - done.get(idem).at <= IDEMPOTENCY_MS) return done.get(idem).result;
    if (swapping) common.fail('SWAP_IN_PROGRESS', 'Another switch is running.');
    ensureBaseline();
    swapping = true;
    try {
      const result = fixture ? swapFixture(b, reason, who) : await swapReal(b, reason, who);
      if (idem) done.set(idem, { at: now(), result });
      for (const [k, v] of done) if (now() - v.at > IDEMPOTENCY_MS) done.delete(k);
      common.audit(ctx, { deviceId: who && who.deviceId, action: 'swap', sessionId: null, detail: b.provider + ' ' + reason, ok: true });
      return result;
    } catch (err) {
      common.audit(ctx, { deviceId: who && who.deviceId, action: 'swap', sessionId: null, detail: b.provider + ' ' + ((err && err.code) || 'failed'), ok: false });
      throw err;
    } finally {
      swapping = false;
    }
  }

  /**
   * The account and the provider entry of a snapshot.
   *
   * @param {object} snap - Snapshot.
   * @param {string} provider - Provider.
   * @param {string} accountId - Account id.
   * @returns {{pr: object, acc: (object|null), prev: (object|null)}}
   */
  function find(snap, provider, accountId) {
    const pr = snap.providers.find((x) => x.provider === provider);
    const acc = pr ? pr.accounts.find((a) => a.accountId === accountId) || null : null;
    const prev = pr ? pr.accounts.find((a) => a.active) || null : null;
    return { pr, acc, prev };
  }

  /**
   * The SwapResult of a done swap.
   *
   * @param {object} o - Fields.
   * @returns {object}
   */
  function swapResult(o) {
    const undoOk = o.prev && o.prev.swappable && o.prev.accountId !== o.acc.accountId;
    return {
      ok: true,
      alreadyActive: !!o.alreadyActive,
      provider: o.provider,
      activeAccountId: o.acc.accountId,
      previousAccountId: o.alreadyActive ? null : (o.prev ? o.prev.accountId : null),
      message: o.message,
      restartNote: o.restartNote || null,
      runningProcesses: o.runningProcesses || [],
      undo: !o.alreadyActive && undoOk ? { accountId: o.prev.accountId, expiresAtMs: now() + UNDO_MS } : null,
    };
  }

  /**
   * A swap in fixture mode: flips active in memory (BUILD-CONTRACT 3.7.1).
   *
   * @param {object} b - Request.
   * @param {string} reason - Reason.
   * @param {object} who - Caller.
   * @returns {object} SwapResult.
   */
  function swapFixture(b, reason, who) {
    const snap = fixture.snapshot;
    if (snap.swapsEnabled === false) common.fail('SWAPS_PAUSED', words.period(snap.swapsDisabledReason || 'Switching paused'), { reason: snap.swapsDisabledReason || 'Switching paused' });
    const { pr, acc, prev } = find(snap, b.provider, b.accountId);
    if (!acc) refuse('ACCT_NOT_FOUND', { name: b.accountId, provider: b.provider });
    if (acc.state === 'needsLogin') refuse('NEEDS_LOGIN', { name: acc.displayName, provider: b.provider });
    if (acc.state === 'blocked') common.fail('ACCOUNT_NOT_SWAPPABLE', acc.displayName + ' is blocked.');
    if (acc.active) return swapResult({ provider: b.provider, acc, prev, alreadyActive: true, message: words.outcome('ALREADY_ACTIVE', { name: acc.displayName }).message });
    if (b.provider === 'codex' && fixture.codexRunning && b.force !== true) { // gsd:provider-literal-allowed (mobile v2 accounts)
      common.fail('CODEX_RUNNING', words.period('Codex is running (' + fixture.codexProcesses.length + '). It keeps the old account until restarted. Swap anyway?'), { processes: fixture.codexProcesses });
    }
    for (const a of pr.accounts) a.active = a.accountId === acc.accountId;
    pr.activeAccountId = acc.accountId;
    const k = b.provider + ':' + acc.accountId;
    activity[k] = now();
    if (prev) activity[b.provider + ':' + prev.accountId] = now();
    pr.accounts.forEach((a) => { a.lastActiveAtMs = activity[b.provider + ':' + a.accountId] || a.lastActiveAtMs || null; });
    sortAccounts(pr.accounts);
    const entry = { atMs: now(), provider: b.provider, accountId: acc.accountId, accountLabel: acc.displayName, source: 'phone', requester: 'phone:' + ((who && who.deviceId) || 'unknown'), reason: reason === 'user' ? null : reason, ok: true };
    snap.swapLog = [entry].concat(Array.isArray(snap.swapLog) ? snap.swapLog : []).slice(0, SWAP_LOG_MAX);
    const running = b.provider === 'codex' && fixture.codexRunning ? fixture.codexProcesses : []; // gsd:provider-literal-allowed (mobile v2 accounts)
    const message = words.outcome(b.provider === 'codex' ? 'OK_CODEX' : 'OK_CLAUDE', { name: acc.displayName }).message; // gsd:provider-literal-allowed (mobile v2 accounts)
    lastSnapshot = null;
    pendingReason = 'swap';
    refreshSnapshot(true).catch(() => {});
    return swapResult({ provider: b.provider, acc, prev, message, runningProcesses: running });
  }

  /**
   * A real swap through Workbook's apply paths (A10).
   *
   * @param {object} b - Request.
   * @param {string} reason - Reason.
   * @param {object} who - Caller.
   * @returns {Promise<object>} SwapResult.
   */
  async function swapReal(b, reason, who) {
    const snap = await refreshSnapshot(true);
    if (!snap.swapsEnabled) {
      const r = snap.swapsDisabledReason || 'Switching paused';
      if (r === PASSIVE_REASON) refuse('PASSIVE', { name: b.accountId, provider: b.provider }, { reason: r });
      common.fail('SWAPS_PAUSED', words.period(r), { reason: r });
    }
    const { acc, prev } = find(snap, b.provider, b.accountId);
    if (!acc) refuse('ACCT_NOT_FOUND', { name: b.accountId, provider: b.provider });
    const name = acc.displayName;
    if (acc.state === 'needsLogin') refuse('NEEDS_LOGIN', { name, provider: b.provider });
    if (acc.state === 'blocked') common.fail('ACCOUNT_NOT_SWAPPABLE', words.period(name + ' is blocked' + (acc.stateDetail ? ': ' + acc.stateDetail : '')));
    const requester = 'phone:' + ((who && who.deviceId) || 'unknown');
    const attempt = { provider: b.provider, accountId: acc.accountId, accountLabel: name, requester, reason: reason === 'user' ? null : reason };
    if (acc.active) {
      return swapResult({ provider: b.provider, acc, prev, alreadyActive: true, message: words.outcome('ALREADY_ACTIVE', { name }).message });
    }
    let running = [];
    try {
      if (b.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 accounts)
        claudePrechecks(name);
        const m = ctx.credentialManager;
        if (!m || typeof m.applyCredential !== 'function') refuse('UNREACHABLE', { name, provider: b.provider });
        const r = await withTimeout(m.applyCredential(acc.accountId), APPLY_TIMEOUT_MS);
        if (r && r.alreadyActive) return swapResult({ provider: b.provider, acc, prev, alreadyActive: true, message: words.outcome('ALREADY_ACTIVE', { name }).message });
        // The desktop hears it as it hears its own apply (credential-routes.js
        // POST /api/credentials/apply): credentials:changed, ids and email only.
        if (r && r.applied) common.broadcast(ctx, 'credentials:changed', { activeProfileId: acc.accountId, email: r.email || '', appliedAt: new Date(now()).toISOString(), mac: { attempted: false, mirrored: false } });
        const liveId = typeof m.getActiveAccountUuid === 'function' ? m.getActiveAccountUuid() : acc.accountId;
        if (liveId && liveId !== acc.accountId) {
          const other = (typeof m.getActiveEmail === 'function' && m.getActiveEmail()) || liveId;
          refuse('IDENTITY_MISMATCH', { name, provider: b.provider, other });
        }
      } else {
        const m = ctx.codexAccountManager;
        if (!m || typeof m.applyAccount !== 'function') refuse('UNREACHABLE', { name, provider: b.provider });
        let r;
        try {
          r = await withTimeout(m.applyAccount(acc.accountId, { force: b.force === true }), APPLY_TIMEOUT_MS);
        } catch (err) {
          if (err && Array.isArray(err.processes)) {
            const procs = err.processes.map((x) => ({ pid: Number(x.pid) || 0, name: String(x.name || 'codex'), path: String(x.path || '') })); // gsd:provider-literal-allowed (mobile v2 accounts)
            common.fail('CODEX_RUNNING', words.period('Codex is running (' + procs.length + '). It keeps the old account until restarted. Swap anyway?'), { processes: procs });
          }
          throw err;
        }
        if (r && r.alreadyActive) return swapResult({ provider: b.provider, acc, prev, alreadyActive: true, message: words.outcome('ALREADY_ACTIVE', { name }).message });
        // As provider-account-routes.js POST .../apply: provider-accounts:changed.
        if (r && r.applied) common.broadcast(ctx, 'provider-accounts:changed', { providerId: 'codex', activeAccountId: acc.accountId, email: r.email || '', appliedAt: new Date(now()).toISOString() }); // gsd:provider-literal-allowed (mobile v2 accounts)
        running = Array.isArray(r && r.runningProcesses) ? r.runningProcesses : [];
        const liveId = typeof m.getActiveAccountId === 'function' ? m.getActiveAccountId() : acc.accountId;
        if (liveId && liveId !== acc.accountId) refuse('IDENTITY_MISMATCH', { name, provider: b.provider, other: liveId });
      }
    } catch (err) {
      if (err && err.name === 'MobileError') {
        if (err.code !== 'CODEX_RUNNING') logSwap(Object.assign({}, attempt, { ok: false }));
        throw err;
      }
      logSwap(Object.assign({}, attempt, { ok: false }));
      refuse(err && err.code ? err.code : 'FAILED', { name, provider: b.provider, message: err && err.message ? String(err.message) : '' });
    }
    logSwap(Object.assign({}, attempt, { ok: true }));
    activity[b.provider + ':' + acc.accountId] = now();
    if (prev) activity[b.provider + ':' + prev.accountId] = now();
    try { common.writeJson(activityFile, activity); } catch (_) { /* best effort */ }
    pendingReason = 'swap';
    refreshSnapshot(true).catch(() => {});
    const message = words.outcome(b.provider === 'codex' ? 'OK_CODEX' : 'OK_CLAUDE', { name }).message; // gsd:provider-literal-allowed (mobile v2 accounts)
    return swapResult({ provider: b.provider, acc, prev, message, runningProcesses: running });
  }

  // ── Refresh ─────────────────────────────────────────────────────────────

  /**
   * POST /accounts/refresh (PROTOCOL.md 4.11): Glass's /v1/refresh when
   * Glass runs, else Workbook's usage refresh within Glass's floors.
   *
   * @param {object} body - {provider|null}.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function refresh(body) {
    const provider = body && body.provider !== undefined && body.provider !== null ? body.provider : null;
    if (provider !== null && !common.AGENT_PROVIDERS.includes(provider)) common.fail('INVALID_FIELD', 'provider is claude, codex or null.', { field: 'provider' });
    ensureBaseline();
    if (fixture) return { ok: true, message: 'Refreshing usage.' };
    if (glass.installed()) {
      const r = await glass.refresh(provider);
      if (r && r.status >= 200 && r.status < 300) {
        pendingReason = 'refresh';
        setTimeout(() => refreshSnapshot(true).catch(() => {}), 1500).unref();
        return { ok: true, message: r.body && r.body.message ? words.period(String(r.body.message)) : 'Refreshing usage.' };
      }
    }
    const t = now();
    const jobs = [];
    const claudeWanted = provider === null || provider === 'claude'; // gsd:provider-literal-allowed (mobile v2 accounts)
    const codexWanted = provider === null || provider === 'codex'; // gsd:provider-literal-allowed (mobile v2 accounts)
    const snap = snapshot();
    if (claudeWanted && ctx.credentialManager && t - lastClaudeRefreshAt >= CLAUDE_GLOBAL_FLOOR_MS) {
      const pr = snap.providers.find((x) => x.provider === 'claude'); // gsd:provider-literal-allowed (mobile v2 accounts)
      const candidates = ((pr && pr.accounts) || []).filter((a) => a.state !== 'needsLogin' && t - (refreshMarks.get('claude:' + a.accountId) || 0) >= CLAUDE_ACCOUNT_FLOOR_MS);
      candidates.sort((a, b) => Number(b.active) - Number(a.active) || (a.asOfMs || 0) - (b.asOfMs || 0));
      const pick = candidates[0];
      if (pick) {
        lastClaudeRefreshAt = t;
        refreshMarks.set('claude:' + pick.accountId, t);
        jobs.push(Promise.resolve().then(() => ctx.credentialManager.updateSnapshotUsage(pick.accountId, { force: true })));
      }
    }
    if (codexWanted && ctx.codexAccountManager) {
      const pr = snap.providers.find((x) => x.provider === 'codex'); // gsd:provider-literal-allowed (mobile v2 accounts)
      for (const a of (pr && pr.accounts) || []) {
        if (a.state === 'needsLogin' || t - (refreshMarks.get('codex:' + a.accountId) || 0) < CODEX_ACCOUNT_FLOOR_MS) continue;
        refreshMarks.set('codex:' + a.accountId, t);
        jobs.push(Promise.resolve().then(() => ctx.codexAccountManager.updateSnapshotUsage(a.accountId, { force: true })));
      }
    }
    if (!jobs.length) return { ok: true, message: 'Refreshed recently. Numbers update within a minute.' };
    Promise.allSettled(jobs).then(() => { pendingReason = 'refresh'; return refreshSnapshot(true); }).catch(() => {});
    return { ok: true, message: 'Refreshing usage.' };
  }

  // ── Sign in ─────────────────────────────────────────────────────────────

  /**
   * A LoginFlow from Glass's LoginStatus (PROTOCOL.md 4.11), with the
   * computer named in the waiting line (DESIGN-SPEC 9.12 group G).
   *
   * @param {object} s - Glass login status.
   * @param {string} provider - Provider.
   * @returns {object}
   */
  function flowOf(s, provider) {
    const phase = LOGIN_PHASES.includes(s.phase) ? s.phase : 'starting';
    let message = String(s.message || '');
    if (phase === 'waitingForBrowser' && /in your browser\.?$/.test(message)) message = message.replace(/\.?$/, '') + ' on ' + computerName();
    return {
      flowId: String(s.flowId),
      provider: common.AGENT_PROVIDERS.includes(s.provider) ? s.provider : provider,
      phase,
      message: words.period(message || 'Opening a sign-in'),
      warning: s.warning === true,
      updatedAtMs: Number.isFinite(s.updatedAtMs) ? s.updatedAtMs : now(),
      done: s.done === true || ['done', 'failed', 'cancelled'].includes(phase),
    };
  }

  /**
   * POST /accounts/login (PROTOCOL.md 4.11): Glass's isolated sign in.
   *
   * @param {object} body - LoginRequest.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {Promise<object>} LoginFlow (202).
   */
  async function login(body, who) {
    const b = body && typeof body === 'object' ? body : {};
    if (!common.AGENT_PROVIDERS.includes(b.provider)) common.fail('INVALID_FIELD', 'provider is claude or codex.', { field: 'provider' });
    const idem = typeof b.clientRequestId === 'string' ? 'login|' + b.clientRequestId : null;
    if (idem && done.has(idem) && now() - done.get(idem).at <= IDEMPOTENCY_MS) return done.get(idem).result;
    for (const [id, f] of flows) {
      if (f.provider === b.provider && !f.flow.done && now() - f.at < FLOW_KEEP_MS) {
        common.fail('LOGIN_IN_PROGRESS', 'Another ' + words.PROVIDER_WORD[b.provider] + ' sign-in is running.', { flowId: id });
      }
    }
    if (fixture || !glass.installed()) common.fail('GLASS_UNAVAILABLE', 'Sign in from Myrlin Glass on ' + computerName() + '.');
    let email = null;
    if (typeof b.accountId === 'string' && b.accountId) {
      const { acc } = find(snapshot(), b.provider, b.accountId);
      if (!acc) common.fail('ACCOUNT_NOT_FOUND', 'That account is not known on ' + computerName() + '.');
      email = acc.email || acc.accountId;
    }
    const r = await glass.login(b.provider, email);
    if (!r) common.fail('GLASS_UNAVAILABLE', 'Sign in from Myrlin Glass on ' + computerName() + '.');
    if (r.status === 409) {
      const msg = r.body && (r.body.message || r.body.error) ? String(r.body.message || r.body.error) : 'Another ' + words.PROVIDER_WORD[b.provider] + ' sign-in is running';
      common.fail('LOGIN_IN_PROGRESS', words.period(msg), { flowId: r.body && r.body.flowId ? String(r.body.flowId) : null });
    }
    if (r.status < 200 || r.status >= 300 || !r.body || !r.body.flowId) common.fail('GLASS_UNAVAILABLE', 'Sign in from Myrlin Glass on ' + computerName() + '.');
    const flow = flowOf({ flowId: r.body.flowId, provider: b.provider, phase: 'waitingForBrowser', message: r.body.message || ('Finish signing in to ' + words.PROVIDER_WORD[b.provider] + ' in your browser'), warning: false, updatedAtMs: now(), done: false }, b.provider);
    flows.set(flow.flowId, { provider: b.provider, at: now(), flow });
    if (idem) done.set(idem, { at: now(), result: flow });
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'accountLogin', sessionId: null, detail: b.provider, ok: true });
    return flow;
  }

  /**
   * GET /accounts/login/:flowId.
   *
   * @param {string} flowId - Flow id.
   * @returns {Promise<object>} LoginFlow.
   */
  async function loginStatus(flowId) {
    const f = flows.get(flowId);
    if (!f || now() - f.at > FLOW_KEEP_MS) common.fail('LOGIN_FLOW_NOT_FOUND', 'That sign in is not known on ' + computerName() + '.');
    if (f.flow.done) return f.flow;
    const r = await glass.loginStatus(flowId);
    if (r && r.status === 200 && r.body) {
      const was = f.flow.phase;
      f.flow = flowOf(r.body, f.provider);
      if (f.flow.phase === 'done' && was !== 'done') { pendingReason = 'login'; refreshSnapshot(true).catch(() => {}); }
    } else if (r && r.status === 404) {
      f.flow = Object.assign({}, f.flow, { phase: 'failed', message: 'Sign-in failed.', done: true, updatedAtMs: now() });
    }
    return f.flow;
  }

  /**
   * POST /accounts/login/:flowId/cancel: Glass's /v1 has no cancel route
   * yet (R01:286-296), so this answers LOGIN_CANCEL_UNSUPPORTED.
   *
   * @param {string} flowId - Flow id.
   * @returns {never}
   */
  function loginCancel(flowId) {
    const f = flows.get(flowId);
    if (!f || now() - f.at > FLOW_KEEP_MS) common.fail('LOGIN_FLOW_NOT_FOUND', 'That sign in is not known on ' + computerName() + '.');
    if (f.flow.done || f.flow.phase === 'importing') common.fail('LOGIN_TOO_LATE', 'That sign in already finished.');
    common.fail('LOGIN_CANCEL_UNSUPPORTED', 'Close the sign in window on ' + computerName() + ' to cancel.');
  }

  // ── Labels ──────────────────────────────────────────────────────────────

  /**
   * PUT /accounts/:provider/:accountId/label (PROTOCOL.md 4.11).
   *
   * @param {string} provider - Provider.
   * @param {string} accountId - Account id.
   * @param {object} body - {label}.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {Promise<object>} Account.
   */
  async function setLabel(provider, accountId, body, who) {
    if (!common.AGENT_PROVIDERS.includes(provider)) common.fail('ACCOUNT_NOT_FOUND', 'That account is not known on ' + computerName() + '.');
    const raw = body && body.label;
    if (typeof raw !== 'string' || /[\r\n]/.test(raw) || raw.trim().length > 60) common.fail('INVALID_FIELD', 'A label is one line of at most 60 characters.', { field: 'label' });
    const label = raw.trim();
    ensureBaseline();
    if (fixture) {
      const { acc } = find(fixture.snapshot, provider, accountId);
      if (!acc) common.fail('ACCOUNT_NOT_FOUND', 'That account is not known on ' + computerName() + '.');
      acc.label = label || null;
      acc.displayName = displayNameOf(acc.label, acc.email);
    } else {
      const m = provider === 'codex' ? ctx.codexAccountManager : ctx.credentialManager; // gsd:provider-literal-allowed (mobile v2 accounts)
      if (!m || typeof m.setLabel !== 'function') common.fail('ACCOUNT_NOT_FOUND', 'That account is not known on ' + computerName() + '.');
      try {
        await m.setLabel(accountId, label);
        // The desktop's own label routes broadcast these (credential-routes.js,
        // provider-account-routes.js); the phone's rename reaches it the same way.
        if (provider === 'codex') common.broadcast(ctx, 'provider-accounts:changed', { providerId: 'codex', renamed: true, accountId }); // gsd:provider-literal-allowed (mobile v2 accounts)
        else common.broadcast(ctx, 'credentials:changed', { renamed: true, profileId: accountId });
      } catch (err) {
        if (err && /NOT_FOUND|VALIDATION/.test(String(err.code))) common.fail('ACCOUNT_NOT_FOUND', 'That account is not known on ' + computerName() + '.');
        if (err && /EXTERNAL_OWNER/.test(String(err.code))) common.fail('INTERNAL', 'Workbook is in passive mode, so account labels cannot change here.');
        throw err;
      }
    }
    if (!fixture) labelOverlay.set(provider + ':' + accountId, { label: label || null, atMs: now() });
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'accountLabel', sessionId: null, detail: provider, ok: true });
    pendingReason = 'label';
    const snap = await refreshSnapshot(true);
    const { acc } = find(snap, provider, accountId);
    if (!acc) common.fail('ACCOUNT_NOT_FOUND', 'That account is not known on ' + computerName() + '.');
    return acc;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Start the watchers: state.json and the periodic roster check. */
  function start() {
    ensureBaseline();
    if (fixture) return;
    stops.push(glass.watchStateFile(() => { refreshSnapshot(true).catch(() => {}); }));
    const tick = setInterval(() => { refreshSnapshot(true).catch(() => {}); }, WATCH_TICK_MS);
    if (tick.unref) tick.unref();
    stops.push(() => clearInterval(tick));
    refreshSnapshot(true).catch(() => {});
  }

  return {
    start,
    stop() { for (const s of stops.splice(0)) { try { s(); } catch (_) {} } if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; } },
    snapshot,
    get: async () => publicSnapshot(await refreshSnapshot(false)),
    swap,
    refresh,
    login,
    loginStatus,
    loginCancel,
    setLabel,
    glassApiUp: () => glass.apiUp(),
    fixtureMode: () => !!fixture,
    rebuild: (reason) => { pendingReason = reason || 'other'; return refreshSnapshot(true).then(publicSnapshot); },
    _internal: { build, fromGlassAccount, fromRoster, codexWindows, claudeWindows, assignRings, labelForSeconds, severityOf, claudePlanName, codexPlanName, glass },
  };
}

module.exports = { createAccounts, severityOf, labelForSeconds, assignRings, SWAP_EFFECT, UNDO_MS };
