/**
 * Canonical metadata for Workbook's color themes.
 *
 * Theme IDs in THEME_REGISTRY are persistence IDs already stored in
 * localStorage under `cwm_theme`; do not rename them. Product-facing choices
 * such as "Myrlin Dark" are aliases in FEATURED_THEME_CHOICES so the UI can
 * become simpler without invalidating existing preferences.
 *
 * This file intentionally contains metadata only. Palette values continue to
 * live in styles.css and terminal.js until those consumers are migrated to
 * this registry.
 */
(function exposeThemeRegistry(root, factory) {
  'use strict';

  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.MyrlinThemeRegistry = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createThemeRegistry() {
  'use strict';

  var DEFAULT_DARK_THEME_ID = 'mocha';
  var DEFAULT_LIGHT_THEME_ID = 'latte';

  function createTheme(id, label, appearance, tier, xtermPaletteId) {
    return Object.freeze({
      id: id,
      label: label,
      appearance: appearance,
      tier: tier,
      xterm: Object.freeze({
        paletteId: xtermPaletteId,
        fallback: xtermPaletteId !== id,
      }),
    });
  }

  // Keep this order aligned with the existing picker: dark themes first,
  // followed by light themes. The order is presentation metadata, not an ID.
  var THEME_REGISTRY = Object.freeze([
    createTheme('mocha', 'Mocha', 'dark', 'featured', 'mocha'),
    createTheme('macchiato', 'Macchiato', 'dark', 'more', 'macchiato'),
    createTheme('frappe', 'Frapp\u00e9', 'dark', 'more', 'frappe'),
    createTheme('nord', 'Nord', 'dark', 'more', 'nord'),
    createTheme('dracula', 'Dracula', 'dark', 'more', 'dracula'),
    createTheme('tokyo-night', 'Tokyo Night', 'dark', 'more', 'tokyo-night'),
    createTheme('cherry', 'Cherry', 'dark', 'more', 'cherry'),
    createTheme('ocean', 'Ocean', 'dark', 'more', 'ocean'),
    createTheme('amber', 'Amber', 'dark', 'more', 'amber'),
    createTheme('mint', 'Mint', 'dark', 'more', 'mint'),
    createTheme('latte', 'Latte', 'light', 'featured', 'latte'),
    createTheme('rose-pine-dawn', 'Rose Pine Dawn', 'light', 'more', 'rose-pine-dawn'),
    createTheme('gruvbox-light', 'Gruvbox Light', 'light', 'more', 'gruvbox-light'),
  ]);

  var themesById = Object.create(null);
  THEME_REGISTRY.forEach(function indexTheme(theme) {
    themesById[theme.id] = theme;
  });
  Object.freeze(themesById);

  var LEGACY_THEME_IDS = Object.freeze(THEME_REGISTRY.map(function getId(theme) {
    return theme.id;
  }));

  /**
   * Product-facing choices for a reduced theme picker.
   *
   * These IDs are conceptual aliases, never replacements for persisted theme
   * IDs. Consumers should persist the legacy ID returned by
   * resolveFeaturedChoice(), except for `system`, whose null persistedThemeId
   * signals that following the operating-system preference needs a separate
   * setting.
   */
  var FEATURED_THEME_CHOICES = Object.freeze([
    Object.freeze({
      id: 'system',
      label: 'System',
      kind: 'adaptive',
      darkThemeId: DEFAULT_DARK_THEME_ID,
      lightThemeId: DEFAULT_LIGHT_THEME_ID,
      persistedThemeId: null,
    }),
    Object.freeze({
      id: 'myrlin-dark',
      label: 'Myrlin Dark',
      kind: 'alias',
      themeId: DEFAULT_DARK_THEME_ID,
      persistedThemeId: DEFAULT_DARK_THEME_ID,
    }),
    Object.freeze({
      id: 'myrlin-light',
      label: 'Myrlin Light',
      kind: 'alias',
      themeId: DEFAULT_LIGHT_THEME_ID,
      persistedThemeId: DEFAULT_LIGHT_THEME_ID,
    }),
  ]);

  var featuredChoicesById = Object.create(null);
  FEATURED_THEME_CHOICES.forEach(function indexChoice(choice) {
    featuredChoicesById[choice.id] = choice;
  });
  Object.freeze(featuredChoicesById);

  function getTheme(themeId) {
    return themesById[themeId] || null;
  }

  function resolveXtermPaletteId(themeId) {
    var theme = getTheme(themeId);
    return theme ? theme.xterm.paletteId : DEFAULT_DARK_THEME_ID;
  }

  /**
   * The terminal surface projection for a theme.
   *
   * Notion restyle P5.4, BUILD-CONTRACT.md's file plan: "additive
   * `terminalSurface(id)` accessor delegating to `window.MyrlinTerminalSurface`
   * with a null-safe fallback. The 13 ids, labels, tiers, xterm.paletteId,
   * xterm.fallback and the frozen objects are untouched."
   *
   * WHY THIS IS A DELEGATION AND NOT THE DATA. This file's own header says it
   * "intentionally contains metadata only", and TERMINAL-ARCHITECTURE.md 10.2
   * asks for the registry to become canonical for terminal surface COLOUR.
   * Both are satisfied by keeping the 340-line colour table in its own file
   * and the pointer to it here: the registry stays the one place that answers
   * "what themes exist and what are they called", and it can now also answer
   * "and what does this one look like in a terminal" without carrying the
   * answer itself. index.html loads terminal-surface.js in the body, so on the
   * app surface the global is always there; requiring it from Node works
   * through the CommonJS branch below.
   *
   * Null-safe by design. A caller that gets null falls back to its own
   * last-resort palette, which is what stops one pane inheriting another
   * theme's colours when a script fails to load.
   *
   * @param {string} themeId - One of the 13 persisted theme ids.
   * @returns {object|null} The projection, or null when it is unavailable.
   */
  function terminalSurface(themeId) {
    var provider = null;
    try {
      if (typeof globalThis !== 'undefined' && globalThis.MyrlinTerminalSurface) {
        provider = globalThis.MyrlinTerminalSurface;
      } else if (typeof require === 'function' && typeof module === 'object' && module.exports) {
        provider = require('./terminal-surface.js');
      }
    } catch (_) {
      provider = null;
    }
    if (!provider || typeof provider.terminalSurface !== 'function') return null;
    try {
      return provider.terminalSurface(themeId);
    } catch (_) {
      return null;
    }
  }

  function resolveFeaturedChoice(choiceId, preferredAppearance) {
    var choice = featuredChoicesById[choiceId];
    if (!choice) return null;
    if (choice.kind === 'adaptive') {
      return preferredAppearance === 'light'
        ? choice.lightThemeId
        : choice.darkThemeId;
    }
    return choice.themeId;
  }

  return Object.freeze({
    DEFAULT_DARK_THEME_ID: DEFAULT_DARK_THEME_ID,
    DEFAULT_LIGHT_THEME_ID: DEFAULT_LIGHT_THEME_ID,
    THEME_REGISTRY: THEME_REGISTRY,
    THEMES_BY_ID: themesById,
    LEGACY_THEME_IDS: LEGACY_THEME_IDS,
    FEATURED_THEME_CHOICES: FEATURED_THEME_CHOICES,
    getTheme: getTheme,
    resolveXtermPaletteId: resolveXtermPaletteId,
    resolveFeaturedChoice: resolveFeaturedChoice,
    terminalSurface: terminalSurface,
  });
}));
