#!/usr/bin/env node
/**
 * Delete-saved-account UI gate (account switcher).
 *
 * Source-scan gate mirroring test/usage-meter.test.js: no jsdom, no
 * browser. The backend DELETE /api/credentials/:profileId route already
 * existed (snapshot-only, never touches the live login); this suite locks
 * the FRONTEND wiring that exposes it:
 *
 *   1. renderAccountRow emits a trash button with the .account-delete-btn
 *      class, reusing the pencil's .account-row-edit base class, carrying
 *      the profileId and an aria-label, and NEVER on the ACTIVE row (the
 *      credential watcher re-captures the live login within ~1s, so
 *      deleting the active snapshot would be a confusing no-op).
 *   2. The delegated #account-panel-list click handler has an
 *      .account-delete-btn branch that runs BEFORE the pencil branch and
 *      calls e.stopPropagation() so a delete click can never stage the row.
 *   3. deleteSavedAccount exists, re-checks the active-row guard, confirms
 *      through showConfirmModal with the destructive button class, issues
 *      DELETE /api/credentials/<id>, treats 404 as success, and clears a
 *      stale staged selection pointing at the deleted row.
 *   4. styles.css defines the .account-delete-btn hover rule using theme
 *      tokens only (red tint for the destructive action).
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

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

console.log('\n  credential-delete-ui gate');
console.log('  ' + '-'.repeat(60));

// ─── 1. Row markup ─────────────────────────────────────────────────────────

const renderRow = extractMethod('renderAccountRow');

check('renderAccountRow emits an .account-delete-btn trash button', () => {
  assert(renderRow.includes('account-delete-btn'), 'delete button class missing from renderAccountRow');
  assert(/account-row-edit account-delete-btn/.test(renderRow),
    'delete button must reuse the pencil base class (account-row-edit) plus account-delete-btn');
  assert(renderRow.includes('type="button"'), 'delete button must be type=button');
});

check('delete button carries the profileId and an aria-label', () => {
  const btnIdx = renderRow.indexOf('account-delete-btn');
  const btnRegion = renderRow.slice(btnIdx, btnIdx + 400);
  assert(btnRegion.includes('data-profile-id='), 'delete button must carry data-profile-id');
  assert(btnRegion.includes('aria-label="Delete saved account'), 'delete button aria-label missing');
});

check('delete button uses an inline SVG icon (no emoji)', () => {
  const btnIdx = renderRow.indexOf('account-delete-btn');
  const btnRegion = renderRow.slice(btnIdx, renderRow.indexOf('</button>', btnIdx));
  assert(btnRegion.includes('<svg'), 'delete button must use an inline SVG icon');
  assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btnRegion), 'no emoji in the delete button');
});

check('ACTIVE row never renders the delete button (render-time guard)', () => {
  // The button push must be gated on the row NOT being active.
  const guardIdx = renderRow.indexOf('if (!isActive) {');
  assert(guardIdx !== -1, 'render-time !isActive guard missing');
  const guarded = renderRow.slice(guardIdx, renderRow.indexOf('}', renderRow.indexOf('account-delete-btn', guardIdx)));
  assert(guarded.includes('account-delete-btn'), 'the delete button push must sit inside the !isActive guard');
});

// ─── 2. Delegated click handler ────────────────────────────────────────────

check('list click handler has an .account-delete-btn branch that stops propagation', () => {
  const handlerIdx = APP_JS.indexOf("els.accountPanelList.addEventListener('click'");
  assert(handlerIdx !== -1, 'delegated list click handler not found');
  const handler = APP_JS.slice(handlerIdx, handlerIdx + 8000);
  // Anchor on the LEGACY branch (the one calling deleteSavedAccount): a
  // provider-row branch may also match .account-delete-btn above it.
  const delCallIdx = handler.indexOf('this.deleteSavedAccount(');
  assert(delCallIdx !== -1, 'deleteSavedAccount call missing from the delegated handler');
  const branchStart = handler.lastIndexOf(".closest('.account-delete-btn')", delCallIdx);
  assert(branchStart !== -1, 'the deleteSavedAccount call must sit inside an .account-delete-btn branch');
  const branch = handler.slice(branchStart, delCallIdx);
  assert(branch.includes('e.stopPropagation()'), 'delete branch must stopPropagation (never stage the row)');
});

check('delete branch runs BEFORE the pencil branch (shared base class)', () => {
  const handlerIdx = APP_JS.indexOf("els.accountPanelList.addEventListener('click'");
  const handler = APP_JS.slice(handlerIdx, handlerIdx + 8000);
  // Anchor both branches by their action calls so provider-row branches
  // (which also use these selectors) cannot confuse the ordering check.
  const delCallIdx = handler.indexOf('this.deleteSavedAccount(');
  const renameCallIdx = handler.indexOf('this.renameAccount(');
  assert(delCallIdx !== -1 && renameCallIdx !== -1, 'both legacy branches must exist');
  const delBranchIdx = handler.lastIndexOf(".closest('.account-delete-btn')", delCallIdx);
  const editBranchIdx = handler.lastIndexOf(".closest('.account-row-edit')", renameCallIdx);
  assert(delBranchIdx !== -1 && editBranchIdx !== -1, 'both branch selectors must exist');
  assert(delBranchIdx < editBranchIdx,
    'the .account-delete-btn branch must be checked before .account-row-edit or the pencil branch swallows it');
});

// ─── 3. deleteSavedAccount behavior ────────────────────────────────────────

const delMethod = extractMethod('deleteSavedAccount');

check('deleteSavedAccount issues DELETE /api/credentials/:profileId', () => {
  assert(delMethod.includes("_credApi('DELETE'"), 'must call _credApi with DELETE');
  assert(delMethod.includes('/api/credentials/'), 'must target the credentials route');
  assert(delMethod.includes('encodeURIComponent(profileId)'), 'profileId must be URI-encoded');
});

check('deleteSavedAccount re-checks the active-row guard', () => {
  assert(delMethod.includes('cred.activeId'), 'active-row guard missing from deleteSavedAccount');
  const guardIdx = delMethod.indexOf('cred.activeId');
  const before = delMethod.slice(0, delMethod.indexOf("_credApi('DELETE'"));
  assert(before.includes('cred.activeId'), 'active guard must run BEFORE the DELETE request');
  assert(guardIdx !== -1, 'guard present');
});

check('deleteSavedAccount confirms via showConfirmModal with destructive styling', () => {
  assert(delMethod.includes('showConfirmModal'), 'must confirm before deleting');
  assert(delMethod.includes('btn-danger'), 'confirm button must use the destructive class');
  assert(delMethod.includes('does not log the account out'),
    'confirm copy must state the account is NOT logged out');
});

check('deleteSavedAccount treats 404 as success and clears stale staging', () => {
  assert(delMethod.includes('resp.status !== 404'), '404 (already gone) must not surface as an error');
  assert(delMethod.includes('cred.stagedId === profileId') || delMethod.includes('stagedId = null'),
    'a staged selection pointing at the deleted row must be cleared');
});

check('deleteSavedAccount arms the SSE self-echo window', () => {
  assert(delMethod.includes('_credSelfActionUntil'), 'must arm _credSelfActionUntil like rename/capture/apply');
});

// ─── 4. CSS ────────────────────────────────────────────────────────────────

check('styles.css defines the .account-delete-btn hover rule with theme tokens', () => {
  const idx = STYLES_CSS.indexOf('.account-row-edit.account-delete-btn:hover');
  assert(idx !== -1, '.account-delete-btn hover rule missing from styles.css');
  const rule = STYLES_CSS.slice(idx, STYLES_CSS.indexOf('}', idx));
  assert(rule.includes('var(--red)'), 'destructive hover must tint toward var(--red)');
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(rule), 'no hardcoded hex in the delete-button rule (theme tokens only)');
});

// ─── Results ───────────────────────────────────────────────────────────────

console.log('  ' + '-'.repeat(60));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
