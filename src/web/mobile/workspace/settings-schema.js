/**
 * workspace/settings-schema.js: the SettingsSchema of each provider
 * (PROTOCOL.md 4.5.3), served by GET /providers/:provider/settings-schema.
 *
 * WHY: the phone renders session settings (S10) and New session (S11) only
 * from this schema and hard codes no provider values (R02:336, A14). The
 * enums come from the provider modules themselves (claude/spawn.js for the
 * values B3 added in S10, codex/spawn.js for the Codex sets), so a CLI
 * upgrade widens one list in one place. Every field applies at the next
 * start in v1 (A14, F16, P11). Model suggestions are the ids this computer
 * actually uses: the 8 most used in the newest 50 sessions of the provider.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Schema revision; bumped when a field or option list changes shape. */
const SCHEMA_REVISION = 1;
/** Model ids accepted from the phone: a letter or digit first (no leading hyphen, W2). */
const MODEL_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$';
/** Longest model id. */
const MODEL_MAX_LENGTH = 128;
/** How many observed model ids become suggestions. */
const MODEL_SUGGESTIONS = 8;
/** How many recent sessions are sampled for model ids. */
const MODEL_SAMPLE_SESSIONS = 50;
/** Suggestions are recomputed at most this often. */
const SUGGESTION_TTL_MS = 60 * 1000;
/** "Default" placeholder shown for an unset field (DESIGN-SPEC 11). */
const PLACEHOLDER_DEFAULT = 'Default';

/** Friendly names and context sizes for model ids this build knows (R08 section 3). */
const KNOWN_MODELS = Object.freeze({
  'claude-fable-5-1': { label: 'Fable 5.1', description: '1M context', provider: 'claude', contextTokens: 1000000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'claude-opus-5-5': { label: 'Opus 5.5', description: '1M context', provider: 'claude', contextTokens: 1000000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'claude-sonnet-5': { label: 'Sonnet 5', description: '1M context', provider: 'claude', contextTokens: 1000000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'claude-opus-5': { label: 'Opus 5', description: '1M context', provider: 'claude', contextTokens: 1000000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'claude-haiku-4-5': { label: 'Haiku 4.5', description: '200K context', provider: 'claude', contextTokens: 200000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'gpt-6-astra': { label: 'GPT-6 Astra', description: '272K context', provider: 'codex', contextTokens: 272000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'gpt-6-sol': { label: 'GPT-6 Sol', description: '272K context', provider: 'codex', contextTokens: 272000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'gpt-6-luna': { label: 'GPT-6 Luna', description: '272K context', provider: 'codex', contextTokens: 272000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'gpt-5.6-sol': { label: 'GPT-5.6 Sol', description: '272K context', provider: 'codex', contextTokens: 272000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'gpt-5.6-terra': { label: 'GPT-5.6 Terra', description: '272K context', provider: 'codex', contextTokens: 272000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
  'gpt-5.6-luna': { label: 'GPT-5.6 Luna', description: '272K context', provider: 'codex', contextTokens: 272000 }, // gsd:provider-literal-allowed (mobile v2 settings schema)
});

/** Claude effort values, from the S10 descriptor (claude/spawn.js). */
function claudeEfforts() {
  try { return require('../../../providers/claude/spawn').CLAUDE_EFFORT_VALUES.slice(); } catch (_) { return ['low', 'medium', 'high', 'xhigh', 'max']; }
}

/** Claude permission modes, from the S10 descriptor. */
function claudeModes() {
  try { return require('../../../providers/claude/spawn').CLAUDE_PERMISSION_MODES.slice(); } catch (_) { return ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']; }
}

/**
 * Codex enums from codex/spawn.js (the single source server.js also uses),
 * with the PROTOCOL.md 4.5.3 lists as the fallback.
 *
 * @returns {{effort: string[], sandbox: string[], approval: string[]}}
 */
function codexEnums() {
  const fallback = {
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'],
    sandbox: ['read-only', 'workspace-write', 'danger-full-access', 'disabled', 'managed'],
    approval: ['untrusted', 'on-failure', 'on-request', 'never'],
  };
  try {
    const m = require('../../../providers/codex/spawn');
    const arr = (s, f) => (s instanceof Set ? Array.from(s) : f);
    return { effort: arr(m.EFFORT_VALUES, fallback.effort), sandbox: arr(m.SANDBOX_VALUES, fallback.sandbox), approval: arr(m.APPROVAL_VALUES, fallback.approval) };
  } catch (_) {
    return fallback;
  }
}

/** Words for enum values; unknown values use the value itself. */
const OPTION_LABELS = Object.freeze({
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', minimal: 'Minimal', ultra: 'Ultra',
  default: 'Ask before changes', acceptEdits: 'Accept edits', plan: 'Plan only', auto: 'Auto', bypassPermissions: 'Bypass permissions',
  'read-only': 'Read only', 'workspace-write': 'Workspace write', 'danger-full-access': 'Full access', disabled: 'No sandbox', managed: 'Managed',
  untrusted: 'Untrusted commands only', 'on-failure': 'On failure', 'on-request': 'On request', never: 'Never ask',
});
/** Option descriptions that state a consequence (brief 6: a consequential control states it). */
const OPTION_DESCRIPTIONS = Object.freeze({
  bypassPermissions: 'Runs every command without asking.',
  'danger-full-access': 'Commands can change anything on this computer.',
  never: 'Codex never stops to ask.',
});

/**
 * One enum option.
 *
 * @param {string} value - Option value (passed through verbatim).
 * @returns {{value: string, label: string, description: (string|null)}}
 */
function option(value) {
  return { value, label: OPTION_LABELS[value] || value, description: OPTION_DESCRIPTIONS[value] || null };
}

/**
 * A field of the schema with every required key (settings-schema.json).
 *
 * @param {object} f - Partial field.
 * @returns {object}
 */
function field(f) {
  return {
    key: f.key,
    label: f.label,
    kind: f.kind,
    options: f.options || [],
    default: f.default === undefined ? null : f.default,
    appliesAt: 'nextStart',
    help: f.help || null,
    pattern: f.pattern || null,
    maxLength: f.maxLength || null,
    placeholder: f.placeholder === undefined ? PLACEHOLDER_DEFAULT : f.placeholder,
  };
}

/**
 * Create the schema service.
 *
 * @param {object} deps - {ctx, now}
 * @returns {{schemaFor: Function, isProvider: Function, fieldsOf: Function, validate: Function, knownModel: Function, suggestions: Function}}
 */
function createSettingsSchema(deps) {
  const ctx = deps.ctx;
  const now = deps.now || Date.now;
  const cache = new Map();

  /**
   * Model ids seen in the newest sessions of a provider, most used first.
   *
   * @param {string} provider - claude or codex.
   * @returns {string[]}
   */
  function observedModels(provider) {
    const counts = new Map();
    let list = [];
    try {
      const chat = ctx.mobile && ctx.mobile.chat;
      list = chat && chat.sessions && typeof chat.sessions.list === 'function' ? chat.sessions.list() : [];
    } catch (_) { list = []; }
    const recent = list.filter((s) => s && s.provider === provider).slice(0, MODEL_SAMPLE_SESSIONS);
    for (const s of recent) {
      if (typeof s.model === 'string' && new RegExp(MODEL_PATTERN).test(s.model)) counts.set(s.model, (counts.get(s.model) || 0) + 1);
    }
    if (provider === 'codex') { // gsd:provider-literal-allowed (mobile v2 settings schema)
      for (const id of codexCatalogModels()) if (!counts.has(id)) counts.set(id, 0);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  }

  /**
   * Model ids from the Codex CLI's own catalog (~/.codex/models_cache.json,
   * entries with visibility list), read only, when present.
   *
   * @returns {string[]}
   */
  function codexCatalogModels() {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
      const models = Array.isArray(raw) ? raw : (Array.isArray(raw.models) ? raw.models : []);
      return models
        .filter((m) => m && typeof (m.slug || m.id) === 'string' && (m.visibility === undefined || m.visibility === 'list'))
        .map((m) => String(m.slug || m.id))
        .filter((id) => new RegExp(MODEL_PATTERN).test(id));
    } catch (_) {
      return [];
    }
  }

  /**
   * Model suggestions for a provider: observed ids first, then known ids so
   * a fresh computer still offers a list.
   *
   * @param {string} provider - claude or codex.
   * @returns {Array<{value: string, label: string, description: (string|null)}>}
   */
  function suggestions(provider) {
    const hit = cache.get(provider);
    if (hit && now() - hit.at < SUGGESTION_TTL_MS) return hit.options;
    let ids = observedModels(provider).slice(0, MODEL_SUGGESTIONS);
    if (!ids.length) ids = Object.keys(KNOWN_MODELS).filter((k) => KNOWN_MODELS[k].provider === provider).slice(0, MODEL_SUGGESTIONS);
    const options = ids.map((id) => ({ value: id, label: KNOWN_MODELS[id] ? KNOWN_MODELS[id].label : id, description: KNOWN_MODELS[id] ? KNOWN_MODELS[id].description : null }));
    cache.set(provider, { at: now(), options });
    return options;
  }

  /**
   * The field list of a provider, in schema order.
   *
   * @param {string} provider - claude or codex.
   * @returns {object[]}
   */
  function fieldsOf(provider) {
    if (provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 settings schema)
      return [
        field({ key: 'model', label: 'Model', kind: 'model', options: suggestions('claude'), pattern: MODEL_PATTERN, maxLength: MODEL_MAX_LENGTH }), // gsd:provider-literal-allowed (mobile v2 settings schema)
        field({ key: 'effort', label: 'Effort', kind: 'enum', options: claudeEfforts().map(option) }),
        field({ key: 'permissionMode', label: 'Permission mode', kind: 'enum', options: claudeModes().map(option) }),
      ];
    }
    const e = codexEnums();
    return [
      field({ key: 'model', label: 'Model', kind: 'model', options: suggestions('codex'), pattern: MODEL_PATTERN, maxLength: MODEL_MAX_LENGTH }), // gsd:provider-literal-allowed (mobile v2 settings schema)
      field({ key: 'reasoningEffort', label: 'Reasoning effort', kind: 'enum', options: e.effort.map(option) }),
      field({ key: 'sandbox', label: 'Sandbox', kind: 'enum', options: e.sandbox.map(option) }),
      field({ key: 'approvalPolicy', label: 'Approval policy', kind: 'enum', options: e.approval.map(option) }),
      field({ key: 'bypassApprovalsAndSandbox', label: 'Bypass approvals and sandbox', kind: 'boolean', help: 'Runs every command without asking and without a sandbox.', placeholder: null }),
    ];
  }

  /**
   * The SettingsSchema of a provider (PROTOCOL.md 4.5.3).
   *
   * @param {string} provider - claude or codex.
   * @returns {object}
   */
  function schemaFor(provider) {
    const groups = provider === 'claude' // gsd:provider-literal-allowed (mobile v2 settings schema)
      ? [{ id: 'model', title: 'Model', fieldKeys: ['model', 'effort'] }, { id: 'permissions', title: 'Permissions', fieldKeys: ['permissionMode'] }]
      : [{ id: 'model', title: 'Model', fieldKeys: ['model', 'reasoningEffort'] }, { id: 'permissions', title: 'Permissions', fieldKeys: ['sandbox', 'approvalPolicy', 'bypassApprovalsAndSandbox'] }];
    return { provider, revision: SCHEMA_REVISION, groups, fields: fieldsOf(provider) };
  }

  /**
   * Validate a values patch against the schema. Null resets a key.
   *
   * @param {string} provider - claude or codex.
   * @param {object} values - {key: value}.
   * @returns {{ok: true, values: object}|{ok: false, field: string}}
   */
  function validate(provider, values) {
    const fields = new Map(fieldsOf(provider).map((f) => [f.key, f]));
    const out = {};
    for (const [key, value] of Object.entries(values || {})) {
      const f = fields.get(key);
      if (!f) return { ok: false, field: key };
      if (value === null) { out[key] = null; continue; }
      if (f.kind === 'enum') {
        if (typeof value !== 'string' || !f.options.some((o) => o.value === value)) return { ok: false, field: key };
      } else if (f.kind === 'model') {
        if (typeof value !== 'string' || value.length > MODEL_MAX_LENGTH || !new RegExp(MODEL_PATTERN).test(value)) return { ok: false, field: key };
      } else if (f.kind === 'boolean') {
        if (typeof value !== 'boolean') return { ok: false, field: key };
      } else if (typeof value !== 'string') {
        return { ok: false, field: key };
      }
      out[key] = value;
    }
    return { ok: true, values: out };
  }

  return {
    schemaFor,
    fieldsOf,
    validate,
    suggestions,
    isProvider: (p) => p === 'claude' || p === 'codex', // gsd:provider-literal-allowed (mobile v2 settings schema)
    knownModel: (id) => KNOWN_MODELS[id] || null,
  };
}

module.exports = { createSettingsSchema, SCHEMA_REVISION, MODEL_PATTERN, KNOWN_MODELS };
