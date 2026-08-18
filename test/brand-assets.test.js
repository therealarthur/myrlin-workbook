/**
 * test/brand-assets.test.js: the brand vector set, asserted rather than assumed.
 *
 * The bug this suite exists for is the one docs/marketing/RESEARCH-2026-08-18.md section
 * 3.8 found: docs/images/logo-animated.svg is not a vector at all. It is a 70 KB wrapper
 * around a base64 238x192 PNG, with zero <path> elements, and nothing in the repo said so.
 * Every "512px app icon" derived from it was a soft 2.7x upscale, and no check failed.
 *
 * So these checks read the files rather than trusting their extensions. An .svg that
 * carries a raster fails. A PNG whose IHDR disagrees with its filename fails. A WebP that
 * encoded a single frame, or that does not loop, fails. And the four silhouette paths are
 * compared byte for byte across every file that draws the mark, because five hand-authored
 * copies of one shape is exactly the shape of a future drift bug.
 *
 * Hermetic: pure file reads. No sharp, no browser, no network. PNG and WebP headers are
 * parsed directly, the same way test/pwa-manifest.test.js reads IHDR, so `npm test` never
 * depends on a native image binding being installed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readWebpInfo } = require('../scripts/brand/webp-info');

/** Two hyphens, built rather than typed: the project bans the literal sequence in source. */
const DOUBLE_HYPHEN = '-'.repeat(2);

const ROOT = path.join(__dirname, '..');
const BRAND = path.join(ROOT, 'docs', 'media', 'brand');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, recording rather than throwing so the whole sheet reports.
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
 * Read a file inside docs/media/brand as UTF-8 text.
 *
 * @param {string} file - File name.
 * @returns {string} Contents.
 */
function text(file) {
  return fs.readFileSync(path.join(BRAND, file), 'utf8');
}

/**
 * Byte size of a file inside docs/media/brand.
 *
 * @param {string} file - File name.
 * @returns {number} Bytes.
 */
function bytes(file) {
  return fs.statSync(path.join(BRAND, file)).size;
}

/**
 * Intrinsic size of a PNG, straight out of the IHDR chunk that begins at byte 16 of
 * every valid PNG. Reading the header rather than the name is the only version of this
 * check that could catch a file that was resized by hand.
 *
 * @param {string} file - File name inside docs/media/brand.
 * @returns {string} "WxH".
 */
function pngSize(file) {
  const buf = fs.readFileSync(path.join(BRAND, file));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', file + ' is not a PNG');
  return buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20);
}

/**
 * Pull one element's `d` attribute out of an SVG by element id.
 *
 * @param {string} svg - SVG source.
 * @param {string} id - Element id.
 * @returns {string} The path data.
 */
function pathData(svg, id) {
  const el = new RegExp('<path[^>]*\\bid="' + id + '"[^>]*>', 's').exec(svg);
  assert.ok(el, 'no <path id="' + id + '"> found');
  const d = /\bd="([^"]+)"/s.exec(el[0]);
  assert.ok(d, 'path #' + id + ' has no d attribute');
  return d[1];
}

/**
 * Every XML comment payload in a document.
 *
 * A double hyphen inside an XML comment is a hard parse error, not a warning. It blanked
 * both lockups during authoring (librsvg refused the file, Chromium rendered an empty
 * root) and the only symptom was an image that silently occupied no space. Since the
 * project also bans double hyphens in prose, one scan covers both rules.
 *
 * @param {string} src - Document source.
 * @returns {string[]} Comment bodies, without the delimiters.
 */
function comments(src) {
  return Array.from(src.matchAll(/<!--([\s\S]*?)-->/g)).map((m) => m[1]);
}

const VECTORS = ['logo.svg', 'logo-mark.svg', 'favicon.svg', 'logo-lockup-light.svg', 'logo-lockup-dark.svg'];
const SVG_BUDGETS = {
  'logo.svg': 20 * 1024,
  'logo-mark.svg': 10 * 1024,
  'favicon.svg': 10 * 1024,
  'logo-lockup-light.svg': 20 * 1024,
  'logo-lockup-dark.svg': 20 * 1024,
};
const RASTERS = {
  'icon-512.png': { dims: '512x512', budget: 60 * 1024 },
  'icon-192.png': { dims: '192x192', budget: 20 * 1024 },
  'icon-180.png': { dims: '180x180', budget: 20 * 1024 },
  'icon-maskable-512.png': { dims: '512x512', budget: 60 * 1024 },
  'favicon-32.png': { dims: '32x32', budget: 4 * 1024 },
  'favicon-16.png': { dims: '16x16', budget: 2 * 1024 },
};

console.log('\n  Brand vector set');

// ================================================================ masters exist

for (const file of VECTORS) {
  check(file + ' exists', () => {
    assert.ok(fs.existsSync(path.join(BRAND, file)), 'missing ' + file);
  });
}

check('logo-anim.html exists', () => {
  assert.ok(fs.existsSync(path.join(BRAND, 'logo-anim.html')));
});

check('docs/media/brand/README.md exists and names every shipped file', () => {
  const readme = text('README.md');
  for (const file of [...VECTORS, ...Object.keys(RASTERS), 'logo-anim.webp', 'logo-anim.mp4', 'logo-anim.html']) {
    assert.ok(readme.includes(file), 'README does not mention ' + file);
  }
});

// ======================================================= the masters are vectors

for (const file of VECTORS) {
  check(file + ' carries no raster', () => {
    const svg = text(file);
    assert.ok(!/<image[\s>]/i.test(svg), file + ' contains an <image> element');
    assert.ok(!/;base64,/i.test(svg), file + ' contains a base64 payload');
    assert.ok(/<path[\s>]|<rect[\s>]/i.test(svg), file + ' has no drawn shapes at all');
  });
}

for (const file of VECTORS) {
  check(file + ' uses no filter and embeds no font binary', () => {
    const svg = text(file);
    // Filters resample badly at 16px and are dropped by several rasterisers outright.
    assert.ok(!/<filter[\s>]/i.test(svg), file + ' declares a <filter>');
    assert.ok(!/@font-face/i.test(svg), file + ' embeds an @font-face');
    assert.ok(!/\.(woff2?|ttf|otf)\b/i.test(svg), file + ' references a font binary');
  });
}

for (const file of [...VECTORS, 'logo-anim.html']) {
  check(file + ' has no double hyphen inside a comment', () => {
    for (const body of comments(text(file))) {
      assert.ok(!body.includes(DOUBLE_HYPHEN), file + ' comment contains a double hyphen: ' + body.trim().slice(0, 60));
    }
  });
}

// ============================================================== square viewBoxes

for (const file of ['logo.svg', 'favicon.svg', 'logo-mark.svg']) {
  check(file + ' has a square 0 0 512 512 viewBox', () => {
    const vb = /viewBox="([^"]+)"/.exec(text(file));
    assert.ok(vb, file + ' has no viewBox');
    const [minX, minY, w, h] = vb[1].trim().split(/\s+/).map(Number);
    assert.strictEqual(minX, 0, file + ' viewBox minX');
    assert.strictEqual(minY, 0, file + ' viewBox minY');
    assert.strictEqual(w, h, file + ' viewBox is ' + w + 'x' + h + ', not square');
    assert.strictEqual(w, 512, file + ' viewBox is ' + w + ' wide, expected 512');
  });
}

check('the lockups are horizontal and share one viewBox', () => {
  const light = /viewBox="([^"]+)"/.exec(text('logo-lockup-light.svg'))[1];
  const dark = /viewBox="([^"]+)"/.exec(text('logo-lockup-dark.svg'))[1];
  assert.strictEqual(light, dark, 'the two lockups disagree on their viewBox');
  const [, , w, h] = light.trim().split(/\s+/).map(Number);
  assert.ok(w > h * 3, 'lockup viewBox ' + w + 'x' + h + ' is not a horizontal lockup');
});

// ================================================================ size budgets

for (const [file, budget] of Object.entries(SVG_BUDGETS)) {
  check(file + ' is under ' + budget / 1024 + ' KB', () => {
    const size = bytes(file);
    assert.ok(size <= budget, file + ' is ' + (size / 1024).toFixed(1) + ' KB, budget ' + budget / 1024 + ' KB');
  });
}

// ================================================== geometry is one shape, not five

const master = text('logo.svg');
const SILHOUETTE = {
  brim: pathData(master, 'brim'),
  crown: pathData(master, 'crown'),
  tip: pathData(master, 'tip'),
  band: pathData(master, 'band'),
};

check('every silhouette path in logo.svg is real geometry', () => {
  for (const [name, d] of Object.entries(SILHOUETTE)) {
    assert.ok(d.length > 40, name + ' path data looks empty: ' + d);
    assert.ok(/^M/.test(d), name + ' path does not start with a moveto');
    assert.ok(/[Zz]\s*$/.test(d), name + ' path is not closed');
  }
});

check('favicon.svg reuses logo.svg geometry byte for byte', () => {
  const svg = text('favicon.svg');
  for (const [name, d] of Object.entries(SILHOUETTE)) {
    assert.ok(svg.includes(d), 'favicon.svg has drifted from logo.svg on the ' + name + ' path');
  }
});

for (const file of ['logo-lockup-light.svg', 'logo-lockup-dark.svg']) {
  check(file + ' reuses logo.svg geometry byte for byte', () => {
    const svg = text(file);
    for (const [name, d] of Object.entries(SILHOUETTE)) {
      assert.ok(svg.includes(d), file + ' has drifted from logo.svg on the ' + name + ' path');
    }
  });
}

check('logo-mark.svg reuses the three silhouette paths', () => {
  const svg = text('logo-mark.svg');
  for (const name of ['brim', 'crown', 'tip']) {
    assert.ok(svg.includes(SILHOUETTE[name]), 'logo-mark.svg has drifted on the ' + name + ' path');
  }
  // The mono mark knocks the band out through a mask instead of filling it, so it
  // deliberately does not carry the band path.
  assert.ok(!svg.includes(SILHOUETTE.band), 'logo-mark.svg should knock the band out, not fill it');
  assert.ok(/<mask[\s>]/.test(svg), 'logo-mark.svg has no mask to knock the band and patches out');
});

check('logo-anim.html animates the same geometry', () => {
  const html = fs.readFileSync(path.join(BRAND, 'logo-anim.html'), 'utf8');
  for (const [name, d] of Object.entries(SILHOUETTE)) {
    assert.ok(html.includes(d), 'logo-anim.html has drifted from logo.svg on the ' + name + ' path');
  }
});

check('logo-mark.svg is a single colour that follows the text', () => {
  const svg = text('logo-mark.svg');
  assert.ok(svg.includes('currentColor'), 'logo-mark.svg does not use currentColor');
  const hexes = new Set((svg.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()));
  // Only the mask's own black and white are allowed; any brand hue means it is not mono.
  for (const hex of hexes) {
    assert.ok(['#000', '#fff', '#000000', '#ffffff'].includes(hex), 'logo-mark.svg paints ' + hex);
  }
});

// =================================================== the detail split is real

check('logo.svg splits core geometry from the detail the favicon drops', () => {
  assert.ok(master.includes('id="hat-core"'), 'logo.svg has no #hat-core group');
  assert.ok(master.includes('id="hat-detail"'), 'logo.svg has no #hat-detail group');
  assert.ok(/stroke-dasharray/.test(master), 'logo.svg has no stitching to drop');
});

check('favicon.svg drops the detail group entirely', () => {
  // Match the element, not the word: the file's header comment explains that it drops
  // the group, so a substring search on the name would fail on its own documentation.
  const svg = text('favicon.svg').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/id="hat-detail"/.test(svg), 'favicon.svg still carries the #hat-detail group');
  assert.ok(!/stroke-dasharray/.test(svg), 'favicon.svg still carries the stitching');
  assert.ok(!/stroke-opacity/.test(svg), 'favicon.svg still carries the crease strokes');
});

check('favicon.svg is dark aware and lifts the body purple', () => {
  const svg = text('favicon.svg');
  assert.ok(/@media\s*\(prefers-color-scheme:\s*dark\)/.test(svg), 'favicon.svg has no dark media query');
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\s*\}\s*<\/style>/.exec(svg);
  assert.ok(dark, 'could not read the dark block out of favicon.svg');
  assert.ok(/#7E63A0/i.test(dark[1]), 'the dark block does not lift the body purple to #7E63A0');
  // The resting body purple sits at 2.1:1 on the app's #191919; the lift is the whole point.
  assert.ok(svg.includes('#5A437A'), 'favicon.svg lost its light-mode body purple');
});

check('the lockups name Plus Jakarta Sans first and fall back to a system stack', () => {
  for (const file of ['logo-lockup-light.svg', 'logo-lockup-dark.svg']) {
    const svg = text(file);
    const family = /font-family="([^"]+)"/.exec(svg);
    assert.ok(family, file + ' sets no font-family');
    assert.ok(/^'Plus Jakarta Sans'/.test(family[1]), file + ' does not name Plus Jakarta Sans first');
    assert.ok(/sans-serif\s*$/.test(family[1]), file + ' has no generic fallback at the end of the stack');
    assert.ok(/font-weight="600"/.test(svg), file + ' does not set weight 600');
    assert.ok(/>Myrlin Workbook</.test(svg), file + ' does not set the wordmark as live text');
  }
});

// ============================================================= icon rasters

for (const [file, spec] of Object.entries(RASTERS)) {
  check(file + ' is exactly ' + spec.dims + ' and under ' + spec.budget / 1024 + ' KB', () => {
    assert.ok(fs.existsSync(path.join(BRAND, file)), 'missing ' + file);
    assert.strictEqual(pngSize(file), spec.dims, file + ' is the wrong size');
    const size = bytes(file);
    assert.ok(size <= spec.budget, file + ' is ' + (size / 1024).toFixed(1) + ' KB, budget ' + spec.budget / 1024 + ' KB');
  });
}

check('the web manifest sizes are present as a set', () => {
  for (const file of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-180.png']) {
    assert.ok(fs.existsSync(path.join(BRAND, file)), 'missing ' + file);
  }
});

// =============================================================== animation

check('logo-anim.webp is a real animation that loops forever', () => {
  const file = path.join(BRAND, 'logo-anim.webp');
  assert.ok(fs.existsSync(file), 'missing logo-anim.webp');
  const info = readWebpInfo(file);
  assert.ok(info.animated, 'logo-anim.webp is not flagged animated in its VP8X chunk');
  assert.ok(info.frames > 1, 'logo-anim.webp carries ' + info.frames + ' frame(s)');
  assert.strictEqual(info.loop, 0, 'logo-anim.webp loop count is ' + info.loop + ', expected 0 for forever');
  assert.ok(info.width >= 400 && info.width <= 600, 'logo-anim.webp is ' + info.width + 'px wide, contract says 400 to 600');
  assert.strictEqual(info.width, info.height, 'logo-anim.webp is not square');
  assert.ok(info.bytes <= 200 * 1024, 'logo-anim.webp is ' + (info.bytes / 1024).toFixed(1) + ' KB, budget 200 KB');
});

check('logo-anim.webp runs between 2 and 3 seconds', () => {
  // Frame durations live at byte 12 of each ANMF payload, three bytes little-endian.
  const buf = fs.readFileSync(path.join(BRAND, 'logo-anim.webp'));
  let offset = 12;
  let total = 0;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (fourcc === 'ANMF') {
      total += buf[offset + 20] | (buf[offset + 21] << 8) | (buf[offset + 22] << 16);
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(total >= 2000 && total <= 3000, 'logo-anim.webp runs ' + total + 'ms, contract says 2000 to 3000');
});

check('logo-anim.mp4 is a faststart MP4 under 2 MB', () => {
  const file = path.join(BRAND, 'logo-anim.mp4');
  assert.ok(fs.existsSync(file), 'missing logo-anim.mp4');
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.toString('ascii', 4, 8), 'ftyp', 'logo-anim.mp4 has no ftyp box');
  const head = buf.slice(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
  assert.ok(head.includes('moov'), 'logo-anim.mp4 moov atom is not near the front; faststart did not apply');
  assert.ok(buf.length <= 2 * 1024 * 1024, 'logo-anim.mp4 is ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB, budget 2 MB');
});

check('logo-anim.html disables its own motion under prefers-reduced-motion', () => {
  const html = fs.readFileSync(path.join(BRAND, 'logo-anim.html'), 'utf8');
  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}/.exec(html);
  assert.ok(block, 'logo-anim.html has no reduced-motion media query');
  assert.ok(/animation:\s*none/.test(block[1]), 'the reduced-motion block does not switch the animation off');
  // One shared duration is what makes the deterministic frame capture possible.
  assert.ok(/animation-duration:\s*2400ms/.test(html), 'logo-anim.html no longer uses one shared duration');
});

// ======================================================= house rules and legacy

check('the brand docs carry no em dash and no double hyphen', () => {
  const readme = text('README.md');
  // Written as escapes on purpose: the literal characters must not appear in the repo,
  // and a detector that spells them out would be its own first violation.
  assert.ok(!/[\u2014\u2015]/.test(readme), 'docs/media/brand/README.md contains an em dash or horizontal bar');
  // Fenced code, inline code and Markdown table delimiter rows are syntax, not prose.
  const prose = readme
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .split('\n')
    .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line))
    .join('\n');
  const hit = new RegExp('.{0,50}' + DOUBLE_HYPHEN + '.{0,30}').exec(prose);
  assert.ok(!hit, 'docs/media/brand/README.md contains a double hyphen outside code: ' + (hit && hit[0]));
});

check('the legacy raster logo is left in place', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'images', 'logo.png')), 'docs/images/logo.png was removed');
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'images', 'logo-animated.svg')), 'docs/images/logo-animated.svg was removed');
});

check('the running app icon was not swapped as a side effect', () => {
  // Replacing what the app loads is a separate, deliberate decision. This gate exists so
  // the brand track cannot change the shipped app icon by accident.
  const appLogo = path.join(ROOT, 'src', 'web', 'public', 'logo.png');
  if (!fs.existsSync(appLogo)) return;
  const buf = fs.readFileSync(appLogo);
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', 'src/web/public/logo.png is not a PNG any more');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
