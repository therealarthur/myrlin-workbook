const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(PROJECT_ROOT, 'marketing', 'raw');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'marketing', 'screenshots');

/**
 * Add a drop shadow behind an image with transparent padding.
 * Creates a blurred dark rounded-rect SVG shadow composited under the original.
 *
 * @param {string} inputPath  - Absolute path to the source PNG
 * @param {string} outputPath - Absolute path for the output PNG
 */
async function addDropShadow(inputPath, outputPath) {
  const { width, height } = await sharp(inputPath).metadata();
  const padding = 60;
  const shadowOffset = 8;
  const totalW = width + padding * 2;
  const totalH = height + padding * 2;

  // Create shadow as a blurred dark rounded rect
  const shadowSvg = Buffer.from(`<svg width="${totalW}" height="${totalH}">
    <rect x="${padding}" y="${padding + shadowOffset}" width="${width}" height="${height}" rx="12" ry="12" fill="rgba(0,0,0,0.35)"/>
  </svg>`);

  const shadow = await sharp(shadowSvg)
    .blur(25)
    .toBuffer();

  // Composite: transparent background -> shadow -> original image
  const bg = sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  await bg
    .composite([
      { input: shadow, top: 0, left: 0 },
      { input: inputPath, top: padding, left: padding },
    ])
    .png()
    .toFile(outputPath);
}

/**
 * Create a 2x2 theme showcase grid from four Catppuccin theme screenshots.
 * Each tile is resized to 940x529 and labeled with its theme name.
 * Skips gracefully if any theme screenshot is missing.
 */
async function createThemeGrid() {
  const themes = [
    { file: 'theme-mocha.png', label: 'Mocha' },
    { file: 'theme-macchiato.png', label: 'Macchiato' },
    { file: 'theme-frappe.png', label: 'Frappe' },
    { file: 'theme-latte.png', label: 'Latte' },
  ];

  // Verify all 4 exist
  const missing = themes.filter((t) => !fs.existsSync(path.join(RAW_DIR, t.file)));
  if (missing.length > 0) {
    console.warn(
      `  [WARN] Skipping theme grid — missing files: ${missing.map((m) => m.file).join(', ')}`
    );
    return;
  }

  const tileW = 940;
  const tileH = 529;
  const gap = 20;
  const outerPad = 10;
  const labelHeight = 28;
  const canvasW = 1920;
  const canvasH = 1120;

  // Pre-compute tile positions (2x2)
  const positions = [
    { col: 0, row: 0 }, // top-left
    { col: 1, row: 0 }, // top-right
    { col: 0, row: 1 }, // bottom-left
    { col: 1, row: 1 }, // bottom-right
  ];

  const composites = [];

  for (let i = 0; i < themes.length; i++) {
    const { file, label } = themes[i];
    const { col, row } = positions[i];

    const x = outerPad + col * (tileW + gap);
    const y = outerPad + row * (tileH + labelHeight + gap);

    // Label SVG
    const labelSvg = Buffer.from(
      `<svg width="${tileW}" height="${labelHeight}">
        <text x="${tileW / 2}" y="20" text-anchor="middle"
              font-family="Arial, sans-serif" font-size="16" fill="#cdd6f4">
          ${label}
        </text>
      </svg>`
    );

    composites.push({
      input: await sharp(labelSvg).png().toBuffer(),
      top: y,
      left: x,
    });

    // Resized tile
    const tileBuffer = await sharp(path.join(RAW_DIR, file))
      .resize(tileW, tileH, { fit: 'cover' })
      .png()
      .toBuffer();

    composites.push({
      input: tileBuffer,
      top: y + labelHeight,
      left: x,
    });
  }

  // Catppuccin Mocha base background
  const outputPath = path.join(OUTPUT_DIR, 'theme-showcase.png');

  await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 30, g: 30, b: 46, alpha: 255 }, // #1e1e2e
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  console.log(`  [OK] theme-showcase.png (${canvasW}x${canvasH})`);
}

/**
 * Add rounded corners to an image using an SVG mask with dest-in blending.
 *
 * @param {string} inputPath  - Absolute path to the source PNG
 * @param {string} outputPath - Absolute path for the output PNG
 * @param {number} radius     - Corner radius in pixels (default 24)
 */
async function addRoundedCorners(inputPath, outputPath, radius = 24) {
  const { width, height } = await sharp(inputPath).metadata();

  // SVG mask: white rounded rect on transparent background
  const maskSvg = Buffer.from(
    `<svg width="${width}" height="${height}">
      <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="white"/>
    </svg>`
  );

  const mask = await sharp(maskSvg).png().toBuffer();

  await sharp(inputPath)
    .composite([
      {
        input: mask,
        blend: 'dest-in',
      },
    ])
    .png()
    .toFile(outputPath);
}

/**
 * Main orchestrator — processes all marketing screenshots.
 * Gracefully skips any missing raw files and copies unprocessed PNGs.
 */
async function processAll() {
  console.log('Marketing screenshot post-processor');
  console.log('===================================');
  console.log(`  Raw dir:    ${RAW_DIR}`);
  console.log(`  Output dir: ${OUTPUT_DIR}`);
  console.log('');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Track which raw files we explicitly process
  const processedFiles = new Set();

  // --- Drop shadow files ---
  const dropShadowFiles = [
    'hero-dashboard.png',
    'terminal-grid.png',
    'login-screen.png',
    'quick-switcher.png',
    'kanban-board.png',
    'docs-panel.png',
    'cost-tracking.png',
    'session-detail.png',
  ];

  for (const file of dropShadowFiles) {
    const inputPath = path.join(RAW_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, file);

    if (!fs.existsSync(inputPath)) {
      console.log(`  [SKIP] ${file} (not found in raw/)`);
      continue;
    }

    try {
      await addDropShadow(inputPath, outputPath);
      processedFiles.add(file);
      console.log(`  [OK] ${file} (drop shadow)`);
    } catch (err) {
      console.error(`  [ERR] ${file}: ${err.message}`);
    }
  }

  // --- Rounded corners ---
  const roundedCornerFiles = [
    { file: 'mobile-dashboard.png', radius: 32 },
  ];

  for (const { file, radius } of roundedCornerFiles) {
    const inputPath = path.join(RAW_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, file);

    if (!fs.existsSync(inputPath)) {
      console.log(`  [SKIP] ${file} (not found in raw/)`);
      continue;
    }

    try {
      await addRoundedCorners(inputPath, outputPath, radius);
      processedFiles.add(file);
      console.log(`  [OK] ${file} (rounded corners, r=${radius})`);
    } catch (err) {
      console.error(`  [ERR] ${file}: ${err.message}`);
    }
  }

  // --- Theme grid ---
  const themeFiles = ['theme-mocha.png', 'theme-macchiato.png', 'theme-frappe.png', 'theme-latte.png'];
  themeFiles.forEach((f) => processedFiles.add(f));

  try {
    await createThemeGrid();
  } catch (err) {
    console.error(`  [ERR] theme-showcase: ${err.message}`);
  }

  // --- Copy remaining PNGs that weren't explicitly processed ---
  console.log('');
  console.log('Copying unprocessed PNGs...');

  const rawFiles = fs.readdirSync(RAW_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
  let copiedCount = 0;

  for (const file of rawFiles) {
    if (processedFiles.has(file)) continue;

    const inputPath = path.join(RAW_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, file);

    try {
      await sharp(inputPath).png().toFile(outputPath);
      copiedCount++;
      console.log(`  [COPY] ${file}`);
    } catch (err) {
      console.error(`  [ERR] copy ${file}: ${err.message}`);
    }
  }

  if (copiedCount === 0) {
    console.log('  (none)');
  }

  console.log('');
  console.log('Done.');
}

module.exports = {
  addDropShadow,
  createThemeGrid,
  addRoundedCorners,
  processAll,
};

if (require.main === module) {
  processAll().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
