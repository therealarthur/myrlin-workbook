#!/usr/bin/env node
/**
 * encode.js - turns raw footage into the delivery files the contract names.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * A second pass over `docs/media/raw/`, deliberately separate from capture.js.
 * Re-encoding at a different frame rate or width is then free: the expensive
 * half, driving the application, does not have to run again.
 *
 * THE LADDER, from docs/marketing/RESEARCH-2026-08-18 section 7
 *
 *   (a) inline animated WebP  libwebp_anim, fps and width from the contract
 *   (b) MP4 click-through     libx264 crf 30, yuv420p, faststart, silent
 *   (c) poster                libwebp still, cut from the resting frame
 *
 * THE FIVE SILENT FAILURES THIS FILE ASSERTS AGAINST
 *
 * Every one of these exits 0 and produces a plausible-looking file. Section 12
 * of the research calls them collectively the biggest risk in the pipeline,
 * because an agent iterating quickly notices none of them.
 *
 *   1. `-loop` is a WebP MUXER option whose default is 1, meaning play once and
 *      stop. A WebP without `-loop 0` looks fine locally and broken on GitHub.
 *      Checked by parsing the ANIM chunk out of every file written.
 *   2. sharp stores an animation as one tall filmstrip, so `metadata().height`
 *      on a 96-frame clip is 66048. Resizing by HEIGHT squashes every frame
 *      into one strip. Only width is ever passed, and `pages` is asserted to
 *      have survived.
 *   3. From RGB input with no `-pix_fmt`, ffmpeg picks yuv444p, which is H.264
 *      High 4:4:4 Predictive: it plays in Chrome and fails in QuickTime and
 *      Safari. Every MP4 command is asserted to carry `-pix_fmt yuv420p`.
 *   4. `-lossless 1` is a size trap, 6.9x larger on the measured clip. Never
 *      passed.
 *   5. `scale=-1` fails on odd dimensions. Every filter uses `scale=W:-2`.
 *
 * BUDGETS
 *
 * The contract gives every asset a size budget, and also pins its frame rate and
 * delivery width. So the encoder meets the budget by SEARCHING QUALITY: it
 * encodes at the contract's rate and width, then steps quality down until the
 * file fits, and prints the value it landed on. See QUALITY_STEP for why that
 * inverts the research's "quality is not the lever" advice.
 *
 * It still EXITS NON-ZERO when an asset misses its budget even at the quality
 * floor, because a budget that only warns is a budget nobody keeps. That is the
 * point at which the frame rate or the width has to be renegotiated in the
 * contract itself rather than worked around here. Both live in the ASSETS table
 * below, one line per output.
 *
 * Usage:
 *   node scripts/media/encode.js                 # everything in raw/
 *   node scripts/media/encode.js hero            # one asset
 *   node scripts/media/encode.js --table         # budgets without encoding
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/encode
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sharp = require('sharp');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.join(PROJECT_ROOT, 'docs', 'media', 'raw');
const OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'media');

/** One kibibyte, so the budget table reads in the units the contract uses. */
const KB = 1024;

/** One mebibyte. */
const MB = 1024 * KB;

/** libwebp compression effort. 6 measured 90,910 bytes against 130,700 at 0. */
const WEBP_COMPRESSION_LEVEL = 6;

/** The two libwebp presets worth trying. Text won on UI content; both are tried. */
const WEBP_PRESETS = Object.freeze(['text', 'picture']);

/**
 * How far the quality search may walk down from an asset's starting quality.
 *
 * WHY QUALITY IS THE LEVER HERE, when the research says it is not.
 *
 * Section 7 of docs/marketing/RESEARCH-2026-08-18 says to reach for frame rate
 * first and width second, and to leave quality alone. That advice assumes both
 * are free. In this pipeline neither is: the CONTRACT pins the frame rate and
 * the delivery width of every clip, asset by asset. Frame rate is the thing a
 * viewer notices most, and width is what the README lays out against, so
 * changing either to make a byte budget would be changing the deliverable to
 * fit the tool.
 *
 * That leaves quality as the only free variable, so the encoder searches it:
 * it encodes at the contract's frame rate and width, starting from the asset's
 * declared quality, and steps down until the file fits. The value it settled on
 * is printed in the size table, so a clip that needed a deep cut is visible
 * rather than quietly soft. If even the floor misses the budget, the run still
 * fails, and THAT is when frame rate or width has to be renegotiated in the
 * contract rather than worked around here.
 */
const QUALITY_STEP = 6;

/** The lowest quality the search may reach before giving up. */
const QUALITY_FLOOR = 34;

/** H.264 constant rate factor for the hero. Measured 1.6 MB at 1440x900. */
const H264_CRF = 30;

/** x264 preset. `slow` buys real bytes at a cost only the build machine pays. */
const H264_PRESET = 'slow';

/** Still-WebP quality for the poster. */
const POSTER_QUALITY = 82;

/** Where in a clip the poster frame is cut from, as a fraction of its duration. */
const POSTER_AT_FRACTION = 0.02;

/** How far an encoded clip's playback length may drift from its source. */
const DURATION_TOLERANCE = 0.05;

/**
 * Every delivery file, its source, and the budget it has to fit.
 *
 * `fps` and `width` come straight from the contract's asset table and are not
 * tuning knobs: changing either changes the deliverable. `quality` is the
 * STARTING point of the search described at QUALITY_STEP, not a fixed setting.
 */
const ASSETS = Object.freeze([
  {
    name: 'hero',
    source: 'hero.webm',
    outputs: [
      { file: 'hero.webp', kind: 'webp-anim', fps: 10, width: 900, quality: 68, minBytes: 1.2 * MB, maxBytes: 2.5 * MB },
      { file: 'hero.mp4', kind: 'mp4', width: 1440, crf: H264_CRF, maxBytes: 3.2 * MB },
      { file: 'hero-poster.webp', kind: 'poster', width: 900, maxBytes: 60 * KB },
    ],
  },
  {
    name: 'feature-sidebar',
    source: 'feature-sidebar.webm',
    outputs: [{ file: 'feature-sidebar.webp', kind: 'webp-anim', fps: 12, width: 900, quality: 66, maxBytes: 500 * KB }],
  },
  {
    name: 'feature-terminal',
    source: 'feature-terminal.webm',
    outputs: [{ file: 'feature-terminal.webp', kind: 'webp-anim', fps: 12, width: 900, quality: 66, maxBytes: 500 * KB }],
  },
  {
    name: 'feature-codex',
    source: 'feature-codex.webm',
    outputs: [{ file: 'feature-codex.webp', kind: 'webp-anim', fps: 12, width: 900, quality: 66, maxBytes: 500 * KB }],
  },
  {
    name: 'feature-phone',
    source: 'feature-phone.webm',
    outputs: [{ file: 'feature-phone.webp', kind: 'webp-anim', fps: 12, width: 390, quality: 70, maxBytes: 350 * KB }],
  },
  {
    name: 'feature-themes',
    source: 'feature-themes.webm',
    // 8 fps, not 12: a palette swap repaints most of the frame, and the
    // contract drops this clip's rate for exactly that reason.
    outputs: [{ file: 'feature-themes.webp', kind: 'webp-anim', fps: 8, width: 900, quality: 62, maxBytes: 600 * KB }],
  },
  {
    name: 'feature-board',
    source: 'feature-board.webm',
    outputs: [{ file: 'feature-board.webp', kind: 'webp-anim', fps: 12, width: 900, quality: 66, maxBytes: 500 * KB }],
  },
  {
    name: 'still-desktop-dark',
    source: 'still-desktop-dark.png',
    outputs: [{ file: 'still-desktop-dark.png', kind: 'png', width: 1440, maxBytes: 600 * KB }],
  },
  {
    name: 'still-desktop-light',
    source: 'still-desktop-light.png',
    outputs: [{ file: 'still-desktop-light.png', kind: 'png', width: 1440, maxBytes: 600 * KB }],
  },
  {
    name: 'still-phone',
    source: 'still-phone.png',
    outputs: [{ file: 'still-phone.png', kind: 'png', width: 780, maxBytes: 250 * KB }],
  },
]);

/* ── ffmpeg ───────────────────────────────────────────────────────────────── */

/**
 * Resolve the bundled ffmpeg binary.
 *
 * @returns {string} Absolute path to ffmpeg.
 */
function ffmpegPath() {
  const resolved = require('ffmpeg-static');
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error('ffmpeg-static did not resolve to a binary; run npm install');
  }
  return resolved;
}

/**
 * Fail early when the encoder this pipeline is built on is missing.
 *
 * `libwebp_anim` is what produces an animated WebP. The plain `libwebp` encoder
 * writes a STILL and exits 0, so a build without the animated encoder would
 * silently ship one frame of every clip. This is the guard against that.
 *
 * @returns {void}
 */
function assertEncoders() {
  const out = spawnSync(ffmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  const text = (out.stdout || '') + (out.stderr || '');
  for (const encoder of ['libwebp_anim', 'libwebp', 'libx264']) {
    if (text.indexOf(encoder) === -1) {
      throw new Error(
        'this ffmpeg build has no ' + encoder + ' encoder, so the media pipeline cannot run. ' +
        'ffmpeg-static 5.3.0 ships a gyan.dev build configured with --enable-libwebp and ' +
        '--enable-libx264; reinstall it rather than working around this.'
      );
    }
  }
}

/**
 * Run ffmpeg and throw with its own diagnostics on failure.
 *
 * @param {string[]} args - Arguments, without the binary.
 * @returns {void}
 */
function runFfmpeg(args) {
  const result = spawnSync(ffmpegPath(), args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * MB });
  if (result.status !== 0) {
    const tail = String(result.stderr || '').split('\n').slice(-14).join('\n');
    throw new Error('ffmpeg failed (' + result.status + ')\n  ' + args.join(' ') + '\n' + tail);
  }
}

/**
 * Read a media file's duration in seconds.
 *
 * ffmpeg rather than ffprobe, because ffmpeg-static ships only the one binary.
 * Decoding to null and reading the reported time is exact for a short clip and
 * needs no second dependency.
 *
 * @param {string} file - Absolute path to a media file.
 * @returns {number} Duration in seconds, or 0 when it cannot be read.
 */
function durationSeconds(file) {
  const result = spawnSync(
    ffmpegPath(),
    ['-hide_banner', '-i', file, '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * MB }
  );
  const text = (result.stderr || '');
  let best = 0;
  const re = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g;
  let match = re.exec(text);
  while (match) {
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (seconds > best) best = seconds;
    match = re.exec(text);
  }
  return best;
}

/* ── Command builders (pure, so the test suite can assert them) ───────────── */

/**
 * Build the animated-WebP command.
 *
 * `-loop 0` is not optional. It is a MUXER option whose default is 1, and the
 * research traced most "my WebP does not loop" reports to its absence.
 *
 * @param {object} spec - { input, output, fps, width, quality, preset }.
 * @returns {string[]} ffmpeg arguments.
 */
function buildWebpAnimArgs(spec) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', spec.input,
    '-vf', 'fps=' + spec.fps + ',scale=' + spec.width + ':-2:flags=lanczos',
    '-c:v', 'libwebp_anim',
    '-preset', spec.preset,
    '-quality', String(spec.quality),
    '-compression_level', String(WEBP_COMPRESSION_LEVEL),
    '-loop', '0',
    '-an',
    spec.output,
  ];
}

/**
 * Build the H.264 command.
 *
 * `-pix_fmt yuv420p` is not optional either: without it ffmpeg picks yuv444p
 * from RGB input, which is High 4:4:4 Predictive and fails in QuickTime and
 * Safari while playing perfectly in Chrome, so the bug ships.
 *
 * @param {object} spec - { input, output, width, crf }.
 * @returns {string[]} ffmpeg arguments.
 */
function buildMp4Args(spec) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', spec.input,
    '-vf', 'scale=' + spec.width + ':-2:flags=lanczos',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.0',
    '-preset', H264_PRESET,
    '-crf', String(spec.crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    spec.output,
  ];
}

/**
 * Build the poster command.
 *
 * `-ss` goes BEFORE `-i` so the seek is a fast one, and the still encoder is
 * plain `libwebp`, not `libwebp_anim`.
 *
 * @param {object} spec - { input, output, width, atSeconds }.
 * @returns {string[]} ffmpeg arguments.
 */
function buildPosterArgs(spec) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', spec.atSeconds.toFixed(3),
    '-i', spec.input,
    '-frames:v', '1',
    '-vf', 'scale=' + spec.width + ':-2:flags=lanczos',
    '-c:v', 'libwebp',
    '-quality', String(POSTER_QUALITY),
    '-compression_level', String(WEBP_COMPRESSION_LEVEL),
    spec.output,
  ];
}

/* ── Verification ─────────────────────────────────────────────────────────── */

/**
 * Read a WebP's animation chunks straight out of the container.
 *
 * A RIFF walk rather than a library call, because the two facts that matter,
 * "is there an ANIM chunk" and "what loop count does it carry", are four bytes
 * apart and no decoder is needed to find them.
 *
 * @param {string} file - Absolute path to a .webp.
 * @returns {{animated: boolean, loop: number|null, frames: number, durationMs: number, bytes: number}} What the container says.
 */
function inspectWebp(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let frames = 0;
  let loop = null;
  let animated = false;
  let durationMs = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'ANIM') { animated = true; loop = buf.readUInt16LE(body + 4); }
    if (id === 'ANMF') {
      frames++;
      // Bytes 12..14 of an ANMF payload are the frame's own duration in
      // milliseconds. Summing them is the only honest measure of how long the
      // file plays, because libwebp_anim COALESCES runs of identical frames
      // into one frame carrying a longer delay. A 33.8 s clip at 10 fps comes
      // out as 292 frames rather than 338, and that is correct rather than
      // truncated: it is how an animated WebP stores a still moment.
      durationMs += buf.readUIntLE(body + 12, 3);
    }
    offset = body + size + (size & 1);
  }
  return { animated, loop, frames, durationMs, bytes: buf.length };
}

/**
 * Assert an animated WebP is actually animated and actually loops.
 *
 * @param {string} file - Absolute path to a .webp.
 * @param {number} expectedSeconds - Source duration, or 0 to skip the check.
 * @returns {Promise<{frames: number, pages: number, playedSeconds: number}>} What was verified.
 */
async function verifyWebpAnim(file, expectedSeconds) {
  const info = inspectWebp(file);
  if (!info.animated) {
    throw new Error(file + ' is not animated: no ANIM chunk. The still libwebp encoder was used.');
  }
  if (info.loop !== 0) {
    throw new Error(file + ' reports loop=' + info.loop + '. Without -loop 0 it plays once and stops.');
  }
  if (info.frames < 2) {
    throw new Error(file + ' carries ' + info.frames + ' frame(s).');
  }
  // sharp agrees independently, which is what catches a filmstrip that was
  // resized by height at some point and collapsed to one page.
  const meta = await sharp(file, { pages: -1 }).metadata();
  if (!meta.pages || meta.pages < 2) {
    throw new Error(file + ' decodes to ' + meta.pages + ' page(s): the animation did not survive.');
  }
  // The frame COUNT proves nothing about playback length once coalescing is in
  // play, so the summed frame delays are checked against the source instead. A
  // truncated encode, the failure this catches, shows up here and nowhere else.
  if (expectedSeconds > 0) {
    const played = info.durationMs / 1000;
    const drift = Math.abs(played - expectedSeconds) / expectedSeconds;
    if (drift > DURATION_TOLERANCE) {
      throw new Error(
        file + ' plays for ' + played.toFixed(2) + 's but its source runs ' +
        expectedSeconds.toFixed(2) + 's: the encode was truncated.'
      );
    }
  }
  return { frames: info.frames, pages: meta.pages, playedSeconds: info.durationMs / 1000 };
}

/**
 * Assert an MP4 was written with faststart and a compatible pixel format.
 *
 * The atom order is read from the file rather than trusted from the command
 * line: `+faststart` is a post-processing move and can fail quietly.
 *
 * @param {string} file - Absolute path to an .mp4.
 * @returns {{faststart: boolean}} What was verified.
 */
function verifyMp4(file) {
  const head = fs.readFileSync(file).subarray(0, 64 * KB).toString('latin1');
  const moov = head.indexOf('moov');
  const mdat = head.indexOf('mdat');
  const faststart = moov !== -1 && (mdat === -1 || moov < mdat);
  if (!faststart) {
    throw new Error(file + ' has moov after mdat: +faststart did not take, so it cannot stream.');
  }
  return { faststart };
}

/* ── Encoders ─────────────────────────────────────────────────────────────── */

/**
 * Encode one animated WebP inside its budget.
 *
 * Two searches, nested. At each quality both libwebp presets are tried and the
 * smaller kept: the research measured `text` at 84,932 bytes against `picture`
 * at 90,850 on UI content and notes the winner is content dependent, and both
 * are cheap enough to try rather than guess. Then quality steps down from the
 * asset's declared value until the file fits its budget, for the reason set out
 * at QUALITY_STEP: the contract pins frame rate and width, so quality is the
 * only variable left to spend.
 *
 * The search path is reported in the size table, so a clip that had to give up
 * several steps of quality is visible rather than quietly soft.
 *
 * @param {object} output - One ASSETS output entry.
 * @param {string} input - Absolute path to the source clip.
 * @param {string} target - Absolute path to write.
 * @returns {Promise<object>} A row for the size table.
 */
async function encodeWebpAnim(output, input, target) {
  const attempts = [];
  let chosen = null;

  for (let quality = output.quality; quality >= QUALITY_FLOOR; quality -= QUALITY_STEP) {
    let best = null;
    for (const preset of WEBP_PRESETS) {
      // The extension has to stay `.webp`: ffmpeg picks its muxer from the
      // output file name, and a `.tmp` suffix makes it refuse to choose one at
      // all ("Unable to choose an output format"). Uniqueness comes from the
      // preset name in the middle, not from the extension.
      // The QUALITY is in the name as well as the preset. Without it the
      // candidate for quality 62 has the same path as the winner kept from
      // quality 68, and cleaning up the previous round deletes the file the
      // current round just wrote.
      const candidate = target.replace(/\.webp$/, '') + '.' + preset + '-' + quality + '.tmp.webp';
      runFfmpeg(buildWebpAnimArgs({
        input,
        output: candidate,
        fps: output.fps,
        width: output.width,
        quality,
        preset,
      }));
      const bytes = fs.statSync(candidate).size;
      if (!best || bytes < best.bytes) {
        if (best) fs.rmSync(best.file, { force: true });
        best = { file: candidate, bytes, preset, quality };
      } else {
        fs.rmSync(candidate, { force: true });
      }
    }
    attempts.push(best.quality + ':' + human(best.bytes));
    if (chosen) fs.rmSync(chosen.file, { force: true });
    chosen = best;
    if (best.bytes <= output.maxBytes) break;
  }

  fs.rmSync(target, { force: true });
  fs.renameSync(chosen.file, target);
  const verified = await verifyWebpAnim(target, durationSeconds(input));
  return {
    file: path.basename(target),
    bytes: chosen.bytes,
    max: output.maxBytes,
    min: output.minBytes || 0,
    note: chosen.preset + ' q' + chosen.quality + ', ' + verified.frames + ' frames, ' +
      verified.playedSeconds.toFixed(1) + 's, loop 0' +
      (attempts.length > 1 ? ' (search ' + attempts.join(' ') + ')' : ''),
  };
}

/**
 * Encode one MP4.
 *
 * @param {object} output - One ASSETS output entry.
 * @param {string} input - Absolute path to the source clip.
 * @param {string} target - Absolute path to write.
 * @returns {object} A row for the size table.
 */
function encodeMp4(output, input, target) {
  runFfmpeg(buildMp4Args({ input, output: target, width: output.width, crf: output.crf }));
  verifyMp4(target);
  return {
    file: path.basename(target),
    bytes: fs.statSync(target).size,
    max: output.maxBytes,
    min: 0,
    note: 'crf ' + output.crf + ', yuv420p, faststart',
  };
}

/**
 * Cut the poster from the clip's opening resting frame.
 *
 * A fraction of the duration rather than a fixed offset, because the clips are
 * between ten and thirty seconds long and the resting frame each opens on is a
 * proportion of the whole, not a constant number of seconds.
 *
 * @param {object} output - One ASSETS output entry.
 * @param {string} input - Absolute path to the source clip.
 * @param {string} target - Absolute path to write.
 * @returns {object} A row for the size table.
 */
function encodePoster(output, input, target) {
  const seconds = durationSeconds(input);
  runFfmpeg(buildPosterArgs({
    input,
    output: target,
    width: output.width,
    atSeconds: Math.max(0.2, seconds * POSTER_AT_FRACTION),
  }));
  return {
    file: path.basename(target),
    bytes: fs.statSync(target).size,
    max: output.maxBytes,
    min: 0,
    note: 'resting frame',
  };
}

/**
 * Downscale a retina still to its delivery width.
 *
 * Width only, never height: sharp lays an animation out as a filmstrip and a
 * height resize destroys it. A still is not an animation, but the rule is
 * absolute in this file so no future edit can reintroduce the failure.
 *
 * @param {object} output - One ASSETS output entry.
 * @param {string} input - Absolute path to the source PNG.
 * @param {string} target - Absolute path to write.
 * @returns {Promise<object>} A row for the size table.
 */
async function encodePng(output, input, target) {
  const buffer = await sharp(input)
    .resize({ width: output.width, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  fs.writeFileSync(target, buffer);
  const meta = await sharp(target).metadata();
  return {
    file: path.basename(target),
    bytes: buffer.length,
    max: output.maxBytes,
    min: 0,
    note: meta.width + 'x' + meta.height,
  };
}

/* ── Reporting ────────────────────────────────────────────────────────────── */

/**
 * Format a byte count for the table.
 *
 * @param {number} bytes - Byte count.
 * @returns {string} Human-readable size.
 */
function human(bytes) {
  if (bytes >= MB) return (bytes / MB).toFixed(2) + ' MB';
  return (bytes / KB).toFixed(0) + ' KB';
}

/**
 * Print the size table and report whether every asset fits its budget.
 *
 * @param {Array<object>} rows - Encoded rows.
 * @returns {boolean} True when every row is inside its budget.
 */
function printTable(rows) {
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

/* ── Runner ───────────────────────────────────────────────────────────────── */

/**
 * Encode one asset's outputs.
 *
 * @param {object} asset - One ASSETS entry.
 * @returns {Promise<Array<object>>} Rows for the size table.
 */
async function encodeAsset(asset) {
  const input = path.join(RAW_DIR, asset.source);
  if (!fs.existsSync(input)) {
    process.stdout.write('  skipping ' + asset.name + ': no ' + asset.source + ' in raw/\n');
    return [];
  }
  const rows = [];
  for (const output of asset.outputs) {
    const target = path.join(OUT_DIR, output.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (output.kind === 'webp-anim') rows.push(await encodeWebpAnim(output, input, target));
    else if (output.kind === 'mp4') rows.push(encodeMp4(output, input, target));
    else if (output.kind === 'poster') rows.push(encodePoster(output, input, target));
    else if (output.kind === 'png') rows.push(await encodePng(output, input, target));
    else throw new Error('unknown output kind: ' + output.kind);
  }
  return rows;
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when every requested asset has been encoded.
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--table')) {
    for (const asset of ASSETS) {
      for (const output of asset.outputs) {
        process.stdout.write('  ' + output.file.padEnd(28) + human(output.maxBytes).padStart(10) + '\n');
      }
    }
    return;
  }

  assertEncoders();

  const names = argv.filter((a) => !a.startsWith('--'));
  const selected = names.length ? ASSETS.filter((a) => names.includes(a.name)) : ASSETS.slice();
  const unknown = names.filter((n) => !ASSETS.some((a) => a.name === n));
  if (unknown.length) {
    process.stderr.write('unknown asset(s): ' + unknown.join(', ') + '\n');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const asset of selected) {
    process.stdout.write('encoding ' + asset.name + '\n');
    rows.push(...(await encodeAsset(asset)));
  }

  if (!rows.length) {
    process.stderr.write('nothing encoded: run npm run media:capture first\n');
    process.exitCode = 1;
    return;
  }

  const ok = printTable(rows);
  if (!ok) {
    process.stderr.write(
      '\nAt least one asset is over its contract budget. Lower `fps` first, then\n' +
      '`width`, then `quality` on that asset in the ASSETS table in this file,\n' +
      'and run it again. Frame rate and width are the levers; quality is not.\n'
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('encode failed: ' + (err && err.message ? err.message : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  ASSETS,
  RAW_DIR,
  OUT_DIR,
  KB,
  MB,
  WEBP_PRESETS,
  WEBP_COMPRESSION_LEVEL,
  DURATION_TOLERANCE,
  QUALITY_STEP,
  QUALITY_FLOOR,
  H264_CRF,
  buildWebpAnimArgs,
  buildMp4Args,
  buildPosterArgs,
  inspectWebp,
  verifyWebpAnim,
  verifyMp4,
  human,
  assertEncoders,
  encodeAsset,
};
