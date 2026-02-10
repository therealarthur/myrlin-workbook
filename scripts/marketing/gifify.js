/**
 * gifify.js - Convert .webm video files to optimized .gif files using ffmpeg
 *
 * Scans marketing/raw/ for .webm files and produces optimized GIFs in marketing/gifs/
 * using a 2-pass palettegen + paletteuse approach for high-quality output.
 *
 * Usage: node scripts/marketing/gifify.js
 *
 * Custom settings per file type:
 *   - Files containing "drag" or "resize": fps=20, width=1280
 *   - Files containing "typing": fps=15, width=1280
 *   - Default: fps=15, width=1200
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Use ffmpeg-static if available (bundles ffmpeg binary), otherwise fall back to system ffmpeg
let FFMPEG_BIN = 'ffmpeg';
try {
  FFMPEG_BIN = require('ffmpeg-static');
} catch (_) {
  // Fall back to system ffmpeg
}

// All paths relative to project root
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(PROJECT_ROOT, 'marketing', 'raw');
const GIF_DIR = path.join(PROJECT_ROOT, 'marketing', 'gifs');

/**
 * Determine fps and width settings based on the filename.
 * @param {string} filename - The base name of the .webm file
 * @returns {{ fps: number, width: number }}
 */
function getSettings(filename) {
  const lower = filename.toLowerCase();

  if (lower.includes('drag') || lower.includes('resize')) {
    return { fps: 20, width: 1280 };
  }

  if (lower.includes('typing')) {
    return { fps: 15, width: 1280 };
  }

  return { fps: 15, width: 1200 };
}

/**
 * Format byte count into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Check that ffmpeg is available on the system PATH.
 */
function checkFfmpeg() {
  try {
    execSync(`"${FFMPEG_BIN}" -version`, { stdio: 'pipe' });
    console.log(`Using ffmpeg: ${FFMPEG_BIN}`);
  } catch (err) {
    console.error('Error: ffmpeg not found.');
    console.error('');
    console.error('Install via npm:     npm install --save-dev ffmpeg-static');
    console.error('');
    console.error('Or install system-wide:');
    console.error('  Windows (winget):  winget install Gyan.FFmpeg');
    console.error('  Windows (choco):   choco install ffmpeg');
    console.error('  macOS:             brew install ffmpeg');
    console.error('  Linux (apt):       sudo apt install ffmpeg');
    console.error('');
    process.exit(1);
  }
}

/**
 * Convert a single .webm file to an optimized .gif using 2-pass ffmpeg.
 * @param {string} inputPath - Absolute path to the .webm file
 * @param {string} outputPath - Absolute path for the output .gif file
 * @param {{ fps: number, width: number }} settings
 */
function convertToGif(inputPath, outputPath, settings) {
  const { fps, width } = settings;
  const palettePath = path.join(GIF_DIR, '_palette_temp.png');

  try {
    // Pass 1: Generate optimized color palette
    const paletteCmd = [
      `"${FFMPEG_BIN}"`, '-y',
      '-i', `"${inputPath}"`,
      '-vf', `"fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=256"`,
      `"${palettePath}"`
    ].join(' ');

    console.log('  Pass 1/2: Generating color palette...');
    execSync(paletteCmd, { stdio: 'pipe' });

    // Pass 2: Convert using the palette for high-quality dithering
    const convertCmd = [
      `"${FFMPEG_BIN}"`, '-y',
      '-i', `"${inputPath}"`,
      '-i', `"${palettePath}"`,
      '-filter_complex', `"fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5"`,
      `"${outputPath}"`
    ].join(' ');

    console.log('  Pass 2/2: Converting with palette...');
    execSync(convertCmd, { stdio: 'pipe' });
  } finally {
    // Clean up temporary palette file
    try {
      if (fs.existsSync(palettePath)) {
        fs.unlinkSync(palettePath);
      }
    } catch (cleanupErr) {
      console.warn('  Warning: Could not delete temporary palette file:', palettePath);
    }
  }
}

/**
 * Main entry point - scan for .webm files and convert them all.
 */
function main() {
  console.log('gifify - .webm to .gif converter');
  console.log('=================================');
  console.log('');

  // Verify ffmpeg is installed
  checkFfmpeg();

  // Ensure the raw directory exists
  if (!fs.existsSync(RAW_DIR)) {
    console.log(`Raw directory not found: ${RAW_DIR}`);
    console.log('Creating it now. Place your .webm files there and run again.');
    fs.mkdirSync(RAW_DIR, { recursive: true });
    process.exit(0);
  }

  // Scan for .webm files
  const webmFiles = fs.readdirSync(RAW_DIR)
    .filter(f => f.toLowerCase().endsWith('.webm'))
    .sort();

  if (webmFiles.length === 0) {
    console.log(`No .webm files found in: ${RAW_DIR}`);
    console.log('Place your .webm screen recordings there and run again.');
    process.exit(0);
  }

  console.log(`Found ${webmFiles.length} .webm file(s) in ${RAW_DIR}`);
  console.log('');

  // Ensure output directory exists
  if (!fs.existsSync(GIF_DIR)) {
    fs.mkdirSync(GIF_DIR, { recursive: true });
  }

  let successCount = 0;
  let failCount = 0;
  const results = [];

  for (const file of webmFiles) {
    const inputPath = path.join(RAW_DIR, file);
    const baseName = path.basename(file, path.extname(file));
    const outputPath = path.join(GIF_DIR, baseName + '.gif');
    const settings = getSettings(file);

    console.log(`[${successCount + failCount + 1}/${webmFiles.length}] ${file}`);
    console.log(`  Settings: fps=${settings.fps}, width=${settings.width}`);

    try {
      const inputStats = fs.statSync(inputPath);
      console.log(`  Input size: ${formatSize(inputStats.size)}`);

      convertToGif(inputPath, outputPath, settings);

      const outputStats = fs.statSync(outputPath);
      console.log(`  Output: ${baseName}.gif (${formatSize(outputStats.size)})`);
      console.log(`  Done!`);

      results.push({
        file: baseName + '.gif',
        inputSize: inputStats.size,
        outputSize: outputStats.size,
      });

      successCount++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failCount++;
    }

    console.log('');
  }

  // Summary
  console.log('=================================');
  console.log(`Complete: ${successCount} succeeded, ${failCount} failed`);

  if (results.length > 0) {
    console.log('');
    console.log('Output files:');
    for (const r of results) {
      console.log(`  ${r.file}  (${formatSize(r.outputSize)})`);
    }
    console.log('');
    console.log(`GIFs saved to: ${GIF_DIR}`);
  }
}

main();
