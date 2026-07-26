# Codex Account Switcher: Build-Ready Spec

> Issue: replicate the Claude credential switcher for Codex (ChatGPT) accounts, as a tab in the same dropdown.
> Status: approved for build 2026-07-03 (Fable 5 recon+design, verified against live code and a live usage-endpoint probe).
> Scope decisions (approved defaults): header chip stays Claude-only, Codex-on-Mac sync deferred, no workbook-side token refresh in v1.

Formatting note: CSS custom properties require a double-hyphen prefix in real code; this spec names tokens bare (provider-codex-accent, mauve). Write them exactly like adjacent rules in styles.css.

## PART 1: CLAUDE SWITCHER ARCHITECTURE MAP (the template to mirror)

### 1.1 Files
- `src/web/credential-manager.js` (1698 lines): store, watcher, usage, apply. Factory `createCredentialManager(opts)` at L277, everything injectable (claudeDir, accountsDir, fetchImpl, usageUrl, tokenUrl, clock, watchDebounceMs 500, pollIntervalMs 30000, settingsProvider, settingsPatcher, log).
- `src/web/credential-routes.js` (564 lines): Express routes, all `requireAuth`, all errors via `structuredError`.
- `src/web/mac-bridge.js` (570 lines): SSH/scp bridge, Claude-only, config-gated.
- Wiring: `src/web/server.js` L371 to 397 (manager creation with settingsProvider reading `store.settings.credentialSwitcher`, settingsPatcher write-back; `setupCredentialRoutes(app, {requireAuth, getStore, broadcast, structuredError, manager, macBridge})`). SSE types registered in `GLOBAL_EVENT_TYPES` at server.js L5930 to 5939 (`credentials:changed`, `credentials:usage`, `credentials:mac`). Startup: seed at L8645, `startCredentialWatcher()` at L8656; `stopCredentialWatcher()` in cleanup at L8669.
- Frontend: `src/web/public/index.html` L113 to 158 (static shell `#account-switcher` with `#account-chip`, `#account-panel`, `#account-panel-header`, `#account-panel-meter`, `#account-machines`, `#account-panel-list`, `#account-panel-footer` with `#account-pending`, cancel/save). Header usage meter `#usage-meter` at L217. `src/web/public/app.js` L8149 to 9520 (details in 1.6). CSS: `styles.css` L8183 to ~8990 plus `styles-mobile.css` (27 account rules, bottom-sheet at phone widths).

### 1.2 Snapshot store schema (verified against a real file in ~/.myrlin/claude-accounts/)
Path: `<getDataDir()>/claude-accounts/<accountUuid>.json` (getDataDir = `~/.myrlin`, overridable via CWM_DATA_DIR; src/utils/data-dir.js). Written atomically, chmod 0600 best effort.
```
{ accountUuid, email, label, savedAt, updatedAt,
  credentials: { accessToken, refreshToken, expiresAt(epoch ms), scopes[], subscriptionType, rateLimitTier },
  identity: { accountUuid, emailAddress, organizationUuid, organizationName, organizationType, displayName, ... },
  usage: { five_hour:{utilization,resets_at}, seven_day:{...}, fetchedAt, limits[] } | null,
  tokenState: 'ok'|'needs_login'|'unverified', lastRefreshError: {at,kind,status,detail}|null }
```
Backups: `~/.myrlin/claude-accounts-backups/<basename>.<yyyyMMdd-HHmmss>.bak`, pruned to backupKeep (20), just-created backup never a prune candidate (L1318 to 1359).

### 1.3 Capture and the watcher (L1524 to 1554)
`startCredentialWatcher()`: `fs.watch` on the ~/.claude DIRECTORY filtered to `.credentials.json` (watching the file itself drops on Windows after atomic rename), 500ms debounce, 30s mtime-poll fallback, `setImmediate` initial sync so the active account self-registers at boot. On fire: `_syncActiveTokenToProfileUnlocked()` (L932): read live token file + `oauthAccount` from ~/.claude.json, dedupe by accountUuid, auto-capture if unknown (this is the "captured within ~1s of /login" behavior), else merge credentials only when live expiresAt is STRICTLY newer, and always resurrect tokenState to ok (live login is definitive evidence). Self-write guard `_selfWriteUntil` (3000ms, L60/L1421/L1508) suppresses watcher echoes of our own apply. Everything runs under a promise-chain mutex `serialize()` (L334).

### 1.4 Switch/apply transaction (`_applyCredentialUnlocked`, L1373 to 1480)
Order is load-bearing: validate id (hex/dash 8 to 64, L106); load snapshot; alreadyActive no-op; needs_login blocks (409 CRED_TOKEN_DEAD); if access token expired (5 min skew, L58) do an inline refresh (transient failure applies anyway with warning; invalid_grant blocks); arm self-write guard; sync current active account's freshest tokens FIRST (capture-before-overwrite safety); backup both live files; write IDENTITY first (surgical oauthAccount replacement in ~/.claude.json), TOKENS last, both via `writeFileAtomic` (L184: temp in same dir, re-read verification against zero-fill, renameSync with 5x EPERM/EBUSY/EACCES backoff retry, temp unlinked in finally); rollback identity from backup if token write fails; VERIFY live identity now reports the target (rollback both on mismatch); reconcile and return `{applied, alreadyActive, email, warning?}`.

### 1.5 Usage refresh
`fetchUsage(accessToken)` (L655): GET `https://api.anthropic.com/api/oauth/usage` with Bearer plus `anthropic-beta: oauth-2025-04-20`, 5s timeout, null on any failure. `_mapUsageResponse` (L598) whitelists five_hour/seven_day `{utilization, resets_at}` plus sanitized `limits[]` rows (kind/percent/resets_at/model from scope.model.display_name). `_updateSnapshotUsageUnlocked` (L821): 10 min cache TTL; ACTIVE account uses the LIVE token strictly read-only (never refresh, would race CLI rotation); Mac-active account gated by lineage hint (never refresh); inactive+expired refreshes at `https://console.anthropic.com/v1/oauth/token` with the corrected three-state failure classification (invalid_grant only sets needs_login; 429/5xx/timeouts are transient; rotated pair persisted BEFORE the usage call). Route: POST /api/credentials/refresh-usage `{profileId}` forces one, `{}` sweeps stale ones (routes L221 to 243).

### 1.6 Frontend structure (app.js, all inside CWMApp)
State slice L191: `state.credentials = {list, activeId, stagedId, stagedMacId, loading, applying, lastListAt, mac, macState, macStale, macStateLoading}`. Constants: CRED_USAGE_STALE_MS L123, CRED_SELF_ACTION_MS L130 (8s self-echo suppression), MAC_STATE_STALE_MS L140. Els registered L364 to 381.
Key methods: `initAccountSwitcher` L8161 (one-time delegated bindings on `#account-panel-list`, chip toggle, keyboard roving focus, outside-click via composedPath, Escape); `_credApi` L8297 (dedicated fetch helper preserving status + structuredError message; 404 = feature self-hides); `loadCredentials` L8325; `_applyCredListResponse` L8364; `renderAccountSwitcher` L8395 (chip + skeleton rows + rows + footer pending lines + save enable); `renderAccountRow` L8509 (div role=option, avatar, name + plan badge, email secondary, usage mini-bars, ACTIVE pill / staged radio, rename pencil; rows are divs because they CONTAIN buttons); `_machineSegmentsHtml` L8596 (PC/MAC segments, empty string while Mac bridge disabled); `_accountUsageRowHtml` L8645 (4px track + fill class from `_usageFillClass` L8675: green <60, amber 60 to 85, red >85, with data-reset-at spans for the 60s tick); `accountHealth` L8831; `_accountDisplayName` L8848; `_accountPlanBadge` L8863; `stageAccount` L8894; `renameAccount` L8950 (showPromptModal); `captureCurrentAccount` L8988; `openMacConfigModal` L9031 (gear); `renderMachinesStrip` L9163; `applyStagedAccount` L9238 (confirm modal, legacy vs {pc,mac} body, per-machine toasts, offer restartAllSessions); `_openAccountPanel` L9359 (mobile sheet classes + stale auto-refresh); `_startAccountTick` L9458 / `_tickAccountCountdowns` L9484 (in-place countdown updates, no re-render); `_formatResetText` L9500. SSE cases: `credentials:changed` L11014, `credentials:usage` L11047 (merge by profileId), `credentials:mac` L11064; cases MUST exist or the default branch causes loadAll() reload storms.
CSS: `.account-switcher` L8183, `.account-chip*` L8200 to 8320, `.account-panel` L8326 (min-width 320px, animation account-panel-in 150ms), header L8370, `.account-machines`/`.machine-pill` L8406 to 8483, `.account-row*` L8496 to 8790, usage bars L8650 to 8705 (fills use var(green/yellow/red)), machine segments L8825+, header meter L8945+.

## PART 2: CODEX FACTS (all verified live 2026-07-03)

### 2.1 ~/.codex/auth.json (single active account; redacted shape)
```
{ "auth_mode": "chatgpt",              // 'apikey' variant exists per binary strings
  "OPENAI_API_KEY": null,              // string when api-key auth; null in chatgpt mode
  "tokens": { "id_token": JWT(~2177), "access_token": JWT(~2032),
              "refresh_token": string(196, opaque), "account_id": uuid(36) },
  "last_refresh": "2026-06-27T19:55:35.320240500Z" }   // RFC3339 with nanos + Z
```
- id_token JWT payload claims: `email`, `name`, `sub`, `exp`/`iat` (LIFETIME 1 HOUR, useless for account health), and `https://api.openai.com/auth` object with `chatgpt_account_id` (equals tokens.account_id, verified), `chatgpt_plan_type` (observed 'prolite'), `chatgpt_user_id`, `chatgpt_subscription_active_until`, `organizations[] {id, is_default, role, title}`.
- access_token is ALSO a JWT: exp is ~10 DAYS after issue (iat 06-27, exp 07-07). This is the real "usage fetchable until" signal. refresh_token is opaque (no exp readable).
- Codex CLI login: `codex login` (ChatGPT OAuth) or `codex login` with an API key flag. Refresh endpoint in binary: `https://auth.openai.com/oauth/token`, OAuth client id `app_EMoamEEZ73f0CkXaXp7hrann` (do NOT use in v1, see 5.2).

### 2.2 Usage endpoint: REAL, VERIFIED LIVE (200 OK)
`GET https://chatgpt.com/backend-api/wham/usage` with headers `Authorization: Bearer <tokens.access_token>`, `chatgpt-account-id: <tokens.account_id>`, `Accept: application/json`, plus a User-Agent (probe used `codex_cli_rs/0.142.3`). Response (verified):
```
{ email, plan_type,
  rate_limit: {
    primary_window:   { used_percent, limit_window_seconds: 18000,  reset_after_seconds, reset_at (EPOCH SECONDS) },
    secondary_window: { used_percent, limit_window_seconds: 604800, reset_at } },
  additional_rate_limits: [ { limit_name, metered_feature, rate_limit: {same windows} } ],
  credits: {...}, spend_control: {...}, rate_limit_reached_type, ... }
```
Verdict: the Codex tab GETS a usage meter. primary_window maps to five_hour (18000s = 5h), secondary_window maps to seven_day (604800s = 7d). reset_at is epoch SECONDS (multiply by 1000 before toISOString; Claude sends ISO strings). Bonus: response carries email + plan_type, so usage refresh can heal identity fields. (Rollout JSONLs also carry `rate_limits` in token_count events; ignore that as a source, the endpoint is authoritative.)

### 2.3 Grep gate reality (test/grep-gate.test.js L29)
Regex is `['"]\b(claude|codex)\b['"]` over `.js` files under src/ excluding src/providers/. Only BARE quoted literals match: `'.codex'`, `'codex-accounts'`, `'../providers/codex/accounts'` all pass without markers (that is exactly how credential-manager.js stays green with `'.claude'` / `'claude-accounts'`). Still, per the abstraction mandate, route all Codex constants through src/providers/codex/ (below) so src/web/ is provider-parameterized, not literal-dodging.

## PART 3: CODEX TAB DESIGN

### 3.1 New file: `src/providers/codex/accounts.js` (provider-owned capability module; codex literals live here freely)
```js
// Pure helpers (all defensive, never throw):
decodeJwtPayload(token) -> object|null
  // typeof string, split('.') length 3, base64url middle segment
  // (replace -/+ _// , pad to %4), Buffer.from(...,'base64'),
  // JSON.parse, non-object -> null, catch -> null. NO signature verification.
parseAccountFromAuth(authJson) -> {
  accountId,        // tokens.account_id, cross-checked vs id_token claim; null in apikey mode
  email,            // id_token payload.email, else usage-healed later, else ''
  plan,             // payload['https://api.openai.com/auth'].chatgpt_plan_type or ''
  name,             // payload.name or ''
  authMode,         // 'chatgpt' | 'apikey' | 'unknown'
  lastRefresh,      // authJson.last_refresh or null
  accessTokenExp }  // epoch ms from decodeJwtPayload(tokens.access_token).exp * 1000, or null
mapUsageResponse(raw, nowIso) -> { five_hour:{utilization,resets_at}, seven_day:{...},
  plan_type, fetchedAt } | null   // reset_at * 1000 -> ISO; whitelist only; null-tolerant

// The capability object (consumed by the generic manager):
module.exports.accountsCapability = {
  providerId: 'codex',
  displayName: 'ChatGPT Codex',
  authFilePath: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'),
  watchDir:      () => CODEX_HOME,           // watch the dir, filter filename 'auth.json'
  watchFileName: 'auth.json',
  storeDirName: 'codex-accounts',            // -> ~/.myrlin/codex-accounts/
  backupsDirName: 'codex-accounts-backups',
  parseAccount: parseAccountFromAuth,        // identity derivation
  serializeAuth: (obj) => JSON.stringify(obj),  // round-trips ALL fields incl. unknown ones
  isNewerThan: (a, b) => Date.parse(a.last_refresh||0) > Date.parse(b.last_refresh||0),
  usage: { url: process.env.CWM_CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage',
           headers: (auth) => ({ Authorization:'Bearer '+auth.tokens.access_token,
                                 'chatgpt-account-id': auth.tokens.account_id,
                                 Accept:'application/json' }),
           map: mapUsageResponse },
  loginHint: 'Run codex login in a terminal; the account is captured automatically.',
};
```
Export the pure helpers individually too (unit tests import them directly). Also re-export `accountsCapability` from `src/providers/codex/index.js` as optional member `accounts` (NOT added to REQUIRED_METHODS in src/providers/index.js L122, mirroring the optional `mirror` member pattern at codex/index.js L369).

### 3.2 New file: `src/web/provider-account-manager.js` (generic, provider-neutral, zero markers)
Factory `createProviderAccountManager(capability, opts)` mirroring createCredentialManager discipline: injectable accountsDir, fetchImpl, clock, watchDebounceMs 500, pollIntervalMs 30000, settingsProvider, log. Reuse via `require('./credential-manager')`: `writeFileAtomic`, `credError`, `validateAccountUuid` (already exported at L1680 to 1698; codex account_id is a 36-char uuid so the same validator gates path construction). Promise-chain mutex `serialize()` identical to L334.

State model (three states, Codex-adapted semantics):
- `ok`: believed good. `unverified`: no fresh evidence. `needs_login`: DEFINITIVE evidence only, which for Codex means a usage 401/403 received while the stored access token was NOT yet expired per its exp claim (an expired token 401 is expected and says nothing). Expiry itself is derived at read time from accessTokenExp, never stored as a state.

Snapshot schema `~/.myrlin/codex-accounts/<accountId>.json` (atomic write, 0600):
```
{ accountId, email, label, plan, authMode, name,
  savedAt, updatedAt,
  auth: <full parsed auth.json object, verbatim fields>,   // THE secret payload
  lastRefresh,                    // copy of auth.last_refresh for cheap compare
  usage: <mapped shape> | null,
  tokenState, lastError: {at,kind,status,detail} | null }
```

Functions (signatures mirror credential-manager):
- `readActiveAuth()` -> `{authObj, parsed: parseAccount(authObj)} | null` (missing/malformed file -> null).
- `getActiveAccountId()` -> parsed.accountId or null (null in apikey mode).
- `snapshotPath/readSnapshot/listSnapshots/saveSnapshot(_writeSnapshot,_mutateSnapshot)`: same carry-forward semantics as L558 (label survives, usage/tokenState carry forward).
- `captureCurrent({label})`: read live auth; throw 500 ACCT_LIVE_STATE_UNREADABLE if missing/malformed; throw 422 ACCT_NO_IDENTITY if authMode is apikey or accountId missing (api-key auth has no account identity; not capturable); else write snapshot with tokenState ok.
- `syncActiveAuthToSnapshot()` (watcher core): read live auth; skip silently if unparseable or apikey; auto-capture if unknown accountId (this gives capture-within-1s of `codex login`); else merge `auth` + `lastRefresh` + identity fields only when `isNewerThan(live, stored)` (strictly newer last_refresh; the second guard against regressing a fresher snapshot, same as Claude expiresAt compare); always resurrect tokenState to ok.
- `startWatcher()/stopWatcher()`: fs.watch on the ~/.codex DIRECTORY filtered to filename 'auth.json' via capability.watchFileName (the dir is BUSY: logs_2.sqlite-wal churns constantly, so the name filter must be the first line of the callback and cheap), 500ms debounce, 30s mtime poll fallback on the auth file, initial `setImmediate` sync, self-write guard 3000ms, error degrades to poll-only. Identical skeleton to L1524.
- `updateSnapshotUsage(accountId, {force})`: 10 min cache TTL; pick token source: ACTIVE account uses the LIVE auth.json tokens read-only; inactive uses stored auth.tokens. If accessTokenExp (minus 5 min skew) has passed: SKIP the network call entirely (no refresh in v1, see 5.2) and return the snapshot unchanged (row keeps stale usage; UI marks stale). Otherwise GET usage with capability.usage headers, 5s timeout; 200 -> store mapped usage, heal email/plan from response, tokenState ok, clear lastError; 401/403 with unexpired token -> needs_login; timeout/network/429/5xx -> record lastError, keep prior state. NEVER call any token endpoint.
- `applyAccount(accountId)` (the switch; single-file, simpler than Claude's two-file transaction):
  1. validate id; read snapshot; 404 ACCT_NOT_FOUND; 422 ACCT_INCOMPLETE if snapshot.auth or tokens missing.
  2. alreadyActive check via getActiveAccountId() -> `{applied:false, alreadyActive:true, email}`.
  3. needs_login blocks with 409 ACCT_TOKEN_DEAD ("run codex login as that account once; it recaptures automatically").
  4. Arm self-write guard.
  5. CAPTURE-BEFORE-OVERWRITE (critical): `syncActiveAuthToSnapshot()`. If the current live auth is chatgpt-mode and its accountId has NO snapshot, this auto-captures it, so the user never loses the account being replaced. If live auth is apikey-mode or unparseable it is not capturable; the backup in step 6 is its only preservation (documented).
  6. `backupLiveFile(authFilePath)` into `~/.myrlin/codex-accounts-backups/` (same timestamp+prune helper pattern as L1318; reimplement in the generic manager since Claude's is closure-private; keep backupKeep 20).
  7. `writeFileAtomic(authFilePath, capability.serializeAuth(snapshot.auth), {mode:0o600})` (temp+rename+verify, Windows retry loop, exactly the exported helper).
  8. VERIFY: re-read live auth, parsed.accountId === target; on mismatch restore the backup via writeFileAtomic and throw 500 ACCT_VERIFY_FAILED.
  9. Reconcile (`syncActiveAuthToSnapshot()`), return `{applied:true, alreadyActive:false, email}`.
- `getSafeList()` -> `{activeAccountId, activeAuthMode, installed:boolean, accounts:[{accountId, email, label, displayName, plan, authMode, isActive, tokenState, health, accessExpired:boolean, savedAt, updatedAt, usage, lastError:{at,kind,status}|null}]}`. THE ONLY route-serializable shape. Never auth, never tokens, never id_token. `installed` = auth file exists OR store non-empty (drives the empty state). displayName fallback chain identical to L118 (label, else email, else accountId8 + ' unnamed').
- Token staleness surfacing: `accessExpired` derived at read time from stored accessTokenExp. Switching to such an account still works (Codex CLI refreshes with refresh_token on next launch); if THAT refresh fails the CLI itself demands login. Apply response carries `restartNote` and, when accessExpired, `warning: 'Stored token is past its access window; Codex will refresh it on next use, or ask for login if the refresh is rejected.'`. There is no way to test the refresh token without spending it, so we never claim more.

### 3.3 New file: `src/web/provider-account-routes.js` (provider-neutral routes)
`setupProviderAccountRoutes(app, {requireAuth, broadcast, structuredError, managers})` where `managers` is a Map providerId -> manager (server.js constructs it with only the codex entry; the id string comes from `capability.providerId`, so no literal in src/web). Resolver middleware: unknown `:providerId` -> 404 PROVIDER_ACCOUNTS_UNSUPPORTED. All routes requireAuth. mapError identical to credential-routes L61.

| Method/Path | Body | Response |
|---|---|---|
| GET `/api/provider-accounts/:providerId` | none | getSafeList() shape above |
| POST `/api/provider-accounts/:providerId/refresh-usage` | `{accountId?}` (force one) or `{}` (sweep stale, per-account failures never fail the batch) | safe list; broadcasts `provider-accounts:usage` |
| POST `/api/provider-accounts/:providerId/apply` | `{accountId}` | `{applied, alreadyActive, activeAccountId, email, restartNote, warning?}`; broadcasts `provider-accounts:changed {providerId, activeAccountId, email, appliedAt}` |
| POST `/api/provider-accounts/:providerId/capture` | `{label?}` | safe list; broadcasts changed `{captured:true, accountId}` |
| PUT `/api/provider-accounts/:providerId/:accountId/label` | `{label}` (trim, 60 cap, empty clears) | safe list; broadcasts changed `{renamed:true, accountId}` |
| DELETE `/api/provider-accounts/:providerId/:accountId` | none | safe list; broadcasts changed `{deleted:true, accountId}`; deletes snapshot file ONLY, never the live auth.json |

restartNote: 'New Codex sessions use this account immediately. Running Codex sessions keep the previous account until restarted.' SSE payload keys are `accountId`/`providerId`, NEVER bare `id` (broadcastSSE misfiles `id` as a workspace id, per credential-routes.js L10). Register `provider-accounts:changed` and `provider-accounts:usage` in GLOBAL_EVENT_TYPES (server.js L5930 block).

server.js wiring (immediately after the credential switcher block at L397):
```js
const { accountsCapability } = require('../providers/codex/accounts');
const { createProviderAccountManager } = require('./provider-account-manager');
const codexAccountManager = createProviderAccountManager(accountsCapability, {
  settingsProvider: () => ((getStore().settings || {}).providerAccounts || {})[accountsCapability.providerId] || {} });
setupProviderAccountRoutes(app, { requireAuth, broadcast: (t,d)=>broadcastSSE(t,d), structuredError,
  managers: new Map([[accountsCapability.providerId, codexAccountManager]]) });
```
Start `codexAccountManager.startWatcher()` next to L8656; stop it in the cleanup at L8669. (Path literal `'../providers/codex/accounts'` passes the gate; `accountsCapability.providerId` keeps everything else neutral.)

### 3.4 Frontend: the tab bar and the Codex pane

The dropdown is NOT structured for tabs today (single static header + one list container). Minimal DOM change in index.html, inserted between `.account-panel-header` (ends ~L133) and `#account-panel-meter` (L138):
```html
<div class="account-tabs" role="tablist" id="account-tabs">
  <button class="account-tab is-active" role="tab" aria-selected="true"
          data-kind="legacy" data-provider-tab="claude" id="account-tab-claude">Claude</button>
  <button class="account-tab" role="tab" aria-selected="false"
          data-kind="provider" data-provider-tab="codex" id="account-tab-codex">Codex</button>
</div>
```
`data-kind` is the branch key in app.js (`'legacy'` renders the existing Claude pipeline untouched; `'provider'` renders via the generic provider-accounts path), so app.js gains ZERO new provider literals: the provider id for API URLs comes from the clicked tab's `dataset.providerTab` (HTML is not gated). Also change the static header span (L124) to `<span id="account-panel-title">Claude account</span>` so JS can retitle per tab.

CSS (styles.css, new block after the account-panel-header rules ~L8405; mirror `.sidebar-tabs` L11535 to 11575):
```css
.account-tabs { display:flex; gap:2px; padding:0 10px; border-bottom:1px solid var(--border-subtle); }
.account-tab  { flex:1 1 0; padding:7px 10px; font-size:12px; font-family:var(--font-sans);
                color:var(--text-tertiary); background:transparent; border:none;
                border-bottom:2px solid transparent; cursor:pointer;
                transition: color var(--transition-fast), border-color var(--transition-fast); }
.account-tab:hover { color:var(--text-secondary); }
.account-tab.is-active { color:var(--text-primary); }
.account-tab.is-active[data-provider-tab="claude"] { border-bottom-color:var(--provider-claude-accent); }
.account-tab.is-active[data-provider-tab="codex"]  { border-bottom-color:var(--provider-codex-accent); }
```
(Tokens exist at :root L127 to 132; phantom-tokens and css-tokens gates stay green because only existing tokens are consumed.) Optional polish: on the Codex tab give `.account-row.is-active .account-active-pill` a codex-tinted background via a `.account-panel[data-active-tab="codex"]` scope using provider-codex-tint; keep it to the pill and the staged radio ring so both tabs share every other pixel. 150 to 200ms transitions throughout, already inherited from `--transition-fast`.

app.js additions (all NEW code, nothing removed):
- State slice next to L191: `state.codexAccounts = { list: [], activeId: null, activeAuthMode: null, installed: false, stagedId: null, loading: false, applying: false, lastListAt: 0 }` and `state.accountTab = null` (null means default first tab; resolved from DOM).
- `initAccountSwitcher` L8161: add a delegated click handler on `#account-tabs` that sets `state.accountTab = btn.dataset.providerTab`, toggles `is-active`/aria-selected, sets `#account-panel-title` text from the button label + ' account', toggles panel `data-active-tab` attribute, hides `#account-mac-config-btn` and `#account-machines` and `#account-panel-meter` when the active tab kind is `provider` (Mac strip and header meter are Claude-only in v1), re-renders, and lazy-loads the provider roster on first activation (`loadProviderAccounts(tabEl)` when lastListAt is 0).
- `loadProviderAccounts(tabEl, {refresh})`: `_credApi('GET'|'POST', '/api/provider-accounts/' + encodeURIComponent(tabEl.dataset.providerTab) + (refresh ? '/refresh-usage' : ''))`; 404 disables the tab (old server: add `.is-unavailable`, title 'Update the workbook server'); response -> state.codexAccounts.
- `renderAccountSwitcher` L8395: at the top of the panel-open section, branch on active tab kind. Legacy path unchanged byte for byte. Provider path renders skeleton rows (same 3-row skeleton markup), `renderProviderAccountRow(a)` per account, or the empty state:
```html
<div class="account-empty"><p>No Codex accounts yet</p>
  <p class="account-empty-hint">Run codex login in a terminal; the account is captured automatically.</p>
  <!-- Capture button ONLY when installed && activeAuthMode === 'chatgpt' -->
</div>
```
  (apikey mode shows 'Codex is using an API key; API-key auth has no switchable account.' instead of the button.)
- `renderProviderAccountRow(a)`: reuse ALL existing row classes (`account-row`, `account-row-avatar`, `account-plan-badge` with `a.plan`, `account-row-secondary` email, `_accountUsageRowHtml('5h', a.usage.five_hour, false)` + `('week', a.usage.seven_day, true)`, ACTIVE pill, radio, pencil). No machine segments. `data-account-id` attribute (not data-profile-id) so the legacy delegated handler ignores these rows; extend the L8185 list click handler with an `.account-row[data-account-id]` branch that stages into state.codexAccounts, plus pencil -> `renameProviderAccount`, and the capture button id `account-capture-provider-btn`.
- Footer: pending line `Codex: <name>`; Save handler branches per tab (`applyStagedProviderAccount()`: confirm modal 'Switch Codex account?', message includes the restart note 'the swap affects only new Codex sessions', POST apply, toast outcomes, clear staging, background reload). Do NOT offer restartAllSessions for Codex in v1 (that helper restarts every session; a per-provider restart is future work; the toast carries the note instead).
- SSE: add `provider-accounts:changed` and `provider-accounts:usage` cases beside L11014/L11047 (same self-echo suppression via `_credSelfActionUntil`; changed -> reload roster for `payload.providerId` if that tab has ever loaded; usage -> merge by accountId; cases MUST exist to avoid the default loadAll storm).
- Countdown tick: nothing to add, `_tickAccountCountdowns` L9484 already sweeps `[data-reset-at]` inside `#account-switcher`, which covers Codex rows automatically.
- Chip (closed state) stays Claude-driven; unchanged.

## PART 4: PROVIDER-ABSTRACTION PLAN (gate stays green)
- codex literals: ONLY in `src/providers/codex/accounts.js` and `src/providers/codex/index.js` (excluded subtree).
- `src/web/provider-account-manager.js` and `provider-account-routes.js`: fully capability-parameterized; the require path string and `'codex-accounts'`-style strings never appear (they come from the capability). Expected new markers: ZERO in src/web and ZERO in app.js (data-kind/data-provider-tab live in HTML; API paths are built from dataset values).
- Claude does NOT migrate onto the generic manager in this build (1698 proven lines; code-preservation rule). Document in the plan doc that a future phase may re-express createCredentialManager as a claude capability.
- server.js gets 2 new SSE type registrations + ~12 wiring lines; no literals.
- Run `node test/grep-gate.test.js` as the acceptance gate.

## PART 5: USAGE VERDICT AND TOKEN POLICY
### 5.1 Usage: REAL
`GET https://chatgpt.com/backend-api/wham/usage` verified 200 with the CLI access token + chatgpt-account-id header (Part 2.2). Codex rows render 5h + week bars with exact reset times, same visuals as Claude. Do not render Opus/Fable-style per-model bars (no per-model data upstream); `additional_rate_limits` is captured into the snapshot but not rendered in v1.
### 5.2 Token refresh: DO NOT, in v1
The workbook never calls `auth.openai.com/oauth/token`. Rationale: refresh consumes/rotates the stored lineage exactly like the Claude lineage hazard (manager L853 comments), but for Codex the CLI itself heals everything on next launch since switching restores the full auth.json including refresh_token. Consequences accepted: an inactive account whose access token aged past ~10 days shows 'usage unavailable' with an `accessExpired` hint until it is made active once (Codex then refreshes and the watcher recaptures the fresh pair). This is honest and zero-risk. Revisit only if Arthur wants always-fresh meters for parked accounts.

## PART 6: SECURITY CHECKLIST
1. Store location `~/.myrlin/codex-accounts/` is outside the repo; the npm tarball uses the files allow-list `["src/", ...]` (package.json, verified), so account stores can never be packaged. No .gitignore change needed (nothing under the repo).
2. Snapshots and backups written 0600 best effort via writeFileAtomic mode option.
3. getSafeList whitelists derived fields only; routes serialize ONLY that shape (mirror credential-routes header contract). Tokens never in responses, SSE payloads, logs, or URLs; error `detail` strings must never interpolate token material.
4. All six routes behind `requireAuth` (same bearer middleware as /api/credentials; verify with a 401 test).
5. accountId path segments gated by `validateAccountUuid` before any path.join (reused export).
6. JWT decode is parse-only; treat all claims as UNTRUSTED display data (escapeHtml at render, already standard in renderAccountRow).
7. Watcher/read paths never log file contents on parse failure, only the error message.
8. Backups contain live tokens: same 0600 + prune-to-20 policy as Claude backups.
9. The live usage probe pattern (Authorization header, GET only) mirrors fetchUsage; no token ever rides in a query string.

## PART 7: RANKED EDGE CASES
1. Active account not yet captured when switching: handled by apply step 5 (capture-before-overwrite). MUST-HAVE, tested.
2. No ~/.codex/auth.json (not installed / never logged in): list returns installed:false; tab shows the login-hint empty state; watcher poll tolerates missing file (statSync catch, manager L1549 pattern); capture returns 500 ACCT_LIVE_STATE_UNREADABLE.
3. apikey auth_mode: not capturable (422), active row area shows the API-key notice, activeAccountId null so no row is ACTIVE; switching TO a stored chatgpt account still works and backs up the api-key file first.
4. Switch to already-active: `{alreadyActive:true}` no-op, no writes, toast 'already active'.
5. Duplicate capture / login echo: dedupe by tokens.account_id; strictly-newer last_refresh merge prevents regressions; self-write guard prevents apply echoes.
6. Running Codex session during switch: swap affects only NEW codex processes (CLI reads auth at startup); restartNote in the response + confirm modal copy; never auto-restart.
7. Expired access token on a stored account: usage skipped, `accessExpired:true` hint; apply proceeds with warning (5.2).
8. Malformed/truncated auth.json mid-write by codex CLI: parse failure skips the sync; debounce + poll retries; never crash the server.
9. Concurrent GUI clients: promise-chain mutex serializes mutations; SSE keeps rosters converged; self-echo suppression via `_credSelfActionUntil`.
10. Busy ~/.codex dir (892MB sqlite churn): watcher callback filters filename first; poll fallback stats only auth.json.
11. Old server + new frontend: 404 on /api/provider-accounts marks the Codex tab unavailable; Claude tab unaffected (mirrors L8338).
12. Mac: deferred for Codex. Machines strip renders only on the Claude tab; spec notes future `codexAccountsSync` would need ~/.codex on the Mac plus a remote profile tool.

## PART 8: TEST PLAN (all hermetic; add each file to the standaloneTests list at the bottom of test/run.js)
1. `test/codex-accounts-capability.test.js`: decodeJwtPayload with a SYNTHETIC token (base64url of a fabricated payload with email/plan/account_id/exp; never a real token in fixtures) and malformed inputs (null, empty, 2 segments, bad base64, non-JSON payload, huge string); parseAccountFromAuth for chatgpt mode, apikey mode, missing tokens, id_token/account_id mismatch; mapUsageResponse epoch-seconds conversion, missing windows, junk input.
2. `test/provider-account-manager.test.js` (mirror credential-manager.test.js harness: `require('./_test-data-dir')` first, tmpdir fake CODEX home via a test capability whose authFilePath points into the sandbox, local http stub for the usage URL): capture, auto-capture on watcher fire, dedupe, strictly-newer merge, label carry-forward, apply happy path (backup file exists, atomic write, verify), apply captures uncaptured active first, alreadyActive no-op, needs_login blocks, verify-failure restores backup, delete, usage 200 mapping + identity heal, usage 401-unexpired -> needs_login vs 401-expired -> unchanged, timeout -> lastError only, safe list NEVER contains the substrings access_token/refresh_token/id_token (leak gate, mirrors the Claude one).
3. `test/provider-account-routes.test.js` (real Express + fake manager map): 401 without bearer; all six routes; unknown provider 404; SSE broadcast types + payload key discipline (accountId, providerId, no `id`); response leak gate.
4. Source gates: `node test/grep-gate.test.js` green with zero new markers; css-tokens + phantom-tokens gates green after the .account-tabs CSS.
5. Frontend smoke (existing pattern, e.g. provider-tabs.test.js string-gates over app.js/index.html): tab markup present, data-kind branch exists, SSE cases exist for both provider-accounts types.
6. Manual QA (CDP visual-qa after deploy): tab switch under 200ms, Codex rows with live usage, empty state with codex logged out (rename auth.json aside TEMPORARILY in a sandbox HOME, not the real one), switch + `codex login status`/new session verification, switch back.

## PART 9: SCOPE DECISIONS (approved defaults for v1)
1. Header chip stays Claude-only (Codex state visible only inside the panel).
2. Codex-on-Mac sync deferred (Claude machine strip untouched; Codex tab shows no machine strip).
3. No workbook-side token refresh (parked Codex accounts older than ~10 days show 'usage unavailable' until used once; honest and zero-risk).
