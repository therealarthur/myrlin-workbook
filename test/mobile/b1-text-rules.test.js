/**
 * b1-text-rules.test.js: the text rules for every file track B1 owns.
 *
 * WHY: BUILD-CONTRACT rule 2 keeps em dashes and double hyphens out of
 * everything written, and allows two hyphen command line flags only inside
 * shell scripts and code strings, never in comments (gate G12b catches only a
 * bare double hyphen, so a flag or a CSS custom property name in a comment
 * slips past it). The Workbook repository is also public, so B1's fixtures
 * and tests use neutral example values: no Windows user folder other than the
 * placeholder "dev", no Tailscale address outside the placeholder tailnet, and
 * no email address outside example.com. The rules are written generically so
 * this file itself names no real value, and its bad samples are built from
 * parts so the file passes its own scan.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const ROOT = H.REPO_ROOT;
const MOBILE_TESTS = path.join(ROOT, 'test', 'mobile');
/** U+2014 and U+2015, built from code points so this file holds neither. */
const DASHES = new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']');
/** Two hyphens, built so the samples below are not comment hits themselves. */
const HH = '-'.repeat(2);
/** The only user folder name example paths may use. */
const PLACEHOLDER_USER = 'dev';
/** The only tailnet example addresses may use. */
const PLACEHOLDER_TAILNET = 'tailnet-example';
/** Fewest files the scans must see (a smaller count means a broken walk). */
const MIN_CODE_FILES = 40;
const MIN_FIXTURE_FILES = 100;

/** Every file under a folder. */
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** B1's code files (BUILD-CONTRACT 3.2 plus fs-atomic.js), not B2's or B3's folders. */
function b1CodeFiles() {
  const mobileSrc = path.join(ROOT, 'src', 'web', 'mobile');
  const src = walk(mobileSrc, []).filter((p) => {
    const top = path.relative(mobileSrc, p).split(path.sep)[0];
    return p.endsWith('.js') && top !== 'chat' && top !== 'workspace' && top !== 'stream';
  });
  const pub = ['connect-app.js', 'connect-app.css'].map((f) => path.join(ROOT, 'src', 'web', 'public', f));
  const own = fs.readdirSync(MOBILE_TESTS)
    .filter((f) => /^b1-.*\.test\.js$/.test(f) || ['_harness.js', '_schema-check.js', 'run-all.js'].includes(f))
    .map((f) => path.join(MOBILE_TESTS, f));
  return src.concat(pub, own, [path.join(MOBILE_TESTS, 'e2e', 'auto-allow.js')]);
}

/** B1's fixtures: examples, the vendored protocol copy and the route table. */
function b1FixtureFiles() {
  const fx = path.join(MOBILE_TESTS, 'fixtures');
  return walk(path.join(fx, 'examples'), []).concat(walk(path.join(fx, 'protocol'), []), [path.join(fx, 'route-table.json')]);
}

/**
 * The comments of a source file: block comments, and for JavaScript the line
 * comments that start after whitespace or punctuation (so a URL's two
 * slashes inside a string are not one).
 *
 * @param {string} file - Path (a .css file has block comments only).
 * @param {string} text - Contents.
 * @returns {string[]}
 */
function commentsOf(file, text) {
  const out = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  if (!file.endsWith('.css')) out.push(...[...text.matchAll(/(^|[\s;,{}()])\/\/[^\n]*/gm)].map((m) => m[0]));
  return out;
}

t('the scans see B1\'s files (neither list is empty or short)', () => {
  const code = b1CodeFiles();
  assert.ok(code.length >= MIN_CODE_FILES, 'only ' + code.length + ' code files');
  for (const f of code) assert.ok(fs.existsSync(f), f);
  assert.ok(b1FixtureFiles().length >= MIN_FIXTURE_FILES);
});

t('no em dash or horizontal bar in any B1 file', () => {
  const bad = b1CodeFiles().concat(b1FixtureFiles()).filter((f) => DASHES.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(bad.map((f) => path.relative(ROOT, f)), []);
});

t('no two hyphen token in any comment of a B1 code file (flags and CSS property names stay in code)', () => {
  const bad = [];
  for (const f of b1CodeFiles()) {
    for (const c of commentsOf(f, fs.readFileSync(f, 'utf8'))) {
      if (c.includes(HH)) bad.push(path.relative(ROOT, f) + ': ' + c.trim().slice(0, 80));
    }
  }
  assert.deepStrictEqual(bad, []);
});

t('the comment scanner finds a flag or a property name in a comment, and ignores them in code', () => {
  const hits = (file, text) => commentsOf(file, text).filter((c) => c.includes(HH)).length;
  const slash2 = '/' + '/';
  assert.strictEqual(hits('x.js', slash2 + ' use ' + HH + 'port 1\nconst u = "http:' + slash2 + 'a";'), 1);
  assert.strictEqual(hits('x.css', '/' + '* via ' + HH + 'accent *' + '/ a { color: var(' + HH + 'accent); }'), 1);
  assert.strictEqual(hits('x.js', 'const s = "' + HH + 'flag"; ' + slash2 + ' plain words'), 0);
  assert.strictEqual(hits('x.css', 'a { color: var(' + HH + 'accent); }'), 0);
});

t('neutral example values only: no personal Windows user folder, Tailscale address or email address', () => {
  const sep = '(?:\\\\\\\\|\\\\|/)';
  const userDir = new RegExp('[A-Za-z]:' + sep + 'Users' + sep + '(?!' + PLACEHOLDER_USER + '(?:\\\\|/|"|$))[A-Za-z0-9._-]+');
  const tsNet = /\b([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)\.ts\.net\b/g;
  const email = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
  const bad = [];
  for (const f of b1CodeFiles().concat(b1FixtureFiles())) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    if (userDir.test(text)) bad.push(rel + ': a user folder other than the placeholder');
    for (const m of text.matchAll(tsNet)) if (m[2] !== PLACEHOLDER_TAILNET) bad.push(rel + ': a Tailscale address outside the placeholder tailnet');
    for (const m of text.matchAll(email)) if (!/(^|\.)example\.(com|org|net)$/.test(m[1]) && m[1] !== 'anthropic.com') bad.push(rel + ': an email address outside example.com');
  }
  assert.deepStrictEqual(bad, []);
  // The patterns catch what they are for.
  assert.ok(userDir.test('C:' + '\\\\' + 'Users' + '\\\\' + 'someone' + '\\\\' + 'x'));
  assert.ok(!userDir.test('C:' + '\\\\' + 'Users' + '\\\\' + PLACEHOLDER_USER + '\\\\' + 'x'));
  assert.strictEqual([...('https://box.othernet' + '.ts' + '.net').matchAll(tsNet)][0][2], 'othernet');
});

H.run('b1-text-rules', tests);
