/**
 * connect-app.js: the desktop side of pairing the Myrlin iPhone app (mobile v2).
 *
 * WHY: BUILD-CONTRACT B1 item 13 (brief D1 to D3, A23). Three surfaces, all in
 * the focused shell's own style (OS font stack, warm inks, the #2383e2 blue),
 * never a status pill with a dot:
 *   1. The Connect app modal: a URL QR code drawn dark on white with a 4 module
 *      quiet zone (the old modal drew light on dark, which may not scan), the
 *      8 character manual code and the computer's Tailscale name beside it, and
 *      "Refreshes in 4:12"; a new offer every 4 minutes, withdrawn on close.
 *   2. The Allow dialog, on every mobile:pair-request: the phone's name and
 *      model, the 4 digit match code, the six scopes (all checked) plus a
 *      disabled Terminal row, Allow and Deny. Requests queue one at a time.
 *   3. The Devices tab: one row per phone with scopes, push status, Test push,
 *      Revoke with a confirm, and the audit list behind "Recent actions".
 *
 * It talks only to /api/mobile-admin/* with the desktop's own token, builds
 * every node with textContent (device names come from phones), and exposes
 * window.MyrlinConnectApp {open, close, onEvent} for app.js (S15, S16).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function () {
  'use strict';

  /** A new offer this often while the modal is open (PROTOCOL.md 2.3). */
  const OFFER_REFRESH_MS = 4 * 60 * 1000;
  /** Countdown tick. */
  const TICK_MS = 1000;
  /** QR size in CSS pixels, at least 240 (PROTOCOL.md 2.3). */
  const QR_SIZE_PX = 256;
  /** Quiet zone in modules on every side. */
  const QR_QUIET_MODULES = 4;
  /** QR colours: dark modules on white in every theme. */
  const QR_DARK = '#000000';
  const QR_LIGHT = '#ffffff';
  /** Milliseconds per unit, for relative dates. */
  const MS_PER_MINUTE = 60 * 1000;
  const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
  /** Audit rows shown behind "Recent actions". */
  const AUDIT_ROWS = 20;
  /** The desktop token key (DO-NOT-BREAK F: cwm_token). */
  const TOKEN_KEY = 'cwm_token';

  /** The six v1 scopes, in the Allow dialog's order, with their words. */
  const SCOPES = [
    { id: 'chat', label: 'Chat', hint: 'Read and send messages, answer questions and approvals' },
    { id: 'sessions.manage', label: 'Manage sessions', hint: 'Rename, restart, start and branch sessions, edit tabs' },
    { id: 'accounts.read', label: 'See accounts', hint: 'Accounts and usage' },
    { id: 'accounts.swap', label: 'Switch accounts', hint: 'Switch, refresh and sign in to accounts' },
    { id: 'media.upload', label: 'Send photos and videos', hint: 'Upload files to this computer' },
    { id: 'search', label: 'Search', hint: 'Search session names and messages' },
  ];

  /** Machine identifiers to model words (display only; unknown ids show as is). */
  const MODEL_WORDS = {
    'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
    'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus',
    'iPhone17,5': 'iPhone 16e', 'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max', 'iPhone18,3': 'iPhone 17',
    'iPhone18,4': 'iPhone Air', 'arm64': 'iPhone Simulator', 'x86_64': 'iPhone Simulator',
  };

  /** Endpoint kinds in words. */
  const PATH_WORDS = {
    tailscale: 'via Tailscale', loopback: 'on this computer', lan: 'on the local network', relay: 'via the relay', custom: 'via a custom address',
  };

  const state = {
    app: null,
    built: false,
    els: {},
    open: false,
    tab: 'connect',
    offerIds: [],
    offer: null,
    tickTimer: null,
    refreshTimer: null,
    allowQueue: [],
    allowCurrent: null,
    confirmRevoke: null,
    refreshing: false,
  };

  // ── Pure helpers (exported for tests) ─────────────────────────────────────

  /**
   * "4:12" from milliseconds.
   *
   * @param {number} ms - Remaining time.
   * @returns {string}
   */
  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  /**
   * "Paired 3 days ago", "Paired today", "Paired yesterday".
   *
   * @param {number} atMs - When.
   * @param {number} nowMs - Now.
   * @returns {string}
   */
  function formatPaired(atMs, nowMs) {
    const startOfToday = new Date(nowMs);
    startOfToday.setHours(0, 0, 0, 0);
    const days = Math.floor((startOfToday.getTime() - new Date(atMs).setHours(0, 0, 0, 0)) / MS_PER_DAY);
    if (days <= 0) return 'Paired today';
    if (days === 1) return 'Paired yesterday';
    return 'Paired ' + days + ' days ago';
  }

  /**
   * "Last seen 16:42" today, "Last seen Sep 25" before, "Not seen yet" never.
   *
   * @param {number|null} atMs - When.
   * @param {number} nowMs - Now.
   * @returns {string}
   */
  function formatLastSeen(atMs, nowMs) {
    if (!atMs) return 'Not seen yet';
    const d = new Date(atMs);
    const n = new Date(nowMs);
    if (d.toDateString() === n.toDateString()) {
      return 'Last seen ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    const month = d.toLocaleString('en-US', { month: 'short' });
    return 'Last seen ' + month + ' ' + d.getDate();
  }

  /** @param {string} model @returns {string} model in words */
  function modelWords(model) {
    return MODEL_WORDS[model] || model || 'iPhone';
  }

  /** @param {string|null} kind @returns {string} path in words */
  function pathWords(kind) {
    return PATH_WORDS[kind] || 'Not connected yet';
  }

  /** @param {object} device @returns {string} push status in words */
  function pushWords(device) {
    if (device.push && device.push.lastError) return 'Push failing: ' + device.push.lastError;
    return device.push && device.push.registered ? 'Push registered' : 'No push';
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  /**
   * Create an element with attributes and children (strings become text).
   *
   * @param {string} tag - Tag name.
   * @param {object} [attrs] - Attributes; "class", "text", "hidden" and on* handled.
   * @param {Array} [children] - Nodes or strings.
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const c of children || []) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /**
   * Call an admin route with the desktop token.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Route path.
   * @param {object} [body] - JSON body.
   * @returns {Promise<object|null>} Parsed body, or null for 204. Throws {status, code, error}.
   */
  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    let token = null;
    try { token = window.localStorage.getItem(TOKEN_KEY); } catch (_) { token = null; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('Request failed (' + res.status + ').'));
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  // ── Build the modal and the Allow dialog once ─────────────────────────────

  /** Build every node and attach it to the body. */
  function build() {
    if (state.built) return;
    state.built = true;
    const E = state.els;

    E.closeBtn = el('button', { class: 'connect-app-icon-btn', id: 'connect-app-close-btn', type: 'button', 'aria-label': 'Close', onclick: close }, ['×']);
    E.tabConnect = el('button', { class: 'connect-app-tab', id: 'connect-app-tab-connect', type: 'button', role: 'tab', 'aria-selected': 'true', onclick: () => switchTab('connect') }, ['Connect']);
    E.tabDevices = el('button', { class: 'connect-app-tab', id: 'connect-app-tab-devices', type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => switchTab('devices') }, ['Devices']);

    E.turnOnBtn = el('button', { class: 'connect-app-btn-primary', id: 'connect-app-turn-on', type: 'button', onclick: turnOn }, ['Turn on']);
    E.off = el('div', { class: 'connect-app-off', id: 'connect-app-off', hidden: true }, [
      el('p', { class: 'connect-app-lede', text: 'The phone connection is off on this computer.' }),
      el('p', { class: 'connect-app-meta', text: 'Turning it on opens a phone-only port on this computer (127.0.0.1). Reach it from the iPhone through Tailscale.' }),
      E.turnOnBtn,
    ]);
    E.errorText = el('p', { class: 'connect-app-lede', id: 'connect-app-error-text' });
    E.retryBtn = el('button', { class: 'connect-app-btn', id: 'connect-app-retry', type: 'button', onclick: () => refreshStatusAndOffer() }, ['Try again']);
    E.error = el('div', { class: 'connect-app-error', id: 'connect-app-error', hidden: true }, [E.errorText, E.retryBtn]);

    E.qr = el('div', { class: 'connect-app-qr', id: 'connect-app-qr', role: 'img', 'aria-label': 'Pairing code for the Myrlin app' });
    E.code = el('span', { class: 'connect-app-mono connect-app-code', id: 'connect-app-code' });
    E.computer = el('span', { class: 'connect-app-mono', id: 'connect-app-computer' });
    E.countdown = el('p', { class: 'connect-app-meta', id: 'connect-app-countdown', 'aria-live': 'off' });
    E.connected = el('p', { class: 'connect-app-success', id: 'connect-app-connected', hidden: true });
    E.pairing = el('div', { class: 'connect-app-pairing', id: 'connect-app-pairing', hidden: true }, [
      E.qr,
      el('div', { class: 'connect-app-side' }, [
        el('p', { class: 'connect-app-lede', text: 'Scan with the iPhone Camera.' }),
        el('p', { class: 'connect-app-meta', text: 'Or type this code in Myrlin under Pair manually.' }),
        el('div', { class: 'connect-app-field' }, [el('span', { class: 'connect-app-field-label', text: 'Code' }), E.code]),
        el('div', { class: 'connect-app-field' }, [el('span', { class: 'connect-app-field-label', text: 'Computer' }), E.computer]),
        E.countdown,
        E.connected,
      ]),
    ]);
    E.panelConnect = el('section', { class: 'connect-app-panel', id: 'connect-app-panel-connect', role: 'tabpanel' }, [E.off, E.error, E.pairing]);

    E.identityNote = el('p', { class: 'connect-app-note', id: 'connect-app-identity-note', hidden: true, text: 'This computer has a new identity. Phones paired before must scan again.' });
    E.devices = el('div', { class: 'connect-app-devices', id: 'connect-app-devices' });
    E.panelDevices = el('section', { class: 'connect-app-panel', id: 'connect-app-panel-devices', role: 'tabpanel', hidden: true }, [E.identityNote, E.devices]);

    E.modal = el('div', { class: 'connect-app-modal', id: 'connect-app-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'connect-app-title' }, [
      el('header', { class: 'connect-app-header' }, [el('h2', { class: 'connect-app-title', id: 'connect-app-title', text: 'Connect app' }), E.closeBtn]),
      el('div', { class: 'connect-app-tabs', role: 'tablist' }, [E.tabConnect, E.tabDevices]),
      E.panelConnect,
      E.panelDevices,
    ]);
    E.overlay = el('div', { class: 'connect-app-overlay', id: 'connect-app-overlay', hidden: true, onclick: (e) => { if (e.target === E.overlay) close(); } }, [E.modal]);

    // Allow dialog.
    E.allowTitle = el('h2', { class: 'connect-app-title', id: 'connect-app-allow-title' });
    E.allowModel = el('p', { class: 'connect-app-meta', id: 'connect-app-allow-model' });
    E.allowCode = el('div', { class: 'connect-app-match', id: 'connect-app-allow-code', 'aria-label': 'Match code' });
    E.allowScopes = el('fieldset', { class: 'connect-app-scopes', id: 'connect-app-allow-scopes' }, [el('legend', { class: 'connect-app-field-label', text: 'This iPhone may' })]);
    for (const s of SCOPES) {
      E.allowScopes.appendChild(el('label', { class: 'connect-app-scope' }, [
        el('input', { type: 'checkbox', value: s.id, checked: true, 'data-scope': s.id }),
        el('span', { class: 'connect-app-scope-text' }, [el('span', { text: s.label }), el('span', { class: 'connect-app-meta', text: s.hint })]),
      ]));
    }
    E.allowScopes.appendChild(el('label', { class: 'connect-app-scope connect-app-scope-disabled' }, [
      el('input', { type: 'checkbox', value: 'pty.raw', disabled: true }),
      el('span', { class: 'connect-app-scope-text' }, [el('span', { text: 'Terminal (not available in this version)' })]),
    ]));
    E.allowError = el('p', { class: 'connect-app-error-text', id: 'connect-app-allow-error', hidden: true });
    E.allowQueue = el('p', { class: 'connect-app-meta', id: 'connect-app-allow-queue', hidden: true });
    E.denyBtn = el('button', { class: 'connect-app-btn', id: 'connect-app-deny-btn', type: 'button', onclick: () => decide('deny') }, ['Deny']);
    E.allowBtn = el('button', { class: 'connect-app-btn-primary', id: 'connect-app-allow-btn', type: 'button', onclick: () => decide('allow') }, ['Allow']);
    E.allowDialog = el('div', { class: 'connect-app-modal connect-app-allow', id: 'connect-app-allow-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'connect-app-allow-title', tabindex: '-1' }, [
      E.allowTitle,
      E.allowModel,
      el('p', { class: 'connect-app-meta', text: 'Allow only if the iPhone shows the same four digits.' }),
      E.allowCode,
      E.allowScopes,
      E.allowError,
      el('div', { class: 'connect-app-actions' }, [E.denyBtn, E.allowBtn]),
      E.allowQueue,
    ]);
    E.allowOverlay = el('div', { class: 'connect-app-overlay connect-app-allow-overlay', id: 'connect-app-allow-overlay', hidden: true }, [E.allowDialog]);

    document.body.appendChild(E.overlay);
    document.body.appendChild(E.allowOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!E.allowOverlay.hidden) { hideAllow(); e.stopPropagation(); return; }
      if (!E.overlay.hidden) { close(); e.stopPropagation(); }
    }, true);
  }

  // ── Connect tab ────────────────────────────────────────────────────────────

  /** Show one of the three connect states. */
  function showConnectState(which, message) {
    const E = state.els;
    E.off.hidden = which !== 'off';
    E.error.hidden = which !== 'error';
    E.pairing.hidden = which !== 'pairing';
    if (which === 'error') E.errorText.textContent = message || 'The phone connection could not start.';
  }

  /** Render the current offer: QR, code, computer name, countdown. */
  async function renderOffer(offer) {
    const E = state.els;
    state.offer = offer;
    E.code.textContent = offer.manualCode;
    E.computer.textContent = offer.tailscaleName || offer.computerName;
    E.qr.textContent = '';
    try {
      // Dark modules on white with a 4 module quiet zone, error correction M,
      // in every theme (PROTOCOL.md 2.3): drawn by the bundled qrcode library.
      const svg = await window.QRCode.toString(offer.qrLink, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: QR_QUIET_MODULES,
        width: QR_SIZE_PX,
        color: { dark: QR_DARK, light: QR_LIGHT },
      });
      E.qr.innerHTML = svg; // generated SVG markup from our own link, no phone input
    } catch (_) {
      E.qr.textContent = 'The code could not be drawn. Use the manual code.';
    }
    tick();
  }

  /** Update "Refreshes in m:ss" and fetch a new offer when due. */
  function tick() {
    if (!state.open || !state.offer) return;
    const left = state.offer.refreshAtMs - Date.now();
    state.els.countdown.textContent = 'Refreshes in ' + formatCountdown(left);
    if (left <= 0 && !state.refreshing) {
      state.refreshing = true;
      createOffer().finally(() => { state.refreshing = false; });
    }
  }

  /** Ask for a new offer; older ones stay valid until they expire. */
  async function createOffer() {
    try {
      const offer = await api('POST', '/api/mobile-admin/pair-offers');
      if (!state.open) {
        api('DELETE', '/api/mobile-admin/pair-offers/' + encodeURIComponent(offer.offerId)).catch(() => {});
        return;
      }
      state.offerIds.push(offer.offerId);
      showConnectState('pairing');
      await renderOffer(offer);
    } catch (err) {
      if (err.code === 'LISTENER_OFF') refreshStatusAndOffer();
      else showConnectState('error', err.message);
    }
  }

  /** Read the admin status, then show the off state, an error, or a QR. */
  async function refreshStatusAndOffer() {
    let status;
    try {
      status = await api('GET', '/api/mobile-admin/status');
    } catch (err) {
      showConnectState('error', err.message);
      return;
    }
    state.els.identityNote.hidden = !(status.identity && status.identity.replacedWhilePaired);
    if (!status.listener.enabled) return showConnectState('off');
    if (!status.listener.running) {
      return showConnectState('error', 'The phone connection could not start: ' + (status.listener.error || 'unknown error'));
    }
    await createOffer();
  }

  /** "Turn on": PUT settings {enabled: true}, then show the QR. */
  async function turnOn() {
    state.els.turnOnBtn.disabled = true;
    try {
      await api('PUT', '/api/mobile-admin/settings', { enabled: true });
      await refreshStatusAndOffer();
    } catch (err) {
      showConnectState('error', 'The phone connection could not start: ' + err.message);
    } finally {
      state.els.turnOnBtn.disabled = false;
    }
  }

  // ── Devices tab ────────────────────────────────────────────────────────────

  /** Load and render the device list. */
  async function loadDevices() {
    const E = state.els;
    let data;
    try {
      data = await api('GET', '/api/mobile-admin/devices');
    } catch (err) {
      E.devices.textContent = '';
      E.devices.appendChild(el('p', { class: 'connect-app-error-text', text: err.message }));
      return;
    }
    E.devices.textContent = '';
    if (!data.devices.length) {
      E.devices.appendChild(el('p', { class: 'connect-app-empty', text: 'No phones yet. Scan the code on the Connect tab with the Myrlin app.' }));
      return;
    }
    for (const d of data.devices) E.devices.appendChild(deviceRow(d));
  }

  /**
   * One device row.
   *
   * @param {object} d - AdminDevice.
   * @returns {HTMLElement}
   */
  function deviceRow(d) {
    const now = Date.now();
    const scopes = el('div', { class: 'connect-app-row-scopes' });
    for (const s of SCOPES) {
      const box = el('input', { type: 'checkbox', value: s.id, checked: d.scopes.includes(s.id), 'data-device-id': d.deviceId });
      box.addEventListener('change', () => patchScopes(d, scopes, box));
      scopes.appendChild(el('label', { class: 'connect-app-scope-inline' }, [box, el('span', { text: s.label })]));
    }
    const status = el('p', { class: 'connect-app-meta connect-app-row-status', 'aria-live': 'polite' });
    const testBtn = el('button', { class: 'connect-app-btn', type: 'button', 'data-device-id': d.deviceId, 'data-action': 'test-push' }, ['Test push']);
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        await api('POST', '/api/mobile-admin/devices/' + encodeURIComponent(d.deviceId) + '/test-push');
        status.textContent = 'Test notification sent.';
      } catch (err) {
        status.textContent = err.message;
      } finally {
        testBtn.disabled = false;
      }
    });
    const confirm = el('div', { class: 'connect-app-confirm', hidden: true }, [
      el('p', { class: 'connect-app-lede', text: 'Revoke ' + d.name + '? It disconnects now and must scan again.' }),
      el('div', { class: 'connect-app-actions' }, [
        el('button', { class: 'connect-app-btn', type: 'button', onclick: () => { confirm.hidden = true; } }, ['Cancel']),
        el('button', { class: 'connect-app-btn-danger', type: 'button', 'data-device-id': d.deviceId, 'data-action': 'revoke-confirm', onclick: async () => {
          try {
            await api('DELETE', '/api/mobile-admin/devices/' + encodeURIComponent(d.deviceId));
            loadDevices();
          } catch (err) {
            status.textContent = err.message;
          }
        } }, ['Revoke']),
      ]),
    ]);
    const revokeBtn = el('button', { class: 'connect-app-btn-danger-quiet', type: 'button', 'data-device-id': d.deviceId, 'data-action': 'revoke', onclick: () => { confirm.hidden = false; } }, ['Revoke']);
    const auditList = el('ol', { class: 'connect-app-audit' });
    const details = el('details', { class: 'connect-app-details' }, [el('summary', { text: 'Recent actions' }), auditList]);
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      auditList.textContent = '';
      try {
        const data = await api('GET', '/api/mobile-admin/devices/' + encodeURIComponent(d.deviceId) + '/audit?limit=' + AUDIT_ROWS);
        if (!data.entries.length) auditList.appendChild(el('li', { class: 'connect-app-meta', text: 'Nothing yet.' }));
        for (const e of data.entries) {
          const when = new Date(e.ts);
          auditList.appendChild(el('li', {}, [
            el('span', { class: 'connect-app-mono', text: when.toLocaleString() }),
            ' ',
            el('span', { text: e.action + (e.detail ? ': ' + e.detail : '') + (e.ok ? '' : ' (refused)') }),
          ]));
        }
      } catch (err) {
        auditList.appendChild(el('li', { class: 'connect-app-error-text', text: err.message }));
      }
    });
    return el('article', { class: 'connect-app-device', 'data-device-id': d.deviceId }, [
      el('div', { class: 'connect-app-device-head' }, [
        el('div', {}, [
          el('h3', { class: 'connect-app-device-name', text: d.name }),
          el('p', { class: 'connect-app-meta', text: modelWords(d.model) + ', iOS ' + d.osVersion + (d.online ? ', connected now' : '') }),
        ]),
        el('div', { class: 'connect-app-actions' }, [testBtn, revokeBtn]),
      ]),
      el('p', { class: 'connect-app-meta' }, [
        formatPaired(d.pairedAtMs, now) + '. ' + formatLastSeen(d.lastSeenAtMs, now) + ', ' + pathWords(d.lastEndpointKind) + '. ' + pushWords(d) + '.',
      ]),
      scopes,
      confirm,
      status,
      details,
    ]);
  }

  /** PATCH a device's scopes at once from its checkboxes. */
  async function patchScopes(d, container, changed) {
    const scopes = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter((b) => b.checked).map((b) => b.value);
    try {
      await api('PATCH', '/api/mobile-admin/devices/' + encodeURIComponent(d.deviceId), { scopes });
    } catch (err) {
      changed.checked = !changed.checked;
      window.alert(err.message);
    }
  }

  // ── Allow dialog ───────────────────────────────────────────────────────────

  /** Show the next queued request, if any. */
  function showNextAllow() {
    const E = state.els;
    if (state.allowCurrent || !state.allowQueue.length) return;
    const req = state.allowQueue.shift();
    state.allowCurrent = req;
    E.allowTitle.textContent = 'Allow ' + req.deviceName + ' to connect?';
    E.allowModel.textContent = modelWords(req.model) + ', iOS ' + req.osVersion + ', Myrlin ' + req.appVersion;
    E.allowCode.textContent = '';
    for (const digit of String(req.matchCode)) E.allowCode.appendChild(el('span', { class: 'connect-app-digit', text: digit }));
    for (const box of E.allowScopes.querySelectorAll('input[data-scope]')) box.checked = true;
    E.allowError.hidden = true;
    E.allowBtn.disabled = false;
    E.denyBtn.disabled = false;
    E.allowQueue.hidden = state.allowQueue.length === 0;
    E.allowQueue.textContent = state.allowQueue.length === 1 ? 'One more phone is waiting.' : state.allowQueue.length + ' more phones are waiting.';
    E.allowOverlay.hidden = false;
    E.allowDialog.focus();
  }

  /** Close the dialog without a choice (the pair stays pending until it expires). */
  function hideAllow() {
    state.els.allowOverlay.hidden = true;
    state.allowCurrent = null;
    showNextAllow();
  }

  /**
   * Allow or Deny the current request.
   *
   * @param {'allow'|'deny'} choice - Decision.
   */
  async function decide(choice) {
    const E = state.els;
    const req = state.allowCurrent;
    if (!req) return;
    E.allowBtn.disabled = true;
    E.denyBtn.disabled = true;
    const scopes = Array.from(E.allowScopes.querySelectorAll('input[data-scope]')).filter((b) => b.checked).map((b) => b.value);
    try {
      if (choice === 'allow') {
        await api('POST', '/api/mobile-admin/pair-requests/' + encodeURIComponent(req.pairId) + '/allow', { scopes, name: null });
        if (state.open) {
          E.connected.textContent = req.deviceName + ' is connected.';
          E.connected.hidden = false;
        }
      } else {
        await api('POST', '/api/mobile-admin/pair-requests/' + encodeURIComponent(req.pairId) + '/deny');
      }
      hideAllow();
      if (state.open && state.tab === 'devices') loadDevices();
    } catch (err) {
      E.allowError.textContent = err.code === 'PAIR_EXPIRED' || err.code === 'PAIR_UNKNOWN'
        ? 'This request is no longer waiting. Scan the code again on the iPhone.'
        : err.message;
      E.allowError.hidden = false;
      E.denyBtn.disabled = false;
      E.denyBtn.textContent = 'Close';
      E.denyBtn.onclick = () => { E.denyBtn.textContent = 'Deny'; E.denyBtn.onclick = null; hideAllow(); };
    }
  }

  /**
   * Queue a pending request unless it is already shown or queued.
   *
   * @param {object} summary - PairRequestSummary.
   */
  function queueRequest(summary) {
    if (!summary || !summary.pairId) return;
    if (state.allowCurrent && state.allowCurrent.pairId === summary.pairId) return;
    if (state.allowQueue.some((r) => r.pairId === summary.pairId)) return;
    state.allowQueue.push(summary);
    build();
    showNextAllow();
  }

  /** Re-read pending requests (SSE events may be coalesced while a modal is open). */
  async function syncPending() {
    try {
      const data = await api('GET', '/api/mobile-admin/pair-requests');
      for (const p of data.pending) queueRequest(p);
    } catch (_) { /* not signed in, or the route is unavailable */ }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Switch between the Connect and Devices tabs.
   *
   * @param {'connect'|'devices'} tab - Tab.
   */
  function switchTab(tab) {
    const E = state.els;
    state.tab = tab;
    E.tabConnect.setAttribute('aria-selected', String(tab === 'connect'));
    E.tabDevices.setAttribute('aria-selected', String(tab === 'devices'));
    E.panelConnect.hidden = tab !== 'connect';
    E.panelDevices.hidden = tab !== 'devices';
    if (tab === 'devices') loadDevices();
  }

  /**
   * Open the Connect app modal (app.js S15 calls this from the header button).
   *
   * @param {object} [app] - The CWMApp instance.
   */
  function open(app) {
    if (app) state.app = app;
    build();
    state.open = true;
    state.offer = null;
    state.els.connected.hidden = true;
    state.els.overlay.hidden = false;
    switchTab('connect');
    showConnectState('pairing');
    state.els.code.textContent = '';
    state.els.computer.textContent = '';
    state.els.countdown.textContent = '';
    state.els.qr.textContent = '';
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(tick, TICK_MS);
    refreshStatusAndOffer();
    syncPending();
    state.els.closeBtn.focus();
  }

  /** Close the modal and withdraw every offer it created (PROTOCOL.md 11.3). */
  function close() {
    if (!state.built) return;
    state.open = false;
    state.els.overlay.hidden = true;
    clearInterval(state.tickTimer);
    state.tickTimer = null;
    const ids = state.offerIds.splice(0);
    for (const id of ids) api('DELETE', '/api/mobile-admin/pair-offers/' + encodeURIComponent(id)).catch(() => {});
    state.offer = null;
  }

  /**
   * Handle a main server SSE event (app.js S16): {type, data}.
   *
   * @param {object} evt - The SSE message.
   */
  function onEvent(evt) {
    if (!evt || !evt.type) return;
    const data = evt.data || {};
    if (evt.type === 'mobile:pair-request') {
      queueRequest(data);
      syncPending();
    } else if (evt.type === 'mobile:pair-resolved') {
      state.allowQueue = state.allowQueue.filter((r) => r.pairId !== data.pairId);
      if (state.allowCurrent && state.allowCurrent.pairId === data.pairId && state.built) hideAllow();
    } else if (evt.type === 'mobile:devices-changed') {
      if (state.open && state.tab === 'devices') loadDevices();
    }
  }

  window.MyrlinConnectApp = {
    open,
    close,
    onEvent,
    _fmt: { formatCountdown, formatPaired, formatLastSeen, modelWords, pathWords, pushWords },
    _constants: { OFFER_REFRESH_MS, QR_SIZE_PX, QR_QUIET_MODULES, QR_DARK, QR_LIGHT, SCOPES },
  };
})();
