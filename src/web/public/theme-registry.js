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
  });
}));
