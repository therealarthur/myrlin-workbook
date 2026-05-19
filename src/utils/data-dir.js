/**
 * Canonical data directory for Myrlin Workbook.
 *
 * All persistent state (workspaces.json, layout.json, docs/, backups/) lives
 * under ~/.myrlin/ so that every launch method (npm run gui, npx myrlin-workbook,
 * global install) reads and writes the same data.
 *
 * Override with CWM_DATA_DIR env var for development or custom installs.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Path to the legacy in-repo ./state/ directory. Tests historically pointed
 * CWM_DATA_DIR at this path and on 2026-05-11 it wiped the user's real
 * workspaces.json with 1019 pty-test-ws-* / codex-test-ws-* entries. The
 * guard below refuses to use that path unless explicitly opted in.
 */
const LEGACY_PROJECT_STATE_DIR = path.resolve(__dirname, '..', '..', 'state');

/** Resolve the canonical data directory, creating it if needed. */
function getDataDir() {
  if (process.env.CWM_DATA_DIR) {
    const custom = path.resolve(process.env.CWM_DATA_DIR);

    // Defense in depth on top of test/_test-data-dir.js. Any process pointing
    // CWM_DATA_DIR at the in-repo ./state/ is either a misconfigured test
    // or a developer running on the legacy layout. Refuse the production
    // dir by default; require an explicit opt-in to override.
    if (custom === LEGACY_PROJECT_STATE_DIR && process.env.CWM_TEST_ALLOW_PROD_DIR !== '1') {
      throw new Error(
        '[data-dir] Refusing to use CWM_DATA_DIR=' + custom + ' because that path is the in-repo ' +
        'legacy ./state/ directory which contains production data. If you really mean this, set ' +
        'CWM_TEST_ALLOW_PROD_DIR=1. Otherwise point CWM_DATA_DIR at a tmpdir (tests should use ' +
        'test/_test-data-dir.js).'
      );
    }

    if (!fs.existsSync(custom)) {
      fs.mkdirSync(custom, { recursive: true });
    }
    return custom;
  }
  const dir = path.join(os.homedir(), '.myrlin');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Migrate state files from old __dirname-relative ./state/ to ~/.myrlin/.
 * Only runs once: skips if the target already has a valid workspaces.json.
 *
 * Skipped entirely if CWM_DATA_DIR is set. The migration's purpose is the
 * one-time move from the project-local layout to ~/.myrlin/ for fresh users;
 * any explicit data-dir override (tests, custom installs) should get a
 * clean directory, not silently inherit production data. Before this guard
 * existed, test sandboxes that used a tmpdir picked up the project's
 * ./state/ contents on first init() and reported wrong counts.
 *
 * @param {string} legacyDir - The old state directory (project-local ./state/)
 */
function migrateFromLegacy(legacyDir) {
  if (process.env.CWM_DATA_DIR) return;
  const dataDir = getDataDir();
  const targetState = path.join(dataDir, 'workspaces.json');

  // If ~/.myrlin/workspaces.json already exists and is valid, skip migration
  if (fs.existsSync(targetState)) {
    try {
      const raw = fs.readFileSync(targetState, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.workspaces) return; // Already migrated
    } catch (_) {
      // Target exists but is invalid; try migrating over it
    }
  }

  if (!legacyDir || !fs.existsSync(legacyDir)) return;

  // Files to migrate
  const filesToMigrate = ['workspaces.json', 'workspaces.backup.json', 'layout.json', 'config.json'];

  for (const file of filesToMigrate) {
    const src = path.join(legacyDir, file);
    const dest = path.join(dataDir, file);
    if (!fs.existsSync(src)) continue;
    // Only migrate if source has real content (not all zeros)
    try {
      const buf = fs.readFileSync(src);
      const hasContent = buf.some(b => b !== 0);
      if (hasContent) {
        fs.copyFileSync(src, dest);
        console.log(`[Migration] Copied ${file} to ~/.myrlin/`);
      }
    } catch (_) {
      // Skip files that can't be read
    }
  }

  // Migrate docs/ subdirectory
  const legacyDocs = path.join(legacyDir, 'docs');
  const targetDocs = path.join(dataDir, 'docs');
  if (fs.existsSync(legacyDocs)) {
    if (!fs.existsSync(targetDocs)) {
      fs.mkdirSync(targetDocs, { recursive: true });
    }
    try {
      const docFiles = fs.readdirSync(legacyDocs);
      for (const file of docFiles) {
        const src = path.join(legacyDocs, file);
        const dest = path.join(targetDocs, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          console.log(`[Migration] Copied docs/${file} to ~/.myrlin/docs/`);
        }
      }
    } catch (_) {}
  }

  // Migrate backups/ subdirectory
  const legacyBackups = path.join(legacyDir, 'backups');
  const targetBackups = path.join(dataDir, 'backups');
  if (fs.existsSync(legacyBackups)) {
    if (!fs.existsSync(targetBackups)) {
      fs.mkdirSync(targetBackups, { recursive: true });
    }
    try {
      const backupFiles = fs.readdirSync(legacyBackups);
      for (const file of backupFiles) {
        const src = path.join(legacyBackups, file);
        const dest = path.join(targetBackups, file);
        if (!fs.existsSync(dest)) {
          const buf = fs.readFileSync(src);
          if (buf.some(b => b !== 0)) {
            fs.copyFileSync(src, dest);
          }
        }
      }
    } catch (_) {}
  }
}

module.exports = { getDataDir, migrateFromLegacy };
