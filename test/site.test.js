#!/usr/bin/env node
/**
 * Landing site gate.
 *
 * WHAT THIS PROTECTS
 *
 * site/ is deployed to GitHub Pages by .github/workflows/pages.yml and is the
 * first thing anyone sees. Nothing else in the suite looks at it, so this file
 * is the only thing standing between a bad edit and a live page. It is a pure
 * string and structure gate over four files on disk: no browser, no network,
 * no jsdom, no fixture. It runs in milliseconds and it is hermetic.
 *
 * THE SIX THINGS IT ASSERTS, AND WHY EACH ONE EARNED A CHECK
 *
 * 1. STRUCTURE. The document parses as balanced markup and every section the
 *    top bar and the deploy contract name is present by id. A missing id is
 *    silent in a browser: the anchor just does nothing.
 *
 * 2. THE ASSET CONTRACT. Every image, video and icon on the page is an
 *    ABSOLUTE raw.githubusercontent.com URL pinned to main, because the same
 *    files are referenced by the README, which npmjs.com renders with no
 *    repository context. Those URLs are produced by a separate pipeline
 *    (docs/marketing/MEDIA-CONTRACT.md) and this gate holds both sides to the
 *    same list of paths, so a rename in the pipeline breaks the build rather
 *    than the page. It also pins the small set of remote hosts the page is
 *    allowed to touch at all.
 *
 * 3. NO EM DASHES. A standing project rule. The Stop hook catches them in chat
 *    output; nothing was watching the files.
 *
 * 4. NO MOVING STATUS MARK, AND NO PILL WITH A DOT IN IT. DECISIONS.md 13.1:
 *    a state the system can sit in is a static shape, never motion, and the
 *    pill-plus-dot construction is banned in every form including static. This
 *    reproduces the structural test that gate G14 in scripts/do-not-break-gates.js
 *    applies to the application, against the site's own stylesheet, plus a
 *    markup check G14 has no reason to make: that no chip, pill or badge
 *    element contains a dot.
 *
 * 5. NO EXTERNAL SCRIPT. The page runs one first-party script and nothing
 *    else. A stylesheet from Google Fonts is allowed and is the only remote
 *    subresource that executes nothing.
 *
 * 6. METADATA AND IMAGE HYGIENE. The link-preview tags, the icons, and the
 *    width, height and alt on every image, so a share renders and the layout
 *    does not jump while the media loads.
 *
 * Created: 2026-08-18.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const HTML_PATH = path.join(SITE, 'index.html');
const CSS_PATH = path.join(SITE, 'styles.css');
const JS_PATH = path.join(SITE, 'main.js');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'pages.yml');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const css = fs.readFileSync(CSS_PATH, 'utf8');
const js = fs.readFileSync(JS_PATH, 'utf8');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, tallying rather than bailing so a single run
 * reports every problem at once.
 *
 * @param {string} name Human readable assertion name.
 * @param {() => void} fn Function that throws on failure.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m' + String.fromCharCode(10003) + '\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mx\x1b[0m ' + name);
    console.log('    \x1b[31m' + err.message + '\x1b[0m');
  }
}

/**
 * Throw with a message when a condition does not hold.
 *
 * @param {*} condition Value tested for truthiness.
 * @param {string} message Failure message.
 * @returns {void}
 */
function ok(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n  \x1b[1mLanding site: site/ and its Pages workflow\x1b[0m');
console.log('  ' + '-'.repeat(48));

/* ── 1. Structure ──────────────────────────────────────────────────────── */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * Walk the document's tags and confirm every non-void element closes, in
 * order. Comments, the doctype and the contents of script elements are
 * skipped, so a "<" inside a script body is never read as a tag.
 *
 * @param {string} source Full HTML text.
 * @returns {{depth: number, unclosed: string[]}} Final stack state.
 */
function tagBalance(source) {
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');

  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3];
    if (name === '!doctype') continue;
    if (VOID_ELEMENTS.has(name) || /\/$/.test(attrs.trim())) continue;
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        throw new Error('close </' + name + '> does not match open <' + (top || 'nothing') + '>');
      }
    } else {
      stack.push(name);
    }
  }
  return { depth: stack.length, unclosed: stack };
}

check('index.html parses as balanced markup', () => {
  const result = tagBalance(html);
  ok(result.depth === 0, 'unclosed elements: ' + result.unclosed.join(', '));
});

check('document declares a doctype, a language and a charset', () => {
  ok(/^<!DOCTYPE html>/i.test(html.trim()), 'missing <!DOCTYPE html>');
  ok(/<html lang="en">/.test(html), 'missing <html lang="en">');
  ok(/<meta charset="utf-8">/i.test(html), 'missing charset');
  ok(/<meta name="viewport" content="width=device-width/.test(html), 'missing viewport');
});

const REQUIRED_IDS = [
  'main', 'top', 'why', 'features', 'phone', 'codex', 'open-source', 'install',
  'chrome-toggle',
];

check('every required section id is present exactly once', () => {
  for (const id of REQUIRED_IDS) {
    const hits = html.match(new RegExp('id="' + id + '"', 'g')) || [];
    ok(hits.length === 1, 'id="' + id + '" appears ' + hits.length + ' times, expected 1');
  }
});

check('every top bar section link resolves to an id on the page', () => {
  const nav = /<nav class="sections"[\s\S]*?<\/nav>/.exec(html);
  ok(nav, 'section nav not found');
  const hrefs = (nav[0].match(/href="#([^"]+)"/g) || []).map((h) => h.slice(7, -1));
  ok(hrefs.length >= 4, 'expected at least four section links, found ' + hrefs.length);
  for (const id of hrefs) {
    ok(html.includes('id="' + id + '"'), 'section link #' + id + ' has no target');
  }
});

check('the two stylesheets and the one script are wired', () => {
  ok(/<link rel="stylesheet" href="styles\.css">/.test(html), 'styles.css not linked');
  ok(/<script src="main\.js" defer><\/script>/.test(html), 'main.js not loaded with defer');
});

/* ── 2. Asset contract ─────────────────────────────────────────────────── */

const ASSET_BASE = 'https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/';

// Every path underneath docs/media/ that this page is allowed to reference.
// Mirrors the asset table in docs/marketing/MEDIA-CONTRACT.md.
const CONTRACT = new Set([
  'hero.webp',
  'hero-poster.webp',
  'hero.mp4',
  'feature-sidebar.webp',
  'feature-terminal.webp',
  'feature-themes.webp',
  'feature-board.webp',
  'feature-phone.webp',
  'feature-codex.webp',
  'social/og.png',
  'brand/logo-mark.svg',
  'brand/favicon.svg',
  'brand/favicon-32.png',
  'brand/icon-180.png',
]);

check('every raw.githubusercontent URL is pinned to the media base on main', () => {
  const urls = html.match(/https:\/\/raw\.githubusercontent\.com\/[^"'\s)]+/g) || [];
  ok(urls.length > 0, 'no remote assets found at all, which cannot be right');
  for (const url of urls) {
    ok(url.startsWith(ASSET_BASE), 'not under the pinned media base: ' + url);
  }
});

check('every referenced asset path is in the media contract', () => {
  const urls = html.match(/https:\/\/raw\.githubusercontent\.com\/[^"'\s)]+/g) || [];
  const seen = new Set();
  for (const url of urls) {
    const rel = url.slice(ASSET_BASE.length);
    seen.add(rel);
    ok(CONTRACT.has(rel), 'asset not in the contract list: ' + rel);
  }
  // The six feature clips and the hero are the page's reason to exist; a
  // silent drop of one would pass every other check here. hero-poster.webp is
  // deliberately absent from this list: it is never a src, it is named by
  // data-poster and resolved at runtime, and the check below pins it.
  for (const required of [
    'hero.webp', 'hero.mp4', 'feature-sidebar.webp',
    'feature-terminal.webp', 'feature-themes.webp', 'feature-board.webp',
    'feature-phone.webp', 'feature-codex.webp', 'social/og.png',
  ]) {
    ok(seen.has(required), 'contract asset never referenced: ' + required);
  }
});

check('every data-asset value matches the URL on its own element', () => {
  const tags = html.match(/<(?:img|a)\b[^>]*data-asset="[^"]*"[^>]*>/g) || [];
  ok(tags.length >= 8, 'expected at least eight tagged assets, found ' + tags.length);
  for (const tag of tags) {
    const name = /data-asset="([^"]+)"/.exec(tag)[1];
    const url = /(?:src|href)="([^"]+)"/.exec(tag);
    ok(url, 'data-asset element with no src or href: ' + tag.slice(0, 80));
    ok(
      url[1] === ASSET_BASE + name,
      'data-asset "' + name + '" does not match its URL "' + url[1] + '"'
    );
  }
});

check('the hero carries a poster fallback that is itself in the contract', () => {
  const poster = /data-poster="([^"]+)"/.exec(html);
  ok(poster, 'no data-poster on the hero image');
  ok(CONTRACT.has(poster[1]), 'poster not in the contract: ' + poster[1]);
});

check('only the allowed remote hosts appear anywhere in the page', () => {
  const ALLOWED = new Set([
    'raw.githubusercontent.com',
    'img.shields.io',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'github.com',
    'www.npmjs.com',
    'therealarthur.github.io',
  ]);
  // Attribute values only. A URL in the visible copy (the loopback address the
  // app starts on) is prose, not a subresource, and must not trip this.
  const hosts = new Set(
    (html.match(/(?:href|src|content)="https?:\/\/([a-z0-9.-]+)/gi) || [])
      .map((u) => u.replace(/^(?:href|src|content)="https?:\/\//i, ''))
  );
  ok(hosts.size > 0, 'no absolute URLs in any attribute, which cannot be right');
  for (const host of hosts) {
    ok(ALLOWED.has(host), 'unexpected remote host: ' + host);
  }
});

check('main.js and styles.css agree with the same asset base', () => {
  ok(
    js.includes("'https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media'"),
    'main.js does not carry the pinned asset base'
  );
  ok(/\?dev/.test(js), 'main.js lost the dev asset mode');
  ok(!/raw\.githubusercontent/.test(css), 'styles.css must not reference remote assets');
});

/* ── 3. No em dashes ───────────────────────────────────────────────────── */

// Built from escapes rather than written as literals, so this file does not
// itself carry the two characters it exists to forbid. Gate G12a in
// scripts/do-not-break-gates.js counts occurrences across the tree and would
// otherwise score this gate's own source as a regression.
const EM_DASH = new RegExp('[\\u2014\\u2015]');

check('no em dash or horizontal bar in any site file or the workflow', () => {
  for (const [name, text] of [
    ['site/index.html', html], ['site/styles.css', css],
    ['site/main.js', js], ['.github/workflows/pages.yml', workflow],
  ]) {
    const index = text.search(EM_DASH);
    ok(
      index === -1,
      name + ' contains an em dash at offset ' + index + ': ' +
        JSON.stringify(text.slice(Math.max(0, index - 40), index + 40))
    );
  }
});

check('no double hyphen in the page text a reader actually sees', () => {
  // Custom properties, HTML comments and CLI flags all legitimately carry a
  // double hyphen, so the scan runs over text nodes only: comments, style,
  // script and every tag are removed first.
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  ok(!text.includes('--'), 'double hyphen in visible copy near: ' +
    JSON.stringify(text.slice(Math.max(0, text.indexOf('--') - 50), text.indexOf('--') + 50)));
});

/* ── 4. Static status marks, and no pill with a dot ────────────────────── */

// The same identifier segments gate G14 treats as naming a status mark.
const STATUS_MARK_TOKENS = new Set([
  'dot', 'dots', 'badge', 'badges', 'pill', 'pills', 'chip', 'chips',
  'tristate', 'notify', 'liveness', 'status', 'mark', 'marks',
]);
const CIRCLE_RADIUS = /border-radius:\s*(?:50%|var\(\s*--radius-(?:avatar|pill)\s*\))/;
const ANIMATION_DECL = /animation(?:-name)?\s*:\s*([^;}]+)/g;

/**
 * Split a stylesheet into leaf rules with their selector and declarations,
 * skipping anything inside an at-rule prelude of its own.
 *
 * @param {string} source Stylesheet text with comments already removed.
 * @returns {Array<{selector: string, block: string}>} Leaf rules.
 */
function leafRules(source) {
  const out = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      stack.push({ prelude: buf.trim().replace(/\s+/g, ' '), start: i + 1 });
      buf = '';
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame && !/^@/.test(frame.prelude)) {
        out.push({ selector: frame.prelude, block: source.slice(frame.start, i) });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/**
 * Whether a selector names something that reports a state.
 *
 * @param {string} selector Full selector text.
 * @returns {boolean} True when any identifier segment is a status-mark token.
 */
function isStatusMarkSelector(selector) {
  return selector
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => STATUS_MARK_TOKENS.has(token));
}

const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

check('no status mark and no circle consumes an animation (gate G14 shape)', () => {
  const offenders = [];
  for (const rule of leafRules(cssNoComments)) {
    ANIMATION_DECL.lastIndex = 0;
    let animates = false;
    let m;
    while ((m = ANIMATION_DECL.exec(rule.block)) !== null) {
      if (!/^\s*none\s*$/.test(m[1])) animates = true;
    }
    if (!animates) continue;
    if (isStatusMarkSelector(rule.selector) || CIRCLE_RADIUS.test(rule.block)) {
      offenders.push(rule.selector.slice(0, 70));
    }
  }
  ok(offenders.length === 0, 'moving status marks: ' + offenders.join(' | '));
});

check('inline styles never draw a circle and animate it at once', () => {
  const inline = html.match(/style\s*=\s*"([^"]*)"/g) || [];
  for (const attr of inline) {
    const decl = attr.slice(attr.indexOf('"') + 1, -1);
    const animates = /animation(?:-name)?\s*:\s*(?!\s*none)/.test(decl);
    ok(!(animates && CIRCLE_RADIUS.test(decl)), 'inline moving mark: ' + decl.slice(0, 70));
  }
});

check('no chip, pill or badge element contains a dot', () => {
  const re = /class="[^"]*\b(?:chip|pill|badge)[^"]*"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const window = html.slice(m.index, m.index + 400);
    const end = window.indexOf('</span>');
    const inner = end === -1 ? window : window.slice(0, end);
    ok(
      !/\bdot\b|-dot\b|\bdot-/.test(inner),
      'a chip, pill or badge encloses a dot: ' + inner.slice(0, 90)
    );
  }
  ok(!/chip-dot|status-pill|pill-dot|badge-dot/.test(html), 'banned pill-plus-dot class present');
  ok(!/chip-dot|status-pill|pill-dot|badge-dot/.test(css), 'banned pill-plus-dot class in the stylesheet');
});

check('the two status shapes are drawn statically, disc and ring', () => {
  ok(/\.mark-running\s*\{[^}]*background:\s*var\(--app-text-green\)/.test(cssNoComments),
    'the running mark is not a filled green disc');
  ok(/\.mark-waiting\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--app-text-yellow\)/.test(cssNoComments),
    'the waiting mark is not a yellow ring');
  ok(html.includes('mark mark-running') && html.includes('mark mark-waiting'),
    'the page never uses the two shapes it defines');
});

/* ── 5. No external script ─────────────────────────────────────────────── */

check('every script is first party', () => {
  const srcs = (html.match(/<script\b[^>]*\bsrc="([^"]+)"/g) || [])
    .map((tag) => /src="([^"]+)"/.exec(tag)[1]);
  ok(srcs.length === 1, 'expected exactly one script src, found ' + srcs.length);
  for (const src of srcs) {
    ok(!/^https?:|^\/\//.test(src), 'external script: ' + src);
  }
});

check('the only remote stylesheet is the font sheet', () => {
  const links = (html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) || []);
  const remote = links.filter((l) => /href="https?:/.test(l));
  ok(remote.length === 1, 'expected one remote stylesheet, found ' + remote.length);
  ok(/fonts\.googleapis\.com/.test(remote[0]), 'unexpected remote stylesheet: ' + remote[0]);
  ok(/Plus\+Jakarta\+Sans/.test(remote[0]) && /JetBrains\+Mono/.test(remote[0]),
    'the font sheet does not request both project faces');
});

/* ── 6. Metadata and image hygiene ─────────────────────────────────────── */

const REQUIRED_META = [
  ['description', /<meta name="description" content="[^"]{60,}">/],
  ['canonical', /<link rel="canonical" href="https:\/\/[^"]+">/],
  ['og:type', /<meta property="og:type" content="website">/],
  ['og:title', /<meta property="og:title" content="[^"]+">/],
  ['og:description', /<meta property="og:description" content="[^"]+">/],
  ['og:url', /<meta property="og:url" content="https:\/\/[^"]+">/],
  ['og:image', /<meta property="og:image" content="[^"]*docs\/media\/social\/og\.png">/],
  ['og:image:width', /<meta property="og:image:width" content="1200">/],
  ['og:image:height', /<meta property="og:image:height" content="630">/],
  ['twitter:card', /<meta name="twitter:card" content="summary_large_image">/],
  ['twitter:title', /<meta name="twitter:title" content="[^"]+">/],
  ['twitter:image', /<meta name="twitter:image" content="[^"]*docs\/media\/social\/og\.png">/],
  ['icon svg', /<link rel="icon" type="image\/svg\+xml" href="[^"]*brand\/favicon\.svg">/],
  ['icon png', /<link rel="icon" type="image\/png" sizes="32x32" href="[^"]*brand\/favicon-32\.png">/],
  ['theme-color light', /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/],
  ['theme-color dark', /<meta name="theme-color" content="#191919" media="\(prefers-color-scheme: dark\)">/],
];

check('every link preview and icon tag is present', () => {
  for (const [name, re] of REQUIRED_META) {
    ok(re.test(html), 'missing or malformed: ' + name);
  }
  ok(/<title>[^<]{20,}<\/title>/.test(html), 'missing or too short a title');
});

check('every image reserves its box and describes itself', () => {
  const imgs = html.match(/<img\b[^>]*>/g) || [];
  ok(imgs.length >= 9, 'expected at least nine images, found ' + imgs.length);
  for (const img of imgs) {
    ok(/\bwidth="\d+"/.test(img), 'image without an explicit width: ' + img.slice(0, 90));
    ok(/\bheight="\d+"/.test(img), 'image without an explicit height: ' + img.slice(0, 90));
    ok(/\balt="/.test(img), 'image without an alt attribute: ' + img.slice(0, 90));
  }
});

check('every image below the hero is lazily loaded', () => {
  const imgs = html.match(/<img\b[^>]*>/g) || [];
  const eager = imgs.filter((img) => !/loading="lazy"/.test(img));
  // The hero is deliberately eager with fetchpriority, and the top bar mark is
  // in the first paint. Everything else has to wait its turn.
  ok(eager.length <= 2, 'too many eagerly loaded images: ' + eager.length);
  for (const img of eager) {
    ok(
      /fetchpriority="high"/.test(img) || /brand\/logo-mark\.svg/.test(img),
      'eager image that is neither the hero nor the top bar mark: ' + img.slice(0, 90)
    );
  }
});

/* ── 7. Theme, motion and the deploy workflow ──────────────────────────── */

check('light and dark are both authored, and an explicit choice wins', () => {
  ok(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-chrome="light"\]\)/.test(css),
    'no system-preference dark branch guarded against an explicit light choice');
  ok(/:root\[data-chrome="dark"\] \{/.test(css), 'no explicit dark branch');
  ok(/localStorage/.test(js) && /mw-chrome/.test(js), 'the choice is not persisted');
  ok(/mw-chrome/.test(html), 'the pre-paint read of the stored choice is missing');
});

check('reduced motion is honoured in the stylesheet and for the animated hero', () => {
  ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'no reduced-motion block in the CSS');
  ok(/prefers-reduced-motion: reduce/.test(js), 'main.js never reads the motion preference');
  ok(/@media \(prefers-reduced-motion: no-preference\)/.test(css),
    'smooth scrolling should be gated on no-preference rather than removed later');
});

check('no transition or animation on the page runs longer than 300ms', () => {
  const durations = cssNoComments.match(/(?:transition|animation)[^;}]*?(\d+)ms/g) || [];
  for (const decl of durations) {
    const values = (decl.match(/(\d+)ms/g) || []).map((v) => parseInt(v, 10));
    for (const value of values) {
      ok(value <= 300, 'motion longer than 300ms: ' + decl.trim());
    }
  }
});

check('the Pages workflow deploys site/ with the right triggers and permissions', () => {
  ok(/^name: Pages$/m.test(workflow), 'workflow is not named Pages');
  ok(/branches: \[main\]/.test(workflow), 'not triggered on main');
  ok(/- 'site\/\*\*'/.test(workflow), 'site/** is not a path trigger');
  ok(/- 'docs\/media\/\*\*'/.test(workflow), 'docs/media/** is not a path trigger');
  ok(/^ {2}workflow_dispatch:$/m.test(workflow), 'no manual trigger');
  ok(/pages: write/.test(workflow), 'missing pages: write');
  ok(/id-token: write/.test(workflow), 'missing id-token: write');
  ok(/group: pages/.test(workflow), 'concurrency group is not "pages"');
  ok(/cancel-in-progress: false/.test(workflow), 'a Pages deploy must not be cancelled mid flight');
  ok(/actions\/configure-pages@v6/.test(workflow), 'configure-pages is not on v6');
  ok(/actions\/upload-pages-artifact@v5/.test(workflow), 'upload-pages-artifact is not on v5');
  ok(/actions\/deploy-pages@v5/.test(workflow), 'deploy-pages is not on v5');
  ok(/actions\/checkout@v7/.test(workflow), 'checkout is not on v7');
  ok(/path: site/.test(workflow), 'the artifact does not point at site/');
  ok(/environment:\s*\n\s*name: github-pages/.test(workflow), 'no github-pages environment');
});

check('site/.nojekyll exists so no path is dropped by a Jekyll pass', () => {
  ok(fs.existsSync(path.join(SITE, '.nojekyll')), 'site/.nojekyll is missing');
});

check('the February image set is still on disk and no longer referenced', () => {
  // Code preservation: the old screenshots stay, but nothing points at them.
  ok(fs.existsSync(path.join(SITE, 'images')), 'site/images was deleted');
  ok(!/images\//.test(html), 'the superseded site/images set is still referenced');
});

console.log('  ' + '-'.repeat(48));
console.log('  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed > 0 ? 1 : 0);
