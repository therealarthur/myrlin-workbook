/**
 * b3-settings.test.js: settings schemas and session settings (PROTOCOL.md
 * 4.5.3; decision A14; critic F16; BUILD-CONTRACT 3.7.2 "Settings", 3.4.4).
 *
 * Both schemas validate and carry exactly the two groups; invalid values
 * answer 422 INVALID_SETTING with the field; values land where Workbook
 * keeps them (the tracked Claude record, the Codex bundle or its ad hoc per
 * thread bundle, the mobile file for discovered Claude sessions, applied by
 * B2 when it creates a store session); a live session reports
 * pendingRestart until its next start; owners that may not change settings
 * answer SESSION_READ_ONLY; launchOptionsFor has the promised shape.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./b3-kit');
const { createDiscoveryCache } = require('../../src/web/mobile/chat/discovery-cache');

const sb = kit.sandbox();
const discovery = createDiscoveryCache({ registry: { getProvider: () => null } });
const dir = path.join(sb.work, 'settings');
const ids = { claude: crypto.randomUUID(), disc: crypto.randomUUID(), codex: crypto.randomUUID(), codexDisc: crypto.randomUUID(), desk: crypto.randomUUID() };
const fakePty = () => ({ pid: 4343, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, on() {} });
let env;
let rec;
let codexRec;

kit.test('boot with tracked and discovered sessions of both providers', async () => {
  env = await kit.bootWorkspace({ pty: true, chat: { discovery } });
  const ws = env.store.createWorkspace({ name: 'Settings' });
  fs.mkdirSync(dir, { recursive: true });
  kit.writeClaude(sb.projects, dir, ids.claude, kit.claudeExchange('claude tracked'));
  kit.writeClaude(sb.projects, dir, ids.disc, kit.claudeExchange('claude discovered'));
  kit.writeCodex(sb.codexHome, ids.codex, kit.codexExchange('codex tracked'), { cwd: dir });
  kit.writeCodex(sb.codexHome, ids.codexDisc, kit.codexExchange('codex discovered'), { cwd: dir });
  kit.writeCodex(sb.codexHome, ids.desk, kit.codexExchange('desktop'), { cwd: dir, originator: 'Codex Desktop' });
  rec = kit.tracked(env.store, { workspaceId: ws.id, provider: 'claude', workingDir: dir, resumeSessionId: ids.claude, name: 'Claude settings' });
  env.store.updateSession(rec.id, { model: 'claude-opus-5-5', bypassPermissions: true });
  codexRec = kit.tracked(env.store, { workspaceId: ws.id, provider: 'codex', workingDir: dir, resumeSessionId: ids.codex, name: 'Codex settings', command: 'codex' });
  discovery._seed('claude', [ids.claude, ids.disc].map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: dir, lastActive: new Date(), sizeBytes: 100 })));
  discovery._seed('codex', [ids.codex, ids.codexDisc, ids.desk].map((id) => ({ provider: 'codex', providerSessionId: id, projectPath: dir, lastActive: new Date(), sizeBytes: 100 })));
  env.chat.internals.index.invalidate();
});

kit.test('settings schemas validate, with two groups in order and every field applying at next start', async () => {
  for (const provider of ['claude', 'codex']) {
    const r = await env.api('GET', '/providers/' + provider + '/settings-schema');
    kit.eq(r.status, 200, JSON.stringify(r.body));
    kit.validate(r.body, 'sessions/settings-schema.json');
    kit.eq(r.body.groups.map((g) => [g.id, g.title]), [['model', 'Model'], ['permissions', 'Permissions']]);
    kit.ok(r.body.fields.every((f) => f.appliesAt === 'nextStart'), 'nextStart everywhere (A14)');
    const keys = r.body.groups.flatMap((g) => g.fieldKeys);
    kit.eq(keys, r.body.fields.map((f) => f.key), 'fields in group order');
  }
  const c = await env.api('GET', '/providers/claude/settings-schema');
  const f = Object.fromEntries(c.body.fields.map((x) => [x.key, x]));
  kit.eq(f.effort.options.map((o) => o.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  kit.eq(f.permissionMode.options.map((o) => o.value), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  kit.eq(f.model.kind, 'model');
  kit.ok(f.model.options.length > 0, 'model suggestions');
  const x = await env.api('GET', '/providers/codex/settings-schema');
  const g = Object.fromEntries(x.body.fields.map((y) => [y.key, y]));
  kit.eq(g.sandbox.options.map((o) => o.value), ['read-only', 'workspace-write', 'danger-full-access', 'disabled', 'managed']);
  kit.eq(g.bypassApprovalsAndSandbox.kind, 'boolean');
  const n = await env.api('GET', '/providers/gemini/settings-schema');
  kit.eq([n.status, n.body.code], [404, 'PROVIDER_NOT_FOUND']);
});

kit.test('GET settings of a tracked Claude session reads the record; bypass maps to bypassPermissions', async () => {
  const r = await env.api('GET', '/sessions/cl_' + ids.claude + '/settings');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'sessions/session-settings.json');
  kit.eq(r.body.values, { model: 'claude-opus-5-5', effort: null, permissionMode: 'bypassPermissions' });
  kit.eq([r.body.pendingRestart, r.body.canRestartNow, r.body.schemaRevision], [false, true, 1]);
});

kit.test('invalid values answer 422 INVALID_SETTING with the field; nothing is stored', async () => {
  const a = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { effort: 'turbo' } });
  kit.eq([a.status, a.body.code, a.body.field], [422, 'INVALID_SETTING', 'effort']);
  const b = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { sandbox: 'read-only' } });
  kit.eq([b.status, b.body.field], [422, 'sandbox'], 'a Codex key on a Claude session');
  const c = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { model: '-rf' } });
  kit.eq([c.status, c.body.field], [422, 'model'], 'a leading hyphen can never become a flag');
  const d = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: {} });
  kit.eq([d.status, d.body.code], [400, 'INVALID_FIELD']);
  kit.eq(env.store.getSession(rec.id).model, 'claude-opus-5-5');
});

kit.test('PATCH on a tracked Claude session writes the record; null resets', async () => {
  const r = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { effort: 'high', permissionMode: 'acceptEdits' } });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'sessions/session-settings.json');
  const s = env.store.getSession(rec.id);
  kit.eq([s.effort, s.permissionMode, s.bypassPermissions], ['high', 'acceptEdits', false]);
  kit.eq(r.body.pendingRestart, false, 'not live, nothing pending');
  const lo = env.ws.settings.launchOptionsFor('cl_' + ids.claude);
  kit.eq(lo, { model: 'claude-opus-5-5', effort: 'high', permissionMode: 'acceptEdits', bypassPermissions: false, codex: { model: null, reasoningEffort: null, sandbox: null, approvalPolicy: null, bypassApprovalsAndSandbox: null } });
  const z = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { effort: null } });
  kit.eq(z.body.values.effort, null);
});

kit.test('a live session reports pendingRestart until its next start (A14)', async () => {
  const spy = () => fakePty();
  const started = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy });
  kit.eq(started.status, 'spawned', JSON.stringify(started));
  env.chat.internals.index.invalidate();
  const r = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { permissionMode: 'plan' } });
  kit.eq([r.status, r.body.pendingRestart], [200, true]);
  kit.eq(env.ws.settings.pendingRestartFor('cl_' + ids.claude), true);
  env.pm.killSession(rec.id);
  await kit.sleep(100);
  await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy });
  env.chat.internals.index.invalidate();
  const after = await env.api('GET', '/sessions/cl_' + ids.claude + '/settings');
  kit.eq(after.body.pendingRestart, false, 'the next start applied them');
  env.pm.killSession(rec.id);
});

kit.test('restart with settings applies them now, through the phone restart route (A14, PROTOCOL.md 4.5.4)', async () => {
  // Every PTY spawn is recorded and answered by an in memory pseudo terminal,
  // so the relaunch's command line can be read and no CLI process runs (a
  // process under a killed Windows console can outlive it, and the live gate
  // would then rightly refuse the relaunch).
  const lines = [];
  const nodePty = require('node-pty');
  const realSpawn = nodePty.spawn;
  nodePty.spawn = function recordSpawn(file, args) {
    lines.push((Array.isArray(args) ? args : [String(args)]).join(' '));
    let exitFn = null;
    return { pid: 90000 + lines.length, onData() { return { dispose() {} }; }, onExit(fn) { exitFn = fn; return { dispose() {} }; }, write() {}, resize() {}, kill() { if (exitFn) setTimeout(() => exitFn({ exitCode: 0 }), 10); }, on() {} };
  };
  try {
    const started = await env.pm.launchDetached(rec.id, {});
    kit.ok(['spawned', 'attached', 'alreadyRunning'].includes(started.status), JSON.stringify(started));
    env.chat.internals.index.invalidate();
    const p = await env.api('PATCH', '/sessions/cl_' + ids.claude + '/settings', { values: { model: 'claude-sonnet-5', effort: 'xhigh', permissionMode: 'acceptEdits' } });
    kit.eq([p.status, p.body.pendingRestart], [200, true], JSON.stringify(p.body));
    const before = lines.length;
    const r = await env.api('POST', '/sessions/cl_' + ids.claude + '/restart', { clientRequestId: crypto.randomUUID(), when: 'now' });
    kit.eq([r.status, r.body.status], [202, 'restarting'], JSON.stringify(r.body));
    await kit.until(() => lines.slice(before).some((l) => /--model claude-sonnet-5( |$)/.test(l) && /--effort xhigh/.test(l) && /--permission-mode acceptEdits/.test(l)), 15000, 'the relaunch with the new settings: ' + lines.slice(before).join(' | '));
    kit.ok(!lines.slice(before).some((l) => /--dangerously-skip-permissions/.test(l)), 'the old bypass is gone');
    env.chat.internals.index.invalidate();
    await kit.until(async () => (await env.api('GET', '/sessions/cl_' + ids.claude + '/settings')).body.pendingRestart === false, 10000, 'pendingRestart cleared by the new start');
  } finally {
    nodePty.spawn = realSpawn;
    env.pm.killSession(rec.id);
    await kit.sleep(200);
  }
});

kit.test('a discovered Claude session stores in the mobile file; B2 applies it to the store session it creates', async () => {
  const r = await env.api('PATCH', '/sessions/cl_' + ids.disc + '/settings', { values: { model: 'claude-sonnet-5', effort: 'low', permissionMode: 'auto' } });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  const file = path.join(process.env.CWM_DATA_DIR, 'mobile', 'session-settings.json');
  kit.eq(JSON.parse(fs.readFileSync(file, 'utf8')).sessions['cl_' + ids.disc], { model: 'claude-sonnet-5', effort: 'low', permissionMode: 'auto' });
  const wbId = env.chat.internals.launch.ensureStoreSession(env.chat.sessions.resolve('cl_' + ids.disc));
  const s = env.store.getSession(wbId);
  kit.eq([s.model, s.effort, s.permissionMode], ['claude-sonnet-5', 'low', 'auto']);
});

kit.test('Codex settings use the provider bundle, merged; discovered threads use the ad hoc bundle', async () => {
  const r = await env.api('PATCH', '/sessions/cx_' + ids.codex + '/settings', { values: { reasoningEffort: 'high', sandbox: 'workspace-write' } });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  const r2 = await env.api('PATCH', '/sessions/cx_' + ids.codex + '/settings', { values: { approvalPolicy: 'on-request', bypassApprovalsAndSandbox: false } });
  kit.eq(env.store.getSession(codexRec.id).providerSettings.codex, { reasoningEffort: 'high', sandbox: 'workspace-write', approvalPolicy: 'on-request', bypassApprovalsAndSandbox: false });
  kit.eq(r2.body.values.sandbox, 'workspace-write');
  const d = await env.api('PATCH', '/sessions/cx_' + ids.codexDisc + '/settings', { values: { model: 'gpt-6-astra' } });
  kit.eq(d.status, 200, JSON.stringify(d.body));
  kit.eq(env.store.getProviderSessionSettings('codex', ids.codexDisc), { model: 'gpt-6-astra' });
  const lo = env.ws.settings.launchOptionsFor('cx_' + ids.codex);
  kit.eq(lo.codex, { model: null, reasoningEffort: 'high', sandbox: 'workspace-write', approvalPolicy: 'on-request', bypassApprovalsAndSandbox: false });
  const bad = await env.api('PATCH', '/sessions/cx_' + ids.codex + '/settings', { values: { bypassApprovalsAndSandbox: 'yes' } });
  kit.eq([bad.status, bad.body.field], [422, 'bypassApprovalsAndSandbox']);
});

kit.test('a ChatGPT owned thread answers SESSION_READ_ONLY with owner and reason; unknown ids 404', async () => {
  const r = await env.api('PATCH', '/sessions/cx_' + ids.desk + '/settings', { values: { model: 'gpt-6-astra' } });
  kit.eq([r.status, r.body.code, r.body.owner], [409, 'SESSION_READ_ONLY', 'chatgpt']);
  kit.ok(/ChatGPT/.test(r.body.reason), r.body.reason);
  const g = await env.api('GET', '/sessions/cx_' + ids.desk + '/settings');
  kit.eq(g.status, 200, 'reading is allowed');
  const n = await env.api('GET', '/sessions/cl_' + crypto.randomUUID() + '/settings');
  kit.eq([n.status, n.body.code], [404, 'SESSION_NOT_FOUND']);
  kit.ok(env.auditEntries.some((a) => a.action === 'settings'), 'settings changes are audited');
});

kit.run(async () => { if (env) await env.close(); });
