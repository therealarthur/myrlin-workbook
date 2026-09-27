/**
 * migrate/redact.js: masks secret shaped strings in every file of a
 * migration pack as [redacted:kind:sha8] (R08 section 4.7).
 *
 * WHY: the history a takeover reads can hold keys, tokens and connection
 * strings (R08 section 1.6 counted them in real transcripts), and a
 * cross provider migration would hand them to another vendor. The same
 * secret gets the same short hash in every file, so it stays recognizable
 * across the pack without being readable. The raw transcript is not
 * rewritten; the charter forbids copying secrets from it. This module is
 * pure (no I/O) so the indexer worker thread can use it.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const crypto = require('crypto');

/**
 * Secret shapes, most specific first (so an Anthropic key is not reported
 * as a generic OpenAI key). Each `re` is global; `group` names the capture
 * group that holds the secret itself (0 for the whole match).
 */
const PATTERNS = Object.freeze([
  { kind: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{16,}/g, group: 0 },
  { kind: 'openai', re: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: 'github', re: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, group: 0 },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { kind: 'slack', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { kind: 'google', re: /AIza[0-9A-Za-z_-]{35}/g, group: 0 },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0 },
  { kind: 'privateKey', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0 },
  { kind: 'bearer', re: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  { kind: 'dbUrl', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:([^@\s]+)@/g, group: 1 },
  { kind: 'assignment', re: /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*[=:]\s*["']?([^\s"'`,;]{8,})/gi, group: 1 },
]);

/** Length of the stable short hash. */
const HASH_CHARS = 8;
/** A redaction marker, so already masked text is left alone. */
const MARKER_RE = /^\[redacted:[a-zA-Z]+:[0-9a-f]{8}\]$/;

/**
 * The marker for one secret.
 *
 * @param {string} kind - Pattern kind.
 * @param {string} secret - The secret text.
 * @returns {string}
 */
function marker(kind, secret) {
  const h = crypto.createHash('sha256').update(secret).digest('hex').slice(0, HASH_CHARS);
  return '[redacted:' + kind + ':' + h + ']';
}

/**
 * Mask every secret shaped string in a text.
 *
 * @param {string} text - Input.
 * @param {object} [counts] - Optional {kind: n} counter, incremented.
 * @returns {string}
 */
function redact(text, counts) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...args) => {
      const whole = args[0];
      const secret = p.group === 0 ? whole : args[p.group];
      if (!secret || MARKER_RE.test(secret) || secret.startsWith('[redacted:')) return whole;
      // An assignment whose value is a number, a keyword or a reference to
      // another variable is not a secret (max_tokens: 40000000, KEY=process.env.X).
      if (p.kind === 'assignment' && (/^[0-9._-]+$/.test(secret) || /^(true|false|null|undefined|none|required|optional)$/i.test(secret) || /^(\$|\{|%|process\.env|os\.environ|<)/.test(secret))) return whole;
      if (counts) counts[p.kind] = (counts[p.kind] || 0) + 1;
      const m = marker(p.kind, secret);
      return p.group === 0 ? m : whole.replace(secret, m);
    });
  }
  return out;
}

/**
 * Whether a text still holds a secret shaped string (tests and the pack
 * self check use it).
 *
 * @param {string} text - Input.
 * @returns {boolean}
 */
function hasSecret(text) {
  if (typeof text !== 'string') return false;
  return redact(text) !== text;
}

module.exports = { redact, hasSecret, marker, PATTERNS };
