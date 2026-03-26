#!/usr/bin/env node
/**
 * imgcat - Display images inline in xterm.js terminals.
 * Uses the iTerm2 Inline Images Protocol (IIP / OSC 1337).
 *
 * Usage:
 *   node imgcat.js <file-path>           # Display an image file
 *   node imgcat.js --base64 <data>       # Display base64-encoded image
 *   echo <base64> | node imgcat.js -     # Pipe base64 from stdin
 *
 * Works in any terminal that supports IIP (iTerm2, WezTerm, Konsole)
 * and in xterm.js with @xterm/addon-image loaded.
 */
const fs = require('fs');
const path = require('path');

/**
 * Emit an iTerm2 IIP escape sequence for an image.
 * Format: ESC ] 1337 ; File = [args] : <base64 data> BEL
 * @param {Buffer|string} data - Image data (Buffer for file, string for base64)
 * @param {object} opts - Display options
 */
function emitIIP(data, opts = {}) {
  let base64;
  if (Buffer.isBuffer(data)) {
    base64 = data.toString('base64');
  } else {
    base64 = data;
  }

  const args = [];
  args.push('inline=1');
  if (opts.name) args.push('name=' + Buffer.from(opts.name).toString('base64'));
  if (opts.width) args.push('width=' + opts.width);
  if (opts.height) args.push('height=' + opts.height);
  args.push('preserveAspectRatio=1');
  args.push('size=' + Math.ceil(base64.length * 3 / 4)); // approximate byte size

  // OSC 1337 ; File = <args> : <base64> ST
  const seq = '\x1b]1337;File=' + args.join(';') + ':' + base64 + '\x07';
  process.stdout.write(seq);
  process.stdout.write('\n');
}

/**
 * Detect MIME type from file extension.
 * @param {string} filePath - Path to the image file
 * @returns {string} MIME type
 */
function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
  };
  return map[ext] || 'image/png';
}

// CLI entry point
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: imgcat <file-path> | imgcat --base64 <data> | echo <base64> | imgcat -');
  process.exit(1);
}

if (args[0] === '--base64' && args[1]) {
  emitIIP(args[1], { name: 'inline-image' });
} else if (args[0] === '-') {
  // Read base64 from stdin
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    emitIIP(input.trim(), { name: 'stdin-image' });
  });
} else {
  // File path
  const filePath = path.resolve(args[0]);
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }
  const data = fs.readFileSync(filePath);
  emitIIP(data, { name: path.basename(filePath) });
}
