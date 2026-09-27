/**
 * b1-sandbox-guard.test.js: no mobile test can load the Workbook store, or
 * src/web/auth.js, outside a sandbox.
 *
 * WHY: on 2026-09-27 a hand run loaded server.js with no sandbox CWM_DATA_DIR.
 * The store wrote a backup into the live data folder and auth.js copied the
 * live desktop password into the ignored state/config.json. The harness now
 * refuses to run unless the process is isolated (sandboxProblems), and
 * run-all.js refuses a file that loads a local module before the sandbox and
 * starts every child with a temp data folder and a throwaway password. This
 * suite proves each of those rules, the negative cases in child processes
 * whose environment is itself a temp sandbox, so the proof can never touch
 * real data either.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const runAll = require('./run-all');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const SANDBOX_FILE = path.join(H.REPO_ROOT, 'test', '_test-data-dir.js');
const STORE_FILE = path.join(H.REPO_ROOT, 'src', 'state', 'store.js');
const DATA_DIR_FILE = path.join(H.REPO_ROOT, 'src', 'utils', 'data-dir.js');
const HARNESS_FILE = path.join(__dirname, '_harness.js');
/** Child process timeout. */
const CHILD_TIMEOUT_MS = 60 * 1000;

/**
 * Run a one line script in a child whose environment is a temp sandbox, so a
 * guard that failed could still reach nothing real.
 *
 * @param {string} script - Code for node's eval flag.
 * @param {object} [extraEnv] - Variables to add.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runChild(script, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-guard-child-'));
  try {
    const env = runAll.childEnv(process.env, dir);
    Object.assign(env, extraEnv || {});
    const r = spawnSync(process.execPath, ['-e', script], { env, cwd: dir, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A sandbox layout for the pure checks: a temp dir that is the sandbox. */
function goodCase() {
  const dir = path.join(os.tmpdir(), 'cwm-test-guard-case');
  return {
    sandbox: { dir, isolated: true },
    env: { CWM_DATA_DIR: dir, CWM_PASSWORD: 'x' },
    loadedModules: [HARNESS_FILE, SANDBOX_FILE, STORE_FILE],
    homedir: path.join(os.tmpdir(), 'cwm-guard-fake-home'),
    tmpdir: os.tmpdir(),
  };
}

t('this process is sandboxed: the harness guard found nothing and the store lives in a temp folder', () => {
  assert.deepStrictEqual(H.sandboxProblems({ sandbox: H.sandbox, env: process.env, loadedModules: Object.keys(require.cache) }), []);
  assert.strictEqual(H.sandbox.isolated, true);
  assert.ok(H.isInside(process.env.CWM_DATA_DIR, os.tmpdir()));
  assert.ok(!H.isInside(process.env.CWM_DATA_DIR, path.join(os.homedir(), '.myrlin')));
  assert.ok(process.env.CWM_PASSWORD, 'auth.js takes the environment path');
  const { getDataDir } = require('../../src/utils/data-dir');
  assert.strictEqual(path.resolve(getDataDir()), path.resolve(H.sandbox.dir));
});

t('sandboxProblems names every unsafe setup', () => {
  const has = (o, re) => assert.ok(H.sandboxProblems(o).some((p) => re.test(p)), 'expected ' + re + ' in ' + JSON.stringify(H.sandboxProblems(o)));
  assert.deepStrictEqual(H.sandboxProblems(goodCase()), []);

  let o = goodCase(); o.sandbox = { dir: o.sandbox.dir, isolated: false };
  has(o, /did not isolate/);

  o = goodCase(); delete o.env.CWM_DATA_DIR;
  has(o, /CWM_DATA_DIR is not set/);

  o = goodCase(); o.env.CWM_DATA_DIR = path.join(o.homedir, '.myrlin');
  has(o, /live Workbook data folder/);

  o = goodCase(); o.env.CWM_DATA_DIR = o.homedir;
  has(o, /live Workbook data folder/);

  o = goodCase(); o.env.CWM_DATA_DIR = path.join(H.REPO_ROOT, 'state');
  has(o, /in-repo state folder/);

  o = goodCase(); o.env.CWM_DATA_DIR = os.tmpdir(); o.sandbox.dir = os.tmpdir();
  has(o, /not a folder inside the system temp folder/);

  o = goodCase(); o.env.CWM_DATA_DIR = path.join(os.tmpdir(), 'some-other-folder');
  has(o, /neither the sandbox folder/);

  o = goodCase(); delete o.env.CWM_PASSWORD;
  has(o, /CWM_PASSWORD is not set/);

  o = goodCase(); o.loadedModules = [STORE_FILE, SANDBOX_FILE];
  has(o, /loaded before the sandbox: src[\\/]state[\\/]store\.js/);

  o = goodCase(); o.loadedModules = [DATA_DIR_FILE];
  has(o, /loaded before the sandbox: src[\\/]utils[\\/]data-dir\.js/);
});

t('a process that loads src/ before the harness is refused before any store code runs', () => {
  const script = 'require(' + JSON.stringify(DATA_DIR_FILE) + '); require(' + JSON.stringify(HARNESS_FILE) + '); console.log("GUARD MISSED");';
  const r = runChild(script);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /refusing to run outside a sandbox/);
  assert.match(r.stderr, /src[\\/]utils[\\/]data-dir\.js/);
  assert.ok(!r.stdout.includes('GUARD MISSED'));
});

t('CWM_TEST_ALLOW_PROD_DIR=1 is refused for mobile tests', () => {
  const r = runChild('require(' + JSON.stringify(HARNESS_FILE) + '); console.log("GUARD MISSED");', { CWM_TEST_ALLOW_PROD_DIR: '1' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /did not isolate this process/);
  assert.ok(!r.stdout.includes('GUARD MISSED'));
});

t('the harness itself loads the sandbox before any Workbook module', () => {
  assert.strictEqual(runAll.firstUnsafeRequire(fs.readFileSync(HARNESS_FILE, 'utf8')), null);
  const keys = Object.keys(require.cache);
  assert.ok(keys.indexOf(SANDBOX_FILE) >= 0);
  assert.deepStrictEqual(H.workbookModulesBeforeSandbox(keys), []);
});

t('the run-all preflight flags a local module loaded before the sandbox', () => {
  const f = runAll.firstUnsafeRequire;
  assert.strictEqual(f("'use strict';\nconst H = require('./_harness');\nrequire('../../src/state/store');"), null);
  assert.strictEqual(f("require('../_test-data-dir');\nconst kit = require('./fakes/kit');"), null);
  assert.strictEqual(f("const fs = require('fs');\nconst ws = require('ws');\nrequire('../_test-data-dir');"), null, 'built ins and packages first are fine');
  assert.strictEqual(f("require('../../_test-data-dir');"), null, 'one folder deeper');
  assert.strictEqual(f("/* require('../../src/x') */\n// require('../../src/y')\nrequire('./_harness');"), null, 'comments do not count');
  assert.strictEqual(f("const store = require('../../src/state/store');\nconst H = require('./_harness');"), '../../src/state/store');
  assert.strictEqual(f("const kit = require('./fakes/kit');\nrequire('../_test-data-dir');"), './fakes/kit', 'a local helper may load src/');
  assert.match(f("const p = 'x';\nrequire(p);\nrequire('./_harness');"), /computed require/);
  assert.match(f("const fs = require('fs');"), /no require of \.\.\/_test-data-dir/);
});

t('every mobile test file in this folder passes the preflight', () => {
  const files = runAll.listTestFiles(__dirname, []);
  assert.ok(files.includes('b1-sandbox-guard.test.js'));
  for (const file of files) {
    assert.strictEqual(runAll.firstUnsafeRequire(fs.readFileSync(path.join(__dirname, file), 'utf8')), null, file);
  }
});

t('run-all starts each child with a fresh temp data folder and a throwaway password, never the opt in', () => {
  const dir = path.join(os.tmpdir(), runAll.CHILD_DIR_PREFIX + 'case');
  const base = { CWM_DATA_DIR: path.join(os.homedir(), '.myrlin'), CWM_TEST_ALLOW_PROD_DIR: '1', CWM_PASSWORD: 'inherited-' + crypto.randomBytes(4).toString('hex'), KEEP_ME: 'yes' };
  const a = runAll.childEnv(base, dir);
  const b = runAll.childEnv(base, dir);
  assert.strictEqual(a.CWM_DATA_DIR, dir);
  assert.strictEqual(a.CWM_TEST_ALLOW_PROD_DIR, undefined);
  assert.notStrictEqual(a.CWM_PASSWORD, base.CWM_PASSWORD);
  assert.match(a.CWM_PASSWORD, /^cwm-mobile-[A-Za-z0-9_-]{24}$/);
  assert.notStrictEqual(a.CWM_PASSWORD, b.CWM_PASSWORD);
  assert.strictEqual(a.KEEP_ME, 'yes');
  assert.strictEqual(base.CWM_TEST_ALLOW_PROD_DIR, '1', 'the parent environment is not changed');
});

t('the e2e helper loads no Workbook module at all (it only talks HTTP to a sandbox)', () => {
  const src = runAll.stripComments(fs.readFileSync(path.join(__dirname, 'e2e', 'auto-allow.js'), 'utf8'));
  const specs = [...src.matchAll(/\brequire\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(!s.startsWith('.'), 'auto-allow.js requires ' + s);
});

H.run('b1-sandbox-guard', tests);
