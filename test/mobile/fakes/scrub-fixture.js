#!/usr/bin/env node
/**
 * Neutralise personal data in captured fixtures before they are committed.
 *
 * What: replaces the capturing machine's user name and host name (every case
 * variant) and the capturing session's scratch id with neutral placeholders
 * of the SAME length ("tester", "testhost", zeros; the id comes from the
 * B2_SCRATCH_DIR path), so the style runs of a
 * ScreenSnapshot line (column ranges) stay aligned with its text. Used by the
 * capture scripts on every JSON they save, and runnable by hand over files or
 * folders: node test/mobile/fakes/scrub-fixture.js <file or folder>...
 *
 * Why: the Workbook repository is public; real screens show absolute paths
 * under the user profile (C:\Users\<name>\...), the encoded project folder
 * (the same path with every separator written as a hyphen), and the host
 * name, none of which may be published.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Neutral stand ins, padded or cut to the length of what they replace. */
const USER_BASE = 'tester';
const HOST_BASE = 'testhost';
/** Shortest name worth replacing (shorter ones would hit ordinary words). */
const MIN_NAME_LEN = 3;
/** File types the folder walk rewrites. */
const TEXT_EXT_RE = /\.(json|jsonl|txt|md|js)$/i;
/** A UUID in a path segment (the capturing session's scratch folder). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A neutral word of exactly n characters.
 * @param {string} base
 * @param {number} n
 * @returns {string}
 */
function sameLength(base, n) {
  let s = base;
  while (s.length < n) s += 'x';
  return s.slice(0, n);
}

/**
 * Keep the case shape of the original (all upper, all lower, or as the base).
 * @param {string} original
 * @param {string} repl
 * @returns {string}
 */
function matchCase(original, repl) {
  if (original === original.toUpperCase()) return repl.toUpperCase();
  if (original === original.toLowerCase()) return repl.toLowerCase();
  return repl;
}

/**
 * The [needle, replacement] pairs for this machine, longest needle first.
 * @param {object} [o] - {users: string[], hosts: string[], ids: string[]} to override detection (tests)
 * @returns {Array<[string, string]>}
 */
function personalPairs(o = {}) {
  const users = new Set(o.users || []);
  const hosts = new Set(o.hosts || []);
  const ids = new Set(o.ids || []);
  if (!o.users) {
    try { users.add(os.userInfo().username); } catch (_) { /* no user info */ }
    if (process.env.USERNAME) users.add(process.env.USERNAME);
    if (process.env.USER) users.add(process.env.USER);
    const home = os.homedir();
    if (home) users.add(path.basename(home));
  }
  if (!o.hosts) {
    try { hosts.add(os.hostname()); } catch (_) { /* no host name */ }
    if (process.env.COMPUTERNAME) hosts.add(process.env.COMPUTERNAME);
  }
  if (!o.ids) {
    // The scratch folder of the capturing run (B2_SCRATCH_DIR) may hold a
    // session id in its path; screens that show the path show the id too.
    const m = UUID_RE.exec(String(process.env.B2_SCRATCH_DIR || ''));
    if (m) ids.add(m[0].toLowerCase());
  }
  const pairs = [];
  const addWord = (word, base) => {
    if (!word || word.length < MIN_NAME_LEN) return;
    for (const v of new Set([word, word.toLowerCase(), word.toUpperCase()])) pairs.push([v, matchCase(v, sameLength(base, v.length))]);
  };
  for (const u of users) addWord(u, USER_BASE);
  for (const h of hosts) addWord(h, HOST_BASE);
  for (const id of ids) {
    const zero = id.replace(/[0-9a-f]/gi, '0');
    pairs.push([id, zero]);
    // A wrapped screen line can split the id after its fourth group.
    const cut = id.lastIndexOf('-') + 1;
    pairs.push([id.slice(0, cut), zero.slice(0, cut)]);
    pairs.push([id.slice(cut), zero.slice(cut)]);
    pairs.push([id.slice(0, 8), zero.slice(0, 8)]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/**
 * Replace every needle in a string.
 * @param {string} s
 * @param {Array<[string, string]>} pairs
 * @returns {string}
 */
function scrubText(s, pairs) {
  let out = String(s);
  for (const [needle, repl] of pairs) if (out.includes(needle)) out = out.split(needle).join(repl);
  return out;
}

/**
 * Scrub every string (and key) of a JSON value.
 * @param {*} v
 * @param {Array<[string, string]>} pairs
 * @returns {*}
 */
function scrubValue(v, pairs) {
  if (typeof v === 'string') return scrubText(v, pairs);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, pairs));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[scrubText(k, pairs)] = scrubValue(x, pairs);
    return o;
  }
  return v;
}

/**
 * Scrub a file in place. Text files are rewritten as text so escaped JSON
 * (\\u sequences, the escaped backslashes of Windows paths) is handled too.
 * @param {string} file
 * @param {Array<[string, string]>} pairs
 * @returns {boolean} whether it changed
 */
function scrubFile(file, pairs) {
  const before = fs.readFileSync(file, 'utf8');
  let after = scrubText(before, pairs);
  // JSON escapes a backslash, so a path needle "C:\Users\x" appears as "C:\\Users\\x";
  // the plain words above already cover it because they hold no backslash.
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

/**
 * Scrub files and folders (recursively, text files only).
 * @param {string[]} targets
 * @param {Array<[string, string]>} [pairs]
 * @returns {string[]} changed files
 */
function scrubPaths(targets, pairs = personalPairs()) {
  const changed = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); return; }
    if (TEXT_EXT_RE.test(p) && path.basename(p) !== path.basename(__filename) && scrubFile(p, pairs)) changed.push(p);
  };
  for (const t of targets) walk(t);
  return changed;
}

module.exports = { personalPairs, scrubText, scrubValue, scrubFile, scrubPaths, sameLength };

if (require.main === module) {
  const targets = process.argv.slice(2);
  if (!targets.length) { console.log('usage: node scrub-fixture.js <file or folder>...'); process.exit(2); }
  const changed = scrubPaths(targets);
  for (const f of changed) console.log('scrubbed ' + f);
  console.log(changed.length + ' file(s) changed');
}
