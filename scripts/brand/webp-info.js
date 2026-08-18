'use strict';
/**
 * scripts/brand/webp-info.js
 *
 * A dependency-free reader for the parts of a RIFF/WebP container that decide whether an
 * animated WebP is actually animated and actually loops.
 *
 * WHY it exists: ffmpeg-static ships ffmpeg but not ffprobe, so there is no bundled way to
 * ask "how many frames does this have, and what is the loop count". Those two facts are
 * exactly what the media contract requires of every animated deliverable ("loop cleanly",
 * "GitHub renders it inline"), and a WebP that silently encoded a single frame looks fine
 * to a file listing and wrong to a reader. Parsing 40 bytes of header is cheaper and more
 * honest than shelling out.
 *
 * Container shape used here (from the WebP container spec):
 *   "RIFF" u32:size "WEBP" then a sequence of chunks, each FourCC + u32 little-endian
 *   payload size + payload, padded to an even length.
 *   VP8X payload byte 0 carries feature flags; bit 0x02 is the animation flag.
 *   ANIM payload is u32 background colour then u16 little-endian loop count (0 = forever).
 *   ANMF appears once per animation frame.
 *
 * Used by scripts/brand/build-logo-anim.js to verify what it just wrote, and by
 * test/brand-assets.test.js as a standing gate.
 */

const fs = require('fs');

/**
 * Read the animation facts out of a WebP file.
 *
 * @param {string} file - Path to a .webp file.
 * @returns {{animated: boolean, frames: number, loop: number|null, width: number|null, height: number|null, bytes: number}}
 *   `loop` is null when the file carries no ANIM chunk. `frames` counts ANMF chunks.
 * @throws {Error} When the file is not a RIFF/WEBP container at all.
 */
function readWebpInfo(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error(`${file} is not a RIFF/WEBP container`);
  }

  const info = { animated: false, frames: 0, loop: null, width: null, height: null, bytes: buf.length };
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > buf.length) break;

    if (fourcc === 'VP8X') {
      info.animated = (buf[payload] & 0x02) !== 0;
      // Canvas size is stored as (value - 1) across three little-endian bytes each.
      info.width = 1 + (buf[payload + 4] | (buf[payload + 5] << 8) | (buf[payload + 6] << 16));
      info.height = 1 + (buf[payload + 7] | (buf[payload + 8] << 8) | (buf[payload + 9] << 16));
    } else if (fourcc === 'ANIM') {
      info.loop = buf.readUInt16LE(payload + 4);
    } else if (fourcc === 'ANMF') {
      info.frames += 1;
    }

    // Chunks are padded to an even byte length.
    offset = payload + size + (size % 2);
  }

  return info;
}

module.exports = { readWebpInfo };
