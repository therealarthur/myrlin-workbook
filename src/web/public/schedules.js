/**
 * Schedule popover, anchors under a pane's clock button and shows a small
 * Active / History form + list. One shared instance, repositioned on each open.
 *
 * Usage: SchedulePopover.toggle(anchorEl, sessionId)
 *        SchedulePopover.close()
 */
const SCHEDULE_ICON_ONCE = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z\"/><path d=\"M8 5v3.25l2 1.25\"/></svg>";
const SCHEDULE_ICON_REPEAT = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M3 8a5 5 0 0 1 8.5-3.5L13 6\"/><path d=\"M13 3v3h-3\"/><path d=\"M13 8a5 5 0 0 1-8.5 3.5L3 10\"/><path d=\"M3 13v-3h3\"/></svg>";
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  const SchedulePopover = {
    el: null,                // root popover element
    activeTab: 'active',     // 'active' | 'history'
    sessionId: null,
    anchor: null,
    _docHandlers: null,
    _tickerHandle: null,
    _pollHandle: null,
    _latestActive: null,

    toggle(anchorEl, sessionId) {
      if (this.el && this.anchor === anchorEl) {
        this.close();
        return;
      }
      this.open(anchorEl, sessionId);
    },

    open(anchorEl, sessionId) {
      // If already open on a different anchor, close first.
      if (this.el) this.close();
      this.sessionId = sessionId;
      this.anchor = anchorEl;
      this._build();
      this._setTab('active');
      this._reposition();
      this._render();
      this._installDocHandlers();
      this._startPoller();
    },

    close() {
      if (!this.el) return;
      if (this._tickerHandle) { clearInterval(this._tickerHandle); this._tickerHandle = null; }
      this._stopPoller();
      this.el.remove();
      this.el = null;
      this.sessionId = null;
      this.anchor = null;
      this._removeDocHandlers();
    },

    _build() {
      const root = document.createElement('div');
      root.className = 'schedule-popover';
      root.innerHTML = `
        <div class="schedule-popover-tabs">
          <button class="schedule-popover-tab active" data-tab="active">Active</button>
          <button class="schedule-popover-tab" data-tab="history">History</button>
        </div>
        <div class="schedule-popover-body" data-body></div>
      `;
      root.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.schedule-popover-tab');
        if (tabBtn) {
          this._setTab(tabBtn.dataset.tab);
          this._render();
        }
      });
      // Stop clicks inside from bubbling to the document outside-handler
      root.addEventListener('mousedown', (e) => e.stopPropagation());
      document.body.appendChild(root);
      this.el = root;
    },

    _setTab(tab) {
      this.activeTab = tab;
      this.el.querySelectorAll('.schedule-popover-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
    },

    _reposition() {
      if (!this.el || !this.anchor) return;
      const r = this.anchor.getBoundingClientRect();
      const margin = 8;
      const popW = this.el.offsetWidth || 360;
      const popH = this.el.offsetHeight || 320;
      // The schedule button floats at the bottom-right of the pane, so the
      // popover opens above-and-left of it (right edge aligned to button's
      // right edge, bottom edge above the button with a margin).
      let left = r.right - popW;
      let top = r.top - popH - margin;
      // If there isn't enough room above, fall back to opening below.
      if (top < 8) top = r.bottom + margin;
      // Clamp inside viewport horizontally.
      if (left < 8) left = 8;
      const maxLeft = window.innerWidth - popW - 8;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      this.el.style.left = `${left}px`;
      this.el.style.top = `${top}px`;
    },

    _render() {
      const body = this.el.querySelector('[data-body]');
      if (this.activeTab === 'active') {
        body.innerHTML = this._renderActive();
        this._wireFormHandlers(body);
        this._refreshList();
      } else {
        body.innerHTML = `<div class="schedule-list" data-history></div>`;
        this._refreshHistory();
      }
      // Reposition after content drops in, the popover height changes,
      // and we anchor the bottom above the button.
      this._reposition();
    },

    _renderActive() {
      // Pre-fill the date with today's local date; leave time empty so the
      // user has to pick it deliberately (datetime-local can't hold a date-only value).
      const now = new Date();
      const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return `
        <form class="schedule-form" data-form>
          <label>Message
            <input type="text" name="command" maxlength="2048" placeholder="Message.." required />
          </label>
          <label>When</label>
          <div class="row">
            <label><input type="radio" name="when" value="in" checked /> in</label>
            <input class="num" type="number" name="delayN" min="1" value="5" />
            <select class="unit" name="delayUnit">
              <option value="s">sec</option>
              <option value="m" selected>min</option>
              <option value="h">hr</option>
              <option value="d">day</option>
            </select>
          </div>
          <div class="row">
            <label><input type="radio" name="when" value="at" /> at</label>
            <input class="date" type="date" name="fireDate" value="${todayLocal}" />
            <input class="time" type="time" name="fireTime" />
          </div>
          <label class="row">
            <input type="checkbox" name="repeat" />
            <span>Repeat (use the delay above as the interval)</span>
          </label>
          <div class="form-error" data-form-error style="color: var(--red); font-size: 11px; min-height: 14px;"></div>
          <div class="actions">
            <button type="button" data-cancel class="btn btn-ghost btn-sm">Cancel</button>
            <button type="submit" data-save class="btn btn-primary btn-sm">Save</button>
          </div>
        </form>
        <div class="schedule-list" data-list></div>
      `;
    },

    _wireFormHandlers(body) {
      const form = body.querySelector('[data-form]');
      const errorEl = body.querySelector('[data-form-error]');
      const repeatBox = form.querySelector('input[name="repeat"]');
      // Auto-focus the message field so the user can start typing immediately.
      const msgInput = form.querySelector('input[name="command"]');
      if (msgInput) setTimeout(() => msgInput.focus(), 0);
      const inMode = () => form.querySelector('input[name="when"]:checked').value === 'in';
      const updateRepeatEnable = () => {
        repeatBox.disabled = !inMode();
        if (!inMode()) repeatBox.checked = false;
      };
      form.querySelectorAll('input[name="when"]').forEach(r => r.addEventListener('change', updateRepeatEnable));
      updateRepeatEnable();

      form.querySelector('[data-cancel]').addEventListener('click', () => {
        form.reset();
        errorEl.textContent = '';
        updateRepeatEnable();
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        const fd = new FormData(form);
        const command = (fd.get('command') || '').toString();
        const when = fd.get('when');
        const repeat = !!fd.get('repeat');
        let payload;
        if (when === 'in') {
          const n = Number(fd.get('delayN'));
          const unit = fd.get('delayUnit');
          const ms = SchedulePopover._unitToMs(n, unit);
          if (!Number.isFinite(ms) || ms < 1000) { errorEl.textContent = 'Delay must be at least 1 second'; return; }
          payload = { command, kind: repeat ? 'recurring' : 'once', delayMs: ms };
        } else {
          const date = (fd.get('fireDate') || '').toString();
          const time = (fd.get('fireTime') || '').toString();
          if (!date) { errorEl.textContent = 'Pick a date'; return; }
          if (!time) { errorEl.textContent = 'Pick a time'; return; }
          const fireAt = new Date(`${date}T${time}`).getTime();
          if (!Number.isFinite(fireAt)) { errorEl.textContent = 'Invalid date/time'; return; }
          payload = { command, kind: 'once', fireAt };
        }
        try {
          const res = await SchedulePopover._fetch('POST', '', payload);
          if (!res.ok) {
            errorEl.textContent = (res.json && res.json.error) || `Save failed (${res.status})`;
            return;
          }
          form.reset();
          updateRepeatEnable();
          await this._refreshList();
          this._refreshBadge();
          if (window.cwm && window.cwm.refreshScheduleIndicators) window.cwm.refreshScheduleIndicators();
        } catch (err) {
          errorEl.textContent = err.message || 'Network error';
        }
      });
    },

    async _refreshList() {
      const listEl = this.el && this.el.querySelector('[data-list]');
      if (!listEl) return;
      const res = await SchedulePopover._fetch('GET', '');
      if (!res.ok) {
        listEl.innerHTML = `<div class="schedule-empty">Failed to load (${res.status})</div>`;
        this._reposition();
        return;
      }
      const active = (res.json && res.json.active) || [];
      this._latestActive = active;
      this._renderList(listEl, active);
      this._refreshBadge(active.length);
      this._restartTicker();
      this._reposition();
    },

    _renderList(listEl, active) {
      if (active.length === 0) {
        listEl.innerHTML = `<div class="schedule-empty">No active schedules</div>`;
        return;
      }
      const rows = active.map(s => `
        <div class="schedule-row" data-id="${s.id}">
          <span class="glyph">${s.kind === 'once' ? SCHEDULE_ICON_ONCE : SCHEDULE_ICON_REPEAT}</span>
          <span class="label">${escapeHtml(s.command)}</span>
          <span class="when" data-when data-next="${s.nextFireAt}" data-kind="${s.kind}" data-delay="${s.delayMs || 0}"></span>
          <button class="trash" title="Delete"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 4.5h9"/><path d="M6.5 4.5V3h3v1.5"/><path d="M4.75 4.5l.6 8h5.3l.6-8"/></svg></button>
        </div>
      `).join('');
      listEl.innerHTML = `<div class="schedule-list-header">Active (${active.length})</div>${rows}`;
      listEl.querySelectorAll('.trash').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const row = btn.closest('.schedule-row');
          if (!row) return;
          if (!window.confirm('Delete this schedule?')) return;
          const id = row.dataset.id;
          await SchedulePopover._fetch('DELETE', '/' + id);
          await this._refreshList();
          if (window.cwm && window.cwm.refreshScheduleIndicators) window.cwm.refreshScheduleIndicators();
        });
      });
      this._tickRelativeLabels(listEl);
    },

    _tickRelativeLabels(listEl) {
      const now = Date.now();
      listEl.querySelectorAll('[data-when]').forEach(el => {
        const next = Number(el.dataset.next);
        const kind = el.dataset.kind;
        const delay = Number(el.dataset.delay);
        if (kind === 'recurring') {
          el.textContent = '· every ' + SchedulePopover._fmtDuration(delay);
        } else {
          const ms = next - now;
          el.textContent = '· in ' + SchedulePopover._fmtDuration(ms);
        }
      });
    },

    _restartTicker() {
      if (this._tickerHandle) clearInterval(this._tickerHandle);
      this._tickerHandle = setInterval(() => {
        const listEl = this.el && this.el.querySelector('[data-list]');
        if (!listEl) return;
        this._tickRelativeLabels(listEl);
      }, 1000);
    },

    _refreshBadge(count) {
      if (!this.anchor) return;
      const badge = this.anchor.querySelector('.pane-schedule-count');
      if (!badge) return;
      const n = Number.isFinite(count) ? count : (this._latestActive ? this._latestActive.length : 0);
      if (n > 0) {
        badge.textContent = String(n);
        badge.hidden = false;
      } else {
        badge.textContent = '';
        badge.hidden = true;
      }
    },

    async _refreshHistory() {
      const histEl = this.el && this.el.querySelector('[data-history]');
      if (!histEl) return;
      const res = await SchedulePopover._fetch('GET', '');
      if (!res.ok) {
        histEl.innerHTML = `<div class="schedule-empty">Failed to load (${res.status})</div>`;
        this._reposition();
        return;
      }
      const rows = (res.json && res.json.history) || [];
      if (rows.length === 0) {
        histEl.innerHTML = `<div class="schedule-empty">No history yet</div>`;
        this._reposition();
        return;
      }
      const now = Date.now();
      const html = rows.map(r => {
        const ago = SchedulePopover._fmtAgo(now - r.firedAt);
        if (r.status === 'success') {
          return `<div class="schedule-row">
            <span class="glyph" style="color:var(--green)">✓</span>
            <span class="label">${escapeHtml(r.command)}</span>
            <span class="when">· ${ago}</span>
          </div>`;
        }
        const reason =
          r.skipReason === 'session-not-running' ? 'session not running'
          : r.skipReason === 'missed-while-down' ? 'missed while server down'
          : 'skipped';
        const count = r.skipCount > 1 ? `Skipped ${r.skipCount}: ${reason}` : `Skipped: ${reason}`;
        return `<div class="schedule-row">
          <span class="glyph" style="color:var(--peach)">⊘</span>
          <span class="label" style="color:var(--subtext0)">${escapeHtml(count)}</span>
          <span class="when">· ${ago}</span>
        </div>`;
      }).join('');
      histEl.innerHTML = html;
      this._reposition();
    },

    _fmtAgo(ms) {
      if (ms < 60_000) return Math.max(1, Math.floor(ms / 1000)) + 's ago';
      if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
      if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
      return Math.floor(ms / 86_400_000) + 'd ago';
    },

    _startPoller() {
      this._stopPoller();
      this._pollHandle = setInterval(() => {
        if (!this.el) return;
        if (this.activeTab === 'active') this._refreshList();
        else this._refreshHistory();
      }, 5000);
    },

    _stopPoller() {
      if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
    },

    _installDocHandlers() {
      const onKey = (e) => { if (e.key === 'Escape') this.close(); };
      const onMouse = (e) => {
        if (!this.el) return;
        if (this.el.contains(e.target)) return;
        if (this.anchor && this.anchor.contains(e.target)) return;
        this.close();
      };
      const onResize = () => this._reposition();
      document.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onMouse);
      window.addEventListener('resize', onResize);
      this._docHandlers = { onKey, onMouse, onResize };
    },

    _removeDocHandlers() {
      if (!this._docHandlers) return;
      document.removeEventListener('keydown', this._docHandlers.onKey);
      document.removeEventListener('mousedown', this._docHandlers.onMouse);
      window.removeEventListener('resize', this._docHandlers.onResize);
      this._docHandlers = null;
    },

    _unitToMs(n, unit) {
      const map = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
      const u = map[unit];
      if (!u) return NaN;
      return Math.floor(n * u);
    },

    _fmtDuration(ms) {
      if (ms <= 0) return 'now';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + (m % 60) + 'm';
      const d = Math.floor(h / 24);
      return d + 'd ' + (h % 24) + 'h';
    },

    async _fetch(method, suffix, body) {
      const url = `/api/sessions/${encodeURIComponent(this.sessionId)}/schedules${suffix}`;
      const opts = {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      };
      const token = (window.cwm && window.cwm.state && window.cwm.state.token) || window.AUTH_TOKEN;
      if (token) opts.headers.authorization = 'Bearer ' + token;
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, json };
    },
  };

  window.SchedulePopover = SchedulePopover;
})();
