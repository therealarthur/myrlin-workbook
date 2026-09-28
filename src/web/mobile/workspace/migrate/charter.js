/**
 * migrate/charter.js: fills the takeover charter (CHARTER.md) and the
 * reader brief (READER.md) for one migration (R08 sections 5.1 to 5.3,
 * A20, critic F15).
 *
 * WHY: the charter is how the new session learns its stance (successor and
 * auditor), its rules for the review phase, its reading plan by tier and
 * the report template with the "Solved and verified" and "Learned" sections
 * A20 and F15 add. It reaches the model as a file, never on a command line
 * (W2): Claude gets it through append-system-prompt-file, Codex reads
 * START.md from a fixed kickoff. The coverage words follow the tier, so the
 * report never implies it read more than it did (F15).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Characters per token for estimates (R08 section 3, Anthropic's ratio). */
const CHARS_PER_TOKEN = 2.5;
/** Usable context of a target by provider (R08 section 4.4). */
const CONTEXT_TOKENS = Object.freeze({ claude: 1000000, codex: 258400 }); // gsd:provider-literal-allowed (mobile v2 migration charter)
/** The fixed kickoffs (R08 section 4.4); plain ASCII, never free text. */
const CLAUDE_KICKOFF = 'Begin the takeover described in your instructions.';
/** The Codex kickoff names START.md by its path in the pack. */
const codexKickoff = (startPath) => 'Read ' + startPath + ' and follow it exactly.';
/** A fork ("Continue as is") starts with the review steps too (R08:475). */
const forkKickoff = (charterPath) => 'Read ' + charterPath + ' and follow its review steps before anything else.';
/** How much of the last human message the glance block shows. */
const GLANCE_ASK_CHARS = 400;

/**
 * Words for a tier and depth, used in the charter's step 2 (F15).
 *
 * @param {string} tier - S, M or L.
 * @param {string} depth - quick, standard or exhaustive.
 * @returns {string}
 */
function tierWords(tier, depth) {
  if (depth === 'quick') return 'read the orientation files and the final range only, and report partial coverage.';
  if (depth === 'exhaustive') return 'every turn is read in full, by you or by readers with the full chunks of their range.';
  if (tier === 'S') return 'you read every turn yourself, in full.';
  if (tier === 'M') return 'readers read every turn, and you read the key turns and the final range in full.';
  return "readers read every turn's digest and open the key turns in full; you read the final era in full.";
}

/**
 * The coverage words the header's coverage field should use (F15).
 *
 * @param {string} tier - Tier.
 * @param {string} depth - Depth.
 * @param {{fromTurn: number, toTurn: number}|null} last - The final range.
 * @returns {string}
 */
function coverageWords(tier, depth, last) {
  const tail = last ? 'T' + last.fromTurn + ' to T' + last.toTurn : 'the final range';
  if (depth === 'quick') return 'orientation files and ' + tail + ' only';
  if (tier === 'S') return 'all turns in full';
  if (tier === 'M') return 'all turns via readers; ' + tail + ' in full';
  return 'all turns via readers from the digest; key turns and ' + tail + ' in full';
}

/**
 * Replace {{KEY}} placeholders.
 *
 * @param {string} text - Template.
 * @param {object} vars - Values.
 * @returns {string}
 */
function fill(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/**
 * The provider notes of the charter (R08 section 5.2).
 *
 * @param {string} provider - Target provider.
 * @param {string} charterPath - Where the charter is.
 * @returns {string}
 */
function providerNotes(provider, charterPath) {
  if (provider === 'codex') { // gsd:provider-literal-allowed (mobile v2 migration charter)
    return [
      '- Start readers with collaboration.spawn_agent, giving each the full text of READER.md plus its range, and collect them with collaboration.wait_agent. At most {{MAX_READERS}} at a time.',
      '- The sandbox is read only for this phase, so you cannot write files. Put the whole report in your final answer; Workbook saves it to the pack.',
      '- After any compaction, re-read ' + charterPath + ' (START.md) before continuing.',
      '- AGENTS.md loads automatically, but the source session ran under the CLAUDE.md files in standards/. They bind you even though Codex does not load them. Hooks they mention do not run here; follow those rules by hand (for example, no em dashes in any output).',
      '- Your reasoning is not visible to the user or to other tools. Everything the user needs must be in the report.',
    ].join('\n');
  }
  return [
    '- Start readers with the Agent tool (general purpose type), model {{READER_MODEL}}. Launch up to {{MAX_READERS}} in one message so they run in parallel, and give each the full text of READER.md plus its range. Readers stay read only for the whole review, as you do.',
    '- Your Read tool is the wrong tool for raw transcript lines (single lines reach 2 MB). Use tools/slice.js.',
    '- This session starts in plan mode. Present the finished report with ExitPlanMode as your plan, and do not edit anything before that, even if the tools would let you.',
    '- CLAUDE.md files load automatically. standards/ also holds the files the source ran under, which can include AGENTS.md from Codex; they bind you too.',
    '- If you need a decision from the user after the report, use AskUserQuestion with your recommended option first.',
  ].join('\n');
}

/**
 * The "source at a glance" block (about 1K tokens, R08 section 4.4).
 *
 * @param {object} o - Values (see fillCharter).
 * @returns {string}
 */
function glance(o) {
  const m = o.manifest || {};
  const lines = [
    '- Name: ' + o.sourceName,
    '- Provider: ' + o.sourceProvider + '; models: ' + (Object.keys(m.models || {}).join(', ') || 'unknown'),
    '- Span: ' + (m.firstTs || 'unknown') + ' to ' + (m.lastTs || 'unknown') + ', ' + (m.turns || 0) + ' user turns, ' + (m.toolCalls || 0) + ' tool calls, ' + (m.toolErrors || 0) + ' failed',
    '- Compactions: ' + (m.checkpoints || 0) + '; decisions asked of the user: ' + (m.decisions || 0),
    '- Tier: ' + o.tier + ' (' + o.ranges + ' ranges, depth ' + o.depth + ')',
    '- Index coverage: ' + o.coverage,
    '- Git: ' + (o.gitSummary || 'no repository found at the working directory'),
    '- The user\'s last message: ' + (o.lastAsk ? '"' + String(o.lastAsk).replace(/\s+/g, ' ').slice(0, GLANCE_ASK_CHARS) + '"' : 'unknown'),
  ];
  if (o.cutAtMessage) lines.push('- This takeover covers the history up to and including message ' + o.cutAtMessage + ' only.');
  return lines.join('\n');
}

/**
 * Fill the charter for one migration.
 *
 * @param {object} o - {provider, sourceName, sourceProvider, manifest, rawPath, snapshotBytes, cwd, otherCwds, packDir, charterPath, tier, depth, ranges, maxReaders, readerModel, coverage, gitSummary, lastAsk, lastRange, cutAtMessage}
 * @returns {string}
 */
function fillCharter(o) {
  const template = fs.readFileSync(path.join(__dirname, 'CHARTER.md'), 'utf8');
  const m = o.manifest || {};
  const stop = o.provider === 'codex' // gsd:provider-literal-allowed (mobile v2 migration charter)
    ? 'Put the whole report in your final answer. Workbook saves it.'
    : 'When the report is ready, present it with ExitPlanMode as your plan.';
  const withNotes = fill(template, {
    PROVIDER_NOTES: providerNotes(o.provider, o.charterPath),
    PROVIDER_STOP_INSTRUCTION: stop,
    SOURCE_AT_A_GLANCE: glance(o),
  });
  return fill(withNotes, {
    SOURCE_NAME: o.sourceName,
    SOURCE_PROVIDER: o.sourceProvider,
    SOURCE_MODELS: Object.keys(m.models || {}).join(', ') || 'unknown',
    TURNS: m.turns || 0,
    FIRST_TS: m.firstTs || 'unknown',
    LAST_TS: m.lastTs || 'unknown',
    SNAPSHOT_BYTES: o.snapshotBytes,
    RAW_PATH: o.rawPath,
    CWD: o.cwd || 'unknown',
    OTHER_CWDS: (o.otherCwds || []).join(', ') || 'none',
    PACK: o.packDir,
    COVERAGE: o.coverage,
    HUMAN_TOKENS: Math.ceil((m.humanChars || 0) / CHARS_PER_TOKEN),
    TIER: o.tier,
    TIER_WORDS: tierWords(o.tier, o.depth),
    MAX_READERS: o.maxReaders,
    READER_MODEL: o.readerModel || 'the same model',
    CHARTER_PATH: o.charterPath,
    CONTEXT: CONTEXT_TOKENS[o.provider] || CONTEXT_TOKENS.claude,
    COVERAGE_WORDS: coverageWords(o.tier, o.depth, o.lastRange || null),
  });
}

/**
 * Fill the reader brief template with the pack path; the per range fields
 * stay as placeholders the lead fills from ranges.json (R08 section 5.3).
 *
 * @param {string} packDir - Pack folder.
 * @returns {string}
 */
function fillReader(packDir) {
  const template = fs.readFileSync(path.join(__dirname, 'READER.md'), 'utf8');
  return fill(template, { PACK: packDir });
}

module.exports = { fillCharter, fillReader, tierWords, coverageWords, CLAUDE_KICKOFF, codexKickoff, forkKickoff, CONTEXT_TOKENS, CHARS_PER_TOKEN };
