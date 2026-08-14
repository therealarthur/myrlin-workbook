#!/usr/bin/env node
/**
 * Round 2 gate: a deploy actually reaches the device.
 *
 * THE BUG THIS FILE EXISTS FOR. The user reported "the mobile view is still
 * the old layout" after a deploy that had already landed on the served tree.
 * The first hypothesis was a duplicate stylesheet link, one bare
 * `styles-mobile.css` shadowing the cache-busted one. That was a FALSE
 * POSITIVE: the duplicate matches were HTML comments discussing the file by
 * name, and the parsed markup has exactly one reference per asset. The real
 * hole was one layer up. Every asset in this tree is versioned through a `?v=`
 * query inside index.html, so a fresh document always pulls fresh assets, but
 * the DOCUMENT itself was served with express.static's default
 * `Cache-Control: public, max-age=0`. `public` invites a SHARED cache to store
 * it, and this app is reached from a phone through a Cloudflare tunnel. One
 * stale index.html held at an edge pins every asset URL inside it at the old
 * version, so the whole application stays old no matter how often the phone is
 * refreshed.
 *
 * Three invariants, because the failure needed all three to be true at once:
 *
 *   1. THE DOCUMENT IS NEVER STORED. server.js sets no-store on .html.
 *   2. ONE REFERENCE PER ASSET. Two references mean one silently wins.
 *   3. EVERY APP ASSET IS VERSIONED. An unbusted asset cannot be evicted by a
 *      deploy; vendored bundles are exempt and the exemption is asserted, so
 *      it stays a deliberate carve-out rather than a hole that grows.
 *
 * Invariants 2 and 3 are also enforced live by gate G15. They are duplicated
 * here because `npm test` is what runs in CI-shaped checks and a contributor
 * should not have to know that a second command exists.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');

let passed = 0;
let failed = 0;
const queue = [];

/**
 * Register a named assertion.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void} fn Function that throws on failure.
 */
function check(name, fn) {
  queue.push({ name, fn });
}

function runQueue() {
  for (const { name, fn } of queue) {
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
}

/**
 * Parse index.html the way a browser does: comments are not markup.
 *
 * @returns {string[]} Every local stylesheet href and script src, in order.
 */
function localAssetRefs() {
  const stripped = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
  const refs = [];
  for (const m of stripped.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
    if (/rel="stylesheet"/.test(m[0])) refs.push(m[1]);
  }
  for (const m of stripped.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    refs.push(m[1]);
  }
  return refs.filter((href) => !/^(https?:)?\/\//i.test(href));
}

console.log('\n  \x1b[1mRound 2: asset delivery\x1b[0m');
console.log('  ' + '─'.repeat(42));

check('the HTML document is served no-store, so no shared cache can pin it', () => {
  assert.ok(
    /express\.static\([\s\S]{0,400}?setHeaders/.test(serverSrc),
    'express.static must install a setHeaders hook'
  );
  const hook = serverSrc.slice(serverSrc.indexOf('setHeaders'), serverSrc.indexOf('setHeaders') + 700);
  assert.ok(/\\\.html\?\$|\.html\?\$/i.test(hook) || /html/i.test(hook),
    'the hook must test for an HTML file path');
  assert.ok(/no-store/.test(hook), 'the document must be sent no-store');
  assert.ok(/must-revalidate/.test(hook), 'the document must be sent must-revalidate');
  assert.ok(/private/.test(hook),
    'an authenticated shell must not be marked public for shared caches');
});

check('versioned assets keep their own caching: only HTML is special-cased', () => {
  const hook = serverSrc.slice(serverSrc.indexOf('setHeaders'), serverSrc.indexOf('setHeaders') + 700);
  // The rule must be INSIDE a conditional. A blanket no-store would defeat the
  // whole point of the ?v= scheme and re-download xterm on every navigation.
  assert.ok(/if\s*\(/.test(hook), 'the no-store rule must be conditional on the file type');
});

check('every local asset is referenced exactly once', () => {
  const counts = new Map();
  for (const href of localAssetRefs()) {
    const base = href.split('?')[0];
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([b, n]) => b + ' x' + n);
  assert.deepStrictEqual(dupes, [], 'duplicate asset references: ' + dupes.join(', '));
});

check('every first-party asset carries a cachebuster', () => {
  const bare = localAssetRefs()
    .filter((href) => !/^vendor\//.test(href.split('?')[0]))
    .filter((href) => !/\?v=[A-Za-z0-9._-]+$/.test(href));
  assert.deepStrictEqual(bare, [], 'unbusted first-party assets: ' + bare.join(', '));
});

check('the vendor exemption is a carve-out, not a hole', () => {
  const vendor = localAssetRefs().filter((href) => /^vendor\//.test(href.split('?')[0]));
  assert.ok(vendor.length > 0, 'the exemption should describe assets that actually exist');
  for (const href of vendor) {
    assert.ok(
      /^vendor\/[A-Za-z0-9._@-]+\//.test(href) || /^vendor\/[A-Za-z0-9._@-]+\.js$/.test(href),
      'a vendor asset must live under a vendored directory: ' + href
    );
  }
});

check('the mobile stylesheet is linked once, versioned, and after the desktop one', () => {
  const refs = localAssetRefs();
  const desktop = refs.findIndex((h) => h.startsWith('styles.css'));
  const mobile = refs.findIndex((h) => h.startsWith('styles-mobile.css'));
  assert.ok(desktop > -1 && mobile > -1, 'both stylesheets must be linked');
  assert.ok(mobile > desktop,
    'styles-mobile.css must come after styles.css: its phone rules override by order');
  assert.strictEqual(refs.filter((h) => h.startsWith('styles-mobile.css')).length, 1,
    'exactly one mobile stylesheet reference');
});

check('the two scripts that shipped bare are now versioned', () => {
  // provider-specs.js and schedules.js were the only first-party assets in the
  // tree with no ?v= at the end of round 1. Named explicitly so a future edit
  // that drops the query is caught by name rather than by a generic count.
  for (const name of ['provider-specs.js', 'schedules.js']) {
    assert.ok(
      new RegExp(name.replace('.', '\\.') + '\\?v=[A-Za-z0-9._-]+').test(indexHtml),
      name + ' must carry a cachebuster'
    );
  }
});

runQueue();
console.log('\n  ' + '─'.repeat(42));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('  ' + '─'.repeat(42) + '\n');
process.exit(failed > 0 ? 1 : 0);
