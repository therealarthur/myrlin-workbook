/**
 * artboard.js / builds one marketing artboard on demand, in the page.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHAT THIS IS
 *
 * The drawing half of the stills pipeline. scripts/media/stills.js owns the
 * manifest (what each asset says, how big it is, what it costs in bytes) and
 * this file owns how a manifest entry becomes pixels. The split is the same one
 * capture.js and encode.js already use: the part that decides and the part that
 * renders are separate, so either can be changed without reopening the other.
 *
 * THREE THINGS IN HERE ARE NOT DECORATION
 *
 *   1. installAssets(). Fonts are added through the FontFace API from base64
 *      payloads rather than declared in CSS. A CSS @font-face that fails leaves
 *      no trace: the text renders in a fallback and the artboard ships wrong.
 *      face.load() REJECTS, so the same failure becomes a thrown error and the
 *      run stops. This is the single most important line in the file.
 *
 *   2. fontProof(). Even a loaded face proves nothing about what the browser
 *      actually resolved for a family stack. So the proof is a MEASUREMENT: the
 *      same string is set in the real stack and in a stack whose only named
 *      family cannot exist, and the two widths have to differ. If they match,
 *      the real stack collapsed to the generic and stills.js fails the run.
 *
 *   3. makeTexture(). Every artboard's plate is generated from a seed derived
 *      from its own id, so no two carry the same gradient or the same grid.
 *      Both the contract and the global design rules require that; a repeated
 *      texture across a set is the tell that a template was filled in rather
 *      than designed. The seed is a hash of the id and not a random number, so
 *      the same artboard renders byte-identically on every run.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/artboards/artboard
 */

'use strict';

/* Geometry constants
   ---------------------------------------------------------------------- */

/**
 * The aspect ratio of every desktop screenshot the contract produces, as a
 * width and a height. The browser frame's screen is always cut to this even
 * when the image inside it is cropped and zoomed, so the frame keeps reading as
 * a real window rather than as a letterbox that changes shape per artboard.
 */
var DESKTOP_SHOT_W = 1440;
var DESKTOP_SHOT_H = 900;

/** The phone capture size from the contract. still-phone.png is exactly 2x it. */
var PHONE_SHOT_W = 390;
var PHONE_SHOT_H = 844;

/**
 * The hue tokens a plate may be tinted with, in the order the seed indexes
 * them. All six are real app tokens; see artboard.css for where each came from.
 */
var TEXTURE_HUES = ['--ab-claude', '--ab-codex', '--ab-blue', '--ab-orange', '--ab-teal', '--ab-pink'];

/**
 * How strong a seeded glow may be, per theme.
 *
 * Light gets the lower band because a saturated wash on white reads as a stock
 * gradient immediately, while the same value on #191919 reads as depth.
 */
var GLOW_ALPHA = { dark: { min: 0.13, span: 0.11 }, light: { min: 0.08, span: 0.07 } };

/** Grid spacing band in CSS pixels. Below 20 it moires after the 2x downscale. */
var GRID_STEP_MIN = 21;
var GRID_STEP_SPAN = 17;

/** The probe string the font measurement uses. Mixed widths on purpose. */
var FONT_PROBE_TEXT = 'Workbook 0123456789 mmiillWW';

/** Probe size. Large, so a one percent metric difference is pixels, not noise. */
var FONT_PROBE_PX = 72;

/**
 * A family name that cannot exist on any machine. Used as the only named family
 * in the control stack, so the control is guaranteed to render in the generic.
 */
var ABSENT_FAMILY = '"__myrlin_absent_face_2026__"';

/* Seeded randomness
   ---------------------------------------------------------------------- */

/**
 * Hash a string to a 32 bit unsigned integer (FNV-1a).
 *
 * @param {string} text - Any string, in practice an artboard id.
 * @returns {number} A 32 bit unsigned seed.
 */
function hashSeed(text) {
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32, a small deterministic pseudo random generator.
 *
 * Deterministic is the whole requirement: the run has to be idempotent, so the
 * texture cannot come from Math.random().
 *
 * @param {number} seed - A 32 bit unsigned seed.
 * @returns {function(): number} A generator returning values in [0, 1).
 */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive one artboard's texture from its id.
 *
 * @param {string} id - The artboard id, for example "ad-02".
 * @param {string} theme - Either "dark" or "light".
 * @returns {object} A plain description of the plate, glows and grid.
 */
function makeTexture(id, theme) {
  var rnd = mulberry32(hashSeed(id));
  var band = GLOW_ALPHA[theme] || GLOW_ALPHA.dark;

  // Two DIFFERENT hues, guaranteed by rejecting the first index out of the
  // second draw rather than by retrying, which would consume a variable number
  // of values from the generator and make the sequence depend on luck.
  var first = Math.floor(rnd() * TEXTURE_HUES.length);
  var second = Math.floor(rnd() * (TEXTURE_HUES.length - 1));
  if (second >= first) second += 1;

  var glow = function (hueIndex) {
    return {
      hue: TEXTURE_HUES[hueIndex],
      x: Math.round((0.06 + rnd() * 0.88) * 1000) / 1000,
      y: Math.round((0.04 + rnd() * 0.92) * 1000) / 1000,
      r: Math.round((0.5 + rnd() * 0.55) * 1000) / 1000,
      alpha: Math.round((band.min + rnd() * band.span) * 1000) / 1000,
    };
  };

  return {
    id: id,
    plateAngle: Math.round(40 + rnd() * 280),
    glows: [glow(first), glow(second)],
    gridKind: rnd() < 0.5 ? 'dot' : 'line',
    gridStep: Math.round(GRID_STEP_MIN + rnd() * GRID_STEP_SPAN),
    gridOffsetX: Math.round(rnd() * 40),
    gridOffsetY: Math.round(rnd() * 40),
    gridAngle: Math.round(-16 + rnd() * 32),
    gridOpacity: Math.round((0.5 + rnd() * 0.4) * 100) / 100,
    maskX: Math.round((0.1 + rnd() * 0.8) * 100),
    maskY: Math.round((0.1 + rnd() * 0.8) * 100),
    maskReach: Math.round((0.5 + rnd() * 0.28) * 100),
  };
}

/**
 * Reduce a texture to a short comparable string.
 *
 * stills.js asserts these are unique across the whole manifest, which is how
 * "seed it per artboard" is enforced rather than merely intended.
 *
 * @param {object} texture - A makeTexture result.
 * @returns {string} A signature string.
 */
function textureSignature(texture) {
  var parts = [
    texture.plateAngle,
    texture.gridKind,
    texture.gridStep,
    texture.gridAngle,
    texture.gridOffsetX + 'x' + texture.gridOffsetY,
    texture.gridOpacity,
    texture.maskX + 'x' + texture.maskY + 'r' + texture.maskReach,
  ];
  for (var i = 0; i < texture.glows.length; i++) {
    var g = texture.glows[i];
    parts.push(g.hue + ':' + g.x + ',' + g.y + ',' + g.r + ',' + g.alpha);
  }
  return parts.join('|');
}

/* DOM helpers
   ---------------------------------------------------------------------- */

/**
 * Create an element with an optional class list and text.
 *
 * @param {string} tag - Tag name.
 * @param {string} [cls] - Space separated class names.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 */
function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Read the payload, failing loudly rather than rendering an empty artboard.
 *
 * @returns {object} The injected media payload.
 */
function payload() {
  if (!window.__MEDIA__) throw new Error('no window.__MEDIA__ payload was injected');
  return window.__MEDIA__;
}

/* Asset installation
   ---------------------------------------------------------------------- */

/**
 * Install every font face carried in the payload.
 *
 * WHY THE FontFace API AND NOT A CSS @font-face RULE. A declarative rule that
 * cannot fetch its source fails silently: the browser paints the next family in
 * the stack and nothing anywhere reports it. face.load() returns a promise that
 * REJECTS, so the same condition becomes a thrown error that stops the run
 * before a single wrong pixel is written. The research calls a silently
 * substituted face the worst class of bug for a brand asset, and this is the
 * line that makes it impossible here.
 *
 * @returns {Promise<object>} A report of what was installed.
 */
async function installAssets() {
  var media = payload();
  var installed = [];
  for (var i = 0; i < media.fonts.length; i++) {
    var spec = media.fonts[i];
    var face = new FontFace(spec.family, 'url(' + spec.dataUri + ')', {
      weight: spec.weight,
      style: spec.style,
      display: 'block',
    });
    await face.load();
    document.fonts.add(face);
    installed.push({ family: face.family, weight: face.weight, status: face.status });
  }
  await document.fonts.ready;
  return {
    installed: installed,
    logo: media.logo ? media.logo.kind : 'none',
    shots: Object.keys(media.shots || {}),
  };
}

/**
 * Measure a string in a given family stack.
 *
 * getBoundingClientRect rather than canvas measureText, because the canvas
 * context resolves fonts through a slightly different path and the point of
 * this measurement is what the LAYOUT engine chose.
 *
 * @param {string} family - A CSS font-family value.
 * @param {number} weight - CSS font weight.
 * @returns {number} Rendered width in CSS pixels.
 */
function measureFamily(family, weight) {
  var probe = el('span', null, FONT_PROBE_TEXT);
  probe.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre;visibility:hidden;';
  probe.style.fontFamily = family;
  probe.style.fontWeight = String(weight);
  probe.style.fontSize = FONT_PROBE_PX + 'px';
  document.body.appendChild(probe);
  var width = probe.getBoundingClientRect().width;
  probe.remove();
  return Math.round(width * 100) / 100;
}

/**
 * Split a CSS font-family list into its individual families.
 *
 * @param {string} stack - A CSS font-family value.
 * @returns {string[]} The families, in order, quotes intact.
 */
function splitStack(stack) {
  return stack.split(',').map(function (part) { return part.trim(); }).filter(Boolean);
}

/**
 * Prove that both type stacks resolved to a real face.
 *
 * The control is the same string in a stack whose only named family cannot
 * exist, so it is guaranteed to be drawn by the generic. If the real stack
 * measures the same, it collapsed to that generic and the artboard is set in
 * the wrong typeface. stills.js turns an equal pair into a failed run.
 *
 * The resolved name is a best effort diagnostic on top of that: each named
 * family in the stack is measured alone, and the first whose width matches the
 * whole stack's width and differs from the generic is reported. Two faces could
 * in principle share metrics exactly, which is why the PASS condition is the
 * inequality above and not this name.
 *
 * @returns {object} Measurements for the UI stack and the mono stack.
 */
function fontProof() {
  var root = getComputedStyle(document.documentElement);
  var uiStack = root.getPropertyValue('--ab-font-ui').trim();
  var monoStack = root.getPropertyValue('--ab-font-mono').trim();

  var report = function (stack, generic, weight) {
    var actual = measureFamily(stack, weight);
    var control = measureFamily(ABSENT_FAMILY + ', ' + generic, weight);
    var resolved = null;
    var families = splitStack(stack);
    for (var i = 0; i < families.length; i++) {
      var name = families[i];
      if (name === 'sans-serif' || name === 'monospace' || name === 'serif') continue;
      var solo = measureFamily(name + ', ' + generic, weight);
      if (Math.abs(solo - actual) < 0.05 && Math.abs(solo - control) >= 0.05) {
        resolved = name;
        break;
      }
    }
    return { stack: stack, actual: actual, control: control, resolved: resolved };
  };

  var faces = [];
  document.fonts.forEach(function (face) {
    faces.push({ family: face.family, weight: face.weight, style: face.style, status: face.status });
  });

  return {
    ui: report(uiStack, 'sans-serif', 600),
    mono: report(monoStack, 'monospace', 400),
    faces: faces,
  };
}

/* Texture painting
   ---------------------------------------------------------------------- */

/**
 * Paint the seeded plate, glows and grid into an artboard.
 *
 * @param {HTMLElement} root - The artboard element.
 * @param {object} spec - The manifest entry.
 * @param {object} texture - A makeTexture result.
 * @returns {void}
 */
function paintTexture(root, spec, texture) {
  var tex = el('div', 'ab__tex');
  // Plate and ground are one step apart in the palette (for example #202020 and
  // #191919), so this reads as a lit surface rather than as a gradient, and it
  // costs almost nothing in PNG bytes.
  tex.style.background = 'linear-gradient(' + texture.plateAngle + 'deg, var(--ab-plate) 0%, var(--ab-ground) 48%, var(--ab-plate) 100%)';

  var diagonal = Math.sqrt(spec.w * spec.w + spec.h * spec.h);
  for (var i = 0; i < texture.glows.length; i++) {
    var g = texture.glows[i];
    var size = Math.round(diagonal * g.r);
    var glow = el('div', 'ab__glow');
    glow.style.width = size + 'px';
    glow.style.height = size + 'px';
    glow.style.left = Math.round(spec.w * g.x - size / 2) + 'px';
    glow.style.top = Math.round(spec.h * g.y - size / 2) + 'px';
    glow.style.background = 'radial-gradient(circle closest-side, var(' + g.hue + ') 0%, transparent 72%)';
    glow.style.opacity = String(g.alpha);
    tex.appendChild(glow);
  }

  var grid = el('div', 'ab__grid');
  if (texture.gridKind === 'dot') {
    grid.style.backgroundImage = 'radial-gradient(circle at center, var(--ab-grid-ink) 1.1px, transparent 1.2px)';
    grid.style.backgroundSize = texture.gridStep + 'px ' + texture.gridStep + 'px';
    grid.style.backgroundPosition = texture.gridOffsetX + 'px ' + texture.gridOffsetY + 'px';
  } else {
    grid.style.backgroundImage = 'repeating-linear-gradient(' + texture.gridAngle + 'deg, ' +
      'var(--ab-grid-ink) 0px, var(--ab-grid-ink) 1px, transparent 1px, transparent ' + texture.gridStep + 'px)';
  }
  grid.style.opacity = String(texture.gridOpacity);
  // The mask is what keeps the grid from tiling edge to edge, which would look
  // like a wireframe and would also cost real PNG bytes: uniform high frequency
  // detail across a whole artboard is the one pattern PNG cannot pack down.
  var mask = 'radial-gradient(circle at ' + texture.maskX + '% ' + texture.maskY + '%, ' +
    'rgba(0,0,0,1) 0%, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0) ' + texture.maskReach + '%)';
  grid.style.webkitMaskImage = mask;
  grid.style.maskImage = mask;
  tex.appendChild(grid);

  root.appendChild(tex);
}

/* Component builders
   ---------------------------------------------------------------------- */

/**
 * Build the mark plus wordmark lockup.
 *
 * @param {boolean} large - True for the banner and avatar scale.
 * @returns {HTMLElement} The lockup.
 */
function buildLockup(large) {
  var media = payload();
  var wrap = el('div', 'lockup');
  if (media.logo) {
    var img = el('img', 'lockup__mark' + (large ? ' lockup__mark--lg' : ''));
    img.src = media.logo.dataUri;
    img.alt = '';
    wrap.appendChild(img);
  } else {
    // The documented degradation for a missing --logo file. A drawn glyph, not
    // a broken image; stills.js has already said so on stdout.
    wrap.appendChild(el('div', 'lockup__glyph' + (large ? ' lockup__glyph--lg' : ''), media.markLetter));
  }
  wrap.appendChild(el('div', 'lockup__word' + (large ? ' lockup__word--lg' : ''), media.wordmark));
  return wrap;
}

/**
 * Build the CSS browser frame around a real screenshot.
 *
 * @param {object} spec - The manifest entry.
 * @returns {HTMLElement} The frame.
 */
function buildDevice(spec) {
  var media = payload();
  var frame = el('div', 'device');
  var width = spec.device.width;
  frame.style.width = width + 'px';

  var bar = el('div', 'device__bar');
  for (var i = 0; i < 3; i++) bar.appendChild(el('span', 'device__dot'));
  bar.appendChild(el('div', 'device__addr', spec.device.addr));
  bar.appendChild(el('span', 'device__spacer'));
  frame.appendChild(bar);

  var height = Math.round(width * DESKTOP_SHOT_H / DESKTOP_SHOT_W);
  var screen = el('div', 'device__screen');
  screen.style.width = width + 'px';
  screen.style.height = height + 'px';

  var img = el('img');
  img.src = media.shots[spec.shot];
  img.alt = '';
  if (spec.crop) {
    // The frame's screen keeps the 1440x900 shape whatever the crop does, so
    // every browser frame in the set is the same window. Only the image inside
    // it moves. Clamping is what stops a zoom from exposing the plate through
    // a corner of the screen.
    screen.classList.add('device__screen--crop');
    var iw = width * spec.crop.zoom;
    var ih = height * spec.crop.zoom;
    var left = Math.min(0, Math.max(width - iw, width / 2 - spec.crop.ox * iw));
    var top = Math.min(0, Math.max(height - ih, height / 2 - spec.crop.oy * ih));
    img.style.width = iw + 'px';
    img.style.height = ih + 'px';
    img.style.left = Math.round(left) + 'px';
    img.style.top = Math.round(top) + 'px';
  }
  screen.appendChild(img);
  frame.appendChild(screen);
  return frame;
}

/**
 * Build the CSS phone frame around the phone screenshot.
 *
 * @param {object} spec - The manifest entry.
 * @returns {HTMLElement} The phone.
 */
function buildPhone(spec) {
  var media = payload();
  var phone = el('div', 'phone');
  var width = spec.device.width;
  phone.style.width = width + 'px';

  var screen = el('div', 'phone__screen');
  var inner = width - 22;                                  /* two 11px bezels */
  screen.style.width = inner + 'px';
  screen.style.height = Math.round(inner * PHONE_SHOT_H / PHONE_SHOT_W) + 'px';

  var img = el('img');
  img.src = media.shots[spec.shot];
  img.alt = '';
  screen.appendChild(img);
  screen.appendChild(el('div', 'phone__slot'));
  phone.appendChild(screen);
  return phone;
}

/**
 * Build the copy column: lockup, headline, accent rule and any support lines.
 *
 * @param {object} spec - The manifest entry.
 * @returns {HTMLElement} The column.
 */
function buildCopy(spec) {
  var copy = el('div', 'copy');
  var text = spec.copy || {};
  if (text.eyebrow) copy.appendChild(el('div', 'eyebrow', text.eyebrow));
  if (text.lockup !== false) copy.appendChild(buildLockup(Boolean(text.lockupLarge)));
  if (text.headline) copy.appendChild(el('h1', 'headline' + (text.headlineClass ? ' ' + text.headlineClass : ''), text.headline));
  if (text.accentRule !== false) copy.appendChild(el('div', 'accent-rule'));
  if (text.subline) copy.appendChild(el('p', 'subline' + (text.sublineClass ? ' ' + text.sublineClass : ''), text.subline));
  if (text.command) {
    var command = el('div', 'command');
    command.appendChild(el('span', 'command__caret', '$'));
    command.appendChild(el('span', null, text.command));
    copy.appendChild(command);
  }
  if (text.platforms && text.platforms.length) {
    var row = el('div', 'platforms');
    for (var i = 0; i < text.platforms.length; i++) {
      if (i > 0) row.appendChild(el('span', 'platforms__rule'));
      row.appendChild(el('span', 'platforms__name', text.platforms[i]));
    }
    copy.appendChild(row);
  }
  return copy;
}

/* Layouts
   ---------------------------------------------------------------------- */

/**
 * Two column layouts: copy on one side, a device on the other.
 *
 * @param {HTMLElement} body - The artboard body.
 * @param {object} spec - The manifest entry.
 * @returns {void}
 */
function layoutTwoColumn(body, spec) {
  var stage = el('div', 'stage');
  var node = spec.layout === 'phone' ? buildPhone(spec) : buildDevice(spec);
  // A frame wider than its column bleeds off the artboard edge, which is the
  // effect the split layouts want. On the MIRRORED layout that bleed is on the
  // left, and the left is where the three window control dots live, so the one
  // piece of chrome the contract names by hand was being cut off the canvas.
  // An artboard can therefore ask for its frame to be centred in the column
  // instead, and keep the whole title bar in shot.
  if (spec.device && spec.device.align === 'center') {
    node.style.left = '50%';
    node.style.right = 'auto';
    node.style.transform = 'translate(-50%, -50%)';
  }
  stage.appendChild(node);
  body.appendChild(buildCopy(spec));
  body.appendChild(stage);
}

/**
 * Centred layout: copy stacked above a device that bleeds off the bottom edge.
 *
 * @param {HTMLElement} body - The artboard body.
 * @param {object} spec - The manifest entry.
 * @returns {void}
 */
function layoutCenter(body, spec) {
  var copy = buildCopy(spec);
  copy.style.alignItems = 'center';
  body.appendChild(copy);
  body.appendChild(buildDevice(spec));
}

/**
 * Card layout for the link preview and the repo social preview.
 *
 * @param {HTMLElement} body - The artboard body.
 * @param {object} spec - The manifest entry.
 * @returns {void}
 */
function layoutCard(body, spec) {
  body.style.gridTemplateColumns = spec.columns;
  var copy = buildCopy(spec);
  copy.style.padding = spec.copyPadding;
  body.appendChild(copy);
  var stage = el('div', 'stage');
  stage.appendChild(buildDevice(spec));
  body.appendChild(stage);
}

/**
 * Square profile layout.
 *
 * Everything sits inside a centred circle well short of the artboard edge, so a
 * platform that crops to a circle cannot cut anything that carries meaning. The
 * safe diameter is a manifest value; see AVATAR_SAFE_DIAMETER in stills.js.
 *
 * @param {HTMLElement} body - The artboard body.
 * @param {object} spec - The manifest entry.
 * @returns {void}
 */
function layoutAvatar(body, spec) {
  var media = payload();
  var ring = el('div', 'avatar__ring');
  ring.style.width = spec.ringDiameter + 'px';
  ring.style.height = spec.ringDiameter + 'px';
  body.appendChild(ring);

  if (media.logo) {
    var img = el('img', 'avatar__mark');
    img.src = media.logo.dataUri;
    img.alt = '';
    img.style.width = spec.markSize + 'px';
    img.style.height = spec.markSize + 'px';
    body.appendChild(img);
  } else {
    var glyph = el('div', 'avatar__glyph', media.markLetter);
    glyph.style.width = spec.markSize + 'px';
    glyph.style.height = spec.markSize + 'px';
    glyph.style.fontSize = Math.round(spec.markSize * 0.7) + 'px';
    body.appendChild(glyph);
  }
}

/**
 * Wide header layout for a social banner.
 *
 * @param {HTMLElement} body - The artboard body.
 * @param {object} spec - The manifest entry.
 * @returns {void}
 */
function layoutBanner(body, spec) {
  var text = spec.copy || {};
  body.appendChild(buildLockup(true));
  if (text.subline) body.appendChild(el('p', 'subline', text.subline));
  body.appendChild(el('div', 'banner__rule'));
  if (text.command) {
    var command = el('div', 'command');
    command.appendChild(el('span', 'command__caret', '$'));
    command.appendChild(el('span', null, text.command));
    body.appendChild(command);
  }
}

/** Every layout the manifest may name, and the builder that draws it. */
var LAYOUTS = {
  split: layoutTwoColumn,
  'split-reverse': layoutTwoColumn,
  phone: layoutTwoColumn,
  center: layoutCenter,
  card: layoutCard,
  avatar: layoutAvatar,
  banner: layoutBanner,
};

/* Entry points called from stills.js
   ---------------------------------------------------------------------- */

/**
 * Compute the texture signature of every artboard in the manifest.
 *
 * Computed for ALL of them regardless of what this run selected, so the
 * uniqueness assertion means the same thing on a single asset run as on a full
 * one.
 *
 * @returns {object} A map of artboard id to signature string.
 */
function textureSignatures() {
  var media = payload();
  var out = {};
  for (var i = 0; i < media.artboards.length; i++) {
    var spec = media.artboards[i];
    out[spec.id] = textureSignature(makeTexture(spec.id, spec.theme));
  }
  return out;
}

/**
 * Render one artboard and wait until it is genuinely ready to photograph.
 *
 * The two waits at the end are not belt and braces. document.fonts.ready is
 * what the research names as the difference between a still set in the right
 * face and one set in a fallback, and img.decode() is the equivalent for the
 * screenshots: a data URI is not decoded synchronously, and a screenshot taken
 * before it lands captures an empty browser frame.
 *
 * @param {string} id - The artboard id to render.
 * @returns {Promise<object>} What was rendered, for the caller's log.
 */
async function renderArtboard(id) {
  var media = payload();
  var spec = null;
  for (var i = 0; i < media.artboards.length; i++) {
    if (media.artboards[i].id === id) { spec = media.artboards[i]; break; }
  }
  if (!spec) throw new Error('unknown artboard: ' + id);

  document.documentElement.dataset.theme = spec.theme;

  var previous = document.getElementById('artboard');
  var root = el('div', 'ab layout-' + spec.layout);
  root.id = 'artboard';
  root.dataset.artboard = spec.id;
  root.style.width = spec.w + 'px';
  root.style.height = spec.h + 'px';

  var texture = makeTexture(spec.id, spec.theme);
  // The accent hairline under each headline takes the artboard's own first
  // seeded hue, so the tint and the plate cannot drift apart.
  root.style.setProperty('--ab-accent', 'var(' + texture.glows[0].hue + ')');
  paintTexture(root, spec, texture);

  var body = el('div', 'ab__body');
  root.appendChild(body);
  var build = LAYOUTS[spec.layout];
  if (!build) throw new Error('unknown layout: ' + spec.layout);
  build(body, spec);

  previous.replaceWith(root);

  await document.fonts.ready;
  var images = Array.prototype.slice.call(root.querySelectorAll('img'));
  await Promise.all(images.map(function (img) { return img.decode(); }));
  await new Promise(function (resolve) {
    requestAnimationFrame(function () { requestAnimationFrame(resolve); });
  });

  return {
    id: spec.id,
    width: root.getBoundingClientRect().width,
    height: root.getBoundingClientRect().height,
    texture: textureSignature(texture),
    images: images.length,
  };
}

window.__installAssets = installAssets;
window.__fontProof = fontProof;
window.__textureSignatures = textureSignatures;
window.__renderArtboard = renderArtboard;
