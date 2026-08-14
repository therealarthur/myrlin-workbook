#!/usr/bin/env node
/**
 * Tests for src/providers/codex/paths.js
 * (BUILD-CONTRACT P8.3 / CODEX-PARITY P0-3, gap B2).
 *
 * Coverage:
 *   1. The normalization truth table: extended-length prefix, UNC form,
 *      separator collapsing, mixed separators, trailing separators, roots,
 *      POSIX paths, and every unusable-input shape.
 *   2. The real duplicate-folder collision measured on a live machine
 *      (CODEX-PARITY A.6): `\\?\C:\...\New project 2` and
 *      `C:\...\New project 2` must collapse to ONE grouping key while keeping
 *      one display name.
 *   3. The two proven sha256 project ids from CODEX-PARITY A.3. These were
 *      recovered by brute-forcing the Codex app's own `.codex-global-state.json`
 *      keys, so they are the acceptance criterion for P8.3: if either literal
 *      stops matching, the workbook has stopped agreeing with the desktop app
 *      about what a project is.
 *   4. Host namespacing, so an ssh/wsl host does not collide with local.
 *   5. Case discipline: the grouping key folds case, the project id does NOT,
 *      and the display name preserves the user's chosen capitalisation.
 *   6. Purity and totality: no input throws.
 *
 * Note on the two literal paths in section 3: they are reproduced verbatim from
 * docs/design/notion-restyle/CODEX-PARITY.md A.3, which is already committed to
 * this repository as the authority document for this phase. No new personal
 * content is introduced by asserting them here, and without the exact input the
 * proven hashes cannot be reproduced at all.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 green / 1 red.
 */

'use strict';

// ─── Assertion helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + err.message + '\x1b[0m');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)
    );
  }
}

// ─── Module require ────────────────────────────────────────────────────────

let paths;
try {
  paths = require('../src/providers/codex/paths');
} catch (err) {
  console.error('FATAL: could not require src/providers/codex/paths.js: ' + err.message);
  process.exit(1);
}

const {
  normalizeCodexPath,
  projectKeyFor,
  projectDisplayNameFor,
  projectIdFor,
  describeProject,
  PROJECT_ID_HASH_LENGTH,
  DEFAULT_HOST_ID,
} = paths;

console.log('\n  \x1b[1mcodex/paths: normalization truth table\x1b[0m');

// ─── 1. Normalization truth table ──────────────────────────────────────────

/**
 * Each row is [input, expected]. Kept as a table so a new observed path shape
 * is one line, not a new test function.
 */
const TRUTH_TABLE = [
  // Extended-length prefix, the measured real-world case.
  ['\\\\?\\C:\\work\\alpha', 'C:\\work\\alpha'],
  ['C:\\work\\alpha', 'C:\\work\\alpha'],
  // UNC long form restores to the familiar double-backslash spelling.
  ['\\\\?\\UNC\\server\\share\\proj', '\\\\server\\share\\proj'],
  ['\\\\server\\share\\proj', '\\\\server\\share\\proj'],
  // Duplicate separators collapse; the UNC leading pair survives.
  ['C:\\work\\\\alpha', 'C:\\work\\alpha'],
  ['\\\\server\\\\share\\\\proj', '\\\\server\\share\\proj'],
  // Mixed separators land on one dialect for Windows-shaped paths.
  ['C:/work//alpha', 'C:\\work\\alpha'],
  ['C:/work\\alpha', 'C:\\work\\alpha'],
  // Trailing separators are dropped.
  ['C:\\work\\alpha\\', 'C:\\work\\alpha'],
  ['C:\\work\\alpha\\\\', 'C:\\work\\alpha'],
  // ...but a root is never destroyed.
  ['C:\\', 'C:\\'],
  ['/', '/'],
  // POSIX paths keep forward slashes, so this module is safe off Windows.
  ['/home/dev/proj', '/home/dev/proj'],
  ['/home/dev/proj/', '/home/dev/proj'],
  ['/home//dev///proj', '/home/dev/proj'],
  // Surrounding whitespace is not a path.
  ['  C:\\work\\alpha  ', 'C:\\work\\alpha'],
  // Unusable inputs return '' rather than throwing.
  ['', ''],
  ['   ', ''],
];

test('normalizeCodexPath satisfies the truth table', () => {
  for (const [input, expected] of TRUTH_TABLE) {
    assertEqual(normalizeCodexPath(input), expected, 'input ' + JSON.stringify(input));
  }
});

test('normalizeCodexPath is total: no input type throws', () => {
  const junk = [null, undefined, 0, 1, NaN, true, false, {}, [], () => {}, Symbol('x')];
  for (const value of junk) {
    let result;
    try {
      result = normalizeCodexPath(value);
    } catch (err) {
      throw new Error('threw on ' + String(value) + ': ' + err.message);
    }
    assertEqual(result, '', 'junk input ' + String(value));
  }
});

test('the extended-length prefix alone normalizes to empty, not to a stray slash', () => {
  assertEqual(normalizeCodexPath('\\\\?\\'), '');
});

// ─── 2. The real duplicate-folder collision ────────────────────────────────

console.log('\n  \x1b[1mcodex/paths: the measured New project 2 collision\x1b[0m');

// The exact pair recorded in CODEX-PARITY A.6. Unnormalized, these render as
// two sidebar folders with the same visible name.
const COLLISION_PREFIXED = '\\\\?\\C:\\Users\\Arthur\\Documents\\New project 2';
const COLLISION_PLAIN = 'C:\\Users\\Arthur\\Documents\\New project 2';

test('the two spellings collapse to ONE grouping key', () => {
  const keyA = projectKeyFor(COLLISION_PREFIXED);
  const keyB = projectKeyFor(COLLISION_PLAIN);
  assert(keyA.length > 0, 'prefixed key must not be empty');
  assertEqual(keyA, keyB, 'the prefixed and plain spellings must share a key');
});

test('grouping the two spellings yields a single folder bucket', () => {
  // This is the sidebar behaviour the collision breaks, asserted directly
  // rather than inferred from the key equality above.
  const rows = [
    { cwd: COLLISION_PREFIXED },
    { cwd: COLLISION_PLAIN },
    { cwd: 'C:\\Users\\Arthur\\Documents\\New project 2\\' },
    { cwd: 'C:/Users/Arthur/Documents/New project 2' },
  ];
  const buckets = new Map();
  for (const row of rows) {
    const key = projectKeyFor(row.cwd);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  assertEqual(buckets.size, 1, 'four spellings of one directory must produce one bucket');
  assertEqual(buckets.values().next().value.length, 4);
});

test('the display name survives normalization with its casing intact', () => {
  assertEqual(projectDisplayNameFor(COLLISION_PREFIXED), 'New project 2');
  assertEqual(projectDisplayNameFor(COLLISION_PLAIN), 'New project 2');
});

test('two genuinely different folders do NOT collapse', () => {
  const a = projectKeyFor('C:\\work\\alpha');
  const b = projectKeyFor('C:\\work\\beta');
  assert(a !== b, 'distinct directories must keep distinct keys');
});

// ─── 3. The two proven sha256 project ids ──────────────────────────────────

console.log('\n  \x1b[1mcodex/paths: the two proven project ids (CODEX-PARITY A.3)\x1b[0m');

const PROVEN = [
  ['C:\\Users\\Arthur\\Documents\\test workday', '96dac46ed15428c0b9d16938cd85d65b'],
  ['C:\\Users\\Arthur\\Documents\\test blockbench', '486f6e5611d625d523f3e79cacd28dce'],
];

test('both proven hashes reproduce exactly', () => {
  for (const [cwd, hash] of PROVEN) {
    assertEqual(projectIdFor(cwd), 'codex:local-' + hash, 'project id for ' + cwd);
  }
});

test('the prefixed spelling produces the SAME proven id', () => {
  // The app stores some rows with the prefix. Normalizing before hashing is
  // what makes the id stable across the two spellings.
  for (const [cwd, hash] of PROVEN) {
    assertEqual(projectIdFor('\\\\?\\' + cwd), 'codex:local-' + hash);
  }
});

test('the trailing-separator spelling produces the SAME proven id', () => {
  for (const [cwd, hash] of PROVEN) {
    assertEqual(projectIdFor(cwd + '\\'), 'codex:local-' + hash);
  }
});

test('the project id hash is exactly the documented length', () => {
  const id = projectIdFor(PROVEN[0][0]);
  const hashPart = id.slice(id.lastIndexOf('-') + 1);
  assertEqual(hashPart.length, PROJECT_ID_HASH_LENGTH);
  assert(/^[0-9a-f]+$/.test(hashPart), 'hash must be lowercase hex');
});

test('project id is empty for unusable input, never a hash of the empty string', () => {
  assertEqual(projectIdFor(null), '');
  assertEqual(projectIdFor(''), '');
  assertEqual(projectIdFor('   '), '');
});

// ─── 4. Host namespacing ───────────────────────────────────────────────────

console.log('\n  \x1b[1mcodex/paths: host namespacing\x1b[0m');

test('the default host is local, and it is not hardcoded at the call site', () => {
  assertEqual(DEFAULT_HOST_ID, 'local');
  assert(projectIdFor('C:\\work\\alpha').startsWith('codex:local-'));
});

test('a non-local host namespaces the same directory to a different id', () => {
  const local = projectIdFor('C:\\work\\alpha', 'local');
  const ssh = projectIdFor('C:\\work\\alpha', 'ssh');
  const wsl = projectIdFor('C:\\work\\alpha', 'wsl');
  assert(local !== ssh && ssh !== wsl && local !== wsl, 'hosts must not collide');
  // ...while the hash half stays identical, which is what makes the format
  // tolerate hosts that do not exist on this machine yet.
  const hashOf = (id) => id.slice(id.lastIndexOf('-') + 1);
  assertEqual(hashOf(local), hashOf(ssh));
  assertEqual(hashOf(ssh), hashOf(wsl));
});

test('an empty or non-string host falls back to the default rather than corrupting the id', () => {
  const expected = projectIdFor('C:\\work\\alpha', 'local');
  assertEqual(projectIdFor('C:\\work\\alpha', ''), expected);
  assertEqual(projectIdFor('C:\\work\\alpha', null), expected);
  assertEqual(projectIdFor('C:\\work\\alpha', 42), expected);
});

// ─── 5. Case discipline ────────────────────────────────────────────────────

console.log('\n  \x1b[1mcodex/paths: case discipline\x1b[0m');

test('the grouping key folds case', () => {
  assertEqual(projectKeyFor('C:\\Work\\Alpha'), projectKeyFor('c:\\work\\alpha'));
});

test('the project id does NOT fold case, because the app hashes the cased path', () => {
  const upper = projectIdFor('C:\\Work\\Alpha');
  const lower = projectIdFor('c:\\work\\alpha');
  assert(upper !== lower, 'lowercasing before hashing would break agreement with the Codex app');
});

test('the display name preserves the capitalisation the user chose', () => {
  assertEqual(projectDisplayNameFor('C:\\Work\\MyProject'), 'MyProject');
  assertEqual(projectDisplayNameFor('C:\\Work\\myproject'), 'myproject');
});

test('a drive root has a display name rather than an empty label', () => {
  assertEqual(projectDisplayNameFor('C:\\'), 'C:');
  assertEqual(projectDisplayNameFor('/'), '/');
});

// ─── 6. describeProject bundle ─────────────────────────────────────────────

console.log('\n  \x1b[1mcodex/paths: describeProject bundle\x1b[0m');

test('describeProject returns every derived form, each consistent with its own function', () => {
  const raw = COLLISION_PREFIXED;
  const d = describeProject(raw);
  assertEqual(d.raw, raw, 'raw is preserved verbatim for debugging');
  assertEqual(d.path, normalizeCodexPath(raw));
  assertEqual(d.key, projectKeyFor(raw));
  assertEqual(d.displayName, projectDisplayNameFor(raw));
  assertEqual(d.id, projectIdFor(raw));
});

test('describeProject on unusable input returns defined empty strings, never undefined', () => {
  const d = describeProject(null);
  assertEqual(d.raw, '');
  assertEqual(d.path, '');
  assertEqual(d.key, '');
  assertEqual(d.displayName, '');
  assertEqual(d.id, '');
});

test('describeProject honours the host parameter', () => {
  assert(describeProject('C:\\work\\alpha', 'wsl').id.startsWith('codex:wsl-'));
});

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\n  ' + '='.repeat(58));
console.log('  [codex-paths] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
