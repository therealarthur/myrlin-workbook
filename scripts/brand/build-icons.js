#!/usr/bin/env node
/**
 * scripts/brand/build-icons.js
 *
 * Rasterises the Myrlin Workbook icon set from the hand-authored vector masters in
 * docs/media/brand/. Run through `npm run brand:build`.
 *
 * WHY this script exists at all: before the vector track there was no square master,
 * only a 238x192 PNG, so every "512px app icon" in the project was a 2.7x upscale of a
 * small raster (docs/marketing/RESEARCH-2026-08-18.md section 3.8). Everything here now
 * comes off a real vector, at exact pixel sizes, in one reproducible command.
 *
 * WHY two sources: logo.svg carries #hat-detail (stitching, buckle, creases), which is
 * legible from roughly 48px up and fills into mud below that. favicon.svg is the same
 * core geometry with that group dropped. So the large icons render from logo.svg and the
 * 32 and 16 favicons render from favicon.svg. That is the whole "drop detail below a
 * size threshold" rule, expressed as a source choice rather than a runtime hack.
 *
 * WHY no .ico here: sharp will happily write a PNG to a path ending in .ico, report the
 * format as png, and exit 0 (RESEARCH section 8). Producing a real .ico needs png-to-ico,
 * which is not a dependency of this project, so the set stops at PNG plus the SVG
 * favicon, which is the 2026 minimum set anyway.
 *
 * Idempotent: same inputs produce byte-identical outputs, so re-running never churns git.
 *
 * IMPACT: writes only into docs/media/brand/. It does not touch src/web/public/, so the
 * running app's icons are unaffected; swapping those in is a separate, deliberate change.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/** Repo root, resolved from this file so the script runs from any cwd. */
const ROOT = path.resolve(__dirname, '..', '..');
/** Where the vector masters live and where the rasters are written. */
const BRAND_DIR = path.join(ROOT, 'docs', 'media', 'brand');

/**
 * The icon set. `source` names the vector master, `size` is the exact square pixel
 * size, `pad` is the fraction of the canvas left empty on every side (used only for
 * the maskable icon, which platforms crop into a circle or a squircle).
 */
const TARGETS = [
  { file: 'icon-512.png', source: 'logo.svg', size: 512, pad: 0, budget: 60 * 1024, note: 'web manifest, large' },
  { file: 'icon-192.png', source: 'logo.svg', size: 192, pad: 0, budget: 20 * 1024, note: 'web manifest, small' },
  { file: 'icon-180.png', source: 'logo.svg', size: 180, pad: 0, budget: 20 * 1024, note: 'apple touch icon' },
  { file: 'icon-maskable-512.png', source: 'logo.svg', size: 512, pad: 0.1, budget: 60 * 1024, note: 'maskable, 10 percent safe zone' },
  { file: 'favicon-32.png', source: 'favicon.svg', size: 32, pad: 0, budget: 4 * 1024, note: 'legacy tab icon' },
  { file: 'favicon-16.png', source: 'favicon.svg', size: 16, pad: 0, budget: 2 * 1024, note: 'legacy tab icon, small' },
];

/** Vector masters that must stay free of embedded raster data. */
const VECTOR_MASTERS = ['logo.svg', 'logo-mark.svg', 'favicon.svg', 'logo-lockup-light.svg', 'logo-lockup-dark.svg'];

/**
 * Fail loudly if a "vector" master smuggles in a raster, which is exactly how the old
 * docs/images/logo-animated.svg ended up being a 70 KB PNG in a trench coat.
 *
 * @param {string} file - File name inside docs/media/brand.
 * @returns {void}
 * @throws {Error} When the file contains an <image> element or a base64 payload.
 */
function assertNoRaster(file) {
  const svg = fs.readFileSync(path.join(BRAND_DIR, file), 'utf8');
  if (/<image[\s>]/i.test(svg)) throw new Error(`${file} contains an <image> element; the masters must be paths only`);
  if (/;base64,/i.test(svg)) throw new Error(`${file} contains a base64 payload; the masters must be paths only`);
}

/**
 * Render one target and verify the file that landed on disk really is the size asked for.
 *
 * Rasterising happens at the SVG's intrinsic 512px and is then resampled down, which is
 * what gives the 16px favicon usable antialiasing instead of a hinted-looking mess.
 *
 * @param {{file: string, source: string, size: number, pad: number}} target - One row of TARGETS.
 * @returns {Promise<{file: string, bytes: number, dims: string}>} What was written.
 */
async function renderTarget(target) {
  const svg = fs.readFileSync(path.join(BRAND_DIR, target.source));
  const inner = Math.round(target.size * (1 - target.pad * 2));
  const margin = Math.round((target.size - inner) / 2);

  let pipeline = sharp(svg, { unlimited: false }).resize(inner, inner, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  if (margin > 0) {
    pipeline = pipeline.extend({
      top: margin,
      bottom: target.size - inner - margin,
      left: margin,
      right: target.size - inner - margin,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }

  const out = path.join(BRAND_DIR, target.file);
  // compressionLevel and effort are pinned so repeated runs produce identical bytes.
  await pipeline.png({ compressionLevel: 9, effort: 10, palette: false }).toFile(out);

  const meta = await sharp(out).metadata();
  if (meta.width !== target.size || meta.height !== target.size) {
    throw new Error(`${target.file} came out ${meta.width}x${meta.height}, expected ${target.size}x${target.size}`);
  }
  if (meta.format !== 'png') {
    throw new Error(`${target.file} is ${meta.format}, expected png`);
  }
  return { file: target.file, bytes: fs.statSync(out).size, dims: `${meta.width}x${meta.height}` };
}

/**
 * Build the whole set and print a budget table, failing the process on any overrun so a
 * bloated icon can never be committed quietly.
 *
 * @returns {Promise<void>}
 */
async function main() {
  for (const file of VECTOR_MASTERS) {
    if (fs.existsSync(path.join(BRAND_DIR, file))) assertNoRaster(file);
  }

  const rows = [];
  for (const target of TARGETS) {
    rows.push({ ...(await renderTarget(target)), budget: target.budget, note: target.note });
  }

  const overruns = rows.filter((r) => r.bytes > r.budget);
  console.log('\n  Myrlin Workbook icon set  ->  docs/media/brand/\n');
  console.log('  file                      dims       size      budget   note');
  console.log('  ' + '-'.repeat(88));
  for (const r of rows) {
    const size = (r.bytes / 1024).toFixed(1) + ' KB';
    const budget = (r.budget / 1024).toFixed(0) + ' KB';
    const flag = r.bytes > r.budget ? '  OVER' : '';
    console.log(
      '  ' + r.file.padEnd(26) + r.dims.padEnd(11) + size.padStart(8) + budget.padStart(10) + '   ' + r.note + flag
    );
  }
  console.log('');

  if (overruns.length) {
    console.error(`  ${overruns.length} file(s) over budget.`);
    process.exitCode = 1;
    return;
  }
  console.log('  All icons within budget.\n');
}

main().catch((err) => {
  console.error('  build-icons failed:', err.message);
  process.exitCode = 1;
});
