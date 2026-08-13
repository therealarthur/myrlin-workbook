/**
 * Codex provider spawn descriptor builder.
 *
 * Phase 17 Plan 17-02 (CDX-07 spawn half) shipped the minimum surface:
 * `resume <id>` when providerSessionId is set, fresh-session otherwise.
 * Phase 21 Plan 21-01 extends this with optional providerSettings so the
 * frontend right-click menu can drive Codex CLI flags (model, sandbox,
 * approval policy, reasoning effort, bypass, feature enables).
 *
 * Pure function. Pty-manager (Plan 14-04) reads the returned descriptor and
 * owns the actual node-pty.spawn call. No filesystem touches, no env
 * mutation, no network. Validation is defensive: unsafe values trigger a
 * console.warn and are dropped silently rather than throwing, so a stale
 * frontend value never blocks a pane spawn.
 *
 * Flag translation (providerSettings -> argv):
 *   model               -> ['-m', model]
 *   sandbox             -> ['-s', sandbox]
 *   approvalPolicy      -> ['-a', approvalPolicy]
 *   reasoningEffort     -> ['-c', 'model_reasoning_effort="<effort>"']
 *   bypassApprovalsAndSandbox: true
 *                       -> ['--dangerously-bypass-approvals-and-sandbox']
 *   features: [name,..] -> ['--enable', name] pairs
 *
 * Positional ordering invariant: any `resume <id>` positional pair stays
 * LAST in args so flags cannot be misparsed as the resume id. This matches
 * the Codex CLI convention (subcommand positions trail option flags).
 *
 * Enum allow-lists are intentionally short and conservative. Drop-unknown
 * with a console.warn keeps the spawn path resilient against typos and
 * stale fields from older clients.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/spawn
 */

'use strict';

const CODEX_BINARY = 'codex'; // gsd:provider-literal-allowed (Codex provider CLI binary)

// Same shell-safe regex Claude uses for its providerSessionId gate.
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Shell-unsafe characters for free-form values (model names, etc.). Mirrors
// pty-manager.js SHELL_UNSAFE so anything that passes here also passes the
// outer gate; we keep the local copy so this module is testable standalone.
const SHELL_UNSAFE_RE = /[;&|`$(){}[\]<>!#*?\n\r\\'"]/;

// Enum allow-lists. Unknown values get dropped with a console.warn instead of
// crashing the spawn so a stale frontend cache never blocks a pane.
//
// BUILD-CONTRACT P8.7 / CODEX-PARITY B5, B16, B17. These sets used to be
// "conservative on purpose", which sounded prudent and was in fact a silent
// data-loss bug: they were written from the CLI's documented options rather
// than from what the app actually records, and the two had diverged badly.
//
// Measured across 3002 real threads on a live machine:
//
//   reasoning_effort  ultra 2849, xhigh 90, high 36, low 20, medium 2, max 1
//   sandbox_policy    disabled 2904, managed ~55, danger-full-access 33,
//                     workspace-write 4
//   approval_mode     never 2971, on-request 31
//
// So the old effort set covered 58 of 2998 threads, roughly 2 percent, and
// every other value was dropped with nothing but a console.warn. A user whose
// actual default is `ultra` could not express it, and a saved template carrying
// it silently lost the field on every round trip.
//
// Widened to the union of the documented options and the observed reality.
// Documented-but-unobserved values are RETAINED rather than pruned: their
// absence from one machine's history is not evidence the CLI rejects them.

/**
 * Sandbox policy names. `disabled` and `managed` are the two the app actually
 * writes; the other three are the CLI's documented set.
 */
const SANDBOX_VALUES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
  'disabled',
  'managed',
]);

const APPROVAL_VALUES = new Set([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
]);

/**
 * Reasoning effort names, ordered from least to most for presentation. `ultra`
 * is the real-world default and accounts for 95 percent of observed threads.
 */
const EFFORT_VALUES = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
]);

/**
 * Model ids observed in real thread records, offered as launcher suggestions.
 *
 * NOT an allow-list: model validation stays regex-based (MODEL_ID_RE) so a
 * model released tomorrow works today. This exists so a picker can be populated
 * from observed reality instead of a frozen literal set that cannot express
 * `gpt-5.6-sol`, which is the actual default.
 */
const OBSERVED_MODEL_IDS = Object.freeze([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4',
  'codex-auto-review',
]);

// Feature name format: short alphanumeric + dash/underscore. Matches Codex
// CLI --enable token shape (e.g. web_search, view_image).
const FEATURE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// Model id format: alphanumeric + dot/dash/underscore/colon. Cap length so
// argv stays bounded. The colon allows version-suffixed model ids
// ("gpt-5:2025-09-01"-shape).
const MODEL_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

/**
 * Validate providerSessionId. Reused by tests.
 *
 * @param {*} id
 * @returns {boolean}
 */
function isSafeProviderSessionId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

/**
 * Translate an optional providerSettings bundle to Codex CLI argv tokens.
 * Pure function. Unknown values are dropped with a single console.warn so
 * one bad field does not abort the spawn.
 *
 * @param {Object} [settings] - providerSettings.codex bundle. Optional.
 * @returns {string[]} Flag tokens ordered model, sandbox, approval, effort,
 *   bypass, then feature pairs. Caller appends positional args after.
 */
function buildFlagsFromSettings(settings) {
  if (!settings || typeof settings !== 'object') return [];
  const flags = [];

  if (typeof settings.model === 'string' && settings.model.length > 0) {
    if (MODEL_ID_RE.test(settings.model) && !SHELL_UNSAFE_RE.test(settings.model)) {
      flags.push('-m', settings.model);
    } else {
      console.warn('[codex/spawn] dropping unsafe/oversized model: ' + settings.model);
    }
  }

  if (typeof settings.sandbox === 'string' && settings.sandbox.length > 0) {
    if (SANDBOX_VALUES.has(settings.sandbox)) {
      flags.push('-s', settings.sandbox);
    } else {
      console.warn('[codex/spawn] dropping unknown sandbox: ' + settings.sandbox);
    }
  }

  if (typeof settings.approvalPolicy === 'string' && settings.approvalPolicy.length > 0) {
    if (APPROVAL_VALUES.has(settings.approvalPolicy)) {
      flags.push('-a', settings.approvalPolicy);
    } else {
      console.warn('[codex/spawn] dropping unknown approvalPolicy: ' + settings.approvalPolicy);
    }
  }

  if (typeof settings.reasoningEffort === 'string' && settings.reasoningEffort.length > 0) {
    if (EFFORT_VALUES.has(settings.reasoningEffort)) {
      // TOML-safe value formatting: quote the string so the Codex `-c key=val`
      // parser treats it as a literal even if a future effort name contains
      // chars TOML would interpret. Today all enum values are bare words and
      // quoting them is a no-op, but the quotes future-proof the contract.
      flags.push('-c', 'model_reasoning_effort="' + settings.reasoningEffort + '"');
    } else {
      console.warn('[codex/spawn] dropping unknown reasoningEffort: ' + settings.reasoningEffort);
    }
  }

  if (settings.bypassApprovalsAndSandbox === true) {
    flags.push('--dangerously-bypass-approvals-and-sandbox');
  }

  if (Array.isArray(settings.features)) {
    for (const name of settings.features) {
      if (typeof name === 'string' && FEATURE_NAME_RE.test(name) && !SHELL_UNSAFE_RE.test(name)) {
        flags.push('--enable', name);
      } else {
        console.warn('[codex/spawn] dropping unsafe feature name: ' + name);
      }
    }
  }

  return flags;
}

/**
 * Build a SpawnDescriptor for the Codex CLI.
 *
 * Pure function. Does NOT touch the filesystem, the network, or any state.
 * Does NOT mutate process.env. Throws on invalid providerSessionId. Unknown
 * providerSettings values are dropped (warn only) rather than thrown.
 *
 * argv ordering:
 *   [<flag tokens from providerSettings...>, 'resume', '<id>']
 *
 * The positional resume pair stays LAST so flag-shaped resume ids cannot be
 * misparsed (the Codex CLI takes the subcommand as a trailing position).
 *
 * @param {Object} [init]
 * @param {string|null} [init.providerSessionId] - Codex session UUID for
 *   `resume`. Validated against /^[a-zA-Z0-9_-]+$/. Throws on unsafe input.
 * @param {string|null} [init.cwd] - Working directory; pass-through.
 * @param {Object} [init.providerSettings] - Optional Codex settings bundle.
 *   See buildFlagsFromSettings for accepted keys.
 * @returns {{cmd:string, args:string[], cwd:(string|null), env:Object}}
 * @throws {Error} when providerSessionId fails the safety regex.
 */
function spawnCommand({ providerSessionId = null, cwd = null, providerSettings = null } = {}) {
  if (providerSessionId && !isSafeProviderSessionId(providerSessionId)) {
    throw new Error('unsafe providerSessionId: ' + providerSessionId);
  }

  // Flags first, positional resume <id> last so flag/value pairs cannot
  // accidentally swallow the resume id at argv-parse time.
  const args = buildFlagsFromSettings(providerSettings);
  if (providerSessionId) {
    args.push('resume', providerSessionId);
  }

  // CODEX_HOME scoping: read process.env at call time so a test that
  // mutates the env in a try/finally sees the change reflected here.
  // Undefined-means-delete semantic honored by pty-manager.
  const codexHomeFromEnv = process.env.CODEX_HOME;
  const envOverride = {
    CODEX_HOME: typeof codexHomeFromEnv === 'string' && codexHomeFromEnv.length > 0
      ? codexHomeFromEnv
      : undefined,
  };

  return {
    cmd: CODEX_BINARY,
    args: args,
    cwd: cwd || null,
    env: envOverride,
  };
}

module.exports = {
  spawnCommand,
  buildFlagsFromSettings,
  isSafeProviderSessionId,
  /**
   * The enum allow-lists, exported so every other layer validates against ONE
   * definition instead of keeping its own copy.
   *
   * BUILD-CONTRACT P8.7 / CODEX-PARITY B16: a saved template must round-trip.
   * It cannot if the spawn layer accepts `ultra` while the persistence route
   * that stores the template rejects it, so the route imports these rather than
   * re-declaring them. Duplicating an enum across layers is exactly how the two
   * percent coverage bug above survived unnoticed.
   */
  SANDBOX_VALUES,
  APPROVAL_VALUES,
  EFFORT_VALUES,
  OBSERVED_MODEL_IDS,
  MODEL_ID_RE,
  FEATURE_NAME_RE,
};
