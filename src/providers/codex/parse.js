/**
 * Codex transcript parser.
 *
 * Phase 17 Plan 17-01 (CDX-03, CDX-04, CDX-05 parser-half, CDX-08).
 *
 * Reads a Codex rollout file at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl
 * and normalizes each line into ProviderMessage[] for the Provider contract
 * established in Plan 14-03.
 *
 * Every Codex line is one of two shapes:
 *
 *   Modern (>= 0.45): {type, timestamp, payload}
 *     - type=session_meta: file header (skipped from output)
 *     - type=turn_context: per-turn config snapshot (skipped)
 *     - type=event_msg: lifecycle event (skipped; user_message/agent_message
 *       are de-duplicated against response_item.message)
 *     - type=response_item: the meat (message, function_call, function_call_output,
 *       reasoning); reasoning is skipped, the rest emit a ProviderMessage
 *     - type=compacted: auto-compacted older turns; emits ONE
 *       ProviderMessage{role:'system', text:'[history fold]'}
 *
 *   Legacy (pre-0.45): bare-JSON top-level shapes (no type+payload envelope)
 *     - bare SessionMeta: top-level id+cwd+cli_version
 *     - bare ResponseItem: top-level role+content
 *
 * Per-line bare-JSON detection (NOT per-file) handles the case where a
 * pre-0.45 session was resumed under 0.45+ and has mixed shapes on disk.
 *
 * The function NEVER throws on malformed JSONL: bad lines are skipped
 * silently, file IO errors return [], and the whole body is wrapped in
 * try/catch as a final defensive guard. This matches the contract that
 * claudeProvider.parseTranscript already obeys.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/parse
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module-private constants
// ---------------------------------------------------------------------------

/**
 * Placeholder text emitted for every `compacted` envelope. Phase 18 renders
 * this with a distinct visual treatment; the parser only ships the right shape.
 * Contract-frozen as the literal '[history fold]' (lowercase, single space).
 */
const COMPACTED_PLACEHOLDER = '[history fold]';

/**
 * The envelope `type` values observed on disk on Codex >= 0.45. The schema
 * fixture (test/fixtures/codex-rollout-schema.json) enumerates the same set;
 * test/codex-schema.test.js asserts they match (drift gate).
 *
 * BUILD-CONTRACT P9.2 / CODEX-PARITY D.1: the last two entries were measured on
 * 2026-08-13 across the 60 largest rollouts on the reference machine, written by
 * CLI 0.144.0-alpha.4 through 0.146.0-alpha.3.1. Both are metadata rather than
 * conversation and are deliberately skipped, but they are listed HERE, as known
 * envelope types, so the unknown-payload counter stays a signal about genuinely
 * new drift instead of a permanent background hum:
 *
 *   world_state                        {full: boolean, state: {...config}}
 *                                      Config snapshot: model, permissions,
 *                                      skills, environments. No transcript
 *                                      content. 5878 lines in the sample.
 *   inter_agent_communication_metadata {trigger_turn: boolean}
 *                                      One-flag marker that pairs with a
 *                                      response_item.agent_message. 368 lines.
 */
const KNOWN_ENVELOPE_TYPES = [
  'session_meta',
  'turn_context',
  'event_msg',
  'response_item',
  'compacted',
  'world_state',
  'inter_agent_communication_metadata',
];

/**
 * Envelope types that are recognised and deliberately produce no message.
 * Membership here is what separates "we looked at this and decided it carries
 * no turn" from "we have never seen this shape", which is the distinction the
 * P9.2 counter exists to make visible.
 */
const SKIPPED_ENVELOPE_TYPES = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'world_state',
  'inter_agent_communication_metadata',
]);

/**
 * Maximum characters of text carried by one MirrorMessage (issue #10 Tier 1).
 * Applied by parseLine when called with default options (the mirror path);
 * parseTranscript opts out via {maxTextChars: Infinity} so the whole-file
 * transcript view keeps its historical uncapped behavior.
 */
const MIRROR_MAX_TEXT_CHARS = 8192;

/**
 * Stand-in for an image part inside a tool result. Codex returns image parts as
 * `{type: 'input_image', image_url: 'data:image/png;base64,...'}`, and that URL
 * is routinely hundreds of kilobytes of base64. Carrying it into a transcript
 * would be useless to a reader and ruinous to memory, so the part is announced
 * and its payload is dropped.
 */
const IMAGE_PART_PLACEHOLDER = '[image]';

/**
 * Synthetic tool name for `tool_search_call`, which carries no `name` column of
 * its own. Named here rather than inlined so the display string has one owner.
 */
const TOOL_SEARCH_TOOL_NAME = 'tool_search';

/**
 * Synthetic tool name for `web_search_call`, which likewise carries no `name`.
 * Its results arrive on a separate `event_msg.web_search_end` line, which is
 * skipped with the rest of the event stream, so the call is the only trace of a
 * web search that reaches a transcript.
 */
const WEB_SEARCH_TOOL_NAME = 'web_search';

/**
 * Upper bound on a tool body that has to be stringified because it arrived as
 * an object rather than a string (`tool_search_call.arguments` is the only
 * observed case). Bounds a pathological payload without touching the
 * string-valued bodies, which pass through untouched.
 */
const TOOL_BODY_JSON_MAX_CHARS = 4096;

/**
 * How many distinct unknown shapes the drift warning names before it stops.
 * A log line that enumerates fifty variants is not read by anyone.
 */
const UNKNOWN_TYPE_LOG_LIMIT = 5;

/**
 * How a payload field is turned into display text. Named strategies rather than
 * inline branches so a new payload variant is a table row, not a new code path.
 *
 * @enum {string}
 */
const BODY_STRATEGY = Object.freeze({
  /** String passes through untouched; anything else is JSON, bounded. */
  TEXT_OR_JSON: 'text-or-json',
  /** String, or an array of `{type, text}` / `{type: 'input_image'}` parts. */
  PARTS: 'parts',
  /** Array length only, for a list of descriptors nobody wants inline. */
  COUNT: 'count',
});

/**
 * The `response_item` emit set, as an allow-list.
 *
 * CODEX-PARITY B8 measured the cost of the previous hard-coded switch: a
 * representative 2465-line rollout dropped 1072 lines, 43 percent of the file,
 * because `custom_tool_call` and `custom_tool_call_output` had no case. Codex
 * moved to freeform tool calling and the parser kept handling only
 * `function_call`. Re-measured on 2026-08-13 across the 60 largest rollouts:
 * 4306 `custom_tool_call` against 2665 `function_call`, so the unhandled shape
 * is now the MAJORITY of tool traffic.
 *
 * Each row is `{role, kind, nameKey|fixedName, bodyKey, bodyStrategy}`:
 *
 *   role          ProviderMessage role.
 *   kind          Mirror rendering hint.
 *   nameKey       Payload key holding the tool name, when it has one.
 *   fixedName     Literal tool name for payloads that carry none.
 *   bodyKey       Payload key holding the displayable body.
 *   bodyStrategy  How that body becomes text (BODY_STRATEGY).
 *   prefixName    True to render '<name> <body>', which is the historical
 *                 function_call idiom and is preserved byte-for-byte.
 *
 * Field names are measured, not guessed. `custom_tool_call` carries `input`,
 * NOT `arguments`; `custom_tool_call_output.output` is a string in 461 of 1226
 * observed lines and an array of content parts in the other 765.
 */
const RESPONSE_ITEM_ADAPTERS = Object.freeze({
  // Historical rows. Behaviour is unchanged; they moved into the table so the
  // whole emit set is readable in one place.
  function_call: Object.freeze({
    role: 'tool',
    kind: 'tool_use',
    nameKey: 'name',
    bodyKey: 'arguments',
    bodyStrategy: BODY_STRATEGY.TEXT_OR_JSON,
    prefixName: true,
  }),
  function_call_output: Object.freeze({
    role: 'tool',
    kind: 'tool_result',
    bodyKey: 'output',
    bodyStrategy: BODY_STRATEGY.PARTS,
    prefixName: false,
  }),

  // BUILD-CONTRACT P9.1: the dropped-transcript fix.
  custom_tool_call: Object.freeze({
    role: 'tool',
    kind: 'tool_use',
    nameKey: 'name',
    bodyKey: 'input',
    bodyStrategy: BODY_STRATEGY.TEXT_OR_JSON,
    prefixName: true,
  }),
  custom_tool_call_output: Object.freeze({
    role: 'tool',
    kind: 'tool_result',
    bodyKey: 'output',
    bodyStrategy: BODY_STRATEGY.PARTS,
    prefixName: false,
  }),

  // Same drift class, two orders of magnitude rarer: 39 of each across the 60
  // largest rollouts. Free to carry once the table exists, and each one is a
  // line that would otherwise vanish. `arguments` here is an OBJECT
  // (`{query, limit}`), unlike function_call's string, which is exactly why the
  // body strategy is a named thing rather than a typeof check at one site.
  tool_search_call: Object.freeze({
    role: 'tool',
    kind: 'tool_use',
    fixedName: TOOL_SEARCH_TOOL_NAME,
    bodyKey: 'arguments',
    bodyStrategy: BODY_STRATEGY.TEXT_OR_JSON,
    prefixName: true,
  }),
  // Written by the 0.125 and 0.142 families, which predate freeform tool
  // calling. `action` is an object, `{type, url}` or `{type, query, queries}`,
  // and there is no matching response_item output: the results come back on an
  // `event_msg.web_search_end` line, which the de-dup rule skips. So this row
  // is the only trace of a web search that a transcript can carry.
  web_search_call: Object.freeze({
    role: 'tool',
    kind: 'tool_use',
    fixedName: WEB_SEARCH_TOOL_NAME,
    bodyKey: 'action',
    bodyStrategy: BODY_STRATEGY.TEXT_OR_JSON,
    prefixName: true,
  }),

  tool_search_output: Object.freeze({
    role: 'tool',
    kind: 'tool_result',
    fixedName: TOOL_SEARCH_TOOL_NAME,
    bodyKey: 'tools',
    bodyStrategy: BODY_STRATEGY.COUNT,
    // Prefixed because a bare '[3]' is unreadable; the result of a tool search
    // is a list of descriptors nobody wants inlined, so the count is the
    // summary and the name is what makes the count mean anything.
    prefixName: true,
  }),
});

/**
 * `response_item` subtypes that are recognised and deliberately emit nothing.
 * `reasoning` is an encrypted blob (`encrypted_content`, 1-3 KB of ciphertext)
 * plus an optional summary array; it is not user-readable.
 */
const SKIPPED_RESPONSE_ITEM_TYPES = new Set(['reasoning']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a parsed JSONL line into a canonical envelope, detecting pre-0.45
 * bare-JSON shapes and synthesizing the matching envelope.
 *
 * Decision tree:
 *   1. parsed has both .type (string) and .payload (object) -> already an
 *      envelope; return as-is.
 *   2. parsed has top-level .id + .cwd + .cli_version -> bare SessionMeta;
 *      wrap in synthetic session_meta envelope.
 *   3. parsed has top-level .role + .content (array) -> bare ResponseItem;
 *      wrap in synthetic response_item.message envelope.
 *   4. otherwise -> return null (caller skips).
 *
 * Per-line classification is intentional: a 0.45-upgraded session may mix
 * bare and enveloped lines, and per-file detection would mis-route the
 * minority shape.
 *
 * @param {any} parsed - Result of JSON.parse on a single JSONL line.
 * @returns {{type:string, timestamp:string|null, payload:object}|null}
 */
function wrapEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Case 1: modern envelope.
  if (typeof parsed.type === 'string' && parsed.payload && typeof parsed.payload === 'object') {
    return parsed;
  }

  // Case 2: bare SessionMeta (pre-0.45 first line).
  if (
    typeof parsed.id === 'string' &&
    typeof parsed.cwd === 'string' &&
    typeof parsed.cli_version === 'string'
  ) {
    return {
      type: 'session_meta',
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
      payload: parsed,
    };
  }

  // Case 3: bare ResponseItem (pre-0.45 message line).
  if (typeof parsed.role === 'string' && Array.isArray(parsed.content)) {
    return {
      type: 'response_item',
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
      // Synthesize the response_item.message shape downstream code expects.
      payload: { type: 'message', role: parsed.role, content: parsed.content },
    };
  }

  // Unknown shape; let caller skip silently.
  return null;
}

/**
 * Extract the joined text from a response_item.message content array.
 * Codex content parts have type in {input_text, output_text}; other parts
 * (image, tool result, etc.) are filtered out. Mirrors how
 * claude/parse.js#parseTranscript handles its content array.
 *
 * @param {Array} content - response_item.message.content array.
 * @returns {string} Joined text, possibly empty when no input/output parts exist.
 */
function extractMessageText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        (c.type === 'input_text' || c.type === 'output_text') &&
        typeof c.text === 'string'
    )
    .map((c) => c.text)
    .join('');
}

/**
 * Extract display text from a tool-result body.
 *
 * Codex writes a tool result one of two ways, and the split is close to even:
 * a bare string (461 of 1226 observed `custom_tool_call_output` lines) or an
 * array of content parts (the other 765). The array form was previously
 * unhandled everywhere, which is why 86 `function_call_output` lines in the
 * same sample emitted a message with an EMPTY body: they were counted but their
 * content was silently thrown away. Both shapes are handled here, in one place,
 * for every tool-result payload type.
 *
 * Image parts are announced, never inlined: their `image_url` is a base64 data
 * URL that reached 671 KB in the sample.
 *
 * @param {*} value - Raw `output`-style field.
 * @returns {string} Display text; '' when there is nothing displayable.
 */
function extractOutputText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const chunks = [];
  for (const part of value) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      chunks.push(part.text);
      continue;
    }
    // Any part carrying no text at all still deserves a mark, because a result
    // that returned an image and nothing else must not render as empty.
    if (typeof part.type === 'string' && part.type.indexOf('image') !== -1) {
      chunks.push(IMAGE_PART_PLACEHOLDER);
    }
  }
  return chunks.join('');
}

/**
 * Turn a tool-call body into display text according to a named strategy.
 *
 * Kept deliberately total: every unexpected shape resolves to '' rather than
 * throwing or leaking `[object Object]` into a transcript.
 *
 * @param {*} value - Raw payload field.
 * @param {string} strategy - One of BODY_STRATEGY.
 * @returns {string}
 */
function coerceToolBody(value, strategy) {
  if (strategy === BODY_STRATEGY.PARTS) return extractOutputText(value);

  if (strategy === BODY_STRATEGY.COUNT) {
    if (!Array.isArray(value)) return '';
    return '[' + value.length + ']';
  }

  // BODY_STRATEGY.TEXT_OR_JSON, the default. A string is the historical case
  // and passes through with no transformation at all, which is what keeps
  // function_call byte-identical to its previous output.
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return '';
    return json.length > TOOL_BODY_JSON_MAX_CHARS
      ? json.slice(0, TOOL_BODY_JSON_MAX_CHARS)
      : json;
  } catch (_) {
    // Circular or otherwise unserialisable: a body is not worth an exception.
    return '';
  }
}

/**
 * Create the counter object parseTranscript reports and parseLine fills in.
 *
 * CODEX-PARITY D.1 asks for this by name: "add an unknown-payload-type counter
 * to parseTranscript and surface it. A transcript that drops 40 percent of its
 * lines should say so, not render short." The `unknown` bucket is the one that
 * matters; everything else is context that makes the number interpretable.
 *
 * @returns {Object} Fresh, zeroed stats.
 */
function createTranscriptStats() {
  return {
    /** Non-empty lines examined. */
    lines: 0,
    /** Lines that JSON.parse'd into an object. */
    parsed: 0,
    /** Lines that did not parse, or that parsed into a shape with no envelope. */
    unparsable: 0,
    /** Lines that produced a message. */
    emitted: 0,
    /** Lines recognised and deliberately dropped (metadata, de-dup, reasoning). */
    skippedKnown: 0,
    /** Lines dropped because NOTHING recognised them. The drift signal. */
    unknown: 0,
    /** 'envelope/payload' -> count, for the unknown bucket only. */
    unknownTypes: {},
    /** 'envelope/payload' -> count, for everything emitted. */
    emittedTypes: {},
    /** 'envelope/payload' -> count, for everything knowingly skipped. */
    skippedTypes: {},
    /** True when at least one pre-0.45 bare-JSON line was wrapped. */
    bareJson: false,
  };
}

/**
 * Increment a `key -> count` bucket on the stats object.
 *
 * @param {Object|null} stats - Stats object, or null when the caller wants none.
 * @param {string} bucket - Property name of the map to bump.
 * @param {string} key - Map key.
 * @returns {void}
 */
function bumpStat(stats, bucket, key) {
  if (!stats) return;
  const map = stats[bucket];
  if (!map || typeof map !== 'object') return;
  map[key] = (map[key] || 0) + 1;
}

/**
 * Record one classified line on the stats object.
 *
 * @param {Object|null} stats
 * @param {'emitted'|'skippedKnown'|'unknown'} outcome
 * @param {string} typeKey - 'envelope/payload' identity of the line.
 * @returns {void}
 */
function recordOutcome(stats, outcome, typeKey) {
  if (!stats) return;
  if (outcome === 'emitted') {
    stats.emitted++;
    bumpStat(stats, 'emittedTypes', typeKey);
    return;
  }
  if (outcome === 'skippedKnown') {
    stats.skippedKnown++;
    bumpStat(stats, 'skippedTypes', typeKey);
    return;
  }
  stats.unknown++;
  bumpStat(stats, 'unknownTypes', typeKey);
}

/**
 * Map a Codex message role to the ProviderMessage role enum. Codex's
 * 'developer' role is the moral equivalent of Claude's 'system'; user and
 * assistant pass through unchanged. Anything unexpected falls through to
 * 'system' as a defensive default (so we never drop content silently).
 *
 * @param {string} role
 * @returns {'user'|'assistant'|'system'|'tool'}
 */
function normalizeRole(role) {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  // Codex 'developer' messages carry permission instructions; treat as system.
  return 'system';
}

/**
 * Resolve a Codex providerSessionId to its on-disk rollout file path.
 *
 * Walks $CODEX_HOME/sessions/YYYY/MM/DD/ for a file whose name ends with
 * '-<id>.jsonl'. Reads process.env.CODEX_HOME at call time (NOT module
 * load) so a user can change the env between calls; falls back to ~/.codex
 * when unset.
 *
 * Returns null on any IO error or when no matching file exists.
 *
 * @param {string} providerSessionId - Codex session UUID.
 * @returns {string|null} Absolute path to the rollout file, or null.
 */
function resolveRolloutPath(providerSessionId) {
  if (!providerSessionId || typeof providerSessionId !== 'string') return null;

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); // gsd:provider-literal-allowed
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  // The id-suffixed pattern: rollout-<...>-<id>.jsonl.
  const idLower = providerSessionId.toLowerCase();
  const suffix = '-' + idLower + '.jsonl';

  // Walk YYYY/MM/DD/ tree. Recursive readdir is faster than three nested
  // loops and matches the discover.js walk-fallback strategy.
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { recursive: true, withFileTypes: true });
  } catch (_) {
    // Older Node fallback: manual three-level walk.
    return resolveRolloutPathManual(sessionsRoot, suffix);
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name.toLowerCase();
    if (name.startsWith('rollout-') && name.endsWith(suffix)) {
      // Node 20+ Dirent under recursive readdir exposes parentPath; older
      // Node 18 exposes path. Fall back to sessionsRoot if neither is
      // available (which would only happen on a very stripped-down runtime).
      const parent = e.parentPath || e.path || sessionsRoot;
      return path.join(parent, e.name);
    }
  }
  return null;
}

/**
 * Manual three-level YYYY/MM/DD walk used when fs.readdirSync(...,{recursive})
 * is unavailable. Defensive fallback only; primary path uses the recursive
 * Node API.
 *
 * @param {string} sessionsRoot
 * @param {string} suffix - lowercased '-<id>.jsonl' suffix to match.
 * @returns {string|null}
 */
function resolveRolloutPathManual(sessionsRoot, suffix) {
  let years;
  try {
    years = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const y of years) {
    if (!y.isDirectory()) continue;
    const yearDir = path.join(sessionsRoot, y.name);
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const m of months) {
      if (!m.isDirectory()) continue;
      const monthDir = path.join(yearDir, m.name);
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const d of days) {
        if (!d.isDirectory()) continue;
        const dayDir = path.join(monthDir, d.name);
        let files;
        try {
          files = fs.readdirSync(dayDir);
        } catch (_) {
          continue;
        }
        for (const f of files) {
          const lower = f.toLowerCase();
          if (lower.startsWith('rollout-') && lower.endsWith(suffix)) {
            return path.join(dayDir, f);
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public: parseLine (issue #10 Tier 1, provider mirror capability)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MirrorMessage
 * @property {'user'|'assistant'|'system'|'tool'} role  Who the entry belongs to.
 * @property {string} text                              Display text (capped on the mirror path).
 * @property {string|null} timestamp                    ISO timestamp when present on the line.
 * @property {string|null} model                        Always null for Codex (rollouts do not record per-message models).
 * @property {'text'|'tool_use'|'tool_result'|'system'} [kind]  Fine-grained rendering hint.
 * @property {string} [toolName]                        Function name, present when kind === 'tool_use'.
 * @property {boolean} [truncated]                      True when text was capped (only set when true).
 */

/**
 * Apply the mirror text cap. Central choke point shared by every parseLine
 * emit path so capping semantics stay identical across message kinds.
 *
 * @param {string} text - Uncapped text (may be empty).
 * @param {number} maxChars - Cap in characters; Infinity disables capping.
 * @returns {{text: string, truncated: boolean}}
 */
function capMirrorText(text, maxChars) {
  const raw = typeof text === 'string' ? text : '';
  if (maxChars !== Infinity && raw.length > maxChars) {
    return { text: raw.slice(0, maxChars), truncated: true };
  }
  return { text: raw, truncated: false };
}

/**
 * Assemble a MirrorMessage from its parts, setting the optional fields only
 * when meaningful (toolName when present, truncated only when true).
 *
 * @param {'user'|'assistant'|'system'|'tool'} role
 * @param {'text'|'tool_use'|'tool_result'|'system'} kind
 * @param {string} text - Uncapped text.
 * @param {string|null} timestamp
 * @param {string|null} toolName - Only for kind 'tool_use'.
 * @param {number} maxChars - Text cap (Infinity disables).
 * @param {{author?: string, recipient?: string}} [extras] - Optional provenance
 *   fields, set only when present. Added for `response_item.agent_message`,
 *   which is one agent addressing another and would otherwise be
 *   indistinguishable from the main assistant's own turn. Attached as optional
 *   members rather than folded into `text` so no content is ever mangled, and
 *   dropped by parseTranscript's ProviderMessage projection so the transcript
 *   wire shape is unchanged.
 * @returns {MirrorMessage}
 */
function buildMirrorMessage(role, kind, text, timestamp, toolName, maxChars, extras) {
  const capped = capMirrorText(text, maxChars);
  const msg = {
    role: role,
    text: capped.text,
    timestamp: timestamp,
    model: null,
    kind: kind,
  };
  if (toolName) msg.toolName = toolName;
  if (capped.truncated) msg.truncated = true;
  if (extras && typeof extras === 'object') {
    if (typeof extras.author === 'string' && extras.author.length > 0) msg.author = extras.author;
    if (typeof extras.recipient === 'string' && extras.recipient.length > 0) {
      msg.recipient = extras.recipient;
    }
  }
  return msg;
}

/**
 * Build a MirrorMessage for one `response_item` payload through its adapter.
 *
 * The adapter table is the emit set; this function is the single place that
 * turns a row of it into a message, so adding a payload variant never means
 * writing message-assembly code again.
 *
 * The `prefixName` branch reproduces the historical function_call idiom
 * exactly, `(name + ' ' + body).trim()`, so an existing transcript renders
 * byte-for-byte as it did before this table existed.
 *
 * @param {Object} adapter - Row from RESPONSE_ITEM_ADAPTERS.
 * @param {Object} payload - The response_item payload.
 * @param {string|null} timestamp
 * @param {number} maxChars
 * @returns {MirrorMessage}
 */
function buildFromAdapter(adapter, payload, timestamp, maxChars) {
  const rawName = adapter.nameKey ? payload[adapter.nameKey] : null;
  const name = typeof rawName === 'string' && rawName.length > 0
    ? rawName
    : (adapter.fixedName || '');
  const body = coerceToolBody(payload[adapter.bodyKey], adapter.bodyStrategy);
  const text = adapter.prefixName ? (name + ' ' + body).trim() : body;
  // `toolName` is documented as a tool_use field, and function_call_output has
  // always left it null. Gating on the kind keeps that contract intact now that
  // a result row can carry a fixed name of its own.
  const toolName = adapter.kind === 'tool_use' && name.length > 0 ? name : null;
  return buildMirrorMessage(adapter.role, adapter.kind, text, timestamp, toolName, maxChars);
}

/**
 * Parse ONE raw Codex rollout JSONL line into a MirrorMessage.
 *
 * Extraction of the per-line switch that previously lived inline in
 * parseTranscript's loop (wrapEnvelope + the envelope switch); parseTranscript
 * now delegates here per line so the two views can never drift. The emit set
 * as of BUILD-CONTRACT P9.1:
 *
 *   response_item.message              -> {role: normalizeRole(role), kind:'text'}
 *   response_item.agent_message        -> {role:'assistant', kind:'text',
 *                                          author, recipient}
 *   response_item.function_call        -> {role:'tool', kind:'tool_use', toolName,
 *                                          text:'<name> <arguments>'}
 *   response_item.function_call_output -> {role:'tool', kind:'tool_result', text:<output>}
 *   response_item.custom_tool_call     -> {role:'tool', kind:'tool_use', toolName,
 *                                          text:'<name> <input>'}
 *   response_item.custom_tool_call_output -> {role:'tool', kind:'tool_result', text:<output>}
 *   response_item.tool_search_call     -> {role:'tool', kind:'tool_use', toolName}
 *   response_item.tool_search_output   -> {role:'tool', kind:'tool_result'}
 *   compacted                          -> {role:'system', kind:'system', text:'[history fold]'}
 *
 * The last six rows are the P9.1 fix. `custom_tool_call` and its output were
 * 1072 of the 2465 lines in the rollout CODEX-PARITY B8 measured, 43 percent of
 * the file, and they were dropped with no error, no warning and no log.
 *
 * Skip set (returns null): session_meta, turn_context, event_msg (all
 * subtypes), world_state, inter_agent_communication_metadata,
 * response_item.reasoning, unknown shapes, corrupt JSON, and the tailer's
 * oversized-line sentinel (NUL-framed, never valid JSON).
 *
 * Pure, synchronous, never throws.
 *
 * @param {string} line - One raw JSONL line (no trailing newline).
 * @param {Object} [opts]
 * @param {number} [opts.maxTextChars=MIRROR_MAX_TEXT_CHARS] - Text cap per
 *   message; pass Infinity to disable (parseTranscript does, to preserve its
 *   historical uncapped output).
 * @param {Object} [opts.meta] - Optional out-param. When the line was a
 *   pre-0.45 bare-JSON shape that wrapped successfully, parseLine sets
 *   meta.bareJson = true so parseTranscript can keep its once-per-file
 *   warning without re-parsing the line.
 * @param {Object} [opts.stats] - Optional out-param from
 *   createTranscriptStats(). When supplied, every line is classified into
 *   emitted / knowingly-skipped / unknown, which is what makes the next format
 *   drift visible instead of silent (BUILD-CONTRACT P9.2, CODEX-PARITY D.1).
 *   Omitting it costs nothing: the mirror path passes no stats and behaves
 *   exactly as before.
 * @returns {MirrorMessage|null}
 */
function parseLine(line, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const stats = options.stats && typeof options.stats === 'object' ? options.stats : null;
  try {
    if (typeof line !== 'string' || line.length === 0) return null;
    const meta = options.meta && typeof options.meta === 'object' ? options.meta : null;
    let maxChars = MIRROR_MAX_TEXT_CHARS;
    if (options.maxTextChars === Infinity) {
      maxChars = Infinity;
    } else if (Number.isFinite(options.maxTextChars) && options.maxTextChars > 0) {
      maxChars = Math.floor(options.maxTextChars);
    }

    if (stats) stats.lines++;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      // Corrupt or partial line. Counted apart from `unknown` because a torn
      // tail line is expected on a live file and says nothing about drift.
      if (stats) stats.unparsable++;
      return null;
    }

    // Bare-JSON detection mirrors the historical inline check EXACTLY: it is
    // computed pre-wrap, but only surfaced when the envelope wraps (the old
    // loop `continue`d on a null envelope before warning).
    const wasBareJson =
      parsed &&
      typeof parsed === 'object' &&
      !(typeof parsed.type === 'string' && parsed.payload && typeof parsed.payload === 'object');

    const envelope = wrapEnvelope(parsed);
    if (!envelope) {
      // Parsed cleanly but matched no envelope shape at all. That is a
      // structural miss rather than a torn line, so it counts as unknown.
      if (stats) {
        stats.parsed++;
        const tag = parsed && typeof parsed === 'object' && typeof parsed.type === 'string'
          ? parsed.type + '/(unwrappable)'
          : '(no-envelope)';
        recordOutcome(stats, 'unknown', tag);
      }
      return null;
    }

    if (stats) stats.parsed++;
    if (wasBareJson && meta) meta.bareJson = true;
    if (wasBareJson && stats) stats.bareJson = true;

    const ts = typeof envelope.timestamp === 'string' ? envelope.timestamp : null;
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : null;
    const payloadType = payload && typeof payload.type === 'string' ? payload.type : '(none)';

    // Identity used for every stats bucket. Only the envelope type is used for
    // non-response_item lines, because their payload type either repeats the
    // envelope or is irrelevant to drift.
    const typeKey = envelope.type === 'response_item'
      ? 'response_item/' + payloadType
      : envelope.type;

    // ── Envelope-level allow-list ──────────────────────────────────────────
    // Deliberately NOT a `default:` that swallows. Anything not named in one of
    // the three sets below reaches the unknown branch at the bottom and is
    // counted there.

    if (SKIPPED_ENVELOPE_TYPES.has(envelope.type)) {
      // session_meta / turn_context: metadata, not a turn.
      // event_msg: de-dup, response_item carries the same content richer.
      // world_state / inter_agent_communication_metadata: measured metadata,
      //   see the KNOWN_ENVELOPE_TYPES note.
      recordOutcome(stats, 'skippedKnown', typeKey);
      return null;
    }

    if (envelope.type === 'compacted') {
      recordOutcome(stats, 'emitted', typeKey);
      return buildMirrorMessage('system', 'system', COMPACTED_PLACEHOLDER, ts, null, maxChars);
    }

    if (envelope.type === 'response_item') {
      if (!payload) {
        recordOutcome(stats, 'unknown', 'response_item/(no-payload)');
        return null;
      }

      // The two message-shaped payloads keep bespoke handling because their
      // role mapping and provenance fields are not a body-extraction problem.
      if (payloadType === 'message') {
        recordOutcome(stats, 'emitted', typeKey);
        return buildMirrorMessage(
          normalizeRole(payload.role),
          'text',
          extractMessageText(payload.content),
          ts,
          null,
          maxChars
        );
      }

      if (payloadType === 'agent_message') {
        // Multi-agent traffic: one agent addressing another, carrying
        // `author` and `recipient` agent paths and an `input_text` content
        // array. 368 lines across the 60 largest rollouts, all previously
        // dropped. Rendered as an assistant turn because that is what it is;
        // the provenance rides along as optional fields rather than being
        // spliced into the text.
        recordOutcome(stats, 'emitted', typeKey);
        return buildMirrorMessage(
          'assistant',
          'text',
          extractMessageText(payload.content),
          ts,
          null,
          maxChars,
          { author: payload.author, recipient: payload.recipient }
        );
      }

      const adapter = RESPONSE_ITEM_ADAPTERS[payloadType];
      if (adapter) {
        recordOutcome(stats, 'emitted', typeKey);
        return buildFromAdapter(adapter, payload, ts, maxChars);
      }

      if (SKIPPED_RESPONSE_ITEM_TYPES.has(payloadType)) {
        recordOutcome(stats, 'skippedKnown', typeKey);
        return null;
      }

      // Unknown response_item subtype. This is the branch that was silent for
      // 536 custom_tool_call lines per file.
      recordOutcome(stats, 'unknown', typeKey);
      return null;
    }

    // Unknown envelope type. Counted, never swallowed.
    recordOutcome(stats, 'unknown', typeKey);
    return null;
  } catch (_) {
    // Never throws, by contract. An exception here is itself a drift signal,
    // so it is counted rather than vanishing.
    if (stats) recordOutcome(stats, 'unknown', '(exception)');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: parseTranscript
// ---------------------------------------------------------------------------

/**
 * Load and normalize a Codex transcript by providerSessionId.
 * Returns ProviderMessage[]: [{role, text, timestamp, model}].
 * Returns [] for missing/empty/malformed input. NEVER throws.
 *
 * Skip set:
 *   - session_meta (file header, not a turn)
 *   - turn_context (per-turn config metadata)
 *   - event_msg (ALL subtypes; user_message/agent_message are duplicated
 *     by sibling response_item.message lines, and lifecycle events like
 *     task_started/task_complete/token_count carry no transcript content)
 *   - world_state (config snapshot; no conversation content)
 *   - inter_agent_communication_metadata (one boolean flag)
 *   - response_item.reasoning (encrypted blob, not user-readable)
 *
 * Emit set:
 *   - response_item.message (developer -> system, user -> user,
 *     assistant -> assistant)
 *   - response_item.agent_message (agent-to-agent turn -> assistant)
 *   - response_item.function_call (role:'tool', text='<name> <arguments>')
 *   - response_item.function_call_output (role:'tool', text=<output>)
 *   - response_item.custom_tool_call (role:'tool', text='<name> <input>')
 *   - response_item.custom_tool_call_output (role:'tool', text=<output>)
 *   - response_item.tool_search_call / tool_search_output
 *   - compacted (one '[history fold]' placeholder per envelope)
 *
 * De-duplication note: Codex frequently writes BOTH an event_msg and a
 * response_item for the same user/assistant turn. The parser ALWAYS prefers
 * response_item (richer structure) and ALWAYS skips the event_msg version.
 * This is the safe default; if a future Codex version writes ONLY event_msg
 * for a turn, the parser drops it, which is the same failure mode as not
 * recognizing an unknown variant.
 *
 * @param {string} providerSessionId - Codex session UUID.
 * @returns {Promise<Array<{role:string,text:string,timestamp:string|null,model:string|null}>>}
 */
async function parseTranscript(providerSessionId) {
  const detailed = await parseTranscriptDetailed(providerSessionId);
  return detailed.messages;
}

/**
 * parseTranscript, plus the counters that say what it did NOT emit.
 *
 * BUILD-CONTRACT P9.2. The transcript view has been rendering short with no
 * indication that anything was missing: CODEX-PARITY B8 measured 217 messages
 * out of a 2465-line file, and nothing anywhere said that 1072 of those lines
 * had been dropped on the floor. The message list alone cannot express that,
 * so this is the entry point for anything that wants to KNOW rather than guess.
 *
 * parseTranscript delegates here and returns only `.messages`, so its wire
 * shape and every existing caller are untouched.
 *
 * @param {string} providerSessionId - Codex session UUID.
 * @param {Object} [opts]
 * @param {string} [opts.filePath] - Skip id resolution and read this file. Used
 *   by callers that already resolved the rollout (the state store answers that
 *   in O(1)) and by tests working against a fixture.
 * @returns {Promise<{messages: Array<object>, stats: Object, filePath: string|null}>}
 *   Always resolves; never rejects. `stats.unknown > 0` means this transcript
 *   dropped lines nothing recognised, which is the drift signal.
 */
async function parseTranscriptDetailed(providerSessionId, opts) {
  const stats = createTranscriptStats();
  try {
    const options = opts && typeof opts === 'object' ? opts : {};
    const explicitPath = typeof options.filePath === 'string' && options.filePath.length > 0
      ? options.filePath
      : null;

    if (!explicitPath && (!providerSessionId || typeof providerSessionId !== 'string')) {
      return { messages: [], stats: stats, filePath: null };
    }

    const filePath = explicitPath || resolveRolloutPath(providerSessionId);
    if (!filePath) return { messages: [], stats: stats, filePath: null };

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      return { messages: [], stats: stats, filePath: filePath };
    }

    const lines = raw.split('\n');
    const messages = [];
    let bareJsonWarned = false;

    for (const line of lines) {
      if (!line || line.length === 0) continue;

      // Issue #10 Tier 1: the per-line normalization (JSON.parse +
      // wrapEnvelope + envelope switch) now lives in parseLine so the live
      // mirror and this whole-file view can never drift. Behavior is
      // preserved exactly:
      //   - maxTextChars: Infinity keeps the historical uncapped text.
      //   - meta.bareJson carries the pre-0.45 detection out of parseLine
      //     so the once-per-file warning (with filePath, which parseLine
      //     does not know) still fires on the same lines it always did.
      //   - The projection below strips the mirror-only fields (kind,
      //     toolName, truncated, author, recipient) so the returned
      //     ProviderMessage shape is byte-identical to what this function
      //     always returned.
      const meta = {};
      const mirrorMsg = parseLine(line, { maxTextChars: Infinity, meta: meta, stats: stats });

      if (meta.bareJson && !bareJsonWarned) {
        // eslint-disable-next-line no-console
        console.warn(
          '[codex-parse] bare-JSON line detected in ' +
            filePath +
            '; assuming pre-0.45 format'
        );
        bareJsonWarned = true;
      }

      if (!mirrorMsg) continue;

      messages.push({
        role: mirrorMsg.role,
        text: mirrorMsg.text,
        timestamp: mirrorMsg.timestamp,
        model: mirrorMsg.model,
      });
    }

    // The logged else-branch CODEX-PARITY D.1 asks for. One line per parse, not
    // per dropped line, and it names the shapes so the fix is a table row away.
    // This is the alarm that did not exist when the parser started silently
    // discarding 43 percent of every session.
    if (stats.unknown > 0) {
      const shapes = Object.keys(stats.unknownTypes)
        .sort((a, b) => stats.unknownTypes[b] - stats.unknownTypes[a])
        .slice(0, UNKNOWN_TYPE_LOG_LIMIT)
        .map((k) => k + ' x' + stats.unknownTypes[k])
        .join(', ');
      // eslint-disable-next-line no-console
      console.warn(
        '[codex-parse] ' + stats.unknown + ' of ' + stats.lines +
          ' lines were an unrecognised shape and were dropped from ' + filePath +
          ' (' + shapes + '). The rollout format has drifted; extend the emit set.'
      );
    }

    return { messages: messages, stats: stats, filePath: filePath };
  } catch (_) {
    // Catastrophic guard: never throw.
    return { messages: [], stats: stats, filePath: null };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseTranscript,
  // BUILD-CONTRACT P9.2: the same parse with the counters attached. Callers
  // that want to TELL the user a transcript rendered short use this; callers
  // that only want messages keep using parseTranscript, whose shape is
  // unchanged.
  parseTranscriptDetailed,
  // Issue #10 Tier 1: per-line mirror parser. Exported both for the provider
  // mirror capability (src/providers/codex/index.js re-exports it under
  // provider.mirror.parseLine) and for direct tests. Called with default
  // options it caps text at MIRROR_MAX_TEXT_CHARS; parseTranscript calls it
  // with {maxTextChars: Infinity} to preserve its historical output.
  parseLine,
  MIRROR_MAX_TEXT_CHARS,
  // Exported for test introspection. test/codex-schema.test.js asserts the
  // KNOWN_ENVELOPE_TYPES list matches the schema fixture's enum (drift gate).
  // discover.js consumes wrapEnvelope to handle bare-JSON first lines when
  // reading session_meta off disk.
  _internal: {
    wrapEnvelope: wrapEnvelope,
    extractMessageText: extractMessageText,
    normalizeRole: normalizeRole,
    resolveRolloutPath: resolveRolloutPath,
    COMPACTED_PLACEHOLDER: COMPACTED_PLACEHOLDER,
    KNOWN_ENVELOPE_TYPES: KNOWN_ENVELOPE_TYPES,
    // BUILD-CONTRACT P9.1 / P9.2 introspection surface. The emit set is a
    // table so a test can assert its contents directly rather than inferring
    // them from behaviour one payload at a time.
    SKIPPED_ENVELOPE_TYPES: SKIPPED_ENVELOPE_TYPES,
    SKIPPED_RESPONSE_ITEM_TYPES: SKIPPED_RESPONSE_ITEM_TYPES,
    RESPONSE_ITEM_ADAPTERS: RESPONSE_ITEM_ADAPTERS,
    BODY_STRATEGY: BODY_STRATEGY,
    extractOutputText: extractOutputText,
    coerceToolBody: coerceToolBody,
    createTranscriptStats: createTranscriptStats,
    IMAGE_PART_PLACEHOLDER: IMAGE_PART_PLACEHOLDER,
    TOOL_SEARCH_TOOL_NAME: TOOL_SEARCH_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME: WEB_SEARCH_TOOL_NAME,
    TOOL_BODY_JSON_MAX_CHARS: TOOL_BODY_JSON_MAX_CHARS,
  },
};
