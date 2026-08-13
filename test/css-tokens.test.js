#!/usr/bin/env node
/**
 * Plan 18-01 gate: CSS provider tokens at :root.
 *
 * Locks the shape of the provider-accent layer added in Plan 18-01:
 *   1. Three accent tokens exist at :root and reference Catppuccin palette
 *      tokens (var(--mauve|green|blue)), never hex literals.
 *   2. Three matching tint tokens exist at :root and use color-mix(in srgb,
 *      ..., transparent), never hardcoded rgba.
 *   3. Zero hex literals appear in any provider token's value.
 *   4. The terminal-pane and project-accordion selectors that consume these
 *      tokens are present so the foundation actually renders.
 *
 * The test is a pure string-match gate over styles.css. No DOM, no jsdom,
 * no browser. Phase 18 visual-QA verification is manual; this gate just
 * prevents the foundation from drifting.
 *
 * Requirements covered: UI-04, UI-05 (foundation layer).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STYLES_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'styles.css');
const css = fs.readFileSync(STYLES_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run a single named assertion. Logs pass/fail and tallies the totals so the
 * exit code reflects the worst outcome instead of bailing on first failure.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void} fn Function that throws on failure.
 */
function check(name, fn) {
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

console.log('\n  \x1b[1mPlan 18-01: CSS provider tokens\x1b[0m');
console.log('  ' + '─'.repeat(42));

// (1) Accent tokens reference theme tokens, not hex.
// SANCTIONED EDIT SE-1 (BUILD-CONTRACT.md 5.4, phase P1.1): Notion restyle:
// provider identity is a named block-palette hue, not the app brand. Token
// names unchanged.
check('--provider-claude-accent references var(--app-text-purple)', () => {
  assert.ok(
    /--provider-claude-accent:\s*var\(--app-text-purple\)/.test(css),
    '--provider-claude-accent must be defined at :root as "var(--app-text-purple)"'
  );
});

check('--provider-codex-accent references var(--app-text-green)', () => {
  assert.ok(
    /--provider-codex-accent:\s*var\(--app-text-green\)/.test(css),
    '--provider-codex-accent must be defined at :root as "var(--app-text-green)"'
  );
});

check('--provider-gemini-accent references var(--app-text-blue)', () => {
  assert.ok(
    /--provider-gemini-accent:\s*var\(--app-text-blue\)/.test(css),
    '--provider-gemini-accent must be defined at :root as "var(--app-text-blue)" (Gemini reserved for v1.3)'
  );
});

// (2) Tint tokens use color-mix; never rgba. Plan 22-02 bumped saturation
// from 6% to 10%; the Pitfall 7 guard below still enforces var()-only
// references, so the percentage is allowed to drift in [1..99] as long
// as the color-mix shape and palette token are intact.
// SANCTIONED EDIT SE-1 (BUILD-CONTRACT.md 5.4, phase P1.1): Notion restyle:
// provider identity is a named block-palette hue, not the app brand. Token
// names unchanged. The color-mix shape and the no-hex rule are unchanged too;
// only the token inside the mix moved.
check('--provider-claude-tint uses color-mix(in srgb, var(--app-text-purple) <pct>%, transparent)', () => {
  assert.ok(
    /--provider-claude-tint:\s*color-mix\(in srgb, var\(--app-text-purple\) \d{1,2}%, transparent\)/.test(css),
    '--provider-claude-tint must use color-mix(in srgb, var(--app-text-purple) N%, transparent)'
  );
});

check('--provider-codex-tint uses color-mix(in srgb, var(--app-text-green) <pct>%, transparent)', () => {
  assert.ok(
    /--provider-codex-tint:\s*color-mix\(in srgb, var\(--app-text-green\) \d{1,2}%, transparent\)/.test(css),
    '--provider-codex-tint must use color-mix(in srgb, var(--app-text-green) N%, transparent)'
  );
});

check('--provider-gemini-tint uses color-mix(in srgb, var(--app-text-blue) <pct>%, transparent)', () => {
  assert.ok(
    /--provider-gemini-tint:\s*color-mix\(in srgb, var\(--app-text-blue\) \d{1,2}%, transparent\)/.test(css),
    '--provider-gemini-tint must use color-mix(in srgb, var(--app-text-blue) N%, transparent)'
  );
});

// (3) Pitfall 7 guard: no hex literal anywhere in a provider token's value.
check('no hex literals in any --provider-*-{accent,tint} value', () => {
  const hexInProviderToken = /--provider-[a-z]+-(accent|tint):\s*[^;]*#[0-9a-fA-F]+/g;
  const offenders = css.match(hexInProviderToken) || [];
  assert.deepStrictEqual(
    offenders,
    [],
    'Pitfall 7: provider tokens must reference theme tokens (var(--mauve), color-mix), not hex literals. Offenders: ' +
      offenders.join(' | ')
  );
});

// (4) Foundation selectors that consume the tokens must be present, otherwise
// the tokens are dead code and the next plan in the wave will silently fail.
check('terminal-pane[data-provider="claude"]:not(.terminal-pane-empty) selector exists', () => {
  assert.ok(
    css.includes('.terminal-pane[data-provider="claude"]:not(.terminal-pane-empty)'),
    'terminal-pane claude selector must be present so the pane tint renders'
  );
});

check('terminal-pane[data-provider="codex"]:not(.terminal-pane-empty) selector exists', () => {
  assert.ok(
    css.includes('.terminal-pane[data-provider="codex"]:not(.terminal-pane-empty)'),
    'terminal-pane codex selector must be present so the pane tint renders'
  );
});

// Note: project-accordion + project-session-item provider stripes were
// removed post-alpha.7 per user feedback (the Discovered Projects
// section already conveys provider via tab filtering; the stripes were
// noise). The remaining provider-stripe surface is .ws-session-item in
// the workspace sidebar, which is covered by test/provider-label-pill.test.js.

// (5) Sanity: the terminal-pane background gradient fades to transparent within
// the pane chrome (Pitfall F: gradient must not bleed onto the xterm canvas and
// reduce text contrast). The exact pixel cutoff is a designer call; v1.2.0-alpha.3
// bumped from 24px to 64px (still well within the pane header band). Test allows
// any cutoff between 16px and 128px so future tuning does not break CI.
check('terminal-pane gradient fades to transparent within pane chrome (Pitfall F guard)', () => {
  const re = /linear-gradient\(180deg,\s*var\(--provider-claude-tint\)\s*0,\s*transparent\s*(\d+)px\)/;
  const m = css.match(re);
  assert.ok(m, 'Pitfall F: pane tint must fade to transparent at some pixel value');
  const px = parseInt(m[1], 10);
  assert.ok(px >= 16 && px <= 128, 'Pitfall F: tint fade cutoff must be between 16px and 128px; got ' + px + 'px');
});

console.log('  ' + '─'.repeat(42));
console.log('  [css-tokens] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
