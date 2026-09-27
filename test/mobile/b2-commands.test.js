/**
 * B2: slash commands (PROTOCOL.md 4.4.8). A fixture home with
 * ~/.claude/commands/a.md and <cwd>/.claude/commands/review/security.md lists
 * `a` (user) and `review:security` (project) after the pinned built ins,
 * descriptions come from front matter or the first line, Codex prompts are
 * prompts:<name>, and every answer validates against sessions/commands.json.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');

const sb = kit.sandbox();
let env;
const cwd = path.join(sb.work, 'cmd-project');

kit.test('fixture command files', async () => {
  fs.mkdirSync(path.join(sb.home, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.claude', 'commands', 'a.md'), '---\ndescription: The a command\n---\nDo a.\n');
  fs.mkdirSync(path.join(cwd, '.claude', 'commands', 'review'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'review', 'security.md'), '# Security review of the current diff\n\nSteps...\n');
  fs.mkdirSync(path.join(sb.codexHome, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(sb.codexHome, 'prompts', 'triage.md'), 'Triage the open issues\n');
  env = await kit.bootChat({ options: { homeDir: () => sb.home } });
});

kit.test('Claude: built ins first, then user a, then project review:security', async () => {
  const id = crypto.randomUUID();
  kit.writeClaude(sb.projects, cwd, id, kit.claudeExchange('x'));
  kit.trackedSession(env.store, { provider: 'claude', resumeSessionId: id, workingDir: cwd });
  env.chat.internals.index.invalidate();
  const r = await kit.api(env.base, 'GET', '/sessions/cl_' + id + '/commands', null, env.device.token);
  kit.eq(r.status, 200);
  kit.validate(r.body, 'sessions/commands.json');
  const names = r.body.commands.map((c) => c.name);
  const builtins = r.body.commands.filter((c) => c.source === 'builtin');
  kit.ok(builtins.length > 30 && names.includes('compact') && names.includes('branch'), 'pinned built ins');
  const ia = names.indexOf('a');
  const ir = names.indexOf('review:security');
  kit.ok(ia > builtins.length - 1 && ir > ia, 'order ' + ia + ' ' + ir);
  kit.eq([r.body.commands[ia].source, r.body.commands[ia].description], ['user', 'The a command']);
  kit.eq([r.body.commands[ir].source, r.body.commands[ir].description], ['project', 'Security review of the current diff']);
  kit.ok(r.body.commands.length <= 200, 'at most 200');
});

kit.test('Codex: built ins then prompts:triage', async () => {
  const id = crypto.randomUUID();
  kit.writeCodex(sb.codexHome, id, kit.codexExchange('x'));
  env.chat.internals.index.invalidate();
  const r = await kit.api(env.base, 'GET', '/sessions/cx_' + id + '/commands', null, env.device.token);
  kit.eq(r.status, 200);
  kit.validate(r.body, 'sessions/commands.json');
  const t = r.body.commands.find((c) => c.name === 'prompts:triage');
  kit.eq([t.source, t.description], ['user', 'Triage the open issues']);
});

kit.test('an unknown session is 404', async () => {
  const r = await kit.api(env.base, 'GET', '/sessions/cl_' + crypto.randomUUID() + '/commands', null, env.device.token);
  kit.eq([r.status, r.body.code], [404, 'SESSION_NOT_FOUND']);
});

kit.run(async () => { if (env) await env.close(); });
