/* ═══════════════════════════════════════════════════════════════
   Instance-color helpers for the session indicator.
   Pure functions over tab data; no DOM dependencies.
   Loaded as a browser <script> AND requireable from Node tests.
   SPDX-License-Identifier: AGPL-3.0-only
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InstanceColors = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAB_COLORS = ['red', 'yellow', 'green', 'teal', 'blue', 'mauve'];

  /* ═══════════════════════════════════════════════════════════════
     CHROME HUE PROJECTION (BUILD-CONTRACT 1.8, DESIGN-SPEC 10.4)
     ═══════════════════════════════════════════════════════════════

     WHAT THIS IS FOR

     Five maps across this module and app.js build `var(--<name>)` strings by
     concatenation from a Catppuccin palette name. That leaks the TERMINAL
     theme into the application chrome, which DESIGN-SPEC 10.4 forbids: the
     palette paints the transcript, the input row, the prompt and the preview
     swatch, and nothing else. It also breaks silently on a palette rename,
     because a concatenated token name is invisible to every tool.

     WHY THE NAMES DO NOT CHANGE

     `red`, `mauve`, `peach` and friends are persisted values. They live in
     workspace.color, tab-folder.color, workspace-group.color and layout JSON
     on every existing install, and instance-colors.test.js pins the six
     TAB_COLORS entries and their modulo-6 wraparound by index. Renaming them
     would invalidate stored state and retarget a pinned test. So the arrays
     stay byte-identical and only the RESOLUTION changes: a name is now a key
     into the Notion named block palette rather than a fragment of a CSS
     custom-property name.

     WHY --app-text-<hue> AND NOT --app-bg-<hue>

     Per DESIGN-SPEC 10.5 the ten named block TEXT colours are theme
     invariant: they are identical in light and dark chrome, which is exactly
     what an identity colour must be. They are also what the design's own dot
     recipes name (DESIGN-SPEC 5.1 tab dot, 5.3 pane slot, BUILD-CONTRACT 2.3
     status dot). Consumers that need a WASH mix this ink down rather than
     reaching for a second token, so one identity value drives dot, ink and
     tint alike and they can never disagree.
     ═══════════════════════════════════════════════════════════════ */

  /**
   * The ten named block hues of the Notion app surface, by canonical name.
   * This is the whole vocabulary; there is no eleventh colour to reach for.
   */
  const BLOCK_HUE_TOKENS = Object.freeze({
    gray: '--app-text-gray',
    brown: '--app-text-brown',
    orange: '--app-text-orange',
    yellow: '--app-text-yellow',
    green: '--app-text-green',
    blue: '--app-text-blue',
    purple: '--app-text-purple',
    pink: '--app-text-pink',
    red: '--app-text-red',
    teal: '--app-text-teal',
  });

  /**
   * The matching block BACKGROUNDS, the other half of the named block colour
   * system (BUILD-CONTRACT 2.3 row 3: a content label is `--app-bg-<hue>`
   * behind `--app-text-<hue>`). Unlike the inks these DO flip with the chrome
   * theme, which is the point: the ink is the identity and stays put, the
   * ground under it follows the surface it is drawn on.
   */
  const BLOCK_HUE_BG_TOKENS = Object.freeze({
    gray: '--app-bg-gray',
    brown: '--app-bg-brown',
    orange: '--app-bg-orange',
    yellow: '--app-bg-yellow',
    green: '--app-bg-green',
    blue: '--app-bg-blue',
    purple: '--app-bg-purple',
    pink: '--app-bg-pink',
    red: '--app-bg-red',
    teal: '--app-bg-teal',
  });

  /**
   * Every legacy palette name this application has ever persisted, mapped to
   * the block hue it now resolves to. Pairings are BUILD-CONTRACT 1.8
   * verbatim: 1.9 rule C1 says map on ROLE, not on hue, and the tag row of
   * 1.8 fixes the five names that have no one-to-one Notion equivalent
   * (`sky` to teal, `lavender` to purple, `flamingo` and `rosewater` to
   * brown, `sapphire` to blue).
   *
   * Thirteen entries, because that is what the colour picker, the folder
   * menu and the tag hash between them can produce. Canonical names resolve
   * to themselves through blockHueToken(), so a caller may pass either form.
   */
  const PALETTE_BLOCK_HUE = Object.freeze({
    mauve: 'purple',
    lavender: 'purple',
    blue: 'blue',
    sapphire: 'blue',
    sky: 'teal',
    teal: 'teal',
    green: 'green',
    yellow: 'yellow',
    peach: 'orange',
    red: 'red',
    pink: 'pink',
    flamingo: 'brown',
    rosewater: 'brown',
  });

  /**
   * The hue an unknown name falls back to. Gray is the block palette's own
   * neutral, so an unrecognised persisted colour degrades to a legible dot
   * rather than to a broken `var()` or to a terminal-palette leak.
   */
  const FALLBACK_BLOCK_HUE = 'gray';

  /**
   * Resolve a palette name, or a canonical block hue name, to its chrome
   * token NAME (no `var()` wrapper).
   *
   * @param {string} name - Legacy palette name ('mauve') or block hue ('purple').
   * @returns {string} A `--app-text-<hue>` custom-property name. Never empty.
   */
  function blockHueToken(name) {
    return BLOCK_HUE_TOKENS[blockHue(name)];
  }

  /**
   * Resolve a palette name, or a canonical block hue name, to the canonical
   * block hue itself. The one place the fallback decision is made, so the ink
   * accessor and the background accessor can never disagree about what an
   * unrecognised name means.
   *
   * @param {string} name - Legacy palette name ('mauve') or block hue ('purple').
   * @returns {string} A canonical block hue name. Never empty.
   */
  function blockHue(name) {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return PALETTE_BLOCK_HUE[key] || (BLOCK_HUE_TOKENS[key] ? key : FALLBACK_BLOCK_HUE);
  }

  /**
   * Resolve a palette name to the block BACKGROUND token that pairs with its
   * ink. Used for content labels (user-authored tags), which are the one
   * surface BUILD-CONTRACT 1.8 sends to the named block palette rather than
   * to the chip palette.
   *
   * @param {string} name - Legacy palette name or block hue name.
   * @returns {string} An `--app-bg-<hue>` custom-property name. Never empty.
   */
  function blockHueBgToken(name) {
    return BLOCK_HUE_BG_TOKENS[blockHue(name)];
  }

  /**
   * The background token, wrapped as a CSS value ready for an inline style.
   *
   * @param {string} name - Legacy palette name or block hue name.
   * @returns {string} e.g. `var(--app-bg-purple)`.
   */
  function blockHueBgVar(name) {
    return 'var(' + blockHueBgToken(name) + ')';
  }

  /**
   * The same resolution, wrapped as a CSS value ready for an inline style.
   * This is the function render code calls; it exists so no caller ever
   * concatenates a token name by hand again.
   *
   * @param {string} name - Legacy palette name or block hue name.
   * @returns {string} e.g. `var(--app-text-purple)`.
   */
  function blockHueVar(name) {
    return 'var(' + blockHueToken(name) + ')';
  }

  /**
   * The same resolution as a translucent WASH over whatever the element sits
   * on, for surfaces that tint rather than mark: a grouped-row hairline, a
   * folder header, a content-label chip fill.
   *
   * Expressed as a color-mix over the identity ink so a wash can never drift
   * away from the dot it belongs to. `transparent` as the second operand
   * keeps the result compositable on a hovered row, which a solid fill is
   * not (BUILD-CONTRACT 2.3).
   *
   * @param {string} name - Legacy palette name or block hue name.
   * @param {number} percent - Ink share, 0 to 100.
   * @returns {string} A `color-mix(...)` CSS value.
   */
  function blockHueWash(name, percent) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    return 'color-mix(in srgb, ' + blockHueVar(name) + ' ' + pct + '%, transparent)';
  }

  /**
   * TAB_COLORS projected onto chrome tokens, name by name. Named and shaped
   * exactly as BUILD-CONTRACT 1.8 specifies so the contract's own text is
   * greppable in the source it describes.
   */
  const TAB_COLOR_TOKENS = Object.freeze(TAB_COLORS.reduce(function (acc, name) {
    acc[name] = blockHueToken(name);
    return acc;
  }, {}));

  /**
   * Return one entry per place sessionId is currently open across all tab groups.
   * @param {string} sessionId
   * @param {Array<{id:string, panes:Array<{slot:number,sessionId:string}>}>} tabGroups
   * @returns {Array<{tabId:string, slot:number}>}
   */
  function getSessionInstances(sessionId, tabGroups) {
    const out = [];
    if (!sessionId || !Array.isArray(tabGroups)) return out;
    for (const tab of tabGroups) {
      const panes = (tab && tab.panes) || [];
      for (const p of panes) {
        if (p && p.sessionId === sessionId) {
          out.push({ tabId: tab.id, slot: p.slot });
        }
      }
    }
    return out;
  }

  /**
   * Return the tab's positional colour. Index is the tab's global position
   * across all tab groups (regardless of folder), wrapping modulo the palette.
   */
  function getTabColor(tabId, tabGroups) {
    const idx = (tabGroups || []).findIndex(g => g.id === tabId);
    return TAB_COLORS[(idx >= 0 ? idx : 0) % TAB_COLORS.length];
  }

  /**
   * The same positional colour, already resolved to a chrome CSS value.
   *
   * The POSITION rule is unchanged and deliberately so: DESIGN-SPEC 5.1 says
   * a tab group's dot colour "comes from the position in the list, not from
   * the content", and names the identical six-step ramp this module has
   * always used. Only the paint moves onto the chrome layer.
   *
   * @param {string} tabId - Tab group id.
   * @param {Array<{id:string}>} tabGroups - All tab groups, in display order.
   * @returns {string} e.g. `var(--app-text-red)`.
   */
  function getTabColorVar(tabId, tabGroups) {
    return blockHueVar(getTabColor(tabId, tabGroups));
  }

  return {
    TAB_COLORS,
    getSessionInstances,
    getTabColor,
    // Chrome hue projection (BUILD-CONTRACT 1.8). Additive: every name above
    // keeps its original identity and shape.
    BLOCK_HUE_TOKENS,
    BLOCK_HUE_BG_TOKENS,
    PALETTE_BLOCK_HUE,
    FALLBACK_BLOCK_HUE,
    TAB_COLOR_TOKENS,
    blockHue,
    blockHueToken,
    blockHueVar,
    blockHueBgToken,
    blockHueBgVar,
    blockHueWash,
    getTabColorVar,
  };
});
