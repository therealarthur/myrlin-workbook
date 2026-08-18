#!/usr/bin/env node
/**
 * fixture.js - the invented world the marketing footage is shot in.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EVERYTHING IN THIS FILE IS INVENTED.
 *
 * There is no operator, no account, no company and no repository behind any of
 * it. Every project name, working directory, session title, transcript line,
 * token count, cost, git branch and Codex thread below was written by hand to
 * look like plausible work. Nothing is copied from, derived from, sampled from
 * or reachable from anybody's real sessions.
 *
 * This matters because the output of this file ends up on screen in a public
 * README. The contract's ground rules put it plainly: "No real project paths,
 * session ids, account names or costs from Arthur's machine in any frame; the
 * fixture is invented and stated as such in the fixture file header." This is
 * that statement.
 *
 * The invented root is `D:\work`, deliberately a drive letter nothing on the
 * build machine uses, so a path that leaked in from somewhere real would be
 * visible at a glance rather than blending in.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT WRITES
 *
 * Three independent surfaces, because the app reads three:
 *
 *   1. The STORE (`<dataDir>/workspaces.json`), which holds the workspaces and
 *      the tracked sessions the sidebar's own list draws.
 *   2. CLAUDE transcripts, at `<claudeProjectsDir>/<encoded-cwd>/<uuid>.jsonl`.
 *      Discovery walks that tree, reads the `cwd` back out of the file rather
 *      than decoding it from the directory name, and takes the title from a
 *      `custom-title` line. Cost comes from `message.usage` on assistant lines.
 *   3. CODEX state, at `$CODEX_HOME`: `state_5.sqlite` (the thread catalogue),
 *      `session_index.jsonl` (titles) and dated `rollout-*.jsonl` transcripts.
 *
 * WHY state_5.sqlite IS NOT OPTIONAL. The Codex session detail strip reads
 * model, reasoning effort, approval mode and sandbox policy EXCLUSIVELY from
 * the state database: `readSessionMetaFromFile` in src/providers/codex/
 * discover.js parses only cwd, timestamp, cli_version and source.subagent out
 * of a rollout and never looks at `turn_context`. A fixture that wrote rollouts
 * alone would show four chips reading "unset", which is precisely the picture
 * the contract forbids.
 *
 * TIME
 *
 * `buildFixture({ now })` is pure: same `now`, same bytes. Every timestamp is a
 * fixed offset from `now` rather than a fixed instant, because the contract
 * requires "Recent list shows both providers within the last hour" and a frozen
 * 2026-08-18 instant would read as "3 months ago" the next time the set is
 * re-shot. Fixing the OFFSETS is what makes two shoots comparable; fixing the
 * absolute instant would make them stale. test/media-pipeline.test.js pins the
 * offsets by calling this with a known `now`.
 *
 * Usage:
 *   node scripts/media/fixture.js --root <dir>     # write a fixture world
 *   node scripts/media/fixture.js --print          # dump the descriptor as JSON
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/fixture
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ── The invented world ───────────────────────────────────────────────────── */

/**
 * The invented drive the fixture's projects live on.
 *
 * Deliberately `D:` and deliberately not a directory anybody has: if a real
 * path ever leaks into a frame it will not look like the rest of the set.
 *
 * BACKSLASHES, not forward slashes, and the reason is load bearing. A Windows
 * Claude transcript records its cwd with backslashes, and the sidebar takes a
 * project's short name with `realPath.split('\\').pop()`. A forward-slashed
 * path survives that split intact, so every Claude project row would render as
 * the whole path where the Codex rows render as a folder name. Matching what a
 * real transcript contains is both more honest and the thing that makes the two
 * providers' rows look alike on screen.
 */
const WORK_ROOT = 'D:\\work';

/** One minute, in milliseconds. Named so the offset table reads as minutes. */
const MINUTE_MS = 60 * 1000;

/** One hour, in milliseconds. */
const HOUR_MS = 60 * MINUTE_MS;

/** One day, in milliseconds. */
const DAY_MS = 24 * HOUR_MS;

/**
 * The Codex detail strip values the contract pins, and the set it forbids.
 *
 * The forbidden set is the four literals the strip used to invent when a thread
 * carried no stored value: not one of them occurred in any real thread on the
 * machine that reported the bug, so seeing them together in a frame would mean
 * the fixture failed to populate the state database and the footage is showing
 * a placeholder. test/media-pipeline.test.js asserts the four never co-occur.
 */
const CODEX_STRIP = Object.freeze({
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  approvalMode: 'on-request',
  sandboxPolicy: 'workspace-write',
});

/**
 * The four literals that must never appear together in a captured frame.
 *
 * @see CODEX_STRIP
 */
const FORBIDDEN_DEFAULT_SET = Object.freeze([
  'gpt-5-codex',
  'workspace-write',
  'on-request',
  'medium',
]);

/**
 * The projects the footage shows, in sidebar order.
 *
 * Session counts follow the contract exactly: storefront-api 6 Claude,
 * mobile-app 4 Codex, docs-site 3 mixed, infra 2 Claude.
 */
const PROJECTS = Object.freeze([
  { id: 'storefront-api', name: 'storefront-api', cwd: WORK_ROOT + '\\storefront-api', branch: 'fix/checkout-race' },
  { id: 'mobile-app', name: 'mobile-app', cwd: WORK_ROOT + '\\mobile-app', branch: 'feat/push-notifications' },
  { id: 'docs-site', name: 'docs-site', cwd: WORK_ROOT + '\\docs-site', branch: 'main' },
  { id: 'infra', name: 'infra', cwd: WORK_ROOT + '\\infra', branch: 'chore/terraform-1-9' },
]);

/**
 * The Claude sessions, newest first within each project.
 *
 * `ageMs` is how far before `now` the transcript was last written, which the
 * app renders as "4 minutes ago". `model` picks the price bucket. `inTok`,
 * `outTok`, `cacheWrite` and `cacheRead` are the token counts the cost worker
 * multiplies by that bucket's per-million rate, chosen so every session lands
 * on a small, believable number of dollars rather than a round one.
 */
const CLAUDE_SESSIONS = Object.freeze([
  // storefront-api: six sessions.
  {
    id: 'c1a70000-0000-4000-8000-000000000101', project: 'storefront-api',
    title: 'Fix checkout race', ageMs: 6 * MINUTE_MS, turns: 14,
    model: 'claude-opus-4-6', inTok: 41200, outTok: 8900, cacheWrite: 12800, cacheRead: 386000,
    prompt: 'the checkout total is wrong when a discount and a gift card are both applied',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000102', project: 'storefront-api',
    title: 'Migrate to Express 5', ageMs: 52 * MINUTE_MS, turns: 22,
    model: 'claude-sonnet-4-5', inTok: 68400, outTok: 15200, cacheWrite: 21000, cacheRead: 512000,
    prompt: 'upgrade the api to express 5 and fix the router changes',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000103', project: 'storefront-api',
    title: 'Rate limit the cart endpoint', ageMs: 4 * HOUR_MS, turns: 9,
    model: 'claude-sonnet-4-5', inTok: 22800, outTok: 4100, cacheWrite: 7400, cacheRead: 154000,
    prompt: 'add a per-ip rate limit to POST /cart and cover it with a test',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000104', project: 'storefront-api',
    title: 'Stripe webhook retries', ageMs: 26 * HOUR_MS, turns: 17,
    model: 'claude-opus-4-6', inTok: 33900, outTok: 7600, cacheWrite: 9800, cacheRead: 241000,
    prompt: 'the payment webhook drops events when stripe retries within a second',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000105', project: 'storefront-api',
    title: 'Split the order service', ageMs: 3 * DAY_MS, turns: 31,
    model: 'claude-sonnet-4-5', inTok: 91500, outTok: 19800, cacheWrite: 28600, cacheRead: 704000,
    prompt: 'pull order creation out of the checkout module into its own service',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000106', project: 'storefront-api',
    title: 'Seed data for local dev', ageMs: 6 * DAY_MS, turns: 6,
    model: 'claude-haiku-4-5', inTok: 12400, outTok: 2900, cacheWrite: 3100, cacheRead: 61000,
    prompt: 'write a seed script that fills the dev database with 40 plausible orders',
  },
  // docs-site: two of its three sessions are Claude.
  {
    id: 'c1a70000-0000-4000-8000-000000000201', project: 'docs-site',
    title: 'Rewrite the getting started page', ageMs: 3 * HOUR_MS, turns: 11,
    model: 'claude-sonnet-4-5', inTok: 26100, outTok: 6400, cacheWrite: 8200, cacheRead: 168000,
    prompt: 'the getting started page assumes docker, rewrite it for a plain node install',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000202', project: 'docs-site',
    title: 'Dark mode for code blocks', ageMs: 2 * DAY_MS, turns: 8,
    model: 'claude-haiku-4-5', inTok: 15800, outTok: 3300, cacheWrite: 4600, cacheRead: 88000,
    prompt: 'code blocks stay light when the site is in dark mode',
  },
  // infra: two sessions.
  {
    id: 'c1a70000-0000-4000-8000-000000000301', project: 'infra',
    title: 'Terraform 1.9 upgrade', ageMs: 9 * HOUR_MS, turns: 19,
    model: 'claude-opus-4-6', inTok: 38700, outTok: 8100, cacheWrite: 11200, cacheRead: 262000,
    prompt: 'bump terraform to 1.9 and fix whatever the plan complains about',
  },
  {
    id: 'c1a70000-0000-4000-8000-000000000302', project: 'infra',
    title: 'Nightly backup verification', ageMs: 5 * DAY_MS, turns: 12,
    model: 'claude-sonnet-4-5', inTok: 29400, outTok: 5700, cacheWrite: 8900, cacheRead: 196000,
    prompt: 'the nightly backup job reports success even when the dump is empty',
  },
]);

/**
 * The Codex threads, newest first.
 *
 * The first entry is the one whose detail strip the contract pins, so it is the
 * one the Codex clip opens. `tokensUsed` is the state database's own O(1) total;
 * Codex carries no dollar price in this application (supportsCost is false), so
 * these render as token counts rather than as money.
 */
const CODEX_SESSIONS = Object.freeze([
  {
    id: '019f1100-0000-7000-8000-000000000401', project: 'mobile-app',
    title: 'Add push notifications', ageMs: 11 * MINUTE_MS,
    preview: 'wire up expo push tokens and the server side fan-out',
    tokensUsed: 48210, cliVersion: '0.151.2',
    model: CODEX_STRIP.model,
    reasoningEffort: CODEX_STRIP.reasoningEffort,
    approvalMode: CODEX_STRIP.approvalMode,
    sandboxPolicy: CODEX_STRIP.sandboxPolicy,
  },
  {
    id: '019f1100-0000-7000-8000-000000000402', project: 'mobile-app',
    title: 'Offline cart persistence', ageMs: 88 * MINUTE_MS,
    preview: 'keep the cart in mmkv so a cold start restores it',
    tokensUsed: 31640, cliVersion: '0.151.2',
    model: 'gpt-5.5', reasoningEffort: 'medium', approvalMode: 'never', sandboxPolicy: 'read-only',
  },
  {
    id: '019f1100-0000-7000-8000-000000000403', project: 'mobile-app',
    title: 'Fix the Android back gesture', ageMs: 7 * HOUR_MS,
    preview: 'the back gesture pops two screens instead of one',
    tokensUsed: 19870, cliVersion: '0.151.2',
    model: 'gpt-5.5-mini', reasoningEffort: 'low', approvalMode: 'on-failure', sandboxPolicy: 'danger-full-access',
  },
  {
    id: '019f1100-0000-7000-8000-000000000404', project: 'mobile-app',
    title: 'Bundle size audit', ageMs: 2 * DAY_MS,
    preview: 'the release bundle grew 4 MB after the icon change',
    tokensUsed: 24450, cliVersion: '0.150.9',
    model: 'gpt-5.5', reasoningEffort: 'high', approvalMode: 'never', sandboxPolicy: 'read-only',
  },
  {
    id: '019f1100-0000-7000-8000-000000000405', project: 'docs-site',
    title: 'Search index rebuild', ageMs: 31 * HOUR_MS,
    preview: 'the search index misses every page added since june',
    tokensUsed: 15230, cliVersion: '0.151.2',
    model: 'gpt-5.5-mini', reasoningEffort: 'medium', approvalMode: 'on-failure', sandboxPolicy: 'read-only',
  },
]);

/** Fixed workspace ids, so a re-shoot lands on the same rows in the same order. */
const WORKSPACE_IDS = Object.freeze({
  storefront: 'f1000000-0000-4000-8000-00000000f001',
  mobile: 'f1000000-0000-4000-8000-00000000f002',
  platform: 'f1000000-0000-4000-8000-00000000f003',
});

/* ── Pure builders ────────────────────────────────────────────────────────── */

/**
 * Encode a working directory the way Claude Code names its project folders.
 *
 * Discovery reads the real path back out of the transcript's `cwd` field rather
 * than decoding this name, so the encoding only has to be plausible and stable,
 * not reversible. Drive letter becomes `C--` style, separators become hyphens,
 * and anything outside the safe set becomes a hyphen too.
 *
 * @param {string} cwd - A working directory, forward or backslash separated.
 * @returns {string} The encoded directory name.
 */
function encodeProjectDir(cwd) {
  return String(cwd)
    .replace(/^([A-Za-z]):/, (_m, drive) => drive.toUpperCase() + '-')
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Build one Claude transcript as JSONL text.
 *
 * The shapes are the minimum discovery, the title cascade and the cost worker
 * all need: a first line carrying `cwd`, alternating user and assistant turns
 * with `message.usage` on the assistant side, and a trailing `custom-title`
 * line, which is the highest-priority title source and therefore the only way
 * to guarantee the sidebar reads exactly what the contract says it should.
 *
 * The token budget is spread across the turns rather than dumped on one, so the
 * cost view's per-session totals are the sum of a plausible conversation.
 *
 * @param {object} spec - One CLAUDE_SESSIONS entry.
 * @param {object} project - Its PROJECTS entry.
 * @param {number} now - Reference instant, in epoch milliseconds.
 * @returns {string} JSONL text, newline terminated.
 */
function buildClaudeTranscript(spec, project, now) {
  const started = now - spec.ageMs - spec.turns * MINUTE_MS;
  const lines = [];
  const share = (total, i) => Math.max(1, Math.round(total / spec.turns) + (i === 0 ? total % spec.turns : 0));

  for (let i = 0; i < spec.turns; i++) {
    const at = new Date(started + i * MINUTE_MS).toISOString();
    const userLine = {
      type: 'user',
      timestamp: at,
      sessionId: spec.id,
      cwd: project.cwd,
      gitBranch: project.branch,
      message: {
        role: 'user',
        content: i === 0 ? spec.prompt : CLAUDE_FOLLOW_UPS[i % CLAUDE_FOLLOW_UPS.length],
      },
    };
    lines.push(JSON.stringify(userLine));

    const assistantLine = {
      type: 'assistant',
      timestamp: new Date(started + i * MINUTE_MS + 30000).toISOString(),
      sessionId: spec.id,
      message: {
        role: 'assistant',
        model: spec.model,
        content: [{ type: 'text', text: CLAUDE_REPLIES[i % CLAUDE_REPLIES.length] }],
        usage: {
          input_tokens: share(spec.inTok, i),
          output_tokens: share(spec.outTok, i),
          cache_creation_input_tokens: share(spec.cacheWrite, i),
          cache_read_input_tokens: share(spec.cacheRead, i),
        },
      },
    };
    lines.push(JSON.stringify(assistantLine));
  }

  lines.push(JSON.stringify({
    type: 'custom-title',
    customTitle: spec.title,
    sessionId: spec.id,
    timestamp: new Date(now - spec.ageMs).toISOString(),
  }));

  return lines.join('\n') + '\n';
}

/** Invented follow-up prompts, cycled so no two turns read identically. */
const CLAUDE_FOLLOW_UPS = Object.freeze([
  'run the tests and show me what broke',
  'that assertion is checking the old shape, update it',
  'add a case for the combination we just fixed',
  'what else reads that field',
  'commit it with a message that explains the ordering',
  'roll that back, the previous version was clearer',
]);

/** Invented assistant replies, cycled the same way. */
const CLAUDE_REPLIES = Object.freeze([
  'Reading the module and the test that covers it now.',
  'The two adjustments were applied in parallel against the same subtotal. Ordering them fixes it.',
  'All 83 cases pass. Two remain pending, both unrelated.',
  'One other caller reads that field, in the receipt template. It already expects the raw figure.',
  'Committed. The message records why the order matters rather than what changed.',
  'Reverted. The earlier shape kept the reducer readable, so the comment carries the reasoning instead.',
]);

/**
 * Build one Codex rollout as JSONL text.
 *
 * `turn_context` is written even though discovery never reads it, because the
 * transcript viewer does, and a rollout without one looks wrong to anybody who
 * opens it. The detail strip's values come from the state database; these are
 * the same values so the two never disagree on screen.
 *
 * @param {object} spec - One CODEX_SESSIONS entry.
 * @param {object} project - Its PROJECTS entry.
 * @param {number} now - Reference instant, in epoch milliseconds.
 * @returns {string} JSONL text, newline terminated.
 */
function buildCodexRollout(spec, project, now) {
  const started = now - spec.ageMs - 12 * MINUTE_MS;
  const at = (offsetMs) => new Date(started + offsetMs).toISOString();
  const lines = [];

  lines.push(JSON.stringify({
    timestamp: at(0),
    type: 'session_meta',
    payload: {
      id: spec.id,
      timestamp: at(0),
      cwd: project.cwd,
      originator: 'Codex Desktop',
      cli_version: spec.cliVersion,
      model_provider: 'openai',
    },
  }));

  lines.push(JSON.stringify({
    timestamp: at(1000),
    type: 'turn_context',
    payload: {
      turn_id: 'turn-' + spec.id.slice(-6),
      cwd: project.cwd,
      model: spec.model,
      reasoning_effort: spec.reasoningEffort,
      approval_policy: spec.approvalMode,
      sandbox_policy: { type: spec.sandboxPolicy },
    },
  }));

  lines.push(JSON.stringify({
    timestamp: at(2000),
    type: 'event_msg',
    payload: { type: 'thread_name_updated', thread_id: spec.id, thread_name: spec.title },
  }));

  lines.push(JSON.stringify({
    timestamp: at(3000),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: spec.preview }] },
  }));

  lines.push(JSON.stringify({
    timestamp: at(9000),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: CODEX_REPLIES[0] }],
    },
  }));

  lines.push(JSON.stringify({
    timestamp: at(12000),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: Math.round(spec.tokensUsed * 0.62),
          cached_input_tokens: Math.round(spec.tokensUsed * 0.24),
          cache_write_input_tokens: Math.round(spec.tokensUsed * 0.05),
          output_tokens: Math.round(spec.tokensUsed * 0.09),
          reasoning_output_tokens: Math.round(spec.tokensUsed * 0.03),
          total_tokens: spec.tokensUsed,
        },
        model_context_window: 258400,
      },
    },
  }));

  return lines.join('\n') + '\n';
}

/** Invented Codex assistant replies. */
const CODEX_REPLIES = Object.freeze([
  'Registering the device token on launch and storing it against the account, then fanning out from the notification worker.',
]);

/**
 * The rollout file name Codex uses, and the only shape discovery's regex accepts.
 *
 * @param {number} whenMs - The rollout's start instant, epoch milliseconds.
 * @param {string} id - The thread uuid.
 * @returns {string} A `rollout-<stamp>-<uuid>.jsonl` file name.
 */
function rolloutFileName(whenMs, id) {
  const stamp = new Date(whenMs).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return 'rollout-' + stamp + '-' + id + '.jsonl';
}

/**
 * The dated directory a rollout lives in, relative to `$CODEX_HOME/sessions`.
 *
 * @param {number} whenMs - The rollout's start instant, epoch milliseconds.
 * @returns {string} A `YYYY/MM/DD` path fragment.
 */
function rolloutDateDir(whenMs) {
  const d = new Date(whenMs);
  const pad2 = (n) => String(n).padStart(2, '0');
  return [d.getUTCFullYear(), pad2(d.getUTCMonth() + 1), pad2(d.getUTCDate())].join('/');
}

/**
 * Build the store document the app boots against.
 *
 * Three workspaces, so the sidebar has something to group by, and a recent list
 * that opens on one Claude session and one Codex session both inside the last
 * hour, which is what the contract's "Recent list shows both providers within
 * the last hour" asks for.
 *
 * Shape follows Store.createWorkspace and Store.createSession, the same way
 * test/browser/notion-shell.spec.js's fixture does; the store merges it over
 * DEFAULT_STATE on load.
 *
 * @param {number} now - Reference instant, in epoch milliseconds.
 * @returns {object} A v2 state document.
 */
function buildStoreState(now) {
  const iso = (ms) => new Date(ms).toISOString();

  // Every discovered session is also tracked. Two reasons, both about what the
  // camera sees. The sessions table draws the ACTIVE workspace, so tracking a
  // subset leaves it three rows long and looking empty. And the cost timeline
  // buckets tracked sessions by day and draws nothing at all when fewer than
  // two days carry a message, so a fixture whose tracked sessions all landed
  // today renders "Not enough data for timeline" in the middle of the cost
  // clip. Tracking the full set spreads the messages across six days.
  const tracked = [];
  const WORKSPACE_OF_PROJECT = {
    'storefront-api': WORKSPACE_IDS.storefront,
    'mobile-app': WORKSPACE_IDS.mobile,
    'docs-site': WORKSPACE_IDS.platform,
    infra: WORKSPACE_IDS.platform,
  };
  for (const spec of CLAUDE_SESSIONS) tracked.push({ claude: spec, workspace: WORKSPACE_OF_PROJECT[spec.project] });
  for (const spec of CODEX_SESSIONS) tracked.push({ codex: spec, workspace: WORKSPACE_OF_PROJECT[spec.project] });

  const sessions = {};
  const order = [];
  tracked.forEach((entry, i) => {
    const spec = entry.claude || entry.codex;
    const provider = entry.claude ? 'claude' : 'codex';
    const project = PROJECTS.find((p) => p.id === spec.project);
    const sessionId = 'a5e50000-0000-4000-8000-0000000005' + String(10 + i);
    sessions[sessionId] = {
      id: sessionId,
      name: spec.title,
      workspaceId: entry.workspace,
      workingDir: project.cwd,
      topic: entry.claude ? spec.prompt : spec.preview,
      command: provider,
      provider: provider,
      resumeSessionId: spec.id,
      status: 'stopped',
      pid: null,
      tags: [project.id],
      initialPrompt: null,
      flags: [],
      createdAt: iso(now - spec.ageMs - 2 * HOUR_MS),
      lastActive: iso(now - spec.ageMs),
      logs: [],
    };
    order.push({ id: sessionId, ageMs: spec.ageMs });
  });

  const byWorkspace = (wsId) => Object.keys(sessions).filter((id) => sessions[id].workspaceId === wsId);
  const newest = (wsId) => byWorkspace(wsId)
    .map((id) => sessions[id].lastActive)
    .sort()
    .pop() || iso(now);

  const workspace = (id, name, description, color) => ({
    id,
    name,
    description,
    color,
    icon: null,
    sessions: byWorkspace(id),
    createdAt: iso(now - 21 * DAY_MS),
    lastActive: newest(id),
    autoSummary: true,
  });

  return {
    version: 2,
    activeWorkspace: WORKSPACE_IDS.storefront,
    workspaces: {
      [WORKSPACE_IDS.storefront]: workspace(WORKSPACE_IDS.storefront, 'Storefront', 'Checkout, orders and payments', 'mauve'),
      [WORKSPACE_IDS.mobile]: workspace(WORKSPACE_IDS.mobile, 'Mobile', 'The React Native client', 'teal'),
      [WORKSPACE_IDS.platform]: workspace(WORKSPACE_IDS.platform, 'Platform', 'Docs and infrastructure', 'peach'),
    },
    sessions,
    worktreeTasks: buildWorktreeTasks(now, sessions),
    recentSessions: order.sort((a, b) => a.ageMs - b.ageMs).slice(0, 6).map((e) => e.id),
    settings: {
      providers: { claude: true, codex: true },
      // Both belt and braces against a credential refresh firing mid-shoot.
      credentialSwitcher: { proactiveRefreshMinutes: 0, externalBridgeOwner: true },
    },
  };
}

/**
 * The invented agent tasks the kanban board draws.
 *
 * Spread across all five columns so the board reads as a board rather than as
 * one loaded column, and ordered so the card the capture drags (the first
 * Review card) has an obvious destination.
 *
 * `worktreePath` is deliberately null. GET /api/worktree-tasks shells out to
 * `git rev-list` and `git diff` once per task to count commits and changed
 * files, and returns early when there is no worktree path. Leaving it null
 * means a capture run spawns no git processes at all, which keeps the shoot
 * hermetic and stops a slow git call from stalling a frame.
 *
 * @param {number} now - Reference instant, in epoch milliseconds.
 * @param {object} sessions - The store's session map, for linking.
 * @returns {object} A worktreeTasks map keyed by task id.
 */
function buildWorktreeTasks(now, sessions) {
  const iso = (ms) => new Date(ms).toISOString();
  const sessionIds = Object.keys(sessions);
  const specs = [
    ['wt_a1b2c3d4', 'backlog', 'Guest checkout without an account', 'feat/guest-checkout', 3 * DAY_MS, 'claude-sonnet-4-5'],
    ['wt_b2c3d4e5', 'backlog', 'Move the receipt template to MJML', 'chore/receipt-mjml', 2 * DAY_MS, 'claude-haiku-4-5'],
    ['wt_c3d4e5f6', 'planning', 'Split the order service', 'refactor/order-service', 30 * HOUR_MS, 'claude-opus-4-6'],
    ['wt_d4e5f6a7', 'running', 'Fix checkout race', 'fix/checkout-race', 3 * HOUR_MS, 'claude-opus-4-6'],
    ['wt_e5f6a7b8', 'running', 'Add push notifications', 'feat/push-notifications', 2 * HOUR_MS, 'gpt-5.5'],
    ['wt_f6a7b8c9', 'review', 'Migrate to Express 5', 'chore/express-5', 20 * HOUR_MS, 'claude-sonnet-4-5'],
    ['wt_a7b8c9d0', 'review', 'Terraform 1.9 upgrade', 'chore/terraform-1-9', 26 * HOUR_MS, 'claude-opus-4-6'],
    ['wt_b8c9d0e1', 'completed', 'Rate limit the cart endpoint', 'feat/cart-rate-limit', 4 * DAY_MS, 'claude-sonnet-4-5'],
    ['wt_c9d0e1f2', 'completed', 'Dark mode for code blocks', 'fix/dark-code-blocks', 5 * DAY_MS, 'claude-haiku-4-5'],
  ];

  const tasks = {};
  specs.forEach(([id, status, description, branch, ageMs, model], i) => {
    const createdAt = iso(now - ageMs);
    tasks[id] = {
      id,
      workspaceId: WORKSPACE_IDS.storefront,
      sessionId: sessionIds[i % sessionIds.length] || null,
      featureId: null,
      branch,
      worktreePath: null,
      repoDir: WORK_ROOT + '\\storefront-api',
      baseBranch: 'main',
      description,
      model,
      tags: [],
      status,
      blockedBy: [],
      history: [{ status, at: createdAt }],
      createdAt,
      completedAt: status === 'completed' ? iso(now - ageMs + 6 * HOUR_MS) : null,
    };
  });
  return tasks;
}

/**
 * Assemble the whole invented world as a plain descriptor.
 *
 * Pure. Writes nothing, reads nothing, and returns the same value for the same
 * `now`, which is what lets the test suite assert its invariants without a
 * filesystem.
 *
 * @param {{now?: number}} [opts] - Reference instant, defaults to Date.now().
 * @returns {object} { now, projects, claude, codex, store }.
 */
function buildFixture(opts) {
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();

  const claude = CLAUDE_SESSIONS.map((spec) => {
    const project = PROJECTS.find((p) => p.id === spec.project);
    return {
      spec,
      project,
      encodedDir: encodeProjectDir(project.cwd),
      fileName: spec.id + '.jsonl',
      mtimeMs: now - spec.ageMs,
      jsonl: buildClaudeTranscript(spec, project, now),
    };
  });

  const codex = CODEX_SESSIONS.map((spec) => {
    const project = PROJECTS.find((p) => p.id === spec.project);
    const startedMs = now - spec.ageMs - 12 * MINUTE_MS;
    return {
      spec,
      project,
      dateDir: rolloutDateDir(startedMs),
      fileName: rolloutFileName(startedMs, spec.id),
      mtimeMs: now - spec.ageMs,
      jsonl: buildCodexRollout(spec, project, now),
    };
  });

  const sessionIndex = codex
    .map((entry) => JSON.stringify({
      id: entry.spec.id,
      thread_name: entry.spec.title,
      updated_at: new Date(now - entry.spec.ageMs).toISOString(),
    }))
    .join('\n') + '\n';

  return {
    now,
    workRoot: WORK_ROOT,
    projects: PROJECTS,
    strip: CODEX_STRIP,
    claude,
    codex,
    sessionIndex,
    store: buildStoreState(now),
  };
}

/* ── The state database ───────────────────────────────────────────────────── */

/**
 * The `threads` columns the fixture writes, in real-schema order.
 *
 * A superset of test/codex-state-db.test.js's FIXTURE_THREAD_COLUMNS, which
 * omits `approval_mode` and `sandbox_policy`. Those two are exactly the columns
 * the detail strip needs, so leaving them out here would reproduce the bug this
 * fixture exists to disprove.
 */
const THREAD_COLUMNS = Object.freeze([
  ['id', 'TEXT'],
  ['rollout_path', 'TEXT'],
  ['cwd', 'TEXT'],
  ['title', 'TEXT'],
  ['preview', 'TEXT'],
  ['name', 'TEXT'],
  ['archived', 'INTEGER'],
  ['is_pinned', 'INTEGER'],
  ['recency_at_ms', 'INTEGER'],
  ['created_at_ms', 'INTEGER'],
  ['updated_at_ms', 'INTEGER'],
  ['tokens_used', 'INTEGER'],
  ['model', 'TEXT'],
  ['model_provider', 'TEXT'],
  ['reasoning_effort', 'TEXT'],
  ['approval_mode', 'TEXT'],
  ['sandbox_policy', 'TEXT'],
  ['cli_version', 'TEXT'],
  ['git_branch', 'TEXT'],
  ['git_sha', 'TEXT'],
  ['thread_source', 'TEXT'],
]);

/**
 * Build the `state_5.sqlite` bytes for a fixture.
 *
 * sql.js rather than a native driver, because sql.js is already a dependency of
 * this project and needs no build toolchain on any platform the capture might
 * run on.
 *
 * @param {object} fixture - The descriptor from buildFixture.
 * @param {string} codexHome - Absolute path the rollout paths are relative to.
 * @returns {Promise<Buffer>} The database bytes.
 */
async function buildStateDatabase(fixture, codexHome) {
  const initSqlJs = require('sql.js');
  const distDir = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(distDir, f) });
  const db = new SQL.Database();

  db.run('CREATE TABLE threads (' + THREAD_COLUMNS.map(([n, t]) => n + ' ' + t).join(', ') + ')');
  db.run('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)');

  for (const entry of fixture.codex) {
    const spec = entry.spec;
    const rolloutPath = path.join(codexHome, 'sessions', entry.dateDir, entry.fileName);
    const recency = fixture.now - spec.ageMs;
    const values = [
      spec.id,
      rolloutPath,
      entry.project.cwd,
      spec.title,
      spec.preview,
      null,
      0,
      0,
      recency,
      recency - 45 * MINUTE_MS,
      recency,
      spec.tokensUsed,
      spec.model,
      'openai',
      spec.reasoningEffort,
      spec.approvalMode,
      // Written as the JSON struct the real table carries, so
      // normalizeSandboxPolicyType in server.js has to do its real work rather
      // than pass a bare word straight through.
      JSON.stringify({ type: spec.sandboxPolicy }),
      spec.cliVersion,
      entry.project.branch,
      FIXTURE_GIT_SHAS[spec.id] || null,
      'user',
    ];
    db.run(
      'INSERT INTO threads (' + THREAD_COLUMNS.map(([n]) => n).join(', ') + ') VALUES (' +
      THREAD_COLUMNS.map(() => '?').join(', ') + ')',
      values
    );
  }

  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
}

/** Invented short commit hashes, one per Codex thread. */
const FIXTURE_GIT_SHAS = Object.freeze({
  '019f1100-0000-7000-8000-000000000401': '4c1a9e7',
  '019f1100-0000-7000-8000-000000000402': 'b03f118',
  '019f1100-0000-7000-8000-000000000403': '7de2a05',
  '019f1100-0000-7000-8000-000000000404': '91c47bd',
  '019f1100-0000-7000-8000-000000000405': '2fa8630',
});

/* ── Writer ───────────────────────────────────────────────────────────────── */

/**
 * Write the whole invented world under one root.
 *
 * The root is expected to be a disposable sandbox directory that the caller
 * created and will delete. Nothing here escapes it: every path is joined onto
 * `root`, and the function refuses a root that is not an absolute path, so a
 * mistyped argument cannot land the fixture in a home directory.
 *
 * @param {{root: string, now?: number}} opts - Destination and reference instant.
 * @returns {Promise<object>} Resolved paths plus the descriptor that was written.
 */
async function writeFixture(opts) {
  const root = opts && opts.root;
  if (!root || !path.isAbsolute(root)) {
    throw new Error('writeFixture needs an absolute root directory');
  }

  const fixture = buildFixture({ now: opts.now });

  const dataDir = path.join(root, 'data');
  const profileDir = path.join(root, 'profile');
  const claudeProjectsDir = path.join(profileDir, '.claude', 'projects');
  const codexHome = path.join(profileDir, '.codex');

  for (const dir of [dataDir, profileDir, claudeProjectsDir, codexHome]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n', 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify(fixture.store, null, 2) + '\n',
    'utf8'
  );

  // Claude transcripts. The mtime is set explicitly because discovery uses it
  // as lastActive; without it every session would read "a moment ago" and the
  // sidebar's recency ordering, which is one of the things the footage is
  // supposed to show, would collapse into a single bucket.
  for (const entry of fixture.claude) {
    const dir = path.join(claudeProjectsDir, entry.encodedDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, entry.fileName);
    fs.writeFileSync(file, entry.jsonl, 'utf8');
    const when = new Date(entry.mtimeMs);
    fs.utimesSync(file, when, when);
  }

  // Codex rollouts, dated the way the CLI dates them.
  for (const entry of fixture.codex) {
    const dir = path.join(codexHome, 'sessions', ...entry.dateDir.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, entry.fileName);
    fs.writeFileSync(file, entry.jsonl, 'utf8');
    const when = new Date(entry.mtimeMs);
    fs.utimesSync(file, when, when);
  }

  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), fixture.sessionIndex, 'utf8');

  const dbBytes = await buildStateDatabase(fixture, codexHome);
  fs.writeFileSync(path.join(codexHome, 'state_5.sqlite'), dbBytes);

  return {
    root,
    dataDir,
    profileDir,
    claudeProjectsDir,
    codexHome,
    stateDbPath: path.join(codexHome, 'state_5.sqlite'),
    fixture,
  };
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

/**
 * Entry point for direct invocation.
 *
 * @returns {Promise<void>} Resolves when the requested action has run.
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--print')) {
    const fixture = buildFixture({ now: Date.parse('2026-08-18T12:00:00.000Z') });
    process.stdout.write(JSON.stringify({
      projects: fixture.projects,
      strip: fixture.strip,
      claude: fixture.claude.map((e) => ({ id: e.spec.id, title: e.spec.title, dir: e.encodedDir })),
      codex: fixture.codex.map((e) => ({ id: e.spec.id, title: e.spec.title, file: e.fileName })),
    }, null, 2) + '\n');
    return;
  }
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1 || !argv[rootIndex + 1]) {
    process.stderr.write('usage: node scripts/media/fixture.js --root <dir> | --print\n');
    process.exitCode = 1;
    return;
  }
  const written = await writeFixture({ root: path.resolve(argv[rootIndex + 1]) });
  process.stdout.write('fixture written to ' + written.root + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('fixture failed: ' + err.message + '\n');
    process.exit(1);
  });
}

module.exports = {
  WORK_ROOT,
  PROJECTS,
  CLAUDE_SESSIONS,
  CODEX_SESSIONS,
  CODEX_STRIP,
  FORBIDDEN_DEFAULT_SET,
  WORKSPACE_IDS,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  encodeProjectDir,
  buildClaudeTranscript,
  buildCodexRollout,
  buildStoreState,
  buildWorktreeTasks,
  buildFixture,
  buildStateDatabase,
  writeFixture,
};
