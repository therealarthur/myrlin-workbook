#!/usr/bin/env node
/**
 * Pure unit coverage for the focused-experience presentation model.
 *
 * This test deliberately requires no DOM, server, profile, or browser. The
 * model is shared by the pre-paint bootstrap and the live app, so its values
 * must remain deterministic and safe to consume from either environment.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const modelPath = path.join(PUBLIC, 'experience-model.js');
const registryPath = path.join(PUBLIC, 'theme-registry.js');
const modelSource = fs.readFileSync(modelPath, 'utf8');
const model = require(modelPath);
const themeRegistry = require(registryPath);

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (error) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${error && error.message ? error.message : String(error)}`);
  }
}

console.log('\n  \x1b[1mFocused experience model\x1b[0m');
console.log('  ' + '-'.repeat(48));

check('exports a frozen, side-effect-free public API', () => {
  assert.ok(Object.isFrozen(model));
  assert.deepStrictEqual(
    Object.keys(model).sort(),
    [
      'ATTENTION_STATES',
      'DENSITY_CHOICES',
      'DENSITY_IDS',
      'buildAttentionQueue',
      'groupThemes',
      'normalizeAttentionState',
      'normalizeDensity',
      'statusToAttentionState',
    ].sort()
  );
  assert.strictEqual(global.MyrlinExperienceModel, undefined);
});

check('declares exactly Quiet and Informative density choices', () => {
  assert.deepStrictEqual(model.DENSITY_IDS, ['quiet', 'informative']);
  assert.deepStrictEqual(
    model.DENSITY_CHOICES.map(choice => ({
      id: choice.id,
      label: choice.label,
      description: choice.description,
    })),
    [
      {
        id: 'quiet',
        label: 'Quiet',
        description: 'Keep supporting detail out of the way until it matters.',
      },
      {
        id: 'informative',
        label: 'Informative',
        description: 'Show more status and context while you work.',
      },
    ]
  );
  assert.ok(Object.isFrozen(model.DENSITY_IDS));
  assert.ok(Object.isFrozen(model.DENSITY_CHOICES));
  model.DENSITY_CHOICES.forEach(choice => assert.ok(Object.isFrozen(choice)));
});

check('normalizes unknown, empty, and non-string density values to Quiet', () => {
  assert.strictEqual(model.normalizeDensity('quiet'), 'quiet');
  assert.strictEqual(model.normalizeDensity('informative'), 'informative');
  for (const value of [undefined, null, '', 'classic', 'QUIET', 1, {}, []]) {
    assert.strictEqual(model.normalizeDensity(value), 'quiet');
  }
});

check('defines the five attention states with stable priority and actionability', () => {
  assert.ok(Object.isFrozen(model.ATTENTION_STATES));
  assert.deepStrictEqual(
    Object.values(model.ATTENTION_STATES).map(state => ({
      id: state.id,
      label: state.label,
      priority: state.priority,
      actionable: state.actionable,
    })),
    [
      { id: 'needs-input', label: 'Needs input', priority: 0, actionable: true },
      { id: 'failed', label: 'Failed', priority: 1, actionable: true },
      { id: 'complete', label: 'Complete', priority: 2, actionable: true },
      { id: 'stale', label: 'Stale', priority: 3, actionable: true },
      { id: 'running', label: 'Running', priority: 4, actionable: false },
    ]
  );
  Object.values(model.ATTENTION_STATES).forEach(state => {
    assert.ok(Object.isFrozen(state));
    assert.strictEqual(typeof state.icon, 'string');
    assert.ok(state.icon.length > 0);
  });
});

check('normalizes attention state IDs without inventing an unknown state', () => {
  for (const state of Object.keys(model.ATTENTION_STATES)) {
    assert.strictEqual(model.normalizeAttentionState(state), state);
  }
  for (const value of [undefined, null, '', 'stopped', 'NEEDS-INPUT', 0, {}]) {
    assert.strictEqual(model.normalizeAttentionState(value), null);
  }
});

check('maps provider-neutral session status synonyms to attention states', () => {
  const cases = {
    failed: ['error', 'crashed', 'failed', 'rejected', 'ERROR'],
    stale: ['stale', 'disconnected'],
    complete: ['complete', 'completed', 'merged', 'done'],
    running: ['running', 'active', 'idle', 'planning'],
  };
  for (const [expected, statuses] of Object.entries(cases)) {
    for (const status of statuses) {
      assert.strictEqual(
        model.statusToAttentionState(status),
        expected,
        `${status} should map to ${expected}`
      );
    }
  }
  for (const status of [undefined, null, '', 'stopped', 'archived', 'queued']) {
    assert.strictEqual(model.statusToAttentionState(status), null);
  }
});

check('buildAttentionQueue lets live pane state override the server roster', () => {
  const queue = model.buildAttentionQueue(
    [{
      sessionId: 'session-a',
      state: 'needs-input',
      slot: 3,
    }],
    [{
      id: 'session-a',
      name: 'Server name',
      provider: 'codex',
      status: 'running',
    }]
  );
  assert.deepStrictEqual(queue, [{
    sessionId: 'session-a',
    sessionName: 'Server name',
    provider: 'codex',
    slot: 3,
    state: 'needs-input',
    label: 'Needs input',
    priority: 0,
    actionable: true,
    icon: model.ATTENTION_STATES['needs-input'].icon,
  }]);
});

check('buildAttentionQueue preserves pane metadata and uses safe fallbacks', () => {
  const queue = model.buildAttentionQueue([
    {
      sessionId: 'pane-name',
      sessionName: 'Pane name wins',
      provider: 'claude',
      slot: 1,
      state: 'running',
    },
    {
      sessionId: 'id-fallback',
      slot: 1.5,
    },
  ], []);
  assert.strictEqual(queue.length, 2);
  const paneNamed = queue.find(item => item.sessionId === 'pane-name');
  const fallback = queue.find(item => item.sessionId === 'id-fallback');
  assert.strictEqual(paneNamed.sessionName, 'Pane name wins');
  assert.strictEqual(paneNamed.provider, 'claude');
  assert.strictEqual(paneNamed.slot, 1);
  assert.strictEqual(fallback.sessionName, 'id-fallback');
  assert.strictEqual(fallback.provider, null);
  assert.strictEqual(fallback.slot, null);
  assert.strictEqual(fallback.state, 'running');
});

check('buildAttentionQueue omits history and sorts by priority then name', () => {
  const queue = model.buildAttentionQueue([], [
    { id: 'run-z', name: 'Zulu', status: 'planning' },
    { id: 'stopped', name: 'Stopped', status: 'stopped' },
    { id: 'complete', name: 'Charlie', status: 'done' },
    { id: 'failed-b', name: 'Bravo', status: 'crashed' },
    { id: 'stale', name: 'Delta', status: 'disconnected' },
    { id: 'failed-a', name: 'Alpha', status: 'error' },
    { id: 'run-a', name: 'Able', status: 'active' },
  ]);
  assert.deepStrictEqual(
    queue.map(item => `${item.state}:${item.sessionName}`),
    [
      'failed:Alpha',
      'failed:Bravo',
      'complete:Charlie',
      'stale:Delta',
      'running:Able',
      'running:Zulu',
    ]
  );
  assert.ok(!queue.some(item => item.sessionId === 'stopped'));
});

check('buildAttentionQueue honors an explicit session attention state', () => {
  const queue = model.buildAttentionQueue([], [{
    id: 'prompt',
    name: 'Waiting prompt',
    attentionState: 'needs-input',
    status: 'running',
  }]);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].state, 'needs-input');
  assert.strictEqual(queue[0].actionable, true);
});

check('buildAttentionQueue tolerates malformed collections without mutation', () => {
  assert.deepStrictEqual(model.buildAttentionQueue(), []);
  assert.deepStrictEqual(model.buildAttentionQueue({}, 'sessions'), []);

  const panes = [{ sessionId: 'safe', state: 'complete' }];
  const sessions = [{ id: 'safe', name: 'Safe', status: 'failed' }];
  const before = JSON.stringify({ panes, sessions });
  model.buildAttentionQueue(panes, sessions);
  assert.strictEqual(JSON.stringify({ panes, sessions }), before);
});

check('groupThemes returns frozen dark/light groups in registry order', () => {
  const groups = model.groupThemes(themeRegistry);
  assert.ok(Object.isFrozen(groups));
  assert.ok(Object.isFrozen(groups.dark));
  assert.ok(Object.isFrozen(groups.light));
  assert.deepStrictEqual(
    groups.dark.map(theme => theme.id),
    themeRegistry.THEME_REGISTRY
      .filter(theme => theme.appearance === 'dark')
      .map(theme => theme.id)
  );
  assert.deepStrictEqual(
    groups.light.map(theme => theme.id),
    themeRegistry.THEME_REGISTRY
      .filter(theme => theme.appearance === 'light')
      .map(theme => theme.id)
  );
  assert.strictEqual(groups.dark.length, 10);
  assert.strictEqual(groups.light.length, 3);
  assert.strictEqual(
    new Set([...groups.dark, ...groups.light].map(theme => theme.id)).size,
    13
  );
});

check('groupThemes degrades safely when registry metadata is unavailable', () => {
  for (const registry of [undefined, null, {}, { THEME_REGISTRY: 'bad' }]) {
    const groups = model.groupThemes(registry);
    assert.deepStrictEqual({ dark: [...groups.dark], light: [...groups.light] }, {
      dark: [],
      light: [],
    });
    assert.ok(Object.isFrozen(groups));
  }
});

check('plain browser loading exposes one frozen MyrlinExperienceModel global', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(modelSource, sandbox, { filename: 'experience-model.js' });
  assert.ok(sandbox.MyrlinExperienceModel);
  assert.ok(Object.isFrozen(sandbox.MyrlinExperienceModel));
  assert.deepStrictEqual(
    Array.from(sandbox.MyrlinExperienceModel.DENSITY_IDS),
    ['quiet', 'informative']
  );
});

console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
