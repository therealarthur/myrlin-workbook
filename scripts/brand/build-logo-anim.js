#!/usr/bin/env node
/**
 * scripts/brand/build-logo-anim.js
 *
 * Renders the Myrlin Workbook logo reveal to docs/media/brand/logo-anim.webp (inline,
 * for READMEs) and docs/media/brand/logo-anim.mp4 (for social, where WebP is not
 * accepted). Run through `npm run brand:build`.
 *
 * METHOD, and why it is this one. Recording an animation in real time gives you frame
 * timing that depends on how busy the machine was, so two runs never match and a dropped
 * frame shows up as a stutter in the loop. Instead every animation in
 * docs/media/brand/logo-anim.html shares one 2400ms duration, so the page can be pinned
 * to an exact instant with `document.getAnimations().forEach(a => a.currentTime = t)`.
 * The script pauses everything, walks t in fixed steps, screenshots each step, and hands
 * the numbered PNGs to ffmpeg. The output is deterministic: same page, same frames.
 *
 * The last frame is the resting mark, and the timeline holds on that rest for its final
 * 24 percent, so the loop settles before it restarts rather than cutting away mid-move.
 *
 * WebP is written with alpha so the same file sits on a light or dark README without a
 * plate around it. MP4 cannot carry alpha, so those frames are composited onto the app's
 * own light ground #F9F8F7 rather than stark white.
 *
 * IMPACT: writes only into docs/media/brand/ plus a scratch frame directory that is
 * removed on success. Nothing the running app loads is touched.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { chromium } = require('@playwright/test');
const { readWebpInfo } = require('./webp-info');

const ROOT = path.resolve(__dirname, '..', '..');
const BRAND_DIR = path.join(ROOT, 'docs', 'media', 'brand');
const PAGE = path.join(BRAND_DIR, 'logo-anim.html');

/** Capture and delivery settings. One place to retune the whole clip. */
const CONFIG = {
  durationMs: 2400,
  fps: 25,
  captureSize: 1080, // MP4 delivery size; the WebP is downscaled from these frames.
  webpSize: 480, // Inside the contract's 400 to 600 px window.
  webpQuality: 70,
  mp4Crf: 26,
  mp4Plate: '0xF9F8F7', // The app's light secondary ground token.
  webpBudget: 200 * 1024,
  mp4Budget: 2 * 1024 * 1024,
};

/**
 * Step the paused page through the timeline and write one PNG per frame.
 *
 * @param {string} frameDir - Directory to fill with 0001.png, 0002.png, ...
 * @returns {Promise<number>} How many frames were written.
 */
async function captureFrames(frameDir) {
  const total = Math.round((CONFIG.durationMs / 1000) * CONFIG.fps);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: CONFIG.captureSize, height: CONFIG.captureSize },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference', // The page disables the animation under "reduce".
      colorScheme: 'light',
    });
    const page = await context.newPage();
    await page.goto('file://' + PAGE.replace(/\\/g, '/'));
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');

    const found = await page.evaluate(async () => {
      const anims = document.getAnimations();
      await Promise.all(anims.map((a) => a.ready.catch(() => null)));
      anims.forEach((a) => a.pause());
      return anims.length;
    });
    if (found === 0) throw new Error('logo-anim.html exposed no animations to step');

    for (let i = 0; i < total; i += 1) {
      // Last frame lands one step short of the duration so the loop does not repeat
      // frame 0 and frame N as the same instant twice.
      const t = (i / total) * CONFIG.durationMs;
      await page.evaluate((ms) => {
        document.getAnimations().forEach((a) => {
          a.currentTime = ms;
        });
        // Read layout back to force the pending style change to flush before capture.
        return document.documentElement.getBoundingClientRect().width;
      }, t);
      await page.screenshot({
        path: path.join(frameDir, String(i + 1).padStart(4, '0') + '.png'),
        omitBackground: true,
      });
    }
    return total;
  } finally {
    await browser.close();
  }
}

/**
 * Run ffmpeg with the given arguments, surfacing its stderr when it fails.
 *
 * @param {string[]} args - Arguments after the executable.
 * @returns {void}
 */
function runFfmpeg(args) {
  try {
    execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().split('\n').slice(-12).join('\n') : err.message;
    throw new Error('ffmpeg failed:\n' + detail);
  }
}

/**
 * Confirm the encoder this pipeline depends on is present in the bundled ffmpeg, rather
 * than discovering it is missing through an empty output file.
 *
 * @param {string} name - Encoder name, for example libwebp_anim.
 * @returns {void}
 * @throws {Error} When the encoder is absent.
 */
function assertEncoder(name) {
  const out = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  if (!new RegExp('\\s' + name + '\\s').test(out)) {
    throw new Error(`bundled ffmpeg has no ${name} encoder; cannot build the animation`);
  }
}

/**
 * Build both deliverables and report them against their budgets.
 *
 * @returns {Promise<void>}
 */
async function main() {
  assertEncoder('libwebp_anim');
  assertEncoder('libx264');

  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myrlin-logo-anim-'));
  let frames = 0;
  try {
    frames = await captureFrames(frameDir);

    const webpOut = path.join(BRAND_DIR, 'logo-anim.webp');
    runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(CONFIG.fps),
      '-i', path.join(frameDir, '%04d.png'),
      '-vf', `scale=${CONFIG.webpSize}:${CONFIG.webpSize}:flags=lanczos,format=rgba`,
      '-c:v', 'libwebp_anim',
      '-pix_fmt', 'yuva420p',
      '-lossless', '0',
      '-q:v', String(CONFIG.webpQuality),
      '-compression_level', '6',
      '-loop', '0',
      webpOut,
    ]);

    const mp4Out = path.join(BRAND_DIR, 'logo-anim.mp4');
    runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(CONFIG.fps),
      '-i', path.join(frameDir, '%04d.png'),
      '-f', 'lavfi',
      '-i', `color=c=${CONFIG.mp4Plate}:s=${CONFIG.captureSize}x${CONFIG.captureSize}:r=${CONFIG.fps}`,
      '-filter_complex', '[1:v][0:v]overlay=shortest=1,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', String(CONFIG.mp4Crf),
      '-movflags', '+faststart',
      '-an',
      mp4Out,
    ]);

    const info = readWebpInfo(webpOut);
    if (!info.animated) throw new Error('logo-anim.webp is not flagged animated');
    if (info.frames < 2) throw new Error(`logo-anim.webp carries ${info.frames} frame(s); expected the full sequence`);
    if (info.loop !== 0) throw new Error(`logo-anim.webp loop count is ${info.loop}; expected 0 (forever)`);

    const webpBytes = fs.statSync(webpOut).size;
    const mp4Bytes = fs.statSync(mp4Out).size;

    console.log('\n  Myrlin Workbook logo reveal  ->  docs/media/brand/\n');
    console.log(`  source frames        ${frames} at ${CONFIG.fps} fps (${CONFIG.durationMs}ms)`);
    console.log(`  logo-anim.webp       ${info.width}x${info.height}, ${info.frames} frames, loop ${info.loop}, ` +
      `${(webpBytes / 1024).toFixed(1)} KB / ${(CONFIG.webpBudget / 1024).toFixed(0)} KB`);
    console.log(`  logo-anim.mp4        ${CONFIG.captureSize}x${CONFIG.captureSize}, crf ${CONFIG.mp4Crf}, ` +
      `${(mp4Bytes / 1024 / 1024).toFixed(2)} MB / ${(CONFIG.mp4Budget / 1024 / 1024).toFixed(1)} MB\n`);

    const over = [];
    if (webpBytes > CONFIG.webpBudget) over.push('logo-anim.webp');
    if (mp4Bytes > CONFIG.mp4Budget) over.push('logo-anim.mp4');
    if (over.length) {
      console.error('  over budget: ' + over.join(', '));
      process.exitCode = 1;
      return;
    }
    console.log('  Both animation files within budget.\n');
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('  build-logo-anim failed:', err.message);
  process.exitCode = 1;
});
