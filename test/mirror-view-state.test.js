#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'web', 'public', 'mirror-view.js'),
  'utf8'
);
const sandbox = {
  window: {},
  document: {},
  console,
  Number,
  Math,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(
  source + '\nthis.__MirrorPaneView = MirrorPaneView;',
  sandbox,
  { filename: 'mirror-view.js' }
);
const MirrorPaneView = sandbox.__MirrorPaneView;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.stack ? err.stack : String(err)));
  }
}

(async () => {
  console.log('\n  Mirror pane reading-position lifecycle');
  console.log('  ' + '-'.repeat(58));

  await check('descriptor records a scrolled-up reading position', () => {
    const view = Object.create(MirrorPaneView.prototype);
    view.provider = 'provider';
    view.providerSessionId = 'session';
    view.title = 'Read me';
    view._elMessages = {
      scrollHeight: 1200,
      scrollTop: 175,
      clientHeight: 300,
    };

    const descriptor = view.descriptor();
    assert.strictEqual(descriptor.scrollState.pinnedToBottom, false);
    assert.strictEqual(descriptor.scrollState.scrollTop, 175);
  });

  await check('initial reopen restores saved scroll instead of jumping to tail', async () => {
    const view = Object.create(MirrorPaneView.prototype);
    view._disposed = false;
    view._openedOnce = false;
    view._restoreScrollState = { pinnedToBottom: false, scrollTop: 210 };
    view._renderSkeleton = () => {};
    view._api = async () => ({
      endOffset: 20,
      startOffset: 0,
      truncatedHead: false,
      live: true,
      history: [{ role: 'user', kind: 'text', text: 'history' }],
    });
    view._setLive = () => {};
    view._renderMessagesHtml = () => '<div>history</div>';
    view._updateLoadEarlier = () => {};
    view._elMessages = {
      innerHTML: '',
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 300,
    };

    await view.open();
    assert.strictEqual(view._elMessages.scrollTop, 210);
    assert.strictEqual(view._restoreScrollState, null);
  });

  await check('pinned mirrors still reopen at the live tail', () => {
    const view = Object.create(MirrorPaneView.prototype);
    view._elMessages = {
      scrollHeight: 900,
      scrollTop: 0,
      clientHeight: 300,
    };
    view._restoreScrollPosition({ pinnedToBottom: true, scrollTop: 12 });
    assert.strictEqual(view._elMessages.scrollTop, 900);
  });

  console.log('  ' + '-'.repeat(58));
  console.log(`  [mirror-view-state] ${passed}/${passed + failed} tests passed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
