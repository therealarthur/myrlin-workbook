/**
 * terminal-surface.js - the single terminal surface projection.
 * Created: 2026-08-13, Notion restyle phase P5, work package P5.4.
 * BUILD-CONTRACT.md P5.4 and the file plan, TERMINAL-ARCHITECTURE.md 10.2,
 * DESIGN-SPEC.md 10.2 and 10.4, CURRENT-UI.md section 6.
 *
 * WHAT PROBLEM THIS FILE SOLVES
 *
 * Before P5 this application had TWO independent colour systems on the
 * terminal, and they met only through getComputedStyle. CURRENT-UI.md section
 * 6.2 measured the consequence: eight of the thirteen palettes were frozen
 * JavaScript objects inside terminal.js, unreachable from CSS, so editing
 * styles.css could not change the terminal for Mocha, Latte, Frappe,
 * Macchiato, Cherry, Ocean, Amber or Mint. The other five were derived from
 * custom properties at run time, so the two halves of one palette were
 * authored in two files in two formats.
 *
 * The chrome around the terminal had the mirror-image problem. The Notion mock
 * paints a pane's input row, its prompt glyph, its top rule and its padding in
 * the TERMINAL palette (DESIGN-SPEC.md 5.6 and 10.4), and none of those five
 * slots existed anywhere a stylesheet could read.
 *
 * This file is the one source both halves read. It is DATA, deliberately, and
 * DESIGN-SPEC.md 10.5 says so in as many words: "All thirteen terminal
 * palettes. They are data, not tokens." Three consequences follow, and each is
 * the reason the alternative was rejected:
 *
 *   1. It works with no DOM. A unit test, an early boot before first paint and
 *      a detached document all get the same answer, so a pane constructed
 *      before the stylesheet resolved can never inherit another theme's
 *      colours. That was the failure mode the eight static palettes existed to
 *      prevent, and it is preserved rather than traded away.
 *   2. Every value is a SIX-DIGIT HEX. `_colorWithAlpha` in terminal.js parses
 *      nothing else and silently returns its fallback for `rgba()`, `hsl()`,
 *      `oklch()` or `color-mix()`. That is risk R5 and BUILD-CONTRACT P5.4's
 *      critical constraint, and a data table is the only way to guarantee it,
 *      because a custom property can be re-authored in any format at any time.
 *   3. It flows JS to CSS rather than CSS to JS. `applyTerminalSurfaceVars`
 *      publishes the five mock slots as `--term-*` custom properties, so the
 *      input row and the terminal agree BY CONSTRUCTION. Reading them the
 *      other way would leave the two able to disagree, which is exactly the
 *      seam TERMINAL-ARCHITECTURE.md 10.1 calls the highest risk item for
 *      perceived quality.
 *
 * DRIFT IS GATED, NOT ASSUMED. test/terminal-surface.test.js re-derives every
 * ANSI slot from the palette blocks in styles.css and asserts the projection
 * matches, so a future edit to `--base` or `--mauve` for any theme fails CI
 * rather than silently desynchronising the terminal from the chrome. That gate
 * is what makes a static table safe; without it this file would rot.
 *
 * WHERE EACH SLOT COMES FROM
 *
 *   bg, ink, cursor, cursorAccent, selectionBg, selectionInk, ansi (16)
 *     The palette this application already shipped, byte for byte. These are
 *     the values `TerminalPane.getCurrentTheme()` has been returning, and
 *     theme-registry.test.js pins all thirteen backgrounds. Nobody's terminal
 *     changes colour because of this file.
 *
 *   dim, rule, accent
 *     New. The Notion mock's `_termThemes()` table (DESIGN-SPEC.md 10.2) is
 *     the source, verbatim, except where a value fails the contrast floor
 *     against the ground THIS application ships. See the substitution note
 *     below: six values moved, each onto another step of the same palette,
 *     each with both measurements recorded.
 *
 *   fontFamily
 *     Resolved at call time, not stored: the `--font-terminal` token when a
 *     document is available, the per-theme override when a theme sets one
 *     (none does today, and the field exists so one can), and TERMINAL_FONT
 *     underneath so Node and early boot still get a real stack.
 *
 * THE SUBSTITUTIONS, with numbers. PROCEDURE.md 4.2 forbids darkening a
 * captured value and prescribes re-pairing instead, so every one of these
 * moves to another step of the SAME palette rather than to a new colour. The
 * floor is 4.5:1, which TERMINAL-ARCHITECTURE.md 10.5 makes a verification
 * gate for the three light themes and which this file applies to all thirteen.
 *
 *   dim, dracula         #6272a4 3.03:1 -> #b8b8b0 7.13:1  (--subtext0)
 *   dim, tokyo-night     #565f89 2.76:1 -> #9aa5ce 7.04:1  (--subtext0)
 *   dim, latte           #8c8fa1 2.83:1 -> #5c5f77 5.53:1  (--subtext1)
 *   dim, rose-pine-dawn  #9893a5 2.73:1 -> #6e6a86 4.73:1  (--subtext0)
 *   dim, gruvbox-light   #7c6f64 4.29:1 -> #504945 7.78:1  (--subtext0)
 *   accent, rose-pine-dawn  #b4637a 3.84:1 -> #286983 5.59:1  (--blue)
 *
 * The five dim substitutions take the QUIETEST palette step that clears the
 * floor, walking `--subtext0`, `--subtext1`, `--text` in that order, which is
 * quietest first in every one of these palettes. The one accent substitution
 * takes Rose Pine's own `pine`, which is a canonical accent for that theme
 * rather than an invention; its `love` misses the text floor by 0.66 and the
 * prompt glyph is text.
 *
 * `rule` is taken verbatim in all thirteen and is NOT substituted. It is a 1px
 * divider, so its floor is the 3:1 boundary floor rather than the text floor,
 * and it measures 1.27:1 to 1.80:1 against its ground. That is the same
 * compressed-neutral-ramp family DEVIATIONS.md DV-15 already records, with the
 * same owner: BUILD-CONTRACT.md 5.5.4's contrast reckoning at P12. Raising it
 * per theme here would make thirteen uncoordinated decisions about one
 * question. DECISIONS.md 14.5 carries the full table.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function exposeTerminalSurface(root, factory) {
  'use strict';

  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.MyrlinTerminalSurface = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTerminalSurface() {
  'use strict';

  /**
   * The terminal face, as a last resort.
   *
   * `--font-terminal` in styles.css is the real source and carries the same
   * families in the same order; this constant exists so a Node consumer, an
   * early boot before the stylesheet resolves, or a detached document still
   * gets a real monospace stack rather than a bare `monospace`.
   */
  var TERMINAL_FONT = '"iA Writer Mono", "JetBrains Mono", SFMono-Regular, ' +
    'Consolas, "Liberation Mono", Menlo, monospace';

  /** The custom property `--font-terminal`, read when a document exists. */
  var FONT_PROPERTY = '--font-terminal';

  /**
   * The five mock slots, published to CSS by applyTerminalSurfaceVars.
   *
   * Named here rather than inline so the stylesheet, the projection and the
   * test all agree on the spelling, and so a sixth slot is one row rather than
   * three edits.
   */
  var CSS_VARIABLES = Object.freeze({
    '--term-bg': 'bg',
    '--term-ink': 'ink',
    '--term-dim': 'dim',
    '--term-rule': 'rule',
    '--term-accent': 'accent',
    '--term-selection-bg': 'selectionBg',
    '--term-cursor': 'cursor',
  });

  /**
   * The thirteen palettes.
   *
   * Ordered to match THEME_REGISTRY in theme-registry.js: dark first, then
   * light. The ids are PERSISTENCE ids stored under `cwm_theme`; do not
   * rename one.
   */
  var SURFACES = {
    'mocha': {
      appearance: 'dark',
      bg: '#1e1e2e', ink: '#cdd6f4',
      dim: '#a6adc8', rule: '#45475a', accent: '#cba6f7',
      cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
      selectionBg: 'rgba(203, 166, 247, 0.25)', selectionInk: '#cdd6f4',
      ansi: {
        black: '#45475a', red: '#f38ba8',
        green: '#a6e3a1', yellow: '#f9e2af',
        blue: '#89b4fa', magenta: '#cba6f7',
        cyan: '#94e2d5', white: '#bac2de',
        brightBlack: '#585b70', brightRed: '#f38ba8',
        brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
        brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5', brightWhite: '#a6adc8',
      },
    },
    'macchiato': {
      appearance: 'dark',
      bg: '#24273a', ink: '#cad3f5',
      dim: '#a5adcb', rule: '#494d64', accent: '#c6a0f6',
      cursor: '#f4dbd6', cursorAccent: '#24273a',
      selectionBg: 'rgba(198, 160, 246, 0.3)', selectionInk: '#cad3f5',
      ansi: {
        black: '#494d64', red: '#ed8796',
        green: '#a6da95', yellow: '#eed49f',
        blue: '#8aadf4', magenta: '#c6a0f6',
        cyan: '#8bd5ca', white: '#b8c0e0',
        brightBlack: '#5b6078', brightRed: '#ed8796',
        brightGreen: '#a6da95', brightYellow: '#eed49f',
        brightBlue: '#8aadf4', brightMagenta: '#c6a0f6',
        brightCyan: '#8bd5ca', brightWhite: '#cad3f5',
      },
    },
    'frappe': {
      appearance: 'dark',
      bg: '#303446', ink: '#c6d0f5',
      dim: '#a5adce', rule: '#51576d', accent: '#ca9ee6',
      cursor: '#f2d5cf', cursorAccent: '#303446',
      selectionBg: 'rgba(202, 158, 230, 0.3)', selectionInk: '#c6d0f5',
      ansi: {
        black: '#51576d', red: '#e78284',
        green: '#a6d189', yellow: '#e5c890',
        blue: '#8caaee', magenta: '#ca9ee6',
        cyan: '#81c8be', white: '#b5bfe2',
        brightBlack: '#626880', brightRed: '#e78284',
        brightGreen: '#a6d189', brightYellow: '#e5c890',
        brightBlue: '#8caaee', brightMagenta: '#ca9ee6',
        brightCyan: '#81c8be', brightWhite: '#c6d0f5',
      },
    },
    'nord': {
      appearance: 'dark',
      bg: '#2e3440', ink: '#eceff4',
      dim: '#81a1c1', rule: '#434c5e', accent: '#88c0d0',
      cursor: '#d8b4a0', cursorAccent: '#2e3440',
      selectionBg: 'rgba(180, 142, 173, 0.25)', selectionInk: '#eceff4',
      ansi: {
        black: '#434c5e', red: '#bf616a',
        green: '#a3be8c', yellow: '#ebcb8b',
        blue: '#81a1c1', magenta: '#b48ead',
        cyan: '#8fbcbb', white: '#d8dee9',
        brightBlack: '#4c566a', brightRed: '#bf616a',
        brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
        brightBlue: '#81a1c1', brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb', brightWhite: '#eceff4',
      },
    },
    'dracula': {
      appearance: 'dark',
      bg: '#282a36', ink: '#f8f8f2',
      dim: '#b8b8b0', rule: '#44475a', accent: '#bd93f9',
      cursor: '#ffd0e0', cursorAccent: '#282a36',
      selectionBg: 'rgba(189, 147, 249, 0.25)', selectionInk: '#f8f8f2',
      ansi: {
        black: '#44475a', red: '#ff5555',
        green: '#50fa7b', yellow: '#f1fa8c',
        blue: '#8be9fd', magenta: '#bd93f9',
        cyan: '#8be9fd', white: '#d8d8d0',
        brightBlack: '#545768', brightRed: '#ff5555',
        brightGreen: '#50fa7b', brightYellow: '#f1fa8c',
        brightBlue: '#8be9fd', brightMagenta: '#bd93f9',
        brightCyan: '#8be9fd', brightWhite: '#f8f8f2',
      },
    },
    'tokyo-night': {
      appearance: 'dark',
      bg: '#1a1b26', ink: '#c0caf5',
      dim: '#9aa5ce', rule: '#3b4261', accent: '#7aa2f7',
      cursor: '#ffc0cb', cursorAccent: '#1a1b26',
      selectionBg: 'rgba(187, 154, 247, 0.25)', selectionInk: '#c0caf5',
      ansi: {
        black: '#3b4261', red: '#f7768e',
        green: '#9ece6a', yellow: '#e0af68',
        blue: '#7aa2f7', magenta: '#bb9af7',
        cyan: '#73daca', white: '#a9b1d6',
        brightBlack: '#545c7e', brightRed: '#f7768e',
        brightGreen: '#9ece6a', brightYellow: '#e0af68',
        brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
        brightCyan: '#73daca', brightWhite: '#c0caf5',
      },
    },
    'cherry': {
      appearance: 'dark',
      bg: '#221a22', ink: '#f0ddf0',
      dim: '#a97f92', rule: '#4a2c3d', accent: '#ed5e93',
      cursor: '#f5a0d0', cursorAccent: '#221a22',
      selectionBg: 'rgba(245, 160, 208, 0.25)', selectionInk: '#f0ddf0',
      ansi: {
        black: '#4c404e', red: '#f07888',
        green: '#a0d890', yellow: '#f0d098',
        blue: '#90b0ea', magenta: '#e890c8',
        cyan: '#80d8c0', white: '#dcc8e0',
        brightBlack: '#605464', brightRed: '#f07888',
        brightGreen: '#a0d890', brightYellow: '#f0d098',
        brightBlue: '#90b0ea', brightMagenta: '#e890c8',
        brightCyan: '#80d8c0', brightWhite: '#f0ddf0',
      },
    },
    'ocean': {
      appearance: 'dark',
      bg: '#1a1e28', ink: '#d8e4f5',
      dim: '#7e9aab', rule: '#29414f', accent: '#4fb3d9',
      cursor: '#70a8f0', cursorAccent: '#1a1e28',
      selectionBg: 'rgba(112, 168, 240, 0.25)', selectionInk: '#d8e4f5',
      ansi: {
        black: '#384254', red: '#f08888',
        green: '#80d8a0', yellow: '#f0d880',
        blue: '#70a8f0', magenta: '#b0a0ea',
        cyan: '#60d8d0', white: '#b8ccdc',
        brightBlack: '#4a5668', brightRed: '#f08888',
        brightGreen: '#80d8a0', brightYellow: '#f0d880',
        brightBlue: '#70a8f0', brightMagenta: '#b0a0ea',
        brightCyan: '#60d8d0', brightWhite: '#d8e4f5',
      },
    },
    'amber': {
      appearance: 'dark',
      bg: '#211e1a', ink: '#f0e8d8',
      dim: '#a8906a', rule: '#4a3c26', accent: '#e8a33d',
      cursor: '#f0d070', cursorAccent: '#211e1a',
      selectionBg: 'rgba(240, 208, 112, 0.25)', selectionInk: '#f0e8d8',
      ansi: {
        black: '#4c4438', red: '#e08878',
        green: '#a0d090', yellow: '#f0d070',
        blue: '#88b4d8', magenta: '#d0a8d8',
        cyan: '#78c8b8', white: '#dcd4bc',
        brightBlack: '#605848', brightRed: '#e08878',
        brightGreen: '#a0d090', brightYellow: '#f0d070',
        brightBlue: '#88b4d8', brightMagenta: '#d0a8d8',
        brightCyan: '#78c8b8', brightWhite: '#f0e8d8',
      },
    },
    'mint': {
      appearance: 'dark',
      bg: '#1a2120', ink: '#d8f0e8',
      dim: '#86a89a', rule: '#2e4a40', accent: '#57c99a',
      cursor: '#78e0a0', cursorAccent: '#1a2120',
      selectionBg: 'rgba(120, 224, 160, 0.25)', selectionInk: '#d8f0e8',
      ansi: {
        black: '#3c4a48', red: '#e09090',
        green: '#78e0a0', yellow: '#e0d890',
        blue: '#80b4e0', magenta: '#c0a0e0',
        cyan: '#60e0c8', white: '#c0dcd4',
        brightBlack: '#4e5e5c', brightRed: '#e09090',
        brightGreen: '#78e0a0', brightYellow: '#e0d890',
        brightBlue: '#80b4e0', brightMagenta: '#c0a0e0',
        brightCyan: '#60e0c8', brightWhite: '#d8f0e8',
      },
    },
    'latte': {
      appearance: 'light',
      bg: '#eff1f5', ink: '#4c4f69',
      dim: '#5c5f77', rule: '#bcc0cc', accent: '#8839ef',
      cursor: '#dc8a78', cursorAccent: '#eff1f5',
      selectionBg: 'rgba(136, 57, 239, 0.2)', selectionInk: '#4c4f69',
      ansi: {
        black: '#5c5f77', red: '#d20f39',
        green: '#40a02b', yellow: '#df8e1d',
        blue: '#1e66f5', magenta: '#8839ef',
        cyan: '#179299', white: '#acb0be',
        brightBlack: '#6c6f85', brightRed: '#d20f39',
        brightGreen: '#40a02b', brightYellow: '#df8e1d',
        brightBlue: '#1e66f5', brightMagenta: '#8839ef',
        brightCyan: '#179299', brightWhite: '#bcc0cc',
      },
    },
    'rose-pine-dawn': {
      appearance: 'light',
      bg: '#faf4ed', ink: '#575279',
      dim: '#6e6a86', rule: '#dfdad9', accent: '#286983',
      cursor: '#d7827e', cursorAccent: '#faf4ed',
      selectionBg: 'rgba(144, 122, 169, 0.2)', selectionInk: '#575279',
      ansi: {
        black: '#635f7b', red: '#b4637a',
        green: '#56949f', yellow: '#ea9d34',
        blue: '#286983', magenta: '#907aa9',
        cyan: '#56949f', white: '#cecacd',
        brightBlack: '#6e6a86', brightRed: '#b4637a',
        brightGreen: '#56949f', brightYellow: '#ea9d34',
        brightBlue: '#286983', brightMagenta: '#907aa9',
        brightCyan: '#56949f', brightWhite: '#dfdad9',
      },
    },
    'gruvbox-light': {
      appearance: 'light',
      bg: '#fbf1c7', ink: '#3c3836',
      dim: '#504945', rule: '#d5c4a1', accent: '#af3a03',
      cursor: '#c8956c', cursorAccent: '#fbf1c7',
      selectionBg: 'rgba(143, 63, 113, 0.2)', selectionInk: '#3c3836',
      ansi: {
        black: '#453e3a', red: '#9d0006',
        green: '#79740e', yellow: '#b57614',
        blue: '#076678', magenta: '#8f3f71',
        cyan: '#427b58', white: '#a89984',
        brightBlack: '#504945', brightRed: '#9d0006',
        brightGreen: '#79740e', brightYellow: '#b57614',
        brightBlue: '#076678', brightMagenta: '#8f3f71',
        brightCyan: '#427b58', brightWhite: '#bdae93',
      },
    },
  };

  // Freeze the table so a consumer that mutates a returned surface cannot
  // recolour every other pane. Deep, because `ansi` is the half a caller is
  // most likely to iterate over.
  Object.keys(SURFACES).forEach(function freezeSurface(id) {
    Object.freeze(SURFACES[id].ansi);
    Object.freeze(SURFACES[id]);
  });
  Object.freeze(SURFACES);

  var SURFACE_IDS = Object.freeze(Object.keys(SURFACES));

  /**
   * Read a custom property off the document root, tolerating every way that
   * can fail: no document, no window, a detached root, a throwing
   * getComputedStyle in a sandboxed frame.
   *
   * @param {string} property - Custom property name, including the leading
   *   double hyphen.
   * @returns {string} The trimmed value, or an empty string.
   */
  function readRootProperty(property) {
    try {
      if (typeof document === 'undefined' || !document.documentElement) return '';
      var view = typeof window !== 'undefined' ? window : null;
      var compute = view && typeof view.getComputedStyle === 'function'
        ? view.getComputedStyle
        : (typeof getComputedStyle === 'function' ? getComputedStyle : null);
      if (!compute) return '';
      var styles = compute(document.documentElement);
      if (!styles || typeof styles.getPropertyValue !== 'function') return '';
      return String(styles.getPropertyValue(property) || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * Resolve the terminal face for a theme.
   *
   * Order: the theme's own override, then the `--font-terminal` token, then
   * the constant. The per-theme override is the extension point
   * TERMINAL-ARCHITECTURE.md 10.2 asks for ("both consumers read from it"):
   * no palette sets one today, and a theme that wants its own face adds one
   * field rather than a branch.
   *
   * @param {object} surface - A surface entry.
   * @returns {string} A CSS font-family list.
   */
  function resolveFontFamily(surface) {
    if (surface && typeof surface.fontFamily === 'string' && surface.fontFamily) {
      return surface.fontFamily;
    }
    return readRootProperty(FONT_PROPERTY) || TERMINAL_FONT;
  }

  /**
   * The projection.
   *
   * @param {string} themeId - One of the thirteen persisted theme ids.
   * @returns {null|{id: string, appearance: string, bg: string, ink: string,
   *   dim: string, rule: string, accent: string, cursor: string,
   *   cursorAccent: string, selectionBg: string, selectionInk: string,
   *   fontFamily: string, ansi: object}} The surface, or null for an id this
   *   projection does not know. NULL RATHER THAN A DEFAULT is deliberate: the
   *   caller then falls through to its own last-resort palette, which is what
   *   keeps one pane from inheriting another theme's colours when a new id is
   *   added to the registry and not to this table.
   */
  function terminalSurface(themeId) {
    var surface = SURFACES[themeId];
    if (!surface) return null;
    return {
      id: themeId,
      appearance: surface.appearance,
      bg: surface.bg,
      ink: surface.ink,
      dim: surface.dim,
      rule: surface.rule,
      accent: surface.accent,
      cursor: surface.cursor,
      cursorAccent: surface.cursorAccent,
      selectionBg: surface.selectionBg,
      selectionInk: surface.selectionInk,
      fontFamily: resolveFontFamily(surface),
      ansi: surface.ansi,
    };
  }

  /**
   * Build the xterm `ITheme` for a theme.
   *
   * Separate from terminalSurface() because xterm's key names are xterm's, and
   * a consumer of the five mock slots should not have to know them. Every one
   * of the twenty two keys is set from the projection, which is
   * BUILD-CONTRACT P5.5's done criterion.
   *
   * @param {string} themeId - Persisted theme id.
   * @returns {object|null} An xterm ITheme, or null for an unknown id.
   */
  function xtermTheme(themeId) {
    var surface = SURFACES[themeId];
    if (!surface) return null;
    var ansi = surface.ansi;
    return {
      background: surface.bg,            // terminalSurface().bg
      foreground: surface.ink,           // terminalSurface().ink
      cursor: surface.cursor,            // terminalSurface().cursor
      cursorAccent: surface.cursorAccent, // the ground the cursor block inverts to
      selectionBackground: surface.selectionBg, // terminalSurface().selectionBg
      selectionForeground: surface.selectionInk, // terminalSurface().selectionInk
      black: ansi.black,                 // terminalSurface().ansi.black
      red: ansi.red,                     // terminalSurface().ansi.red
      green: ansi.green,                 // terminalSurface().ansi.green
      yellow: ansi.yellow,               // terminalSurface().ansi.yellow
      blue: ansi.blue,                   // terminalSurface().ansi.blue
      magenta: ansi.magenta,             // terminalSurface().ansi.magenta
      cyan: ansi.cyan,                   // terminalSurface().ansi.cyan
      white: ansi.white,                 // terminalSurface().ansi.white
      brightBlack: ansi.brightBlack,     // terminalSurface().ansi.brightBlack
      brightRed: ansi.brightRed,         // terminalSurface().ansi.brightRed
      brightGreen: ansi.brightGreen,     // terminalSurface().ansi.brightGreen
      brightYellow: ansi.brightYellow,   // terminalSurface().ansi.brightYellow
      brightBlue: ansi.brightBlue,       // terminalSurface().ansi.brightBlue
      brightMagenta: ansi.brightMagenta, // terminalSurface().ansi.brightMagenta
      brightCyan: ansi.brightCyan,       // terminalSurface().ansi.brightCyan
      brightWhite: ansi.brightWhite,     // terminalSurface().ansi.brightWhite
    };
  }

  /**
   * Publish the mock's five slots (plus the cursor and the selection wash) as
   * `--term-*` custom properties on the document root.
   *
   * This is the JS-to-CSS direction that makes the pane input row, the pane
   * padding and the history layer paint the SAME colour the terminal paints,
   * rather than a near neighbour. DESIGN-SPEC.md 5.6 and 10.4 require exactly
   * that, and 10.1 is why: a seam of one shade is immediately visible.
   *
   * Idempotent and side-effect free on failure. Called on load, on every
   * getCurrentTheme(), and from a `data-theme` observer, so it runs often and
   * must be cheap and must never throw into a render path.
   *
   * @param {string} themeId - Persisted theme id.
   * @param {HTMLElement} [rootElement] - Override for the element to stamp,
   *   for tests. Defaults to `document.documentElement`.
   * @returns {boolean} Whether the properties were written.
   */
  function applyTerminalSurfaceVars(themeId, rootElement) {
    var surface = SURFACES[themeId];
    if (!surface) return false;
    var target = rootElement;
    try {
      if (!target) {
        if (typeof document === 'undefined' || !document.documentElement) return false;
        target = document.documentElement;
      }
      if (!target.style || typeof target.style.setProperty !== 'function') return false;
      Object.keys(CSS_VARIABLES).forEach(function setOne(property) {
        target.style.setProperty(property, surface[CSS_VARIABLES[property]]);
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  return Object.freeze({
    SURFACES: SURFACES,
    SURFACE_IDS: SURFACE_IDS,
    CSS_VARIABLES: CSS_VARIABLES,
    TERMINAL_FONT: TERMINAL_FONT,
    FONT_PROPERTY: FONT_PROPERTY,
    terminalSurface: terminalSurface,
    xtermTheme: xtermTheme,
    applyTerminalSurfaceVars: applyTerminalSurfaceVars,
  });
}));
