/**
 * migrate/report.js: the takeover report: finding and mapping its JSON
 * header, saving TAKEOVER.md in the pack, coveragePercent, and the evidence
 * turn read from the pack (PROTOCOL.md 4.12.6, 4.12.7; R08 section 5.2).
 *
 * WHY: the model writes the header in snake case (R08:360); the phone gets
 * camelCase with every count present, so it can draw the tally without
 * parsing prose. solvedVerified and learned count the "Solved and verified"
 * and "Learned" sections A20 and F15 add; when a model leaves them out of
 * the header they are counted from the sections themselves. coveragePercent
 * is computed by Workbook from the reading step, never taken from the model
 * (PROTOCOL.md 4.12.6), so a report cannot claim coverage it did not have.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

/** Count fields of the header: camelCase name and the snake case aliases. */
const COUNTS = Object.freeze([
  ['claimsChecked', ['claims_checked']],
  ['claimsHeld', ['claims_held']],
  ['claimsFailed', ['claims_failed']],
  ['claimsUnverifiable', ['claims_unverifiable']],
  ['suspectedMistakes', ['suspected_mistakes']],
  ['openIssues', ['open_issues', 'open_items']],
  ['solvedVerified', ['solved_verified']],
  ['learned', ['learned']],
]);
/** Confidence values; anything else maps to low (PROTOCOL.md 4.12.6). */
const CONFIDENCE = ['high', 'medium', 'low'];
/** Section headings counted when the header lacks a count. */
const SECTION_RES = Object.freeze({
  solvedVerified: /^#+\s*(?:\d+\.\s*)?solved and verified\b|^\d+\.\s*solved and verified\b/i,
  learned: /^#+\s*(?:\d+\.\s*)?learned\b|^\d+\.\s*learned\b/i,
});

/**
 * Find the JSON header of a report: the first fenced json block, else the
 * first line that parses as an object holding a takeover field.
 *
 * @param {string} markdown - Report text.
 * @returns {object|null} The raw header.
 */
function findHeader(markdown) {
  const text = String(markdown || '');
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    try {
      const o = JSON.parse(m[1].trim());
      if (o && typeof o === 'object' && ('takeover_report' in o || 'claims_checked' in o || 'takeoverReport' in o || 'schema' in o)) return o;
    } catch (_) { /* not the header */ }
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && ('takeover_report' in o || 'claims_checked' in o)) return o;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

/**
 * Items listed under a section heading (bullets or numbered lines) until
 * the next heading.
 *
 * @param {string} markdown - Report.
 * @param {RegExp} heading - Heading matcher.
 * @returns {number}
 */
function countSection(markdown, heading) {
  const lines = String(markdown || '').split('\n');
  let inside = false;
  let n = 0;
  for (const line of lines) {
    const t = line.trim();
    if (heading.test(t)) { inside = true; continue; }
    if (inside && (/^#+\s/.test(t) || /^\d+\.\s+[A-Z][a-z]+( [a-z]+)*:?$/.test(t))) break;
    if (inside && /^([-*]|\d+[.)])\s+\S/.test(t)) n += 1;
  }
  return n;
}

/**
 * Map a raw header (snake case) to the ReportHeader (camelCase), filling
 * every field (report-header.json).
 *
 * @param {object|null} raw - Raw header.
 * @param {string} markdown - Report (for section counts).
 * @param {string} fallbackCoverage - Coverage words when the header has none.
 * @returns {object}
 */
function mapHeader(raw, markdown, fallbackCoverage) {
  const h = raw && typeof raw === 'object' ? raw : {};
  const intOf = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : null);
  const out = { takeoverReport: 1, verdict: typeof h.verdict === 'string' ? h.verdict : '' };
  for (const [key, aliases] of COUNTS) {
    let v = intOf(h[key]);
    for (const a of aliases) if (v === null) v = intOf(h[a]);
    if (v === null && SECTION_RES[key]) v = countSection(markdown, SECTION_RES[key]);
    out[key] = v === null ? 0 : v;
  }
  out.coverage = typeof h.coverage === 'string' && h.coverage.trim() ? h.coverage.trim() : fallbackCoverage;
  const conf = typeof h.confidence === 'string' ? h.confidence.toLowerCase() : '';
  out.confidence = CONFIDENCE.includes(conf) ? conf : 'low';
  return out;
}

/**
 * coveragePercent (PROTOCOL.md 4.12.6): the floor of 100 times the ranges
 * the readers finished over the ranges planned; a tier S plan (the lead
 * reads everything itself) is 100 once the report exists.
 *
 * @param {string} tier - S, M or L.
 * @param {object|null} readingStep - The migration's reading step.
 * @returns {number}
 */
function coveragePercent(tier, readingStep) {
  if (tier === 'S') return 100;
  const done = readingStep && Number.isInteger(readingStep.done) ? readingStep.done : 0;
  const total = readingStep && Number.isInteger(readingStep.total) && readingStep.total > 0 ? readingStep.total : 0;
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.floor((100 * Math.min(done, total)) / total)));
}

/**
 * Save the report in the pack as TAKEOVER.md (redacted) with its header.
 *
 * @param {string} packDir - Pack folder.
 * @param {string} markdown - Report text.
 * @param {object} saved - {header, savedAtMs, coveragePercent, tripwire}.
 */
function saveReport(packDir, markdown, saved) {
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'TAKEOVER.md'), redact(String(markdown || '')));
  fs.writeFileSync(path.join(packDir, 'report.json'), JSON.stringify(saved, null, 2));
}

/**
 * The saved report of a pack, or null.
 *
 * @param {string} packDir - Pack folder.
 * @returns {{markdown: string, header: object, savedAtMs: number, coveragePercent: number, tripwire: object}|null}
 */
function readReport(packDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'report.json'), 'utf8'));
    const markdown = fs.readFileSync(path.join(packDir, 'TAKEOVER.md'), 'utf8');
    return Object.assign({ markdown }, meta);
  } catch (_) {
    return null;
  }
}

/**
 * One source turn from the pack for the evidence sheet (PROTOCOL.md 4.12.7).
 *
 * @param {string} packDir - Pack folder.
 * @param {number} n - Turn number (1 based).
 * @returns {object|null} {turn, ts, user, events, offset}
 */
function readTurn(packDir, n) {
  let offsets;
  try { offsets = JSON.parse(fs.readFileSync(path.join(packDir, 'turns-index.json'), 'utf8')); } catch (_) { return null; }
  if (!Array.isArray(offsets) || !Number.isInteger(n) || n < 1 || n > offsets.length) return null;
  const file = path.join(packDir, 'turns.jsonl');
  const start = offsets[n - 1];
  const end = n < offsets.length ? offsets[n] : fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { findHeader, mapHeader, countSection, coveragePercent, saveReport, readReport, readTurn };
