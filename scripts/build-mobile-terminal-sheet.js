#!/usr/bin/env node
/**
 * build-mobile-terminal-sheet.js - the before and after comparison sheet.
 * Created: 2026-08-19.
 *
 * WHAT IT MAKES
 *
 * One PNG, `screenshots/mobile-terminal/sheet.png`: four situations across,
 * the before row above the after row, each panel labelled with the numbers
 * the harness measured. Two directories of eight phone screenshots are not a
 * comparison, because a reviewer has to hold one in their head while looking
 * at the other.
 *
 * WHY THE PANELS ARE CROPPED
 *
 * A phone capture is 780 by 1688, and eight of those at any legible scale is
 * a sheet several thousand pixels tall. The global image rule caps every axis
 * at 2000px, and a sheet nobody can open is not a deliverable. The crop keeps
 * the pane body, which is the only region this work changed, and drops the
 * app header, the tab strips and the bottom navigation, which are identical
 * in every shot.
 *
 * Usage:
 *   node scripts/build-mobile-terminal-sheet.js
 *   node scripts/build-mobile-terminal-sheet.js --before <dir> --after <dir>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SHOT_ROOT = path.join(PROJECT_ROOT, 'screenshots', 'mobile-terminal');

// The image guard. Nothing this script writes may exceed it on either axis.
const ABSOLUTE_MAX_DIM = 2000;

/**
 * The pane body as a fraction of the capture's height. Above it are the app
 * header and the two tab strips, below it the bottom navigation; all of them
 * are pixel-identical across every shot in both runs, so they carry no
 * information here. Fractions rather than pixels so a future capture at a
 * different device scale factor still crops to the same region.
 */
const CROP_TOP_FRACTION = 0.34;
const CROP_BOTTOM_FRACTION = 0.90;

const SHEET_WIDTH = 1400;
const GUTTER = 14;
const HEADER_H = 92;
const COL_TITLE_H = 52;
const BAND_LABEL_H = 24;
const CAPTION_H = 56;
const BG = '#12121a';
const INK = '#e6e6f0';
const DIM = '#9a9ab0';
const BAD = '#f5a3a3';
const GOOD = '#a3e0b8';

/**
 * The columns of the sheet, in the order a reader should meet them: the
 * reported scenario first, then the states it leads to.
 */
const COLUMNS = [
  { shot: '1-desktop-owns', situation: '1-desktop-owns', title: 'Phone watching a desktop-driven session' },
  { shot: '6-sidecar-replay', situation: '6-sidecar-replay', title: 'Cold phone attach, from the server snapshot' },
  { shot: '2-phone-claims', situation: '2-phone-claims', title: 'After the phone takes the session over' },
  { shot: '3-phone-only', situation: '3-phone-only', title: 'A session the phone owns outright' },
];

/**
 * Read a run's manifest.
 *
 * @param {string} dir - Run directory.
 * @returns {object|null} The manifest, or null when the run is missing.
 */
function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * The measured numbers for one situation, as two short lines.
 *
 * @param {object|null} manifest - The run's manifest.
 * @param {string} situation - Situation id.
 * @returns {string[]} Caption lines.
 */
function caption(manifest, situation) {
  const m = manifest && manifest.situations ? manifest.situations[situation] : null;
  if (!m || !m.mounted) return ['not captured'];
  const total = manifest.fixture ? manifest.fixture.turns : 30;
  const first = 'grid ' + m.xtermCols + 'x' + m.xtermRows +
    '   PTY ' + (m.server ? m.server.cols + 'x' + m.server.rows : '?') +
    '   whole rows ' + m.intactRows + '/' + total;
  let second = 'fragments ' + m.fragmentRows + '   misplaced ' + m.rowPositionErrors;
  if (m.fidelityPct !== null && m.fidelityPct !== undefined) {
    second += '   matches owner ' + m.fidelityPct + '%';
  }
  return [first, second];
}

/**
 * Escape text for an SVG text node.
 *
 * @param {string} s - Raw text.
 * @returns {string} Escaped text.
 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render text as an SVG buffer sharp can composite.
 *
 * @param {number} width - Block width.
 * @param {number} height - Block height.
 * @param {Array<object>} lines - `{x, y, size, fill, weight, text}` records.
 * @returns {Buffer} SVG bytes.
 */
function textBlock(width, height, lines) {
  const body = lines.map((l) => (
    '<text x="' + l.x + '" y="' + l.y + '" font-family="Segoe UI, Helvetica, Arial, sans-serif" ' +
    'font-size="' + l.size + '" font-weight="' + (l.weight || '400') + '" ' +
    'fill="' + l.fill + '">' + esc(l.text) + '</text>'
  )).join('');
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
    '<rect width="' + width + '" height="' + height + '" fill="' + BG + '"/>' + body + '</svg>'
  );
}

/**
 * Crop one capture to the pane body and scale it to a column.
 *
 * @param {string} file - Capture path.
 * @param {number} colWidth - Target width.
 * @returns {Promise<{buffer: Buffer, height: number}|null>} Panel, or null.
 */
async function panel(file, colWidth) {
  if (!fs.existsSync(file)) return null;
  const meta = await sharp(file).metadata();
  const top = Math.round(meta.height * CROP_TOP_FRACTION);
  const height = Math.round(meta.height * CROP_BOTTOM_FRACTION) - top;
  const buffer = await sharp(file)
    .extract({ left: 0, top, width: meta.width, height })
    .resize({ width: colWidth })
    .png()
    .toBuffer();
  const out = await sharp(buffer).metadata();
  return { buffer, height: out.height };
}

/**
 * Build the sheet.
 *
 * @returns {Promise<string>} Path to the written PNG.
 */
async function build() {
  const argv = process.argv.slice(2);
  const at = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback;
  };
  const beforeDir = at('--before', path.join(SHOT_ROOT, 'before'));
  const afterDir = at('--after', path.join(SHOT_ROOT, 'after'));
  const beforeManifest = readManifest(beforeDir);
  const afterManifest = readManifest(afterDir);

  const colWidth = Math.floor((SHEET_WIDTH - GUTTER * (COLUMNS.length + 1)) / COLUMNS.length);

  // Panels are all the same capture size, so one probe sizes the whole sheet.
  const probe = await panel(path.join(beforeDir, COLUMNS[0].shot + '.png'), colWidth);
  assert.ok(probe, 'no before capture found in ' + beforeDir + '; run the harness first');
  const panelH = probe.height;

  const bandH = BAND_LABEL_H + panelH + CAPTION_H;
  const sheetH = HEADER_H + COL_TITLE_H + bandH * 2 + GUTTER * 2;

  assert.ok(SHEET_WIDTH <= ABSOLUTE_MAX_DIM && sheetH <= ABSOLUTE_MAX_DIM,
    'the sheet would be ' + SHEET_WIDTH + 'x' + sheetH + ', over the ' +
    ABSOLUTE_MAX_DIM + 'px image guard; crop harder or drop a column');

  const composites = [];
  composites.push({
    input: textBlock(SHEET_WIDTH, HEADER_H, [
      { x: GUTTER, y: 32, size: 21, weight: '700', fill: INK,
        text: 'Mobile terminal: the same phone, the same sessions, before and after' },
      { x: GUTTER, y: 58, size: 12.5, fill: DIM,
        text: 'Phone viewport 390 by 844 at a device pixel ratio of 2, cropped to the pane body. ' +
          'Fixture: an alternate-buffer agent CLI painting a 34 row frame by absolute cursor addressing.' },
      { x: GUTTER, y: 78, size: 12.5, fill: DIM,
        text: 'Measured by test/browser/mobile-terminal.spec.js. Fragments are rows carrying only part ' +
          'of a frame row; misplaced are rows painted where the application did not address them.' },
    ]),
    top: 0,
    left: 0,
  });

  composites.push({
    input: textBlock(SHEET_WIDTH, COL_TITLE_H, COLUMNS.map((c, i) => ({
      x: GUTTER + i * (colWidth + GUTTER),
      y: 30,
      size: 13,
      weight: '700',
      fill: INK,
      text: c.title,
    }))),
    top: HEADER_H,
    left: 0,
  });

  let y = HEADER_H + COL_TITLE_H;
  for (const band of [
    { dir: beforeDir, manifest: beforeManifest, label: 'BEFORE', fill: BAD },
    { dir: afterDir, manifest: afterManifest, label: 'AFTER', fill: GOOD },
  ]) {
    composites.push({
      input: textBlock(SHEET_WIDTH, BAND_LABEL_H, [
        { x: GUTTER, y: 17, size: 13, weight: '700', fill: band.fill, text: band.label },
      ]),
      top: y,
      left: 0,
    });
    const panelTop = y + BAND_LABEL_H;
    for (const [i, col] of COLUMNS.entries()) {
      const built = await panel(path.join(band.dir, col.shot + '.png'), colWidth);
      const left = GUTTER + i * (colWidth + GUTTER);
      if (built) composites.push({ input: built.buffer, top: panelTop, left });
      const lines = caption(band.manifest, col.situation);
      composites.push({
        input: textBlock(colWidth, CAPTION_H, lines.map((text, n) => ({
          x: 0, y: 20 + n * 18, size: 11.5, fill: DIM, text,
        }))),
        top: panelTop + panelH,
        left,
      });
    }
    y += bandH + GUTTER;
  }

  const out = path.join(SHOT_ROOT, 'sheet.png');
  await sharp({
    create: { width: SHEET_WIDTH, height: sheetH, channels: 3, background: BG },
  }).composite(composites).png({ compressionLevel: 9 }).toFile(out);

  const meta = await sharp(out).metadata();
  assert.ok(meta.width <= ABSOLUTE_MAX_DIM && meta.height <= ABSOLUTE_MAX_DIM,
    'the written sheet is ' + meta.width + 'x' + meta.height + ', over the image guard');
  console.log('wrote ' + out.replace(/\\/g, '/') + ' at ' + meta.width + 'x' + meta.height);
  return out;
}

build().catch((error) => {
  console.error('sheet build failed:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
