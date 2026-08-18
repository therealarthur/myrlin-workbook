#!/usr/bin/env node
/**
 * stills.js - renders every static marketing artboard the contract names.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHAT IT PRODUCES
 *
 *   docs/media/ad-01.png .. ad-04.png    1600x900 artboards, one per contract headline
 *   docs/media/social/og.png             1200x630 link preview
 *   docs/media/social/social-preview.png 1280x640 repository social preview
 *   docs/media/social/avatar.png         1024x1024 profile mark, safe under a circle crop
 *   docs/media/social/banner.png         1500x500 wide header
 *
 * Each one is an HTML artboard (scripts/media/artboards/) rendered by Playwright
 * at deviceScaleFactor 2 and downscaled with sharp to its delivery width, with a
 * real application screenshot composited inside a CSS drawn browser frame.
 *
 * WHY PLAYWRIGHT AND NOT sharp PLUS AN SVG STRING
 *
 * This is the single constraint that shaped the whole file, and it is measured
 * rather than assumed. Section 8 of docs/marketing/RESEARCH-2026-08-18.md
 * records that rendering an SVG naming a font family that is not installed
 * system wide through sharp 0.34.5 SUBSTITUTES a generic face, emits no
 * warning, and exits 0. Neither brand font is installed on the build machine.
 * That is the worst class of bug for a brand asset: it does not fail, it just
 * ships wrong, and nobody notices until it is on a package page.
 *
 * So every glyph in every output here is rasterised by Chromium, from a face
 * this script hands it as bytes, and the run asserts the result before it
 * writes anything. See assertFontProof below.
 *
 * WHY THE PAGE IS LOADED OVER file:// WITH EVERY ASSET INLINED
 *
 * The alternative was to serve the artboard from the sandboxed application
 * origin, so that /design/notion/fonts/*.woff2 resolve the way they do in the
 * app. That works and it costs a whole server boot, a sandbox and a teardown
 * path for a page that does not need the application at all. The cheaper route
 * has one trap: a file:// document is an opaque origin, so a @font-face
 * pointing at a sibling .woff2 is a cross origin font request and Chromium
 * refuses it, silently, back into a fallback face.
 *
 * Inlining every font, screenshot and logo as a base64 data URI removes the
 * origin from the question entirely. Nothing is fetched, the page cannot depend
 * on anything outside this repository, and the http(s) route blocker below
 * exists only to prove that.
 *
 * THE IMAGE SIZE RULE THIS FILE OBEYS
 *
 * deviceScaleFactor 2 on a 1600x900 artboard emits 3200x1800. Anthropic's API
 * rejects an image over 2000px on either axis and a single one poisons an agent
 * session, so no raw capture is ever written where a reviewer might open it.
 * Review copies go to screenshots/media-review/ (gitignored) capped at
 * REVIEW_THUMB_MAX_PX on the long side, and the delivered files themselves are
 * at most 1600px wide.
 *
 * Usage:
 *   node scripts/media/stills.js                             # every artboard
 *   node scripts/media/stills.js ad-01 og                     # named artboards only
 *   node scripts/media/stills.js --logo docs/media/brand/logo.svg
 *   node scripts/media/stills.js --list                       # names and budgets
 *   node scripts/media/stills.js --headed                     # watch it render
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/stills
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const sharp = require('sharp');
const { chromium } = require('@playwright/test');

const { PROJECT_ROOT } = require('./harness');
// human(), KB and MB are imported rather than reimplemented, so a byte count
// printed here is formatted by the same function that formats the encoder's.
// Requiring encode.js is free: it resolves ffmpeg lazily inside ffmpegPath(),
// so nothing spawns and no encoder is touched by this import.
//
// printTable is NOT importable, because encode.js does not export it. It is
// reimplemented below rather than added to that file's exports: encode.js
// belongs to a parallel track in this session and is out of scope to edit. See
// printSizeTable, which is a line for line copy of it so the two runs print the
// same table.
const { human, KB, MB } = require('./encode');

/** Where the delivery files land. Same root the encoder writes to. */
const OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'media');

/** The artboard template. One HTML file for the whole set, by design. */
const TEMPLATE = path.join(__dirname, 'artboards', 'artboard.html');

/** Gitignored review copies. Never the raw 2x capture; see REVIEW_THUMB_MAX_PX. */
const REVIEW_DIR = path.join(PROJECT_ROOT, 'screenshots', 'media-review');

/**
 * The longest edge a review thumbnail may have.
 *
 * The hard ceiling is 2000px, above which an image cannot enter an agent's
 * context at all. 1300 sits well under it while still being large enough to
 * read a headline and spot clipped text, which is the whole point of writing
 * them.
 */
const REVIEW_THUMB_MAX_PX = 1300;

/**
 * The capture scale.
 *
 * 2 is the contract's own "Stills are rendered at deviceScaleFactor 2". It
 * doubles every artboard, so the 1600x900 ads are captured at 3200x1800 and
 * downscaled to 1600, which supersamples the type and is why the headlines stay
 * crisp instead of merely large.
 */
const DEVICE_SCALE_FACTOR = 2;

/** Default mark. Overridable with --logo, which the brand track will exercise. */
const DEFAULT_LOGO = path.join('docs', 'images', 'logo.png');

/** File extensions the logo may be, and the MIME type each is embedded under. */
const LOGO_MIME = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

/** Shown in the lockup when no logo file resolves. */
const FALLBACK_MARK_LETTER = 'M';

/** The product name as the application header and the README both spell it. */
const WORDMARK = "Myrlin's Workbook";

/**
 * The install line.
 *
 * THE TAG IS LOAD BEARING, and getting it wrong was a real defect in the first
 * cut of this file, which printed `npm i myrlin-workbook`.
 *
 * That command installs the STABLE line, and README.md line 18 and line 32 both
 * record what the stable line is: Claude only. Every artboard that carries this
 * command also carries a screenshot of ChatGPT Codex sessions and a subhead
 * saying "Claude Code and ChatGPT Codex in one interface", so the untagged
 * command contradicted the picture directly above it. Anyone who ran it got a
 * build with no Codex support and no redesigned interface.
 *
 * `npx myrlin-workbook@alpha` is the command README.md line 33 gives for the
 * v1.3 multi provider line, which is the version these screenshots are of. npx
 * rather than npm i because this is a tool that is run, not a package that is
 * imported, and npx is the form the README's own Quick Start leads with.
 */
const INSTALL_COMMAND = 'npx myrlin-workbook@alpha';

/**
 * What the browser frame's address field reads.
 *
 * 3456 is the application's own default port, so this is what a person actually
 * sees. Note that nothing in this pipeline BINDS that port; harness.js refuses
 * to, because on the build machine it serves a live checkout. Printing it in an
 * artboard is text, not a socket.
 */
const APP_ADDRESS = 'localhost:3456';

/**
 * The four ad headlines, verbatim from the contract's "Ad still headlines"
 * section. This copy is contractual: the README track may refine it, and if it
 * does, it changes THERE first and then here.
 */
const HEADLINES = Object.freeze([
  'Every Claude Code and Codex session on your machine, in one sidebar.',
  'A terminal you can actually scroll back through and copy from.',
  'Your sessions, on your phone, over your own tunnel.',
  'Open source. Runs locally. Windows, macOS, Linux.',
]);

/**
 * Supporting copy for the social assets, which the contract does not script.
 *
 * Both lines are compressions of the README's own first paragraph rather than
 * new marketing claims, because an asset that says something the product does
 * not do is worse than an asset that says nothing.
 */
const PRODUCT_LINE = 'Open source workspace manager for AI coding CLIs.';
const PRODUCT_SUBLINE = 'Claude Code and ChatGPT Codex in one interface. Runs locally.';

/** The three platforms the README supports, set as text rather than as chips. */
const PLATFORMS = Object.freeze(['Windows', 'macOS', 'Linux']);

/**
 * The self hosted faces, from src/web/public/design/notion/fonts.css.
 *
 * ONLY the mono. The application's body stack is the OS UI stack: the Notion
 * restyle deliberately removed the webfont from the app surface, and fonts.css
 * says so in as many words. So an artboard set in Plus Jakarta Sans would be
 * set in a face the product no longer uses, which is why the contract's
 * "Plus Jakarta Sans, JetBrains Mono" line is honoured in spirit (the app's own
 * faces, rendered by the browser) rather than to the letter.
 *
 * Weight 700 rather than the "600 700" range fonts.css declares: the artboards
 * only ever ask for 400 and 700, and a plain weight cannot be misparsed by the
 * FontFace constructor.
 */
const FONT_FACES = Object.freeze([
  {
    family: 'iA Writer Mono',
    weight: '400',
    style: 'normal',
    file: path.join('src', 'web', 'public', 'design', 'notion', 'fonts', 'iAWriterMonoS-Regular.woff2'),
  },
  {
    family: 'iA Writer Mono',
    weight: '700',
    style: 'normal',
    file: path.join('src', 'web', 'public', 'design', 'notion', 'fonts', 'iAWriterMonoS-Bold.woff2'),
  },
]);

/**
 * Where each screenshot comes from, best source first.
 *
 * WHY raw/ IS PREFERRED. capture.js writes the desktop stills at 2880x1800 into
 * docs/media/raw/, and encode.js downscales them to the committed 1440x900
 * delivery files. An artboard places a desktop screenshot around 1000 CSS px
 * wide and is captured at deviceScaleFactor 2, so the browser needs about 2000
 * device pixels of image. From the 1440px delivery file that is an UPSCALE and
 * the app text goes soft; from the 2880px raw file it is a downscale and stays
 * sharp.
 *
 * raw/ is gitignored and regenerable, so the committed file is the fallback and
 * the run works on a clean checkout. The fallback is only softer, never wrong,
 * and it produces a SMALLER PNG, so a budget proved against raw/ holds.
 */
const SHOT_SOURCES = Object.freeze({
  'desktop-dark': [
    path.join('docs', 'media', 'raw', 'still-desktop-dark.png'),
    path.join('docs', 'media', 'still-desktop-dark.png'),
  ],
  'desktop-light': [
    path.join('docs', 'media', 'raw', 'still-desktop-light.png'),
    path.join('docs', 'media', 'still-desktop-light.png'),
  ],
  phone: [
    path.join('docs', 'media', 'raw', 'still-phone.png'),
    path.join('docs', 'media', 'still-phone.png'),
  ],
});

/**
 * The diameter, inside the 1024px avatar, that a circle crop is guaranteed to
 * keep.
 *
 * A circle inscribed in a 1024 square touches all four edges, so "inside the
 * circle" alone would still put the mark hard against the crop line. This is
 * the circle the mark is actually composed inside, and the 132px of ground it
 * leaves on every side is the padding the contract asks for.
 */
const AVATAR_SAFE_DIAMETER = 760;

/**
 * The mark's box on the avatar.
 *
 * The number that matters is the box's HALF DIAGONAL, not its width: a square
 * box's corners are further from the centre than its edges are, so a mark sized
 * by width alone can sit inside the safe circle at three o'clock and outside it
 * at half past four. 560 gives a half diagonal of 396px against the safe
 * circle's 380px radius, and the mark is drawn with object-fit: contain, so the
 * painted content of the current 238x192 mark reaches 360px and clears it.
 *
 * A square SVG from the brand track would reach the full 396px, which is 16px
 * outside the safe circle at the corners only. That is acceptable because a
 * logo does not paint into its own corners; if one ever does, drop this to 530
 * rather than moving the safe circle.
 */
const AVATAR_MARK_SIZE = 560;

/** A decorative ring, well inside the crop circle and outside the mark. */
const AVATAR_RING_DIAMETER = 872;

/**
 * How much of a wide social header the hosting platform can cover or crop.
 *
 * X overlays the profile picture across the lower left of a header and crops
 * the sides on a narrow viewport. Neither number is worth guessing at
 * precisely, so the banner simply centres everything: the middle band survives
 * both. This constant exists to record the reason the layout is centred, so a
 * future edit does not "improve" it by moving the lockup to the left.
 */
const BANNER_AVATAR_KEEPOUT = Object.freeze({ left: 420, bottom: 140 });

/**
 * Every artboard, its size, its delivery width and its byte budget.
 *
 * Sizes and budgets are the contract's asset table and are not tuning knobs.
 * Everything else on a row is layout, which is this file's to choose.
 */
const ARTBOARDS = Object.freeze([
  {
    id: 'ad-01',
    out: 'ad-01.png',
    w: 1600,
    h: 900,
    deliveryWidth: 1600,
    maxBytes: 800 * KB,
    theme: 'dark',
    layout: 'split',
    shot: 'desktop-dark',
    device: { width: 1000, addr: APP_ADDRESS },
    copy: { headline: HEADLINES[0] },
  },
  {
    id: 'ad-02',
    out: 'ad-02.png',
    w: 1600,
    h: 900,
    deliveryWidth: 1600,
    maxBytes: 800 * KB,
    theme: 'dark',
    layout: 'split-reverse',
    shot: 'desktop-dark',
    // Zoomed onto the two terminal panes, because the headline is about
    // scrollback and a whole 1440px app at this size shows no legible output.
    //
    // BOTH numbers are measured rather than chosen by feel. ox 0.466 puts the
    // crop's left edge exactly on the Claude pane's left border: aimed further
    // right, the frame opens on the empty right half of that pane and the ad
    // leads with a blank navy column carrying three stray box corners, which
    // reads as a rendering fault. zoom 1.7 renders the screenshot at 1.015x its
    // native size, so at deviceScaleFactor 2 against the 2880px source the
    // terminal text is drawn at essentially one device pixel per source pixel.
    // Zooming harder to isolate a single pane costs exactly that sharpness,
    // because the crop's span is 1/zoom of the image whatever the frame's width.
    crop: { zoom: 1.7, ox: 0.466, oy: 0.5 },
    // Centred rather than bled, so the title bar's window controls stay in
    // shot. See the note in layoutTwoColumn.
    device: { width: 860, addr: APP_ADDRESS, align: 'center' },
    copy: { headline: HEADLINES[1] },
  },
  {
    id: 'ad-03',
    out: 'ad-03.png',
    w: 1600,
    h: 900,
    deliveryWidth: 1600,
    maxBytes: 800 * KB,
    // Light plate under a dark phone. The two ads either side of it are dark,
    // and a set of four identical grounds reads as one template filled in.
    theme: 'light',
    layout: 'phone',
    shot: 'phone',
    device: { width: 372 },
    copy: { headline: HEADLINES[2] },
  },
  {
    id: 'ad-04',
    out: 'ad-04.png',
    w: 1600,
    h: 900,
    deliveryWidth: 1600,
    maxBytes: 800 * KB,
    theme: 'light',
    layout: 'center',
    shot: 'desktop-light',
    device: { width: 1180, addr: APP_ADDRESS },
    copy: { headline: HEADLINES[3], headlineClass: 'headline--lg' },
  },
  {
    id: 'og',
    out: path.join('social', 'og.png'),
    w: 1200,
    h: 630,
    deliveryWidth: 1200,
    maxBytes: 400 * KB,
    theme: 'dark',
    layout: 'card',
    columns: '660px 1fr',
    copyPadding: '0 36px 0 76px',
    shot: 'desktop-dark',
    // ox 0 pins the crop to the LEFT edge of the screenshot. Anything else
    // slices vertically through the sidebar and leaves a column of half words
    // ("lecent", "jects") down the edge of the frame, which at link preview
    // size reads as a broken image rather than as a cropped one.
    crop: { zoom: 1.16, ox: 0, oy: 0.42 },
    device: { width: 600, addr: APP_ADDRESS },
    copy: {
      headline: PRODUCT_LINE,
      headlineClass: 'headline--sm',
      subline: PRODUCT_SUBLINE,
      sublineClass: 'subline--sm',
      command: INSTALL_COMMAND,
    },
  },
  {
    id: 'social-preview',
    out: path.join('social', 'social-preview.png'),
    w: 1280,
    h: 640,
    deliveryWidth: 1280,
    maxBytes: 1 * MB,
    theme: 'dark',
    layout: 'card',
    columns: '700px 1fr',
    copyPadding: '0 36px 0 84px',
    shot: 'desktop-dark',
    // Pinned left for the same reason as og: a half sliced sidebar label is
    // the one crop artefact a viewer reads as a bug.
    crop: { zoom: 1.24, ox: 0, oy: 0.42 },
    device: { width: 700, addr: APP_ADDRESS },
    copy: {
      headline: HEADLINES[0],
      headlineClass: 'headline--sm',
      command: INSTALL_COMMAND,
      platforms: PLATFORMS,
    },
  },
  {
    id: 'avatar',
    out: path.join('social', 'avatar.png'),
    w: 1024,
    h: 1024,
    deliveryWidth: 1024,
    maxBytes: 300 * KB,
    theme: 'dark',
    layout: 'avatar',
    markSize: AVATAR_MARK_SIZE,
    ringDiameter: AVATAR_RING_DIAMETER,
    safeDiameter: AVATAR_SAFE_DIAMETER,
  },
  {
    id: 'banner',
    out: path.join('social', 'banner.png'),
    w: 1500,
    h: 500,
    deliveryWidth: 1500,
    maxBytes: 500 * KB,
    theme: 'dark',
    layout: 'banner',
    keepout: BANNER_AVATAR_KEEPOUT,
    copy: { subline: PRODUCT_SUBLINE, command: INSTALL_COMMAND },
  },
]);

/**
 * The PNG encodings tried, in order, against a byte budget.
 *
 * THE SAME BARGAIN encode.js MAKES, for the same reason. The contract pins each
 * still's delivery WIDTH, so width is not available as a lever: changing it
 * would change the deliverable to fit the tool. The first two entries are both
 * lossless and differ only in filter strategy, and whichever is smaller wins.
 * Only if neither fits does the search start quantising colour, and the entry
 * it settled on is printed in the size table, so a still that had to give up
 * colour depth is visible rather than quietly banded.
 */
const PNG_ATTEMPTS = Object.freeze([
  { note: 'lossless', lossy: false, options: { compressionLevel: 9, adaptiveFiltering: true, palette: false } },
  { note: 'lossless, plain filter', lossy: false, options: { compressionLevel: 9, adaptiveFiltering: false, palette: false } },
  { note: '256 colour', lossy: true, options: { compressionLevel: 9, palette: true, colors: 256, dither: 1, effort: 10 } },
  { note: '192 colour', lossy: true, options: { compressionLevel: 9, palette: true, colors: 192, dither: 1, effort: 10 } },
  { note: '128 colour', lossy: true, options: { compressionLevel: 9, palette: true, colors: 128, dither: 1, effort: 10 } },
]);

/* Assets
   ---------------------------------------------------------------------- */

/**
 * Read a file and wrap it as a base64 data URI.
 *
 * @param {string} file - Absolute path.
 * @param {string} mime - MIME type to declare.
 * @returns {string} A data URI.
 */
function dataUri(file, mime) {
  return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
}

/**
 * Load both self hosted faces as data URIs.
 *
 * @returns {Array<object>} Font specs ready for the FontFace constructor.
 */
function loadFonts() {
  return FONT_FACES.map((face) => {
    const file = path.join(PROJECT_ROOT, face.file);
    if (!fs.existsSync(file)) {
      throw new Error(
        'font face missing: ' + face.file + '. The vendored bundle under ' +
        'src/web/public/design/notion/fonts/ is what the application itself ' +
        'ships; without it these artboards would be set in a substituted face.'
      );
    }
    return {
      family: face.family,
      weight: face.weight,
      style: face.style,
      dataUri: dataUri(file, 'font/woff2'),
    };
  });
}

/**
 * Resolve the screenshots the selected artboards actually need.
 *
 * Only the ones in use, so a single asset run does not carry two megabytes of
 * base64 it will never draw.
 *
 * @param {Array<object>} selected - The artboards being rendered.
 * @returns {{shots: object, sources: object}} Data URIs and the paths they came from.
 */
function loadShots(selected) {
  const shots = {};
  const sources = {};
  for (const spec of selected) {
    if (!spec.shot || shots[spec.shot]) continue;
    const candidates = SHOT_SOURCES[spec.shot];
    if (!candidates) throw new Error('unknown screenshot: ' + spec.shot);
    const found = candidates.map((rel) => path.join(PROJECT_ROOT, rel)).find((abs) => fs.existsSync(abs));
    if (!found) {
      throw new Error(
        'no source for screenshot "' + spec.shot + '". Expected one of: ' +
        candidates.join(', ') + '. Run npm run media:capture and npm run media:encode first.'
      );
    }
    shots[spec.shot] = dataUri(found, 'image/png');
    sources[spec.shot] = path.relative(PROJECT_ROOT, found).replace(/\\/g, '/');
  }
  return { shots, sources };
}

/**
 * Resolve the logo, whatever kind of file it turns out to be.
 *
 * A PNG today and an SVG the moment the brand track lands docs/media/brand/
 * logo.svg, which is exactly the swap --logo exists for. Embedded as a data URI
 * either way, so the artboard makes no request for it. A MISSING file is not an
 * error: it degrades to a drawn wordmark and says so on stdout, because a media
 * run that dies over one decorative asset blocks four ad stills that do not
 * need it. A file of an unsupported TYPE is an error, because that is a typo in
 * the flag rather than a missing dependency.
 *
 * @param {string|null} requested - The --logo value, or null for the default.
 * @returns {{logo: object|null, note: string}} The payload entry and a line for stdout.
 */
function resolveLogo(requested) {
  const relative = requested || DEFAULT_LOGO;
  const abs = path.isAbsolute(relative) ? relative : path.join(PROJECT_ROOT, relative);
  const shown = path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');

  if (!fs.existsSync(abs)) {
    return {
      logo: null,
      note: 'logo: ' + shown + ' not found, drawing the "' + FALLBACK_MARK_LETTER +
        '" wordmark instead. Pass --logo <path> to point at a real mark.',
    };
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = LOGO_MIME[ext];
  if (!mime) {
    throw new Error(
      'unsupported logo type "' + ext + '". Supported: ' + Object.keys(LOGO_MIME).join(', ')
    );
  }
  return {
    logo: { kind: ext === '.svg' ? 'svg' : 'raster', dataUri: dataUri(abs, mime) },
    note: 'logo: ' + shown + ' (' + (ext === '.svg' ? 'vector' : 'raster') + ', inlined as a data URI)',
  };
}

/* Verification
   ---------------------------------------------------------------------- */

/**
 * Fail the run unless both type stacks resolved to a real face.
 *
 * The control string is drawn in a stack whose only named family cannot exist,
 * so it is guaranteed to be the generic. If the real stack measures the same
 * width, it collapsed into that generic and every headline in the set is in the
 * wrong typeface. This is the assertion that stands between this pipeline and
 * the silent substitution the research measured out of sharp.
 *
 * @param {object} proof - The page's fontProof() result.
 * @returns {void}
 */
function assertFontProof(proof) {
  const loaded = proof.faces.filter((f) => f.status === 'loaded');
  if (loaded.length < FONT_FACES.length) {
    throw new Error(
      'expected ' + FONT_FACES.length + ' loaded faces, found ' + loaded.length + ': ' +
      JSON.stringify(proof.faces)
    );
  }
  for (const key of ['ui', 'mono']) {
    const entry = proof[key];
    if (Math.abs(entry.actual - entry.control) < 0.5) {
      throw new Error(
        'the ' + key + ' stack fell back to a generic face: it measures ' + entry.actual +
        'px, and so does the control stack that cannot resolve anything (' + entry.control + 'px). ' +
        'Stack was: ' + entry.stack
      );
    }
  }
  process.stdout.write(
    '  fonts    ui ' + (proof.ui.resolved || 'resolved') + ' at ' + proof.ui.actual +
    'px against a ' + proof.ui.control + 'px generic; mono ' +
    (proof.mono.resolved || 'resolved') + ' at ' + proof.mono.actual +
    'px against a ' + proof.mono.control + 'px generic\n'
  );
}

/**
 * Fail the run if any two artboards share a texture.
 *
 * The contract and the global design rules both require a repeated gradient or
 * grid to be seeded per artboard. Computed across the WHOLE manifest rather than
 * across the selection, so rendering one asset checks the same property a full
 * run does.
 *
 * @param {object} signatures - A map of artboard id to signature.
 * @returns {void}
 */
function assertTexturesUnique(signatures) {
  const seen = new Map();
  for (const [id, signature] of Object.entries(signatures)) {
    if (seen.has(signature)) {
      throw new Error(
        'artboards ' + seen.get(signature) + ' and ' + id + ' carry the same seeded texture. ' +
        'Every artboard must seed its own; change one of the ids or the seed derivation.'
      );
    }
    seen.set(signature, id);
  }
  process.stdout.write('  textures ' + seen.size + ' distinct seeds across ' +
    Object.keys(signatures).length + ' artboards\n');
}

/* Encoding
   ---------------------------------------------------------------------- */

/**
 * Downscale a 2x capture to its delivery width, inside its byte budget.
 *
 * Width only, never height. A still is not an animation, but encode.js keeps
 * that rule absolute because sharp lays an animation out as a filmstrip and a
 * height resize destroys it, and a rule that holds in one file and not its
 * neighbour is a rule somebody breaks later.
 *
 * @param {Buffer} capture - The raw 2x PNG from Playwright.
 * @param {object} spec - The artboard entry.
 * @returns {Promise<{buffer: Buffer, note: string, width: number, height: number}>} The delivery file.
 */
async function encodeArtboard(capture, spec) {
  let smallest = null;
  const tried = [];

  for (const attempt of PNG_ATTEMPTS) {
    const buffer = await sharp(capture)
      .resize({ width: spec.deliveryWidth, withoutEnlargement: true, kernel: 'lanczos3' })
      .png(attempt.options)
      .toBuffer();
    tried.push(attempt.note + ' ' + human(buffer.length));
    if (!smallest || buffer.length < smallest.buffer.length) {
      smallest = { buffer, note: attempt.note };
    }
    // The two lossless entries are both tried before anything is decided, so
    // the cheaper filter strategy wins on its own merits rather than by being
    // first. Colour is only given up once neither of them fits.
    if (attempt.lossy && buffer.length <= spec.maxBytes) {
      smallest = { buffer, note: attempt.note };
      break;
    }
    if (!attempt.lossy && attempt === PNG_ATTEMPTS[1] && smallest.buffer.length <= spec.maxBytes) break;
  }

  const meta = await sharp(smallest.buffer).metadata();
  if (meta.width !== spec.deliveryWidth) {
    throw new Error(
      spec.id + ' encoded to ' + meta.width + 'px wide, expected ' + spec.deliveryWidth +
      '. The capture was probably not at deviceScaleFactor ' + DEVICE_SCALE_FACTOR + '.'
    );
  }
  return {
    buffer: smallest.buffer,
    width: meta.width,
    height: meta.height,
    note: meta.width + 'x' + meta.height + ', ' + smallest.note +
      (tried.length > 2 ? ' (search ' + tried.join(' ') + ')' : ''),
  };
}

/**
 * Write a review copy small enough to open safely.
 *
 * @param {Buffer} buffer - The delivery PNG.
 * @param {object} spec - The artboard entry.
 * @returns {Promise<string>} The absolute path written.
 */
async function writeReviewThumb(buffer, spec) {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  const target = path.join(REVIEW_DIR, spec.id + '.png');
  await sharp(buffer)
    .resize({
      width: REVIEW_THUMB_MAX_PX,
      height: REVIEW_THUMB_MAX_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toFile(target);
  return target;
}

/* Reporting
   ---------------------------------------------------------------------- */

/**
 * Print the size table and report whether every still fits its budget.
 *
 * A line for line copy of printTable in encode.js, which does not export it.
 * Duplicated deliberately rather than fixed at the source, because encode.js is
 * another track's file in this session. The column widths, the padding and the
 * status words are identical on purpose: `npm run media:encode` and this script
 * print one table shape between them, so an operator reads both the same way.
 *
 * @param {Array<object>} rows - Encoded rows.
 * @returns {boolean} True when every row is inside its budget.
 */
function printSizeTable(rows) {
  const width = Math.max(24, ...rows.map((r) => r.file.length + 2));
  process.stdout.write('\n  ' + 'file'.padEnd(width) + 'size'.padStart(10) + 'budget'.padStart(11) + '   status\n');
  process.stdout.write('  ' + '-'.repeat(width + 21 + 12) + '\n');
  let ok = true;
  for (const row of rows) {
    const over = row.bytes > row.max;
    const under = row.min > 0 && row.bytes < row.min;
    if (over) ok = false;
    const status = over ? 'OVER BUDGET' : (under ? 'under target' : 'ok');
    process.stdout.write(
      '  ' + row.file.padEnd(width) +
      human(row.bytes).padStart(10) +
      human(row.max).padStart(11) +
      '   ' + status.padEnd(13) + row.note + '\n'
    );
  }
  process.stdout.write('\n  total committed: ' + human(rows.reduce((a, r) => a + r.bytes, 0)) + '\n');
  return ok;
}

/* Runner
   ---------------------------------------------------------------------- */

/**
 * Parse the command line.
 *
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{names: string[], logo: string|null, headed: boolean, list: boolean}} The parsed options.
 */
function parseArgs(argv) {
  const names = [];
  let logo = null;
  let headed = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--logo') {
      logo = argv[++i];
      if (!logo) throw new Error('--logo needs a path');
    } else if (arg.startsWith('--logo=')) {
      logo = arg.slice('--logo='.length);
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--list' || arg === '--table') {
      list = true;
    } else if (arg.startsWith('--')) {
      throw new Error('unknown flag: ' + arg);
    } else {
      names.push(arg);
    }
  }
  return { names, logo, headed, list };
}

/**
 * Render every selected artboard.
 *
 * @param {object} options - Parsed command line options.
 * @returns {Promise<Array<object>>} Rows for the size table.
 */
async function renderAll(options) {
  const selected = options.names.length
    ? ARTBOARDS.filter((a) => options.names.includes(a.id))
    : ARTBOARDS.slice();
  const unknown = options.names.filter((n) => !ARTBOARDS.some((a) => a.id === n));
  if (unknown.length) throw new Error('unknown artboard(s): ' + unknown.join(', '));

  const { logo, note } = resolveLogo(options.logo);
  const { shots, sources } = loadShots(selected);
  process.stdout.write('  ' + note + '\n');
  for (const [name, from] of Object.entries(sources)) {
    process.stdout.write('  shot     ' + name.padEnd(14) + from + '\n');
  }

  const payload = {
    fonts: loadFonts(),
    logo,
    markLetter: FALLBACK_MARK_LETTER,
    wordmark: WORDMARK,
    shots,
    // The whole manifest travels, not just the selection, so the page can
    // compute every texture signature and the uniqueness check means the same
    // thing on a one asset run.
    artboards: ARTBOARDS.map((spec) => JSON.parse(JSON.stringify(spec))),
  };

  const browser = await chromium.launch({
    headless: !options.headed,
    // The same two flags harness.js launches with: no scrollbar in frame, and a
    // fixed colour profile so a capture does not depend on the display.
    args: ['--hide-scrollbars', '--force-color-profile=srgb'],
  });

  const rows = [];
  try {
    const context = await browser.newContext({
      viewport: { width: ARTBOARDS[0].w, height: ARTBOARDS[0].h },
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      reducedMotion: 'reduce',
    });
    // Only http and https are intercepted, and both are refused. file: and
    // data: are left alone deliberately: routing the navigation itself would
    // be a way to break it, and the point of this rule is only to prove that
    // an artboard cannot quietly start depending on a remote font or image.
    await context.route(/^https?:/, (route) => route.abort());
    await context.addInitScript((data) => { window.__MEDIA__ = data; }, payload);

    const page = await context.newPage();
    // Collected rather than thrown from the handler. A throw inside a Playwright
    // event callback escapes the awaited call stack entirely and surfaces as an
    // unhandled rejection with no context about which artboard was rendering,
    // so the errors are drained at each checkpoint instead.
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    /**
     * Rethrow anything the page reported since the last checkpoint.
     *
     * @param {string} stage - What was happening, for the message.
     * @returns {void}
     */
    const drainPageErrors = (stage) => {
      if (!pageErrors.length) return;
      const messages = pageErrors.splice(0, pageErrors.length);
      throw new Error('artboard page error during ' + stage + ': ' + messages.join(' | '));
    };
    await page.goto(pathToFileURL(TEMPLATE).href, { waitUntil: 'load' });
    drainPageErrors('page load');

    const installed = await page.evaluate(() => window.__installAssets());
    process.stdout.write('  faces    ' + installed.installed.map((f) => f.family + ' ' + f.weight).join(', ') + '\n');
    assertFontProof(await page.evaluate(() => window.__fontProof()));
    assertTexturesUnique(await page.evaluate(() => window.__textureSignatures()));

    for (const spec of selected) {
      await page.setViewportSize({ width: spec.w, height: spec.h });
      const rendered = await page.evaluate((id) => window.__renderArtboard(id), spec.id);
      // A tolerance rather than equality: getBoundingClientRect is fractional,
      // and a border or a transform that added a subpixel is not the failure
      // this guard is looking for. A layout that overflowed its artboard is.
      if (Math.abs(rendered.width - spec.w) > 0.5 || Math.abs(rendered.height - spec.h) > 0.5) {
        throw new Error(
          spec.id + ' laid out at ' + rendered.width + 'x' + rendered.height +
          ', expected ' + spec.w + 'x' + spec.h
        );
      }
      const capture = await page.locator('#artboard').screenshot({ type: 'png', scale: 'device', animations: 'disabled' });
      drainPageErrors('rendering ' + spec.id);
      const encoded = await encodeArtboard(capture, spec);

      const target = path.join(OUT_DIR, spec.out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, encoded.buffer);
      const thumb = await writeReviewThumb(encoded.buffer, spec);

      rows.push({
        file: spec.out.replace(/\\/g, '/'),
        bytes: encoded.buffer.length,
        max: spec.maxBytes,
        min: 0,
        note: encoded.note,
        thumb,
      });
      process.stdout.write('  rendered ' + spec.id.padEnd(14) + human(encoded.buffer.length) + '\n');
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return rows;
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when every requested artboard is written.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    for (const spec of ARTBOARDS) {
      process.stdout.write(
        '  ' + spec.id.padEnd(16) + (spec.w + 'x' + spec.h).padEnd(11) +
        String(spec.deliveryWidth).padStart(5) + ' wide' +
        human(spec.maxBytes).padStart(10) + '   ' + spec.out.replace(/\\/g, '/') + '\n'
      );
    }
    return;
  }

  if (!fs.existsSync(TEMPLATE)) throw new Error('artboard template missing: ' + TEMPLATE);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = await renderAll(options);
  const ok = printSizeTable(rows);
  process.stdout.write('\n  review copies (gitignored, each at most ' + REVIEW_THUMB_MAX_PX + 'px):\n');
  for (const row of rows) {
    process.stdout.write('    ' + row.thumb.replace(/\\/g, '/') + '\n');
  }

  if (!ok) {
    process.stderr.write(
      '\nAt least one still is over its contract budget even at the bottom of the\n' +
      'colour search. The delivery width is contractual, so the fix is to give the\n' +
      'artboard less to compress: shrink the composited screenshot, tighten the\n' +
      'seeded grid mask, or renegotiate the budget in docs/marketing/MEDIA-CONTRACT.md.\n'
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('stills failed: ' + (err && err.message ? err.message : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  ARTBOARDS,
  HEADLINES,
  OUT_DIR,
  REVIEW_DIR,
  REVIEW_THUMB_MAX_PX,
  DEVICE_SCALE_FACTOR,
  AVATAR_SAFE_DIAMETER,
  BANNER_AVATAR_KEEPOUT,
  PNG_ATTEMPTS,
  SHOT_SOURCES,
  FONT_FACES,
  LOGO_MIME,
  parseArgs,
  resolveLogo,
  loadFonts,
  loadShots,
  assertFontProof,
  assertTexturesUnique,
  printSizeTable,
  encodeArtboard,
};
