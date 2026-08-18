#!/usr/bin/env node
/**
 * ads.js - renders the two vertical ad snippets the media contract names.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHAT IT PRODUCES
 *
 *   docs/media/ad-vertical-01.mp4   1080x1920, discovery, under 6 MB
 *   docs/media/ad-vertical-02.mp4   1080x1920, the terminal, under 6 MB
 *
 * Both are H.264 crf 26, yuv420p, faststart, carrying a SILENT AAC track,
 * between ten and fifteen seconds. Kinetic type over a cropped capture.
 *
 * WHY A FRAME STEPPER AND NOT A SCREENCAST
 *
 * capture.js films the live application with page.screencast, which is right
 * for a product tour: whatever the application does, the camera sees. It is
 * wrong for a composed advertisement. A screencast delivers frames when the
 * renderer produces them, so the timing of a type animation is a function of
 * how busy the machine was, and a rerun is never the same file twice. An ad
 * has to be reproducible, because the copy in it is going to be revised and
 * the only sane way to revise it is to rerun the command.
 *
 * So this file drives the clock instead of watching it. It renders a 1080x1920
 * page at deviceScaleFactor 1, and for every frame at 30 fps it swaps in the
 * matching capture frame, pins every animation on the page to that exact
 * millisecond through document.getAnimations(), waits for the compositor, and
 * screenshots. The output is deterministic: same input, same bytes.
 *
 * NO REMOTION. Remotion was considered and not needed. It would add a React
 * renderer, a bundler and a licence question (research section 5) to solve a
 * problem that the Web Animations API already solves in one page: pause every
 * animation, set currentTime, screenshot. The frame stepper below is about
 * eighty lines. Nothing was compromised to avoid the dependency.
 *
 * WHY THE CAPTURE IS A FRAME SEQUENCE AND NOT A VIDEO ELEMENT
 *
 * Seeking a video element is the obvious way to do this and it is the one that
 * fails quietly. video.currentTime plus the seeked event tells you the DECODER
 * arrived, not that the compositor drew it, and seeking inside a long inter
 * frame run in a VP8 stream is only as exact as the encoder's keyframes. An
 * off by one frame there is invisible in review and permanent in the file. So
 * the crop pass writes PNG frames and the page swaps an img, where
 * HTMLImageElement.decode() is a hard guarantee that the pixels are ready. The
 * cost is disk in a temp folder that is deleted at the end of the run.
 *
 * THE PIXEL RULE
 *
 * The crop pass upscales with lanczos to EXACTLY the size the page displays,
 * and the page pins the img to those dimensions. The browser therefore never
 * resamples the application screenshot, and nothing in the scene animates a
 * scale over the panel. Two resamples of 13px UI text is the difference
 * between readable and mushy on a phone.
 *
 * SAFETY
 *
 *   - NO NETWORK. Every request the page makes is intercepted and fulfilled
 *     from disk, and anything unmapped is aborted. The origin uses the
 *     reserved .invalid TLD so it cannot resolve even if interception broke.
 *   - NO REPO WRITES except the two delivery files and the gitignored review
 *     thumbnails. Frames live in a temp folder outside the repo.
 *   - The recursive delete at the end refuses to run on a path that is not
 *     inside the scratch root this process created.
 *
 * Usage:
 *   node scripts/media/ads.js                    # both ads
 *   node scripts/media/ads.js ad-vertical-01     # one ad
 *   node scripts/media/ads.js --table            # budgets, no rendering
 *   node scripts/media/ads.js --preview          # a few frames only, no encode
 *   node scripts/media/ads.js --keep-frames      # leave the temp frames behind
 *   node scripts/media/ads.js --headed           # watch the stage being shot
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/ads
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sharp = require('sharp');
const { chromium } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Where the stage lives. Served to the browser under the /scene/ prefix. */
const SCENE_DIR = path.join(__dirname, 'ad-scenes');

/** The application's own web root. Served under /app/ for the fonts and mark. */
const APP_PUBLIC_DIR = path.join(PROJECT_ROOT, 'src', 'web', 'public');

/** Raw footage from capture.js. Read only; this file never writes here. */
const RAW_DIR = path.join(PROJECT_ROOT, 'docs', 'media', 'raw');

/** The delivery folder named by the contract. */
const OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'media');

/** Downscaled frames for human and agent review. Gitignored via screenshots/. */
const REVIEW_DIR = path.join(PROJECT_ROOT, 'screenshots', 'media-review');

/**
 * Where the intermediate frames go.
 *
 * Outside the repository, always. A run writes roughly 700 MB of PNG per ad
 * and none of it is a deliverable. CWM_MEDIA_SCRATCH overrides it, which is
 * how an agent session points the run at its own scratchpad; the default is
 * the OS temp root so the script is not tied to one machine's folder layout.
 */
const SCRATCH_ROOT = process.env.CWM_MEDIA_SCRATCH
  ? path.resolve(process.env.CWM_MEDIA_SCRATCH)
  : path.join(os.tmpdir(), 'myrlin-media-ads');

/** One kibibyte, so the budget table reads in the units the contract uses. */
const KB = 1024;

/** One mebibyte. */
const MB = 1024 * KB;

/** The contract's capture size for both vertical snippets. */
const CANVAS = Object.freeze({ width: 1080, height: 1920 });

/**
 * Delivery frame rate.
 *
 * 30 and not the 10 to 12 the animated WebP clips use. Those numbers are a
 * BYTE budget decision for an inline README image, and they are wrong here for
 * two reasons: an MP4 codes a static plate almost for free, so the extra
 * frames cost little, and this composition is mostly type in motion, where a
 * low rate reads as a fault rather than as a style.
 */
const FPS = 30;

/** Constant rate factor. The contract pins 26 for the vertical snippets. */
const H264_CRF = 26;

/** x264 preset. Slow buys real bytes at a cost only the build machine pays. */
const H264_PRESET = 'slow';

/**
 * H.264 level.
 *
 * 4.2 rather than the 4.0 the hero uses, because 1080x1920 at 30 fps sits on
 * the exact edge of level 4.0: 68 by 120 macroblocks is 8160 against a 8192
 * ceiling, and 8160 times 30 is 244800 against a 245760 ceiling. Both fit with
 * under half a percent of headroom, which is not headroom. 4.2 is universally
 * supported on anything that can play a vertical video at all.
 */
const H264_LEVEL = '4.2';

/**
 * The pixel format, asserted into every H.264 command this file builds.
 *
 * From RGB PNG input with no flag ffmpeg picks yuv444p, which is High 4:4:4
 * Predictive. It plays in Chrome and fails in QuickTime and Safari, so the bug
 * ships. Research section 7 calls this the single most expensive silent
 * failure in the encode ladder, and assertH264Safety refuses to build a
 * command without it.
 */
const PIX_FMT = 'yuv420p';

/**
 * The silent audio track.
 *
 * Not optional and not decoration. Several social players, and some in app
 * browsers, mishandle a video with no audio stream at all: muted playback
 * controls do not appear, or the clip is treated as a GIF and looped without
 * the poster. A stereo 44.1 kHz null source costs about 2 KB per second.
 */
const SILENT_AUDIO_INPUT = 'anullsrc=channel_layout=stereo:sample_rate=44100';

/** Audio codec and bitrate for that silent track. */
const AUDIO_CODEC = 'aac';
const AUDIO_BITRATE = '128k';

/** The contract's byte budget for each vertical snippet. */
const AD_BUDGET_BYTES = 6 * MB;

/** The contract's duration window for a vertical snippet, in seconds. */
const DURATION_MIN_S = 10;
const DURATION_MAX_S = 15;

/** How far the encoded duration may drift from the frame count before it is
 *  treated as a truncated or padded encode rather than rounding. */
const DURATION_TOLERANCE_S = 0.12;

/**
 * The origin the stage is served from.
 *
 * .invalid is reserved by RFC 2606 and is guaranteed never to resolve, so if
 * the route interception below ever failed open the page would fail closed.
 * A file:// origin was rejected for the opposite reason: it is an opaque
 * origin with its own quiet rules about which subresources load.
 */
const ROUTE_ORIGIN = 'https://ads.myrlin.invalid';

/** Content types for everything the stage is allowed to load. A stylesheet
 *  served with the wrong type is refused outright in standards mode, which
 *  would render the ad unstyled rather than failing. */
const MIME_BY_EXT = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
});

/** Longest side any image this file writes for review may have. The agent
 *  review limit is 2000px on either axis and a 1080x1920 frame is over it on
 *  its long axis, so review copies are always cut down first. */
const REVIEW_MAX_DIM = 1300;

/** The hard ceiling that limit represents, asserted rather than trusted. */
const REVIEW_ABSOLUTE_MAX_DIM = 2000;

/** Where in each ad the review frames are cut from, as fractions of duration.
 *  Start, first hold, mid, and the closing card, which is the set that would
 *  expose a clipped line, a frozen panel or a mistimed beat. */
const REVIEW_AT_FRACTIONS = Object.freeze([0.06, 0.24, 0.58, 0.92]);

/**
 * Where a preview run samples the timeline, as fractions of duration.
 *
 * Wider than REVIEW_AT_FRACTIONS on purpose. A preview exists to catch a
 * composition fault before three quarters of an hour of rendering, so it wants
 * the moment each beat LANDS: the first line alone, the stack complete, the
 * panel risen, the long hold, the shrink in progress, and the closing card.
 */
const PREVIEW_FRACTIONS = Object.freeze([0.045, 0.10, 0.20, 0.28, 0.55, 0.68, 0.78, 0.94]);

/** How often the frame loop prints progress. Often enough to prove it is
 *  alive on a two minute render, rarely enough not to flood a log. */
const PROGRESS_EVERY = 30;

/* ── The two ads ──────────────────────────────────────────────────────────── */

/**
 * Every value that makes one ad what it is.
 *
 * COPY comes from the contract's "Ad still headlines" section, word for word.
 * The only editorial act here is where the line breaks fall, which is a
 * typographic decision rather than a copy change; the sentences are unaltered.
 *
 * CROP has to frame the thing the headline claims. It used to have a second
 * constraint, and that one is now gone: the Status column and the pane header
 * both carried a pill with a dot inside it, which this project bans outright in
 * any frame, so ad one cut at the column boundary before Status and ad two
 * started below the header strip. The 2026-08-18 status-mark sweep removed the
 * capsule from both (DECISIONS 13.6) and `capture.js` now refuses to record a
 * frame containing one, so neither crop is working around anything any more.
 *
 * WHAT THE GEOMETRY ACTUALLY ALLOWS, since the freed constraint tempts a
 * rewrite that cannot work. The panel is anchored at `panel.left`/`panel.top`
 * with `object-fit: cover` from its top left, so on a 1080x1920 canvas the
 * visible window into the panel is 1024 wide and 1220 tall, whatever the render
 * size is. Scaling the render scales that window in source pixels but never
 * changes its 0.839 ASPECT. A window that shows the full 900px height of a
 * capture is therefore at most 900 * 0.839 = 755 source pixels wide, out of
 * 1440. Ad one already sees 717 of them. Reaching the Status column, which
 * starts around x=950, would mean sliding the window right past x=305 and
 * losing the entire sidebar, in the ad whose headline ends "in one sidebar".
 * So ad one's framing is not a leftover of the ban; it is the only framing that
 * fits, and it is kept deliberately.
 *
 * Ad two is the one that moves. Its `y` drops from 132 to 88 so the pane header
 * is in frame: with the provider pill's dot gone there is nothing to avoid, and
 * a clip claiming "a terminal you can scroll back through" reads better as a
 * terminal PANE, with its title and its Select control, than as a floating
 * block of monospace.
 *
 * RENDER is the size the crop is upscaled to with lanczos, and the size the
 * page pins the img to, so the browser resamples nothing. It is always even on
 * both axes because odd dimensions break yuv420p chroma subsampling.
 *
 * PLATE is seeded per ad so the two clips cannot come out wearing the same
 * texture. Ad one runs violet over the neutral chrome of the session list; ad
 * two runs cold blue behind the violet transcript, with amber type, so the two
 * read as a set rather than as a duplicate.
 */
const ADS = Object.freeze([
  {
    name: 'ad-vertical-01',
    output: 'ad-vertical-01.mp4',
    source: 'feature-sidebar.webm',
    durationSeconds: 13.0,
    maxBytes: AD_BUDGET_BYTES,
    // Unchanged, and now by choice rather than by constraint: see the geometry
    // note above. 900 is the whole height of the capture, so the Discovered
    // section stays in frame, and at full height the panel can show 755 source
    // pixels of width at most. The sidebar and the session names are what the
    // headline is about, and they are what fits.
    crop: { x: 0, y: 0, width: 838, height: 900 },
    render: { width: 1196, height: 1284 },
    panel: { left: 56, top: 700 },
    eyebrow: 'Myrlin Workbook',
    headline: {
      size: 92,
      lines: [
        [{ t: 'Every ' }, { t: 'Claude Code', accent: 'a' }],
        [{ t: 'and ' }, { t: 'Codex', accent: 'b' }, { t: ' session' }],
        [{ t: 'on your machine,' }],
        [{ t: 'in one sidebar.' }],
      ],
    },
    cta: { claim: 'Open source. Runs locally.', command: 'npx myrlin-workbook@alpha' },
    plate: {
      base: '#0d0d0f',
      wash: '#1c1327',
      glow: '#b577d6',
      glowX: '20%',
      glowY: '24%',
      glowSize: '62%',
      gridPitch: '62px',
      gridAngle: '0deg',
      accentA: '#b577d6',
      accentB: '#5cba8a',
    },
  },
  {
    name: 'ad-vertical-02',
    output: 'ad-vertical-02.mp4',
    source: 'feature-terminal.webm',
    durationSeconds: 12.0,
    maxBytes: AD_BUDGET_BYTES,
    // y starts at 88 rather than 132 so the pane header is the top of the shot:
    // the provider chip it carries no longer has a dot inside it, so the reason
    // for cutting below it is gone, and the pane's own title and Select control
    // are what make the frame read as a terminal rather than as a block of
    // monospace. x still starts past the sidebar, so the shot is the pane and
    // nothing else.
    crop: { x: 250, y: 88, width: 754, height: 768 },
    render: { width: 1218, height: 1240 },
    panel: { left: 56, top: 700 },
    eyebrow: 'Myrlin Workbook',
    headline: {
      size: 88,
      lines: [
        [{ t: 'A terminal you can' }],
        [{ t: 'actually ' }, { t: 'scroll back', accent: 'a' }],
        [{ t: 'through and ' }, { t: 'copy from', accent: 'a' }, { t: '.' }],
      ],
    },
    cta: { claim: 'Open source. Runs locally.', command: 'npx myrlin-workbook@alpha' },
    plate: {
      base: '#0a0d11',
      wash: '#0f1c2a',
      glow: '#2783de',
      glowX: '78%',
      glowY: '18%',
      glowSize: '58%',
      gridPitch: '44px',
      gridAngle: '8deg',
      accentA: '#e0912f',
      accentB: '#37a4b4',
    },
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
 * Fail early when the encoders this file is built on are missing.
 *
 * libx264 and the native aac encoder are both required, and a build without
 * either would still produce a file: ffmpeg would pick something else and exit
 * 0. Checking up front is cheaper than discovering it after two minutes of
 * frame rendering.
 *
 * @returns {void}
 */
function assertEncoders() {
  const out = spawnSync(ffmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  const text = (out.stdout || '') + (out.stderr || '');
  for (const encoder of ['libx264', 'aac']) {
    if (text.indexOf(encoder) === -1) {
      throw new Error(
        'this ffmpeg build has no ' + encoder + ' encoder, so the ad pipeline cannot run. ' +
        'ffmpeg-static 5.3.0 ships a gyan.dev build that carries both; reinstall it ' +
        'rather than working around this.'
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
  const result = spawnSync(ffmpegPath(), args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * MB });
  if (result.status !== 0) {
    const tail = String(result.stderr || '').split('\n').slice(-14).join('\n');
    throw new Error('ffmpeg failed (' + result.status + ')\n  ' + args.join(' ') + '\n' + tail);
  }
}

/**
 * Read a media file's true duration by decoding it.
 *
 * The same approach encode.js uses, and for the same reason: ffmpeg-static
 * ships one binary and no ffprobe, and decoding to null reports the last
 * timestamp actually produced. That is a stronger statement than the container
 * header, which is what a truncated encode lies in.
 *
 * @param {string} file - Absolute path to a media file.
 * @returns {number} Duration in seconds, or 0 when it cannot be read.
 */
function decodedDuration(file) {
  const result = spawnSync(
    ffmpegPath(),
    ['-hide_banner', '-i', file, '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * MB }
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

/**
 * Read what streams a file actually carries.
 *
 * Parsed out of ffmpeg's own input report rather than ffprobe, for the reason
 * above. Everything asserted later comes from here: that there is a video
 * stream at the contract's size, that its pixel format is the compatible one,
 * and that the silent audio track survived the mux.
 *
 * @param {string} file - Absolute path to a media file.
 * @returns {{video: object|null, audio: object|null, headerSeconds: number}} What the container reports.
 */
function probeStreams(file) {
  const result = spawnSync(
    ffmpegPath(),
    ['-hide_banner', '-i', file],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * MB }
  );
  // ffmpeg exits non zero when given no output; the report is on stderr either
  // way, so the status is deliberately not checked here.
  const text = String(result.stderr || '');

  let headerSeconds = 0;
  const duration = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  if (duration) {
    headerSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  }

  let video = null;
  const videoLine = /Stream #\d+:\d+.*: Video: ([a-zA-Z0-9_]+)[^\n]*/.exec(text);
  if (videoLine) {
    const line = videoLine[0];
    const size = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(line);
    const pix = /:\sVideo:\s[a-zA-Z0-9_]+(?:\s\([^)]*\))*,\s([a-z0-9]+)/.exec(line);
    video = {
      codec: videoLine[1],
      width: size ? Number(size[1]) : 0,
      height: size ? Number(size[2]) : 0,
      pixFmt: pix ? pix[1] : null,
      line: line.trim(),
    };
  }

  let audio = null;
  const audioLine = /Stream #\d+:\d+.*: Audio: ([a-zA-Z0-9_]+)[^\n]*/.exec(text);
  if (audioLine) {
    audio = { codec: audioLine[1], line: audioLine[0].trim() };
  }

  return { video, audio, headerSeconds };
}

/* ── Command builders (pure, so they can be asserted before they run) ─────── */

/**
 * Build the crop and upscale pass that turns one raw clip into PNG frames.
 *
 * Filter ORDER is load bearing. crop first, so the fps and scale passes only
 * touch the pixels that survive; fps second, so the frame numbers the page
 * asks for are already at the delivery rate and the mapping from ad frame to
 * source frame is the identity; scale last, at lanczos, so the one upscale in
 * the whole pipeline is the good one.
 *
 * @param {object} spec - { input, outPattern, crop, render, frames }.
 * @returns {string[]} ffmpeg arguments.
 */
function buildCropFramesArgs(spec) {
  const crop = spec.crop;
  const render = spec.render;
  const filter = [
    'crop=' + crop.width + ':' + crop.height + ':' + crop.x + ':' + crop.y,
    'fps=' + FPS,
    'scale=' + render.width + ':' + render.height + ':flags=lanczos',
  ].join(',');
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', spec.input,
    '-vf', filter,
    '-frames:v', String(spec.frames),
    '-start_number', '0',
    spec.outPattern,
  ];
}

/**
 * Build the H.264 assembly command.
 *
 * Two inputs: the rendered frame sequence, and an endless null audio source.
 * `-shortest` is what stops the endless one, so the output length is the frame
 * count and nothing else. `-framerate` before the input is the image2 demuxer's
 * option and is not the same flag as the `-r` after it; both are set, because
 * the first decides how the stills are read and the second decides how they
 * are written.
 *
 * @param {object} spec - { pattern, output, crf }.
 * @returns {string[]} ffmpeg arguments.
 */
function buildAssembleArgs(spec) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-start_number', '0',
    '-i', spec.pattern,
    '-f', 'lavfi',
    '-i', SILENT_AUDIO_INPUT,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', H264_LEVEL,
    '-preset', H264_PRESET,
    '-crf', String(spec.crf),
    '-pix_fmt', PIX_FMT,
    '-r', String(FPS),
    '-c:a', AUDIO_CODEC,
    '-b:a', AUDIO_BITRATE,
    '-shortest',
    '-movflags', '+faststart',
    spec.output,
  ];
  assertH264Safety(args);
  return args;
}

/**
 * Build the review thumbnail command.
 *
 * Width only, and the height derived with -2, because a review copy that
 * distorts the frame would send a reviewer chasing a layout bug that is not
 * there. `-ss` before `-i` for a fast seek, as in encode.js.
 *
 * @param {object} spec - { input, output, atSeconds, width }.
 * @returns {string[]} ffmpeg arguments.
 */
function buildThumbnailArgs(spec) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', spec.atSeconds.toFixed(3),
    '-i', spec.input,
    '-frames:v', '1',
    '-vf', 'scale=' + spec.width + ':-2:flags=lanczos',
    spec.output,
  ];
}

/**
 * Refuse to build an H.264 command that is missing either flag that has to be
 * on it.
 *
 * This is a guard against a future edit, not against today's code. Both of
 * these have exactly one failure mode: the command succeeds, the file looks
 * right on the machine that made it, and it is broken somewhere the author
 * cannot see. An assertion is the only thing that catches that class.
 *
 * @param {string[]} args - A fully built ffmpeg argument list.
 * @returns {void}
 */
function assertH264Safety(args) {
  const pixIndex = args.indexOf('-pix_fmt');
  if (pixIndex === -1 || args[pixIndex + 1] !== PIX_FMT) {
    throw new Error(
      'refusing to encode without -pix_fmt ' + PIX_FMT + '. From RGB frames ffmpeg ' +
      'picks yuv444p, which plays in Chrome and fails in QuickTime and Safari.'
    );
  }
  const flagsIndex = args.indexOf('-movflags');
  if (flagsIndex === -1 || String(args[flagsIndex + 1]).indexOf('faststart') === -1) {
    throw new Error('refusing to encode without -movflags +faststart; the file could not stream.');
  }
  const audioIndex = args.indexOf('-c:a');
  if (audioIndex === -1) {
    throw new Error('refusing to encode without an audio stream; some players mishandle a video with none.');
  }
}

/* ── Verification ─────────────────────────────────────────────────────────── */

/**
 * Assert an MP4 really was written with faststart.
 *
 * The atom order is read out of the file rather than trusted from the command
 * line, because +faststart is a post processing move over the finished file
 * and it can fail without failing the encode.
 *
 * @param {string} file - Absolute path to an .mp4.
 * @returns {{moovAt: number, mdatAt: number}} Where each atom was found.
 */
function verifyFaststart(file) {
  const head = fs.readFileSync(file).subarray(0, 256 * KB).toString('latin1');
  const moov = head.indexOf('moov');
  const mdat = head.indexOf('mdat');
  if (moov === -1) {
    throw new Error(file + ' has no moov atom in its first 256 KB, so +faststart did not take.');
  }
  if (mdat !== -1 && moov > mdat) {
    throw new Error(file + ' has moov after mdat: +faststart did not take, so it cannot stream.');
  }
  return { moovAt: moov, mdatAt: mdat };
}

/**
 * Assert one finished ad meets every promise the contract makes about it.
 *
 * Size is checked by the table rather than here, because a size miss should
 * still print alongside the others rather than aborting the run at the first
 * one. Everything else is a correctness failure and throws.
 *
 * @param {object} ad - One ADS entry.
 * @param {string} file - Absolute path to the finished mp4.
 * @returns {object} What was verified, for the size table's note column.
 */
function verifyAd(ad, file) {
  const atoms = verifyFaststart(file);
  const probe = probeStreams(file);

  if (!probe.video) throw new Error(file + ' carries no video stream.');
  if (probe.video.width !== CANVAS.width || probe.video.height !== CANVAS.height) {
    throw new Error(
      file + ' is ' + probe.video.width + 'x' + probe.video.height +
      ' but the contract asks for ' + CANVAS.width + 'x' + CANVAS.height + '.'
    );
  }
  if (probe.video.pixFmt !== PIX_FMT) {
    throw new Error(
      file + ' is ' + probe.video.pixFmt + ' rather than ' + PIX_FMT +
      '. It will play in Chrome and fail in QuickTime and Safari.'
    );
  }
  if (!probe.audio) {
    throw new Error(file + ' carries no audio stream; the silent track did not survive the mux.');
  }

  const seconds = decodedDuration(file);
  if (seconds < DURATION_MIN_S || seconds > DURATION_MAX_S) {
    throw new Error(
      file + ' runs ' + seconds.toFixed(2) + 's, outside the contract window of ' +
      DURATION_MIN_S + ' to ' + DURATION_MAX_S + 's.'
    );
  }
  const expected = ad.durationSeconds;
  if (Math.abs(seconds - expected) > DURATION_TOLERANCE_S) {
    throw new Error(
      file + ' runs ' + seconds.toFixed(2) + 's but its frame count says ' + expected.toFixed(2) +
      's: frames were dropped or padded during assembly.'
    );
  }

  return {
    seconds,
    faststart: atoms.mdatAt === -1 || atoms.moovAt < atoms.mdatAt,
    pixFmt: probe.video.pixFmt,
    audioCodec: probe.audio.codec,
  };
}

/* ── Scratch space ────────────────────────────────────────────────────────── */

/**
 * Delete a directory, but only when it is genuinely inside the scratch root.
 *
 * A recursive delete driven by a computed path is the one operation in this
 * file that could do real damage if a future edit passed it the wrong value,
 * so it validates its argument rather than trusting the caller.
 *
 * @param {string} dir - Absolute path to remove.
 * @returns {void}
 */
function removeScratch(dir) {
  const target = path.resolve(dir);
  const root = path.resolve(SCRATCH_ROOT);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('refusing to delete ' + target + ': it is not inside the scratch root ' + root);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Frame file name for an index, zero padded so the image2 demuxer's %05d
 * pattern reads them in order rather than lexically wrong.
 *
 * @param {string} prefix - `src` or `frame`.
 * @param {number} index - Zero based frame index.
 * @returns {string} File name.
 */
function frameName(prefix, index) {
  return prefix + '-' + String(index).padStart(5, '0') + '.png';
}

/**
 * The full frame list for an ad, which is what a delivery run shoots.
 *
 * Spelled out as a list rather than as a loop bound so that a delivery run and
 * a preview run go through the SAME renderer. A preview that took a different
 * code path would be a preview of a different thing.
 *
 * @param {number} count - How many frames the ad has.
 * @returns {number[]} Every index from zero.
 */
function everyFrame(count) {
  const list = [];
  for (let i = 0; i < count; i++) list.push(i);
  return list;
}

/**
 * Width a review copy is cut to, so its long axis stays under the limit.
 *
 * Derived from the canvas rather than written down, because the limit applies
 * to the LONG axis and on a vertical frame that is the height. Rounded DOWN to
 * an even number: even because odd dimensions break chroma subsampling in any
 * later encode, down because rounding up would put the height back over.
 *
 * @returns {number} An even width in pixels.
 */
function reviewWidth() {
  return Math.floor(REVIEW_MAX_DIM * (CANVAS.width / CANVAS.height) / 2) * 2;
}

/* ── Capture crop pass ────────────────────────────────────────────────────── */

/**
 * Crop, resample and explode one raw clip into the frames the page will show.
 *
 * The mapping from ad frame to source frame is the identity, which is why the
 * fps filter runs here rather than being worked around in the page. It also
 * means the visible window into the source starts at its first frame, so the
 * resting state every capture opens on is spent under a panel that has not
 * risen yet rather than on camera.
 *
 * @param {object} ad - One ADS entry.
 * @param {string} dir - Directory to write into.
 * @param {number} frames - How many frames the ad needs.
 * @returns {{written: number, source: string}} What was produced.
 */
function extractSourceFrames(ad, dir, frames) {
  const input = path.join(RAW_DIR, ad.source);
  if (!fs.existsSync(input)) {
    throw new Error(
      'no ' + ad.source + ' in docs/media/raw/. Run `npm run media:capture` first; ' +
      'this file composes footage and never records it.'
    );
  }

  const available = decodedDuration(input);
  const needed = frames / FPS;
  if (available > 0 && available < needed) {
    throw new Error(
      ad.source + ' runs ' + available.toFixed(2) + 's but ' + ad.name + ' needs ' +
      needed.toFixed(2) + 's of it. Either shorten durationSeconds for this ad or ' +
      'lengthen the scene in capture.js; holding the last frame would read as a freeze.'
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  runFfmpeg(buildCropFramesArgs({
    input,
    outPattern: path.join(dir, 'src-%05d.png'),
    crop: ad.crop,
    render: ad.render,
    frames,
  }));

  const written = fs.readdirSync(dir).filter((f) => f.startsWith('src-') && f.endsWith('.png')).length;
  if (written !== frames) {
    throw new Error(
      'the crop pass wrote ' + written + ' frames for ' + ad.name + ' but ' + frames +
      ' were asked for. A short source produces a short ad silently, so this is fatal.'
    );
  }
  return { written, source: input };
}

/**
 * Extract one source frame, by index, for a preview run.
 *
 * A delivery run explodes the whole clip in one pass, which is far faster per
 * frame but costs the whole clip. A preview wants eight frames out of four
 * hundred, so it seeks instead. `-ss` goes AFTER `-i` here, the opposite of
 * the poster cut in encode.js: seeking before the input is fast and lands on
 * the nearest keyframe, and a preview that silently showed a neighbouring
 * frame would misreport exactly the timing this mode exists to check.
 *
 * @param {object} ad - One ADS entry.
 * @param {string} dir - Directory to write into.
 * @param {number} index - Zero based frame index at the delivery frame rate.
 * @returns {void}
 */
function extractSourceFrameAt(ad, dir, index) {
  const input = path.join(RAW_DIR, ad.source);
  if (!fs.existsSync(input)) {
    throw new Error('no ' + ad.source + ' in docs/media/raw/. Run `npm run media:capture` first.');
  }
  fs.mkdirSync(dir, { recursive: true });
  runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-ss', (index / FPS).toFixed(3),
    '-frames:v', '1',
    '-vf',
    'crop=' + ad.crop.width + ':' + ad.crop.height + ':' + ad.crop.x + ':' + ad.crop.y +
      ',scale=' + ad.render.width + ':' + ad.render.height + ':flags=lanczos',
    path.join(dir, frameName('src', index)),
  ]);
}

/* ── Stage rendering ──────────────────────────────────────────────────────── */

/**
 * Map one request path onto a file, refusing anything that climbs out of its
 * root.
 *
 * The stage only ever asks for three kinds of thing, so the map has three
 * entries and everything else is refused. The containment check is not
 * theoretical tidiness: the frames root is a computed path and a request path
 * is attacker shaped input in the general case, so the rule is that a resolved
 * target must still be inside the root it was resolved against.
 *
 * @param {string} pathname - The URL path, still percent encoded.
 * @param {object} roots - Prefix to directory map.
 * @returns {string|null} An absolute file path, or null when nothing matches.
 */
function resolveRoutePath(pathname, roots) {
  for (const prefix of Object.keys(roots)) {
    if (pathname.indexOf(prefix) !== 0) continue;
    let relative;
    try {
      relative = decodeURIComponent(pathname.slice(prefix.length));
    } catch (err) {
      return null;
    }
    // A NUL byte truncates a path in some system calls, so a name carrying one
    // can resolve to a file other than the one that was checked.
    if (!relative || relative.indexOf('\u0000') !== -1) return null;
    const root = path.resolve(roots[prefix]);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
    return target;
  }
  return null;
}

/**
 * Content type for a file, defaulting to a type no browser will execute.
 *
 * @param {string} file - A file path.
 * @returns {string} A content type.
 */
function mimeFor(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Photograph one ad, frame by frame, into a directory of PNGs.
 *
 * The loop is deliberately dull: for every frame, hand the page the capture
 * frame and the timestamp, let it decode and pin and composite, then shoot. No
 * waiting on wall clock time anywhere, which is what makes two runs of this
 * function produce the same bytes.
 *
 * @param {object} ad - One ADS entry.
 * @param {object} dirs - { source, frames } directories.
 * @param {number[]} indices - Which frame numbers to shoot, in order.
 * @param {object} options - { headed }.
 * @returns {Promise<object>} The page audit plus what was rendered.
 */
async function renderAdFrames(ad, dirs, indices, options) {
  const roots = {
    '/scene/': SCENE_DIR,
    '/app/': APP_PUBLIC_DIR,
    '/frames/': dirs.source,
  };

  const browser = await chromium.launch({ headless: !options.headed });
  const problems = [];
  const refused = new Set();
  try {
    const context = await browser.newContext({
      viewport: { width: CANVAS.width, height: CANVAS.height },
      // 1, always. Anything else resamples the capture a second time, and the
      // screenshot would come out at a size the contract does not name.
      deviceScaleFactor: 1,
      // The stage is a still life. Honouring a reduced motion preference here
      // would disable the very thing being filmed, so it is pinned to no
      // preference rather than inherited from the build machine.
      reducedMotion: 'no-preference',
      colorScheme: 'dark',
    });
    const page = await context.newPage();

    page.on('pageerror', (err) => problems.push('page error: ' + err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push('console error: ' + msg.text());
    });

    await page.route('**/*', async (route, request) => {
      let url;
      try {
        url = new URL(request.url());
      } catch (err) {
        await route.abort();
        return;
      }
      if (url.origin !== ROUTE_ORIGIN) {
        refused.add(url.origin + url.pathname);
        await route.abort();
        return;
      }
      const file = resolveRoutePath(url.pathname, roots);
      if (!file) {
        refused.add(url.pathname);
        await route.abort();
        return;
      }
      await route.fulfill({ path: file, contentType: mimeFor(file) });
    });

    // Injected before any script on the page runs, so the stage never has to
    // cope with a missing config or poll for one.
    await page.addInitScript((config) => { window.__MYRLIN_AD__ = config; }, {
      name: ad.name,
      durationSeconds: ad.durationSeconds,
      render: ad.render,
      panel: ad.panel,
      plate: ad.plate,
      headline: ad.headline,
      eyebrow: ad.eyebrow,
      cta: ad.cta,
    });

    await page.goto(ROUTE_ORIGIN + '/scene/ad-vertical.html', { waitUntil: 'load' });

    // Before the first frame, not after. A frame shot during the font swap
    // window ships the fallback face, and nothing downstream would notice.
    await page.evaluate(async () => { await document.fonts.ready; return true; });

    const built = await page.evaluate(() => window.adBuild());
    const audit = await page.evaluate(() => window.adAudit());
    assertStageIsSound(ad, audit, built);

    fs.mkdirSync(dirs.frames, { recursive: true });
    for (let shot = 0; shot < indices.length; shot++) {
      const index = indices[shot];
      const sourceUrl = ROUTE_ORIGIN + '/frames/' + frameName('src', index);
      const step = await page.evaluate(
        (payload) => window.adPrepareFrame(payload.url, payload.timeMs),
        { url: sourceUrl, timeMs: (index / FPS) * 1000 }
      );
      if (!step.painted) {
        problems.push('frame ' + index + ' timed out waiting for the compositor');
      }
      await page.screenshot({
        path: path.join(dirs.frames, frameName('frame', index)),
        type: 'png',
        // 'allow' and never 'disabled'. Playwright's disabled mode FINISHES
        // every animation before it shoots, which would render the last frame
        // of the timeline into every frame of the ad.
        animations: 'allow',
        caret: 'hide',
        scale: 'css',
      });
      if (shot > 0 && shot % PROGRESS_EVERY === 0) {
        process.stdout.write('    frame ' + shot + '/' + indices.length + '\n');
      }
    }

    await context.close();
    return { audit, built, problems, refused: Array.from(refused) };
  } finally {
    await browser.close();
  }
}

/**
 * Refuse to spend two minutes photographing a stage that is already wrong.
 *
 * Every check here is for a failure that produces a plausible looking file:
 * the wrong typeface, a headline running off the side of the frame, a stage
 * that laid out at the wrong size. None of them raise an error on their own.
 *
 * @param {object} ad - One ADS entry.
 * @param {object} audit - What window.adAudit() reported.
 * @param {object} built - What window.adBuild() reported.
 * @returns {void}
 */
function assertStageIsSound(ad, audit, built) {
  if (audit.stage.width !== CANVAS.width || audit.stage.height !== CANVAS.height) {
    throw new Error(
      'the stage laid out at ' + audit.stage.width + 'x' + audit.stage.height +
      ' rather than ' + CANVAS.width + 'x' + CANVAS.height + '.'
    );
  }
  if (!audit.monoResolves || !audit.monoLoaded || !audit.monoBoldLoaded) {
    throw new Error(
      'the self hosted mono face did not resolve, so the eyebrow and the closing ' +
      'command would ship in Courier with no error anywhere. Check that ' +
      'src/web/public/design/notion/fonts/ still holds the iA Writer Mono woff2 files.'
    );
  }
  if (!audit.displayResolved) {
    throw new Error('no family in the display stack resolved, so the headline would ship in a fallback face.');
  }
  const overflowing = audit.lines.filter((line) => line.overflows);
  if (overflowing.length) {
    throw new Error(
      ad.name + ' has ' + overflowing.length + ' headline line(s) wider than the safe area: ' +
      overflowing.map((l) => '"' + l.text + '" at ' + l.width + 'px against ' + audit.usableWidth + 'px').join('; ') +
      '. Break the line differently or drop the headline size in the ADS table.'
    );
  }
  if (built.animations < ad.headline.lines.length) {
    throw new Error('the stage built ' + built.animations + ' animations, which is fewer than it has headline lines.');
  }
  if (built.headlineTop < 0) {
    throw new Error(
      ad.name + ' positions its headline above the top of frame (' + built.headlineTop + 'px). ' +
      'The block is too tall for the space above the panel; lower the headline size or the panel.'
    );
  }
}

/* ── Assembly and review ──────────────────────────────────────────────────── */

/**
 * Assemble one ad's frames into the delivery file and verify what came out.
 *
 * @param {object} ad - One ADS entry.
 * @param {string} framesDir - Directory of rendered frames.
 * @param {string} target - Absolute path to write.
 * @returns {object} A row for the size table.
 */
function assembleAd(ad, framesDir, target) {
  runFfmpeg(buildAssembleArgs({
    pattern: path.join(framesDir, 'frame-%05d.png'),
    output: target,
    crf: H264_CRF,
  }));
  const verified = verifyAd(ad, target);
  return {
    file: path.basename(target),
    bytes: fs.statSync(target).size,
    max: ad.maxBytes,
    min: 0,
    seconds: verified.seconds,
    note: 'crf ' + H264_CRF + ', ' + verified.pixFmt + ', faststart, silent ' +
      verified.audioCodec + ', ' + verified.seconds.toFixed(2) + 's at ' + FPS + ' fps',
  };
}

/**
 * Cut downscaled review copies out of the finished file.
 *
 * WHY DOWNSCALED, and why this is asserted rather than assumed: a delivered
 * frame is 1920px on its long axis and an image over 2000px on either axis
 * cannot be looked at by a reviewing agent without poisoning its context. So
 * the review copies are cut to REVIEW_MAX_DIM and then MEASURED, because a
 * scale filter that silently did nothing would produce exactly the file this
 * rule exists to prevent.
 *
 * @param {object} ad - One ADS entry.
 * @param {string} file - Absolute path to the finished mp4.
 * @param {number} seconds - The file's verified duration.
 * @returns {Promise<string[]>} Absolute paths to the review copies.
 */
async function writeReviewThumbnails(ad, file, seconds) {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  // Width, so the long axis (height) lands on the limit exactly.
  const width = reviewWidth();
  const written = [];
  for (let i = 0; i < REVIEW_AT_FRACTIONS.length; i++) {
    const atSeconds = Math.min(seconds - 0.05, Math.max(0, seconds * REVIEW_AT_FRACTIONS[i]));
    const target = path.join(REVIEW_DIR, ad.name + '-t' + i + '.png');
    runFfmpeg(buildThumbnailArgs({ input: file, output: target, atSeconds, width }));
    const meta = await sharp(target).metadata();
    if (Math.max(meta.width, meta.height) > REVIEW_ABSOLUTE_MAX_DIM) {
      throw new Error(
        target + ' came out ' + meta.width + 'x' + meta.height + ', over the ' +
        REVIEW_ABSOLUTE_MAX_DIM + 'px review limit. The scale filter did not take.'
      );
    }
    written.push(target);
  }
  return written;
}

/* ── Reporting ────────────────────────────────────────────────────────────── */

/**
 * Format a byte count for the table. Mirrors encode.js so the two commands
 * print in the same units.
 *
 * @param {number} bytes - Byte count.
 * @returns {string} Human-readable size.
 */
function human(bytes) {
  if (bytes >= MB) return (bytes / MB).toFixed(2) + ' MB';
  return (bytes / KB).toFixed(0) + ' KB';
}

/**
 * Print the size table and report whether every ad fits its budget.
 *
 * @param {Array<object>} rows - Assembled rows.
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
 * Build one ad end to end.
 *
 * The scratch directory is removed in a finally, so a failure halfway through
 * does not leave several hundred megabytes of PNG behind on every retry.
 *
 * @param {object} ad - One ADS entry.
 * @param {object} options - { headed, keepFrames }.
 * @returns {Promise<object>} { row, thumbnails, problems }.
 */
async function buildAd(ad, options) {
  const frames = Math.round(ad.durationSeconds * FPS);
  const runDir = path.join(SCRATCH_ROOT, ad.name);
  const dirs = { source: path.join(runDir, 'source'), frames: path.join(runDir, 'frames') };

  process.stdout.write('building ' + ad.name + ' (' + frames + ' frames, ' + ad.durationSeconds.toFixed(1) + 's)\n');
  try {
    // Idempotent: a previous run's frames would otherwise be counted as this
    // run's, and a shorter ad would inherit the tail of a longer one.
    removeScratch(runDir);
    fs.mkdirSync(dirs.source, { recursive: true });
    fs.mkdirSync(dirs.frames, { recursive: true });

    process.stdout.write('  cropping ' + ad.source + ' to ' +
      ad.crop.width + 'x' + ad.crop.height + ' at ' + ad.crop.x + ',' + ad.crop.y +
      ' and resampling to ' + ad.render.width + 'x' + ad.render.height + '\n');
    extractSourceFrames(ad, dirs.source, frames);

    process.stdout.write('  rendering the stage\n');
    const rendered = await renderAdFrames(ad, dirs, everyFrame(frames), options);
    process.stdout.write('    ' + rendered.built.animations + ' animations, headline at ' +
      rendered.built.headlineTop + 'px in ' + rendered.audit.displayResolved + '\n');

    const firstFrame = path.join(dirs.frames, frameName('frame', 0));
    const meta = await sharp(firstFrame).metadata();
    if (meta.width !== CANVAS.width || meta.height !== CANVAS.height) {
      throw new Error(
        'the stage screenshot came out ' + meta.width + 'x' + meta.height +
        ' rather than ' + CANVAS.width + 'x' + CANVAS.height + '.'
      );
    }

    process.stdout.write('  encoding\n');
    const target = path.join(OUT_DIR, ad.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const row = assembleAd(ad, dirs.frames, target);

    const thumbnails = await writeReviewThumbnails(ad, target, row.seconds);
    return { row, thumbnails, problems: rendered.problems, refused: rendered.refused };
  } finally {
    if (options.keepFrames) {
      process.stdout.write('  keeping frames in ' + runDir + '\n');
    } else {
      removeScratch(runDir);
    }
  }
}

/**
 * Render a handful of frames of one ad and stop.
 *
 * WHY THIS MODE EXISTS. A delivery run is four hundred screenshots and an x264
 * pass at preset slow, which is minutes. Almost every fault worth catching is
 * a composition fault visible in one frame: a line that overflows, a beat that
 * lands on the wrong second, type sitting on a busy part of the capture. This
 * mode answers those in seconds, and it goes through the SAME renderer as the
 * delivery run, so an answer here is an answer about the real thing.
 *
 * It writes only downscaled copies, never a full size frame, because a
 * 1080x1920 frame is over the review limit on its long axis.
 *
 * @param {object} ad - One ADS entry.
 * @param {object} options - { headed, keepFrames }.
 * @returns {Promise<string[]>} Absolute paths to the preview copies.
 */
async function previewAd(ad, options) {
  const frames = Math.round(ad.durationSeconds * FPS);
  const indices = PREVIEW_FRACTIONS
    .map((fraction) => Math.min(frames - 1, Math.round(frames * fraction)))
    .filter((value, at, all) => all.indexOf(value) === at);
  const runDir = path.join(SCRATCH_ROOT, ad.name + '-preview');
  const dirs = { source: path.join(runDir, 'source'), frames: path.join(runDir, 'frames') };

  process.stdout.write('previewing ' + ad.name + ' at frames ' + indices.join(', ') + '\n');
  try {
    removeScratch(runDir);
    fs.mkdirSync(dirs.source, { recursive: true });
    fs.mkdirSync(dirs.frames, { recursive: true });
    for (const index of indices) extractSourceFrameAt(ad, dirs.source, index);

    const rendered = await renderAdFrames(ad, dirs, indices, options);
    process.stdout.write('  ' + rendered.built.animations + ' animations, headline at ' +
      rendered.built.headlineTop + 'px in ' + rendered.audit.displayResolved + '\n');
    for (const problem of rendered.problems) process.stdout.write('  ' + problem + '\n');

    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    const written = [];
    for (const index of indices) {
      const target = path.join(
        REVIEW_DIR,
        ad.name + '-preview-' + String(index).padStart(5, '0') +
          '-t' + (index / FPS).toFixed(2) + 's.png'
      );
      await downscaleForReview(path.join(dirs.frames, frameName('frame', index)), target);
      written.push(target);
    }
    return written;
  } finally {
    if (!options.keepFrames) removeScratch(runDir);
  }
}

/**
 * Write a review sized copy of one full size frame.
 *
 * The measurement after the resize is the point of the function. A resize that
 * quietly did nothing would produce exactly the oversized image the review rule
 * exists to prevent, and it would do it without raising anything.
 *
 * @param {string} source - Absolute path to a full size PNG.
 * @param {string} target - Absolute path to write.
 * @returns {Promise<void>} Resolves once the copy is written and measured.
 */
async function downscaleForReview(source, target) {
  await sharp(source)
    .resize({ width: reviewWidth(), withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(target);
  const meta = await sharp(target).metadata();
  if (Math.max(meta.width, meta.height) > REVIEW_ABSOLUTE_MAX_DIM) {
    throw new Error(
      target + ' came out ' + meta.width + 'x' + meta.height + ', over the ' +
      REVIEW_ABSOLUTE_MAX_DIM + 'px review limit. The resize did not take.'
    );
  }
}
/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when every requested ad has been built.
 */
async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--table')) {
    for (const ad of ADS) {
      process.stdout.write(
        '  ' + ad.output.padEnd(24) + human(ad.maxBytes).padStart(10) +
        '   ' + CANVAS.width + 'x' + CANVAS.height +
        ', ' + ad.durationSeconds.toFixed(1) + 's at ' + FPS + ' fps, from ' + ad.source + '\n'
      );
    }
    return;
  }

  const options = {
    headed: argv.includes('--headed'),
    keepFrames: argv.includes('--keep-frames'),
  };
  const previewOnly = argv.includes('--preview');

  const names = argv.filter((a) => !a.startsWith('--'));
  const unknown = names.filter((n) => !ADS.some((ad) => ad.name === n));
  if (unknown.length) {
    process.stderr.write('unknown ad(s): ' + unknown.join(', ') + '\n');
    process.stderr.write('known: ' + ADS.map((ad) => ad.name).join(', ') + '\n');
    process.exitCode = 1;
    return;
  }
  const selected = names.length ? ADS.filter((ad) => names.includes(ad.name)) : ADS.slice();

  assertEncoders();
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  process.stdout.write('scratch: ' + SCRATCH_ROOT + '\n');

  // A preview stops here. It is a look at the composition, not a delivery, so
  // it never writes into docs/media and never claims a budget was met.
  if (previewOnly) {
    const previews = [];
    for (const ad of selected) previews.push(...(await previewAd(ad, options)));
    process.stdout.write('\n' + '  preview copies (downscaled, gitignored):' + '\n');
    for (const file of previews) process.stdout.write('    ' + file + '\n');
    return;
  }

  const rows = [];
  const thumbnails = [];
  const problems = [];
  for (const ad of selected) {
    const result = await buildAd(ad, options);
    rows.push(result.row);
    thumbnails.push(...result.thumbnails);
    problems.push(...result.problems.map((p) => ad.name + ': ' + p));
    for (const refusal of result.refused) {
      // A refused request is not automatically wrong: a browser asks for a
      // favicon on every navigation. It is reported so an unexpected one, which
      // would mean the stage tried to reach off machine, cannot pass unseen.
      process.stdout.write('  refused request: ' + refusal + '\n');
    }
  }

  const ok = printTable(rows);

  process.stdout.write('\n  review copies (downscaled, gitignored):\n');
  for (const file of thumbnails) {
    process.stdout.write('    ' + file + '\n');
  }

  if (problems.length) {
    process.stdout.write('\n  page diagnostics:\n');
    for (const problem of problems) process.stdout.write('    ' + problem + '\n');
  }

  if (!ok) {
    process.stderr.write(
      '\nAt least one ad is over its contract budget of ' + human(AD_BUDGET_BYTES) + '.\n' +
      'Raise H264_CRF a couple of steps first, then shorten durationSeconds on that\n' +
      'ad in the ADS table. Frame rate is the last lever here, not the first: the\n' +
      'composition is type in motion and it reads as broken below 30 fps.\n'
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('ads failed: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  ADS,
  buildAssembleArgs,
  buildCropFramesArgs,
  buildThumbnailArgs,
  assertH264Safety,
  resolveRoutePath,
  human,
  printTable,
};
