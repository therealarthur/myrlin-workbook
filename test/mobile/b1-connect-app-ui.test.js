/**
 * b1-connect-app-ui.test.js: the desktop Connect app surfaces (BUILD-CONTRACT
 * 3.5.1 item 13, 3.5.2 last bullet; shared edits S12 to S16).
 *
 * WHY: a source test that the modal's element ids exist, that the QR is drawn
 * dark on white with a 4 module quiet zone at 240 CSS px or more (executed
 * through the bundled qrcode library, not just read), that the Allow dialog
 * has the six scopes plus the disabled Terminal row, that the copy the
 * contract names is present, that phone supplied text never reaches
 * innerHTML, that the header entry is visible in the focused shell, and that
 * app.js routes the button and the three SSE events to connect-app.js.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GRANTABLE_SCOPES } = require('../../src/web/mobile/scope-table');

const PUB = path.join(__dirname, '..', '..', 'src', 'web', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8').replace(/\r\n/g, '\n');
const js = read('connect-app.js');
const css = read('connect-app.css');
const html = read('index.html');
const appJs = read('app.js');
const focused = read('focused-shell.css');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/** Load connect-app.js in a sandbox and return window.MyrlinConnectApp. */
function loadModule() {
  const win = {};
  vm.runInNewContext(js, { window: win });
  return win.MyrlinConnectApp;
}

t('the modal, Allow dialog and Devices tab element ids exist', () => {
  for (const id of [
    'connect-app-overlay', 'connect-app-modal', 'connect-app-title', 'connect-app-close-btn', 'connect-app-tab-connect',
    'connect-app-tab-devices', 'connect-app-panel-connect', 'connect-app-panel-devices', 'connect-app-qr', 'connect-app-code',
    'connect-app-computer', 'connect-app-countdown', 'connect-app-off', 'connect-app-turn-on', 'connect-app-error',
    'connect-app-devices', 'connect-app-identity-note', 'connect-app-allow-overlay', 'connect-app-allow-dialog',
    'connect-app-allow-title', 'connect-app-allow-model', 'connect-app-allow-code', 'connect-app-allow-scopes',
    'connect-app-allow-btn', 'connect-app-deny-btn', 'connect-app-allow-queue',
  ]) assert.ok(js.includes("id: '" + id + "'"), 'missing id ' + id);
});

t('the QR is drawn dark on white with a 4 module quiet zone, error correction M, 240 px or more', async () => {
  const m = loadModule();
  const c = m._constants;
  assert.strictEqual(c.QR_DARK, '#000000');
  assert.strictEqual(c.QR_LIGHT, '#ffffff');
  assert.strictEqual(c.QR_QUIET_MODULES, 4);
  assert.ok(c.QR_SIZE_PX >= 240);
  assert.ok(/window\.QRCode\.toString\(offer\.qrLink, \{\s*type: 'svg',\s*errorCorrectionLevel: 'M',\s*margin: QR_QUIET_MODULES,\s*width: QR_SIZE_PX,\s*color: \{ dark: QR_DARK, light: QR_LIGHT \},/.test(js));
  // Execute the bundled library with exactly those options.
  const ctx = { window: {}, self: {}, navigator: {}, TextEncoder };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('vendor/qrcode.min.js'), ctx);
  const QR = ctx.QRCode || ctx.window.QRCode;
  const link = 'myrlin://pair#v=2&o=oKGio6Sl&s=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&pk=_zktncHwwAR2ap49kZrJMcKSkL2FIeQQ9ctq9L6dmBE&n=STUDIO-PC&e=https%3A%2F%2Fstudio-1.tailnet-example.ts.net,http%3A%2F%2F127.0.0.1%3A3458';
  const svg = await QR.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: c.QR_QUIET_MODULES, width: c.QR_SIZE_PX, color: { dark: c.QR_DARK, light: c.QR_LIGHT } });
  assert.match(svg, /fill="#ffffff"/, 'white ground');
  assert.match(svg, /stroke="#000000"|fill="#000000"/, 'dark modules');
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const modules = Number(vb[1]);
  const path0 = /<path[^>]*d="M(\d+)[ ,](\d+)/.exec(svg.slice(svg.indexOf('stroke="#000000"') - 200));
  assert.ok(modules >= 25 + 8, 'the view box includes the quiet zone');
  assert.ok(path0 === null || Number(path0[1]) >= 4, 'no module inside the 4 module quiet zone');
  assert.match(svg, /width="256" height="256"/);
  assert.match(css, /\.connect-app-qr \{[^}]*min-width: 240px;/);
  assert.match(css, /--connect-app-qr-ground: #ffffff;/);
});

t('the copy the contract names is present', () => {
  for (const s of [
    "text: 'Connect app'", 'The phone connection is off on this computer.', "['Turn on']", "'Refreshes in '",
    'Terminal (not available in this version)', "'Allow ' + req.deviceName + ' to connect?'", "['Allow']", "['Deny']",
    "' It disconnects now and must scan again.'".slice(1, -1), "text: 'Recent actions'", "'Push registered'", "'No push'",
    "['Test push']", "['Revoke']", "tailscale: 'via Tailscale'", 'This computer has a new identity. Phones paired before must scan again.',
  ]) assert.ok(js.includes(s), 'missing copy: ' + s);
  assert.ok(js.includes("'Revoke ' + d.name + '? It disconnects now and must scan again.'"));
});

t('the Allow dialog offers exactly the six grantable scopes, all checked, plus a disabled Terminal row', () => {
  const m = loadModule();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m._constants.SCOPES.map((s) => s.id).sort())), GRANTABLE_SCOPES.slice().sort());
  assert.ok(/el\('input', \{ type: 'checkbox', value: s\.id, checked: true, 'data-scope': s\.id \}\)/.test(js));
  assert.ok(/el\('input', \{ type: 'checkbox', value: 'pty\.raw', disabled: true \}\)/.test(js));
});

t('formatters: countdown, paired, last seen, model words, path and push words', () => {
  const f = loadModule()._fmt;
  assert.strictEqual(f.formatCountdown(252000), '4:12');
  assert.strictEqual(f.formatCountdown(0), '0:00');
  const now = new Date(2026, 8, 27, 16, 42).getTime();
  assert.strictEqual(f.formatPaired(now - 3 * 86400000, now), 'Paired 3 days ago');
  assert.strictEqual(f.formatPaired(now - 60000, now), 'Paired today');
  assert.strictEqual(f.formatPaired(now - 86400000, now), 'Paired yesterday');
  assert.strictEqual(f.formatLastSeen(now, now), 'Last seen 16:42');
  assert.strictEqual(f.formatLastSeen(new Date(2026, 8, 25, 9, 0).getTime(), now), 'Last seen Sep 25');
  assert.strictEqual(f.formatLastSeen(null, now), 'Not seen yet');
  assert.strictEqual(f.modelWords('iPhone17,2'), 'iPhone 16 Pro Max');
  assert.strictEqual(f.modelWords('iPhone99,9'), 'iPhone99,9');
  assert.strictEqual(f.pathWords('tailscale'), 'via Tailscale');
  assert.strictEqual(f.pushWords({ push: { registered: true, lastError: null } }), 'Push registered');
  assert.strictEqual(f.pushWords({ push: { registered: false, lastError: null } }), 'No push');
});

t('phone supplied text never reaches innerHTML (only the generated QR SVG does)', () => {
  const uses = js.match(/\.innerHTML\s*=/g) || [];
  assert.strictEqual(uses.length, 1);
  assert.ok(/E\.qr\.innerHTML = svg;/.test(js));
});

t('no status pill with a dot: no dot or pill selectors, no animation on marks', () => {
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) || [];
  for (const s of selectors) {
    for (const seg of s.split(/[^A-Za-z0-9_-]+/)) {
      for (const part of seg.split('-')) assert.ok(!['dot', 'dots', 'pill', 'pills', 'badge', 'chip'].includes(part), 'selector ' + s.trim());
    }
  }
  assert.ok(!/animation\s*:/.test(css));
  assert.ok(!/@keyframes/.test(css));
});

t('index.html: visible Connect app entry (S12) and one versioned reference each, script right after app.js (S13, see G10 note)', () => {
  assert.ok(html.includes('<button class="btn btn-ghost btn-icon btn-sm connect-app-btn" id="pair-mobile-btn" title="Connect app">'));
  assert.ok(html.includes('<span class="connect-app-label">Connect app</span>'));
  assert.ok(html.includes('id="pair-badge"'), 'the badge id stays');
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.strictEqual((stripped.match(/connect-app\.css\?v=1"/g) || []).length, 1);
  assert.strictEqual((stripped.match(/connect-app\.js\?v=1"/g) || []).length, 1);
  assert.ok(stripped.indexOf('connect-app.js?v=1') > stripped.indexOf('src="app.js?v='), 'loaded right after app.js (gate G10 reads the first app.js?v= match)');
  assert.ok(stripped.indexOf('connect-app.css?v=1') > stripped.indexOf('focused-shell.css?v='), 'after the focused shell sheet');
});

t('focused-shell.css keeps the hide rule and adds the more specific visible rule (S14)', () => {
  assert.ok(focused.includes(':root[data-ui-shell="focused"] #pair-mobile-btn,\n'), 'the original hide rule is untouched');
  assert.ok(focused.includes(':root[data-ui-shell="focused"] #pair-mobile-btn.connect-app-btn {\n  display: inline-flex !important;\n}'));
});

t('app.js routes the button to MyrlinConnectApp (S15) and the three SSE events (S16), keeping the old modal', () => {
  assert.ok(appJs.includes("btn.addEventListener('click', () => (window.MyrlinConnectApp ? window.MyrlinConnectApp.open(this) : this.showPairMobileModal()));"));
  assert.ok(/case 'mobile:pair-request':\n\s*case 'mobile:pair-resolved':\n\s*case 'mobile:devices-changed':[\s\S]{0,200}window\.MyrlinConnectApp\.onEvent\(data\);\n\s*break;\n\s*case 'discover:refreshed':/.test(appJs));
  assert.ok(appJs.includes('  async showPairMobileModal() {'), 'the old modal stays');
});

H.run('b1-connect-app-ui', tests);
