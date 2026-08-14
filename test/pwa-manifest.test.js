/**
 * test/pwa-manifest.test.js: the installable shell, asserted rather than assumed.
 *
 * Notion restyle P12.6, MOBILE-EXPERIENCE F and BUILD-CONTRACT P12.1.
 *
 * The bug this suite exists for is the one BUILD-CONTRACT P12.1 names out
 * loud: "both entries currently point at the same /logo.png with different
 * declared sizes, so one is a lie". It was worse than that. logo.png is
 * 691x361, so BOTH declarations were lies, and the asset is not even square,
 * which means neither an Android launcher nor a splash screen could use it
 * without distorting the mark. Nothing failed loudly; the icon just looked
 * wrong on a device nobody was testing on.
 *
 * So the checks here read the PNG headers rather than trusting the JSON. A
 * declared size that does not match the file's own IHDR fails, which is the
 * only form of this check that could have caught the original.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, recording rather than throwing.
 *
 * @param {string} name - What is being asserted.
 * @param {Function} fn - Body; throws to fail.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name + '\n        ' + err.message);
  }
}

/**
 * Read a PNG's intrinsic dimensions straight out of its IHDR chunk, which
 * begins at byte 16 of every valid PNG.
 *
 * @param {string} file - Path relative to the public root, leading slash ok.
 * @returns {string} "WxH".
 */
function pngSize(file) {
  const buf = fs.readFileSync(path.join(PUBLIC, file.replace(/^\//, '')));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', file + ' is not a PNG');
  return buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20);
}

console.log('\n  PWA manifest and installability');

check('the manifest parses and carries every field an install prompt needs', () => {
  for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display',
    'theme_color', 'background_color', 'orientation', 'icons']) {
    assert.ok(manifest[key], 'manifest is missing ' + key);
  }
});

check('display is standalone, which is what the iOS tags also promise', () => {
  assert.strictEqual(manifest.display, 'standalone');
});

check('EVERY icon file exists and is EXACTLY the size it declares', () => {
  assert.ok(manifest.icons.length >= 4, 'an install needs more than a favicon');
  for (const icon of manifest.icons) {
    assert.strictEqual(pngSize(icon.src), icon.sizes,
      icon.src + ' declares ' + icon.sizes + ' and is not that size');
  }
});

check('no two icon entries share a source file', () => {
  const sources = manifest.icons.map(i => i.src + '|' + i.purpose);
  assert.strictEqual(new Set(sources).size, sources.length,
    'two entries pointing at one file is how the 192/512 lie happened');
});

check('there is a real 512 for the splash and a real maskable for Android', () => {
  const any512 = manifest.icons.find(i => i.sizes === '512x512' && i.purpose === 'any');
  const maskable = manifest.icons.find(i => i.purpose === 'maskable');
  assert.ok(any512, 'no 512x512 any-purpose icon');
  assert.ok(maskable, 'no maskable icon');
  assert.notStrictEqual(any512.src, maskable.src,
    'a maskable icon needs its own safe-zone padding, so it cannot be the same file');
});

check('the manifest ground matches the DEFAULT chrome, not a leftover palette', () => {
  // index.html stamps data-chrome="light" pre-paint, so the splash a user sees
  // before any script runs is the light canvas. The old manifest said #1e1e2e,
  // the Catppuccin Mocha ground, which flashed dark then repainted white.
  assert.match(html, /data-chrome="light"/);
  assert.strictEqual(manifest.background_color.toLowerCase(), '#ffffff');
  assert.strictEqual(manifest.theme_color.toLowerCase(), '#ffffff');
});

check('the runtime keeps theme-color on the ACTIVE chrome, both tags', () => {
  // The static pair covers first paint; syncThemeColorMeta rewrites both after
  // an explicit chrome toggle, which is allowed to disagree with the OS.
  assert.match(html, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#191919" media="\(prefers-color-scheme: dark\)">/);
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.ok(app.includes("document.querySelectorAll('meta[name=\"theme-color\"]')"),
    'the sync must rewrite BOTH tags; a querySelector would leave one stale');
  assert.ok(app.includes("getPropertyValue('--app-bg-primary')"),
    'the status bar sits over the chrome canvas, not over the sidebar');
});

check('iOS gets the tags Safari actually reads for a standalone launch', () => {
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Workbook">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180"/);
  assert.strictEqual(pngSize('apple-touch-icon.png'), '180x180');
});

check('status-bar-style stays default until the safe-area header is verified', () => {
  // P12.2's deferral, kept honest: black-translucent takes the status bar out
  // of the flow and would slide the 44px header under the clock.
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/);
  // Scoped to the TAGS, not to the file: the comment above them names the
  // deferred value on purpose, and a check that cannot tell a decision from
  // its explanation is a check that punishes writing the reason down.
  const statusBarTags = html.match(/<meta name="apple-mobile-web-app-status-bar-style"[^>]*>/g) || [];
  assert.strictEqual(statusBarTags.length, 1, 'exactly one status-bar-style tag');
  assert.ok(!statusBarTags[0].includes('black-translucent'),
    'black-translucent is deferred until the G.5 device script has run');
});

check('the service worker is a no-op, and nothing about that is accidental', () => {
  // P12.3's caching service worker is OUT OF SCOPE by the orchestrator's P12
  // ruling and is recorded as DV-P12-3. The pre-existing stub stays because it
  // is registered and removing a registered worker strands installed clients.
  // What this asserts is that the stub cannot cache: no cache API, and a fetch
  // handler that never calls respondWith. A worker that started caching would
  // serve stale ?v= assets and break gate G10's whole premise.
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.ok(!/caches\./.test(sw), 'the stub must not touch the Cache API');
  assert.ok(!/respondWith/.test(sw), 'the stub must not answer any request');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total\n');
if (failed) process.exit(1);
