# Credential Expiry Labeling Fix: Build-Ready Spec

> Root-caused by Fable investigation 2026-07-16. Decisions locked by Arthur: proactive refresh ON by default (lineage-gated), write-back guard built + experiment later.
> All file:line refs are src/web/credential-manager.js unless noted. Verify as you read; they may drift.
> Sequenced AFTER the delete+Codex build (feat/codex-account-switcher) so it does not conflict on credential-manager.js / credential-routes.js / app.js / styles.css. Build ON TOP of that branch (or off the merged main once it lands).

## Root cause (for context)
Refresh tokens are one-time-use; a successful refresh rotates the pair and kills the old token server-side (documented at lines 806-815, 1099-1103). The workbook stores one refresh-token copy per account. Any OTHER holder of the same login lineage (a running CLI session left on an account after a switch, a Mac-installed profile, an old claude-swap copy) refreshes on its own 8h boundary and invalidates the workbook's stored copy. Next workbook refresh gets invalid_grant (or a Cloudflare 403 false positive) and the row is marked needs_login. Timing fingerprint: rejections land ~8 to 13h after the workbook's own last successful rotation. Access token lifetime is exactly 8h. The account is NOT dead; a single /login re-captures it (watcher resurrection, lines 963-967). `lastRefreshError` is written null by the rejection path (line 902), erasing the evidence (a diagnosability bug).

## Phase 1: manager, honest state model (credential-manager.js)
1. Split refreshInactiveToken verdicts (lines 700-764): return `rejected` ONLY for 400/401 body `error === 'invalid_grant'`; return `suspect` for any 403 and for 401 with no parseable body; keep transient (429/5xx/network/timeout) unchanged. Currently 403 and 401-no-body both map straight to needs_login (749-757); demote them to `suspect`.
2. Stop nulling evidence. At the needs_login writes (894-902 usage path, 1409-1411 apply-path twin): write `lastRefreshError: { at: clock(), kind: 'auth', status, detail }` instead of null. At the no-refresh-token writes (883-886, 1399-1400): `kind: 'no_refresh_token'`. getSafeList already forwards at/kind/status (1595-1599).
3. Suspect ladder: on `suspect`, keep the prior tokenState, record `lastRefreshError: { kind: 'auth_suspect', count: (priorCount||0)+1, at, status }`. Escalate to needs_login only when count reaches `SUSPECT_ESCALATE_COUNT` (new named const = 3) consecutive suspects. A single Cloudflare 403 no longer nukes the row.
4. Dead-retry window: relax the needs_login skip at 888-892 so an account with tokenState needs_login IS retried (even without force) when `lastRefreshError.at` is older than `DEAD_RETRY_MIN` (new const = 6h in ms). A repeat invalid_grant is harmless and self-heals WAF false positives.
5. Health mapping (healthFor, ~129-139 and getSafeList): tokenState `ok` carrying a `lastRefreshError.kind === 'auth_suspect'` maps to `needs-attention` (amber), not healthy and not red.
Reuse existing constants: ANTHROPIC_TOKEN_URL, TOKEN_STATE_OK/NEEDS_LOGIN/UNVERIFIED. Preserve the rotate-then-persist ordering (897-899: persist the rotated pair IMMEDIATELY, before any use). No new bare 'claude'/'codex' literals (grep gate). No em dashes.

## Phase 2: frontend (app.js + styles.css)
- accountHealth (8831-8837) already trusts server health. Add rendering for the amber `needs-attention` suspect rows: copy like "Temporary auth issue, retrying" keyed off `p.health` + `p.lastRefreshError.kind === 'auth_suspect'`.
- Dead (needs-re-login) rows (dead note 8533-8534): soften copy to "Signed out here. Run /login as this account once, or press Retry." Add a small **Retry** button in the row wired to the EXISTING per-profile force route: POST /api/credentials/refresh-usage `{ profileId }` (credential-routes.js:228). On success the SSE credentials:usage/changed refreshes the row. Rows stay unstageable while dead (8880, 8899, 8926, tabindex -1 at 8571) until the retry succeeds.
- CSS: a `.account-retry-btn` near the row-action rules using existing tokens; amber state reuses the existing needs-attention styling. css-tokens + phantom-tokens gates stay green.

## Phase 3: proactive background refresh (ON by default, lineage-gated) - Arthur chose on-by-default
- New setting `proactiveRefreshMinutes` under store.settings.credentialSwitcher; DEFAULT = 20 (non-zero = on). Interval clamped to a sane floor (e.g. min 10 min).
- server.js: start a `setInterval` next to startCredentialWatcher (server.js:8656), cleared in the cleanup at ~8662, that calls a new manager method `proactiveRefreshSweep()`. Guard the interval on proactiveRefreshMinutes > 0.
- `proactiveRefreshSweep()` refreshes ONLY accounts that ALL of:
  - are NOT the PC-active account (never refresh the live account; it races the CLI, existing concern),
  - are NOT flagged Mac-active by the existing lineage hint (gate at 867-877),
  - tokenState === ok (do not hammer dead/suspect rows here; dead-retry handles those on its own 6h cadence),
  - have no recent `auth_suspect` backoff,
  - expiresAt is within `PROACTIVE_REFRESH_WINDOW_MIN` (new const = 30 min) of lapsing (refresh just-in-time, not constantly).
  - Rotate-then-persist ordering preserved (persist the new pair atomically BEFORE the usage call).
- RISK Arthur accepted: proactively rotating an idle account makes the workbook win the lineage and can log out a CLI session still running on that previously-active account, and reuse detection can revoke the family. The gates above minimize but do not eliminate this. Document it in a WHY comment and the CHANGELOG.

## Phase 4: write-back theft guard (build the guard; experiment deferred, NOT run live)
- Mechanism theory: a running CLI session, after the user switches accounts, may refresh and write its rotated OLD-account tokens into ~/.claude/.credentials.json; `_syncActiveTokenToProfileUnlocked` (932-974) would then adopt those tokens onto the NEW active account's snapshot (identity/token mismatch), corrupting which snapshot owns which token and accelerating lineage death.
- Guard: before adopting live credentials in `_syncActiveTokenToProfileUnlocked`, reject adoption when the live accessToken equals the stored accessToken of a DIFFERENT snapshot (i.e. the live token belongs to another account). Skip the merge, log a benign diagnostic (no token value), leave both snapshots intact.
- Do NOT run the confirming experiment live (it would switch Arthur's active account mid-work). Note it as a controlled follow-up: on an adjacent instance with sandbox HOME, switch accounts while an old session runs, watch .credentials.json.

## Tests (hermetic, injected fetchImpl per existing pattern in test/credential-manager*.test.js)
- verdict split: invalid_grant -> rejected -> needs_login (after ladder); 403 -> suspect -> stays ok until 3rd -> needs_login; 429/5xx/timeout -> transient, unchanged.
- lastRefreshError is now populated (kind auth / auth_suspect / no_refresh_token), never null on a rejection.
- dead-retry: a needs_login snapshot with lastRefreshError.at older than 6h IS retried without force.
- health mapping: ok+auth_suspect -> needs-attention.
- proactiveRefreshSweep: refreshes only inactive-non-Mac ok accounts within the 30-min window; skips active, Mac-active, suspect, and not-near-expiry; persists rotated pair before use; default setting non-zero.
- write-back guard: adoption rejected when live accessToken matches another snapshot's stored token.
- frontend source-scan gate: Retry button markup + handler calling the force route; suspect/dead copy branches.
- grep-gate PASS (zero new markers); css/phantom-token gates green; leak gate (safe list never contains token substrings) still green.
- CHANGELOG [Unreleased]; version bump continues the 1.3.0-alpha line.

## Immediate recovery for Arthur's 6 currently-red accounts (operational, not code)
Either /login as each once (auto-recapture), or after Phase 1+2 land, press Retry on each row to discover which were Cloudflare 403 false positives vs genuinely rotated-out.
