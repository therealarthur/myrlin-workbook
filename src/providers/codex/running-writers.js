/**
 * Codex running-writer detection (Quota widget support, W2).
 *
 * WHY: a running Codex process keeps the account it started with and, when
 * its access token needs a refresh, rotates that account's refresh-token
 * family on its own. Swapping ~/.codex/auth.json underneath it is safe for
 * the NEW login (the CLI's guarded reload refuses to write the old tokens
 * over a different account), but the running process stays on the old
 * account until restarted. Arthur's decision (2026-09-25): warn and allow.
 * Workbook lists the running Codex writers, the Quota widget shows them, and
 * "Swap anyway" retries with force:true. NOTHING here ever kills a process.
 *
 * Two pieces, both pure or side-effect free:
 *   listWindowsProcesses()  one read-only PowerShell enumeration
 *                           (Get-CimInstance Win32_Process, 5 s timeout)
 *   isCodexWriterProcess()  the image-path / image-name match rule
 *
 * The lister is NOT invoked implicitly by the generic manager: the server
 * injects it (createProviderAccountManager opts.processLister), so hermetic
 * tests never spawn PowerShell and inject a fake lister instead.
 *
 * Design: claude-swap docs/plans/2026-09-25-usage-widget-design.md section 7
 * (W2); detection paths from docs/research/2026-09-25-codex-usage-auth.md.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/running-writers
 */

'use strict';

const { execFile } = require('child_process');

// ─── Named constants ────────────────────────────────────────────────────────
// Hard ceiling for the enumeration (design W2). execFile's own timeout only
// ever terminates the PowerShell child THIS module started; never another
// process.
const PROCESS_LIST_TIMEOUT_MS = 5000;
// Win32_Process for a busy desktop is a few hundred KB of JSON; this bound
// only guards against a runaway child.
const PROCESS_LIST_MAX_BUFFER = 32 * 1024 * 1024;
const POWERSHELL_EXE = 'powershell.exe';
const PROCESS_LIST_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
// Image-path fragments (lowercased, backslash separators) that identify a
// Codex writer: the Microsoft Store desktop app package, and the npm
// package (its vendored native codex.exe lives under this folder).
const WRITER_PATH_FRAGMENTS = Object.freeze([
  '\\windowsapps\\openai.codex_',
  '\\node_modules\\@openai\\codex\\',
]);
// Image names (lowercased) that identify a Codex writer wherever they live:
// the CLI and IDE-extension binary, and the desktop app's code-mode host.
const WRITER_IMAGE_NAMES = Object.freeze([
  'codex.exe',
  'codex-code-mode-host.exe',
]);
// The 409 code the apply route answers with when a writer is running and
// the request did not say force:true (design W2).
const CODEX_RUNNING_CODE = 'CODEX_RUNNING';

/**
 * Normalize one raw Win32_Process row (or an injected fake) to the public
 * {pid, name, path} shape. Returns null for rows without a usable pid.
 *
 * @param {*} row - {ProcessId, Name, ExecutablePath} or {pid, name, path}.
 * @returns {{pid: number, name: string, path: string|null}|null}
 */
function normalizeProcessRow(row) {
  if (!row || typeof row !== 'object') return null;
  const pid = Number(row.ProcessId !== undefined ? row.ProcessId : row.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const rawName = row.Name !== undefined ? row.Name : row.name;
  const rawPath = row.ExecutablePath !== undefined ? row.ExecutablePath : row.path;
  return {
    pid,
    name: typeof rawName === 'string' ? rawName : '',
    path: (typeof rawPath === 'string' && rawPath) ? rawPath : null,
  };
}

/**
 * Enumerate every process on this Windows machine with one read-only
 * PowerShell call. Resolves to normalized rows; rejects on a non-Windows
 * host, a timeout, a non-zero exit, or unparseable output (the caller turns
 * any rejection into processCheck:"unavailable" and proceeds).
 *
 * @param {{timeoutMs?: number}} [listOpts]
 * @returns {Promise<Array<{pid: number, name: string, path: string|null}>>}
 */
function listWindowsProcesses(listOpts = {}) {
  const timeoutMs = Number(listOpts.timeoutMs) > 0 ? Number(listOpts.timeoutMs) : PROCESS_LIST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('process enumeration is only implemented on Windows'));
      return;
    }
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LIST_SCRIPT], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: PROCESS_LIST_MAX_BUFFER,
    }, (err, stdout) => {
      if (err) {
        reject(new Error('process enumeration failed: ' + (err.killed ? 'timed out' : (err.code || 'error'))));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(String(stdout || '').trim() || '[]');
      } catch (_) {
        reject(new Error('process enumeration returned unparseable output'));
        return;
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      resolve(rows.map(normalizeProcessRow).filter(Boolean));
    });
  });
}

/**
 * The Codex writer match rule (design W2): image path under the Store app
 * package (\WindowsApps\OpenAI.Codex_*) or the npm package
 * (\node_modules\@openai\codex\), or image name codex.exe / Codex.exe (the
 * CLI, the npm vendor binary, and the IDE extension binary all use it) or
 * codex-code-mode-host.exe. Case-insensitive; forward slashes tolerated.
 *
 * @param {{name?: string, path?: string|null}} proc - Normalized row.
 * @returns {boolean} True when the process can write the Codex login.
 */
function isCodexWriterProcess(proc) {
  if (!proc || typeof proc !== 'object') return false;
  const name = String(proc.name || '').toLowerCase();
  const imagePath = String(proc.path || '').replace(/\//g, '\\').toLowerCase();
  if (imagePath && WRITER_PATH_FRAGMENTS.some((frag) => imagePath.includes(frag))) return true;
  if (WRITER_IMAGE_NAMES.includes(name)) return true;
  return false;
}

/**
 * Human-facing copy for the CODEX_RUNNING conflict.
 *
 * @param {Array<{pid: number, name: string}>} processes - Matched writers.
 * @returns {string} Message naming how many writers run and what to do.
 */
function runningConflictMessage(processes) {
  const n = Array.isArray(processes) ? processes.length : 0;
  return 'Codex is running (' + n + ' process' + (n === 1 ? '' : 'es') + '). Running Codex keeps the old account '
    + 'until restarted. Send force:true to swap anyway; nothing is stopped for you.';
}

module.exports = {
  listWindowsProcesses,
  isCodexWriterProcess,
  normalizeProcessRow,
  runningConflictMessage,
  CODEX_RUNNING_CODE,
  PROCESS_LIST_TIMEOUT_MS,
};
