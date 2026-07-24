/**
 * HTTP routes for the Claude account switcher (design section 4).
 *
 * Every route requires the workbook's own bearer auth (src/web/auth.js;
 * completely unrelated to the Claude OAuth credentials being managed) and
 * every error goes through structuredError. Responses only ever serialize
 * the manager's safe projection (getSafeList); token material never reaches
 * the browser in any HTTP or SSE payload.
 *
 * SSE payloads use `profileId`, never a bare `id` key, so broadcastSSE's
 * workspace-id extraction cannot misfile them; the event types are also
 * registered in GLOBAL_EVENT_TYPES (server.js) as the second guard.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Copy shown after every successful apply (design 4.3): sets restart
// expectations without auto-restarting anything.
const RESTART_NOTE = 'New sessions use this account immediately. Running sessions keep the previous account until restarted.';

// A cached Mac inventory sweep older than this is reported as stale; the
// frontend then auto-refreshes on panel open instead of trusting it.
const MAC_STATE_TTL_MS = 5 * 60 * 1000;

/**
 * Register the credential switcher routes on the Express app.
 *
 * @param {import('express').Express} app - The Express app.
 * @param {object} deps
 * @param {Function} deps.requireAuth - Bearer auth middleware.
 * @param {() => object} deps.getStore - Store accessor (settings persistence).
 * @param {(type: string, data: object) => void} deps.broadcast - SSE broadcast.
 * @param {Function} deps.structuredError - The server's error serializer.
 * @param {object} deps.manager - createCredentialManager() instance.
 * @param {object} [deps.macBridge] - mac-bridge module (optional; injectable
 *   for tests, gated by config and CWM_CRED_DISABLE_MAC at request time).
 * @returns {void}
 */
function setupCredentialRoutes(app, { requireAuth, getStore, broadcast, structuredError, manager, macBridge }) {
  /**
   * Broadcast wrapper: an SSE failure must never fail a route.
   *
   * @param {string} type - Event type.
   * @param {object} data - Event payload (profileId keys only, never id).
   * @returns {void}
   */
  function safeBroadcast(type, data) {
    try { broadcast(type, data); } catch (_) { /* SSE must never fail a route */ }
  }

  /**
   * Map a thrown manager error onto structuredError. Errors created via
   * credError carry .status/.code/.retryable; anything else is a 500.
   *
   * @param {import('express').Response} res
   * @param {Error} err
   * @returns {import('express').Response}
   */
  function mapError(res, err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    const code = (err && err.code && typeof err.code === 'string') ? err.code : 'CRED_INTERNAL';
    const message = (err && err.message) ? err.message : 'Internal credential manager error';
    return structuredError(res, status, code, message, !!(err && err.retryable));
  }

  /**
   * Reject a credential mutation when ownership has been handed to the
   * external Myrlin bridge. Older injected manager fakes do not expose the
   * guard and retain their historical behavior.
   *
   * @param {import('express').Response} res
   * @param {string} operation - Human-readable operation for the conflict.
   * @returns {import('express').Response|null} Conflict response, or null.
   */
  function rejectExternalOwnerMutation(res, operation) {
    if (typeof manager.assertCredentialPoolWritable !== 'function') return null;
    try {
      manager.assertCredentialPoolWritable(operation);
      return null;
    } catch (err) {
      return mapError(res, err);
    }
  }

  /**
   * Read the manager's passive-mode state without making marker presence an
   * implicit opt-in. Missing methods on older test fakes mean writable.
   *
   * @returns {boolean}
   */
  function credentialPoolIsReadOnly() {
    return typeof manager.isCredentialPoolReadOnly === 'function'
      && manager.isCredentialPoolReadOnly();
  }

  /**
   * Summarize the mac mirror config for list responses (no secrets; host
   * and user are already non-secret connection metadata).
   *
   * @returns {{configured: boolean, enabled: boolean, host: string, user: string}}
   */
  function macSummary() {
    const mac = manager.getSettings().mac;
    return {
      configured: !!(mac.host && mac.user),
      enabled: !!mac.enabled,
      host: mac.host || '',
      user: mac.user || '',
    };
  }

  /**
   * Send the canonical list response (design 4.1): the safe projection plus
   * the mac summary. The ONLY roster shape any route serializes.
   *
   * @param {import('express').Response} res
   * @returns {import('express').Response}
   */
  function sendList(res) {
    const list = manager.getSafeList();
    return res.json({ ...list, mac: macSummary() });
  }

  /**
   * True when the Mac mirror may run for this process: bridge present,
   * config enabled and complete, and not disabled via env (tests set
   * CWM_CRED_DISABLE_MAC=1 so no SSH can ever fire in CI).
   *
   * @returns {boolean}
   */
  function macMirrorAvailable() {
    if (process.env.CWM_CRED_DISABLE_MAC === '1') return false;
    if (!macBridge || typeof macBridge.mirrorToMac !== 'function') return false;
    const mac = manager.getSettings().mac;
    return !!(mac.enabled && mac.host && mac.user);
  }

  /**
   * Like macMirrorAvailable, but for the inventory sweep: also requires the
   * bridge's readMacInventory and the manager's mac-state surface (both
   * absent on older injected fakes, which then simply see the feature as
   * unavailable instead of crashing a route).
   *
   * @returns {boolean}
   */
  function macStateAvailable() {
    if (process.env.CWM_CRED_DISABLE_MAC === '1') return false;
    if (!macBridge || typeof macBridge.readMacInventory !== 'function') return false;
    if (typeof manager.runMacExclusive !== 'function' || typeof manager.setMacState !== 'function') return false;
    const mac = manager.getSettings().mac;
    return !!(mac.enabled && mac.host && mac.user);
  }

  /**
   * Compute staleness of a cached sweep against MAC_STATE_TTL_MS. A missing
   * cache or an unparseable timestamp reads as stale (the frontend then
   * probes on next panel open).
   *
   * @param {object|null} state - Cached sweep from manager.getMacState().
   * @returns {boolean} True when the cache should not be trusted.
   */
  function macStateIsStale(state) {
    const checkedAtMs = state && state.checkedAt ? Date.parse(state.checkedAt) : NaN;
    return !Number.isFinite(checkedAtMs) || (Date.now() - checkedAtMs) > MAC_STATE_TTL_MS;
  }

  /**
   * Perform ONE Mac inventory sweep: read active name, installed profiles,
   * live token text, and identity in a single SSH round trip; match names
   * to local snapshots by slug; merge the Mac-active account's freshest
   * tokens back into its snapshot; update the cache; and broadcast the
   * sanitized result. Runs under the manager's Mac mutex so sweeps and
   * profile applies can never interleave their SSH conversations, while
   * the snapshot mutex is only taken for the short local merge.
   *
   * SECURITY: inv.liveCredText is consumed HERE (handed to syncBackFromMac)
   * and never copied onto the returned/cached/broadcast state object.
   *
   * An unreachable Mac is a STATE, not an error: the sweep resolves with
   * reachable:false and the route replies 200.
   *
   * @returns {Promise<object>} The sanitized, cached state object.
   */
  async function refreshMacState() {
    const settings = manager.getSettings();
    const cfg = { ...settings.mac, sshTimeoutSec: settings.sshTimeoutSec };
    const state = await manager.runMacExclusive(async () => {
      const inv = await macBridge.readMacInventory(cfg);
      const nowIso = new Date().toISOString();
      if (!inv || !inv.reachable) {
        return {
          checkedAt: nowIso,
          reachable: false,
          activeName: null,
          activeProfileId: null,
          profiles: [],
          ...(inv && inv.error ? { error: inv.error } : {}),
        };
      }
      const matched = (typeof macBridge.resolveInventoryProfiles === 'function')
        ? macBridge.resolveInventoryProfiles(manager, inv)
        : { activeProfileId: null, profiles: [] };
      if (matched.activeProfileId && inv.liveCredText && typeof manager.syncBackFromMac === 'function') {
        // Adopt the Mac's freshest rotated tokens for the matched active
        // account (strictly-newer merge; never regresses a fresher local
        // snapshot). Best effort: a merge failure must not fail the sweep.
        try { await manager.syncBackFromMac(matched.activeProfileId, inv.liveCredText); } catch (_) { /* sweep continues */ }
      }
      // Keep the persisted Mac-active hint honest with observed reality:
      // the sweep is the ground truth for what the Mac is running.
      if (typeof manager.setMacActiveHint === 'function') {
        try { manager.setMacActiveHint(matched.activeProfileId || null); } catch (_) { /* hint is advisory */ }
      }
      return {
        checkedAt: nowIso,
        reachable: true,
        activeName: inv.activeName || null,
        activeProfileId: matched.activeProfileId || null,
        profiles: matched.profiles || [],
      };
    });
    const cached = manager.setMacState(state);
    // Names and uuids only; the setMacState whitelist guarantees no secret
    // field can exist on this payload.
    safeBroadcast('credentials:mac', { state: cached });
    return cached;
  }

  // ─── GET /api/credentials ─────────────────────────────────────────────
  // List the roster. Side effects: the sentinel-gated one-time claude-swap
  // seed (a harmless no-op once the startup seed in startServer has run;
  // kept as a belt-and-braces path for stores created before that seed
  // existed), and a cheap guarded sync so the active account always appears.
  // NO network usage calls (pure cache read).
  app.get('/api/credentials', requireAuth, async (req, res) => {
    try {
      // In passive mode this GET is a true read: no seed sentinel, snapshot
      // import, or live-token sync-back may ride on a list request.
      if (!credentialPoolIsReadOnly()) {
        try { await manager.seedFromClaudeSwap(); } catch (_) { /* seed is best effort */ }
        try { await manager.syncActiveTokenToProfile(); } catch (_) { /* sync is best effort */ }
      }
      return sendList(res);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── POST /api/credentials/refresh-usage ──────────────────────────────
  // Body { profileId } forces one profile past the TTL; {} refreshes every
  // snapshot whose cache is stale. Per-profile usage failure is NOT a route
  // error (rows keep their stale cache; dead tokens surface in the list).
  app.post('/api/credentials/refresh-usage', requireAuth, async (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Usage refresh');
    if (ownershipConflict) return ownershipConflict;
    try {
      const body = req.body || {};
      if (body.profileId !== undefined) {
        if (typeof body.profileId !== 'string' || !body.profileId) {
          return structuredError(res, 400, 'VALIDATION', 'profileId must be a non-empty string', false);
        }
        await manager.updateSnapshotUsage(body.profileId, { force: true });
      } else {
        const snaps = manager.listSnapshots();
        for (const snap of snaps) {
          try {
            await manager.updateSnapshotUsage(snap.accountUuid, { force: false });
          } catch (_) { /* per-profile failure never fails the batch */ }
        }
      }
      const list = manager.getSafeList();
      safeBroadcast('credentials:usage', { profiles: list.profiles });
      return res.json({ ...list, mac: macSummary() });
    } catch (err) {
      return mapError(res, err);
    }
  });

  /**
   * Optimistically update the mac-state cache after a VERIFIED Mac apply
   * and broadcast it. The apply itself just verified the active marker and
   * the live token file over SSH, so this cache write reflects observed
   * reality without spending a second round trip on a full sweep.
   *
   * @param {string} profileId - The accountUuid now active on the Mac.
   * @param {string} [name] - The remote profile slug (from the bridge result).
   * @returns {void}
   */
  function noteMacApplied(profileId, name) {
    if (typeof manager.setMacState !== 'function') return;
    const prev = (typeof manager.getMacState === 'function' && manager.getMacState()) || null;
    let profiles = (prev && Array.isArray(prev.profiles)) ? prev.profiles.slice() : [];
    let slug = name || null;
    if (!slug && macBridge && typeof macBridge.profileSlug === 'function') {
      try {
        const snap = manager.readSnapshot(profileId);
        if (snap) slug = macBridge.profileSlug(snap);
      } catch (_) { slug = null; }
    }
    if (slug) {
      // The applied profile is now both installed and active; replace any
      // stale mapping for that remote name.
      profiles = profiles.filter((p) => p && p.name !== slug);
      profiles.push({ name: slug, profileId });
    }
    const cached = manager.setMacState({
      checkedAt: new Date().toISOString(),
      reachable: true,
      activeName: slug,
      activeProfileId: profileId,
      profiles,
    });
    safeBroadcast('credentials:mac', { state: cached });
  }

  // ─── POST /api/credentials/apply ──────────────────────────────────────
  // The swap, per machine. Two accepted body shapes:
  //   legacy: { profileId, mirrorToMac? } - PC apply plus optional Mac
  //           mirror of the SAME profile; behavior, statuses, and response
  //           fields unchanged (old clients keep working byte for byte).
  //   new:    { pc?: profileId, mac?: profileId } - each machine applied
  //           INDEPENDENTLY; a Mac-only body skips the PC transaction
  //           entirely, and a Mac failure NEVER rolls back a successful PC
  //           apply. In this shape per-machine failures ride in `machines`
  //           with HTTP 200 (the other machine may have succeeded), except
  //           when only one machine was requested and its apply threw, in
  //           which case the historical error statuses are kept.
  // PC always runs first so the Mac push ships the freshest PC state.
  app.post('/api/credentials/apply', requireAuth, async (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Credential apply');
    if (ownershipConflict) return ownershipConflict;
    const body = req.body || {};
    const legacy = body.profileId !== undefined;
    let pcTarget = null;
    let macTarget = null;
    if (legacy) {
      if (typeof body.profileId !== 'string' || !body.profileId) {
        return structuredError(res, 400, 'VALIDATION', 'profileId must be a non-empty string', false);
      }
      pcTarget = body.profileId;
      macTarget = body.mirrorToMac === true ? body.profileId : null;
    } else {
      if (body.pc !== undefined) {
        if (typeof body.pc !== 'string' || !body.pc) {
          return structuredError(res, 400, 'VALIDATION', 'pc must be a non-empty profileId string', false);
        }
        pcTarget = body.pc;
      }
      if (body.mac !== undefined) {
        if (typeof body.mac !== 'string' || !body.mac) {
          return structuredError(res, 400, 'VALIDATION', 'mac must be a non-empty profileId string', false);
        }
        macTarget = body.mac;
      }
      if (!pcTarget && !macTarget) {
        return structuredError(res, 400, 'VALIDATION', 'Provide profileId (legacy) or at least one of pc / mac', false);
      }
    }

    // ── PC transaction first (the Mac never gates it) ──
    let result = { applied: false, alreadyActive: false, email: '' };
    let pcMachine = null;
    if (pcTarget) {
      try {
        result = await manager.applyCredential(pcTarget);
        pcMachine = {
          requested: true,
          applied: !!result.applied,
          alreadyActive: !!result.alreadyActive,
          profileId: pcTarget,
          ...(result.warning ? { warning: result.warning } : {}),
        };
      } catch (err) {
        if (legacy || !macTarget) return mapError(res, err); // historical statuses
        // Both machines requested: report the PC failure per-machine and
        // continue to the INDEPENDENT Mac apply.
        pcMachine = {
          requested: true,
          applied: false,
          alreadyActive: false,
          profileId: pcTarget,
          error: (err && typeof err.code === 'string') ? err.code : 'CRED_INTERNAL',
          message: (err && err.message) || 'PC apply failed',
        };
      }
    }

    // ── Mac apply second; failures ride in the response, never a rollback ──
    let mac = { attempted: false, mirrored: false }; // legacy summary field
    let macMachine = null;
    // Legacy semantics preserved exactly: the mirror only ever ran after a
    // successful PC apply (alreadyActive skipped it). The new shape applies
    // the Mac independently of the PC outcome.
    const macWanted = !!macTarget && (legacy ? !!result.applied : true);
    if (macWanted && macMirrorAvailable()) {
      const settings = manager.getSettings();
      const cfg = { ...settings.mac, sshTimeoutSec: settings.sshTimeoutSec };
      // Prefer the explicit install+activate entry point; fall back to the
      // mirrorToMac alias for older injected fakes.
      const applyFn = (typeof macBridge.applyProfileOnMac === 'function')
        ? macBridge.applyProfileOnMac : macBridge.mirrorToMac;
      // The Mac mutex keeps this apply's SSH conversation from ever
      // interleaving with an inventory sweep's.
      const runEx = (typeof manager.runMacExclusive === 'function')
        ? manager.runMacExclusive : ((fn) => fn());
      let m;
      try {
        m = await runEx(() => applyFn(manager, cfg, macTarget));
      } catch (err) {
        m = { mirrored: false, error: 'MAC_UNREACHABLE', message: (err && err.message) || 'mirror failed' };
      }
      mac = {
        attempted: true,
        mirrored: !!(m && m.mirrored),
        ...(m && m.error ? { error: m.error } : {}),
        ...(m && m.message ? { message: m.message } : {}),
        ...(m && m.warning ? { warning: m.warning } : {}),
      };
      macMachine = {
        requested: true,
        applied: !!(m && m.mirrored),
        profileId: macTarget,
        ...(m && m.error ? { error: m.error } : {}),
        ...(m && m.message ? { message: m.message } : {}),
        ...(m && m.warning ? { warning: m.warning } : {}),
      };
      if (m && m.mirrored) noteMacApplied(macTarget, m.name);
    } else if (macWanted) {
      mac = { attempted: false, mirrored: false, message: 'Mac mirror is not configured or is disabled.' };
      macMachine = { requested: true, applied: false, profileId: macTarget, error: 'MAC_DISABLED', message: mac.message };
    }

    if (result.applied) {
      // Broadcast AFTER the PC commit, regardless of the Mac outcome.
      safeBroadcast('credentials:changed', {
        activeProfileId: pcTarget,
        email: result.email || '',
        appliedAt: new Date().toISOString(),
        mac: { attempted: mac.attempted, mirrored: mac.mirrored },
      });
    }
    return res.json({
      // Legacy top-level fields: PC-centric, unchanged for old clients.
      applied: !!result.applied,
      alreadyActive: !!result.alreadyActive,
      activeProfileId: pcTarget || manager.getActiveAccountUuid() || null,
      restartNote: RESTART_NOTE,
      ...(result.warning ? { warning: result.warning } : {}),
      mac,
      // Per-machine outcomes (new shape); null = machine not requested.
      machines: { pc: pcMachine, mac: macMachine },
    });
  });

  // ─── POST /api/credentials/capture ────────────────────────────────────
  // Snapshot the live PC pair with an optional friendly label.
  app.post('/api/credentials/capture', requireAuth, async (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Credential capture');
    if (ownershipConflict) return ownershipConflict;
    try {
      const body = req.body || {};
      const snap = await manager.captureCurrent({ label: body.label });
      safeBroadcast('credentials:changed', { captured: true, profileId: snap.accountUuid });
      return sendList(res);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── PUT /api/credentials/:profileId/label ────────────────────────────
  // Rename. Trim, cap 60 (400 beyond), empty clears back to the fallback.
  app.put('/api/credentials/:profileId/label', requireAuth, async (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Credential label update');
    if (ownershipConflict) return ownershipConflict;
    try {
      const body = req.body || {};
      const snap = await manager.setLabel(req.params.profileId, body.label != null ? body.label : '');
      safeBroadcast('credentials:changed', { renamed: true, profileId: snap.accountUuid });
      return sendList(res);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── DELETE /api/credentials/:profileId ───────────────────────────────
  // Removes the snapshot file only (never live files, never remote files).
  app.delete('/api/credentials/:profileId', requireAuth, async (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Credential snapshot delete');
    if (ownershipConflict) return ownershipConflict;
    try {
      const profileId = req.params.profileId;
      await manager.deleteSnapshot(profileId);
      safeBroadcast('credentials:changed', { deleted: true, profileId });
      return sendList(res);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── GET /api/credentials/mac-config ──────────────────────────────────
  // Current Mac mirror config (merged over defaults; no secrets involved).
  app.get('/api/credentials/mac-config', requireAuth, (req, res) => {
    try {
      const mac = manager.getSettings().mac;
      return res.json({
        enabled: !!mac.enabled,
        host: mac.host || '',
        user: mac.user || '',
        profileTool: mac.profileTool || '',
        postSwapCommand: mac.postSwapCommand || '',
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── PUT /api/credentials/mac-config ──────────────────────────────────
  // Persist the Mac mirror config. Host/user are charset-validated (ssh
  // option-injection guard). No connectivity probe here; the probe happens
  // naturally at mirror time with a clean MAC_UNREACHABLE.
  app.put('/api/credentials/mac-config', requireAuth, (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Credential switcher configuration update');
    if (ownershipConflict) return ownershipConflict;
    try {
      const body = req.body || {};
      const cur = manager.getSettings().mac;
      const next = {
        enabled: body.enabled !== undefined ? !!body.enabled : !!cur.enabled,
        host: body.host !== undefined ? String(body.host) : cur.host,
        user: body.user !== undefined ? String(body.user) : cur.user,
        profileTool: body.profileTool !== undefined ? String(body.profileTool) : cur.profileTool,
        postSwapCommand: body.postSwapCommand !== undefined ? String(body.postSwapCommand) : cur.postSwapCommand,
      };
      const TARGET_RE = /^[A-Za-z0-9._@-]+$/;
      if (!next.host || !TARGET_RE.test(next.host) || next.host.startsWith('-')) {
        return structuredError(res, 400, 'VALIDATION', 'mac host must match ^[A-Za-z0-9._@-]+$ and must not start with a dash', false);
      }
      if (!next.user || !TARGET_RE.test(next.user) || next.user.startsWith('-')) {
        return structuredError(res, 400, 'VALIDATION', 'mac user must match ^[A-Za-z0-9._@-]+$ and must not start with a dash', false);
      }
      const store = getStore();
      const curAll = (store.settings && store.settings.credentialSwitcher) || {};
      // updateSettings does a shallow Object.assign on settings, so the
      // whole credentialSwitcher object is merged and rewritten here.
      store.updateSettings({ credentialSwitcher: { ...curAll, mac: next } });
      return res.json(next);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── GET /api/credentials/mac-state ───────────────────────────────────
  // Serve the CACHED result of the last Mac inventory sweep. NEVER triggers
  // SSH; instant by construction. `stale` tells the client the cache is
  // older than MAC_STATE_TTL_MS (or absent) and worth a refresh. `available`
  // is false when the bridge is disabled/unconfigured so the client can
  // hide the feature rather than show a permanently stale strip.
  app.get('/api/credentials/mac-state', requireAuth, (req, res) => {
    try {
      const state = (typeof manager.getMacState === 'function') ? manager.getMacState() : null;
      return res.json({
        mac: macSummary(),
        available: macStateAvailable(),
        state: state || null,
        stale: macStateIsStale(state),
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── POST /api/credentials/mac-state/refresh ──────────────────────────
  // Perform ONE inventory sweep (single SSH round trip), sync the matched
  // Mac-active account's tokens back, update the cache, and broadcast
  // credentials:mac. An offline Mac is a 200 with reachable:false, never an
  // error status: offline is a state the UI renders, not a failure.
  app.post('/api/credentials/mac-state/refresh', requireAuth, async (req, res) => {
    const ownershipConflict = rejectExternalOwnerMutation(res, 'Mac credential-state refresh');
    if (ownershipConflict) return ownershipConflict;
    try {
      if (!macStateAvailable()) {
        return res.json({
          mac: macSummary(),
          available: false,
          state: (typeof manager.getMacState === 'function') ? manager.getMacState() : null,
          stale: true,
        });
      }
      const state = await refreshMacState();
      return res.json({ mac: macSummary(), available: true, state, stale: false });
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── Lineage-gate support (manager <-> bridge decoupling) ─────────────
  // The manager's usage poller needs "pull fresh Mac state" (one sweep +
  // sync-back) when the Mac-active account's stored access token has
  // expired, but it cannot require the bridge itself (circular require:
  // the bridge already requires credential-manager). Register the sweep
  // here instead; it no-ops whenever the bridge is disabled/unconfigured.
  if (typeof manager.setMacStateRefresher === 'function') {
    manager.setMacStateRefresher(async () => {
      if (!macStateAvailable()) return null;
      return refreshMacState();
    });
  }
}

module.exports = { setupCredentialRoutes };
