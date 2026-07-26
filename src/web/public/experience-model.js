/**
 * Pure presentation model for Workbook's focused experience.
 *
 * Keep state normalization here so the browser UI, source tests, and future
 * native shells agree on the same density and attention vocabulary.
 */
(function exposeExperienceModel(root, factory) {
  'use strict';

  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.MyrlinExperienceModel = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createExperienceModel() {
  'use strict';

  var DENSITY_CHOICES = Object.freeze([
    Object.freeze({
      id: 'quiet',
      label: 'Quiet',
      description: 'Keep supporting detail out of the way until it matters.',
    }),
    Object.freeze({
      id: 'informative',
      label: 'Informative',
      description: 'Show more status and context while you work.',
    }),
  ]);

  var densityIds = Object.freeze(DENSITY_CHOICES.map(function getDensityId(choice) {
    return choice.id;
  }));

  var ATTENTION_STATES = Object.freeze({
    'needs-input': Object.freeze({
      id: 'needs-input',
      label: 'Needs input',
      priority: 0,
      actionable: true,
      icon: '\u25cf',
    }),
    failed: Object.freeze({
      id: 'failed',
      label: 'Failed',
      priority: 1,
      actionable: true,
      icon: '\u00d7',
    }),
    complete: Object.freeze({
      id: 'complete',
      label: 'Complete',
      priority: 2,
      actionable: true,
      icon: '\u2713',
    }),
    stale: Object.freeze({
      id: 'stale',
      label: 'Stale',
      priority: 3,
      actionable: true,
      icon: '\u25cb',
    }),
    running: Object.freeze({
      id: 'running',
      label: 'Running',
      priority: 4,
      actionable: false,
      icon: '\u25b6',
    }),
  });

  function normalizeDensity(value) {
    return densityIds.indexOf(value) !== -1 ? value : 'quiet';
  }

  function normalizeAttentionState(value) {
    return ATTENTION_STATES[value] ? value : null;
  }

  function statusToAttentionState(status) {
    switch (String(status || '').toLowerCase()) {
      case 'error':
      case 'crashed':
      case 'failed':
      case 'rejected':
        return 'failed';
      case 'stale':
      case 'disconnected':
        return 'stale';
      case 'complete':
      case 'completed':
      case 'merged':
      case 'done':
        return 'complete';
      case 'running':
      case 'active':
      case 'idle':
      case 'planning':
        return 'running';
      default:
        return null;
    }
  }

  /**
   * Merge active-pane presentation state with the server session roster.
   * Pane state wins because it is live and can distinguish a prompt that needs
   * input from an otherwise-running process.
   */
  function buildAttentionQueue(panes, sessions) {
    var sessionRows = Array.isArray(sessions) ? sessions : [];
    var paneRows = Array.isArray(panes) ? panes : [];
    var sessionsById = Object.create(null);
    var seen = Object.create(null);
    var items = [];

    sessionRows.forEach(function indexSession(session) {
      if (session && session.id) sessionsById[session.id] = session;
    });

    paneRows.forEach(function addPane(pane) {
      if (!pane || !pane.sessionId) return;
      if (seen[pane.sessionId]) return;
      var session = sessionsById[pane.sessionId] || null;
      var state = normalizeAttentionState(pane.state)
        || statusToAttentionState(session && session.status)
        || 'running';
      var meta = ATTENTION_STATES[state];
      seen[pane.sessionId] = true;
      items.push({
        sessionId: pane.sessionId,
        sessionName: pane.sessionName
          || (session && (session.name || session.title))
          || pane.sessionId,
        provider: pane.provider || (session && session.provider) || null,
        slot: Number.isInteger(pane.slot) ? pane.slot : null,
        state: state,
        label: meta.label,
        priority: meta.priority,
        actionable: meta.actionable,
        icon: meta.icon,
      });
    });

    sessionRows.forEach(function addUnpinnedSession(session) {
      if (!session || !session.id || seen[session.id]) return;
      var state = normalizeAttentionState(session.attentionState)
        || statusToAttentionState(session.status);
      // Stopped/history rows are deliberately omitted. The queue is a compact
      // live overview, not another copy of Sessions.
      if (!state) return;
      var meta = ATTENTION_STATES[state];
      items.push({
        sessionId: session.id,
        sessionName: session.name || session.title || session.id,
        provider: session.provider || null,
        slot: null,
        state: state,
        label: meta.label,
        priority: meta.priority,
        actionable: meta.actionable,
        icon: meta.icon,
      });
    });

    return items.sort(function sortAttention(a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a.sessionName).localeCompare(String(b.sessionName));
    });
  }

  function groupThemes(themeRegistry) {
    var themes = themeRegistry && Array.isArray(themeRegistry.THEME_REGISTRY)
      ? themeRegistry.THEME_REGISTRY
      : [];
    return Object.freeze({
      dark: Object.freeze(themes.filter(function isDark(theme) {
        return theme.appearance === 'dark';
      })),
      light: Object.freeze(themes.filter(function isLight(theme) {
        return theme.appearance === 'light';
      })),
    });
  }

  return Object.freeze({
    DENSITY_CHOICES: DENSITY_CHOICES,
    DENSITY_IDS: densityIds,
    ATTENTION_STATES: ATTENTION_STATES,
    normalizeDensity: normalizeDensity,
    normalizeAttentionState: normalizeAttentionState,
    statusToAttentionState: statusToAttentionState,
    buildAttentionQueue: buildAttentionQueue,
    groupThemes: groupThemes,
  });
}));
