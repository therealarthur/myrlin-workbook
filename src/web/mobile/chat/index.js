/**
 * mountChat: the mobile v2 chat track (B2) wired into B1's router.
 *
 * What: creates the stream hub, the session index, the turn service, the
 * prompt service and answers, the send queue, interrupt, launch, the Codex
 * linker, uploads, slash commands and push triggers; connects them to the
 * PTY manager's taps (P1 to P3) and the hub's subscribe hooks; registers
 * every chat route of PROTOCOL.md 2.10 through router.route; and fills
 * ctx.mobile.hub and ctx.mobile.chat with the members BUILD-CONTRACT 3.4.3
 * promises to B1 and B3.
 *
 * Why: B1's index.js loads this module only if it exists (3.4.1), so all of
 * the chat wiring must hang off this one entry point, and the route list is
 * exported so B1's route table test can compare it with scope-table.js.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const { createHub } = require('../stream/hub');
const { createDiscoveryCache } = require('./discovery-cache');
const { createAgentsPoller } = require('./agents-poller');
const { createSessionIndex } = require('./session-index');
const { createRuntime } = require('./runtime');
const { createPromptService } = require('./prompt-detect');
const { createTurnService } = require('./turn-service');
const { createSendQueue } = require('./send-queue');
const { createInterrupts } = require('./interrupt');
const { createAnswers } = require('./prompt-answer');
const { createLauncher } = require('./launch');
const { createCodexLinker } = require('./codex-linker');
const { createUploads } = require('./uploads');
const { createCommands } = require('./commands');
const { createPushTriggers } = require('./push-triggers');
const { createRecent } = require('./recent');
const { createPartRoutes } = require('./part-routes');
const reader = require('./transcript-reader');
const { sendJson, errorBody, jsonBody, readBody, warn, log } = require('./common');

/** Upload chunk bodies may be up to 16 MiB (PROTOCOL.md 4.10). */
const CHUNK_BODY_MAX = 16 * 1024 * 1024;

/** Every chat route B2 registers: [method, path] relative to /api/m/v2 (PROTOCOL.md 2.10). */
const CHAT_ROUTES = Object.freeze([
  ['GET', '/sessions/recent'],
  ['GET', '/sessions/:sessionId'],
  ['GET', '/sessions/:sessionId/messages'],
  ['GET', '/sessions/:sessionId/messages/:messageId/parts/:partIndex/text'],
  ['GET', '/sessions/:sessionId/messages/:messageId/parts/:partIndex/content'],
  ['POST', '/sessions/:sessionId/send'],
  ['GET', '/sessions/:sessionId/sends'],
  ['DELETE', '/sessions/:sessionId/sends/:clientMessageId'],
  ['POST', '/sessions/:sessionId/interrupt'],
  ['GET', '/sessions/:sessionId/prompts'],
  ['POST', '/sessions/:sessionId/prompts/:promptId/answer'],
  ['POST', '/sessions/:sessionId/restart'],
  ['POST', '/sessions/:sessionId/stop'],
  ['POST', '/sessions/:sessionId/continue-here'],
  ['POST', '/sessions/:sessionId/resume-anyway'],
  ['POST', '/sessions/:sessionId/branch'],
  ['GET', '/sessions/:sessionId/commands'],
  ['POST', '/sessions'],
  ['POST', '/uploads'],
  ['GET', '/uploads/:uploadId'],
  ['PUT', '/uploads/:uploadId/chunks'],
  ['POST', '/uploads/:uploadId/complete'],
  ['DELETE', '/uploads/:uploadId'],
  ['GET', '/uploads/:uploadId/content'],
]);

/**
 * Path parameters of a request: B1's req.params, else matched here.
 * @param {string} pattern
 * @param {object} req
 * @returns {object}
 */
function paramsOf(pattern, req) {
  if (req.params && typeof req.params === 'object' && Object.keys(req.params).length) return req.params;
  let p = '';
  try { p = new URL(req.url, 'http://x').pathname; } catch (_) { p = ''; }
  p = p.replace(/^\/api\/m\/v2/, '');
  const a = pattern.split('/');
  const b = p.split('/');
  const out = {};
  if (a.length !== b.length) return out;
  a.forEach((seg, i) => { if (seg.startsWith(':')) { try { out[seg.slice(1)] = decodeURIComponent(b[i]); } catch (_) { out[seg.slice(1)] = b[i]; } } });
  return out;
}

/**
 * Query of a request: B1's req.query, else parsed here.
 * @param {object} req
 * @returns {object}
 */
function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch (_) { return {}; }
}

/**
 * Whether the VT sidecar screen model is available (PROTOCOL.md 1.6).
 * @returns {boolean}
 */
function screenModelAvailable() {
  try {
    const vt = require('../../vt-sidecar');
    return vt.isSidecarEnabled() && vt.getVtSidecarAvailability().available;
  } catch (_) { return false; }
}

/**
 * Mount the chat track.
 * @param {object} router - B1's router ({route(method, path, handler)}) or null
 * @param {object} ctx - the mobile context (BUILD-CONTRACT 3.4.1)
 * @param {object} [options] - test seams: {hub, agents, now, timings, uploadsRoot, homeDir}
 * @returns {object} ctx.mobile.chat
 */
function mountChat(router, ctx, options = {}) {
  ctx.mobile = ctx.mobile || {};
  const now = options.now || Date.now;
  const hub = createHub(ctx, Object.assign({}, options.hub || {}));
  ctx.mobile.hub = hub;
  const discovery = options.discovery || createDiscoveryCache({ registry: ctx.registry });
  const agents = options.agents || createAgentsPoller();
  const index = createSessionIndex({ ctx, discovery, agents, now });
  const runtime = createRuntime({ ctx, index, now });
  const caps = () => ({ screenModel: screenModelAvailable(), codexLinker: true, branchFromMessage: [] });
  let turns;
  let prompts;
  let sends;
  let interrupts;
  let launch;
  let linker;
  let uploads;
  prompts = createPromptService({ ctx, index, now, lazy: { turns: () => turns } });
  turns = createTurnService({ ctx, index, agents, now, checkTickMs: options.checkTickMs, lazy: { sends: () => sends, prompts: () => prompts, interrupts: () => interrupts } });
  index.setStateSource((id) => turns.stateOf(id));
  sends = createSendQueue({ ctx, index, runtime, now, timings: options.timings, lazy: { turns: () => turns, prompts: () => prompts, launch: () => launch, uploads: () => uploads, agents: () => agents } });
  interrupts = createInterrupts({ ctx, index, runtime, now, lazy: { turns: () => turns, prompts: () => prompts, launch: () => launch } });
  const answers = createAnswers({ ctx, index, runtime, now, timings: options.answerTimings, lazy: { prompts: () => prompts, interrupts: () => interrupts } });
  linker = createCodexLinker({ ctx, index, now });
  launch = createLauncher({ ctx, index, now, lazy: { turns: () => turns, sends: () => sends, linker: () => linker, capabilities: caps } });
  uploads = createUploads({ ctx, now, uploadsRoot: options.uploadsRoot, lazy: { sends: () => sends } });
  const commands = createCommands({ homeDir: options.homeDir, now });
  const pushes = createPushTriggers({ ctx, index, prompts, turns });
  const recent = createRecent({ ctx, index, turns: () => turns, prompts: () => prompts, sends: () => sends });
  const parts = createPartRoutes({ ctx, index, sends: () => sends });

  // Screens feed prompts, turns and the send pumps.
  runtime.onScreen((sessionId, cls) => {
    prompts.onClassified(sessionId, cls);
    turns.onScreen(sessionId, cls);
  });
  hub.setSessionResolver((sid) => !!index.resolve(sid));
  const unsubs = [];
  unsubs.push(hub.onSubscribe((topic) => { if (topic.startsWith('session:')) turns.watch(topic.slice(8), 'subscriber'); }));
  unsubs.push(hub.onUnsubscribe((topic) => { if (topic.startsWith('session:')) turns.unwatch(topic.slice(8), 'subscriber'); }));

  // PTY taps (pty-manager P1 to P3).
  const pm = typeof ctx.getPtyManager === 'function' ? ctx.getPtyManager() : null;
  const onSpawn = (wbId) => {
    index.invalidate();
    const phoneId = index.idForWorkbookSession(wbId);
    if (!phoneId) return;
    runtime.readerFor(wbId);
    turns.watch(phoneId, 'hosted');
    index.noteChanged(phoneId, 'updated');
  };
  if (pm && typeof pm.onSessionData === 'function') {
    unsubs.push(pm.onSessionData((wbId) => runtime.onPtyData(wbId)));
    unsubs.push(pm.onSessionSpawn(onSpawn));
    unsubs.push(pm.onSessionExit((wbId, code) => {
      const phoneId = index.idForWorkbookSession(wbId);
      turns.onPtyExit(wbId, code);
      if (phoneId) prompts.onExit(phoneId);
      runtime.onPtyExit(wbId);
      index.invalidate();
      if (phoneId) { index.noteChanged(phoneId, 'updated'); turns.unwatch(phoneId, 'hosted'); }
    }));
    try { for (const [wbId, s] of pm.sessions) if (s.alive) onSpawn(wbId); } catch (_) { /* no sessions yet */ }
  }
  if (ctx.mobile.devices && typeof ctx.mobile.devices.onRevoked === 'function') {
    unsubs.push(ctx.mobile.devices.onRevoked((deviceId) => { sends.cancelDevice(deviceId); uploads.cancelDevice(deviceId); }));
  }

  /**
   * Wrap a route: parse, call, answer JSON or the error body.
   * @param {string} pattern
   * @param {(req: object, p: object, q: object, who: object, res: object) => Promise<*>} fn
   * @returns {Function}
   */
  const handler = (pattern, fn) => async (req, res, auth) => {
    try {
      const who = { deviceId: auth && auth.deviceId ? auth.deviceId : null, scopes: auth && auth.scopes ? auth.scopes : [] };
      const out = await fn(req, paramsOf(pattern, req), queryOf(req), who, res);
      if (out === undefined || res.headersSent) return;
      sendJson(res, out.status || 200, out.body);
    } catch (err) {
      if (!(err && typeof err.status === 'number')) warn('chat route failed', pattern, err && err.message);
      const e = errorBody(err);
      if (!res.headersSent) sendJson(res, e.status, e.body);
    }
  };
  const body = async (req) => {
    const b = await jsonBody(req);
    if (b && b.__invalidJson) { const E = require('./common').errorClass(ctx); throw new E(400, 'INVALID_JSON', 'The request body is not JSON.'); }
    return b || {};
  };
  const ok = (b, status) => ({ status: status || 200, body: b });
  const requireSession = (sid) => { const r = index.resolve(sid); if (!r) { const E = require('./common').errorClass(ctx); throw new E(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.'); } return r; };

  const routes = {
    'GET /sessions/recent': async (req, p, q) => ok(recent.recent(q)),
    'GET /sessions/:sessionId': async (req, p) => ok(recent.detail(p.sessionId)),
    'GET /sessions/:sessionId/messages': async (req, p, q) => { const page = parts.messages(p.sessionId, q); delete page._bytesRead; return ok(page); },
    'GET /sessions/:sessionId/messages/:messageId/parts/:partIndex/text': async (req, p, q) => ok(parts.partText(p.sessionId, p.messageId, p.partIndex, q)),
    'GET /sessions/:sessionId/messages/:messageId/parts/:partIndex/content': async (req, p, q, who, res) => {
      const c = parts.partContent(p.sessionId, p.messageId, p.partIndex);
      res.statusCode = 200;
      res.setHeader('Content-Type', c.mediaType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', c.bytes.length);
      res.end(c.bytes);
      return undefined;
    },
    'POST /sessions/:sessionId/send': async (req, p, q, who) => { const r = sends.accept(p.sessionId, await body(req), who); return ok(r.send, r.status); },
    'GET /sessions/:sessionId/sends': async (req, p) => { const r = requireSession(p.sessionId); return ok({ sends: sends.list(r.sessionId) }); },
    'DELETE /sessions/:sessionId/sends/:clientMessageId': async (req, p, q, who) => { const r = requireSession(p.sessionId); return ok(sends.cancel(r.sessionId, p.clientMessageId, who.deviceId)); },
    'POST /sessions/:sessionId/interrupt': async (req, p, q, who) => ok(await interrupts.interrupt(p.sessionId, await body(req), who)),
    'GET /sessions/:sessionId/prompts': async (req, p) => { const r = requireSession(p.sessionId); return ok({ prompts: prompts.openFor(r.sessionId), streamEpoch: hub.epoch, streamSeq: hub.currentSeq('session:' + r.sessionId) }); },
    'POST /sessions/:sessionId/prompts/:promptId/answer': async (req, p, q, who) => ok(await answers.answer(p.sessionId, p.promptId, await body(req), who)),
    'POST /sessions/:sessionId/restart': async (req, p, q, who) => ok(await launch.restart(p.sessionId, await body(req), who), 202),
    'POST /sessions/:sessionId/stop': async (req, p, q, who) => ok(await launch.stop(p.sessionId, await body(req), who)),
    'POST /sessions/:sessionId/continue-here': async (req, p, q, who) => ok(await launch.continueHere(p.sessionId, await body(req), who), 201),
    'POST /sessions/:sessionId/resume-anyway': async (req, p, q, who) => ok(launch.resumeAnyway(p.sessionId, await body(req), who)),
    'POST /sessions/:sessionId/branch': async (req, p, q, who) => ok(await launch.branch(p.sessionId, await body(req), who), 201),
    'GET /sessions/:sessionId/commands': async (req, p) => { const r = requireSession(p.sessionId); return ok({ sessionId: r.sessionId, provider: r.provider, commands: commands.listFor(r.provider, r.workingDir), generatedAtMs: now() }); },
    'POST /sessions': async (req, p, q, who) => ok(await launch.createSession(await body(req), who), 201),
    'POST /uploads': async (req, p, q, who) => ok(uploads.create(await body(req), who.deviceId), 201),
    'GET /uploads/:uploadId': async (req, p, q, who) => ok(uploads.get(p.uploadId, who.deviceId)),
    'PUT /uploads/:uploadId/chunks': async (req, p, q, who) => {
      let buf;
      try { buf = await readBody(req, CHUNK_BODY_MAX); } catch (err) { const E = require('./common').errorClass(ctx); throw new E(413, 'BODY_TOO_LARGE', 'A chunk is at most 16 MiB.'); }
      return ok(uploads.writeChunk(p.uploadId, who.deviceId, Number(q.offset), buf));
    },
    'POST /uploads/:uploadId/complete': async (req, p, q, who) => ok(uploads.complete(p.uploadId, who.deviceId, await body(req))),
    'DELETE /uploads/:uploadId': async (req, p, q, who, res) => { uploads.remove(p.uploadId, who.deviceId); res.statusCode = 204; res.setHeader('Cache-Control', 'no-store'); res.end(); return undefined; },
    'GET /uploads/:uploadId/content': async (req, p, q, who, res) => {
      const c = uploads.contentOf(p.uploadId, who.deviceId);
      res.statusCode = 200;
      res.setHeader('Content-Type', c.mediaType);
      res.setHeader('Content-Length', c.size);
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(c.file).pipe(res);
      return undefined;
    },
  };

  if (router && typeof router.route === 'function') {
    for (const [method, pattern] of CHAT_ROUTES) {
      const fn = routes[method + ' ' + pattern];
      router.route(method, pattern, handler(pattern, fn));
    }
  } else {
    warn('chat mounted without a router; routes are not served');
  }

  const chat = {
    routes: CHAT_ROUTES,
    capabilities: caps,
    sessions: {
      resolve: (id) => index.resolve(id),
      list: () => index.list({ includeArchived: true }),
      summary: (id) => index.summary(id),
      meta: (id) => index.meta(id, turns.metaExtra(id)),
      onChanged: (fn) => index.onChanged(fn),
      noteChanged: (id, change) => index.noteChanged(id, change),
      setHandedOff: (id, info) => { index.setHandedOff(id, info); if (info) sends.cancelSession(id, 'HANDED_OFF'); turns.publishMeta(id); },
      handoffOf: (id) => index.handoffOf(id),
    },
    turns: { stateOf: (id) => turns.stateOf(id), onTurn: (fn) => turns.onTurn(fn), turnOf: (id) => turns.turnOf(id) },
    prompts: { openFor: (id) => prompts.openFor(id), answer: (id, promptId, req, who) => answers.answer(id, promptId, req, who || { deviceId: null }) },
    sends: { enqueueSystem: (id, text, o) => sends.enqueueSystem(id, text, o) },
    launch: { start: (id, o) => launch.start(id, o), createSession: (o, who) => launch.createSession(o, who || { deviceId: null }), restart: (id, o) => launch.restart(id, o || {}, { deviceId: null }), stop: (id, o) => launch.stop(id, o || {}, { deviceId: null }) },
    readTranscriptRange: (id, o) => { const r = index.resolve(id); if (!r || !r.transcriptPath) return (async function* empty() {})(); return reader.readRange(r.transcriptPath, (o && o.fromOffset) || 0, o && o.toOffset); },
    onProviderChange: (providerId) => discovery.onProviderChange(providerId),
    internals: { hub, index, runtime, prompts, turns, sends, interrupts, answers, launch, linker, uploads, commands, pushes, discovery, agents },
    stop() {
      for (const u of unsubs.splice(0)) { try { u(); } catch (_) {} }
      turns.stopAll();
      agents.stop();
      linker.stop();
      uploads.stop();
      pushes.stop();
      runtime.dispose();
      hub.close();
    },
  };
  ctx.mobile.chat = chat;
  discovery.refresh().catch(() => {});
  log('chat mounted with ' + CHAT_ROUTES.length + ' routes');
  return chat;
}

module.exports = { mountChat, CHAT_ROUTES, paramsOf };
