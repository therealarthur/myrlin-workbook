#!/usr/bin/env node
/**
 * Credential expiry-fix UI + wiring gate (expiry-fix spec Phases 2 and 3).
 *
 * Source-scan gate mirroring test/credential-delete-ui.test.js: no jsdom,
 * no browser, no network. The manager-side behavior (verdict split,
 * suspect ladder, dead-retry, proactive sweep, write-back guard) is locked
 * by test/credential-manager.test.js; this suite locks the FRONTEND copy
 * and wiring plus the server interval:
 *
 *   1. renderAccountRow: softer dead-row copy ("Signed out here...") with
 *      a Retry button wired by data-profile-id, and the amber suspect note
 *      ("Temporary auth issue, retrying") keyed off BOTH the health enum
 *      and lastRefreshError.kind === 'auth_suspect'.
 *   2. Dead rows stay unstageable (tabindex -1, aria-disabled) while the
 *      nested Retry button stays interactive; the delegated click handler
 *      has an .account-retry-btn branch that stops propagation and runs
 *      before the delete/pencil/row branches.
 *   3. retryDeadAccount posts the EXISTING per-profile force route
 *      POST /api/credentials/refresh-usage { profileId }, is single-flight
 *      (cred.retryingId), applies the returned list, and always clears the
 *      in-flight flag in finally.
 *   4. styles.css defines .account-retry-btn and .account-warn-note from
 *      theme tokens only (no hardcoded hex).
 *   5. server.js starts the proactive sweep interval next to
 *      startCredentialWatcher, guards it on proactiveRefreshMinutes,
 *      clamps to PROACTIVE_REFRESH_FLOOR_MIN, unrefs the timer, and clears
 *      it in the shutdown cleanup.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');

let passed = 0;
let failed = 0;

/**
 * Minimal check harness: runs fn, records pass/fail, prints result.
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (throws to fail).
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + ((err && err.message) || err));
  }
}

/** Assert a condition. @param {*} cond @param {string} msg */
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

/**
 * Brace-extract one method body from the CWMApp class source by name.
 * Finds the method at class-body indentation and scans forward matching
 * braces so the whole body is returned. Throws when missing (that IS the
 * test). Handles optional async prefix.
 * @param {string} name - Method name to extract.
 * @returns {string} The full method source text.
 */
function extractMethod(name) {
  const startIdx = APP_JS.search(new RegExp('^  (?:async )?' + name + '\\(', 'm'));
  assert(startIdx !== -1, 'method ' + name + ' not found in app.js');
  const openIdx = APP_JS.indexOf('{', startIdx);
  let depth = 0;
  for (let i = openIdx; i < APP_JS.length; i++) {
    const ch = APP_JS[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return APP_JS.slice(startIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

console.log('\n  credential-expiry-ui gate');
console.log('  ' + '-'.repeat(60));

// ─── 1. Row markup: dead copy + Retry button, suspect note ────────────────

const renderRow = extractMethod('renderAccountRow');

check('dead rows use the softer copy and the old scary copy is gone', () => {
  assert(renderRow.includes('Signed out here. Run /login as this account once, or press Retry.'),
    'softer dead-row copy missing');
  assert(!renderRow.includes('needs re-login (stored token is dead)'),
    'old dead-row copy must be replaced');
});

check('dead rows render an .account-retry-btn carrying the profileId', () => {
  assert(renderRow.includes('account-retry-btn'), 'Retry button class missing');
  const btnIdx = renderRow.indexOf('account-retry-btn');
  const btnRegion = renderRow.slice(btnIdx, btnIdx + 400);
  assert(btnRegion.includes('data-profile-id='), 'Retry button must carry data-profile-id');
  assert(btnRegion.includes('aria-label='), 'Retry button must carry an aria-label');
  const beforeBtn = renderRow.slice(0, btnIdx);
  assert(beforeBtn.lastIndexOf('if (isDead)') !== -1
    && beforeBtn.lastIndexOf('if (isDead)') > beforeBtn.lastIndexOf('} else'),
    'the Retry button must render inside the isDead branch only');
});

check('Retry button disables while its round trip is in flight (retryingId)', () => {
  assert(renderRow.includes('retryingId'), 'renderAccountRow must consult cred.retryingId');
  assert(renderRow.includes("'Retrying'") || renderRow.includes('Retrying'),
    'in-flight button must read Retrying');
});

check('suspect note is keyed off health AND lastRefreshError.kind auth_suspect', () => {
  assert(renderRow.includes('Temporary auth issue, retrying'), 'suspect copy missing');
  assert(renderRow.includes("lastRefreshError.kind === 'auth_suspect'"),
    'suspect note must key off lastRefreshError.kind (unverified rows are also needs-attention)');
  assert(renderRow.includes('isWarn'), 'suspect note must also require the amber health state');
  assert(renderRow.includes('account-warn-note'), 'suspect note class missing');
});

check('dead rows stay unstageable: tabindex -1 and aria-disabled', () => {
  assert(renderRow.includes("tabindex=\"${isDead ? '-1' : '0'}\""), 'dead rows must drop out of tab order');
  assert(renderRow.includes("aria-disabled=\"true\""), 'dead rows must carry aria-disabled');
});

check('stageAccount and stageMacAccount still refuse needs-re-login rows', () => {
  const stage = extractMethod('stageAccount');
  const stageMac = extractMethod('stageMacAccount');
  assert(stage.includes("=== 'needs-re-login') return"), 'stageAccount must refuse dead rows');
  assert(stageMac.includes("=== 'needs-re-login') return"), 'stageMacAccount must refuse dead rows');
});

// ─── 2. Delegated click handler ────────────────────────────────────────────

check('list click handler has an .account-retry-btn branch that stops propagation', () => {
  const handlerIdx = APP_JS.indexOf("els.accountPanelList.addEventListener('click'");
  assert(handlerIdx !== -1, 'delegated list click handler not found');
  const handler = APP_JS.slice(handlerIdx, handlerIdx + 9000);
  const retryCallIdx = handler.indexOf('this.retryDeadAccount(');
  assert(retryCallIdx !== -1, 'retryDeadAccount call missing from the delegated handler');
  const branchStart = handler.lastIndexOf(".closest('.account-retry-btn')", retryCallIdx);
  assert(branchStart !== -1, 'the retryDeadAccount call must sit inside an .account-retry-btn branch');
  const branch = handler.slice(branchStart, retryCallIdx);
  assert(branch.includes('e.stopPropagation()'), 'retry branch must stopPropagation (never stage the row)');
});

check('retry branch runs before the delete, pencil, and whole-row branches', () => {
  const handlerIdx = APP_JS.indexOf("els.accountPanelList.addEventListener('click'");
  const handler = APP_JS.slice(handlerIdx, handlerIdx + 9000);
  const retryCallIdx = handler.indexOf('this.retryDeadAccount(');
  const delCallIdx = handler.indexOf('this.deleteSavedAccount(');
  const stageCallIdx = handler.indexOf('this.stageAccount(');
  assert(retryCallIdx !== -1 && delCallIdx !== -1 && stageCallIdx !== -1, 'all three branches must exist');
  assert(retryCallIdx < delCallIdx, 'retry branch must be checked before the delete branch');
  assert(retryCallIdx < stageCallIdx, 'retry branch must be checked before whole-row staging');
});

// ─── 3. retryDeadAccount behavior ──────────────────────────────────────────

const retryMethod = extractMethod('retryDeadAccount');

check('retryDeadAccount posts the EXISTING per-profile force route', () => {
  assert(retryMethod.includes("_credApi('POST', '/api/credentials/refresh-usage', { profileId })"),
    'must POST /api/credentials/refresh-usage with { profileId } (the force route)');
});

check('retryDeadAccount is single-flight and always clears the in-flight flag', () => {
  assert(retryMethod.includes('cred.retryingId) return'), 'must refuse a second concurrent retry');
  assert(retryMethod.includes('cred.retryingId = profileId'), 'must mark the row in flight');
  const finallyIdx = retryMethod.indexOf('finally');
  assert(finallyIdx !== -1, 'must have a finally block');
  const finallyBlock = retryMethod.slice(finallyIdx);
  assert(finallyBlock.includes('cred.retryingId = null'), 'finally must clear the in-flight flag');
});

check('retryDeadAccount applies the returned list and reports both outcomes honestly', () => {
  assert(retryMethod.includes('_applyCredListResponse'), 'must apply the canonical list response');
  assert(retryMethod.includes("!== 'needs-re-login'"), 'must detect recovery from the fresh row health');
  assert(retryMethod.includes('Still signed out'), 'the stayed-dead outcome must say so');
});

// ─── 4. CSS ────────────────────────────────────────────────────────────────

check('styles.css defines .account-retry-btn from theme tokens only', () => {
  const idx = STYLES_CSS.indexOf('.account-retry-btn {');
  assert(idx !== -1, '.account-retry-btn rule missing from styles.css');
  const rule = STYLES_CSS.slice(idx, STYLES_CSS.indexOf('}', idx));
  assert(rule.includes('var(--'), 'retry button must use theme tokens');
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(rule), 'no hardcoded hex in the retry-button rule (theme tokens only)');
});

check('styles.css defines .account-warn-note with the needs-attention yellow', () => {
  const idx = STYLES_CSS.indexOf('.account-warn-note {');
  assert(idx !== -1, '.account-warn-note rule missing from styles.css');
  const rule = STYLES_CSS.slice(idx, STYLES_CSS.indexOf('}', idx));
  assert(rule.includes('var(--yellow)'), 'suspect note must reuse the needs-attention yellow token');
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(rule), 'no hardcoded hex in the warn-note rule (theme tokens only)');
});

// ─── 5. server.js proactive sweep wiring ───────────────────────────────────

check('server.js starts a guarded proactive sweep interval next to the credential watcher', () => {
  const watcherIdx = SERVER_JS.indexOf('credentialManager.startCredentialWatcher()');
  assert(watcherIdx !== -1, 'startCredentialWatcher call not found');
  const region = SERVER_JS.slice(watcherIdx, watcherIdx + 4000);
  assert(region.includes('proactiveRefreshSweep'), 'proactiveRefreshSweep interval must sit next to the watcher start');
  assert(region.includes('proactiveRefreshMinutes'), 'interval must be guarded on proactiveRefreshMinutes');
  assert(region.includes('PROACTIVE_REFRESH_FLOOR_MIN'), 'interval must clamp to the named floor');
  assert(region.includes('credProactiveTimer.unref'), 'interval must unref so it never holds the process open');
});

check('server.js imports the floor constant and clears the timer in cleanup', () => {
  assert(/require\('\.\/credential-manager'\)/.test(SERVER_JS), 'credential-manager require missing');
  assert(SERVER_JS.includes('PROACTIVE_REFRESH_FLOOR_MIN } = require(\'./credential-manager\')')
    || /\{[^}]*PROACTIVE_REFRESH_FLOOR_MIN[^}]*\}\s*=\s*require\('\.\/credential-manager'\)/.test(SERVER_JS),
    'PROACTIVE_REFRESH_FLOOR_MIN must come from credential-manager (named constant, not a magic number)');
  const cleanupIdx = SERVER_JS.indexOf('const cleanup = () => {');
  assert(cleanupIdx !== -1, 'cleanup function not found');
  const cleanupBlock = SERVER_JS.slice(cleanupIdx, cleanupIdx + 1500);
  assert(cleanupBlock.includes('clearInterval(credProactiveTimer)'),
    'cleanup must clear the proactive sweep interval');
});

check('server.js documents the accepted lineage risk in a WHY comment', () => {
  assert(SERVER_JS.includes('ACCEPTED RISK'), 'the accepted-risk WHY comment must exist');
  const idx = SERVER_JS.indexOf('ACCEPTED RISK');
  const region = SERVER_JS.slice(Math.max(0, idx - 2000), idx + 1200);
  assert(region.includes('logged out') || region.includes('logs out'),
    'the risk comment must name the CLI-logout consequence');
});

// ─── Results ───────────────────────────────────────────────────────────────

console.log('  ' + '-'.repeat(60));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
