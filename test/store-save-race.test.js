/**
 * Store persistence regression: critical writes survive pending debounced saves.
 * Uses one sandboxed Store to verify the on-disk session data, dirty state and
 * error events, so an older background snapshot cannot hide a lost write.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';
require('./_test-data-dir');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStore } = require('../src/state/store');

const SAVE_RACE_REPETITIONS = 20;
const DEBOUNCE_SETTLE_MS = 400;

/** Exercise real persistence and report a failing assertion as a nonzero exit. */
async function main() {
  const store = getStore();
  const errors = [];
  store.on('error', (error) => errors.push(error));
  const stateFile = path.join(process.env.CWM_DATA_DIR, 'workspaces.json');

  for (let i = 0; i < SAVE_RACE_REPETITIONS; i++) {
    const workspace = store.createWorkspace({ name: 'save-race-' + i });
    store._debouncedSave();
    const session = store.createSession({
      name: 'critical-' + i,
      workspaceId: workspace.id,
      workingDir: os.tmpdir(),
      command: 'claude', // gsd:provider-literal-allowed (test fixture)
    });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SETTLE_MS));
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(saved.sessions[session.id], 'critical session survives iteration ' + i);
    assert.strictEqual(store._dirty, false, 'saved state is clean at iteration ' + i);
    assert.deepStrictEqual(errors, [], 'no persistence errors at iteration ' + i);
  }
  console.log('PASS critical sessions survive pending saves in 20 repetitions');

  store.createWorkspace({ name: 'save-cancels-debounce' });
  store._dirty = true;
  store._debouncedSave();
  store.save();
  assert.strictEqual(store._saveTimer, null, 'the whole-state save cancels its redundant timer');
  assert.deepStrictEqual(errors, [], 'no persistence errors');
  console.log('PASS a synchronous save clears the pending debounce timer');
  store.destroy();
  console.log('passed 2/2');
}

main().catch((error) => {
  console.error('FAIL ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
