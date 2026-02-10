#!/usr/bin/env node
/**
 * Marketing Capture Pipeline — Playwright Orchestrator
 *
 * Automates screenshots and GIF video recordings of the GUI in demo mode.
 * CRITICAL: Never captures personal information — uses demo data only.
 *
 * Usage:
 *   node scripts/marketing/capture.js                  Full capture (screenshots + GIFs)
 *   node scripts/marketing/capture.js --screenshots-only
 *   node scripts/marketing/capture.js --gifs-only
 *   node scripts/marketing/capture.js --headed         Show browser (for debugging)
 */

const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Resolve paths relative to project root
const ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, 'marketing', 'raw');
const STATE_DIR = path.join(ROOT, 'state');

const PORT = 3457;
const BASE_URL = `http://localhost:${PORT}`;

const DESKTOP = { width: 1920, height: 1080 };
const MOBILE = { width: 390, height: 844 };

// ── Fake terminal content (loaded from content.js) ──────────────
let content;
try {
  content = require('./content');
} catch (e) {
  console.error('Failed to load content.js:', e.message);
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════
//  MarketingCapture — orchestrates all captures
// ════════════════════════════════════════════════════════════════

class MarketingCapture {
  constructor(options = {}) {
    this.headed = options.headed || false;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.server = null;
    this.token = null;
  }

  // ── Server lifecycle ──────────────────────────────────────────

  async startServer() {
    // Backup then wipe ALL state (except config.json) to force fresh demo seeding.
    // The real workspaces.json contains actual user workspaces/sessions.
    // layout.json has saved terminal tab groups from real usage.
    // docs/ has real workspace documentation.
    this._stateBackupDir = path.join(ROOT, 'marketing', 'raw', '_state_backup');
    if (fs.existsSync(this._stateBackupDir)) {
      fs.rmSync(this._stateBackupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this._stateBackupDir, { recursive: true });

    if (fs.existsSync(STATE_DIR)) {
      for (const entry of fs.readdirSync(STATE_DIR)) {
        if (entry === 'config.json') continue; // Keep password
        const src = path.join(STATE_DIR, entry);
        const dst = path.join(this._stateBackupDir, entry);
        // Copy to backup before deleting
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
        } else {
          fs.copyFileSync(src, dst);
          fs.unlinkSync(src);
        }
      }
      console.log('  State backed up and wiped for clean demo.');
    }

    return new Promise((resolve, reject) => {
      this.server = spawn('node', [path.join(ROOT, 'src', 'gui.js'), '--demo'], {
        env: { ...process.env, PORT: String(PORT), CWM_NO_OPEN: '1' },
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Suppress the browser auto-open by not passing through stdio
      this.server.stdout.on('data', (d) => {
        const line = d.toString();
        if (line.includes('running at')) {
          // Server is ready
        }
      });

      this.server.stderr.on('data', (d) => {
        // Suppress stderr noise but log real errors
        const line = d.toString();
        if (line.includes('Error') && !line.includes('EADDRINUSE')) {
          console.error('  [server]', line.trim());
        }
      });

      this.server.on('error', reject);

      // Poll for readiness
      const poll = setInterval(() => {
        http.get(`${BASE_URL}/api/health`, (res) => {
          if (res.statusCode === 200 || res.statusCode === 401) {
            clearInterval(poll);
            resolve();
          }
        }).on('error', () => {}); // Not ready yet
      }, 300);

      // Timeout after 15 seconds
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error('Server did not start within 15 seconds'));
      }, 15000);
    });
  }

  // ── Browser lifecycle ─────────────────────────────────────────

  async initBrowser() {
    this.browser = await chromium.launch({
      headless: !this.headed,
    });
    this.context = await this.browser.newContext({
      viewport: DESKTOP,
      deviceScaleFactor: 1,
    });
    this.page = await this.context.newPage();
  }

  async login() {
    // Read password from config
    const configPath = path.join(STATE_DIR, 'config.json');
    let password = process.env.CWM_PASSWORD || 'demo123';
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.password) password = cfg.password;
      } catch (_) {}
    }

    await this.page.goto(BASE_URL);
    await this.page.waitForSelector('#login-password', { state: 'visible', timeout: 10000 });

    // Capture login screen BEFORE typing password
    await this.page.waitForTimeout(800); // Let logo animation settle
    await this.screenshot('login-screen');
    console.log('  [screenshot] login-screen.png');

    // Now login
    await this.page.fill('#login-password', password);
    await this.page.click('#login-btn');
    await this.page.waitForSelector('.sidebar', { state: 'visible', timeout: 10000 });

    // Store token for API calls
    this.token = await this.page.evaluate(() => localStorage.getItem('cwm_token'));

    // Wait for initial data load
    await this.page.waitForTimeout(1000);
  }

  // ── Privacy safeguards ────────────────────────────────────────

  async hidePersonalInfo() {
    await this.page.evaluate(() => {
      // Collapse projects panel (shows real ~/.claude/projects/ data)
      if (!window.cwm.state.projectsCollapsed) {
        window.cwm.toggleProjectsPanel();
      }
      // Also hide the projects header section entirely for extra safety
      const projectsHeader = document.getElementById('projects-header');
      if (projectsHeader) projectsHeader.style.display = 'none';
      const projectsList = document.getElementById('projects-list');
      if (projectsList) projectsList.style.display = 'none';
      const projectsSearch = document.querySelector('.projects-search');
      if (projectsSearch) projectsSearch.style.display = 'none';
    });
    // Hide $NaN cost badges (demo sessions have no JSONL data)
    await this.page.addStyleTag({
      content: '.ws-session-cost { display: none !important; }'
    });
    await this.page.waitForTimeout(300);
  }

  // ── Helpers ───────────────────────────────────────────────────

  async screenshot(name) {
    const filepath = path.join(RAW_DIR, `${name}.png`);
    await this.page.screenshot({ path: filepath, type: 'png' });
    return filepath;
  }

  /**
   * Dismiss any open modals, overlays, or context menus that might block clicks.
   */
  async dismissModals() {
    await this.page.evaluate(() => {
      // Close ALL modal overlays (catches quick-switcher, find-convo, update, notes-editor, generic)
      document.querySelectorAll('.modal-overlay').forEach(el => {
        el.hidden = true;
        el.style.display = 'none';
      });
      // Close any visible modals, context menus, action sheets
      document.querySelectorAll('.modal, .context-menu, .action-sheet').forEach(el => {
        el.hidden = true;
        el.style.display = 'none';
      });
      // Close sidebar backdrop (mobile blur overlay)
      const sb = document.querySelector('.sidebar-backdrop');
      if (sb) { sb.hidden = true; sb.style.display = 'none'; }
      // Close theme dropdown
      const td = document.getElementById('theme-dropdown');
      if (td) td.hidden = true;
    });
    await this.page.waitForTimeout(200);
  }

  async apiCall(method, endpoint, body = null) {
    return this.page.evaluate(async ({ method, endpoint, body, token }) => {
      const opts = {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(endpoint, opts);
      return res.json();
    }, { method, endpoint, body, token: this.token });
  }

  // ── Terminal injection ────────────────────────────────────────

  async injectTerminals() {
    // Dismiss any blocking modals first
    await this.dismissModals();
    // Switch to terminal view
    await this.page.click('[data-mode="terminal"]');
    await this.page.waitForTimeout(500);

    // Prevent WebSocket connections entirely — override connect() to no-op
    // This avoids PTY spawn failures and real output leaking into terminals
    await this.page.evaluate(() => {
      TerminalPane.prototype._originalConnect = TerminalPane.prototype.connect;
      TerminalPane.prototype.connect = function() {
        // Remove loading animation since we're not connecting
        const container = document.getElementById(this.containerId);
        const paneEl = container ? container.closest('.terminal-pane') : null;
        if (paneEl) paneEl.classList.remove('terminal-pane-loading');
        this.connected = false;
        this._log('connect() suppressed for marketing capture');
      };
    });

    // Get ALL demo sessions (state.sessions only has current workspace's)
    const sessions = await this.page.evaluate(async () => {
      // Fetch all sessions via the API
      const token = localStorage.getItem('cwm_token');
      const res = await fetch('/api/sessions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const all = data.sessions || data || [];
      return all.slice(0, 4).map(s => ({ id: s.id, name: s.name }));
    });

    const fakeOutputs = [
      content.session1(),
      content.session2(),
      content.session3(),
      content.session4(),
    ];

    // Open all 4 panes quickly (no WS connection will happen)
    for (let i = 0; i < Math.min(4, sessions.length); i++) {
      await this.page.evaluate(({ slot, session }) => {
        window.cwm.openTerminalInPane(slot, session.id, session.name, {});
      }, { slot: i, session: sessions[i] });
      // Small delay for xterm to mount (happens in rAF)
      await this.page.waitForTimeout(600);
    }

    // Wait for all terminals to fully render
    await this.page.waitForTimeout(800);

    // Inject fake content into each pane
    for (let i = 0; i < Math.min(4, sessions.length); i++) {
      await this.page.evaluate(({ slot, fakeContent }) => {
        const tp = window.cwm.terminalPanes[slot];
        if (!tp || !tp.term) {
          console.warn('[capture] Pane', slot, 'has no terminal instance');
          return;
        }
        tp.term.reset();
        tp.term.write(fakeContent);
      }, { slot: i, fakeContent: fakeOutputs[i] });
    }

    // Restore original connect for subsequent operations if needed
    await this.page.evaluate(() => {
      if (TerminalPane.prototype._originalConnect) {
        TerminalPane.prototype.connect = TerminalPane.prototype._originalConnect;
        delete TerminalPane.prototype._originalConnect;
      }
    });

    await this.page.waitForTimeout(500);
  }

  // ════════════════════════════════════════════════════════════
  //  SCREENSHOTS
  // ════════════════════════════════════════════════════════════

  async captureAllScreenshots() {
    console.log('\n--- Screenshots ---');

    // Login screen already captured during login()
    await this.captureHeroDashboard();
    await this.captureTerminalGrid();
    await this.captureThemes();
    await this.captureKanban();
    await this.captureQuickSwitcher();
    await this.captureDocsPanel();
    await this.captureSessionDetail();
    await this.captureMobile();
  }

  async captureHeroDashboard() {
    await this.dismissModals();
    await this.hidePersonalInfo();
    // Switch to workspace view
    await this.page.click('[data-mode="workspace"]');
    await this.page.waitForTimeout(500);

    // Click first workspace to show sessions
    const wsItem = this.page.locator('.workspace-item').first();
    if (await wsItem.isVisible()) {
      await wsItem.click();
      await this.page.waitForTimeout(500);
    }

    // Click first session to show detail panel
    const sessionItem = this.page.locator('.ws-session-item').first();
    if (await sessionItem.isVisible()) {
      await sessionItem.click();
      await this.page.waitForTimeout(500);
    }

    // Inject fake cost data into the detail panel
    await this.page.evaluate(() => {
      const costEl = document.getElementById('detail-cost');
      if (costEl) costEl.hidden = false;
      const totalEl = document.getElementById('detail-cost-total');
      if (totalEl) totalEl.textContent = '$0.47';
      const breakdownEl = document.getElementById('detail-cost-breakdown');
      if (breakdownEl) {
        breakdownEl.innerHTML = `
          <div class="cost-item"><span>Input tokens</span><span class="cost-item-value">24,831</span></div>
          <div class="cost-item"><span>Output tokens</span><span class="cost-item-value">8,412</span></div>
          <div class="cost-item"><span>Cache read</span><span class="cost-item-value">142,067</span></div>
          <div class="cost-item"><span>Cache write</span><span class="cost-item-value">3,290</span></div>
        `;
      }
      const tokenBar = document.getElementById('detail-token-bar');
      if (tokenBar) {
        tokenBar.innerHTML = `
          <div class="token-bar-fill token-bar-input" style="width:18.6%;display:inline-block"></div>
          <div class="token-bar-fill token-bar-output" style="width:5.6%;display:inline-block"></div>
          <div class="token-bar-fill token-bar-cache" style="width:75.8%;display:inline-block"></div>
        `;
      }
    });

    await this.screenshot('hero-dashboard');
    console.log('  [screenshot] hero-dashboard.png');
  }

  async captureTerminalGrid() {
    await this.hidePersonalInfo();
    await this.injectTerminals();

    await this.screenshot('terminal-grid');
    console.log('  [screenshot] terminal-grid.png');
  }

  async captureThemes() {
    await this.dismissModals();
    await this.hidePersonalInfo();
    // Go to workspace view for consistent appearance
    await this.page.click('[data-mode="workspace"]');
    await this.page.waitForTimeout(400);

    // Click first session for detail panel
    const sessionItem = this.page.locator('.ws-session-item').first();
    if (await sessionItem.isVisible()) {
      await sessionItem.click();
      await this.page.waitForTimeout(300);
    }

    const themes = ['mocha', 'macchiato', 'frappe', 'latte'];
    for (const theme of themes) {
      await this.page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        localStorage.setItem('cwm_theme', t);
        // Also update terminal themes if any are open
        window.cwm.terminalPanes.forEach(tp => {
          if (tp && tp.term) {
            tp.term.options.theme = TerminalPane.getCurrentTheme();
          }
        });
      }, theme);

      await this.page.waitForTimeout(400);
      await this.screenshot(`theme-${theme}`);
      console.log(`  [screenshot] theme-${theme}.png`);
    }

    // Reset to mocha
    await this.page.evaluate(() => {
      document.documentElement.dataset.theme = 'mocha';
      localStorage.setItem('cwm_theme', 'mocha');
    });
  }

  async captureKanban() {
    await this.dismissModals();
    await this.hidePersonalInfo();

    // Get active workspace ID
    const wsId = await this.page.evaluate(() => {
      return window.cwm.state.activeWorkspace ? window.cwm.state.activeWorkspace.id : null;
    });
    if (!wsId) {
      console.log('  [skip] kanban — no active workspace');
      return;
    }

    // Seed feature board with demo data
    for (const feat of content.demoFeatures) {
      await this.apiCall('POST', `/api/workspaces/${wsId}/features`, {
        name: feat.title,
        description: feat.description,
        status: feat.status,
      });
    }

    // Switch to docs view then board tab
    await this.page.click('[data-mode="docs"]');
    await this.page.waitForTimeout(500);
    await this.page.click('.docs-tab[data-tab="board"]');
    await this.page.waitForTimeout(800);

    await this.screenshot('kanban-board');
    console.log('  [screenshot] kanban-board.png');
  }

  async captureQuickSwitcher() {
    await this.dismissModals();
    await this.hidePersonalInfo();
    // Go to workspace view first for good background
    await this.page.click('[data-mode="workspace"]');
    await this.page.waitForTimeout(300);

    // Open quick switcher
    await this.page.keyboard.press('Control+k');
    await this.page.waitForTimeout(400);

    // Type a search query
    await this.page.type('#qs-input', 'api', { delay: 80 });
    await this.page.waitForTimeout(500);

    await this.screenshot('quick-switcher');
    console.log('  [screenshot] quick-switcher.png');

    // Close switcher
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(200);
  }

  async captureDocsPanel() {
    await this.dismissModals();
    await this.hidePersonalInfo();

    // Get active workspace ID
    const wsId = await this.page.evaluate(() => {
      return window.cwm.state.activeWorkspace ? window.cwm.state.activeWorkspace.id : null;
    });
    if (!wsId) {
      console.log('  [skip] docs — no active workspace');
      return;
    }

    // Seed docs with demo content
    for (const note of content.demoNotes) {
      await this.apiCall('POST', `/api/workspaces/${wsId}/docs/${note.section}`, {
        text: `**${note.title}**\n${note.content}`,
      });
    }

    // Switch to docs view
    await this.page.click('[data-mode="docs"]');
    await this.page.waitForTimeout(500);

    // Make sure we're on the docs tab (not board)
    const docsTab = this.page.locator('.docs-tab[data-tab="docs"]');
    if (await docsTab.isVisible()) {
      await docsTab.click();
      await this.page.waitForTimeout(500);
    }

    await this.screenshot('docs-panel');
    console.log('  [screenshot] docs-panel.png');
  }

  async captureSessionDetail() {
    await this.dismissModals();
    await this.hidePersonalInfo();
    await this.page.click('[data-mode="workspace"]');
    await this.page.waitForTimeout(400);

    // Click first session to show detail
    const sessionItem = this.page.locator('.ws-session-item').first();
    if (await sessionItem.isVisible()) {
      await sessionItem.click();
      await this.page.waitForTimeout(500);
    }

    // Inject fake cost data
    await this.page.evaluate(() => {
      const costEl = document.getElementById('detail-cost');
      if (costEl) costEl.hidden = false;
      const totalEl = document.getElementById('detail-cost-total');
      if (totalEl) totalEl.textContent = '$1.23';
      const breakdownEl = document.getElementById('detail-cost-breakdown');
      if (breakdownEl) {
        breakdownEl.innerHTML = `
          <div class="cost-item"><span>Input tokens</span><span class="cost-item-value">52,480</span></div>
          <div class="cost-item"><span>Output tokens</span><span class="cost-item-value">18,932</span></div>
          <div class="cost-item"><span>Cache read</span><span class="cost-item-value">287,541</span></div>
          <div class="cost-item"><span>Cache write</span><span class="cost-item-value">6,102</span></div>
        `;
      }
      const tokenBar = document.getElementById('detail-token-bar');
      if (tokenBar) {
        tokenBar.innerHTML = `
          <div class="token-bar-fill token-bar-input" style="width:16.1%;display:inline-block"></div>
          <div class="token-bar-fill token-bar-output" style="width:5.2%;display:inline-block"></div>
          <div class="token-bar-fill token-bar-cache" style="width:78.7%;display:inline-block"></div>
        `;
      }
    });

    await this.screenshot('session-detail');
    console.log('  [screenshot] session-detail.png');
  }

  async captureMobile() {
    await this.dismissModals();
    // Resize to mobile
    await this.page.setViewportSize(MOBILE);
    await this.page.waitForTimeout(600);

    await this.screenshot('mobile-dashboard');
    console.log('  [screenshot] mobile-dashboard.png');

    // Mobile terminal view
    await this.page.evaluate(() => {
      // Click terminal tab in mobile bottom bar
      const termTab = document.querySelector('.mobile-tab[data-view="terminal"]');
      if (termTab) termTab.click();
    });
    await this.page.waitForTimeout(500);
    await this.screenshot('mobile-terminal');
    console.log('  [screenshot] mobile-terminal.png');

    // Restore desktop size
    await this.page.setViewportSize(DESKTOP);
    await this.page.waitForTimeout(400);
  }

  // ════════════════════════════════════════════════════════════
  //  GIF RECORDINGS (video capture → .webm)
  // ════════════════════════════════════════════════════════════

  async recordAllGifs() {
    console.log('\n--- GIF Recordings ---');

    const recordings = [
      ['theme-switching', () => this.recordThemeSwitching()],
      ['quick-switcher', () => this.recordQuickSwitcher()],
      ['create-session', () => this.recordCreateSession()],
      ['drag-session', () => this.recordDragToTerminal()],
      ['completion-flash', () => this.recordCompletionFlash()],
      ['terminal-typing', () => this.recordMultiTerminalTyping()],
    ];

    for (const [name, fn] of recordings) {
      try {
        await fn();
      } catch (err) {
        console.error(`  [FAIL] ${name}: ${err.message}`);
      }
      // Pause between recordings to let server stabilize and GC browser resources
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  /**
   * Creates a fresh context with video recording enabled.
   * Returns { context, page } — caller must close when done.
   */
  async _startRecording(name, viewport = DESKTOP) {
    const ctx = await this.browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      recordVideo: {
        dir: RAW_DIR,
        size: viewport,
      },
    });
    const page = await ctx.newPage();

    // Login on the new page
    const configPath = path.join(STATE_DIR, 'config.json');
    let password = process.env.CWM_PASSWORD || 'demo123';
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.password) password = cfg.password;
      } catch (_) {}
    }

    await page.goto(BASE_URL);
    await page.waitForTimeout(1000);
    // Check if login screen is showing, or if already logged in
    const needsLogin = await page.locator('#login-password').isVisible().catch(() => false);
    if (needsLogin) {
      await page.fill('#login-password', password);
      await page.click('#login-btn');
    }
    // Wait for app to load — retry login with escalating recovery if needed
    let appVisible = false;
    for (let attempt = 0; attempt < 3 && !appVisible; attempt++) {
      try {
        await page.waitForSelector('#app:not([hidden])', { timeout: 6000 });
        appVisible = true;
      } catch (_) {
        console.log(`    login retry ${attempt + 1}...`);
        await page.waitForTimeout(2000);
        await page.goto('about:blank');
        await page.waitForTimeout(1000);
        await page.goto(BASE_URL);
        await page.waitForTimeout(2000);
        const stillNeedsLogin = await page.locator('#login-password').isVisible().catch(() => false);
        if (stillNeedsLogin) {
          await page.fill('#login-password', password);
          await page.click('#login-btn');
        }
      }
    }
    if (!appVisible) {
      await page.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    }
    await page.waitForTimeout(800);

    // Dismiss all modals/overlays (may appear after login)
    await page.evaluate(() => {
      document.querySelectorAll('.modal-overlay').forEach(el => {
        el.hidden = true;
        el.style.display = 'none';
      });
      document.querySelectorAll('.modal, .context-menu, .action-sheet').forEach(el => {
        el.hidden = true;
        el.style.display = 'none';
      });
      const sb = document.querySelector('.sidebar-backdrop');
      if (sb) { sb.hidden = true; sb.style.display = 'none'; }
      const td = document.getElementById('theme-dropdown');
      if (td) td.hidden = true;
    });
    await page.waitForTimeout(200);

    // Hide personal info
    await page.evaluate(() => {
      if (!window.cwm.state.projectsCollapsed) window.cwm.toggleProjectsPanel();
      const ph = document.getElementById('projects-header');
      if (ph) ph.style.display = 'none';
      const pl = document.getElementById('projects-list');
      if (pl) pl.style.display = 'none';
    });
    // Hide $NaN cost badges
    await page.addStyleTag({
      content: '.ws-session-cost { display: none !important; }'
    });

    // Override TerminalPane.connect to prevent WebSocket connections
    await page.evaluate(() => {
      if (typeof TerminalPane !== 'undefined') {
        TerminalPane.prototype.connect = function() {
          const container = document.getElementById(this.containerId);
          const paneEl = container ? container.closest('.terminal-pane') : null;
          if (paneEl) paneEl.classList.remove('terminal-pane-loading');
          this.connected = false;
        };
      }
    });
    await page.waitForTimeout(300);

    return { ctx, page };
  }

  async _stopRecording(ctx, page, name) {
    const videoPath = await page.video().path();
    await page.close();
    await ctx.close();

    // Rename the auto-generated video file
    const dest = path.join(RAW_DIR, `${name}.webm`);
    if (fs.existsSync(videoPath)) {
      fs.renameSync(videoPath, dest);
    }
    console.log(`  [recording] ${name}.webm`);
    return dest;
  }

  async recordThemeSwitching() {
    const { ctx, page } = await this._startRecording('theme-switching');

    // Start on workspace view
    await page.click('[data-mode="workspace"]');
    await page.waitForTimeout(500);

    // Click first session for detail panel context
    const sessionItem = page.locator('.ws-session-item').first();
    if (await sessionItem.isVisible()) {
      await sessionItem.click();
      await page.waitForTimeout(300);
    }

    // Cycle through themes with visible picker
    const themes = ['macchiato', 'frappe', 'latte', 'mocha'];
    for (const theme of themes) {
      // Open theme dropdown
      await page.click('#theme-toggle-btn');
      await page.waitForTimeout(400);

      // Click theme option
      await page.click(`.theme-option[data-theme="${theme}"]`);
      await page.waitForTimeout(800);
    }

    await page.waitForTimeout(500);
    await this._stopRecording(ctx, page, 'theme-switching');
  }

  async recordQuickSwitcher() {
    const { ctx, page } = await this._startRecording('quick-switcher');

    await page.click('[data-mode="workspace"]');
    await page.waitForTimeout(600);

    // Open quick switcher
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Type search query slowly
    for (const char of 'api-routes') {
      await page.type('#qs-input', char, { delay: 0 });
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(600);

    // Arrow down to select
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);

    // Select
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    await this._stopRecording(ctx, page, 'quick-switcher');
  }

  async recordCreateSession() {
    const { ctx, page } = await this._startRecording('create-session');

    await page.click('[data-mode="workspace"]');
    await page.waitForTimeout(600);

    // Click create session button (the + in the sessions header)
    const addBtn = page.locator('#add-session-btn, .session-add-btn, [title="Create session"]').first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      await page.waitForTimeout(500);

      // Fill form fields (the prompt modal)
      const nameInput = page.locator('input[placeholder*="name" i], .modal-field input').first();
      if (await nameInput.isVisible()) {
        await nameInput.fill('');
        await nameInput.type('auth-refactor', { delay: 50 });
        await page.waitForTimeout(300);
      }

      // Submit
      const confirmBtn = page.locator('.modal-confirm, .btn-primary').first();
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    await this._stopRecording(ctx, page, 'create-session');
  }

  async recordMultiTerminalTyping() {
    const { ctx, page } = await this._startRecording('terminal-typing');

    await page.click('[data-mode="terminal"]');
    await page.waitForTimeout(500);

    // Open 3 terminal panes with demo sessions (fetch ALL sessions via API)
    const sessions = await page.evaluate(async () => {
      const token = localStorage.getItem('cwm_token');
      const res = await fetch('/api/sessions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const all = data.sessions || data || [];
      return all.slice(0, 3).map(s => ({ id: s.id, name: s.name }));
    });

    for (let i = 0; i < Math.min(3, sessions.length); i++) {
      await page.evaluate(({ slot, session }) => {
        window.cwm.openTerminalInPane(slot, session.id, session.name, {});
      }, { slot: i, session: sessions[i] });
      await page.waitForTimeout(1500);

      // Disconnect WebSocket
      await page.evaluate(({ slot }) => {
        const tp = window.cwm.terminalPanes[slot];
        if (!tp || !tp.term) return;
        tp._maxReconnectAttempts = 0;
        clearTimeout(tp.reconnectTimer);
        if (tp.ws) {
          tp.ws.onclose = null;
          tp.ws.onerror = null;
          try { tp.ws.close(); } catch (_) {}
        }
        tp.term.reset();
      }, { slot: i });
    }

    await page.waitForTimeout(300);

    // Now simulate typing in all 3 panes simultaneously
    // Use the raw session content, split into chunks for progressive reveal
    const rawContent = [
      content.session1(),
      content.session2(),
      content.session3(),
    ];

    // Write content in chunks to simulate parallel Claude sessions working
    const CHUNK_SIZE = 40;
    const maxLen = Math.max(...rawContent.map(c => c.length));
    const maxChunks = Math.ceil(maxLen / CHUNK_SIZE);

    for (let chunk = 0; chunk < Math.min(maxChunks, 80); chunk++) {
      await page.evaluate(({ contents, chunkIdx, chunkSize }) => {
        for (let pane = 0; pane < contents.length; pane++) {
          const tp = window.cwm.terminalPanes[pane];
          if (!tp || !tp.term) continue;
          const start = chunkIdx * chunkSize;
          const slice = contents[pane].substring(start, start + chunkSize);
          if (slice) tp.term.write(slice);
        }
      }, {
        contents: rawContent,
        chunkIdx: chunk,
        chunkSize: CHUNK_SIZE,
      });
      await page.waitForTimeout(60);
    }

    await page.waitForTimeout(1000);
    await this._stopRecording(ctx, page, 'terminal-typing');
  }

  async recordDragToTerminal() {
    const { ctx, page } = await this._startRecording('drag-session');

    // Start in workspace view to see session list
    await page.click('[data-mode="workspace"]');
    await page.waitForTimeout(500);

    // Click first workspace
    const wsItem = page.locator('.workspace-item').first();
    if (await wsItem.isVisible()) {
      await wsItem.click();
      await page.waitForTimeout(300);
    }

    // Switch to terminal view (shows empty panes)
    await page.click('[data-mode="terminal"]');
    await page.waitForTimeout(500);

    // Get first session via API
    const session = await page.evaluate(async () => {
      const token = localStorage.getItem('cwm_token');
      const res = await fetch('/api/sessions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const all = data.sessions || data || [];
      return all[0] ? { id: all[0].id, name: all[0].name } : null;
    });

    if (session) {
      // Programmatically open terminal to simulate drag result
      await page.evaluate(({ session }) => {
        window.cwm.openTerminalInPane(0, session.id, session.name, {});
      }, { session });

      await page.waitForTimeout(2000);

      // Inject fake content (connect is already no-op'd)
      await page.evaluate(({ fakeContent }) => {
        const tp = window.cwm.terminalPanes[0];
        if (!tp || !tp.term) return;
        tp.term.reset();
        tp.term.write(fakeContent);
      }, { fakeContent: content.session1() });

      await page.waitForTimeout(1500);
    }

    await this._stopRecording(ctx, page, 'drag-session');
  }

  async recordCompletionFlash() {
    const { ctx, page } = await this._startRecording('completion-flash');

    await page.click('[data-mode="terminal"]');
    await page.waitForTimeout(500);

    // Open one terminal (fetch session via API)
    const session = await page.evaluate(async () => {
      const token = localStorage.getItem('cwm_token');
      const res = await fetch('/api/sessions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const all = data.sessions || data || [];
      return all[0] ? { id: all[0].id, name: all[0].name } : null;
    });

    if (session) {
      await page.evaluate(({ session }) => {
        window.cwm.openTerminalInPane(0, session.id, session.name, {});
      }, { session });

      await page.waitForTimeout(2000);

      // Inject fake content (connect is already no-op'd)
      await page.evaluate(({ fakeContent }) => {
        const tp = window.cwm.terminalPanes[0];
        if (!tp || !tp.term) return;
        tp.term.reset();
        tp.term.write(fakeContent);
      }, { fakeContent: content.session3() });

      await page.waitForTimeout(1000);

      // Trigger the completion flash animation
      await page.evaluate(() => {
        const pane = document.getElementById('term-pane-0');
        if (pane) {
          pane.classList.add('terminal-pane-done');
          setTimeout(() => pane.classList.remove('terminal-pane-done'), 4000);
        }
        // Also dispatch the terminal-idle event for notification
        const container = document.getElementById('term-container-0');
        if (container) {
          container.dispatchEvent(new CustomEvent('terminal-idle', {
            bubbles: true,
            detail: { sessionId: 'demo', sessionName: 'test-runner' },
          }));
        }
      });

      await page.waitForTimeout(3000);
    }

    await this._stopRecording(ctx, page, 'completion-flash');
  }

  // ── Cleanup ───────────────────────────────────────────────────

  _restoreState() {
    // Restore original state from backup (so user's real data isn't lost)
    if (!this._stateBackupDir || !fs.existsSync(this._stateBackupDir)) return;

    // First wipe demo state
    if (fs.existsSync(STATE_DIR)) {
      for (const entry of fs.readdirSync(STATE_DIR)) {
        if (entry === 'config.json') continue;
        const fullPath = path.join(STATE_DIR, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        } catch (_) {}
      }
    }

    // Restore from backup
    for (const entry of fs.readdirSync(this._stateBackupDir)) {
      const src = path.join(this._stateBackupDir, entry);
      const dst = path.join(STATE_DIR, entry);
      try {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
        } else {
          fs.copyFileSync(src, dst);
        }
      } catch (_) {}
    }

    // Cleanup backup
    fs.rmSync(this._stateBackupDir, { recursive: true, force: true });
    console.log('  State restored from backup.');
  }

  async cleanup() {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.server) {
      this.server.kill('SIGTERM');
      // Wait for server to stop before restoring state
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { this.server.kill('SIGKILL'); } catch (_) {}
    }
    this._restoreState();
  }
}

// ════════════════════════════════════════════════════════════════
//  CLI Entry Point
// ════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const screenshotsOnly = args.includes('--screenshots-only');
  const gifsOnly = args.includes('--gifs-only');
  const headed = args.includes('--headed');

  // Ensure output directories exist
  for (const dir of [RAW_DIR, path.join(ROOT, 'marketing', 'screenshots'), path.join(ROOT, 'marketing', 'gifs')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const capture = new MarketingCapture({ headed });

  console.log('Marketing Capture Pipeline');
  console.log('─────────────────────────');

  try {
    console.log('Starting demo server on port', PORT, '...');
    await capture.startServer();
    console.log('Server ready.');

    console.log('Launching browser' + (headed ? ' (headed)' : '') + '...');
    await capture.initBrowser();
    console.log('Browser ready.');

    console.log('Logging in...');
    await capture.login();
    console.log('Logged in.');

    if (!gifsOnly) {
      await capture.captureAllScreenshots();
    }

    if (!screenshotsOnly) {
      await capture.recordAllGifs();
    }

    console.log('\nCapture complete!');
    console.log(`  Raw files: ${RAW_DIR}`);

  } catch (err) {
    console.error('\nCapture failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await capture.cleanup();
  }
}

if (require.main === module) {
  main();
}

module.exports = { MarketingCapture };
