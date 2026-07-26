/**
 * Codex account-switcher capability (provider-owned).
 *
 * Everything Codex-specific about multi-account management lives HERE, in
 * the excluded src/providers/ subtree, so the generic machinery in
 * src/web/provider-account-manager.js and provider-account-routes.js stays
 * provider-neutral (grep-gate discipline, requirement ABST-04).
 *
 * Facts this module encodes (verified live 2026-07-03, design doc Part 2):
 *   - ~/.codex/auth.json holds ONE active account:
 *     { auth_mode: 'chatgpt'|'apikey', OPENAI_API_KEY: string|null,
 *       tokens: { id_token, access_token, refresh_token, account_id },
 *       last_refresh: RFC3339 }
 *   - id_token is a JWT whose payload carries email/name plus the
 *     'https://api.openai.com/auth' claim object (chatgpt_plan_type,
 *     chatgpt_account_id, organizations[]). Its exp is ~1 hour and is
 *     USELESS for account health.
 *   - access_token is ALSO a JWT; its exp (~10 days after issue) is the
 *     real "usage fetchable until" signal.
 *   - Usage endpoint: GET https://chatgpt.com/backend-api/wham/usage with
 *     Authorization: Bearer <access_token> + chatgpt-account-id header.
 *     primary_window (18000s) maps to five_hour, secondary_window
 *     (604800s) to seven_day; reset_at is epoch SECONDS.
 *   - Token refresh policy v1: the workbook NEVER calls
 *     auth.openai.com/oauth/token. Switching restores the full auth.json
 *     (refresh_token included); the Codex CLI heals the pair on next
 *     launch. See design doc 5.2.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/accounts
 */

'use strict';

const os = require('os');
const path = require('path');

// ─── Named constants (never inlined) ────────────────────────────────────────
// Live usage endpoint; override with CWM_CODEX_USAGE_URL for hermetic tests.
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// The auth file name inside CODEX_HOME (the dir is BUSY: sqlite WAL churn,
// so watchers must filter on this name first).
const CODEX_AUTH_FILE_NAME = 'auth.json';
// The OIDC claim namespace OpenAI packs account metadata under.
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * Resolve the Codex home directory: CODEX_HOME env override, else
 * ~/.codex. Evaluated per call so tests can repoint it after module load.
 *
 * @returns {string} Absolute Codex home directory path.
 */
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Decode a JWT payload WITHOUT signature verification (display data only;
 * every claim is treated as untrusted downstream). Defensive at every step:
 * non-strings, wrong segment counts, bad base64url, non-JSON payloads, and
 * non-object payloads all return null, never throw.
 *
 * @param {*} token - Candidate JWT string.
 * @returns {object|null} Parsed payload object, or null.
 */
function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token) return null;
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    // base64url -> base64: swap the URL-safe alphabet back and re-pad.
    let b64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Derive the identity fields from a parsed auth.json object. Pure and
 * null-tolerant: any malformed input degrades to nulls/empty strings,
 * never a throw (the watcher calls this on files the Codex CLI may be
 * mid-writing).
 *
 * accountId comes from tokens.account_id, cross-checked against the
 * id_token's chatgpt_account_id claim when both exist (a mismatch keeps
 * tokens.account_id, which is what the usage endpoint keys on, but is
 * worth knowing about; the caller sees only the winner). apikey mode has
 * no account identity at all.
 *
 * @param {object|null} authJson - Parsed auth.json content.
 * @returns {{accountId: string|null, email: string, plan: string,
 *   name: string, authMode: string, lastRefresh: string|null,
 *   accessTokenExp: number|null}} Derived identity (never throws).
 */
function parseAccountFromAuth(authJson) {
  const out = {
    accountId: null,
    email: '',
    plan: '',
    name: '',
    authMode: 'unknown',
    lastRefresh: null,
    accessTokenExp: null,
  };
  if (!authJson || typeof authJson !== 'object') return out;
  if (authJson.auth_mode === 'chatgpt' || authJson.auth_mode === 'apikey') {
    out.authMode = authJson.auth_mode;
  } else if (typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY) {
    // Older files may omit auth_mode; a bare API key implies apikey mode.
    out.authMode = 'apikey';
  }
  if (typeof authJson.last_refresh === 'string' && authJson.last_refresh) {
    out.lastRefresh = authJson.last_refresh;
  }
  const tokens = authJson.tokens;
  if (!tokens || typeof tokens !== 'object') {
    // No tokens at all: apikey mode (or a broken file). Nothing more to derive.
    return out;
  }
  // tokens present without an explicit mode reads as chatgpt mode.
  if (out.authMode === 'unknown') out.authMode = 'chatgpt';
  if (typeof tokens.account_id === 'string' && tokens.account_id) {
    out.accountId = tokens.account_id;
  }
  const idPayload = decodeJwtPayload(tokens.id_token);
  if (idPayload) {
    if (typeof idPayload.email === 'string') out.email = idPayload.email;
    if (typeof idPayload.name === 'string') out.name = idPayload.name;
    const claim = idPayload[OPENAI_AUTH_CLAIM];
    if (claim && typeof claim === 'object') {
      if (typeof claim.chatgpt_plan_type === 'string') out.plan = claim.chatgpt_plan_type;
      // Cross-check: tokens.account_id is authoritative (the usage endpoint
      // keys on it); the claim only fills a missing one.
      if (!out.accountId && typeof claim.chatgpt_account_id === 'string' && claim.chatgpt_account_id) {
        out.accountId = claim.chatgpt_account_id;
      }
    }
  }
  const accessPayload = decodeJwtPayload(tokens.access_token);
  if (accessPayload && Number.isFinite(Number(accessPayload.exp))) {
    out.accessTokenExp = Number(accessPayload.exp) * 1000; // epoch seconds -> ms
  }
  // apikey mode never exposes a switchable account identity.
  if (out.authMode === 'apikey') out.accountId = null;
  return out;
}

/**
 * Whitelist-map one raw wham/usage response to the stored usage shape
 * shared with the Claude switcher UI: five_hour/seven_day windows with
 * {utilization, resets_at}. reset_at arrives in epoch SECONDS and is
 * converted to an ISO string (the Claude endpoint sends ISO already, and
 * the frontend countdown code expects ISO). plan_type rides along so the
 * manager can heal identity fields. Null-tolerant: junk input returns
 * null; a missing window maps to null inside the shape.
 *
 * @param {object|null} raw - Parsed usage response body.
 * @param {string} nowIso - fetchedAt timestamp (injected for testability).
 * @returns {object|null} { five_hour, seven_day, plan_type, fetchedAt } or null.
 */
function mapUsageResponse(raw, nowIso) {
  if (!raw || typeof raw !== 'object') return null;
  /**
   * Map one rate-limit window ({used_percent, reset_at seconds}) to the
   * stored {utilization, resets_at ISO} shape. Malformed windows -> null.
   * @param {*} w - Raw window object.
   * @returns {{utilization: number|null, resets_at: string|null}|null}
   */
  const pickWindow = (w) => {
    if (!w || typeof w !== 'object') return null;
    let resetsAt = null;
    if (Number.isFinite(Number(w.reset_at)) && Number(w.reset_at) > 0) {
      try {
        resetsAt = new Date(Number(w.reset_at) * 1000).toISOString();
      } catch (_) {
        resetsAt = null; // absurd epoch values must never throw
      }
    }
    return {
      utilization: Number.isFinite(Number(w.used_percent)) ? Number(w.used_percent) : null,
      resets_at: resetsAt,
    };
  };
  const rl = (raw.rate_limit && typeof raw.rate_limit === 'object') ? raw.rate_limit : {};
  const usage = {
    five_hour: pickWindow(rl.primary_window),
    seven_day: pickWindow(rl.secondary_window),
    plan_type: typeof raw.plan_type === 'string' ? raw.plan_type : '',
    fetchedAt: typeof nowIso === 'string' && nowIso ? nowIso : new Date().toISOString(),
  };
  // Endpoint drift guard: a response with NEITHER window is not usage data.
  if (!usage.five_hour && !usage.seven_day) return null;
  return usage;
}

/**
 * The capability object consumed by createProviderAccountManager. Every
 * provider-specific constant, path, header, and parser is packed in here
 * so the generic manager and routes never mention a provider by name.
 */
const accountsCapability = {
  providerId: 'codex',                    // gsd:provider-literal-allowed
  displayName: 'ChatGPT Codex',
  /**
   * Absolute path of the single-account live auth file.
   * @returns {string}
   */
  authFilePath: () => path.join(codexHome(), CODEX_AUTH_FILE_NAME),
  /**
   * Directory to fs.watch (the file itself drops on Windows after atomic
   * rename, same lesson as the Claude watcher).
   * @returns {string}
   */
  watchDir: () => codexHome(),
  // Watcher callbacks filter on this name FIRST: the Codex home dir churns
  // constantly (sqlite WAL), so the name check must be the cheap first line.
  watchFileName: CODEX_AUTH_FILE_NAME,
  // Snapshot store dir names under getDataDir() (~/.myrlin).
  storeDirName: 'codex-accounts',         // gsd:provider-literal-allowed
  backupsDirName: 'codex-accounts-backups', // gsd:provider-literal-allowed
  parseAccount: parseAccountFromAuth,
  /**
   * Serialize a stored auth object back to live-file text. JSON.stringify
   * round-trips EVERY field including unknown future ones (the snapshot
   * stores the parsed object verbatim).
   * @param {object} obj - Stored auth object.
   * @returns {string} File text.
   */
  serializeAuth: (obj) => JSON.stringify(obj),
  /**
   * Strictly-newer comparison on last_refresh (RFC3339). Unparseable or
   * missing stamps read as epoch 0, so "newer than nothing" adopts and
   * "nothing vs stored" never regresses.
   * @param {object} a - Candidate auth object.
   * @param {object} b - Stored auth object.
   * @returns {boolean} True when a.last_refresh is strictly newer.
   */
  isNewerThan: (a, b) => {
    const at = Date.parse((a && a.last_refresh) || '') || 0;
    const bt = Date.parse((b && b.last_refresh) || '') || 0;
    return at > bt;
  },
  usage: {
    /**
     * Usage endpoint URL. Read per call so hermetic tests can point it at
     * a local stub AFTER this module loads.
     * @returns {string}
     */
    url: () => process.env.CWM_CODEX_USAGE_URL || CODEX_USAGE_URL,
    /**
     * Request headers for one usage GET. The access token rides ONLY in
     * the Authorization header, never in a URL.
     * @param {object} auth - Parsed live or stored auth object.
     * @returns {object} Header map.
     */
    headers: (auth) => ({
      'Authorization': 'Bearer ' + (auth && auth.tokens ? auth.tokens.access_token : ''),
      'chatgpt-account-id': (auth && auth.tokens ? auth.tokens.account_id : '') || '',
      'Accept': 'application/json',
    }),
    map: mapUsageResponse,
  },
  loginHint: 'Run codex login in a terminal; the account is captured automatically.',
};

module.exports = {
  decodeJwtPayload,
  parseAccountFromAuth,
  mapUsageResponse,
  accountsCapability,
  CODEX_USAGE_URL,
  CODEX_AUTH_FILE_NAME,
};
