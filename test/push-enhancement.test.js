#!/usr/bin/env node
/**
 * Integration tests for push notification retry, batching, and preference filtering.
 *
 * Tests the three core push enhancement behaviors:
 *   1. Retry with exponential backoff on transient failures
 *   2. Batch coalescing of multiple events into summary notifications
 *   3. Per-device preference filtering (skip disabled categories)
 *
 * Mocks global.fetch to intercept Expo Push API calls (no real network).
 * Mocks setTimeout to eliminate sleep delays (tests run in <1 second).
 *
 * Usage: node --test test/push-enhancement.test.js
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

// ---- Helpers ---------------------------------------------------------------

/**
 * Load a fresh copy of push.js by clearing the require cache.
 * The module has internal state (pushQueue, flushTimer) that must be
 * reset between test groups.
 *
 * @returns {Object} Fresh push module exports
 */
function freshPush() {
  const modPath = require.resolve('../src/web/push.js');
  delete require.cache[modPath];
  return require('../src/web/push.js');
}

/**
 * Create a mock store with configurable paired devices.
 * Tracks calls to updatePairedDevice for assertion.
 *
 * @param {Array} devices - Array of device objects with pushToken, deviceId, etc.
 * @returns {Object} Mock store
 */
function createMockStore(devices = []) {
  const updateCalls = [];
  return {
    state: {
      sessions: {
        's1': { status: 'running' },
        's2': { status: 'stopped' },
      },
    },
    getPairedDevices: () => devices,
    findDeviceByToken: (token) => devices.find(d => d.pushToken === token) || null,
    updatePairedDevice: (deviceId, updates) => {
      updateCalls.push({ deviceId, updates });
      // Apply the update to the device in-place for subsequent lookups
      const dev = devices.find(d => d.deviceId === deviceId);
      if (dev) Object.assign(dev, updates);
    },
    removePushDevice: () => {},
    on: () => {},
    emit: () => {},
    _updateCalls: updateCalls,
  };
}

/**
 * Create a mock fetch function that records calls and returns
 * configurable responses.
 *
 * @param {Array} responses - Array of response configs in order.
 *   Each is either { ok: true, data: [...] }, { ok: false, status: N },
 *   or { throw: true } to simulate a network error.
 * @returns {{ fn: Function, calls: Array }}
 */
function createMockFetch(responses) {
  const calls = [];
  let idx = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    const config = responses[Math.min(idx, responses.length - 1)];
    idx++;
    if (config.throw) {
      throw new Error('Network error');
    }
    return {
      ok: config.ok !== false,
      status: config.status || (config.ok !== false ? 200 : 500),
      json: async () => config.data || { data: [{ status: 'ok', id: 'ticket-1' }] },
    };
  };
  return { fn, calls };
}

// ---- Test Suite ------------------------------------------------------------

describe('Push Enhancement: Retry Logic', () => {
  let originalFetch;
  let originalSetTimeout;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalSetTimeout = global.setTimeout;
    // Make sleep() resolve immediately so retry tests are fast
    global.setTimeout = (fn, _ms) => {
      fn();
      return 0;
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });

  it('retries on transient failure and succeeds on 2nd attempt', async () => {
    const push = freshPush();
    const store = createMockStore([
      { deviceId: 'd1', pushToken: 'ExponentPushToken[abc]', deviceName: 'Phone' },
    ]);

    const { fn, calls } = createMockFetch([
      { throw: true },
      { ok: true, data: { data: [{ status: 'ok', id: 'ticket-ok' }] } },
    ]);
    global.fetch = fn;

    const results = await push.sendPush(store, {
      title: 'Test',
      body: 'Hello',
    });

    assert.equal(calls.length, 2, 'fetch should be called exactly twice');
    assert.equal(results.length, 1);
    assert.equal(results[0].sent, true, 'should succeed on 2nd attempt');
  });

  it('gives up after max retries', async () => {
    const push = freshPush();
    const store = createMockStore([
      { deviceId: 'd1', pushToken: 'ExponentPushToken[abc]', deviceName: 'Phone' },
    ]);

    const { fn, calls } = createMockFetch([
      { throw: true },
      { throw: true },
      { throw: true },
    ]);
    global.fetch = fn;

    const results = await push.sendPush(store, {
      title: 'Test',
      body: 'Hello',
    });

    assert.equal(calls.length, 3, 'fetch should be called exactly 3 times');
    assert.equal(results.length, 1);
    assert.equal(results[0].sent, false, 'should give up after max retries');
    assert.equal(results[0].reason, 'max_retries');
  });

  it('clears stale pushToken on DeviceNotRegistered', async () => {
    const push = freshPush();
    const store = createMockStore([
      { deviceId: 'd1', pushToken: 'ExponentPushToken[stale]', deviceName: 'Old Phone' },
    ]);

    const { fn } = createMockFetch([
      {
        ok: true,
        data: {
          data: [{
            status: 'error',
            details: { error: 'DeviceNotRegistered' },
          }],
        },
      },
    ]);
    global.fetch = fn;

    const results = await push.sendPush(store, {
      title: 'Test',
      body: 'Hello',
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].sent, false);
    assert.equal(results[0].reason, 'unregistered');
    assert.equal(store._updateCalls.length, 1, 'should call updatePairedDevice');
    assert.equal(store._updateCalls[0].deviceId, 'd1');
    assert.equal(store._updateCalls[0].updates.pushToken, null, 'should clear pushToken');
  });
});

describe('Push Enhancement: Batching', () => {
  let originalFetch;
  let originalSetTimeout;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalSetTimeout = global.setTimeout;
    // Capture setTimeout calls but do not auto-fire (we call flushPushQueue manually)
    global.setTimeout = (fn, ms) => {
      return originalSetTimeout(fn, ms);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });

  it('single event sends full notification (not summary)', async () => {
    const push = freshPush();
    const store = createMockStore([
      { deviceId: 'd1', pushToken: 'ExponentPushToken[batch1]', deviceName: 'Phone' },
    ]);

    const { fn, calls } = createMockFetch([
      { ok: true, data: { data: [{ status: 'ok' }] } },
    ]);
    global.fetch = fn;

    push.queuePush(store, {
      type: 'session:complete',
      title: 'Session completed',
      body: 'my-session has finished',
    });

    // Manually flush instead of waiting for timer
    push.flushPushQueue(store);

    // Give the async sendPushWithRetry a tick to complete
    await new Promise(r => originalSetTimeout(r, 50));

    assert.equal(calls.length, 1, 'fetch should be called once');
    const sent = calls[0].body;
    assert.equal(sent[0].title, 'Session completed', 'should use original title');
    assert.equal(sent[0].body, 'my-session has finished', 'should use original body');
  });

  it('multiple events send summary notification with count', async () => {
    const push = freshPush();
    const store = createMockStore([
      { deviceId: 'd1', pushToken: 'ExponentPushToken[batch2]', deviceName: 'Phone' },
    ]);

    const { fn, calls } = createMockFetch([
      { ok: true, data: { data: [{ status: 'ok' }] } },
    ]);
    global.fetch = fn;

    // Queue 3 events
    push.queuePush(store, { type: 'session:complete', title: 'Session completed', body: 'a' });
    push.queuePush(store, { type: 'session:complete', title: 'Session completed', body: 'b' });
    push.queuePush(store, { type: 'session:needs-input', title: 'Input needed', body: 'c' });

    push.flushPushQueue(store);
    await new Promise(r => originalSetTimeout(r, 50));

    assert.equal(calls.length, 1, 'fetch should be called once for the batch');
    const sent = calls[0].body;
    assert.ok(sent[0].title.includes('3'), 'summary title should contain event count');
    assert.ok(sent[0].title.toLowerCase().includes('updates'), 'summary title should say updates');
  });
});

describe('Push Enhancement: Preference Filtering', () => {
  let originalFetch;
  let originalSetTimeout;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => {
      return originalSetTimeout(fn, ms);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });

  it('skips device with disabled preference', async () => {
    const push = freshPush();
    const store = createMockStore([
      {
        deviceId: 'd1',
        pushToken: 'ExponentPushToken[pref1]',
        deviceName: 'Phone',
        pushPreferences: { sessionComplete: false },
      },
    ]);

    const { fn, calls } = createMockFetch([
      { ok: true, data: { data: [{ status: 'ok' }] } },
    ]);
    global.fetch = fn;

    push.queuePush(store, {
      type: 'session:complete',
      title: 'Session completed',
      body: 'test',
    });

    push.flushPushQueue(store);
    await new Promise(r => originalSetTimeout(r, 50));

    assert.equal(calls.length, 0, 'fetch should NOT be called for disabled preference');
  });

  it('sends to device with enabled preference', async () => {
    const push = freshPush();
    const store = createMockStore([
      {
        deviceId: 'd1',
        pushToken: 'ExponentPushToken[pref2]',
        deviceName: 'Phone',
        pushPreferences: { sessionComplete: true },
      },
    ]);

    const { fn, calls } = createMockFetch([
      { ok: true, data: { data: [{ status: 'ok' }] } },
    ]);
    global.fetch = fn;

    push.queuePush(store, {
      type: 'session:complete',
      title: 'Session completed',
      body: 'test',
    });

    push.flushPushQueue(store);
    await new Promise(r => originalSetTimeout(r, 50));

    assert.equal(calls.length, 1, 'fetch should be called for enabled preference');
  });

  it('defaults to true for unknown event types', async () => {
    const push = freshPush();
    const store = createMockStore([
      {
        deviceId: 'd1',
        pushToken: 'ExponentPushToken[pref3]',
        deviceName: 'Phone',
        pushPreferences: { sessionComplete: true },
      },
    ]);

    const { fn, calls } = createMockFetch([
      { ok: true, data: { data: [{ status: 'ok' }] } },
    ]);
    global.fetch = fn;

    push.queuePush(store, {
      type: 'custom:unknown-event',
      title: 'Custom event',
      body: 'test',
    });

    push.flushPushQueue(store);
    await new Promise(r => originalSetTimeout(r, 50));

    assert.equal(calls.length, 1, 'fetch should be called for unknown event type (defaults to true)');
  });
});
