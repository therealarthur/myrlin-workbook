/**
 * Workbook performance readout (browser half of src/web/perf-monitor.js).
 *
 * What: measures this page's own lag and reports it to the server every
 * 30 s (POST /api/perf/client): long animation frames with the scripts that
 * caused them (falls back to long tasks where the browser lacks them), slow
 * input events, JS heap, DOM size, and SSE and WebSocket message rates. Press
 * Ctrl+Alt+P for an overlay that shows the server's numbers (GET /api/perf)
 * next to these, with a button that profiles the server for 10 s.
 *
 * Why: the desktop lagged and the cause could be the server's main thread,
 * the page's main thread, or a flood of messages between them; this shows
 * which one, and the server writes the reports to perf.log.
 *
 * Loads before app.js so the EventSource and WebSocket wrappers see every
 * connection. Costs: one PerformanceObserver per entry type, one listener per
 * socket, one small POST every 30 s. No animation frame loop.
 */
(function () {
  'use strict';

  const REPORT_MS = 30000;
  const HUD_REFRESH_MS = 2000;
  const pageId = 'page-' + Math.random().toString(36).slice(2, 10);
  const startedAt = Date.now();

  /** Counters for the current report window. */
  let win = newWindow();
  function newWindow() {
    return {
      start: Date.now(),
      longFrames: { n: 0, ms: 0, max: 0, blockingMs: 0 },
      causes: new Map(),
      inputs: { n: 0, max: 0, byType: new Map() },
      sse: { n: 0, bytes: 0 },
      ws: { n: 0, bytes: 0 },
    };
  }
  /** The last finished window, shown by the overlay. */
  let lastReport = null;

  function bump(map, key, ms) {
    const e = map.get(key) || { n: 0, ms: 0, max: 0 };
    e.n += 1; e.ms += ms; if (ms > e.max) e.max = ms;
    map.set(key, e);
  }
  function topOf(map, limit) {
    return [...map.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit)
      .map(([key, e]) => ({ key, n: e.n, ms: Math.round(e.ms), max: Math.round(e.max) }));
  }
  const shortUrl = (u) => String(u || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');

  // Long animation frames (Chrome 123+) name the script behind each frame.
  let frameSource = 'none';
  try {
    const types = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
    if (types.includes('long-animation-frame')) {
      frameSource = 'long-animation-frame';
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const lf = win.longFrames;
          lf.n += 1; lf.ms += e.duration; lf.blockingMs += e.blockingDuration || 0;
          if (e.duration > lf.max) lf.max = e.duration;
          const scripts = e.scripts || [];
          if (!scripts.length) { bump(win.causes, '(rendering or style)', e.duration); continue; }
          for (const s of scripts) {
            const fn = s.sourceFunctionName || s.invoker || '(anon)';
            const where = shortUrl(s.sourceURL) + (s.sourceCharPosition >= 0 ? ':' + s.sourceCharPosition : '');
            bump(win.causes, fn + ' ' + where + (s.invokerType ? ' [' + s.invokerType + ']' : ''), s.duration);
          }
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } else if (types.includes('longtask')) {
      frameSource = 'longtask';
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const lf = win.longFrames;
          lf.n += 1; lf.ms += e.duration; if (e.duration > lf.max) lf.max = e.duration;
          bump(win.causes, '(long task, no attribution)', e.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    }
    if (types.includes('event')) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          win.inputs.n += 1;
          if (e.duration > win.inputs.max) win.inputs.max = e.duration;
          bump(win.inputs.byType, e.name, e.duration);
        }
      }).observe({ type: 'event', durationThreshold: 64, buffered: true });
    }
  } catch (_) { /* observers are optional */ }

  // Message rates: wrap the constructors so every connection is counted.
  try {
    const NativeES = window.EventSource;
    if (NativeES) {
      const Wrapped = function EventSource(url, cfg) {
        const es = new NativeES(url, cfg);
        es.addEventListener('message', (e) => { win.sse.n += 1; win.sse.bytes += (e.data && e.data.length) || 0; });
        return es;
      };
      Wrapped.prototype = NativeES.prototype;
      ['CONNECTING', 'OPEN', 'CLOSED'].forEach((k) => { Wrapped[k] = NativeES[k]; });
      window.EventSource = Wrapped;
    }
    const NativeWS = window.WebSocket;
    if (NativeWS) {
      const WrappedWS = function WebSocket(url, protocols) {
        const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
        ws.addEventListener('message', (e) => {
          win.ws.n += 1;
          const d = e.data;
          win.ws.bytes += typeof d === 'string' ? d.length : (d && (d.byteLength || d.size)) || 0;
        });
        return ws;
      };
      WrappedWS.prototype = NativeWS.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { WrappedWS[k] = NativeWS[k]; });
      window.WebSocket = WrappedWS;
    }
  } catch (_) { /* counting is optional */ }

  function token() {
    try { return (window.cwm && window.cwm.state && window.cwm.state.token) || localStorage.getItem('cwm_token'); } catch (_) { return null; }
  }
  async function call(method, url, body) {
    const t = token();
    if (!t) throw new Error('not signed in');
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function buildReport() {
    const secs = Math.max(1, (Date.now() - win.start) / 1000);
    let heapMb = null;
    try { if (performance.memory) heapMb = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (_) {}
    let domNodes = null;
    try { domNodes = document.getElementsByTagName('*').length; } catch (_) {}
    const lf = win.longFrames;
    return {
      seconds: Math.round(secs),
      visible: document.visibilityState === 'visible',
      frameSource,
      longFrames: { n: lf.n, ms: Math.round(lf.ms), max: Math.round(lf.max), blockingMs: Math.round(lf.blockingMs) },
      causes: topOf(win.causes, 8),
      inputs: { n: win.inputs.n, max: Math.round(win.inputs.max), byType: topOf(win.inputs.byType, 5) },
      ssePerMin: Math.round((win.sse.n / secs) * 60),
      sseKbPerMin: Math.round((win.sse.bytes / secs) * 60 / 1024),
      wsPerSec: Math.round((win.ws.n / secs) * 10) / 10,
      wsKbPerSec: Math.round((win.ws.bytes / secs) / 1024 * 10) / 10,
      heapMb,
      domNodes,
      terminals: (window.cwm && Array.isArray(window.cwm.terminalPanes)) ? window.cwm.terminalPanes.filter(Boolean).length : null,
      pageAgeMin: Math.round((Date.now() - startedAt) / 60000),
    };
  }

  async function report() {
    const r = buildReport();
    lastReport = r;
    win = newWindow();
    try { await call('POST', '/api/perf/client', { id: pageId, report: r }); } catch (_) { /* signed out or offline */ }
  }
  setInterval(report, REPORT_MS);

  // ─── Overlay (Ctrl+Alt+P) ─────────────────────────────────
  let hud = null;
  let hudTimer = null;
  let lastServer = null;
  let profileResult = null;
  let profileBusy = false;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = (list, fmt) => (list && list.length ? list.map(fmt).join('') : '<div class="wbperf-dim">none</div>');
  const row = (label, value, warn) => '<div class="wbperf-row' + (warn ? ' wbperf-warn' : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  const item = (text, ms) => '<div class="wbperf-item"><span>' + esc(text) + '</span><b>' + esc(ms) + '</b></div>';

  function injectStyle() {
    if (document.getElementById('wbperf-style')) return;
    const st = document.createElement('style');
    st.id = 'wbperf-style';
    st.textContent = [
      '#wbperf{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:min(460px,calc(100vw - 32px));max-height:72vh;overflow:auto;',
      'background:var(--bg-elevated,#1b1b1f);color:var(--text-primary,#e6e6e6);border:1px solid var(--border-default,#333);border-radius:10px;',
      'box-shadow:0 12px 40px rgba(0,0,0,.45);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 14px}',
      '#wbperf h4{margin:10px 0 4px;font:600 11px/1.2 inherit;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary,#a0a0a8)}',
      '#wbperf .wbperf-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}',
      '#wbperf .wbperf-head strong{font-size:13px}',
      '#wbperf button{font:inherit;color:inherit;background:var(--bg-tertiary,#26262b);border:1px solid var(--border-default,#333);border-radius:6px;padding:3px 8px;cursor:pointer}',
      '#wbperf button:disabled{opacity:.55;cursor:default}',
      '#wbperf .wbperf-row,#wbperf .wbperf-item{display:flex;justify-content:space-between;gap:12px}',
      '#wbperf .wbperf-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary,#b0b0b8)}',
      '#wbperf .wbperf-warn b{color:#f38ba8}',
      '#wbperf .wbperf-dim{color:var(--text-tertiary,#77777f)}',
    ].join('');
    document.head.appendChild(st);
  }

  function render() {
    if (!hud) return;
    const s = lastServer;
    const c = buildReport();
    let html = '<div class="wbperf-head"><strong>Performance</strong><span>'
      + '<button type="button" data-wbperf="profile"' + (profileBusy ? ' disabled' : '') + '>' + (profileBusy ? 'Profiling 10 s' : 'Profile server 10 s') + '</button> '
      + '<button type="button" data-wbperf="copy">Copy</button> '
      + '<button type="button" data-wbperf="close" aria-label="Close">Close</button></span></div>';
    if (!s) {
      html += '<div class="wbperf-dim">Loading server numbers</div>';
    } else if (s.off) {
      html += '<div class="wbperf-dim">Server monitor is off (CWM_PERF=0)</div>';
    } else {
      const cur = s.current || {};
      const el = cur.eventLoop || {};
      html += '<h4>Server, this minute</h4>'
        + row('event loop p99 / max', (el.p99 || 0) + ' / ' + (el.max || 0) + ' ms', el.p99 > 100)
        + row('stalls (150 ms+)', (cur.stalls || 0) + ', worst ' + (cur.maxStall || 0) + ' ms', cur.stalls > 0)
        + row('cpu / rss / heap', (cur.cpuPct || 0) + '% / ' + s.rssMb + ' MB / ' + s.heapMb + ' MB', cur.cpuPct > 50)
        + '<h4>Recent stalls, and what ran inside</h4>'
        + rows((s.recentStalls || []).slice(0, 6), (st) => item(st.at.slice(11, 19) + ' ' + st.ms + ' ms: ' + ((st.during && st.during.length) ? st.during.map((d) => d.op + ' x' + d.n).join(', ') : 'unattributed, profile it'), ''))
        + '<h4>Spawns (sync ms blocked)</h4>'
        + rows(cur.spawns, (e) => item(e.key + ' x' + e.n, e.ms + ' ms, max ' + e.max))
        + '<h4>Operations</h4>'
        + rows(cur.ops, (e) => item(e.key + ' x' + e.n, e.ms + ' ms, max ' + e.max))
        + '<h4>Routes</h4>'
        + rows((cur.routes || []).slice(0, 6), (e) => item(e.key + ' x' + e.n, 'avg ' + e.avg + ', max ' + e.max))
        + '<h4>SSE sent</h4>'
        + rows((cur.sse || []).slice(0, 6), (e) => item(e.key, e.n + ''));
      if (profileResult) {
        html += '<h4>Profile ' + esc(profileResult.at ? profileResult.at.slice(11, 19) : '') + ': busy ' + profileResult.busyPct + '%, ' + profileResult.blocks + ' blocks, ' + profileResult.blockedMs + ' ms</h4>'
          + rows(profileResult.causes, (e) => item(e.key, e.n + ' x, ' + e.ms + ' ms, max ' + e.max));
      } else if (s.lastProfile) {
        html += '<h4>Last profile (' + esc(s.lastProfile.why) + ' ' + esc(s.lastProfile.at.slice(11, 19)) + ')</h4>'
          + rows(s.lastProfile.causes, (e) => item(e.key, e.n + ' x, ' + e.ms + ' ms, max ' + e.max));
      }
    }
    html += '<h4>This page, last ' + c.seconds + ' s</h4>'
      + row('long frames', c.longFrames.n + ', worst ' + c.longFrames.max + ' ms', c.longFrames.max > 200)
      + row('slow inputs (64 ms+)', c.inputs.n + ', worst ' + c.inputs.max + ' ms', c.inputs.max > 150)
      + row('heap / DOM nodes', (c.heapMb == null ? '?' : c.heapMb + ' MB') + ' / ' + c.domNodes, c.domNodes > 30000)
      + row('SSE / min, WS / s', c.ssePerMin + ' / ' + c.wsPerSec + ' (' + c.wsKbPerSec + ' KB/s)', false)
      + '<h4>Page frames caused by</h4>'
      + rows(c.causes, (e) => item(e.key, e.ms + ' ms, max ' + e.max));
    hud.innerHTML = html;
  }

  async function refresh() {
    try { lastServer = await call('GET', '/api/perf'); } catch (err) { lastServer = null; }
    render();
  }

  async function runProfile() {
    if (profileBusy) return;
    profileBusy = true;
    render();
    try { profileResult = await call('POST', '/api/perf/profile?seconds=10'); } catch (err) { profileResult = { at: new Date().toISOString(), busyPct: '?', blocks: 0, blockedMs: 0, causes: [{ key: 'profile failed: ' + err.message, n: 0, ms: 0, max: 0 }] }; }
    profileBusy = false;
    render();
  }

  function open() {
    if (hud) return;
    injectStyle();
    hud = document.createElement('div');
    hud.id = 'wbperf';
    hud.setAttribute('role', 'dialog');
    hud.setAttribute('aria-label', 'Performance');
    hud.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wbperf]');
      if (!b) return;
      const what = b.getAttribute('data-wbperf');
      if (what === 'close') close();
      else if (what === 'profile') runProfile();
      else if (what === 'copy') {
        const text = JSON.stringify({ server: lastServer, page: buildReport(), profile: profileResult }, null, 2);
        try { navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (_) { /* clipboard blocked */ }
      }
    });
    document.body.appendChild(hud);
    refresh();
    hudTimer = setInterval(refresh, HUD_REFRESH_MS);
  }
  function close() {
    if (hudTimer) clearInterval(hudTimer);
    hudTimer = null;
    if (hud) hud.remove();
    hud = null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.metaKey && (e.code === 'KeyP' || e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      e.stopPropagation();
      if (hud) close(); else open();
    }
  }, true);

  window.WorkbookPerf = { open, close, report: buildReport, pageId };
})();
