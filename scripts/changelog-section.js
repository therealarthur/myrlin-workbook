#!/usr/bin/env node
/**
 * changelog-section.js - print one version's section out of CHANGELOG.md.
 *
 * WHY: the release workflow (.github/workflows/release.yml) attaches the
 * changelog entry for the tag being published to the GitHub Release body,
 * on top of `gh release create --generate-notes`. Rather than teach the
 * workflow YAML how to parse Markdown, that parsing lives here as a small,
 * dependency-free script the workflow can shell out to and pipe straight
 * into `gh release create --notes-file`.
 *
 * Matching rule: finds the first line that starts with `## [<version>]`
 * (the Keep a Changelog heading form this project uses, e.g.
 * `## [1.3.0-alpha.30] - 2026-08-18`) and prints everything from that
 * heading up to, but not including, the next `## [` heading or end of file.
 * Exits non-zero with a clear message if the version has no section, so a
 * tag published without a changelog entry fails loudly instead of shipping
 * an empty release body.
 *
 * Usage: node scripts/changelog-section.js <version>
 *   e.g. node scripts/changelog-section.js 1.3.0-alpha.30
 *
 * This script is intentionally syntax-checked only (`node --check`), not
 * unit tested: it is a thin, easily-eyeballed text scan over a file humans
 * already read on every release, not business logic.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read CHANGELOG.md and return the Markdown section for the given version.
 * @param {string} version - version string as it appears in the heading,
 *   without the surrounding brackets (e.g. "1.3.0-alpha.30").
 * @param {string} [changelogPath] - path to CHANGELOG.md, defaults to the
 *   repo root relative to this script.
 * @returns {string} the section text, trimmed of trailing blank lines.
 */
function getChangelogSection(version, changelogPath) {
  const filePath = changelogPath || path.join(__dirname, '..', 'CHANGELOG.md');
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);

  const headingPrefix = `## [${version}]`;
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(headingPrefix)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    throw new Error(
      `No CHANGELOG.md section found for version "${version}" ` +
        `(looked for a heading starting with "${headingPrefix}"). ` +
        'Add the entry to CHANGELOG.md before tagging a release.'
    );
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      endIndex = i;
      break;
    }
  }

  return lines
    .slice(startIndex, endIndex)
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * CLI entry point. Prints the section to stdout, or an error to stderr and
 * exits 1 if the version is missing or has no matching section.
 */
function main() {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write('Usage: node scripts/changelog-section.js <version>\n');
    process.exit(1);
  }

  try {
    const section = getChangelogSection(version);
    process.stdout.write(section + '\n');
  } catch (err) {
    process.stderr.write(`changelog-section: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getChangelogSection };
