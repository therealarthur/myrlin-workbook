#!/usr/bin/env node
/**
 * Build script: generates public/vendor/lucide.bundle.js
 * Imports curated icons from `lucide` and `@lucide/lab`, converts to SVG strings,
 * and outputs a plain JS bundle that sets window.__lucideIcons.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'src/web/public/vendor/lucide.bundle.js');

// ── Curated icon list ────────────────────────────────────────────────────────
// Format: { category: [[kebab-name, 'lucide' | 'lab'], ...], ... }
const ICON_CATEGORIES = {
  'Folders & Files': [
    ['folder',          'lucide'],
    ['folder-open',     'lucide'],
    ['folder-code',     'lucide'],
    ['folder-git-2',    'lucide'],
    ['folder-sync',     'lucide'],
    ['folder-key',      'lucide'],
    ['folder-search',   'lucide'],
    ['folders',         'lucide'],
    ['file',            'lucide'],
    ['file-code',       'lucide'],
    ['file-text',       'lucide'],
    ['files',           'lucide'],
    ['notebook',        'lucide'],
    ['notebook-pen',    'lucide'],
  ],
  'Code & Dev': [
    ['code',            'lucide'],
    ['code-xml',        'lucide'],
    ['square-terminal', 'lucide'],
    ['terminal',        'lucide'],
    ['git-branch',      'lucide'],
    ['git-merge',       'lucide'],
    ['git-commit-vertical', 'lucide'],
    ['git-fork',        'lucide'],
    ['braces',          'lucide'],
    ['brackets',        'lucide'],
    ['hash',            'lucide'],
    ['variable',        'lucide'],
  ],
  'Infrastructure': [
    ['database',        'lucide'],
    ['database-zap',    'lucide'],
    ['server',          'lucide'],
    ['server-cog',      'lucide'],
    ['cpu',             'lucide'],
    ['hard-drive',      'lucide'],
    ['network',         'lucide'],
    ['wifi',            'lucide'],
    ['cloud',           'lucide'],
    ['cloud-upload',    'lucide'],
    ['globe',           'lucide'],
    ['layers',          'lucide'],
  ],
  'Apps & Tools': [
    ['box',             'lucide'],
    ['package',         'lucide'],
    ['package-2',       'lucide'],
    ['workflow',        'lucide'],
    ['settings',        'lucide'],
    ['settings-2',      'lucide'],
    ['wrench',          'lucide'],
    ['hammer',          'lucide'],
    ['cog',             'lucide'],
    ['tool-case',       'lucide'],
    ['puzzle',          'lucide'],
    ['blocks',          'lucide'],
    ['plug',            'lucide'],
    ['cpu',             'lucide'],
  ],
  'Design & Art': [
    ['palette',         'lucide'],
    ['brush',           'lucide'],
    ['paintbrush',      'lucide'],
    ['wand',            'lucide'],
    ['wand-sparkles',   'lucide'],
    ['sparkles',        'lucide'],
    ['pen-tool',        'lucide'],
    ['pencil',          'lucide'],
    ['scissors',        'lucide'],
    ['crop',            'lucide'],
    ['image',           'lucide'],
    ['camera',          'lucide'],
  ],
  'Learning & Science': [
    ['book-open',       'lucide'],
    ['book',            'lucide'],
    ['scroll',          'lucide'],
    ['flask-conical',   'lucide'],
    ['flask-round',     'lucide'],
    ['microscope',      'lucide'],
    ['test-tube',       'lucide'],
    ['brain',           'lucide'],
    ['brain-circuit',   'lucide'],
    ['atom',            'lucide'],
    ['dna',             'lucide'],
    ['telescope',       'lucide'],
  ],
  'People & Status': [
    ['user',            'lucide'],
    ['users',           'lucide'],
    ['user-round',      'lucide'],
    ['bot',             'lucide'],
    ['rocket',          'lucide'],
    ['star',            'lucide'],
    ['heart',           'lucide'],
    ['zap',             'lucide'],
    ['shield',          'lucide'],
    ['lock',            'lucide'],
    ['key',             'lucide'],
    ['flag',            'lucide'],
    ['trophy',          'lucide'],
    ['medal',           'lucide'],
    ['crown',           'lucide'],
  ],
  'Home & Work': [
    ['house',           'lucide'],
    ['briefcase',       'lucide'],
    ['building',        'lucide'],
    ['building-2',      'lucide'],
    ['store',           'lucide'],
    ['landmark',        'lucide'],
    ['map-pin',         'lucide'],
    ['compass',         'lucide'],
    ['map',             'lucide'],
    ['globe-2',         'lucide'],
    ['mountain',        'lucide'],
  ],
  'Media & Comms': [
    ['monitor',         'lucide'],
    ['laptop',          'lucide'],
    ['smartphone',      'lucide'],
    ['mail',            'lucide'],
    ['message-circle',  'lucide'],
    ['bell',            'lucide'],
    ['phone',           'lucide'],
    ['mic',             'lucide'],
    ['music',           'lucide'],
    ['headphones',      'lucide'],
    ['video',           'lucide'],
    ['radio',           'lucide'],
  ],
  'Nature & Fun': [
    ['sun',             'lucide'],
    ['moon',            'lucide'],
    ['cloud-sun',       'lucide'],
    ['flame',           'lucide'],
    ['waves',           'lucide'],
    ['coffee',          'lucide'],
    ['leaf',            'lucide'],
    ['flower',          'lucide'],
    ['flower-2',        'lucide'],
    ['tree-pine',       'lucide'],
    ['trees',           'lucide'],
    ['snail',           'lucide'],
    ['fish',            'lucide'],
    ['rabbit',          'lucide'],
    ['turtle',          'lucide'],
    ['bird',            'lucide'],
    ['dog',             'lucide'],
    ['cat',             'lucide'],
  ],
  'Lab Extras': [
    ['owl',             'lab'],
    ['planet',          'lab'],
    ['bee',             'lab'],
    ['venn',            'lab'],
    ['copy-code',       'lab'],
    ['grid-lines',      'lab'],
    ['farm',            'lab'],
    ['toolbox',         'lab'],
    ['toolbox-2',       'lab'],
    ['snowman',         'lab'],
    ['mountain-snow',   'lab'],
  ],
};

// ── SVG serializer ────────────────────────────────────────────────────────────
function iconDataToSvg(iconData) {
  const children = iconData.map(([tag, attrs]) => {
    // Filter out non-SVG metadata attrs ('key' is a React/lucide internal)
    const entries = Object.entries(attrs).filter(([k]) => k !== 'key');
    const attrStr = entries.map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${attrStr}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const icons = {};    // { "folder": "<svg>...</svg>", ... }
const categories = {}; // { "Folders & Files": ["folder", "folder-open", ...], ... }
const skipped = [];

for (const [category, entries] of Object.entries(ICON_CATEGORIES)) {
  const catIcons = [];
  for (const [name, pkg] of entries) {
    // De-dup (e.g. 'cpu' appears twice in the list above)
    if (icons[name]) { catIcons.push(name); continue; }

    const iconDir = pkg === 'lab'
      ? resolve(ROOT, `node_modules/@lucide/lab/dist/esm/icons/${name}.js`)
      : resolve(ROOT, `node_modules/lucide/dist/esm/icons/${name}.js`);

    try {
      const src = readFileSync(iconDir, 'utf8');
      // Extract: const <Name> = <array>;\nexport { <Name> as default }
      // Use greedy match up to the last ";" before the export statement
      const match = src.match(/const \w+ = ([\s\S]+?);\s*\nexport/);
      if (!match) { skipped.push(`${name} (parse fail)`); continue; }
      // Evaluate JS object literal (has unquoted keys, not valid JSON)
      const iconData = vm.runInNewContext(`(${match[1]})`);
      icons[name] = iconDataToSvg(iconData);
      catIcons.push(name);
    } catch {
      skipped.push(`${name} (${pkg})`);
    }
  }
  if (catIcons.length > 0) categories[category] = catIcons;
}

// ── Output ────────────────────────────────────────────────────────────────────
mkdirSync(resolve(ROOT, 'src/web/public/vendor'), { recursive: true });

const output = `/* lucide icons bundle, generated by scripts/build-lucide-bundle.mjs */
/* Includes ${Object.keys(icons).length} icons from lucide + @lucide/lab */
(function() {
  window.__lucideIcons = ${JSON.stringify(icons)};
  window.__lucideIconCategories = ${JSON.stringify(categories)};
  document.dispatchEvent(new Event('lucide-ready'));
})();
`;

writeFileSync(OUT, output);
console.log(`✓ Built ${Object.keys(icons).length} icons → src/web/public/vendor/lucide.bundle.js`);
if (skipped.length) console.log(`  Skipped (not found): ${skipped.join(', ')}`);
