/**
 * Marketing content for Claude Workspace Manager screenshots/GIFs.
 *
 * Provides realistic fake terminal output styled with ANSI escape codes
 * for injection into xterm.js terminals. All file paths use C:\Projects\*
 * to avoid leaking real user paths.
 *
 * Usage:
 *   const { session1, session2, session3, session4, claudePrompt, typingSequence, demoFeatures, demoNotes } = require('./content');
 *   term.write(session1());
 */

// ─── ANSI Helpers ────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';

/**
 * Shorthand: wrap text in color then reset.
 */
function c(color, text) {
  return `${color}${text}${RESET}`;
}

/**
 * Bold + color combo.
 */
function bc(color, text) {
  return `${BOLD}${color}${text}${RESET}`;
}

/**
 * Builds the Claude Code header box.
 * @param {'Opus'|'Sonnet'} model
 * @returns {string}
 */
function header(model) {
  const modelPad = model === 'Opus' ? '  ' : '';
  return [
    `${DIM}\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e${RESET}`,
    `${DIM}\u2502${RESET} ${bc(MAGENTA, '\u273b')} ${BOLD}Claude Code${RESET}        ${DIM}(${RESET}${c(CYAN, model)}${DIM})${RESET}${modelPad}     ${DIM}v2.1${RESET}  ${DIM}\u2502${RESET}`,
    `${DIM}\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f${RESET}`,
  ].join('\r\n');
}

/**
 * The styled interactive prompt character.
 */
function prompt() {
  return `${BOLD}${MAGENTA}\u276f${RESET} `;
}

/**
 * A tool action line (indented, cyan tool name).
 */
function tool(name, detail) {
  return `  ${bc(CYAN, name)} ${detail || ''}`;
}

/**
 * An indented sub-line (dim +/bullet style).
 */
function sub(text) {
  return `   ${DIM}${text}${RESET}`;
}

/**
 * A green success check.
 */
function ok(text) {
  return `   ${c(GREEN, '\u2713')} ${c(GREEN, text)}`;
}

// ─── Session Content ─────────────────────────────────────────────────────────

/**
 * Session 1 — Coding Session
 *
 * Simulates Claude reading a file, editing a component, and writing tests.
 */
function session1() {
  const lines = [
    header('Opus'),
    `${prompt()}Working on ui-components`,
    '',
    `${c(YELLOW, '\u23fa')} I'll update the Button component to support icon variants.`,
    '',
    tool('Read', `${c(BLUE, 'src/components/Button.tsx')} ${DIM}(248 lines)${RESET}`),
    '',
    tool('Edit', c(BLUE, 'src/components/Button.tsx')),
    sub(`${GREEN}+${RESET} Added ${BOLD}iconLeft${RESET} and ${BOLD}iconRight${RESET} props`),
    sub(`${GREEN}+${RESET} Updated render method for icon layout`),
    sub(`${GREEN}+${RESET} Added ${BOLD}aria-label${RESET} for icon-only buttons`),
    ok(`Changes applied ${DIM}(278 lines)${RESET}`),
    '',
    tool('Write', c(BLUE, 'src/components/Button.test.tsx')),
    sub(`${GREEN}+${RESET} Icon variant rendering tests`),
    sub(`${GREEN}+${RESET} Accessibility tests for icon-only mode`),
    ok(`Created ${DIM}(89 lines)${RESET}`),
    '',
    tool('Bash', `${DIM}npm test -- --testPathPattern=Button${RESET}`),
    `   ${BOLD}PASS${RESET}  ${c(BLUE, 'src/components/Button.test.tsx')}`,
    `   ${c(GREEN, '\u2713')} renders default button ${DIM}(12ms)${RESET}`,
    `   ${c(GREEN, '\u2713')} renders with left icon ${DIM}(8ms)${RESET}`,
    `   ${c(GREEN, '\u2713')} renders icon-only with aria-label ${DIM}(6ms)${RESET}`,
    `   ${DIM}Tests:${RESET} ${c(GREEN, '3 passed')}, 3 total`,
    '',
    `All changes applied. The Button component now supports ${BOLD}iconLeft${RESET},`,
    `${BOLD}iconRight${RESET}, and icon-only variants with proper accessibility labels.`,
    '',
    prompt(),
  ];
  return lines.join('\r\n');
}

/**
 * Session 2 — Planning Session
 *
 * Simulates creating a PLANNING.md and spawning a subagent for analysis.
 */
function session2() {
  const lines = [
    header('Sonnet'),
    `${prompt()}Plan the state management refactor`,
    '',
    `${c(YELLOW, '\u23fa')} I'll create a planning document and analyze the current architecture.`,
    '',
    tool('Glob', `${DIM}**/*.{store,context,reducer}.{ts,tsx}${RESET}`),
    sub(`Found ${BOLD}12${RESET} files`),
    '',
    tool('Read', `${c(BLUE, 'src/state/AppContext.tsx')} ${DIM}(342 lines)${RESET}`),
    tool('Read', `${c(BLUE, 'src/state/reducers/index.ts')} ${DIM}(156 lines)${RESET}`),
    '',
    tool('Write', c(BLUE, 'PLANNING.md')),
    sub(`${BOLD}## State Management Refactor${RESET}`),
    sub(''),
    sub(`${BOLD}Current${RESET}: React Context + useReducer ${DIM}(7 contexts, 12 reducers)${RESET}`),
    sub(`${BOLD}Target${RESET}: Zustand stores with persistence middleware`),
    sub(''),
    sub(`${BOLD}### Migration Phases${RESET}`),
    sub(`${YELLOW}1.${RESET} Install zustand + immer middleware`),
    sub(`${YELLOW}2.${RESET} Create atomic stores ${DIM}(auth, ui, data, settings)${RESET}`),
    sub(`${YELLOW}3.${RESET} Migrate components top-down ${DIM}(pages \u2192 features \u2192 shared)${RESET}`),
    sub(`${YELLOW}4.${RESET} Remove legacy Context providers`),
    sub(`${YELLOW}5.${RESET} Add persistence for offline support`),
    ok(`Created ${DIM}(67 lines)${RESET}`),
    '',
    tool('Task', `${c(YELLOW, 'Spawning subagent')} for dependency analysis...`),
    `   ${DIM}[Subagent]${RESET} Analyzing ${BOLD}24${RESET} component files for state dependencies...`,
    `   ${DIM}[Subagent]${RESET} ${c(GREEN, '\u2713')} Mapped ${BOLD}47${RESET} state subscriptions across ${BOLD}3${RESET} domains`,
    '',
    `Ready for review. See ${c(BLUE, 'PLANNING.md')} for the full migration strategy.`,
    '',
    prompt(),
  ];
  return lines.join('\r\n');
}

/**
 * Session 3 — Testing Session
 *
 * Simulates running a test suite with coverage results.
 */
function session3() {
  const lines = [
    header('Sonnet'),
    `${prompt()}Run the test suite and fix any failures`,
    '',
    `${c(YELLOW, '\u23fa')} Running the full test suite first to check current status.`,
    '',
    tool('Bash', `${DIM}npm test${RESET}`),
    '',
    `  ${DIM}> project-alpha@2.0.0 test${RESET}`,
    `  ${DIM}> jest --coverage --verbose${RESET}`,
    '',
    `  ${bc(GREEN, 'PASS')}  ${c(BLUE, 'src/components/Button.test.tsx')}`,
    `    ${c(GREEN, '\u2713')} renders with default props ${DIM}(15ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} fires onClick handler ${DIM}(12ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} applies variant classes ${DIM}(8ms)${RESET}`,
    '',
    `  ${bc(GREEN, 'PASS')}  ${c(BLUE, 'src/hooks/useAuth.test.ts')}`,
    `    ${c(GREEN, '\u2713')} returns authenticated state ${DIM}(22ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} handles token refresh ${DIM}(18ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} clears session on logout ${DIM}(14ms)${RESET}`,
    '',
    `  ${bc(GREEN, 'PASS')}  ${c(BLUE, 'src/utils/format.test.ts')}`,
    `    ${c(GREEN, '\u2713')} formats currency correctly ${DIM}(3ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} formats dates with locale ${DIM}(5ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} truncates long strings ${DIM}(2ms)${RESET}`,
    '',
    `  ${bc(GREEN, 'PASS')}  ${c(BLUE, 'src/api/client.test.ts')}`,
    `    ${c(GREEN, '\u2713')} retries on 5xx errors ${DIM}(45ms)${RESET}`,
    `    ${c(GREEN, '\u2713')} adds auth headers ${DIM}(8ms)${RESET}`,
    '',
    `  ${DIM}Test Suites:${RESET} ${c(GREEN, '4 passed')}, 4 total`,
    `  ${DIM}Tests:${RESET}       ${c(GREEN, '11 passed')}, 11 total`,
    `  ${DIM}Coverage:${RESET}    ${c(GREEN, '94.2%')} Statements ${DIM}|${RESET} ${c(YELLOW, '89.7%')} Branches ${DIM}|${RESET} ${c(GREEN, '91.3%')} Functions`,
    `  ${DIM}Time:${RESET}        3.847s`,
    '',
    `All tests passing with ${bc(GREEN, '94.2%')} coverage. No failures to fix.`,
    '',
    prompt(),
  ];
  return lines.join('\r\n');
}

/**
 * Session 4 — Debugging Session
 *
 * Simulates diagnosing and fixing a port conflict (EADDRINUSE).
 */
function session4() {
  const lines = [
    header('Opus'),
    `${prompt()}The API server won't start \u2014 getting EADDRINUSE`,
    '',
    `${c(YELLOW, '\u23fa')} Let me check what's using that port and fix the issue.`,
    '',
    tool('Bash', `${DIM}netstat -ano | findstr :3000${RESET}`),
    `   ${DIM}TCP${RESET}  0.0.0.0:${BOLD}3000${RESET}  0.0.0.0:0  ${c(YELLOW, 'LISTENING')}  ${DIM}18294${RESET}`,
    '',
    `  Found a stale process on port ${BOLD}3000${RESET} ${DIM}(PID 18294)${RESET}.`,
    '',
    tool('Bash', `${DIM}taskkill /PID 18294 /F${RESET}`),
    `   ${c(GREEN, 'SUCCESS')}: The process with PID 18294 has been terminated.`,
    '',
    tool('Bash', `${DIM}npm run dev${RESET}`),
    `   ${DIM}> backend-api@1.0.0 dev${RESET}`,
    `   ${DIM}> ts-node src/server.ts${RESET}`,
    '',
    `   ${c(GREEN, '\u2713')} Database connected ${DIM}(PostgreSQL 16.2)${RESET}`,
    `   ${c(GREEN, '\u2713')} Redis cache ready`,
    `   ${c(GREEN, '\u2713')} API server running on ${c(CYAN, 'http://localhost:3000')}`,
    '',
    `   ${DIM}Routes loaded:${RESET}`,
    `     ${c(GREEN, 'GET')}    ${DIM}/api/health${RESET}`,
    `     ${c(GREEN, 'GET')}    ${DIM}/api/users${RESET}`,
    `     ${c(YELLOW, 'POST')}   ${DIM}/api/users${RESET}`,
    `     ${c(BLUE, 'PUT')}    ${DIM}/api/users/:id${RESET}`,
    `     ${c(RED, 'DELETE')} ${DIM}/api/users/:id${RESET}`,
    '',
    `  Server is running. The stale process was from a previous dev session`,
    `  that didn't shut down cleanly. Consider adding a cleanup script.`,
    '',
    prompt(),
  ];
  return lines.join('\r\n');
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Returns the styled Claude Code prompt character.
 * Bold magenta > followed by a space.
 * @returns {string}
 */
function claudePrompt() {
  return `${BOLD}${MAGENTA}\u276f${RESET} `;
}

/**
 * Splits text into individual characters with realistic typing delays.
 * Adds longer pauses after punctuation for a natural feel.
 *
 * @param {string} text - The text to split into a typing sequence
 * @returns {Array<{char: string, delay: number}>}
 */
function typingSequence(text) {
  const punctuation = new Set(['.', ',', '!', '?', ';', ':']);
  const result = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Base delay: random between 20-80ms
    let delay = Math.floor(Math.random() * 61) + 20;

    // Longer pause after punctuation: 200-400ms
    if (punctuation.has(char)) {
      delay = Math.floor(Math.random() * 201) + 200;
    }

    result.push({ char, delay });
  }

  return result;
}

// ─── Demo Data ───────────────────────────────────────────────────────────────

/**
 * Kanban-style feature cards for demo workspace board views.
 * @type {Array<{title: string, description: string, status: 'done'|'active'|'review'|'planned'}>}
 */
const demoFeatures = [
  {
    title: 'User Authentication',
    description: 'OAuth2 + JWT token flow with refresh rotation',
    status: 'done',
  },
  {
    title: 'Dashboard Analytics',
    description: 'Real-time metrics with Chart.js and WebSocket updates',
    status: 'active',
  },
  {
    title: 'API Rate Limiting',
    description: 'Redis-based sliding window limiter with per-key quotas',
    status: 'active',
  },
  {
    title: 'File Upload Service',
    description: 'S3 presigned URLs with chunked upload and progress tracking',
    status: 'review',
  },
  {
    title: 'Email Notifications',
    description: 'Transactional emails via Resend with template system',
    status: 'planned',
  },
  {
    title: 'Dark Mode Toggle',
    description: 'System preference detection + manual override with persistence',
    status: 'done',
  },
  {
    title: 'Search Indexing',
    description: 'Full-text search with Meilisearch and typo tolerance',
    status: 'planned',
  },
  {
    title: 'WebSocket Events',
    description: 'Real-time updates for multi-user collaboration',
    status: 'review',
  },
];

/**
 * Workspace documentation entries for demo doc panel views.
 * @type {Array<{section: string, title: string, content: string}>}
 */
const demoNotes = [
  {
    section: 'notes',
    title: 'Architecture Decision',
    content:
      'Chose Zustand over Redux for state management. Smaller bundle size, less boilerplate, and the immer middleware gives us immutable updates without the ceremony. The devtools integration is comparable for our needs.',
  },
  {
    section: 'goals',
    title: 'Q1 Milestone',
    content:
      'Ship v2.0 with the new auth flow, dashboard analytics, and rate limiting by end of March. File uploads and email notifications are stretch goals if the team has bandwidth.',
  },
  {
    section: 'tasks',
    title: 'Migrate database',
    content:
      'PostgreSQL 15 \u2192 16 upgrade. Need to test the new JSONB merge patch operator, verify extension compatibility (pg_trgm, uuid-ossp), and update connection pooling config for the new query planner.',
  },
  {
    section: 'tasks',
    title: 'Update API docs',
    content:
      'Swagger spec needs v2 endpoints added. The /api/users/:id/preferences and /api/teams/* routes are undocumented. Add request/response examples and error codes for each.',
  },
  {
    section: 'rules',
    title: 'Code Review Policy',
    content:
      '2 approvals required for merges to main. At least one reviewer must be a domain owner. All PRs must have passing CI, no coverage regression, and a linked issue or ADR.',
  },
];

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  session1,
  session2,
  session3,
  session4,
  claudePrompt,
  typingSequence,
  demoFeatures,
  demoNotes,
};
