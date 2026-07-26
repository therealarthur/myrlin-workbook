/**
 * MirrorPaneView: read-only live mirror of an externally-started provider
 * session, rendered inside a terminal-grid pane view container.
 *
 * Issue #10 (session mirror, Tier 1) Phase 4. The view owns exactly one
 * mirror subscription: it POSTs /api/mirror/open on mount (and again on SSE
 * reconnect via reopen(), which is idempotent server-side), renders the
 * returned history, then applies live mirror:* SSE events routed to it by
 * CWMApp.handleSSEEvent via handleEvent(). dispose() POSTs /api/mirror/close.
 *
 * Provider-agnostic by construction: the provider id arrives as data and is
 * only used for API payloads and data-provider styling hooks; no provider
 * name literals live here (grep gate: test/grep-gate.test.js).
 *
 * SECURITY: every piece of transcript text is routed through the injected
 * escapeHtml before touching innerHTML. The text is the user's own
 * conversation, but transcripts embed arbitrary tool output (HTML, script
 * tags, prompt-injection payloads), so the renderer treats ALL of it as
 * hostile.
 *
 * Duplicate/gap handling (history vs live sequencing): open() returns
 * history ending at endOffset; every mirror:message batch carries
 * [prevOffset, offset). The view keeps _offset and applies:
 *   offset <= _offset          -> duplicate of history/earlier batch: skip
 *   prevOffset == _offset      -> contiguous: append, advance
 *   prevOffset == null         -> post-truncate reseed: accept, advance
 *   anything else              -> gap or partial overlap (dropped SSE frame,
 *                                 open/append race): reopen() to resync.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

/* eslint-disable no-unused-vars */

// ─── Named constants ─────────────────────────────────────────────────────────

/** Pixels of slack when deciding the list is "pinned" to the bottom. */
const MIRROR_VIEW_AUTOSCROLL_SLACK_PX = 48;

/** Max characters of tool text shown in a collapsed <details> summary. */
const MIRROR_VIEW_TOOL_SUMMARY_CHARS = 96;

/** Max rendered messages kept in the DOM; older nodes are pruned. */
const MIRROR_VIEW_MAX_DOM_MESSAGES = 600;

/** Number of skeleton rows shown while the initial open() is in flight. */
const MIRROR_VIEW_SKELETON_ROWS = 4;

class MirrorPaneView {
  /**
   * @param {HTMLElement} container - The pane-view container to render into.
   * @param {object} opts
   * @param {string} opts.provider - Provider id (from the element dataset,
   *   never a literal).
   * @param {string} opts.providerSessionId - Upstream session id to mirror.
   * @param {string} [opts.title] - Display title for the header.
   * @param {{pinnedToBottom:boolean,scrollTop:number}|null} [opts.scrollState]
   *   Saved reading position from a tab-group or layout transition.
   * @param {(method: string, path: string, body?: object) => Promise<object>} opts.api
   *   CWMApp.api bound to the app (carries auth).
   * @param {(str: string) => string} opts.escapeHtml - HTML escaper.
   * @param {string} opts.deviceId - This tab's SSE device id.
   */
  constructor(container, opts) {
    const o = opts || {};
    this.container = container;
    this.provider = String(o.provider || '');
    this.providerSessionId = String(o.providerSessionId || '');
    this.title = o.title || this.providerSessionId;
    this._restoreScrollState = o.scrollState || null;
    this._api = o.api;
    this._esc = o.escapeHtml;
    this.deviceId = String(o.deviceId || '');

    /** @type {number|null} Byte offset of the newest rendered content. */
    this._offset = null;
    /** @type {number} Byte offset of the oldest rendered content. */
    this._startOffset = 0;
    /** @type {boolean} Older history exists beyond _startOffset. */
    this._truncatedHead = false;
    /** @type {boolean} open() completed at least once (gates reopen-on-SSE-reconnect). */
    this._openedOnce = false;
    /** @type {boolean} A resync open() is already in flight. */
    this._resyncing = false;
    /** @type {boolean} dispose() ran; ignore all further events. */
    this._disposed = false;

    // DOM refs, populated by _renderShell.
    this._elRoot = null;
    this._elHeader = null;
    this._elLiveDot = null;
    this._elMessages = null;
    this._elLoadEarlier = null;

    this._renderShell();
  }

  /** The mirror key this view subscribes to (matches the server's shape). */
  get mirrorKey() {
    return this.provider + ':' + this.providerSessionId;
  }

  /**
   * Serializable descriptor used by the pane-layout persistence so a
   * restored layout can re-open this exact mirror.
   *
   * @returns {{provider:string, providerSessionId:string, title:string,
   *   scrollState:{pinnedToBottom:boolean,scrollTop:number}}}
   */
  descriptor() {
    return {
      provider: this.provider,
      providerSessionId: this.providerSessionId,
      title: this.title,
      scrollState: this._captureScrollState(),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Open (or re-open) the mirror: POST /api/mirror/open, replace the message
   * list with the returned history, and resume live updates from endOffset.
   * Idempotent server-side, so it doubles as the SSE-reconnect resync path.
   *
   * @returns {Promise<void>} Resolves after the history renders; rejects on
   *   API failure AFTER rendering an inline error notice (callers may
   *   fire-and-forget).
   */
  async open() {
    if (this._disposed) return;
    const scrollState = this._openedOnce
      ? this._captureScrollState()
      : this._restoreScrollState;
    this._renderSkeleton();
    let res;
    try {
      res = await this._api('POST', '/api/mirror/open', {
        provider: this.provider,
        providerSessionId: this.providerSessionId,
        deviceId: this.deviceId,
      });
    } catch (err) {
      this._renderFatal((err && err.message) || 'Failed to open mirror');
      throw err;
    }
    if (this._disposed) return;
    this._openedOnce = true;
    this._offset = res.endOffset;
    this._startOffset = res.startOffset;
    this._truncatedHead = !!res.truncatedHead;
    this._setLive(!!res.live);
    this._elMessages.innerHTML = this._renderMessagesHtml(res.history || []);
    this._updateLoadEarlier();
    this._restoreScrollPosition(scrollState);
    this._restoreScrollState = null;
  }

  /**
   * Route one mirror:* SSE event to this view. The caller (CWMApp) already
   * matched mirrorKey, but the guard is repeated here so a routing bug can
   * never cross-pollinate two mirrors.
   *
   * @param {string} type - Event type ('mirror:message' | 'mirror:reset'
   *   | 'mirror:status' | 'mirror:closed').
   * @param {object} data - Event payload (carries mirrorKey).
   * @returns {void}
   */
  handleEvent(type, data) {
    if (this._disposed || !data || data.mirrorKey !== this.mirrorKey) return;
    switch (type) {
      case 'mirror:message': {
        const next = typeof data.offset === 'number' ? data.offset : null;
        const prev = typeof data.prevOffset === 'number' ? data.prevOffset : null;
        // Duplicate: the batch ends at-or-before what we already rendered
        // (typical right after a reopen, when the shared tailer re-covers
        // ground our fresh history snapshot already included).
        if (this._offset != null && next != null && next <= this._offset) return;
        // Gap or partial overlap: we cannot split a batch without per-line
        // offsets, so resync with an idempotent reopen. Rare by design
        // (server drains the tailer before every history snapshot).
        if (this._offset != null && prev != null && prev !== this._offset) {
          this._resync();
          return;
        }
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          this._appendMessages(data.messages);
        }
        if (next != null) this._offset = next;
        break;
      }
      case 'mirror:reset':
        // Transcript truncated/rotated: derived state is void. Clear and
        // accept the reseed batches unconditionally (prevOffset null).
        this._offset = null;
        this._elMessages.innerHTML = '';
        this._notice('Transcript was truncated upstream; re-synced to the new tail.');
        break;
      case 'mirror:status':
        this._setLive(!!data.live);
        break;
      case 'mirror:closed':
        this._setLive(false);
        this._notice(data.reason === 'gone'
          ? 'Transcript file disappeared; mirror closed.'
          : 'Mirror closed (' + this._esc(String(data.reason || 'server')) + ').');
        break;
      default:
        break;
    }
  }

  /**
   * Detach from the mirror: best-effort POST /api/mirror/close (the server
   * idle-sweep is the safety net if this never lands) and drop DOM refs.
   * Idempotent; safe to call twice.
   *
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      this._api('POST', '/api/mirror/close', {
        mirrorKey: this.mirrorKey,
        deviceId: this.deviceId,
      }).catch(() => { /* server sweep cleans up if this never lands */ });
    } catch (_) { /* fire and forget */ }
    if (this._elRoot && this._elRoot.parentNode) {
      this._elRoot.parentNode.removeChild(this._elRoot);
    }
    this._elRoot = null;
    this._elHeader = null;
    this._elLiveDot = null;
    this._elMessages = null;
    this._elLoadEarlier = null;
  }

  // ── History paging ────────────────────────────────────────────────────────

  /**
   * Fetch and prepend the previous history window (the "Load earlier"
   * button). Preserves the visual scroll position across the prepend so
   * the content the user was reading does not jump.
   *
   * @returns {Promise<void>}
   */
  async loadEarlier() {
    if (this._disposed || !this._truncatedHead) return;
    if (this._elLoadEarlier) this._elLoadEarlier.disabled = true;
    let res;
    try {
      res = await this._api('GET', '/api/mirror/history'
        + '?provider=' + encodeURIComponent(this.provider)
        + '&providerSessionId=' + encodeURIComponent(this.providerSessionId)
        + '&beforeOffset=' + encodeURIComponent(String(this._startOffset)));
    } catch (_) {
      if (this._elLoadEarlier) this._elLoadEarlier.disabled = false;
      this._notice('Could not load earlier history.');
      return;
    }
    if (this._disposed) return;
    this._startOffset = res.startOffset;
    this._truncatedHead = !!res.truncatedHead;
    const messages = Array.isArray(res.messages) ? res.messages : [];
    if (messages.length > 0) {
      // Anchor: keep the previously-visible content at the same viewport
      // position by compensating scrollTop with the height delta.
      const beforeHeight = this._elMessages.scrollHeight;
      this._elMessages.insertAdjacentHTML('afterbegin', this._renderMessagesHtml(messages));
      const delta = this._elMessages.scrollHeight - beforeHeight;
      this._elMessages.scrollTop += delta;
    }
    this._updateLoadEarlier();
  }

  // ── Internal rendering ────────────────────────────────────────────────────

  /**
   * Build the static shell: provider-accented header (pill, live dot,
   * title, read-only tag) above the scrollable message list with the
   * "Load earlier" button docked at its top.
   *
   * @returns {void}
   */
  _renderShell() {
    const esc = this._esc;
    const root = document.createElement('div');
    root.className = 'mirror-pane';
    root.dataset.provider = this.provider;
    root.dataset.mirrorKey = this.mirrorKey;
    root.innerHTML = `
      <div class="mirror-pane-header" data-provider="${esc(this.provider)}">
        <span class="mirror-provider-pill" data-provider="${esc(this.provider)}">${esc(this.provider)}</span>
        <span class="mirror-live-dot" data-live="false" title="Stale: no transcript writes in the last 2 min"></span>
        <span class="mirror-title" title="${esc(this.providerSessionId)}">${esc(this.title)}</span>
        <span class="mirror-readonly-tag" title="Tier 1 mirrors are watch-only; forking into an interactive session is a follow-up">read-only</span>
      </div>
      <button class="mirror-load-earlier" hidden>Load earlier</button>
      <div class="mirror-messages" aria-live="polite"></div>
    `;
    this.container.appendChild(root);
    this._elRoot = root;
    this._elHeader = root.querySelector('.mirror-pane-header');
    this._elLiveDot = root.querySelector('.mirror-live-dot');
    this._elMessages = root.querySelector('.mirror-messages');
    this._elLoadEarlier = root.querySelector('.mirror-load-earlier');
    this._elLoadEarlier.addEventListener('click', () => { this.loadEarlier(); });
  }

  /**
   * Map a MirrorMessage array to HTML. Central choke point: EVERY dynamic
   * string below passes through the injected escapeHtml.
   *
   * @param {Array} messages - MirrorMessages from the server.
   * @returns {string} Safe HTML.
   */
  _renderMessagesHtml(messages) {
    const esc = this._esc;
    const parts = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const text = typeof m.text === 'string' ? m.text : '';
      const ts = typeof m.timestamp === 'string' ? m.timestamp : '';
      const tsAttr = ts ? ' title="' + esc(ts) + '"' : '';
      const truncatedTag = m.truncated
        ? '<span class="mirror-truncated-tag" title="Message text was capped by the server">truncated</span>'
        : '';
      if (m.kind === 'tool_use' || m.kind === 'tool_result') {
        // Tools collapse to a <details>: summary carries the tool name (or
        // result marker) plus the first line of the payload.
        const label = m.kind === 'tool_use'
          ? (m.toolName ? esc(m.toolName) : 'tool')
          : 'result';
        const firstLine = text.split('\n')[0].slice(0, MIRROR_VIEW_TOOL_SUMMARY_CHARS);
        parts.push(
          '<details class="mirror-msg mirror-msg-tool" data-kind="' + esc(m.kind) + '"' + tsAttr + '>'
          + '<summary><span class="mirror-tool-name">' + label + '</span>'
          + '<span class="mirror-tool-first-line">' + esc(firstLine) + '</span></summary>'
          + '<pre class="mirror-tool-body">' + esc(text) + '</pre>' + truncatedTag
          + '</details>'
        );
      } else if (m.role === 'user') {
        parts.push('<div class="mirror-msg mirror-msg-user"' + tsAttr + '><div class="mirror-bubble">'
          + esc(text) + '</div>' + truncatedTag + '</div>');
      } else if (m.role === 'system') {
        parts.push('<div class="mirror-msg mirror-msg-system"' + tsAttr + '>' + esc(text) + truncatedTag + '</div>');
      } else {
        // assistant (and any unknown role, rendered neutrally)
        const modelTag = m.model
          ? '<span class="mirror-model-tag">' + esc(m.model) + '</span>'
          : '';
        parts.push('<div class="mirror-msg mirror-msg-assistant"' + tsAttr + '>'
          + esc(text) + modelTag + truncatedTag + '</div>');
      }
    }
    return parts.join('');
  }

  /**
   * Append live messages, autoscrolling ONLY when the user is already
   * pinned to the bottom (reading scrollback must never be yanked away).
   * Prunes the oldest DOM nodes past MIRROR_VIEW_MAX_DOM_MESSAGES so a
   * day-long mirror cannot grow the DOM unboundedly ("Load earlier" and
   * reopen re-fetch anything pruned).
   *
   * @param {Array} messages - MirrorMessages to append.
   * @returns {void}
   */
  _appendMessages(messages) {
    const pinned = this._isPinnedToBottom();
    this._elMessages.insertAdjacentHTML('beforeend', this._renderMessagesHtml(messages));
    while (this._elMessages.children.length > MIRROR_VIEW_MAX_DOM_MESSAGES) {
      this._elMessages.removeChild(this._elMessages.firstElementChild);
    }
    if (pinned) this._scrollToBottom();
  }

  /**
   * True when the scroll position is within the autoscroll slack of the
   * bottom (the user is following the live tail, not reading history).
   *
   * @returns {boolean}
   */
  _isPinnedToBottom() {
    const el = this._elMessages;
    if (!el) return true;
    return el.scrollHeight - (el.scrollTop + el.clientHeight) <= MIRROR_VIEW_AUTOSCROLL_SLACK_PX;
  }

  /** Capture enough state to preserve whether the user is reading history. */
  _captureScrollState() {
    const el = this._elMessages;
    if (!el) return { pinnedToBottom: true, scrollTop: 0 };
    return {
      pinnedToBottom: this._isPinnedToBottom(),
      scrollTop: Number.isFinite(el.scrollTop) ? el.scrollTop : 0,
    };
  }

  /** Restore a saved reading position, or follow the live tail by default. */
  _restoreScrollPosition(state) {
    if (!this._elMessages || !state || state.pinnedToBottom !== false) {
      this._scrollToBottom();
      return;
    }
    const requested = Number(state.scrollTop);
    this._elMessages.scrollTop = Number.isFinite(requested)
      ? Math.max(0, requested)
      : 0;
  }

  /** Jump the message list to its bottom (newest content). */
  _scrollToBottom() {
    if (this._elMessages) this._elMessages.scrollTop = this._elMessages.scrollHeight;
  }

  /**
   * Update the header live dot + tooltip. data-live drives the CSS pulse.
   *
   * @param {boolean} live
   * @returns {void}
   */
  _setLive(live) {
    if (!this._elLiveDot) return;
    this._elLiveDot.dataset.live = live ? 'true' : 'false';
    this._elLiveDot.title = live
      ? 'Live: transcript written within the last 2 min'
      : 'Stale: no transcript writes in the last 2 min';
  }

  /** Show or hide the "Load earlier" affordance based on truncatedHead. */
  _updateLoadEarlier() {
    if (!this._elLoadEarlier) return;
    this._elLoadEarlier.hidden = !this._truncatedHead;
    this._elLoadEarlier.disabled = false;
  }

  /**
   * Append an inline system notice (reset, closed, load failure). Escaped
   * like everything else even though most notices are static strings.
   *
   * @param {string} text
   * @returns {void}
   */
  _notice(text) {
    if (!this._elMessages) return;
    const pinned = this._isPinnedToBottom();
    this._elMessages.insertAdjacentHTML('beforeend',
      '<div class="mirror-msg mirror-msg-notice">' + this._esc(text) + '</div>');
    if (pinned) this._scrollToBottom();
  }

  /**
   * Replace the message list with skeleton placeholder rows while the
   * initial (or resync) open is in flight. Skeletons, never spinners,
   * per the design system.
   *
   * @returns {void}
   */
  _renderSkeleton() {
    if (!this._elMessages) return;
    let html = '';
    for (let i = 0; i < MIRROR_VIEW_SKELETON_ROWS; i++) {
      html += '<div class="mirror-skeleton-row" style="width:' + (55 + ((i * 17) % 40)) + '%"></div>';
    }
    this._elMessages.innerHTML = html;
  }

  /**
   * Render a fatal open failure inside the pane (the pane stays mounted so
   * the user can read the reason and close it).
   *
   * @param {string} message
   * @returns {void}
   */
  _renderFatal(message) {
    if (!this._elMessages) return;
    this._elMessages.innerHTML =
      '<div class="mirror-msg mirror-msg-notice mirror-msg-error">' + this._esc(message) + '</div>';
  }

  /**
   * Idempotent reopen used when the offset bookkeeping detects a gap or
   * partial overlap (dropped SSE frames, server restart). Collapses
   * concurrent triggers into one in-flight open.
   *
   * @returns {void}
   */
  _resync() {
    if (this._resyncing || this._disposed) return;
    this._resyncing = true;
    this.open()
      .catch(() => { /* _renderFatal already showed the failure */ })
      .finally(() => { this._resyncing = false; });
  }
}

// Exposed as a browser global (same pattern as TerminalPane in terminal.js).
window.MirrorPaneView = MirrorPaneView;
