/**
 * redact.js: redactSettings(settings) for every settings object that leaves
 * the Workbook process (W3).
 *
 * WHY: settings:updated over SSE and GET /api/mobile/sync used to carry the
 * whole settings object, including any Anthropic API key (R02:372). PROTOCOL.md
 * 1.4: redact `anthropicApiKey`, anything under `mobile.apns`, and any key
 * whose name matches /key|token|secret|password/i, replacing the value with
 * "[redacted]". The input object is never modified.
 */
'use strict';

/** The replacement value. */
const REDACTED = '[redacted]';
/** Key names whose values never leave the process. */
const SENSITIVE_KEY = /key|token|secret|password/i;
/** Guard against pathological nesting. */
const MAX_DEPTH = 32;

/**
 * Deep copy a value, redacting sensitive keys.
 *
 * @param {*} value - Value to copy.
 * @param {number} depth - Current depth.
 * @returns {*}
 */
function redactValue(value, depth) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = v === null || v === undefined ? v : REDACTED;
    } else {
      out[k] = redactValue(v, depth + 1);
    }
  }
  return out;
}

/**
 * Redact a Workbook settings object for broadcast or sync.
 *
 * @param {object} settings - The store's settings (never modified).
 * @returns {object} A redacted deep copy.
 */
function redactSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = redactValue(settings, 0);
  if (Object.prototype.hasOwnProperty.call(out, 'anthropicApiKey') && out.anthropicApiKey != null) {
    out.anthropicApiKey = REDACTED;
  }
  if (out.mobile && typeof out.mobile === 'object' && out.mobile.apns != null) {
    out.mobile = Object.assign({}, out.mobile, { apns: REDACTED });
  }
  return out;
}

module.exports = { redactSettings, REDACTED, SENSITIVE_KEY };
