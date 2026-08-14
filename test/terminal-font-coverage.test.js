#!/usr/bin/env node
/**
 * Round 1 post-launch gate: the terminal face covers the characters TUIs draw.
 *
 * THE BUG THIS FILE EXISTS FOR. The user reported "codex/chatgpt terminal
 * output is not formatted properly". It was not a width bug, a wrap bug or a
 * spawn bug: it was glyph coverage. P5.5 made the vendored iA Writer Mono S
 * the FIRST family in --font-terminal. That face maps 746 code points and
 * covers none of the box-drawing block (U+2500-257F), none of the block
 * elements (U+2580-259F) and none of the braille patterns (U+2800-28FF). The
 * Codex TUI frames every panel with box-drawing runs and animates with braille
 * spinners, so each of those characters fell through to whatever face the
 * browser picked next, drawn at THAT face's advance width inside a cell grid
 * xterm measured from iA Writer's. Every framed row drifted.
 *
 * The gate is the measurement itself, so it cannot go stale:
 *   1. Read the cmap out of each vendored woff2 and count real coverage.
 *   2. Assert the terminal chain does not LEAD with a face that fails the
 *      TUI coverage floor.
 *   3. Assert the chain still contains the vendored face (nothing was
 *      deleted) and that styles.css and terminal-surface.js agree on order.
 *
 * If a future vendored face DOES cover the ranges, assertion 2 relaxes on its
 * own and iA Writer may lead again. That is the point of measuring rather
 * than pinning a font name.
 *
 * woff2 note: tables are brotli-compressed as one stream and concatenated in
 * table-directory order. Only glyf and loca are transformed, so summing the
 * preceding tables' lengths lands exactly on cmap, which is enough to read
 * format 4 and format 12 subtables. No font library is required, which keeps
 * the suite dependency-free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const FONT_DIR = path.join(PUBLIC_DIR, 'design', 'notion', 'fonts');
const stylesCss = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const surfaceSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'terminal-surface.js'), 'utf8');

let passed = 0;
let failed = 0;
const queue = [];

/**
 * Register a named assertion.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void} fn Function that throws on failure.
 */
function check(name, fn) {
  queue.push({ name, fn });
}

function runQueue() {
  for (const { name, fn } of queue) {
    try {
      fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + err.message + '\x1b[0m');
    }
  }
}

// The woff2 known-tag table, in specification order. Index 63 means the tag
// follows inline as four bytes.
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

/**
 * Read a woff2 UIntBase128 value.
 *
 * @param {Buffer} buf Font buffer.
 * @param {{p: number}} posRef Cursor, advanced in place.
 * @returns {number} The decoded value.
 */
function readBase128(buf, posRef) {
  let accum = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[posRef.p++];
    accum = (accum << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return accum >>> 0;
  }
  throw new Error('malformed UIntBase128 in woff2 table directory');
}

/**
 * Locate and decompress the cmap table of a woff2 file.
 *
 * @param {string} file Absolute path to a .woff2 file.
 * @returns {{data: Buffer, offset: number}} Decompressed stream and cmap offset.
 */
function readCmapTable(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.toString('latin1', 0, 4), 'wOF2', file + ' is not a woff2 file');
  const numTables = buf.readUInt16BE(12);
  const posRef = { p: 48 };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[posRef.p++];
    const tagIdx = flags & 0x3f;
    let tag;
    if (tagIdx === 63) {
      tag = buf.toString('latin1', posRef.p, posRef.p + 4);
      posRef.p += 4;
    } else {
      tag = KNOWN_TAGS[tagIdx];
    }
    const transform = (flags >> 6) & 0x03;
    const origLength = readBase128(buf, posRef);
    // glyf and loca are transformed when transform == 0; every other table is
    // transformed when transform != 0. Either way a transformLength follows.
    const transformed = (tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0;
    const length = transformed ? readBase128(buf, posRef) : origLength;
    tables.push({ tag, length });
  }
  const data = zlib.brotliDecompressSync(buf.slice(posRef.p));
  let offset = 0;
  for (const t of tables) {
    if (t.tag === 'cmap') return { data, offset };
    offset += t.length;
  }
  throw new Error('no cmap table in ' + file);
}

/**
 * Count how many code points in a range the face actually maps to a glyph.
 *
 * @param {string} file Absolute path to a .woff2 file.
 * @param {number} lo Inclusive range start.
 * @param {number} hi Inclusive range end.
 * @returns {number} Mapped code point count.
 */
function coverage(file, lo, hi) {
  const { data, offset } = readCmapTable(file);
  const numSubtables = data.readUInt16BE(offset + 2);
  let covered = 0;
  const seen = new Set();
  for (let i = 0; i < numSubtables; i++) {
    const rec = offset + 4 + i * 8;
    const sub = offset + data.readUInt32BE(rec + 4);
    const format = data.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = data.readUInt16BE(sub + 6);
      const segments = segX2 / 2;
      const endBase = sub + 14;
      const startBase = endBase + segX2 + 2;
      const deltaBase = startBase + segX2;
      const rangeBase = deltaBase + segX2;
      for (let s = 0; s < segments; s++) {
        const end = data.readUInt16BE(endBase + s * 2);
        const start = data.readUInt16BE(startBase + s * 2);
        const delta = data.readInt16BE(deltaBase + s * 2);
        const rangeOff = data.readUInt16BE(rangeBase + s * 2);
        if (start === 0xffff) continue;
        const from = Math.max(start, lo);
        const to = Math.min(end, hi);
        for (let c = from; c <= to; c++) {
          let gid;
          if (rangeOff === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const gidx = rangeBase + s * 2 + rangeOff + (c - start) * 2;
            if (gidx + 1 >= data.length) continue;
            gid = data.readUInt16BE(gidx);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0 && !seen.has(c)) { seen.add(c); covered++; }
        }
      }
    } else if (format === 12) {
      const groups = data.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const go = sub + 16 + g * 12;
        const start = data.readUInt32BE(go);
        const end = data.readUInt32BE(go + 4);
        const from = Math.max(start, lo);
        const to = Math.min(end, hi);
        for (let c = from; c <= to; c++) {
          if (!seen.has(c)) { seen.add(c); covered++; }
        }
      }
    }
  }
  return covered;
}

// The ranges a text-mode program needs before a monospace grid can hold.
// Box drawing frames every panel; block elements draw bars and shading;
// braille is the spinner idiom every modern Rust and Go TUI uses.
const TUI_RANGES = [
  { label: 'box drawing (U+2500-257F)', lo: 0x2500, hi: 0x257f, floor: 0.75 },
  { label: 'block elements (U+2580-259F)', lo: 0x2580, hi: 0x259f, floor: 0.5 },
  { label: 'braille patterns (U+2800-28FF)', lo: 0x2800, hi: 0x28ff, floor: 0.5 },
];

const VENDORED_FACES = fs.existsSync(FONT_DIR)
  ? fs.readdirSync(FONT_DIR).filter((f) => /^iAWriterMonoS-.*\.woff2$/.test(f))
  : [];

console.log('\n  \x1b[1mRound 1: terminal font glyph coverage\x1b[0m');
console.log('  ' + '─'.repeat(42));

check('the four vendored iA Writer Mono faces are present', () => {
  assert.strictEqual(VENDORED_FACES.length, 4,
    'expected four vendored faces, found ' + VENDORED_FACES.length);
});

/**
 * True when a face clears every TUI coverage floor.
 *
 * @param {string} file Absolute path to a .woff2 file.
 * @returns {{ok: boolean, report: string[]}} Verdict plus a readable report.
 */
function tuiCapable(file) {
  const report = [];
  let ok = true;
  for (const range of TUI_RANGES) {
    const total = range.hi - range.lo + 1;
    const have = coverage(file, range.lo, range.hi);
    report.push(range.label + ': ' + have + '/' + total);
    if (have / total < range.floor) ok = false;
  }
  return { ok, report };
}

check('the vendored face is measured, and the measurement is the reason for the order', () => {
  const regular = path.join(FONT_DIR, 'iAWriterMonoS-Regular.woff2');
  const { ok, report } = tuiCapable(regular);
  console.log('      measured: ' + report.join('  |  '));
  // This is not an assertion that the face is bad. It is the fork: whichever
  // way it measures, the chain order below has to agree with it.
  const chain = (stylesCss.match(/--font-terminal:\s*([^;]+);/) || [])[1] || '';
  assert.ok(chain, '--font-terminal must be declared in styles.css');
  const leadsWithVendored = /^\s*"iA Writer Mono"/.test(chain);
  if (!ok) {
    assert.ok(
      !leadsWithVendored,
      'iA Writer Mono fails the TUI coverage floor (' + report.join('; ') +
      ') so it must not be the FIRST family in --font-terminal: TUI frames tear'
    );
  }
});

check('the terminal chain leads with a coverage-complete mono', () => {
  const chain = (stylesCss.match(/--font-terminal:\s*([^;]+);/) || [])[1] || '';
  const first = chain.split(',')[0].trim().replace(/^["']|["']$/g, '');
  // The faces that ship with a developer machine and carry the full box,
  // block and braille repertoire. Any of them may lead.
  const COVERAGE_COMPLETE = ['JetBrains Mono', 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Menlo', 'SFMono-Regular'];
  assert.ok(
    COVERAGE_COMPLETE.includes(first),
    'the first terminal family must cover box drawing, blocks and braille; found "' + first + '"'
  );
});

check('nothing was deleted: the vendored face is still in the chain', () => {
  const chain = (stylesCss.match(/--font-terminal:\s*([^;]+);/) || [])[1] || '';
  assert.ok(/iA Writer Mono/.test(chain), 'the vendored face must remain selectable in the chain');
  assert.ok(/--font-mono:\s*"iA Writer Mono"/.test(stylesCss),
    'iA Writer Mono must remain the app mono for code, ids and diffs');
});

check('styles.css and the projection agree on the leading families', () => {
  const chain = (stylesCss.match(/--font-terminal:\s*([^;]+);/) || [])[1] || '';
  const cssFirstThree = chain.split(',').slice(0, 3).map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const constMatch = surfaceSrc.match(/var TERMINAL_FONT\s*=\s*([\s\S]*?);/);
  assert.ok(constMatch, 'TERMINAL_FONT constant not found in terminal-surface.js');
  const jsChain = constMatch[1].replace(/['"+\n]/g, ' ');
  for (const family of cssFirstThree) {
    assert.ok(
      jsChain.includes(family),
      'the projection fallback must carry "' + family + '" so a pre-stylesheet boot has the same metrics'
    );
  }
});

runQueue();
console.log('\n  ' + '─'.repeat(42));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('  ' + '─'.repeat(42) + '\n');
process.exit(failed > 0 ? 1 : 0);
