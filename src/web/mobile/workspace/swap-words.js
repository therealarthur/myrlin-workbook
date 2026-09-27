/**
 * workspace/swap-words.js: the one table that turns every outcome of a
 * swap into Glass's exact sentence (DESIGN-SPEC 9.12 group H) and the
 * protocol status and code (PROTOCOL.md 4.11, 13).
 *
 * WHY: critic F18 and P28. v1 swaps run through Workbook's own apply paths
 * (A10), not Glass, yet the phone must show Glass's words. So the mapping
 * Glass's swap.rs does from Workbook's apply codes (apply_error_message,
 * claude_swap_block_reason, workbook_block_reason) is kept here, row by
 * row, with the names filled in and a final period added where Glass has
 * none. One test per row (b3-swap.test.js) keeps it honest.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

/** "Claude" or "Codex" for a provider id (the words Glass uses). */
const PROVIDER_WORD = Object.freeze({ claude: 'Claude', codex: 'Codex' }); // gsd:provider-literal-allowed (mobile v2 swap words)
/** Glass's note after a Codex swap (swap.rs RUNNING_CODEX_NOTE). */
const RUNNING_CODEX_NOTE = 'Running Codex keeps the old account until restarted.';

/**
 * Add a final period when the sentence has none (PROTOCOL.md 4.11).
 *
 * @param {string} s - Sentence.
 * @returns {string}
 */
function period(s) {
  const t = String(s || '').trim();
  return /[.!?]$/.test(t) ? t : t + '.';
}

/**
 * The rows. `match` lists the Workbook codes (or B3's own outcome kinds)
 * that produce the row; `words(o)` builds Glass's sentence from
 * {name, provider, computerName, minutes, other, message}.
 */
const ROWS = Object.freeze([
  { key: 'claudeOk', match: ['OK_CLAUDE'], status: 200, code: null, words: (o) => 'Switched Claude to ' + o.name + '.' },
  { key: 'codexOk', match: ['OK_CODEX'], status: 200, code: null, words: (o) => 'Switched Codex to ' + o.name + '. ' + RUNNING_CODEX_NOTE },
  { key: 'alreadyLive', match: ['ALREADY_ACTIVE', 'ALREADY_LIVE'], status: 200, code: null, words: (o) => o.name + ' is already active' },
  { key: 'workbookOffline', match: ['UNREACHABLE', 'TRANSPORT'], status: 502, code: 'SWAP_FAILED', words: () => 'Workbook offline, the switch did not happen' },
  { key: 'timeout', match: ['TIMEOUT'], status: 504, code: 'SWAP_TIMEOUT', words: () => 'Workbook did not answer in time; the switch may still finish, refresh to check' },
  { key: 'passive', match: ['CRED_POOL_EXTERNAL_OWNER', 'ACCT_POOL_EXTERNAL_OWNER', 'PASSIVE'], status: 409, code: 'SWAPS_PAUSED', words: () => 'Workbook is in passive mode, swaps paused' },
  { key: 'deadToken', match: ['CRED_TOKEN_DEAD', 'ACCT_TOKEN_DEAD', 'NEEDS_LOGIN'], status: 409, code: 'ACCOUNT_NOT_SWAPPABLE', words: (o) => o.name + ' needs a new sign-in. Tap its chip to sign in again' },
  { key: 'renewalGuard', match: ['RENEWAL_GUARD'], status: 409, code: 'SWAP_REFUSED', words: (o) => 'Claude Code is renewing its login, try again in ' + o.minutes + ' min' },
  { key: 'credentialManager', match: ['CREDMAN'], status: 409, code: 'SWAP_REFUSED', words: (o) => 'Claude Code keeps its login in Windows Credential Manager on ' + o.computerName + ', so Claude swaps are off' },
  { key: 'filesBusy', match: ['CRED_LIVE_BUSY', 'FILES_BUSY'], status: 409, code: 'SWAP_REFUSED', words: () => 'Claude Code is updating its login files, try again in a moment' },
  { key: 'identityMismatch', match: ['CRED_VERIFY_FAILED', 'IDENTITY_MISMATCH'], status: 502, code: 'SWAP_FAILED', words: (o) => 'Workbook switched ' + (PROVIDER_WORD[o.provider] || 'Claude') + ' to ' + o.name + ', but the live login is still ' + o.other + '. Check Workbook before switching again' },
  { key: 'liveFileUnreadable', match: ['CRED_LIVE_UNPARSEABLE'], status: 409, code: 'SWAP_REFUSED', words: () => "Claude Code's live login file could not be read, so Workbook changed nothing. Try again in a moment" },
  { key: 'notFound', match: ['CRED_NOT_FOUND', 'ACCT_NOT_FOUND'], status: 404, code: 'ACCOUNT_NOT_FOUND', words: (o) => 'Workbook no longer has ' + o.name + ', refresh and try again' },
  { key: 'incompleteCopy', match: ['CRED_INCOMPLETE', 'ACCT_INCOMPLETE'], status: 409, code: 'ACCOUNT_NOT_SWAPPABLE', words: (o) => "Workbook's copy of " + o.name + ' is incomplete. Tap its chip to sign in again' },
  { key: 'busyTimeout', match: ['CRED_OP_TIMEOUT', 'ACCT_OP_TIMEOUT'], status: 504, code: 'SWAP_TIMEOUT', words: () => 'Workbook was busy and timed out, try again in a moment' },
  { key: 'anythingElse', match: [], status: 502, code: 'SWAP_FAILED', words: (o) => 'Switching ' + (PROVIDER_WORD[o.provider] || 'Claude') + ' failed: ' + (o.message || 'unknown error') },
]);

/**
 * The row for an outcome code (the last row catches anything else).
 *
 * @param {string} code - Workbook error code or a B3 outcome kind.
 * @returns {object}
 */
function rowFor(code) {
  return ROWS.find((r) => r.match.includes(String(code || ''))) || ROWS[ROWS.length - 1];
}

/**
 * The words, status and protocol code of an outcome.
 *
 * @param {string} code - Workbook error code or B3 outcome kind.
 * @param {object} o - {name, provider, computerName, minutes, other, message}.
 * @returns {{key: string, status: number, code: (string|null), message: string}}
 */
function outcome(code, o) {
  const row = rowFor(code);
  const vars = Object.assign({ name: 'the account', provider: 'claude', computerName: 'this computer', minutes: 1, other: 'another account', message: '' }, o || {}); // gsd:provider-literal-allowed (mobile v2 swap words)
  // Glass's "anything else" line quotes Workbook's message; it must not
  // end in two periods once the final period is added.
  if (row.key === 'anythingElse') vars.message = String(vars.message || '').replace(/[.\s]+$/, '');
  return { key: row.key, status: row.status, code: row.code, message: period(row.words(vars)) };
}

/**
 * Glass's agent swap notice (DESIGN-SPEC 9.12 group H): "Switched Claude to
 * X by claude-code: reason"; no reason drops the colon part, no requester
 * reads "an agent".
 *
 * @param {object} e - {provider, to, requester, reason}.
 * @returns {string}
 */
function agentSwapNotice(e) {
  const who = e && e.requester ? String(e.requester) : 'an agent';
  const reason = e && e.reason ? ': ' + String(e.reason) : '';
  return 'Switched ' + (PROVIDER_WORD[e && e.provider] || 'Claude') + ' to ' + String((e && e.to) || 'an account') + ' by ' + who + reason;
}

module.exports = { ROWS, rowFor, outcome, period, agentSwapNotice, RUNNING_CODEX_NOTE, PROVIDER_WORD };
