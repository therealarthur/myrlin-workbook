#!/usr/bin/env node
/**
 * Terminal host ownership regression.
 *
 * Fixed grid slots are reused by drag/reorder and terminal-tab caching. The
 * xterm DOM, selection, and WebSocket belong to a TerminalPane, while Select
 * controls, capture listeners, and resize observation belong to the current
 * fixed host. This test executes the production TerminalPane/CWMApp methods in
 * a deterministic VM DOM so those two ownership domains cannot drift apart.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const terminalSource = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const appSource = fs.readFileSync(APP_JS_PATH, 'utf8');

let passed = 0;
let failed = 0;
const pendingChecks = [];

function pass(name) {
  passed++;
  console.log('  \x1b[32mPASS\x1b[0m ' + name);
}

function fail(name, err) {
  failed++;
  console.log('  \x1b[31mFAIL\x1b[0m ' + name);
  console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n       ') : String(err)));
}

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingChecks.push(Promise.resolve(result).then(
        () => pass(name),
        err => fail(name, err)
      ));
    } else {
      pass(name);
    }
  } catch (err) {
    fail(name, err);
  }
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set();
  }

  replaceFromString(value) {
    this.names = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.names.add(name);
    this.owner._className = [...this.names].join(' ');
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
    this.owner._className = [...this.names].join(' ');
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.names.has(name) : !!force;
    if (shouldAdd) this.add(name);
    else this.remove(name);
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName = 'div', options = {}) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.id = options.id || '';
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.blurCalls = 0;
    this.focusCalls = 0;
    this.attributes = new Map();
    this.listeners = new Map();
    this._innerHTML = '';
    this._className = '';
    this.classList = new FakeClassList(this);
    this.className = options.className || '';
  }

  set className(value) {
    this._className = String(value || '');
    if (this.classList) this.classList.replaceFromString(this._className);
  }

  get className() {
    return this._className;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    if (this._innerHTML === '') this.replaceChildren();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get childNodes() {
    return this.children;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    if (child && child.nodeType === 11) {
      while (child.firstChild) this.appendChild(child.firstChild);
      return child;
    }
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    return child;
  }

  insertBefore(child, before) {
    if (!before || !this.children.includes(before)) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(before);
    this.children.splice(index, 0, child);
    child.parentNode = this;
    child.parentElement = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  replaceChildren(...children) {
    for (const child of [...this.children]) this.removeChild(child);
    for (const child of children) this.appendChild(child);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains && child.contains(node));
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches && child.matches(selector)) return child;
      const nested = child.querySelector && child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (child.matches && child.matches(selector)) matches.push(child);
      if (child.querySelectorAll) matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  count(selector) {
    let total = 0;
    for (const child of this.children) {
      if (child.matches && child.matches(selector)) total++;
      if (child.count) total += child.count(selector);
    }
    return total;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete this.dataset[key];
    }
  }

  addEventListener(type, handler, options) {
    const capture = options === true || !!(options && options.capture);
    const key = `${type}:${capture ? 'capture' : 'bubble'}`;
    const handlers = this.listeners.get(key) || [];
    if (!handlers.includes(handler)) handlers.push(handler);
    this.listeners.set(key, handlers);
  }

  removeEventListener(type, handler, options) {
    const capture = options === true || !!(options && options.capture);
    const key = `${type}:${capture ? 'capture' : 'bubble'}`;
    const handlers = (this.listeners.get(key) || []).filter(candidate => candidate !== handler);
    this.listeners.set(key, handlers);
  }

  listenerCount(type, capture = true) {
    return (this.listeners.get(`${type}:${capture ? 'capture' : 'bubble'}`) || []).length;
  }

  dispatchEvent() {
    return true;
  }

  blur() {
    this.blurCalls++;
  }

  focus() {
    this.focusCalls++;
  }
}

class FakeFragment extends FakeElement {
  constructor() {
    super('fragment');
    this.nodeType = 11;
    this.tagName = '';
  }
}

class FakeDocument {
  constructor() {
    this.nodesById = new Map();
    this.documentElement = new FakeElement('html');
    this.documentElement.dataset = {};
    this.body = new FakeElement('body');
    this.activeElement = this.body;
  }

  register(node) {
    if (node.id) this.nodesById.set(node.id, node);
    for (const child of node.children) this.register(child);
    return node;
  }

  getElementById(id) {
    return this.nodesById.get(id) || null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createDocumentFragment() {
    return new FakeFragment();
  }

  addEventListener() {}
  removeEventListener() {}
  getSelection() { return null; }
}

class FakeResizeObserver {
  constructor() {
    this.observeCalls = [];
    this.disconnectCalls = 0;
    this.current = null;
  }

  observe(node) {
    this.observeCalls.push(node);
    this.current = node;
  }

  disconnect() {
    this.disconnectCalls++;
    this.current = null;
  }
}

function createSlot(document, slot) {
  const pane = new FakeElement('section', {
    id: `term-pane-${slot}`,
    className: 'terminal-pane',
  });
  const header = new FakeElement('header', { className: 'terminal-pane-header' });
  const title = new FakeElement('span', { className: 'terminal-pane-title' });
  const providerPill = new FakeElement('span', { className: 'pane-provider-pill' });
  const activity = new FakeElement('span', {
    id: `term-activity-${slot}`,
    className: 'terminal-pane-activity',
  });
  const micButton = new FakeElement('button', { className: 'terminal-pane-mic' });
  const expandButton = new FakeElement('button', { className: 'terminal-pane-expand' });
  const collapseButton = new FakeElement('button', { className: 'terminal-pane-collapse' });
  const closeButton = new FakeElement('button', { className: 'terminal-pane-close' });
  const viewBadge = new FakeElement('span', { className: 'pane-view-badge' });
  const viewBackButton = new FakeElement('button', { className: 'pane-view-back' });
  header.appendChild(title);
  header.appendChild(providerPill);
  header.appendChild(activity);
  header.appendChild(micButton);
  header.appendChild(expandButton);
  header.appendChild(collapseButton);
  const pinButton = new FakeElement('button', { className: 'terminal-pane-pinnedoc' });
  const pinCount = new FakeElement('span', { className: 'pane-pin-count' });
  pinButton.appendChild(pinCount);
  header.appendChild(pinButton);
  header.appendChild(closeButton);
  header.appendChild(viewBadge);
  header.appendChild(viewBackButton);
  const container = new FakeElement('div', {
    id: `term-container-${slot}`,
    className: 'terminal-container',
  });
  const viewContainer = new FakeElement('div', {
    id: `pane-view-${slot}`,
    className: 'pane-view-container',
  });
  viewContainer.hidden = true;
  const uploadButton = new FakeElement('button', { className: 'terminal-pane-upload' });
  const scheduleButton = new FakeElement('button', { className: 'terminal-pane-schedule' });
  const scheduleCount = new FakeElement('span', { className: 'pane-schedule-count' });
  scheduleButton.appendChild(scheduleCount);
  const mobileInputRow = new FakeElement('div', { className: 'terminal-mobile-input-row' });
  mobileInputRow.appendChild(new FakeElement('input', { className: 'mobile-type-input' }));
  mobileInputRow.appendChild(new FakeElement('button', { className: 'mobile-send-btn' }));
  const mobileToolbar = new FakeElement('div', { className: 'terminal-mobile-toolbar' });
  mobileToolbar.appendChild(new FakeElement('button', { className: 'toolbar-keyboard' }));
  pane.appendChild(header);
  pane.appendChild(container);
  pane.appendChild(viewContainer);
  pane.appendChild(uploadButton);
  pane.appendChild(scheduleButton);
  pane.appendChild(mobileInputRow);
  pane.appendChild(mobileToolbar);
  document.register(pane);
  return {
    pane,
    header,
    title,
    providerPill,
    activity,
    micButton,
    expandButton,
    collapseButton,
    closeButton,
    pinButton,
    pinCount,
    viewBadge,
    viewBackButton,
    container,
    viewContainer,
    uploadButton,
    scheduleButton,
    scheduleCount,
    mobileInputRow,
    mobileInput: mobileInputRow.querySelector('.mobile-type-input'),
    mobileToolbar,
    keyboardButton: mobileToolbar.querySelector('.toolbar-keyboard'),
  };
}

function loadProductionRuntime(document, options = {}) {
  const animationFrames = [];
  let animationFrameId = 0;
  const window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  const sandbox = {
    window,
    document,
    navigator: { platform: 'Win32' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { protocol: 'http:', host: 'test.invalid' },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame(callback) {
      const id = ++animationFrameId;
      if (options.deferAnimationFrames) {
        animationFrames.push({ id, callback });
      } else {
        callback();
      }
      return id;
    },
    cancelAnimationFrame(id) {
      const index = animationFrames.findIndex(frame => frame.id === id);
      if (index !== -1) animationFrames.splice(index, 1);
    },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ status: 'ok' }) }),
    ErrorEvent: function ErrorEvent(type, init) { this.type = type; Object.assign(this, init); },
    MouseEvent: function MouseEvent(type, init) { this.type = type; Object.assign(this, init); },
    CustomEvent: function CustomEvent(type, init) { this.type = type; Object.assign(this, init); },
    ResizeObserver: FakeResizeObserver,
    CSS: { escape: value => String(value) },
  };
  window.document = document;
  window.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(terminalSource, sandbox, { filename: 'terminal.js' });
  vm.runInContext(appSource + '\nwindow.__TestCWMApp = CWMApp;', sandbox, { filename: 'app.js' });
  return {
    TerminalPane: sandbox.window.TerminalPane,
    CWMApp: sandbox.window.__TestCWMApp,
    flushNextAnimationFrame() {
      const frame = animationFrames.shift();
      if (frame) frame.callback();
      return !!frame;
    },
    flushAllAnimationFrames() {
      while (animationFrames.length) animationFrames.shift().callback();
    },
    get pendingAnimationFrames() {
      return animationFrames.length;
    },
  };
}

function makeLivePane(TerminalPane, host, options = {}) {
  const selection = { text: options.selection || '' };
  const xtermRoot = new FakeElement('div', { className: 'xterm' });
  host.container.appendChild(xtermRoot);
  const term = {
    element: xtermRoot,
    rows: 24,
    refreshCalls: 0,
    clearSelectionCalls: 0,
    focusCalls: 0,
    blurCalls: 0,
    hasSelection: () => selection.text.length > 0,
    getSelection: () => selection.text,
    clearSelection() {
      this.clearSelectionCalls++;
      selection.text = '';
    },
    refresh() { this.refreshCalls++; },
    focus() { this.focusCalls++; },
    blur() { this.blurCalls++; },
  };
  const ws = {
    closeCalls: 0,
    close() { this.closeCalls++; },
  };
  const pane = new TerminalPane(
    host.container.id,
    options.sessionId || 'session',
    options.sessionName || 'Terminal',
    { provider: options.provider || 'claude' }
  );
  pane.term = term;
  pane.ws = ws;
  pane._resizeObserver = new FakeResizeObserver();
  pane._isMobile = () => false;
  pane._maybeShowCopyHint = () => {};
  pane._updateSelectModeUI = () => {};
  pane.activate = () => {};
  pane.safeFit = () => {};
  assert.strictEqual(pane.rebindHost(host.container.id), true, 'initial host bind');
  return { pane, term, ws, selection, xtermRoot };
}

function makeDeferredPane(document, slot, options = {}) {
  const pane = {
    containerId: `term-container-${slot}`,
    paneEl: document.getElementById(`term-pane-${slot}`),
    sessionId: options.sessionId || `deferred-${slot}`,
    sessionName: options.sessionName || `Deferred ${slot}`,
    spawnOpts: { provider: options.provider || 'claude' },
    _providerId: options.provider || 'claude',
    _mountActivationGeneration: 0,
    _currentActivity: options.activity || null,
    term: null,
    mountCalls: 0,
    disposeCalls: 0,
    rebindCalls: [],
    detachCalls: 0,
    focusCalls: 0,
    blurCalls: 0,
    safeFitCalls: 0,
    activateCalls: 0,
    focusedStates: [],
    mount() {
      this.mountCalls++;
      const root = new FakeElement('div', { className: 'xterm' });
      root.__cwmTerminalPane = this;
      const container = document.getElementById(this.containerId);
      if (container) container.appendChild(root);
      this.term = {
        element: root,
        rows: 24,
        refreshCalls: 0,
        refresh() { this.refreshCalls++; },
      };
    },
    dispose() {
      this.disposeCalls++;
      if (this.term && this.term.element) this.term.element.remove();
      this.term = null;
    },
    rebindHost(containerId) {
      this.rebindCalls.push(containerId);
      this.containerId = containerId;
      this.paneEl = document.getElementById(containerId.replace('container', 'pane'));
      const container = document.getElementById(containerId);
      if (container && this.term && this.term.element) {
        container.appendChild(this.term.element);
      }
      return !!container;
    },
    detachHostBindings() {
      this.detachCalls++;
      return true;
    },
    setFocused(value) {
      this._isFocused = !!value;
      this.focusedStates.push(!!value);
    },
    focus() { this.focusCalls++; },
    blur() { this.blurCalls++; },
    safeFit() { this.safeFitCalls++; },
    activate() { this.activateCalls++; },
  };
  return pane;
}

function makeLifecycleApp(CWMApp, options = {}) {
  const app = Object.create(CWMApp.prototype);
  const size = CWMApp.MAX_PANES;
  app.terminalPanes = new Array(size).fill(null);
  (options.panes || []).forEach((pane, index) => {
    app.terminalPanes[index] = pane;
  });
  app._activeGroupId = options.activeGroupId || 'group-a';
  app._activeTerminalSlot = options.activeSlot === undefined
    ? 0
    : options.activeSlot;
  app._tabGroups = options.groups || [
    { id: 'group-a', name: 'A', panes: [] },
    { id: 'group-b', name: 'B', panes: [] },
  ];
  app._groupPaneCache = {};
  app._mirrorPanes = new Array(size).fill(null);
  app._voiceRecognitions = {};
  app._paneRefreshTimers = {};
  app._paneViewGenerations = new Array(size).fill(0);
  app._gridColSizes = [1, 1];
  app._gridRowSizes = [1, 1];
  app._speechRecognitionAvailable = false;
  app._getProviderById = id => ({ displayName: String(id).toUpperCase() });
  app._renderCodexStatusStrip = () => {};
  app.updateTerminalGridLayout = () => {};
  app.renderTerminalGroupTabs = () => {};
  app._ensureActiveTabVisible = () => {};
  app.saveTerminalLayout = () => {};
  app.saveCurrentGroupPanes = () => {};
  app.showToast = () => {};
  app._activationCalls = [];
  app.setActiveTerminalPane = slot => {
    app._activeTerminalSlot = slot;
    app._activationCalls.push(slot);
  };
  return app;
}

function assertSingleHostBinding(host) {
  assert.strictEqual(host.header.count('.terminal-pane-selectmode'), 1, 'one Select control');
  assert.strictEqual(host.container.listenerCount('mousedown'), 1, 'one mousedown interceptor');
  assert.strictEqual(host.container.listenerCount('mousemove'), 1, 'one mousemove interceptor');
  assert.strictEqual(host.container.listenerCount('mouseup'), 1, 'one mouseup interceptor');
}

function assertNoHostBinding(host) {
  assert.strictEqual(host.header.count('.terminal-pane-selectmode'), 0, 'no stale Select control');
  assert.strictEqual(host.container.listenerCount('mousedown'), 0, 'no stale mousedown interceptor');
  assert.strictEqual(host.container.listenerCount('mousemove'), 0, 'no stale mousemove interceptor');
  assert.strictEqual(host.container.listenerCount('mouseup'), 0, 'no stale mouseup interceptor');
}

console.log('\n  Terminal host ownership lifecycle');
console.log('  ' + '-'.repeat(58));

check('stamped xterm event owner beats a stale fixed-slot array entry', () => {
  const document = new FakeDocument();
  const host = createSlot(document, 0);
  const { CWMApp } = loadProductionRuntime(document);
  const stampedOwner = { id: 'rendered-owner' };
  const staleSlotOwner = { id: 'stale-slot-owner' };
  const xtermRoot = new FakeElement('div', { className: 'xterm' });
  const child = new FakeElement('span');
  xtermRoot.__cwmTerminalPane = stampedOwner;
  xtermRoot.appendChild(child);
  host.container.appendChild(xtermRoot);
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [staleSlotOwner];

  assert.strictEqual(
    app._terminalPaneFromPointerEvent(0, { target: child }),
    stampedOwner,
    'event routing must follow the stamped rendered terminal'
  );
});

check('context-menu pane actions use the stamped owner slot coherently', () => {
  const document = new FakeDocument();
  createSlot(document, 0);
  createSlot(document, 1);
  const { CWMApp } = loadProductionRuntime(document);
  const staleSlotOwner = {
    sessionId: 'stale',
    sessionName: 'Stale',
    spawnOpts: {},
  };
  const renderedOwner = {
    sessionId: 'rendered',
    sessionName: 'Rendered',
    spawnOpts: {},
    pasteFromClipboard() {},
    focus() {},
    sendCommand() {},
  };
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [staleSlotOwner, renderedOwner];
  app.state = {};
  app._tabGroups = [];
  app._activeGroupId = null;
  app._buildSessionContextItems = () => null;
  app.getSessionConflicts = () => [];
  let renderedItems = null;
  const closedSlots = [];
  app._renderContextItems = (_title, items) => { renderedItems = items; };
  app.closeTerminalPane = slot => { closedSlots.push(slot); };

  app.showTerminalContextMenu(
    0,
    10,
    20,
    { hasSelection: true, text: 'OWNER TEXT', source: 'xterm' },
    renderedOwner
  );
  const closeItem = renderedItems.find(item => item && item.label === 'Close Pane');
  assert.ok(closeItem, 'production menu must expose Close Pane');
  closeItem.action();
  assert.deepStrictEqual(
    closedSlots,
    [1],
    'slot-owning actions must follow the stamped owner, never the stale listener slot'
  );
});

check('detach/rebind transfers host resources without touching selection or WebSocket', () => {
  const document = new FakeDocument();
  const host0 = createSlot(document, 0);
  const host1 = createSlot(document, 1);
  const { TerminalPane } = loadProductionRuntime(document);
  const live = makeLivePane(TerminalPane, host0, { selection: 'keep this text' });
  assertSingleHostBinding(host0);

  const sameSocket = live.pane.ws;
  assert.strictEqual(live.pane.detachHostBindings(), true);
  assertNoHostBinding(host0);
  assert.strictEqual(live.pane._resizeObserver.current, null, 'old resize host disconnected');
  assert.strictEqual(live.pane.getCopySelection().text, 'keep this text');
  assert.strictEqual(live.term.clearSelectionCalls, 0);
  assert.strictEqual(live.ws.closeCalls, 0);

  assert.strictEqual(live.pane.rebindHost(host1.container.id), true);
  assertNoHostBinding(host0);
  assertSingleHostBinding(host1);
  assert.strictEqual(live.pane.containerId, host1.container.id);
  assert.strictEqual(live.pane.paneEl, host1.pane);
  assert.strictEqual(live.xtermRoot.parentElement, host1.container);
  assert.strictEqual(live.xtermRoot.__cwmTerminalPane, live.pane);
  assert.strictEqual(live.pane._resizeObserver.current, host1.container);
  assert.strictEqual(live.pane.getCopySelection().text, 'keep this text');
  assert.strictEqual(live.pane.ws, sameSocket);
  assert.strictEqual(live.ws.closeCalls, 0);
});

check('swapTerminalPanes rebinds both moved terminals and keeps owner/container coherent', () => {
  const document = new FakeDocument();
  const host0 = createSlot(document, 0);
  const host1 = createSlot(document, 1);
  const { TerminalPane, CWMApp } = loadProductionRuntime(document);
  const left = makeLivePane(TerminalPane, host0, {
    sessionId: 'left',
    selection: 'LEFT SELECTION',
    provider: 'codex',
  });
  const right = makeLivePane(TerminalPane, host1, {
    sessionId: 'right',
    selection: 'RIGHT SELECTION',
    provider: 'claude',
  });
  left.pane._currentActivity = { type: 'writing' };
  right.pane._currentActivity = { type: 'reading' };
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [left.pane, right.pane];
  app._activeTerminalSlot = 0;
  app._voiceRecognitions = {};
  app._mirrorPanes = {};
  app._paneRefreshTimers = {};
  app._paneViewGenerations = [0, 0];
  app._speechRecognitionAvailable = false;
  app._renderCodexStatusStrip = () => {};
  app._getProviderById = id => ({ displayName: id.toUpperCase() });
  app.updateTerminalGridLayout = () => {};
  app.saveTerminalLayout = () => {};

  app.swapTerminalPanes(0, 1);

  assert.strictEqual(app.terminalPanes[0], right.pane);
  assert.strictEqual(app.terminalPanes[1], left.pane);
  assert.strictEqual(right.pane.containerId, host0.container.id);
  assert.strictEqual(right.pane.paneEl, host0.pane);
  assert.strictEqual(right.xtermRoot.parentElement, host0.container);
  assert.strictEqual(right.xtermRoot.__cwmTerminalPane, right.pane);
  assert.strictEqual(left.pane.containerId, host1.container.id);
  assert.strictEqual(left.pane.paneEl, host1.pane);
  assert.strictEqual(left.xtermRoot.parentElement, host1.container);
  assert.strictEqual(left.xtermRoot.__cwmTerminalPane, left.pane);
  assert.strictEqual(host0.pane.dataset.provider, 'claude');
  assert.strictEqual(host1.pane.dataset.provider, 'codex');
  assertSingleHostBinding(host0);
  assertSingleHostBinding(host1);
  assert.strictEqual(left.pane.getCopySelection().text, 'LEFT SELECTION');
  assert.strictEqual(right.pane.getCopySelection().text, 'RIGHT SELECTION');
  assert.strictEqual(left.ws.closeCalls + right.ws.closeCalls, 0);
  assert.strictEqual(app._activeTerminalSlot, 1, 'active owner follows the moved pane');
  assert.strictEqual(left.pane._isFocused, true, 'moved active pane keeps foreground rendering');
  assert.strictEqual(right.pane._isFocused, false, 'other pane is demoted');
  assert.strictEqual(
    host0.activity.dataset.activityKey,
    'reading|',
    'destination host restores the activity owned by the pane moved into it'
  );
  assert.strictEqual(
    host1.activity.dataset.activityKey,
    'writing|',
    'source host restores the activity owned by the pane moved into it'
  );
});

check('cached group detach/restore is idempotent and preserves live terminal ownership', () => {
  const document = new FakeDocument();
  const host = createSlot(document, 0);
  const { TerminalPane, CWMApp } = loadProductionRuntime(document);
  const live = makeLivePane(TerminalPane, host, {
    sessionId: 'cached',
    selection: 'CACHED SELECTION',
    provider: 'codex',
  });
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [live.pane, null, null, null, null, null];
  app._mirrorPanes = new Array(CWMApp.MAX_PANES).fill(null);
  app._groupPaneCache = {};
  app._activeGroupId = 'group-a';
  app._activeTerminalSlot = 0;
  app._tabGroups = [
    { id: 'group-a', name: 'A', panes: [] },
    { id: 'group-b', name: 'B', panes: [] },
  ];
  app.saveCurrentGroupPanes = () => {};
  app.updateTerminalGridLayout = () => {};
  app.renderTerminalGroupTabs = () => {};
  app._ensureActiveTabVisible = () => {};
  app.saveTerminalLayout = () => {};
  app._restoreGroupMirrorPanes = () => {};
  app._getProviderById = id => ({ displayName: id.toUpperCase() });
  app._renderCodexStatusStrip = () => {};
  app._voiceRecognitions = {};
  app._paneRefreshTimers = {};
  app._paneViewGenerations = new Array(CWMApp.MAX_PANES).fill(0);
  app.openTerminalInPane = () => { throw new Error('cache restore must not reconnect'); };
  live.pane._isFocused = true;
  live.pane._needsInput = true;
  live.pane._currentActivity = { type: 'searching' };

  app.switchTerminalGroup('group-b');
  assertNoHostBinding(host);
  assert.strictEqual(host.activity.innerHTML, '', 'shared host activity is empty while its owner is cached');
  assert.ok(app._groupPaneCache['group-a'], 'outgoing live group cached');
  assert.strictEqual(live.pane.getCopySelection().text, 'CACHED SELECTION');
  assert.strictEqual(live.ws.closeCalls, 0);
  assert.strictEqual(live.xtermRoot.__cwmTerminalPane, live.pane);
  assert.strictEqual(live.pane._isFocused, false, 'cached pane is background-throttled');

  app.switchTerminalGroup('group-a');
  assert.strictEqual(app.terminalPanes[0], live.pane);
  assert.strictEqual(live.xtermRoot.parentElement, host.container);
  assert.strictEqual(live.xtermRoot.__cwmTerminalPane, live.pane);
  assert.strictEqual(live.pane.containerId, host.container.id);
  assert.strictEqual(live.pane.paneEl, host.pane);
  assertSingleHostBinding(host);
  assert.strictEqual(live.pane.getCopySelection().text, 'CACHED SELECTION');
  assert.strictEqual(live.ws.closeCalls, 0);
  assert.strictEqual(live.pane._isFocused, true, 'remembered active pane is promoted');
  assert.strictEqual(
    host.header.dataset.needsInput,
    'true',
    'unresolved needs-input badge is restored with its TerminalPane'
  );
  assert.strictEqual(
    host.activity.dataset.activityKey,
    'searching|',
    'cached pane activity is restored onto its rebound host'
  );

  // A second full cycle proves controls/listeners do not accumulate.
  app.switchTerminalGroup('group-b');
  app.switchTerminalGroup('group-a');
  assertSingleHostBinding(host);
  assert.strictEqual(live.pane.getCopySelection().text, 'CACHED SELECTION');
  assert.strictEqual(live.xtermRoot.__cwmTerminalPane, live.pane);
  assert.strictEqual(live.pane._resizeObserver.current, host.container);
  assert.strictEqual(live.ws.closeCalls, 0);
});

check('A to B to A remembers a selected mirror instead of activating a hidden terminal', () => {
  const document = new FakeDocument();
  const hosts = [];
  for (let slot = 0; slot < 6; slot++) hosts.push(createSlot(document, slot));
  const runtime = loadProductionRuntime(document, { deferAnimationFrames: true });
  const live = makeLivePane(runtime.TerminalPane, hosts[0], {
    sessionId: 'terminal-a',
  });
  live.pane.activateCalls = 0;
  live.pane.activate = () => { live.pane.activateCalls++; };
  const groups = [
    {
      id: 'group-a',
      name: 'A',
      panes: [
        { slot: 0, sessionId: 'terminal-a', sessionName: 'Terminal A' },
        {
          slot: 1,
          sessionId: null,
          viewType: 'mirror',
          viewData: {
            provider: 'codex',
            providerSessionId: 'mirror-a',
            title: 'Mirror A',
          },
        },
      ],
    },
    { id: 'group-b', name: 'B', panes: [] },
  ];
  const app = makeLifecycleApp(runtime.CWMApp, {
    panes: [live.pane],
    activeGroupId: 'group-a',
    activeSlot: 1,
    groups,
  });
  app._mirrorPanes[1] = {
    title: 'Mirror A',
    dispose() {},
    descriptor() { return groups[0].panes[1].viewData; },
  };
  app._restoreGroupMirrorPanes = group => {
    for (const record of (group && group.panes) || []) {
      if (record.viewType !== 'mirror') continue;
      app._mirrorPanes[record.slot] = {
        title: record.viewData.title,
        dispose() {},
        descriptor() { return record.viewData; },
      };
    }
  };

  app.switchTerminalGroup('group-b');
  app.switchTerminalGroup('group-a');

  assert.strictEqual(
    app._activeTerminalSlot,
    1,
    'remembered mirror slot is restored after its descriptor is reopened'
  );
  runtime.flushAllAnimationFrames();
  assert.strictEqual(
    live.pane.activateCalls,
    0,
    'cached repaint must not activate the hidden terminal behind a selected mirror'
  );
});

check('deferred mount is cancelled by a group switch and by close', () => {
  {
    const document = new FakeDocument();
    for (let slot = 0; slot < 6; slot++) createSlot(document, slot);
    const runtime = loadProductionRuntime(document, { deferAnimationFrames: true });
    const pane = makeDeferredPane(document, 0, { sessionId: 'switch-cancel' });
    const app = makeLifecycleApp(runtime.CWMApp, {
      panes: [pane],
      activeGroupId: 'group-a',
      activeSlot: 0,
    });

    app._mountTerminalPaneOnNextFrame(pane, 'group-a', true);
    app.switchTerminalGroup('group-b');
    runtime.flushAllAnimationFrames();

    assert.strictEqual(pane.mountCalls, 0, 'switch-away must cancel the old group mount');
    assert.deepStrictEqual(app._activationCalls, [], 'switch-away must cancel stale activation');
    assert.strictEqual(
      app._groupPaneCache['group-a'].panes[0],
      pane,
      'the unmounted pane remains cached for a later legitimate restore'
    );
  }

  {
    const document = new FakeDocument();
    for (let slot = 0; slot < 6; slot++) createSlot(document, slot);
    const runtime = loadProductionRuntime(document, { deferAnimationFrames: true });
    const pane = makeDeferredPane(document, 0, { sessionId: 'close-cancel' });
    const app = makeLifecycleApp(runtime.CWMApp, {
      panes: [pane],
      activeGroupId: 'group-a',
      activeSlot: 0,
    });

    app._mountTerminalPaneOnNextFrame(pane, 'group-a', true);
    app.closeTerminalPane(0);
    runtime.flushAllAnimationFrames();

    assert.strictEqual(pane.disposeCalls, 1, 'close disposes the pending pane');
    assert.strictEqual(pane.mountCalls, 0, 'closed pane must not mount on the queued frame');
    assert.strictEqual(app.terminalPanes[0], null, 'closed slot remains empty');
    assert.deepStrictEqual(app._activationCalls, [], 'closed pane cannot reclaim focus');
  }
});

check('deferred mount follows TerminalPane identity through a same-group swap', () => {
  const document = new FakeDocument();
  for (let slot = 0; slot < 6; slot++) createSlot(document, slot);
  const runtime = loadProductionRuntime(document, { deferAnimationFrames: true });
  const pane = makeDeferredPane(document, 0, {
    sessionId: 'swap-before-mount',
    provider: 'codex',
  });
  const app = makeLifecycleApp(runtime.CWMApp, {
    panes: [pane],
    activeGroupId: 'group-a',
    activeSlot: 0,
  });

  app._mountTerminalPaneOnNextFrame(pane, 'group-a', true);
  app.swapTerminalPanes(0, 1);
  runtime.flushNextAnimationFrame();

  assert.strictEqual(app.terminalPanes[0], null);
  assert.strictEqual(app.terminalPanes[1], pane);
  assert.strictEqual(pane.mountCalls, 1, 'pane mounts exactly once after its move');
  assert.strictEqual(pane.containerId, 'term-container-1', 'mount resolves the moved owner slot');
  assert.strictEqual(
    pane.term.element.parentElement,
    document.getElementById('term-container-1'),
    'new xterm root lands in the moved destination host'
  );
  assert.deepStrictEqual(app._activationCalls, [1], 'activation follows the moved owner identity');
});

check('A to B to A cannot let stale unconditional mount override remembered active pane', () => {
  const document = new FakeDocument();
  for (let slot = 0; slot < 6; slot++) createSlot(document, slot);
  const runtime = loadProductionRuntime(document, { deferAnimationFrames: true });
  const staleOpen = makeDeferredPane(document, 0, { sessionId: 'stale-open' });
  const rememberedActive = makeDeferredPane(document, 1, { sessionId: 'remembered-active' });
  const app = makeLifecycleApp(runtime.CWMApp, {
    panes: [staleOpen, rememberedActive],
    activeGroupId: 'group-a',
    activeSlot: 1,
  });

  // This is the unconditional frame queued by the initial open in A.
  app._mountTerminalPaneOnNextFrame(staleOpen, 'group-a', true);
  app.switchTerminalGroup('group-b');
  app.switchTerminalGroup('group-a');
  assert.strictEqual(app._activeTerminalSlot, 1, 'cache restore remembers pane 1 before frames run');

  runtime.flushAllAnimationFrames();

  assert.strictEqual(staleOpen.mountCalls, 1, 'stale-open pane may still construct once after A returns');
  assert.strictEqual(rememberedActive.mountCalls, 1, 'remembered active pane constructs once');
  assert.deepStrictEqual(
    app._activationCalls,
    [1],
    'invalidated unconditional activation cannot steal focus from remembered pane 1'
  );
  assert.strictEqual(app._activeTerminalSlot, 1);
  assert.strictEqual(staleOpen._isFocused, false);
  assert.strictEqual(rememberedActive._isFocused, true);
});

check('_resetTerminalPaneHost clears every fixed-slot lifecycle surface', () => {
  const document = new FakeDocument();
  const host = createSlot(document, 0);
  const { CWMApp } = loadProductionRuntime(document);
  const app = Object.create(CWMApp.prototype);
  let mirrorDisposeCalls = 0;
  let voiceAbortCalls = 0;
  let codexStripCalls = 0;
  const interimOverlay = new FakeElement('div', { className: 'voice-interim-overlay' });
  host.pane.appendChild(interimOverlay);
  const recognition = {
    _cwmSlot: 0,
    _cwmMicButton: host.micButton,
    _cwmInterimOverlay: interimOverlay,
    abort() { voiceAbortCalls++; },
  };
  app._voiceRecognitions = { 0: recognition };
  app._mirrorPanes = {
    0: { dispose() { mirrorDisposeCalls++; } },
  };
  app._paneRefreshTimers = { 0: 123 };
  app._paneViewGenerations = [7, 0, 0, 0, 0, 0];
  app._renderCodexStatusStrip = () => { codexStripCalls++; };

  host.pane.classList.add(
    'terminal-pane-active',
    'pane-expanded-stage1',
    'pane-expanded-stage2',
    'pane-nav-pulse',
    'terminal-pane-dragging',
    'drag-over',
    'terminal-pane-loading',
    'terminal-pane-done'
  );
  host.pane.classList.remove('terminal-pane-empty');
  Object.assign(host.pane.dataset, {
    provider: 'codex',
    attentionState: 'needs-input',
    needsInput: 'true',
    viewType: 'doc',
    viewData: '{"docId":"readme"}',
  });
  host.header.classList.add('attention-state');
  host.header.dataset.attentionState = 'needs-input';
  host.header.dataset.needsInput = 'true';
  host.title.textContent = 'Busy pane';
  host.providerPill.hidden = false;
  host.providerPill.textContent = 'Codex';
  host.providerPill.dataset.provider = 'codex';
  [
    host.closeButton,
    host.uploadButton,
    host.expandButton,
    host.collapseButton,
    host.micButton,
    host.pinButton,
    host.scheduleButton,
  ].forEach(control => { control.hidden = false; });
  host.expandButton.classList.add('terminal-pane-expand-stage1', 'terminal-pane-expand-stage2');
  host.expandButton.title = 'Expand to full screen';
  host.micButton.classList.add('mic-active');
  host.scheduleCount.textContent = '4';
  host.scheduleCount.hidden = false;
  host.pinCount.textContent = '2';
  host.viewBadge.hidden = false;
  host.viewBadge.textContent = 'Markdown';
  host.viewBackButton.hidden = false;
  host.viewContainer.hidden = false;
  host.viewContainer.appendChild(new FakeElement('article'));
  host.container.hidden = true;
  host.container.appendChild(new FakeElement('div', { className: 'xterm' }));
  host.mobileInputRow.classList.add('active');
  host.mobileInput.value = 'unsent draft';
  document.activeElement = host.mobileInput;
  host.keyboardButton.classList.add('toolbar-active');
  host.keyboardButton.textContent = '\u2328 Typing';
  host.activity.dataset.activityKey = 'writing|file.js';
  host.activity.innerHTML = 'Writing: file.js';

  assert.strictEqual(app._resetTerminalPaneHost(0), true);

  assert.strictEqual(recognition._cwmDiscarded, true);
  assert.strictEqual(voiceAbortCalls, 1);
  assert.strictEqual(app._voiceRecognitions[0], undefined);
  assert.strictEqual(interimOverlay.parentNode, null);
  assert.strictEqual(mirrorDisposeCalls, 1);
  assert.strictEqual(app._mirrorPanes[0], undefined);
  assert.strictEqual(app._paneRefreshTimers[0], undefined);
  assert.strictEqual(app._paneViewGenerations[0], 8);
  assert.strictEqual(host.pane.classList.contains('terminal-pane-empty'), true);
  for (const className of [
    'terminal-pane-active',
    'pane-expanded-stage1',
    'pane-expanded-stage2',
    'pane-nav-pulse',
    'terminal-pane-dragging',
    'drag-over',
    'terminal-pane-loading',
    'terminal-pane-done',
  ]) {
    assert.strictEqual(host.pane.classList.contains(className), false, `${className} cleared`);
  }
  assert.strictEqual(host.pane.dataset.provider, undefined);
  assert.strictEqual(host.pane.dataset.attentionState, undefined);
  assert.strictEqual(host.pane.dataset.needsInput, undefined);
  assert.strictEqual(host.pane.dataset.viewType, undefined);
  assert.strictEqual(host.pane.dataset.viewData, undefined);
  assert.strictEqual(host.header.classList.contains('attention-state'), false);
  assert.strictEqual(host.header.dataset.attentionState, undefined);
  assert.strictEqual(host.header.dataset.needsInput, undefined);
  assert.strictEqual(host.title.textContent, 'Drop a session here');
  assert.strictEqual(host.providerPill.hidden, true);
  assert.strictEqual(host.providerPill.textContent, '');
  assert.strictEqual(host.providerPill.dataset.provider, undefined);
  [
    host.closeButton,
    host.uploadButton,
    host.expandButton,
    host.collapseButton,
    host.micButton,
    host.pinButton,
    host.scheduleButton,
  ].forEach(control => assert.strictEqual(control.hidden, true));
  assert.strictEqual(host.expandButton.classList.contains('terminal-pane-expand-stage1'), false);
  assert.strictEqual(host.expandButton.classList.contains('terminal-pane-expand-stage2'), false);
  assert.strictEqual(host.expandButton.title, 'Expand pane');
  assert.strictEqual(host.micButton.classList.contains('mic-active'), false);
  assert.strictEqual(host.scheduleCount.textContent, '');
  assert.strictEqual(host.scheduleCount.hidden, true);
  assert.strictEqual(host.pinCount.textContent, '');
  assert.strictEqual(host.viewBadge.hidden, true);
  assert.strictEqual(host.viewBadge.textContent, '');
  assert.strictEqual(host.viewBackButton.hidden, true);
  assert.strictEqual(host.viewContainer.hidden, true);
  assert.strictEqual(host.viewContainer.children.length, 0);
  assert.strictEqual(host.container.hidden, false);
  assert.strictEqual(host.container.children.length, 0);
  assert.strictEqual(host.mobileInputRow.classList.contains('active'), false);
  assert.strictEqual(host.mobileInput.value, '');
  assert.strictEqual(host.mobileInput.blurCalls, 1);
  assert.strictEqual(host.keyboardButton.classList.contains('toolbar-active'), false);
  assert.strictEqual(host.keyboardButton.textContent, '\u2328 Type');
  assert.strictEqual(host.activity.innerHTML, '');
  assert.strictEqual(host.activity.dataset.activityKey, undefined);
  assert.strictEqual(codexStripCalls, 1);
});

check('fatal error in cached group disposes pane and removes its persisted descriptor', () => {
  const document = new FakeDocument();
  const { CWMApp } = loadProductionRuntime(document);
  const app = Object.create(CWMApp.prototype);
  const deadPane = {
    sessionId: 'dead-session',
    disposeCalls: 0,
    dispose() { this.disposeCalls++; },
  };
  const survivor = { sessionId: 'survivor' };
  const cachedPanes = new Array(CWMApp.MAX_PANES).fill(null);
  const fragments = new Array(CWMApp.MAX_PANES).fill(null);
  cachedPanes[2] = deadPane;
  cachedPanes[4] = survivor;
  fragments[2] = { id: 'dead-fragment' };
  app.terminalPanes = new Array(CWMApp.MAX_PANES).fill(null);
  app._groupPaneCache = {
    'group-a': {
      panes: cachedPanes,
      domFragments: fragments,
      activePane: deadPane,
      activeSlot: 2,
    },
  };
  app._tabGroups = [{
    id: 'group-a',
    panes: [
      { slot: 2, sessionId: 'dead-session', sessionName: 'Dead' },
      { slot: 4, sessionId: 'survivor', sessionName: 'Survivor' },
    ],
  }];
  let saveCalls = 0;
  app.saveTerminalLayout = () => { saveCalls++; };

  assert.strictEqual(app._handleTerminalPaneFatal(deadPane), true);
  assert.strictEqual(deadPane.disposeCalls, 1);
  assert.strictEqual(cachedPanes[2], null);
  assert.strictEqual(fragments[2], null);
  assert.strictEqual(app._groupPaneCache['group-a'].activePane, survivor);
  assert.strictEqual(app._groupPaneCache['group-a'].activeSlot, 4);
  assert.deepStrictEqual(
    app._tabGroups[0].panes.map(record => record.sessionId),
    ['survivor'],
    'fatal cached session descriptor is removed without touching siblings'
  );
  assert.strictEqual(saveCalls, 1);
});

check('auto-trust setting propagates to live and cached panes in both directions', () => {
  const document = new FakeDocument();
  const { CWMApp } = loadProductionRuntime(document);
  const live = {
    _autoTrustEnabled: false,
    smoothCalls: 0,
    applySmoothScrollSetting() { this.smoothCalls++; },
  };
  const cachedA = {
    _autoTrustEnabled: false,
    smoothCalls: 0,
    applySmoothScrollSetting() { this.smoothCalls++; },
  };
  const cachedB = {
    _autoTrustEnabled: false,
    smoothCalls: 0,
    applySmoothScrollSetting() { this.smoothCalls++; },
  };
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [live, null];
  app._groupPaneCache = {
    a: { panes: [cachedA, null] },
    b: { panes: [null, cachedB] },
  };
  app.state = { settings: { autoTrustDialogs: true } };
  app.els = {};
  app.getSetting = () => false;
  app._sidebarTasksMode = 'native';
  app._activeTasksTab = 'worktree';
  app.renderWorkspaces = null;
  app.loadTdIssues = null;

  app.applySettings();
  assert.strictEqual(live._autoTrustEnabled, true);
  assert.strictEqual(cachedA._autoTrustEnabled, true);
  assert.strictEqual(cachedB._autoTrustEnabled, true);

  app.state.settings.autoTrustDialogs = false;
  app.applySettings();
  assert.strictEqual(live._autoTrustEnabled, false);
  assert.strictEqual(cachedA._autoTrustEnabled, false);
  assert.strictEqual(cachedB._autoTrustEnabled, false);
  assert.strictEqual(live.smoothCalls, 2);
  assert.strictEqual(cachedA.smoothCalls, 2);
  assert.strictEqual(cachedB.smoothCalls, 2);
});

check('mobile A to B to A keeps keyboard state scoped to each pane input row', () => {
  const document = new FakeDocument();
  const hostA = createSlot(document, 0);
  const hostB = createSlot(document, 1);
  const { CWMApp } = loadProductionRuntime(document);
  const paneA = { safeFitCalls: 0, safeFit() { this.safeFitCalls++; } };
  const paneB = { safeFitCalls: 0, safeFit() { this.safeFitCalls++; } };
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [paneA, paneB];
  app._activeTerminalSlot = 0;
  app.els = { terminalTabStrip: null };
  app.setActiveTerminalPane = slot => { app._activeTerminalSlot = slot; };

  hostA.mobileInputRow.classList.add('active');
  hostA.keyboardButton.classList.add('toolbar-active');
  hostA.keyboardButton.textContent = '\u2328 Typing';
  hostB.keyboardButton.textContent = '\u2328 Type';

  app.switchTerminalTab(1);
  assert.strictEqual(hostB.keyboardButton.classList.contains('toolbar-active'), false);
  assert.strictEqual(hostB.keyboardButton.textContent, '\u2328 Type');
  assert.strictEqual(
    hostA.keyboardButton.textContent,
    '\u2328 Typing',
    'switching to B does not mirror B state into A toolbar'
  );

  app.switchTerminalTab(0);
  assert.strictEqual(hostA.keyboardButton.classList.contains('toolbar-active'), true);
  assert.strictEqual(hostA.keyboardButton.textContent, '\u2328 Typing');
  assert.strictEqual(hostB.keyboardButton.classList.contains('toolbar-active'), false);
  assert.strictEqual(hostB.keyboardButton.textContent, '\u2328 Type');
  assert.strictEqual(paneA.safeFitCalls, 1);
  assert.strictEqual(paneB.safeFitCalls, 1);
});

check('mobile mirror selection overrides a stale visible terminal class', () => {
  const document = new FakeDocument();
  const terminalHost = createSlot(document, 0);
  createSlot(document, 1);
  const { CWMApp } = loadProductionRuntime(document);
  const strip = new FakeElement('div');
  terminalHost.pane.classList.add('mobile-active');
  const app = Object.create(CWMApp.prototype);
  Object.defineProperty(app, 'isMobile', { value: true });
  app.terminalPanes = [{ sessionName: 'Terminal' }, null];
  app._mirrorPanes = [null, {
    title: 'Mirror',
    providerSessionId: 'mirror-session',
  }];
  app._activeTerminalSlot = 1;
  app.els = { terminalTabStrip: strip };
  app.state = { sessions: [], hiddenSessions: new Set() };
  app.escapeHtml = value => String(value);
  let switchedTo = null;
  app.switchTerminalTab = slot => { switchedTo = slot; };

  app.updateTerminalTabs();
  assert.strictEqual(
    switchedTo,
    1,
    'explicitly opened mirror wins over the previous terminal mobile-active class'
  );
});

check('mobile mirror hides terminal-only controls and terminal restores them', () => {
  const document = new FakeDocument();
  const terminalHost = createSlot(document, 0);
  const mirrorHost = createSlot(document, 1);
  const { CWMApp } = loadProductionRuntime(document);
  const terminal = { safeFit() {} };
  const app = Object.create(CWMApp.prototype);
  app.terminalPanes = [terminal, null];
  app._mirrorPanes = [null, { title: 'Mirror' }];
  app._activeTerminalSlot = 0;
  app.els = { terminalTabStrip: null };
  app.setActiveTerminalPane = slot => { app._activeTerminalSlot = slot; };

  app.switchTerminalTab(1);
  assert.strictEqual(mirrorHost.mobileToolbar.hidden, true);
  assert.strictEqual(mirrorHost.mobileInputRow.hidden, true);
  assert.strictEqual(
    mirrorHost.mobileInputRow.classList.contains('active'),
    false
  );

  app.switchTerminalTab(0);
  assert.strictEqual(terminalHost.mobileToolbar.hidden, false);
  assert.strictEqual(terminalHost.mobileInputRow.hidden, false);
});

Promise.all(pendingChecks).then(() => {
  console.log('  ' + '-'.repeat(58));
  console.log(`  [terminal-host-ownership] ${passed}/${passed + failed} tests passed`);
  process.exitCode = failed > 0 ? 1 : 0;
});
