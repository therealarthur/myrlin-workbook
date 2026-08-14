/**
 * Mac Mini bridge for the Claude account switcher (optional, config-gated).
 *
 * Mirrors an applied credential to the Mac Mini by reusing the Mac-native
 * ~/.local/bin/claude-profile tool. Format VERIFIED live on 2026-07-02 by
 * reading the script over SSH:
 *   profiles are RAW COPIES of ~/.claude/.credentials.json stored at
 *   ~/.claude-profiles/<name>.credentials.json (chmod 600), with the active
 *   profile name recorded in ~/.claude-profiles/active. 'claude-profile use'
 *   syncs the live file back into the outgoing profile, overlays the target,
 *   and restarts the forge agent. It swaps ONLY the token file; the Mac's
 *   ~/.claude.json identity is untouched by the tool, so verification here
 *   compares the live token file to the pushed profile (cmp) plus the
 *   active-name marker rather than the Mac identity email (which would
 *   spuriously mismatch by design).
 *
 * Security posture (design section 7):
 *   ssh host/user are charset-allowlisted (option-injection guard);
 *   secret payloads travel only as scp'd temp files, never on remote
 *   command lines (visible in process listings);
 *   local child processes use execFile with argv arrays, no shell.
 *
 * Mirror failures NEVER roll back a successful PC apply; every function
 * degrades to a structured warning object instead of throwing mid-route.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { serializeCredentialsFile } = require('./credential-manager');
// Leaf module, required by BOTH this bridge and the credential manager, so
// the shipped default host has exactly one definition. See mac-host.js for
// why it is not defined here (require cycle) and why the candidate chain is
// only ever a suggestion.
const macHost = require('./mac-host');

// Charset allowlist for ssh host/user; also rejected when starting with a
// dash (ssh option injection guard). Matches the design section 2.3 rule.
// Sourced from mac-host.js so the validator and the candidate builder can
// never drift apart; the local name and the exported behavior are unchanged.
const MAC_TARGET_RE = macHost.MAC_TARGET_RE;
// Reachability probe budget, per candidate. Short on purpose: the probe runs
// on a path where one host has ALREADY failed, so it must not multiply the
// operator's wait by the full ssh timeout for each address tried.
const HOST_PROBE_TIMEOUT_SEC = 6;
// The remote command the probe runs. Carries nothing, reads nothing, writes
// nothing: it exists only to prove that ssh could open a session.
const HOST_PROBE_COMMAND = 'true';
// Default remote profile tool path when config omits it.
const DEFAULT_PROFILE_TOOL = '$HOME/.local/bin/claude-profile';
// Cap slugs so remote filenames stay sane.
const SLUG_MAX_LENGTH = 40;
// The 'use' step restarts the forge agent (script sleeps about 6s plus
// process checks); give it a generous floor regardless of sshTimeoutSec.
const USE_TIMEOUT_FLOOR_SEC = 45;
// ssh option ConnectTimeout is capped so a large exec budget does not also
// stretch the TCP connect phase.
const CONNECT_TIMEOUT_CAP_SEC = 10;
// Host key policy for every ssh/scp invocation. WHY accept-new and not the
// ssh default (ask): BatchMode=yes means ssh can never prompt, so a host
// whose key is not yet in known_hosts (e.g. the Mac renamed from
// arthurs-mac-mini to alloy) would hard-fail every connection forever.
// accept-new performs trust-on-first-use, which is appropriate on the
// private tailnet these hosts live on, while STILL failing loudly if a
// previously known host presents a DIFFERENT key (the actual MITM signal).
// NEVER weaken this to 'no': that would also accept changed keys and
// silently swallow a real man-in-the-middle.
const HOST_KEY_POLICY = 'accept-new';

/**
 * Validate the ssh target. Throws on any charset violation or a leading
 * dash on host or user (which ssh would parse as an option).
 *
 * @param {{host?: string, user?: string}} cfg - Mac config.
 * @returns {true} When valid; throws otherwise.
 */
function validateMacTarget(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('mac config missing');
  const host = String(cfg.host || '');
  const user = String(cfg.user || '');
  if (!host || !MAC_TARGET_RE.test(host) || host.startsWith('-')) {
    throw new Error('mac host must match ^[A-Za-z0-9._@-]+$ and must not start with a dash');
  }
  if (!user || !MAC_TARGET_RE.test(user) || user.startsWith('-')) {
    throw new Error('mac user must match ^[A-Za-z0-9._@-]+$ and must not start with a dash');
  }
  return true;
}

/**
 * Resolve the execFile implementation for one bridge call. Tests inject a
 * fake through opts.execFileImpl so every bridge test is hermetic (zero
 * real ssh/scp processes ever spawn in CI); production callers omit it and
 * get the real child_process.execFile.
 *
 * @param {{execFileImpl?: Function}} [opts] - Per-call options bag.
 * @returns {Function} An execFile-compatible function.
 */
function _resolveExecFile(opts) {
  return (opts && typeof opts.execFileImpl === 'function') ? opts.execFileImpl : execFile;
}

/**
 * Run one remote command over ssh with BatchMode (never prompts) and
 * keep-alive options. Never throws; resolves a structured result. Exit
 * code 255 is ssh's own client/link error and maps to unreachable.
 *
 * @param {{host: string, user: string}} cfg - Validated mac config.
 * @param {string} remoteCommand - Command line for the remote shell.
 * @param {number} timeoutSec - Total execution budget in seconds.
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
function sshExec(cfg, remoteCommand, timeoutSec, opts = {}) {
  return new Promise((resolve) => {
    const t = Math.max(1, Number(timeoutSec) || 8);
    const connectT = Math.min(t, CONNECT_TIMEOUT_CAP_SEC);
    const args = [
      '-o', 'ConnectTimeout=' + connectT,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=' + HOST_KEY_POLICY,
      '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=2',
      cfg.user + '@' + cfg.host,
      remoteCommand,
    ];
    _resolveExecFile(opts)('ssh', args, { timeout: t * 1000, windowsHide: true }, (err, stdout, stderr) => {
      const timedOut = !!(err && (err.killed || err.signal === 'SIGTERM'));
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut });
    });
  });
}

/**
 * Copy one local file to the Mac over scp. Secret payloads always travel
 * this way, never interpolated into remote command lines. Never throws.
 *
 * @param {{host: string, user: string}} cfg - Validated mac config.
 * @param {string} localPath - Local source file.
 * @param {string} remotePath - Remote destination path.
 * @param {number} timeoutSec - Total execution budget in seconds.
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<boolean>} true on success.
 */
function scpSend(cfg, localPath, remotePath, timeoutSec, opts = {}) {
  return new Promise((resolve) => {
    const t = Math.max(1, Number(timeoutSec) || 8);
    const args = [
      '-o', 'ConnectTimeout=' + Math.min(t, CONNECT_TIMEOUT_CAP_SEC),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=' + HOST_KEY_POLICY,
      localPath,
      cfg.user + '@' + cfg.host + ':' + remotePath,
    ];
    _resolveExecFile(opts)('scp', args, { timeout: Math.max(t, 20) * 1000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Probe the ordered host candidates and report which one answers (task #37).
 *
 * WHAT IT IS FOR. The shipped default named a tailnet node that no longer
 * exists, so an install that never had its host typed in by hand fails every
 * Mac operation with MAC_UNREACHABLE and no indication of why. This turns
 * that dead end into a diagnosis: it says which of the known addresses the
 * machine actually answers on, so the operator can accept it in one click
 * through the existing PUT /api/credentials/mac-config.
 *
 * WHAT IT DELIBERATELY IS NOT. It does not switch any operation onto the
 * host that answered. Every Mac operation either pushes a credential
 * snapshot out or pulls the remote live token file in, and the host key
 * policy is accept-new, so an automatic redirect would let a reassigned
 * tailnet address both receive credentials and feed tokens into the local
 * snapshot store from a machine nobody configured. See mac-host.js.
 *
 * REACHABILITY, NOT SUCCESS. Exit 255 is ssh's own client/link error and a
 * timeout is a dead link; ANY OTHER exit code means the remote shell ran,
 * which is exactly the thing being tested, so a non-255 nonzero counts as
 * reachable. Nothing from stderr is carried into the result: the result is
 * cached and broadcast, and it has no business carrying remote text.
 *
 * Never throws. A config with no valid candidate resolves to unreachable
 * with an empty attempt list rather than an error.
 *
 * @param {{host?: string, user: string, sshTimeoutSec?: number}} cfg - Mac config.
 * @param {{execFileImpl?: Function, timeoutSec?: number}} [opts] - Injection point for tests.
 * @returns {Promise<{reachable: boolean, host: string|null, configuredHost: string|null, suggestedHost: string|null, attempts: Array<{host: string, code: number, timedOut: boolean, reachable: boolean}>}>}
 */
async function probeMacHosts(cfg, opts = {}) {
  const configuredHost = (cfg && typeof cfg.host === 'string' && cfg.host.trim()) ? cfg.host.trim() : null;
  const out = { reachable: false, host: null, configuredHost, suggestedHost: null, attempts: [] };
  const user = cfg && typeof cfg.user === 'string' ? cfg.user : '';
  if (!macHost.isValidMacTargetPart(user)) return out;

  const timeoutSec = Math.max(1, Number(opts.timeoutSec) || HOST_PROBE_TIMEOUT_SEC);
  for (const host of macHost.macHostCandidates(cfg)) {
    let r;
    try {
      r = await sshExec({ host, user }, HOST_PROBE_COMMAND, timeoutSec, opts);
    } catch (_) {
      // sshExec never rejects, but a hostile injected fake might.
      r = { code: 255, timedOut: false };
    }
    const reachable = r.code !== 255 && !r.timedOut;
    out.attempts.push({ host, code: r.code, timedOut: !!r.timedOut, reachable });
    if (reachable) {
      out.reachable = true;
      out.host = host;
      // Only a host DIFFERENT from the configured one is worth suggesting;
      // suggesting the value already in settings would be noise.
      out.suggestedHost = (configuredHost && host.toLowerCase() === configuredHost.toLowerCase()) ? null : host;
      return out;
    }
  }
  return out;
}

/**
 * Read the Mac's live identity (its ~/.claude.json oauthAccount) in one
 * SSH round trip via python3. Informational: claude-profile only swaps the
 * token file, so the Mac identity legitimately lags the mirrored token.
 *
 * @param {{host: string, user: string, sshTimeoutSec?: number}} cfg
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<{email: string|null, accountUuid: string|null}|null>}
 */
async function readMacLiveState(cfg, opts = {}) {
  try { validateMacTarget(cfg); } catch (_) { return null; }
  const pyCode = "import json,os;a=json.load(open(os.path.expanduser('~/.claude.json'))).get('oauthAccount') or {};" +
    "print(json.dumps({'email':a.get('emailAddress'),'accountUuid':a.get('accountUuid')}))";
  const r = await sshExec(cfg, 'python3 -c "' + pyCode + '"', Number(cfg.sshTimeoutSec) || 8, opts);
  if (r.code !== 0) return null;
  try {
    const lines = r.stdout.trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]);
    return { email: parsed.email || null, accountUuid: parsed.accountUuid || null };
  } catch (_) {
    return null;
  }
}

// Section separators for the one-round-trip inventory sweep. Unique tokens
// (never plausible file content) so the parser can split the compound
// command's stdout even when a section is empty or missing.
const INV_SEP_1 = '__CWM_S1__';
const INV_SEP_2 = '__CWM_S2__';
const INV_SEP_3 = '__CWM_S3__';
// Remote profile files are named <slug>.credentials.json; the inventory
// parser strips this suffix to recover profile names.
const PROFILE_FILE_SUFFIX = '.credentials.json';

/**
 * Split text at the FIRST occurrence of a separator token. Returns the
 * before/after halves; a missing separator yields [text, null] so a
 * truncated or garbled sweep degrades section by section instead of
 * corrupting every field.
 *
 * @param {string} text - Input text.
 * @param {string} sep - Separator token.
 * @returns {[string, string|null]} Before and after (after null if absent).
 */
function _splitOnce(text, sep) {
  const idx = text.indexOf(sep);
  if (idx === -1) return [text, null];
  return [text.slice(0, idx), text.slice(idx + sep.length)];
}

/**
 * Read the Mac's full credential-profile inventory in ONE ssh round trip:
 *   section 0: the active profile name (~/.claude-profiles/active). This is
 *              the TRUE Mac-active signal; the Mac ~/.claude.json identity
 *              deliberately lags (claude-profile never touches it).
 *   section 1: ls of ~/.claude-profiles/ (installed profile files).
 *   section 2: the live Mac token file (~/.claude/.credentials.json). This
 *              is SECRET MATERIAL: it stays in Node memory only, is consumed
 *              solely by syncBackFromMac, and must NEVER appear in any route
 *              response, SSE payload, cache object, or log line.
 *   section 3: the (lagging, informational) Mac identity via python3.
 *
 * Exit 255 or a timeout maps to { reachable: false } (offline is a state,
 * not an error). Any other exit code still parses whatever arrived, because
 * the compound command's exit status is just the LAST subcommand's status
 * (python3 fails when ~/.claude.json is absent) and says nothing about the
 * earlier sections. Never throws.
 *
 * @param {{host: string, user: string, sshTimeoutSec?: number}} cfg - Mac config.
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<{reachable: boolean, activeName: string|null, profileNames: string[], liveCredText: string|null, identity: {email: string|null, accountUuid: string|null}|null, error?: string}>}
 */
async function readMacInventory(cfg, opts = {}) {
  const empty = { reachable: false, activeName: null, profileNames: [], liveCredText: null, identity: null };
  try {
    validateMacTarget(cfg);
  } catch (err) {
    return { ...empty, error: 'VALIDATION: ' + err.message };
  }
  const pyCode = "import json,os;a=json.load(open(os.path.expanduser('~/.claude.json'))).get('oauthAccount') or {};" +
    "print(json.dumps({'email':a.get('emailAddress'),'accountUuid':a.get('accountUuid')}))";
  const cmd = 'cat "$HOME/.claude-profiles/active" 2>/dev/null; echo ' + INV_SEP_1 + '; ' +
    'ls -1 "$HOME/.claude-profiles/" 2>/dev/null; echo ' + INV_SEP_2 + '; ' +
    'cat "$HOME/.claude/.credentials.json" 2>/dev/null; echo ' + INV_SEP_3 + '; ' +
    'python3 -c "' + pyCode + '" 2>/dev/null';
  const r = await sshExec(cfg, cmd, Number(cfg.sshTimeoutSec) || 8, opts);
  if (r.code === 255 || r.timedOut) {
    return { ...empty, error: (r.stderr || (r.timedOut ? 'ssh timed out' : 'ssh link error')).trim() };
  }
  const [activePart, rest1] = _splitOnce(String(r.stdout || ''), INV_SEP_1);
  const [lsPart, rest2] = _splitOnce(rest1 == null ? '' : rest1, INV_SEP_2);
  const [credPart, pyPart] = _splitOnce(rest2 == null ? '' : rest2, INV_SEP_3);

  // Active name: first non-empty line of section 0 (the marker file is a
  // single bare name; extra whitespace tolerated).
  const activeName = activePart.split('\n').map((l) => l.trim()).find((l) => l) || null;

  // Profile names: every *.credentials.json entry with the suffix stripped.
  const profileNames = (rest1 == null ? '' : lsPart)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith(PROFILE_FILE_SUFFIX))
    .map((l) => l.slice(0, -PROFILE_FILE_SUFFIX.length))
    .filter((l) => l.length > 0);

  // Live token file text: kept verbatim (whitespace-trimmed) for the
  // strictly-newer merge in syncBackFromMac. Empty section means the file
  // is absent or unreadable.
  const credText = (rest2 == null ? '' : credPart).trim();
  const liveCredText = credText ? credText : null;

  // Identity: last non-empty line of the python section parsed as JSON.
  let identity = null;
  if (pyPart != null) {
    const lines = pyPart.split('\n').map((l) => l.trim()).filter((l) => l);
    if (lines.length > 0) {
      try {
        const parsed = JSON.parse(lines[lines.length - 1]);
        if (parsed && typeof parsed === 'object') {
          identity = { email: parsed.email || null, accountUuid: parsed.accountUuid || null };
        }
      } catch (_) {
        identity = null; // garbled python output degrades to no identity
      }
    }
  }
  return { reachable: true, activeName, profileNames, liveCredText, identity };
}

/**
 * Match a Mac inventory against the local snapshot store by profile slug.
 * Every remote profile name is resolved to the local snapshot whose
 * profileSlug(snapshot) equals it (null when nothing matches, e.g. a
 * profile created on the Mac by hand). Duplicate slugs (two snapshots with
 * the same label) resolve to the first snapshot encountered; slugs are
 * derived from user labels, so collisions are user-visible and harmless
 * here (both rows would show the same location pill).
 *
 * @param {object} manager - Credential manager instance (listSnapshots).
 * @param {{activeName: string|null, profileNames: string[]}} inventory - From readMacInventory.
 * @returns {{activeProfileId: string|null, profiles: Array<{name: string, profileId: string|null}>}}
 */
function resolveInventoryProfiles(manager, inventory) {
  const bySlug = new Map();
  try {
    for (const snap of manager.listSnapshots()) {
      const slug = profileSlug(snap);
      if (!bySlug.has(slug)) bySlug.set(slug, snap.accountUuid);
    }
  } catch (_) { /* an unreadable store degrades to zero matches */ }
  const names = (inventory && Array.isArray(inventory.profileNames)) ? inventory.profileNames : [];
  const profiles = names.map((name) => ({ name, profileId: bySlug.get(name) || null }));
  const activeName = inventory && inventory.activeName ? inventory.activeName : null;
  const activeProfileId = activeName ? (bySlug.get(activeName) || null) : null;
  return { activeProfileId, profiles };
}

/**
 * Build a shell-safe remote profile name from a snapshot: slugified label
 * (lowercase, runs of non-alphanumerics collapse to single hyphens, edges
 * trimmed, capped) or the first 8 chars of the accountUuid.
 *
 * @param {{label?: string, accountUuid?: string}} snapshot
 * @returns {string} Safe profile name, never empty.
 */
function profileSlug(snapshot) {
  const label = snapshot && typeof snapshot.label === 'string' ? snapshot.label : '';
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
  if (slug) return slug;
  const uuid = snapshot && typeof snapshot.accountUuid === 'string' ? snapshot.accountUuid : '';
  return uuid.slice(0, 8) || 'profile';
}

/**
 * Shared local gates for every Mac-bound operation: the ssh target must be
 * valid, the snapshot must exist, must not be definitively dead
 * (needs_login), and must carry credentials. Pure local checks; nothing is
 * spawned. Returns { snap } on success or { result } carrying the
 * mirror-shaped failure object the caller returns as-is.
 *
 * @param {object} manager - A credential manager instance (readSnapshot).
 * @param {{host: string, user: string}} cfg - Mac config to validate.
 * @param {string} accountUuid - The profileId being sent to the Mac.
 * @returns {{snap: object}|{result: {mirrored: boolean, installed: boolean, error: string, message: string}}}
 */
function _gateSnapshotForMac(manager, cfg, accountUuid) {
  // Defense in depth for non-route callers: passive mode forbids writing a
  // credential snapshot to either the local or remote live/profile files.
  // The manager supplies the canonical typed conflict and marker-aware
  // message; convert it to this module's result shape without spawning.
  if (manager && typeof manager.assertCredentialPoolWritable === 'function') {
    try {
      manager.assertCredentialPoolWritable('Mac credential apply');
    } catch (err) {
      return {
        result: {
          mirrored: false,
          installed: false,
          error: (err && err.code) || 'CRED_POOL_EXTERNAL_OWNER',
          message: (err && err.message) || 'Credential pool is externally owned and read-only.',
        },
      };
    }
  }
  try {
    validateMacTarget(cfg);
  } catch (err) {
    return { result: { mirrored: false, installed: false, error: 'VALIDATION', message: err.message } };
  }
  const snap = manager.readSnapshot(accountUuid);
  if (!snap) {
    return { result: { mirrored: false, installed: false, error: 'CRED_NOT_FOUND', message: 'No stored snapshot for that profile; nothing to mirror.' } };
  }
  if (snap.tokenState === 'needs_login') {
    return { result: { mirrored: false, installed: false, error: 'MAC_TOKEN_DEAD', message: 'The stored token needs a fresh login; not mirroring a dead token to the Mac.' } };
  }
  if (!snap.credentials || !snap.credentials.accessToken) {
    return { result: { mirrored: false, installed: false, error: 'CRED_NOT_FOUND', message: 'The stored snapshot has no credentials to mirror.' } };
  }
  return { snap };
}

/**
 * Install one snapshot as a NAMED profile on the Mac without activating it:
 *   1. load and gate the snapshot (missing or needs_login rejects);
 *   2. write the raw credentials payload to a local 0600 temp file and scp
 *      it to a random /tmp path on the Mac;
 *   3. install it as ~/.claude-profiles/<name>.credentials.json (mkdir,
 *      atomic mv, chmod 600).
 * No 'use', no verify, no agent restart: the Mac keeps running whatever
 * profile was active. This is the "put this account ON the Mac" half of
 * the old mirrorToMac; applyProfileOnMac adds the activation half.
 *
 * SECURITY: the secret payload travels ONLY inside the scp'd 0600 temp
 * file, never on a remote command line; the local temp file is deleted in
 * finally regardless of outcome, and a failed install attempts a
 * best-effort remote temp cleanup. Never throws.
 *
 * @param {object} manager - A credential manager instance (readSnapshot).
 * @param {{host: string, user: string, sshTimeoutSec?: number}} cfg - Mac config.
 * @param {string} accountUuid - The profileId to install.
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<{installed: boolean, name?: string, remoteProfile?: string, error?: string, message?: string}>}
 */
async function installProfileOnMac(manager, cfg, accountUuid, opts = {}) {
  const gate = _gateSnapshotForMac(manager, cfg, accountUuid);
  if (gate.result) return { ...gate.result, installed: false };
  const snap = gate.snap;
  const timeoutSec = Math.max(1, Number(cfg.sshTimeoutSec) || 8);
  const name = profileSlug(snap);
  const payload = serializeCredentialsFile(snap.credentials);
  const localTmp = path.join(os.tmpdir(), 'cwm-mac-mirror-' + crypto.randomBytes(8).toString('hex') + '.json');
  const remoteTmp = '/tmp/cwm-mirror-' + crypto.randomBytes(8).toString('hex') + '.json';
  const remoteProfile = '$HOME/.claude-profiles/' + name + '.credentials.json';
  try {
    fs.writeFileSync(localTmp, payload, { mode: 0o600 });
    const sent = await scpSend(cfg, localTmp, remoteTmp, timeoutSec, opts);
    if (!sent) {
      return { installed: false, name, error: 'MAC_UNREACHABLE', message: 'scp to ' + cfg.host + ' failed; check SSH connectivity (Tailscale up, key auth working).' };
    }
    // Both remoteTmp and the profile name are safe by construction
    // ([a-z0-9-] slug, hex temp name), so no remote quoting can break.
    const install = await sshExec(cfg,
      'mkdir -p "$HOME/.claude-profiles" && mv ' + remoteTmp + ' "' + remoteProfile + '" && chmod 600 "' + remoteProfile + '"',
      timeoutSec, opts);
    if (install.code !== 0) {
      await sshExec(cfg, 'rm -f ' + remoteTmp, timeoutSec, opts); // best-effort temp cleanup
      if (install.code === 255) {
        return { installed: false, name, error: 'MAC_UNREACHABLE', message: 'ssh to ' + cfg.host + ' failed: ' + (install.stderr || 'link error').trim() };
      }
      return { installed: false, name, error: 'MAC_VERIFY_FAILED', message: 'Installing the profile on the Mac failed: ' + ((install.stderr || install.stdout) || 'unknown error').trim() };
    }
    return { installed: true, name, remoteProfile };
  } catch (err) {
    return { installed: false, name, error: 'MAC_UNREACHABLE', message: 'Install failed: ' + ((err && err.message) || err) };
  } finally {
    try { fs.unlinkSync(localTmp); } catch (_) { /* best effort */ }
  }
}

/**
 * Apply one snapshot as the ACTIVE profile on the Mac (install + activate):
 *   1. gate locally (missing snapshot / dead token rejects, zero SSH);
 *   2. PRE-USE SYNC-BACK: one readMacInventory sweep adopts the current
 *      Mac-active account's freshest rotated tokens into its local
 *      snapshot BEFORE anything on the Mac changes. WHY: 'claude-profile
 *      use' swaps the LIVE token file; the Mac-side tool does preserve the
 *      outgoing profile remotely, but the PC snapshot is what this
 *      switcher pushes everywhere, so it must never be left stale. An
 *      unreachable sweep or an unmatched active profile degrades to a
 *      WARNING and never blocks (the install/use path fails cleanly on
 *      its own if the Mac is really down); an unknown Mac login is never
 *      clobbered silently, it is flagged in the warning.
 *   3. install via installProfileOnMac (scp + mkdir + mv + chmod);
 *   4. run 'claude-profile use <name>' (the script owns sync-back, live
 *      overlay, and the forge agent restart on the Mac) with the 45s
 *      timeout floor;
 *   5. verify: the active marker equals <name> AND the Mac live token file
 *      byte-matches the pushed profile (cmp);
 *   6. on success record the Mac-active lineage hint on the manager so
 *      the PC's usage poller can never rotate this account's tokens out
 *      from under the Mac (see the lineage gate in credential-manager);
 *   7. run postSwapCommand when configured (nonzero exit = warning only).
 * Never throws; always returns a result object so a Mac failure can never
 * fail a PC apply.
 *
 * @param {object} manager - A credential manager instance.
 * @param {{host: string, user: string, profileTool?: string, postSwapCommand?: string, sshTimeoutSec?: number}} cfg
 * @param {string} accountUuid - The profileId to activate on the Mac.
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<{mirrored: boolean, name?: string, error?: string, message?: string, warning?: string}>}
 */
async function applyProfileOnMac(manager, cfg, accountUuid, opts = {}) {
  const gate = _gateSnapshotForMac(manager, cfg, accountUuid);
  if (gate.result) return gate.result;
  const timeoutSec = Math.max(1, Number(cfg.sshTimeoutSec) || 8);
  const warnings = [];

  // Step 2: pre-use sync-back (see the function header for the WHY).
  try {
    const inv = await readMacInventory(cfg, opts);
    if (inv && inv.reachable) {
      const matched = resolveInventoryProfiles(manager, inv);
      if (matched.activeProfileId && inv.liveCredText && typeof manager.syncBackFromMac === 'function') {
        try {
          await manager.syncBackFromMac(matched.activeProfileId, inv.liveCredText);
        } catch (_) {
          warnings.push('Could not sync the Mac-active account back before switching.');
        }
      } else if (inv.activeName && !matched.activeProfileId) {
        // Unknown Mac login: preserved remotely by claude-profile itself,
        // but flag it so a login captured only on the Mac is never lost
        // silently from the operator's mental model.
        warnings.push('The Mac was running profile "' + inv.activeName + '" which matches no saved account here; it stays saved on the Mac but was not synced back.');
      }
    } else {
      warnings.push('Could not read the Mac state before switching; continuing with the apply.');
    }
  } catch (_) {
    warnings.push('Could not read the Mac state before switching; continuing with the apply.');
  }

  // Step 3: install (scp + mkdir + mv + chmod), no activation yet.
  const inst = await installProfileOnMac(manager, cfg, accountUuid, opts);
  if (!inst.installed) {
    const out = { mirrored: false, error: inst.error, message: inst.message };
    if (warnings.length) out.warning = warnings.join(' ');
    return out;
  }
  const name = inst.name;
  const remoteProfile = inst.remoteProfile;

  // Step 4: activate through the Mac-native tool.
  const tool = (cfg.profileTool && String(cfg.profileTool).trim()) ? String(cfg.profileTool).trim() : DEFAULT_PROFILE_TOOL;
  const useRes = await sshExec(cfg,
    'export PATH="$HOME/.local/bin:$PATH"; ' + tool + ' use ' + name,
    Math.max(timeoutSec, USE_TIMEOUT_FLOOR_SEC), opts);
  if (useRes.code === 255) {
    return { mirrored: false, error: 'MAC_UNREACHABLE', message: 'ssh to ' + cfg.host + ' dropped while applying: ' + (useRes.stderr || 'link error').trim() };
  }
  if (useRes.code === 127 || /command not found|No such file/i.test(useRes.stderr)) {
    return { mirrored: false, error: 'MAC_TOOL_MISSING', message: 'claude-profile tool missing on the Mac (' + tool + '). Install it or fix profileTool in mac-config.' };
  }
  if (useRes.code !== 0) {
    return { mirrored: false, error: 'MAC_VERIFY_FAILED', message: 'claude-profile use failed on the Mac: ' + ((useRes.stderr || useRes.stdout) || 'unknown error').trim() };
  }

  // Step 5: verify: active marker matches AND the live token file equals
  // the pushed profile byte for byte. (The Mac identity file is
  // deliberately NOT compared; claude-profile does not touch it.)
  const verify = await sshExec(cfg,
    'cat "$HOME/.claude-profiles/active" 2>/dev/null; cmp -s "$HOME/.claude/.credentials.json" "' + remoteProfile + '" && echo CWM_MATCH',
    timeoutSec, opts);
  if (verify.code === 255 || verify.timedOut) {
    warnings.push('Mirror applied but the verification round trip could not connect; assume applied.');
  } else {
    const activeName = verify.stdout.split('\n')[0].trim();
    const bytesMatch = verify.stdout.indexOf('CWM_MATCH') !== -1;
    if (activeName !== name || !bytesMatch) {
      return { mirrored: false, error: 'MAC_VERIFY_FAILED', message: 'The Mac live credentials do not match the pushed profile after apply.' };
    }
  }

  // Step 6: lineage hint. From this moment the MAC owns this account's
  // refresh-token lineage; the manager's usage poller must never rotate it
  // (Phase D lineage gate). Advisory: a hint failure never fails the apply.
  if (typeof manager.setMacActiveHint === 'function') {
    try { manager.setMacActiveHint(accountUuid); } catch (_) { /* advisory */ }
  }

  // Step 7: optional post-swap command (nonzero exit = warning only).
  if (cfg.postSwapCommand && String(cfg.postSwapCommand).trim()) {
    const post = await sshExec(cfg, String(cfg.postSwapCommand), Math.max(timeoutSec, 30), opts);
    if (post.code !== 0) {
      warnings.push('postSwapCommand exited ' + post.code + '.');
    }
  }
  const result = { mirrored: true, name };
  if (warnings.length) result.warning = warnings.join(' ');
  return result;
}

/**
 * Back-compat alias: the original single-call "push and activate on the
 * Mac" entry point. Kept so existing callers (legacy apply route bodies,
 * older injected fakes) keep working; new code should call
 * installProfileOnMac / applyProfileOnMac explicitly.
 *
 * @param {object} manager - A credential manager instance.
 * @param {object} cfg - Mac config (see applyProfileOnMac).
 * @param {string} accountUuid - The profileId to mirror.
 * @param {{execFileImpl?: Function}} [opts] - Injection point for tests.
 * @returns {Promise<{mirrored: boolean, name?: string, error?: string, message?: string, warning?: string}>}
 */
async function mirrorToMac(manager, cfg, accountUuid, opts = {}) {
  return applyProfileOnMac(manager, cfg, accountUuid, opts);
}

module.exports = {
  validateMacTarget,
  sshExec,
  scpSend,
  readMacLiveState,
  readMacInventory,
  resolveInventoryProfiles,
  profileSlug,
  installProfileOnMac,
  applyProfileOnMac,
  mirrorToMac,
  // Task #37: the host chain. probeMacHosts is READ-ONLY and advisory; the
  // constants and pure helpers are re-exported so a caller does not have to
  // know that mac-host.js exists.
  probeMacHosts,
  macHostCandidates: macHost.macHostCandidates,
  isLegacyMacHost: macHost.isLegacyMacHost,
  DEFAULT_MAC_HOST: macHost.DEFAULT_MAC_HOST,
  MAC_HOST_FALLBACKS: macHost.MAC_HOST_FALLBACKS,
  LEGACY_MAC_HOSTS: macHost.LEGACY_MAC_HOSTS,
  HOST_PROBE_TIMEOUT_SEC,
};
