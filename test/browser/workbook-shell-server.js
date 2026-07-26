#!/usr/bin/env node
/**
 * workbook-shell-server.js - Isolated full Workbook server for browser QA.
 * Created: 2026-07-25
 *
 * The parent test supplies sandboxed data/profile paths before this process
 * loads any Workbook modules. No real credentials, sessions, or provider
 * state are read or written.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const { getStore } = require('../../src/state/store');
const providerRegistry = require('../../src/providers');

let server = null;
let shuttingDown = false;
let store = null;

/**
 * Notify the server-side discovery cache when a sandbox provider changes.
 * @param {string} providerId - Provider whose sandbox files changed.
 */
function onProviderChange(providerId) {
  try {
    const serverModule = require('../../src/web/server');
    if (typeof serverModule.onProviderDiscoverChange === 'function') {
      serverModule.onProviderDiscoverChange(providerId);
    }
  } catch (_) {
    // Browser QA does not depend on provider discovery notifications.
  }
}

/**
 * Stop only resources owned by this child process.
 * @param {number} code - Desired process exit code.
 */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const { getPtyManager } = require('../../src/web/server');
    const ptyManager = getPtyManager();
    if (ptyManager) ptyManager.destroyAll();
  } catch (_) {}
  const finish = () => process.exit(code);
  if (server) {
    try {
      server.close(finish);
      setTimeout(finish, 2000).unref();
      return;
    } catch (_) {}
  }
  finish();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('disconnect', () => shutdown(0));
process.on('message', (message) => {
  if (message && message.type === 'shutdown') shutdown(0);
});

store = getStore();
providerRegistry.initRegistry(store, { onProviderChange }).then(() => {
  const { startServer } = require('../../src/web/server');
  const { generateStartupToken } = require('../../src/web/auth');
  server = startServer(0, '127.0.0.1');
  server.once('listening', () => {
    const address = server.address();
    const token = generateStartupToken();
    if (typeof process.send !== 'function') {
      process.stderr.write('Workbook browser harness requires an IPC parent\n');
      shutdown(1);
      return;
    }
    process.send({
      type: 'ready',
      url: 'http://127.0.0.1:' + address.port +
        '/?token=' + encodeURIComponent(token),
    });
  });
}).catch((error) => {
  process.stderr.write('Workbook shell boot failed: ' + error.message + '\n');
  shutdown(1);
});
