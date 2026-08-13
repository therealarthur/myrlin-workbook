/**
 * Mac tailnet host constants and pure helpers (task #37).
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Two modules need the same answer to "which machine is the Mac": the
 * credential manager, which owns the DEFAULT that ships in settings, and the
 * bridge, which opens the ssh connection. The bridge already requires the
 * manager (for serializeCredentialsFile), so putting the constants in the
 * bridge would make the manager require it back and create a cycle whose
 * partially-initialised exports would leave DEFAULT_CRED_SETTINGS holding
 * undefined. A leaf module both can require has no such failure mode, and it
 * gives the host exactly one definition instead of two that agree today.
 *
 * WHAT WENT WRONG
 * ---------------
 * The shipped default named a tailnet node that no longer exists. The Mac's
 * node was renamed, and its tailnet address changed with it, so on any
 * install that never opened Settings and typed a host by hand, every mirror,
 * every inventory sweep and every apply resolved to a dead name and failed
 * with MAC_UNREACHABLE. Nothing was broken about the bridge; it was pointed
 * at a machine that is not there.
 *
 * WHAT THIS FIXES AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * It fixes the default, it names the old values so a stored copy of one can
 * be migrated exactly once, and it provides an ORDERED CANDIDATE LIST plus a
 * reachability probe so an operator whose stored host is dead is TOLD which
 * address answered.
 *
 * It does NOT silently redirect an operation to a candidate that answered.
 * That refusal is deliberate and it is a security property, not caution for
 * its own sake: the bridge reads the remote machine's live credential file
 * into memory and merges it into the local snapshot store, and it scp's
 * credential snapshots out. The host key policy is accept-new, which trusts
 * an unknown host on first contact. An automatic fallback would therefore
 * let a reassigned or impersonated tailnet address both receive a credential
 * snapshot and feed tokens INTO the snapshot store, from a machine the
 * operator never configured. A suggestion the operator accepts with one
 * click carries none of that, and the stored-value migration is a local,
 * deterministic rename rather than a network guess.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/web/mac-host
 */

'use strict';

/**
 * Charset allowlist for the ssh host and user parts. Also used to reject a
 * leading dash, which ssh would parse as an option. Defined here so the
 * bridge's validator and the candidate builder cannot drift apart.
 */
const MAC_TARGET_RE = /^[A-Za-z0-9._@-]+$/;

/**
 * The tailnet node name the Mac answers to today. This is the value that
 * ships in DEFAULT_CRED_SETTINGS.mac.host.
 */
const DEFAULT_MAC_HOST = 'alloy';

/**
 * Addresses to OFFER when the configured host does not answer, in order.
 * The tailnet IP is a fallback for the case where MagicDNS is not resolving
 * on this machine but the tailnet link itself is up. Offered, never used
 * automatically; see the module header.
 */
const MAC_HOST_FALLBACKS = Object.freeze(['100.111.181.106']);

/**
 * Hosts this deployment is known to have pointed at in the past and which
 * are known dead. A STORED value matching one of these is what the one-time
 * migration rewrites; anything else the operator typed is left alone,
 * because a host we do not recognise is a host we have no business
 * second-guessing.
 */
const LEGACY_MAC_HOSTS = Object.freeze(['arthurs-mac-mini', '100.118.228.46']);

/**
 * Is this string usable as an ssh host or user part?
 * Charset-allowlisted and never leading-dash (ssh option injection guard).
 *
 * @param {*} value - Candidate host or user.
 * @returns {boolean} True when safe to place in an ssh target.
 */
function isValidMacTargetPart(value) {
  if (typeof value !== 'string') return false;
  if (!value || value.startsWith('-')) return false;
  return MAC_TARGET_RE.test(value);
}

/**
 * Is this host one of the known-dead names this deployment used to use?
 * Case-insensitive because host names are, and whitespace-tolerant because
 * a hand-typed settings value often is not trimmed.
 *
 * @param {*} host - Candidate host.
 * @returns {boolean} True when the host is a known-dead legacy value.
 */
function isLegacyMacHost(host) {
  if (typeof host !== 'string') return false;
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  return LEGACY_MAC_HOSTS.some((legacy) => legacy.toLowerCase() === normalized);
}

/**
 * Build the ordered candidate list for a config: the CONFIGURED host first
 * (the operator's stated intent always leads), then the current default,
 * then the documented fallbacks. Deduplicated case-insensitively, and every
 * entry is charset-validated so a junk settings value can never reach an
 * ssh argv through this path.
 *
 * A known-dead legacy host is NOT dropped from the list. It stays in first
 * position because the operator configured it, and because a probe that
 * reports "the host you configured did not answer, this one did" is more
 * useful than one that quietly reordered the question.
 *
 * @param {{host?: string}} [cfg] - Mac config (only host is read).
 * @returns {string[]} Ordered, deduplicated, validated candidate hosts.
 */
function macHostCandidates(cfg) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (!isValidMacTargetPart(value)) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  push(cfg && typeof cfg.host === 'string' ? cfg.host.trim() : '');
  push(DEFAULT_MAC_HOST);
  for (const fallback of MAC_HOST_FALLBACKS) push(fallback);
  return out;
}

module.exports = {
  MAC_TARGET_RE,
  DEFAULT_MAC_HOST,
  MAC_HOST_FALLBACKS,
  LEGACY_MAC_HOSTS,
  isValidMacTargetPart,
  isLegacyMacHost,
  macHostCandidates,
};
