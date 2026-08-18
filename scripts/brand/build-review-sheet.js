#!/usr/bin/env node
/**
 * scripts/brand/build-review-sheet.js
 *
 * Renders screenshots/brand-review/sheet.png: one page that puts the new vector master
 * beside the 238x192 raster it replaces, at every size the mark actually ships at, on
 * both a light and a dark ground, plus the monochrome mark, the favicon, the two lockups
 * and a filmstrip of the reveal. Run through `npm run brand:review`.
 *
 * WHY a sheet rather than eyeballing one 512px render: the only question that matters for
 * an icon is whether it still reads at 16 and 32 pixels, and that cannot be judged from a
 * large render. Putting the ladder and the source raster on one page makes a regression
 * in the small read obvious instead of arguable.
 *
 * Playwright renders the page rather than sharp compositing it, because the sheet carries
 * labels and the build machine has no Plus Jakarta Sans installed; sharp would silently
 * substitute a face for any text it drew (docs/marketing/RESEARCH-2026-08-18.md, 3.5).
 *
 * The output is deliberately capped at 1360px wide so it can be reviewed inline without
 * tripping the 2000px image ceiling.
 *
 * IMPACT: writes only screenshots/brand-review/. Reads the masters from docs/media/brand/.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');
const BRAND_DIR = path.join(ROOT, 'docs', 'media', 'brand');
const LEGACY_PNG = path.join(ROOT, 'docs', 'images', 'logo.png');
const OUT_DIR = path.join(ROOT, 'screenshots', 'brand-review');
const OUT = path.join(OUT_DIR, 'sheet.png');

const SHEET_WIDTH = 1360;
const LADDER = [16, 32, 64, 128];
const FILMSTRIP_STOPS = 8;
const ANIM_DURATION_MS = 2400;

/** Grounds the mark has to survive, taken from the app's own colour tokens. */
const LIGHT_GROUND = '#FFFFFF';
const DARK_GROUND = '#191919';

/**
 * Turn an absolute path into a file URL the page can load.
 *
 * @param {string} p - Absolute path.
 * @returns {string} file:// URL.
 */
function fileUrl(p) {
  return 'file://' + p.replace(/\\/g, '/');
}

/**
 * Capture evenly spaced stills from the reveal, so the sheet shows the motion as well as
 * the resting mark. Uses the same pause-and-seek method as build-logo-anim.js.
 *
 * @param {import('@playwright/test').Browser} browser - A live browser.
 * @param {string} dir - Scratch directory for the stills.
 * @returns {Promise<string[]>} Absolute paths, in time order.
 */
async function captureFilmstrip(browser, dir) {
  const context = await browser.newContext({
    viewport: { width: 300, height: 300 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  await page.goto(fileUrl(path.join(BRAND_DIR, 'logo-anim.html')));
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.evaluate(async () => {
    const anims = document.getAnimations();
    await Promise.all(anims.map((a) => a.ready.catch(() => null)));
    anims.forEach((a) => a.pause());
  });

  const out = [];
  for (let i = 0; i < FILMSTRIP_STOPS; i += 1) {
    const t = (i / (FILMSTRIP_STOPS - 1)) * ANIM_DURATION_MS * 0.98;
    await page.evaluate((ms) => {
      document.getAnimations().forEach((a) => {
        a.currentTime = ms;
      });
      return document.documentElement.getBoundingClientRect().width;
    }, t);
    const p = path.join(dir, `strip-${i}.png`);
    await page.screenshot({ path: p, omitBackground: true });
    out.push(p);
  }
  await context.close();
  return out;
}

/**
 * One size-ladder block: the vector on top, the raster it replaces underneath, each shown
 * at true size next to a pixel-doubled blow-up.
 *
 * @param {string} ground - Background colour for the block.
 * @param {string} ink - Label colour readable on that ground.
 * @returns {string} HTML.
 */
function ladderBlock(ground, ink) {
  const row = (src, label) => `
    <div class="ladder-row">
      <div class="ladder-label" style="color:${ink}">${label}</div>
      ${LADDER.map(
        (s) => `
        <div class="ladder-cell">
          <div class="true"><img src="${src}" width="${s}" height="${s}" alt=""></div>
          <div class="mag"><img src="${src}" alt=""></div>
          <div class="cap" style="color:${ink}">${s}</div>
        </div>`
      ).join('')}
    </div>`;
  return `
    <div class="ladder" style="background:${ground}">
      ${row(fileUrl(path.join(BRAND_DIR, 'logo.svg')), 'vector')}
      ${row(fileUrl(LEGACY_PNG), 'raster')}
    </div>`;
}

/**
 * Inline a mark's markup with its internal ids namespaced, so several copies can live in
 * one document without the second copy resolving url(#...) against the first.
 *
 * The monochrome mark has to be inlined rather than referenced through <img>: an SVG
 * loaded as an image is an isolated document, so currentColor resolves to that document's
 * own default (black) and the whole point of the file would not be visible.
 *
 * @param {string} file - File name inside docs/media/brand.
 * @param {string} suffix - Unique suffix for this copy's ids.
 * @param {number} size - Rendered square size in px.
 * @returns {string} SVG markup.
 */
function inlineMark(file, suffix, size) {
  let svg = fs.readFileSync(path.join(BRAND_DIR, file), 'utf8');
  svg = svg.replace(/myrlin-mark-cut/g, `myrlin-mark-cut-${suffix}`);
  svg = svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`);
  return svg.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Compose the whole sheet as one HTML document.
 *
 * @param {string[]} strip - Filmstrip still paths.
 * @returns {string} HTML.
 */
function sheetHtml(strip) {
  const logo = fileUrl(path.join(BRAND_DIR, 'logo.svg'));
  const legacy = fileUrl(LEGACY_PNG);

  const fav = fileUrl(path.join(BRAND_DIR, 'favicon.svg'));
  const lockLight = fileUrl(path.join(BRAND_DIR, 'logo-lockup-light.svg'));
  const lockDark = fileUrl(path.join(BRAND_DIR, 'logo-lockup-dark.svg'));

  return `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; width: ${SHEET_WIDTH}px; background: #F5F4F2;
    font: 400 13px/1.45 ui-sans-serif, "Segoe UI Variable Display", "Segoe UI", Helvetica, Arial, sans-serif;
    color: #2C2C2B; -webkit-font-smoothing: antialiased;
  }
  header { padding: 20px 30px 14px; border-bottom: 1px solid #E6E5E3; }
  h1 { margin: 0 0 4px; font-size: 21px; font-weight: 700; letter-spacing: -0.01em; }
  header p { margin: 0; color: #7D7A75; font-size: 13px; }
  section { padding: 16px 30px 18px; border-bottom: 1px solid #E6E5E3; }
  h2 { margin: 0 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
       text-transform: uppercase; color: #91918E; }
  .tiles { display: flex; gap: 14px; }
  .tile { border-radius: 10px; padding: 14px; display: grid; place-items: center; gap: 8px; }
  .tile span { font-size: 11px; letter-spacing: 0.02em; }
  .ladders { display: flex; gap: 14px; }
  .ladder { flex: 1; border-radius: 10px; padding: 16px 14px; }
  .ladder-row { display: flex; align-items: flex-end; gap: 14px; margin-bottom: 10px; }
  .ladder-row:last-child { margin-bottom: 0; }
  .ladder-label { width: 46px; font-size: 11px; letter-spacing: 0.04em; opacity: 0.75; }
  .ladder-cell { display: grid; gap: 6px; justify-items: center; }
  .true { height: 108px; display: grid; place-items: center; }
  .mag { width: 96px; height: 96px; display: grid; place-items: center; overflow: hidden; }
  .mag img { width: 96px; height: 96px; image-rendering: pixelated; }
  .cap { font-size: 11px; opacity: 0.7; }
  .row { display: flex; gap: 14px; align-items: stretch; }
  .plate { border-radius: 10px; padding: 12px; display: grid; place-items: center; gap: 10px; }
  .strip { display: flex; gap: 8px; }
  .strip div { width: 152px; height: 128px; border-radius: 8px; background: #FFFFFF;
               display: grid; place-items: center; border: 1px solid #E6E5E3; }
  .strip img { width: 116px; height: 116px; }
  .swatches { display: flex; gap: 8px; flex-wrap: wrap; }
  .sw { width: 118px; border-radius: 8px; overflow: hidden; border: 1px solid #E6E5E3; }
  .sw i { display: block; height: 46px; }
  .sw b { display: block; padding: 6px 8px 2px; font-size: 11px; font-weight: 600; }
  .sw em { display: block; padding: 0 8px 7px; font-size: 10px; font-style: normal; color: #7D7A75;
           font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  </style>
  <header>
    <h1>Myrlin Workbook, vector brand review</h1>
    <p>Hand-drawn 512 vector master against the 238&times;192 raster it replaces. The question this sheet answers is whether the 16 and 32 pixel reads are still the same hat.</p>
  </header>

  <section>
    <h2>Master against the source raster</h2>
    <div class="tiles">
      <div class="tile" style="background:${LIGHT_GROUND};border:1px solid #E6E5E3">
        <img src="${legacy}" width="188" alt=""><span style="color:#7D7A75">raster, light</span></div>
      <div class="tile" style="background:${LIGHT_GROUND};border:1px solid #E6E5E3">
        <img src="${logo}" width="188" height="188" alt=""><span style="color:#7D7A75">vector, light</span></div>
      <div class="tile" style="background:${DARK_GROUND}">
        <img src="${legacy}" width="188" alt=""><span style="color:#ADA9A3">raster, dark</span></div>
      <div class="tile" style="background:${DARK_GROUND}">
        <img src="${logo}" width="188" height="188" alt=""><span style="color:#ADA9A3">vector, dark</span></div>
    </div>
  </section>

  <section>
    <h2>Size ladder, true size next to a pixel-doubled blow-up</h2>
    <div class="ladders">
      ${ladderBlock(LIGHT_GROUND, '#2C2C2B')}
      ${ladderBlock(DARK_GROUND, '#F0EFED')}
    </div>
  </section>

  <section>
    <h2>Monochrome mark and favicon</h2>
    <div class="row">
      <div class="plate" style="background:${LIGHT_GROUND};border:1px solid #E6E5E3;color:#2C2C2B">
        ${inlineMark('logo-mark.svg', 'lt', 120)}
        <span style="font-size:11px;color:#7D7A75">logo-mark.svg, currentColor on light</span></div>
      <div class="plate" style="background:${DARK_GROUND};color:#F0EFED">
        ${inlineMark('logo-mark.svg', 'dk', 120)}
        <span style="font-size:11px;color:#ADA9A3">logo-mark.svg, currentColor on dark</span></div>
      <div class="plate" style="background:${LIGHT_GROUND};border:1px solid #E6E5E3">
        <div style="display:flex;gap:14px;align-items:flex-end">
          <img src="${fav}" width="16" height="16" alt="">
          <img src="${fav}" width="32" height="32" alt="">
          <img src="${fav}" width="112" height="112" style="image-rendering:pixelated" alt="">
        </div>
        <span style="font-size:11px;color:#7D7A75">favicon.svg, light scheme</span></div>
      <div class="plate" style="background:${DARK_GROUND};color-scheme:dark">
        <div style="display:flex;gap:14px;align-items:flex-end">
          <img src="${fav}" width="16" height="16" alt="">
          <img src="${fav}" width="32" height="32" alt="">
          <img src="${fav}" width="112" height="112" style="image-rendering:pixelated" alt="">
        </div>
        <span style="font-size:11px;color:#ADA9A3">favicon.svg, dark scheme, lifted ramp</span></div>
    </div>
  </section>

  <section>
    <h2>Lockups</h2>
    <div style="display:grid;gap:10px">
      <div class="plate" style="background:${LIGHT_GROUND};border:1px solid #E6E5E3;justify-items:start">
        <img src="${lockLight}" width="540" alt=""></div>
      <div class="plate" style="background:${DARK_GROUND};justify-items:start">
        <img src="${lockDark}" width="540" alt=""></div>
    </div>
  </section>

  <section>
    <h2>Reveal, eight equal stops across the 2.4 second loop</h2>
    <div class="strip">
      ${strip.map((p) => `<div><img src="${fileUrl(p)}" alt=""></div>`).join('')}
    </div>
  </section>

  <section style="border-bottom:none">
    <h2>Palette</h2>
    <div class="swatches">
      ${[
        ['#5A437A', 'Myrlin Purple', 'body'],
        ['#8E76A9', 'Purple Light', 'lit face'],
        ['#35164B', 'Purple Shade', 'shadow face'],
        ['#221033', 'Purple Ink', 'keyline'],
        ['#4BEDB3', 'Myrlin Mint', 'band, patches'],
        ['#2CBA8B', 'Mint Shade', 'band under-edge'],
        ['#7E63A0', 'Purple Lifted', 'body on dark'],
        ['#2A1440', 'Ink Lifted', 'keyline on dark'],
        ['#5DF3BE', 'Mint Lifted', 'mint on dark'],
      ]
        .map(([hex, name, role]) => `<div class="sw"><i style="background:${hex}"></i><b>${name}</b><em>${hex} &middot; ${role}</em></div>`)
        .join('')}
    </div>
  </section>`;
}

/**
 * Build the sheet.
 *
 * @returns {Promise<void>}
 */
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myrlin-brand-review-'));
  const browser = await chromium.launch();
  try {
    const strip = await captureFilmstrip(browser, scratch);
    const context = await browser.newContext({
      viewport: { width: SHEET_WIDTH, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
    });
    const page = await context.newPage();
    // The page is written to disk and navigated to rather than pushed in with setContent:
    // a setContent document has an about:blank origin, and Chromium refuses to load
    // file:// subresources into one, so every <img> would come out as a broken icon.
    const pagePath = path.join(scratch, 'sheet.html');
    fs.writeFileSync(pagePath, sheetHtml(strip), 'utf8');
    await page.goto(fileUrl(pagePath), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(
      Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
    ));
    await page.screenshot({ path: OUT, fullPage: true });
    const { width, height } = await page.evaluate(() => ({
      width: document.body.scrollWidth,
      height: document.body.scrollHeight,
    }));
    console.log(`\n  review sheet -> ${path.relative(ROOT, OUT)}  ${width}x${height}\n`);
    if (height > 2000) {
      console.warn('  WARNING: sheet is taller than 2000px; trim a section before reviewing it inline.');
    }
  } finally {
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('  build-review-sheet failed:', err.message);
  process.exitCode = 1;
});
