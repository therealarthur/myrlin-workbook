/**
 * Slash commands for the composer's "/" list (PROTOCOL.md 4.4.8).
 *
 * What: the built in commands of the installed CLIs, pinned in this file,
 * then the command files: Claude's ~/.claude/commands/**.md (user) and
 * <workingDir>/.claude/commands/**.md (project), named by relative path with
 * "/" turned into ":", and Codex's ~/.codex/prompts/*.md as prompts:<name>.
 * Descriptions come from front matter, else the first non empty line. Built
 * from the file system with a 30 s cache per working directory; never spawns
 * a CLI (P24).
 *
 * Why: typing "/" on the phone must answer at once, and the list must match
 * what the desktop TUI would accept.
 *
 * Source of CLAUDE_BUILTINS: the "/" menu of Claude Code 2.1.283 captured in
 * the B2 scratch run (test/mobile/fixtures/scratch/claude-2.1.283-live-evidence.json,
 * the alphabetical built in block from add-dir to workflows; skills, plugins
 * and user commands of that machine are excluded). CODEX_BUILTINS: codex-cli
 * 0.153.4 was not captured (no scratch Codex run, see the B2 report); the list
 * is the TUI's documented slash commands and is marked UNVERIFIED.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_TTL_MS = 30000;
const MAX_COMMANDS = 200;
const DESCRIPTION_MAX = 100;
const MAX_DEPTH = 4;
const HEAD_BYTES = 4096;

const CLAUDE_BUILTINS = [
  ["add-dir", "Add a new working directory"],
  ["advisor", "Let Claude consult a stronger model at key moments"],
  ["artifacts", "Browse your published and shared artifacts"],
  ["auto-mode-setup", "Teach auto mode about your environment, plus optional rule tweaks"],
  ["autocompact", "Set how full the context gets before auto-summarizing"],
  ["autofix-pr", "Monitor and autofix any issues with the current PR"],
  ["background", "Send this session to the background and free the terminal"],
  ["branch", "Create a branch of the current conversation at this point"],
  ["btw", "Ask a quick side question without interrupting the main conversation"],
  ["bug", "Report a bug or share your conversation"],
  ["cd", "Move this session to a new working directory"],
  ["chrome", "Open Claude in Chrome settings"],
  ["color", "Set the prompt bar color for this session"],
  ["compact", "Free up context by summarizing the conversation so far"],
  ["config", "Open settings"],
  ["context", "Visualize current context usage as a colored grid"],
  ["desktop", "Continue the current session in Claude Desktop"],
  ["diff", "Toggle the diff panel showing uncommitted changes"],
  ["effort", "Set effort level for model usage"],
  ["exit", "Exit the CLI"],
  ["export", "Export the current conversation to a file or clipboard"],
  ["fast", "Toggle fast mode (Opus 5.5)"],
  ["feedback", "Send feedback to Anthropic or report a bug"],
  ["focus", "Toggle focus view: just your prompt, summary, and response"],
  ["goal", "Set a goal Claude checks before stopping"],
  ["help", "Show help and available commands"],
  ["hooks", "View hook configurations for tool events"],
  ["ide", "Manage IDE integrations and show status"],
  ["import", "Import config from another AI coding agent"],
  ["install-github-app", "Set up Claude GitHub Actions for a repository"],
  ["install-slack-app", "Install the Claude Slack app"],
  ["keybindings", "Open your keyboard shortcuts file"],
  ["list-agents", "List subagents, teammates, and other Claude sessions you can message"],
  ["login", "Sign in with your Anthropic account"],
  ["logout", "Sign out from your Anthropic account"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit CLAUDE.md files and memory settings"],
  ["mobile", "Show QR code to download the Claude mobile app"],
  ["model", "Set the AI model for Claude Code (currently Haiku 4.5)"],
  ["output-style", "List output styles or switch to one"],
  ["permissions", "Manage allow and deny tool permission rules"],
  ["plan", "Enable plan mode or view the current session plan"],
  ["plugin", "Manage Claude Code plugins"],
  ["powerup", "Discover Claude Code features through quick interactive lessons"],
  ["privacy-settings", "View and update your privacy settings"],
  ["radio", "Listen to Claude FM lo-fi radio"],
  ["recap", "Generate a one-line session recap now"],
  ["release-notes", "View release notes"],
  ["reload-plugins", "Activate pending plugin changes in the current session"],
  ["reload-skills", "Pick up skills added or changed on disk during this session"],
  ["remote-control", "Control this session from your phone or claude.ai/code"],
  ["remote-env", "Choose the default environment for cloud agents"],
  ["rename", "Rename the current conversation"],
  ["resume", "Resume a previous conversation"],
  ["rewind", "Restore the code and/or conversation to a previous point"],
  ["scroll-speed", "Adjust mouse wheel scroll speed"],
  ["skill-doctor", "Show which loaded skills are unused and costing context"],
  ["skills", "List available skills"],
  ["subtask", "Send a subagent off with your full context; its result comes back"],
  ["tasks", "View and manage everything running in the background"],
  ["teleport", "Send this session to the cloud, or resume one from claude.ai"],
  ["terminal-setup", "Install Shift+Enter key binding for newlines"],
  ["theme", "Change the theme"],
  ["tui", "Set the terminal UI renderer (default | fullscreen)"],
  ["ultrareview", "3 free left \u00b7 Start a cloud agent that finds and verifies bugs in"],
  ["upgrade", "Upgrade to Max for higher rate limits and more Opus"],
  ["voice", "Toggle voice mode"],
  ["web-setup", "Set up cloud sessions with your GitHub account"],
  ["workflows", "Browse running and completed workflows"],
];

const CODEX_BUILTINS = [
  ['approvals', 'Choose what Codex can do without approval'],
  ['compact', 'Summarize the conversation to free context'],
  ['diff', 'Show the git diff, including untracked files'],
  ['init', 'Create an AGENTS.md file with instructions for Codex'],
  ['mcp', 'List configured MCP tools'],
  ['mention', 'Mention a file'],
  ['model', 'Choose the model and reasoning effort'],
  ['new', 'Start a new chat'],
  ['quit', 'Exit Codex'],
  ['review', 'Review the current changes'],
  ['status', 'Show the session configuration and token usage'],
];

/**
 * Description of a command file: front matter description, else first line.
 * @param {string} file
 * @returns {string|null}
 */
function describe(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch (_) { return null; }
  const lines = text.split(/\r?\n/);
  if (lines[0] && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { lines.splice(0, i + 1); break; }
      const m = /^description:\s*(.*)$/.exec(lines[i]);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim().slice(0, DESCRIPTION_MAX) || null;
    }
  }
  const first = lines.map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  return first ? first.slice(0, DESCRIPTION_MAX) : null;
}

/**
 * Command files under a folder, named by relative path.
 * @param {string} root
 * @param {string} source
 * @param {string} [prefix]
 * @returns {Array<{name: string, description: (string|null), source: string}>}
 */
function scan(root, source, prefix) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < MAX_DEPTH) walk(full, rel.concat(e.name), depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const name = (prefix || '') + rel.concat(e.name.slice(0, -3)).join(':');
        out.push({ name, description: describe(full), source });
      }
    }
  };
  walk(root, [], 0);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * @param {object} [opts] - {homeDir: () => string, codexHome: () => string, now}
 * @returns {object}
 */
function createCommands(opts = {}) {
  const homeDir = opts.homeDir || (() => os.homedir());
  const codexHome = opts.codexHome || (() => process.env.CODEX_HOME || path.join(homeDir(), '.codex'));
  const now = opts.now || Date.now;
  const cache = new Map();

  /**
   * The command list of a provider and working directory.
   * @param {'claude'|'codex'} provider
   * @param {string|null} workingDir
   * @returns {Array<object>}
   */
  function listFor(provider, workingDir) {
    const k = provider + '|' + (workingDir || '');
    const hit = cache.get(k);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.list;
    let list;
    if (provider === 'claude') {
      const builtins = CLAUDE_BUILTINS.map(([name, description]) => ({ name, description, source: 'builtin' }));
      const user = scan(path.join(homeDir(), '.claude', 'commands'), 'user');
      const project = workingDir ? scan(path.join(workingDir, '.claude', 'commands'), 'project') : [];
      list = builtins.concat(user, project);
    } else {
      const builtins = CODEX_BUILTINS.map(([name, description]) => ({ name, description, source: 'builtin' }));
      list = builtins.concat(scan(path.join(codexHome(), 'prompts'), 'user', 'prompts:'));
    }
    const seen = new Set();
    list = list.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true))).slice(0, MAX_COMMANDS);
    cache.set(k, { at: now(), list });
    return list;
  }

  return { listFor, CLAUDE_BUILTINS, CODEX_BUILTINS };
}

module.exports = { createCommands, describe, CLAUDE_BUILTINS, CODEX_BUILTINS };
