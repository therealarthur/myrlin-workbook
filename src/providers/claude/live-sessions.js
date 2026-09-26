/**
 * Claude live-session lookup: is this transcript running right now,
 * outside the Workbook PTY that is about to open it?
 *
 * WHY (2026-09-26): opening a Workbook pane for a Claude session spawns
 * `claude --resume <transcriptId>`. When that transcript belongs to a
 * Claude Code BACKGROUND session (`claude --bg`), the resume does not join
 * it; it FORKS it: a second process appends to the same conversation while
 * the background one keeps running. The same happens for a session that is
 * open in an interactive terminal on the PC. This module answers the
 * question before anything is spawned:
 *
 *   - background match  -> attach to it (`claude attach <shortId>`)
 *   - interactive match -> tell the user, spawn nothing until they confirm
 *   - no match          -> resume as before
 *   - lookup failed     -> FAIL SAFE: if the transcript was seen live
 *                          recently (persisted marker) or the record says it
 *                          is live, tell the user and spawn nothing; only an
 *                          unmarked transcript falls back to resume.
 *
 * The source of truth is `claude agents --json`, which prints the active
 * sessions as a JSON array:
 *   background:  {id: "<8-char short id>", sessionId, name, cwd, kind: "background", state, status, pid}
 *   interactive: {pid, sessionId, name, cwd, kind: "interactive", status}
 *
 * The CLI is resolved without relying on the caller's PATH, because the
 * Workbook runs as a Scheduled Task (S4U) whose PATH can differ from an
 * interactive shell's: an explicit override, then PATH order (the same order
 * cmd.exe would use for the pane), then the well-known install locations
 * (native installer, the npm package's own claude.exe behind the npm shim,
 * the npm shim itself). An npm shim is mapped to the claude.exe it wraps so
 * no cmd.exe layer is needed; only a shim with no resolvable target is run
 * through `cmd.exe /d /s /c`.
 *
 * Results are cached for CACHE_TTL_MS (failures for FAILURE_TTL_MS) and
 * concurrent callers share one in-flight process, so restoring ten panes
 * after a Workbook restart costs one `claude agents` run, not ten.
 *
 * Everything with a side effect (exec, fs, clock) is injectable so the unit
 * tests never run the real CLI.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/claude/live-sessions
 */

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Hard ceiling for one `claude agents --json` run. */
const LOOKUP_TIMEOUT_MS = 5000;
/** How long a successful listing is reused. */
const CACHE_TTL_MS = 10000;
/** How long a failed listing is reused (short, so a retry soon re-asks). */
const FAILURE_TTL_MS = 2000;
/**
 * Floor for `fresh` re-asks: a listing younger than this is reused even when
 * a fresh one is requested. It bounds how stale a "not live" answer can be
 * when it decides a spawn, and rate-limits bursts of re-checks.
 */
const FRESH_REUSE_MS = 1000;
/** How long resolved binary paths are reused before probing again. */
const CANDIDATE_TTL_MS = 5 * 60 * 1000;
/**
 * How long a transcript seen live stays "recently live" for the fail-safe.
 * A successful listing replaces the whole marker set, so this window only
 * matters while listings keep failing; it is generous on purpose because a
 * false notice costs one click and a false resume forks a live session.
 */
const SEEN_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** stdout ceiling for the listing (a few KB in practice). */
const MAX_BUFFER = 4 * 1024 * 1024;
/**
 * Background short ids are 8 hex chars today. The pattern is wider so a
 * future id format still attaches, but it stays shell-inert: the id is
 * joined into the pane's `cmd.exe /c` / `sh -c` command line.
 */
const SHORT_ID_RE = /^[A-Za-z0-9]{4,32}$/;
/** Same validation spawn.js applies to transcript ids. */
const TRANSCRIPT_ID_RE = /^[a-zA-Z0-9_-]+$/;
/** Characters cmd.exe would interpret inside a quoted path. */
const CMD_UNSAFE_PATH_RE = /["%^&|<>!\r\n]/;
/** Record status values that mean "live outside this pane" (fail-safe input). */
const LIVE_RECORD_STATUSES = new Set(['live-bg', 'live-terminal']);
/** File (under the Workbook data dir) that persists the seen-live markers. */
const SEEN_LIVE_FILE = 'claude-live-seen.json';

/**
 * Default existence probe: a regular file at p.
 * @param {string} p
 * @returns {boolean}
 */
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/**
 * Compare two transcript ids. Claude writes lowercase UUIDs; compare
 * case-insensitively so a record that stored an uppercased id still matches.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameTranscriptId(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve the Claude CLI binary to execute for the lookup.
 *
 * Order: CWM_CLAUDE_BIN override, PATH order (per directory the platform's
 * executable extensions), then well-known install locations. A Windows npm
 * shim (claude.cmd) is mapped to the claude.exe it wraps when that exists.
 *
 * @param {Object} [opts]
 * @param {Object<string,string>} [opts.env=process.env]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.homedir=os.homedir()]
 * @param {function(string):boolean} [opts.exists=fileExists]
 * @returns {Array<{path: string, viaCmd: boolean, source: string}>} Ordered, de-duplicated candidates (may be empty).
 */
function resolveClaudeCandidates({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  exists = fileExists,
} = {}) {
  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;
  const out = [];
  const seen = new Set();
  const getEnv = (name) => {
    if (!env) return undefined;
    if (env[name] !== undefined) return env[name];
    if (!isWin) return undefined;
    // Windows env names are case-insensitive (Path vs PATH).
    const key = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase());
    return key ? env[key] : undefined;
  };

  /** npm shim -> the claude.exe it runs (node_modules/@anthropic-ai/claude-code/bin/claude.exe). */
  const shimTarget = (shimPath) => p.join(p.dirname(shimPath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

  const add = (candidatePath, source) => {
    if (!candidatePath || typeof candidatePath !== 'string') return;
    let resolved = candidatePath;
    let viaCmd = false;
    let src = source;
    const lower = resolved.toLowerCase();
    if (isWin && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
      const target = shimTarget(resolved);
      if (exists(target)) {
        resolved = target;
        src = source + ':shim-target';
      } else {
        viaCmd = true;
        // A path cmd.exe would reinterpret cannot be quoted safely; skip it.
        if (CMD_UNSAFE_PATH_RE.test(resolved)) return;
      }
    }
    const key = isWin ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    if (!exists(resolved)) return;
    seen.add(key);
    out.push({ path: resolved, viaCmd, source: src });
  };

  // 1. Explicit override.
  const override = getEnv('CWM_CLAUDE_BIN');
  if (override) add(override, 'env:CWM_CLAUDE_BIN');

  // 2. PATH order, the way the pane's shell would resolve `claude`.
  const pathVar = getEnv('PATH') || '';
  const dirs = pathVar.split(isWin ? ';' : ':').map(d => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    // A UNC PATH entry would make these synchronous probes wait on the network.
    .filter(d => !(isWin && d.startsWith('\\\\')));
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) add(p.join(dir, 'claude' + ext), 'path');
  }

  // 3. Well-known locations, for a PATH that lacks them (S4U tasks, services).
  if (isWin) {
    const home = getEnv('USERPROFILE') || homedir;
    const appData = getEnv('APPDATA') || (home ? p.join(home, 'AppData', 'Roaming') : null);
    const localAppData = getEnv('LOCALAPPDATA') || (home ? p.join(home, 'AppData', 'Local') : null);
    const npmPrefixes = [];
    if (getEnv('npm_config_prefix')) npmPrefixes.push(getEnv('npm_config_prefix'));
    if (appData) npmPrefixes.push(p.join(appData, 'npm'));
    if (homedir) npmPrefixes.push(p.join(homedir, 'AppData', 'Roaming', 'npm'));
    if (home) add(p.join(home, '.local', 'bin', 'claude.exe'), 'native');
    if (homedir) add(p.join(homedir, '.local', 'bin', 'claude.exe'), 'native');
    for (const prefix of npmPrefixes) {
      add(p.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'npm-exe');
    }
    if (localAppData) add(p.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'), 'winget');
    for (const prefix of npmPrefixes) add(p.join(prefix, 'claude.cmd'), 'npm-shim');
  } else {
    const home = getEnv('HOME') || homedir;
    if (home) {
      add(p.join(home, '.local', 'bin', 'claude'), 'native');
      add(p.join(home, '.claude', 'local', 'claude'), 'native-local');
      add(p.join(home, '.npm-global', 'bin', 'claude'), 'npm-global');
    }
    add('/opt/homebrew/bin/claude', 'homebrew');
    add('/usr/local/bin/claude', 'usr-local');
  }
  return out;
}

/**
 * Find the listing inside output that has other text around it (an update
 * banner, a "[warn] ..." line). Tries each '[' in order and takes the first
 * span, balanced with a string-aware bracket walk, that parses as an array of
 * objects (or an empty array). A bracket inside a banner therefore cannot hide
 * the real listing.
 *
 * @param {string} text
 * @returns {Array|null}
 */
function findJsonArray(text) {
  let attempts = 0;
  for (let start = text.indexOf('['); start !== -1 && attempts < 64; start = text.indexOf('[', start + 1)) {
    attempts++;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
        if (depth < 0) break;
      }
    }
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed) && parsed.every(x => x && typeof x === 'object' && !Array.isArray(x))) return parsed;
    } catch (_) { /* try the next '[' */ }
  }
  return null;
}

/**
 * Parse `claude agents --json` stdout into normalized entries.
 * Tolerates a banner or warning line around the array by falling back to
 * the outermost [...] span. Throws when no JSON array can be found.
 *
 * @param {string} stdout
 * @returns {Array<{kind: string, sessionId: string, shortId: (string|null), pid: (number|null), name: (string|null), cwd: (string|null), status: (string|null), state: (string|null)}>}
 */
function parseAgentsJson(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = findJsonArray(text);
    if (data === null) throw new Error('claude agents --json printed no JSON array');
  }
  if (!Array.isArray(data)) throw new Error('claude agents --json did not print an array');
  const entries = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId) continue;
    const kind = typeof raw.kind === 'string' ? raw.kind : 'unknown';
    entries.push({
      kind,
      sessionId: raw.sessionId,
      shortId: (kind === 'background' && typeof raw.id === 'string') ? raw.id : null,
      pid: Number.isFinite(raw.pid) ? raw.pid : null,
      name: typeof raw.name === 'string' ? raw.name : null,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      status: typeof raw.status === 'string' ? raw.status : null,
      state: typeof raw.state === 'string' ? raw.state : null,
    });
  }
  return entries;
}

/**
 * Make sure the lookup process can find the account's real ~/.claude.
 *
 * WHY: the CLI resolves its config home from the profile variables. Measured
 * on 2026-09-26: with the variables missing it still finds the right home,
 * but with USERPROFILE pointing somewhere else it bootstraps a brand-new,
 * empty config there (review debris: a "UsersArthur\.claude" tree in the
 * working directory) and prints `[]`, which reads as "nothing is live". This
 * fills only MISSING variables from the account home, so the lookup resolves
 * the same home the pane processes do; a present value is never overridden
 * (a lookup that disagreed with the panes about the home would be worse).
 * The blind-listing check in createLiveSessionLookup covers the rest.
 *
 * @param {Object<string,string>} env - Copy of the environment (mutated and returned).
 * @param {{platform: string, homedir: string}} o
 * @returns {Object<string,string>}
 */
function withProfileEnv(env, { platform, homedir }) {
  if (!homedir) return env;
  if (platform === 'win32') {
    const has = (name) => Object.keys(env).some(k => k.toUpperCase() === name && env[k]);
    if (!has('USERPROFILE')) env.USERPROFILE = homedir;
    const m = /^([A-Za-z]:)(\\.*)?$/.exec(homedir);
    if (m && !has('HOMEDRIVE')) env.HOMEDRIVE = m[1];
    if (m && !has('HOMEPATH')) env.HOMEPATH = m[2] || '\\';
    if (!has('APPDATA')) env.APPDATA = path.win32.join(homedir, 'AppData', 'Roaming');
    if (!has('LOCALAPPDATA')) env.LOCALAPPDATA = path.win32.join(homedir, 'AppData', 'Local');
    if (!has('SYSTEMROOT')) env.SystemRoot = 'C:\\WINDOWS';
  } else if (!env.HOME) {
    env.HOME = homedir;
  }
  return env;
}

/**
 * Kill a lookup child that overran its deadline. Targets the child's own
 * PID (and, on Windows, its tree, so a cmd.exe shim's claude.exe goes too).
 * Never a name-based kill.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {string} platform
 * @param {Function} execFileImpl
 */
function killLookupChild(child, platform, execFileImpl) {
  if (!child) return;
  try {
    if (platform === 'win32' && Number.isInteger(child.pid)) {
      execFileImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) { /* already gone */ }
}

/**
 * Run `claude agents --json` once with one candidate binary.
 *
 * @param {{path: string, viaCmd: boolean}} bin
 * @param {Object} opts
 * @param {number} opts.timeoutMs
 * @param {Object<string,string>} opts.env
 * @param {string} opts.platform
 * @param {Function} opts.execFileImpl - child_process.execFile compatible.
 * @param {string} [opts.cwd] - Working directory for the CLI (the account home in production).
 * @returns {Promise<{ok: true, entries: Array}|{ok: false, error: string, detail: string}>}
 */
function runAgentsJsonOnce(bin, { timeoutMs, env, platform, execFileImpl, cwd = undefined }) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Our own deadline (instead of execFile's timeout option) so an overrun
    // resolves on time even while the kill is still in flight, and so the
    // kill can take the whole tree when a cmd.exe shim sits in between.
    // Not unref'd: someone is awaiting this answer, so the deadline must fire
    // even when nothing else holds the event loop open.
    const timer = setTimeout(() => {
      killLookupChild(child, platform, execFileImpl);
      finish({ ok: false, error: 'timeout', detail: 'no answer within ' + timeoutMs + ' ms' });
    }, timeoutMs);

    const onDone = (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EINVAL') {
          finish({ ok: false, error: 'not-found', detail: err.code + ' ' + bin.path });
        } else {
          finish({ ok: false, error: 'exit-code', detail: String(err.code != null ? err.code : err.message) });
        }
        return;
      }
      try {
        finish({ ok: true, entries: parseAgentsJson(stdout) });
      } catch (parseErr) {
        finish({ ok: false, error: 'bad-json', detail: parseErr.message });
      }
    };

    try {
      if (bin.viaCmd) {
        // cmd.exe /d /s /c ""<shim>" agents --json": /s strips the outer
        // quotes, the inner pair keeps a path with spaces whole. The path was
        // screened for cmd metacharacters in resolveClaudeCandidates.
        const comspec = (env && (env.ComSpec || env.COMSPEC)) || 'cmd.exe';
        child = execFileImpl(comspec, ['/d', '/s', '/c', '""' + bin.path + '" agents --json"'], {
          env, cwd, windowsHide: true, windowsVerbatimArguments: true, maxBuffer: MAX_BUFFER,
        }, onDone);
      } else {
        child = execFileImpl(bin.path, ['agents', '--json'], {
          env, cwd, windowsHide: true, maxBuffer: MAX_BUFFER,
        }, onDone);
      }
      // `agents --json` never reads stdin; close it so nothing can wait on it.
      try { if (child && child.stdin) child.stdin.end(); } catch (_) {}
    } catch (err) {
      finish({ ok: false, error: 'not-found', detail: err.message });
    }
  });
}

/**
 * Persisted "seen live" markers: the set of transcript ids the last
 * successful listing reported, with when and how. Survives a Workbook
 * restart so pane restore can still fail safe if the first listing after
 * the restart fails.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.filePath] - JSON file; null keeps it in memory only.
 * @returns {{get: function(string): (Object|null), replaceFrom: function(Array, number): void, all: function(): Object}}
 */
function createSeenLiveStore({ filePath = null } = {}) {
  let map = null;
  let lastWritten = null;
  const load = () => {
    if (map) return;
    map = {};
    if (!filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        map = parsed.sessions;
      }
    } catch (_) { /* missing or corrupt: start empty */ }
    lastWritten = JSON.stringify(map);
  };
  const persist = () => {
    if (!filePath) return;
    const body = JSON.stringify(map);
    if (body === lastWritten) return;
    const tmp = filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: map }, null, 2));
      fs.renameSync(tmp, filePath);
      lastWritten = body;
    } catch (err) {
      // The in-memory markers still work; only surviving a restart is lost.
      console.warn('[claude-live] could not persist seen-live markers: ' + err.message);
      appendDecisionLog('seen-live markers not persisted: ' + err.message);
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    }
  };
  return {
    /** Marker for one transcript id, or null. */
    get(transcriptId) {
      load();
      if (!transcriptId) return null;
      const key = Object.keys(map).find(k => sameTranscriptId(k, transcriptId));
      return key ? map[key] : null;
    },
    /**
     * Replace the marker set with what a successful listing reported. A
     * listing is authoritative for every id: anything it no longer lists is
     * no longer live, so it is dropped rather than left to age out.
     */
    replaceFrom(entries, at) {
      load();
      const next = {};
      for (const e of entries || []) {
        if (!e || !e.sessionId) continue;
        // Keep only the marker fields; if a transcript is listed twice
        // (bg + a terminal on it) the background entry wins.
        if (next[e.sessionId] && next[e.sessionId].kind === 'background') continue;
        next[e.sessionId] = {
          kind: e.kind,
          liveState: e.kind === 'background' ? 'live-bg' : 'live-terminal',
          shortId: e.shortId || null,
          name: e.name || null,
          // The folder it runs in, so a failed lookup can still fail safe
          // for a --continue command in the same folder.
          cwd: e.cwd || null,
          at,
        };
      }
      // Keep `at` stable for unchanged entries so the file is not rewritten
      // every 10 s while nothing changes.
      for (const [k, v] of Object.entries(next)) {
        const prev = map[k];
        if (prev && prev.kind === v.kind && prev.shortId === v.shortId && prev.name === v.name
            && Number.isFinite(prev.at) && at - prev.at < SEEN_LIVE_WINDOW_MS / 2) {
          v.at = prev.at;
        }
      }
      map = next;
      persist();
    },
    /** Snapshot (for diagnostics and tests). */
    all() { load(); return { ...map }; },
  };
}

/**
 * Read a resume target out of a custom session command, for records whose
 * `command` is not the bare CLI (for example "claude --resume <id>" or
 * "claude --continue"). Those commands bypass the provider descriptor, so
 * without this they would resume, and fork, a live session unchecked.
 *
 * Forms understood: --resume <id>, --resume=<id>, -r <id>, -r<id>, -r=<id>,
 * short clusters such as -cr<id> (commander expands them letter by letter:
 * -c, then -r taking the rest), --continue / -c, and three forms whose
 * conversation is chosen only when the CLI starts: a bare --resume / -r (the
 * resume picker), --from-pr, and a cluster that ends in r with no value.
 * Those come back as `unknownResume`, and the gate treats them like
 * --continue with an unknown target.
 *
 * @param {string} command - The session's command line (already shell-screened).
 * @param {string} [cliBinary='claude'] - The provider's CLI name.
 * @returns {{resumeId: (string|null), continueInCwd: boolean, unknownResume: boolean, fork: boolean}|null}
 *   null when the command is not this CLI at all. `fork` is true for an
 *   explicit --fork-session (a new session id by the user's own choice).
 */
function parseResumeCommand(command, cliBinary = 'claude') {
  if (typeof command !== 'string') return null;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const base = tokens[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (base !== String(cliBinary).toLowerCase()) return null;
  let resumeId = null;
  let continueInCwd = false;
  let unknownResume = false;
  let fork = false;
  // Value of an option that takes one: attached ("rest") or the next token.
  const takeValue = (rest, i) => {
    if (rest) return { value: rest, used: 0 };
    const next = tokens[i + 1];
    if (next && !next.startsWith('-')) return { value: next, used: 1 };
    return { value: null, used: 0 };
  };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--fork-session') {
      fork = true;
    } else if (t === '--continue') {
      continueInCwd = true;
    } else if (t === '--resume' || t.startsWith('--resume=')) {
      const v = takeValue(t.startsWith('--resume=') ? t.slice('--resume='.length) : '', i);
      i += v.used;
      if (v.value) resumeId = v.value; else unknownResume = true;
    } else if (t === '--from-pr' || t.startsWith('--from-pr=')) {
      // Resumes whatever session is linked to a PR: target unknown here.
      unknownResume = true;
      if (t === '--from-pr') i += takeValue('', i).used;
    } else if (/^-[A-Za-z]/.test(t)) {
      // Short option or cluster: walk the letters the way commander does.
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (ch === 'c') { continueInCwd = true; continue; }
        if (ch === 'r') {
          const v = takeValue(t.slice(k + 1).replace(/^=/, ''), i);
          i += v.used;
          if (v.value) resumeId = v.value; else unknownResume = true;
          break;
        }
        if (!/[A-Za-z]/.test(ch)) break;
      }
    }
  }
  if (fork) return { resumeId: null, continueInCwd: false, unknownResume: false, fork: true };
  if (resumeId && !TRANSCRIPT_ID_RE.test(resumeId)) { resumeId = null; unknownResume = true; }
  return {
    resumeId,
    continueInCwd: !resumeId && continueInCwd,
    unknownResume: !resumeId && unknownResume,
    fork: false,
  };
}

/** Claude Code cuts project folder names at this length and appends a hash. */
const PROJECT_DIR_NAME_MAX = 200;
/** How long a newest-transcript answer is reused for the same folder. */
const NEWEST_MEMO_MS = 2000;
const newestMemo = new Map(); // key -> { at, value }

/**
 * The Claude project folders that can hold `cwd`'s transcripts, the way the
 * CLI names them: every character outside [A-Za-z0-9] becomes '-', and a
 * name longer than 200 characters is cut to 200 plus '-' and a hash (the
 * hash is not reproduced here; any folder with that prefix counts). The real
 * path of `cwd` is tried as well. Exact names win; a case-insensitive match
 * is used only where the file system ignores case (Windows, macOS).
 *
 * @param {string} root - The projects directory.
 * @param {string} cwd
 * @param {string} [platform=process.platform]
 * @returns {string[]} Folder names under root.
 */
function projectDirsForCwd(root, cwd, platform = process.platform) {
  const { encodeClaudeProjectDir } = require('./path-decode');
  const cwds = [cwd];
  try {
    const real = fs.realpathSync.native(cwd);
    if (real && real !== cwd) cwds.push(real);
  } catch (_) { /* folder may not exist */ }
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return []; }
  const foldCase = platform === 'win32' || platform === 'darwin';
  const out = new Set();
  for (const c of cwds) {
    const enc = encodeClaudeProjectDir(c);
    if (!enc) continue;
    const prefix = enc.length > PROJECT_DIR_NAME_MAX ? enc.slice(0, PROJECT_DIR_NAME_MAX) + '-' : null;
    const hit = (n, e, p) => n === e || (p && n.startsWith(p));
    let found = names.filter(n => hit(n, enc, prefix));
    if (found.length === 0 && foldCase) {
      const encL = enc.toLowerCase();
      const prefixL = prefix ? prefix.toLowerCase() : null;
      found = names.filter(n => hit(n.toLowerCase(), encL, prefixL));
    }
    for (const n of found) out.add(n);
  }
  return Array.from(out);
}

/**
 * The conversation `claude --continue` would pick in `cwd`: the newest
 * transcript in the Claude project folder(s) for that folder. Reads the
 * folder by the name the CLI writes, so worktree folders that the project
 * path decoder cannot map back still resolve. The answer is reused for
 * NEWEST_MEMO_MS so one open does not scan the folder three times.
 *
 * @param {string} cwd - The folder the pane will run in.
 * @param {Object} [o]
 * @param {string} [o.projectsDir] - ~/.claude/projects (or CWM_CLAUDE_PROJECTS_DIR).
 * @returns {string|null} Transcript id, or null when the folder has none.
 */
function newestTranscriptForCwd(cwd, { projectsDir } = {}) {
  if (!cwd || typeof cwd !== 'string') return null;
  let root = projectsDir;
  if (!root) {
    try { root = require('./path-decode').resolveClaudeProjectsDir(); } catch (_) { return null; }
  }
  const key = root + '\u0000' + cwd;
  const memo = newestMemo.get(key);
  if (memo && Date.now() - memo.at < NEWEST_MEMO_MS) return memo.value;
  let newest = null;
  for (const dirName of projectDirsForCwd(root, cwd)) {
    let files;
    try { files = fs.readdirSync(path.join(root, dirName)); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      if (!TRANSCRIPT_ID_RE.test(id)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(path.join(root, dirName, f)).mtimeMs; } catch (_) { continue; }
      if (!newest || mtime > newest.mtime) newest = { id, mtime };
    }
  }
  const value = newest ? newest.id : null;
  newestMemo.set(key, { at: Date.now(), value });
  if (newestMemo.size > 256) newestMemo.delete(newestMemo.keys().next().value);
  return value;
}

/**
 * Normalize a folder path for comparing a listing entry's cwd with the
 * folder a pane will run in (case and separators, trailing slash).
 * @param {string} p
 * @returns {string}
 */
function normalizeCwd(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Decision log (claude-live-check.log in the Workbook data dir), rotated. */
const DECISION_LOG_FILE = 'claude-live-check.log';
const DECISION_LOG_MAX_BYTES = 256 * 1024;

/**
 * Append one line to the durable decision log. The served install runs as a
 * scheduled task with no console, so console lines are lost; this is the
 * audit trail for why a pane attached, resumed, or stopped at a notice.
 * Never throws.
 *
 * @param {string} line
 */
function appendDecisionLog(line) {
  try {
    const { getDataDir } = require('../../utils/data-dir');
    const file = path.join(getDataDir(), DECISION_LOG_FILE);
    try {
      if (fs.statSync(file).size > DECISION_LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch (_) { /* no file yet */ }
    fs.appendFileSync(file, new Date().toISOString() + ' ' + String(line).replace(/[\r\n]+/g, ' ') + '\n', 'utf8');
  } catch (_) { /* logging must never break an open */ }
}

/**
 * Pure decision: what should opening this transcript do?
 *
 * @param {Object} input
 * @param {string} input.resumeSessionId - Transcript id the pane would resume.
 * @param {{ok: boolean, entries?: Array, error?: string, detail?: string}} input.lookup
 * @param {Object|null} [input.marker] - Seen-live marker for this id (createSeenLiveStore().get).
 * @param {Object|null} [input.record] - Workbook store record, if any.
 * @param {number} input.now
 * @returns {{action: 'attach', shortId: string, entry: Object}
 *   | {action: 'notice', reason: ('interactive'|'unattachable'|'lookup-failed'), entry?: Object, marker?: Object, error?: string}
 *   | {action: 'resume', degraded?: boolean, error?: string}}
 */
function classifyResume({ resumeSessionId, lookup, marker = null, record = null, now }) {
  if (lookup && lookup.ok) {
    // A custom command can name a session by its short id or its name
    // ("claude --resume hytale-goku") as well as by transcript id.
    const matches = (lookup.entries || []).filter(e => sameTranscriptId(e.sessionId, resumeSessionId)
      || (e.shortId && sameTranscriptId(e.shortId, resumeSessionId))
      || (e.name && e.name === resumeSessionId));
    const bg = matches.find(e => e.kind === 'background' && SHORT_ID_RE.test(e.shortId || ''));
    if (bg) return { action: 'attach', shortId: bg.shortId, entry: bg };
    const interactive = matches.find(e => e.kind === 'interactive');
    if (interactive) return { action: 'notice', reason: 'interactive', entry: interactive };
    // Listed, but not in a form we can attach to (a background entry without
    // a usable short id, or a kind this code does not know). It is live, so
    // it must not be resumed.
    if (matches.length > 0) return { action: 'notice', reason: 'unattachable', entry: matches[0] };
    return { action: 'resume' };
  }
  const error = (lookup && lookup.error) || 'unknown';
  const recordLive = !!(record && LIVE_RECORD_STATUSES.has(record.status));
  const markerFresh = !!(marker && Number.isFinite(marker.at) && (now - marker.at) <= SEEN_LIVE_WINDOW_MS);
  if (recordLive || markerFresh) {
    return { action: 'notice', reason: 'lookup-failed', marker: marker || null, error };
  }
  return { action: 'resume', degraded: true, error };
}

/**
 * Build a lookup service. Production uses the module singleton
 * (getDefaultLookup); tests build their own with fakes.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.execFileImpl=child_process.execFile]
 * @param {function(): Array} [opts.resolveCandidates=resolveClaudeCandidates]
 * @param {function(): number} [opts.now=Date.now]
 * @param {number} [opts.timeoutMs=LOOKUP_TIMEOUT_MS]
 * @param {number} [opts.ttlMs=CACHE_TTL_MS]
 * @param {number} [opts.failureTtlMs=FAILURE_TTL_MS]
 * @param {number} [opts.freshReuseMs=FRESH_REUSE_MS]
 * @param {Object} [opts.env=process.env]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.homedir=os.homedir()] - Account home, used to fill missing profile variables.
 * @param {Object|null} [opts.seenStore] - createSeenLiveStore() instance.
 */
function createLiveSessionLookup({
  execFileImpl = childProcess.execFile,
  resolveCandidates = resolveClaudeCandidates,
  now = Date.now,
  timeoutMs = LOOKUP_TIMEOUT_MS,
  ttlMs = CACHE_TTL_MS,
  failureTtlMs = FAILURE_TTL_MS,
  freshReuseMs = FRESH_REUSE_MS,
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  seenStore = createSeenLiveStore(),
} = {}) {
  let cache = null;      // { result, at }
  let inFlight = null;   // Promise of the current run
  let generation = 0;    // bumped by invalidate(); stale runs do not fill the cache
  let runs = 0;          // number of real CLI runs (diagnostics/tests)

  // The lookup process must not inherit CLAUDECODE (nested-session detection),
  // same scrub as the pane spawn descriptor.
  const lookupEnv = withProfileEnv({ ...env }, { platform, homedir });
  delete lookupEnv.CLAUDECODE;
  // Run from the account home, never from the Workbook install dir, so a CLI
  // that writes anything relative to its cwd cannot litter the install.
  let lookupCwd;
  try { lookupCwd = homedir && fs.statSync(homedir).isDirectory() ? homedir : undefined; } catch (_) { lookupCwd = undefined; }

  // Resolved binaries, kept for a few minutes: the probes are synchronous
  // stats, and the install location practically never moves. Dropped as soon
  // as every candidate fails to start, so a reinstall is picked up.
  let candidateCache = null; // { list, at }

  // Optional sanity check on a successful listing (setSightCheck). A listing
  // that fails it is treated as a failed lookup: not cached as the truth, and
  // it does not replace the seen-live markers.
  let sightCheck = null;

  async function runFresh() {
    runs++;
    let candidates = null;
    if (candidateCache && now() - candidateCache.at < CANDIDATE_TTL_MS) {
      candidates = candidateCache.list;
    } else {
      try { candidates = resolveCandidates({ env, platform }) || []; } catch (_) { candidates = []; }
      candidateCache = candidates.length ? { list: candidates, at: now() } : null;
    }
    if (candidates.length === 0) {
      return { ok: false, error: 'not-found', detail: 'no claude binary on PATH or in the known install locations' };
    }
    const deadline = now() + timeoutMs;
    let last = null;
    for (const bin of candidates) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const result = await runAgentsJsonOnce(bin, { timeoutMs: remaining, env: lookupEnv, platform, execFileImpl, cwd: lookupCwd });
      if (result.ok) return { ...result, bin: bin.path };
      last = { ...result, bin: bin.path };
      // A hang is not worth repeating with another copy of the same CLI.
      if (result.error === 'timeout') break;
    }
    // No cached candidate worked (removed shim, broken install): resolve
    // again next time instead of retrying the same paths for minutes.
    candidateCache = null;
    return last || { ok: false, error: 'timeout', detail: 'deadline passed before a candidate ran' };
  }

  /**
   * The current listing, from cache when fresh.
   *
   * `fresh` skips the TTL cache, but a listing younger than freshReuseMs is
   * still reused (and a run already in flight is joined), which bounds a
   * burst of re-checks (key auto-repeat on the notice, a restore storm) to
   * one CLI run per second.
   *
   * @param {Object} [o]
   * @param {boolean} [o.fresh=false]
   * @returns {Promise<{ok: boolean, entries?: Array, error?: string, detail?: string, at: number, cached: boolean}>}
   */
  async function list({ fresh = false } = {}) {
    const t = now();
    if (cache) {
      const age = t - cache.at;
      const ttl = cache.result.ok ? ttlMs : failureTtlMs;
      if ((!fresh && age < ttl) || (fresh && age < freshReuseMs)) {
        return { ...cache.result, at: cache.at, cached: true };
      }
    }
    if (!inFlight) {
      const gen = generation;
      const run = runFresh().then((raw) => {
        const at = now();
        let result = raw;
        if (result.ok && typeof sightCheck === 'function') {
          let verdict = true;
          try { verdict = sightCheck(result.entries); } catch (_) { verdict = true; }
          if (verdict !== true) {
            result = { ok: false, error: 'blind', detail: typeof verdict === 'string' ? verdict : 'listing failed the sight check', bin: raw.bin };
            appendDecisionLog('lookup treated as failed (blind): ' + result.detail);
          }
        }
        if (gen === generation) cache = { result, at };
        if (result.ok && seenStore) {
          try { seenStore.replaceFrom(result.entries, at); } catch (_) {}
        }
        if (!result.ok && result.error !== 'blind') {
          appendDecisionLog('lookup failed: ' + result.error + (result.detail ? ' (' + result.detail + ')' : ''));
        }
        return { ...result, at, cached: false };
      }).finally(() => {
        // Only clear our own slot: invalidate() may already have let a newer run start.
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
    }
    return inFlight;
  }

  /**
   * Decide what opening `resumeSessionId` should do.
   * @param {Object} o
   * @param {string} o.resumeSessionId
   * @param {Object|null} [o.record]
   * @param {boolean} [o.fresh=false]
   * @returns {Promise<Object>} classifyResume() result plus `lookup` ({ok, error, cached, at}).
   */
  async function resolveResumeAction({ resumeSessionId, record = null, fresh = false }) {
    if (!resumeSessionId || !TRANSCRIPT_ID_RE.test(resumeSessionId)) {
      return { action: 'resume', lookup: null };
    }
    let lookup = await safeList({ fresh });
    const decide = () => classifyResume({
      resumeSessionId, lookup, marker: seenStore ? seenStore.get(resumeSessionId) : null, record, now: now(),
    });
    let decision = decide();
    // A cached "not live" must never decide a spawn: the session may have
    // gone live since that listing (review finding F1, 2026-09-26). A cached
    // "live" answer is safe to act on (it attaches, or shows the notice), so
    // only the negative is re-asked. The re-ask may still reuse a listing
    // younger than freshReuseMs, which bounds the staleness to about 1 s.
    // Same for a degraded resume decided from a cached FAILURE: ask again
    // rather than resume on a two-second-old "could not check".
    if (decision.action === 'resume' && lookup.cached && (lookup.ok || decision.degraded)) {
      lookup = await safeList({ fresh: true });
      decision = decide();
    }
    return { ...decision, lookup: lookupSummary(lookup) };
  }

  /**
   * Decide what a command that picks its conversation when it starts should
   * do in `cwd`: `claude --continue` (the newest conversation in the folder),
   * the resume picker, --from-pr.
   *
   * The newest transcript can change while the check runs (a live session
   * writes to its own), so the folder, not the transcript, is what counts:
   *   - the known newest transcript is a live background session -> attach;
   *   - any other session live in that folder -> notice, nothing started;
   *   - nothing live there -> resume (run the command as before).
   * On a failed lookup the seen-live markers stand in for the listing, by
   * transcript and by folder.
   *
   * @param {Object} o
   * @param {string} o.cwd - Folder the command will run in.
   * @param {string|null} o.transcriptId - newestTranscriptForCwd(cwd), if any.
   * @param {Object|null} [o.record]
   * @param {boolean} [o.fresh=false]
   * @returns {Promise<Object>} Decision plus `lookup`.
   */
  async function resolveContinueAction({ cwd, transcriptId = null, record = null, fresh = false }) {
    const target = transcriptId && TRANSCRIPT_ID_RE.test(transcriptId) ? transcriptId : null;
    let lookup = await safeList({ fresh });
    // Neither a cached "nothing here" nor a cached failure decides a spawn.
    if (lookup.cached) lookup = await safeList({ fresh: true });
    const want = normalizeCwd(cwd);
    if (lookup.ok) {
      if (target) {
        const d = classifyResume({ resumeSessionId: target, lookup, now: now() });
        if (d.action === 'attach') return { ...d, lookup: lookupSummary(lookup) };
        if (d.action === 'notice') return { ...d, lookup: lookupSummary(lookup) };
      }
      const inCwd = want ? lookup.entries.find(e => normalizeCwd(e.cwd) === want) : null;
      if (inCwd) return { action: 'notice', reason: 'continue-live-cwd', entry: inCwd, lookup: lookupSummary(lookup) };
      return { action: 'resume', lookup: lookupSummary(lookup) };
    }
    const t = now();
    const freshMarker = (m) => !!(m && Number.isFinite(m.at) && t - m.at <= SEEN_LIVE_WINDOW_MS);
    if (target) {
      const d = classifyResume({ resumeSessionId: target, lookup, marker: seenStore ? seenStore.get(target) : null, record, now: t });
      if (d.action === 'notice') return { ...d, lookup: lookupSummary(lookup) };
    }
    if (want && seenStore) {
      const inCwd = Object.values(seenStore.all()).find(m => freshMarker(m) && normalizeCwd(m.cwd) === want);
      if (inCwd) return { action: 'notice', reason: 'lookup-failed', marker: inCwd, error: lookup.error, lookup: lookupSummary(lookup) };
    }
    return { action: 'resume', degraded: true, error: lookup.error, lookup: lookupSummary(lookup) };
  }

  /** list() that never throws. */
  async function safeList(o) {
    try {
      return await list(o);
    } catch (err) {
      return { ok: false, error: 'exception', detail: err && err.message, at: now(), cached: false };
    }
  }

  /** The part of a listing a decision carries (no entries). */
  function lookupSummary(lookup) {
    return { ok: !!lookup.ok, error: lookup.error || null, detail: lookup.detail || null, cached: !!lookup.cached, at: lookup.at };
  }

  /**
   * Install a sanity check for successful listings: fn(entries) returns true
   * when the listing is plausible, or a reason string when it cannot be
   * (pty-manager: an empty listing while this Workbook runs Claude panes).
   * @param {function(Array): (true|string)|null} fn
   */
  function setSightCheck(fn) {
    sightCheck = typeof fn === 'function' ? fn : null;
  }

  /**
   * Synchronous view for defense-in-depth checks that cannot await: true
   * when the cached listing or a fresh marker says the transcript is live.
   * Never runs the CLI.
   * @param {string} transcriptId
   * @returns {boolean}
   */
  function isKnownLive(transcriptId) {
    if (!transcriptId) return false;
    const t = now();
    if (cache && cache.result.ok && t - cache.at < ttlMs) {
      return cache.result.entries.some(e => sameTranscriptId(e.sessionId, transcriptId));
    }
    const marker = seenStore ? seenStore.get(transcriptId) : null;
    return !!(marker && Number.isFinite(marker.at) && t - marker.at <= SEEN_LIVE_WINDOW_MS);
  }

  /** Drop the cached listing (e.g. after a Workbook PTY exits). */
  function invalidate() {
    cache = null;
    generation++;
    inFlight = null;
  }

  return {
    list,
    resolveResumeAction,
    resolveContinueAction,
    isKnownLive,
    invalidate,
    setSightCheck,
    get runs() { return runs; },
    seenStore,
  };
}

let defaultLookup = null;

/**
 * Process-wide lookup, with seen-live markers persisted in the Workbook data
 * dir (~/.myrlin, or CWM_DATA_DIR in tests).
 * @returns {ReturnType<typeof createLiveSessionLookup>}
 */
function getDefaultLookup() {
  if (!defaultLookup) {
    let filePath = null;
    try {
      const { getDataDir } = require('../../utils/data-dir');
      filePath = path.join(getDataDir(), SEEN_LIVE_FILE);
    } catch (_) { filePath = null; }
    defaultLookup = createLiveSessionLookup({ seenStore: createSeenLiveStore({ filePath }) });
  }
  return defaultLookup;
}

/** Test hook: forget memoized newest-transcript answers. */
function _resetNewestMemoForTesting() {
  newestMemo.clear();
}

/** Test hook: replace (or with null, reset) the process-wide lookup. */
function _setDefaultLookupForTesting(lookup) {
  defaultLookup = lookup;
}

module.exports = {
  LOOKUP_TIMEOUT_MS,
  CACHE_TTL_MS,
  FAILURE_TTL_MS,
  SEEN_LIVE_WINDOW_MS,
  SHORT_ID_RE,
  LIVE_RECORD_STATUSES,
  SEEN_LIVE_FILE,
  FRESH_REUSE_MS,
  DECISION_LOG_FILE,
  resolveClaudeCandidates,
  parseAgentsJson,
  findJsonArray,
  parseResumeCommand,
  newestTranscriptForCwd,
  projectDirsForCwd,
  PROJECT_DIR_NAME_MAX,
  normalizeCwd,
  appendDecisionLog,
  runAgentsJsonOnce,
  withProfileEnv,
  classifyResume,
  createSeenLiveStore,
  createLiveSessionLookup,
  getDefaultLookup,
  sameTranscriptId,
  _setDefaultLookupForTesting,
  _resetNewestMemoForTesting,
};
