/**
 * Workspace Documentation Manager
 *
 * Handles reading, writing, and parsing per-workspace markdown documentation files.
 * Each workspace gets a dedicated file at state/docs/{workspaceId}.md with three
 * structured sections: Notes, Goals, and Tasks.
 *
 * This is a pure utility module with no EventEmitter dependency — the store
 * calls these functions and emits events itself.
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', '..', 'state', 'docs');

/**
 * Ensure the state/docs/ directory exists.
 */
function ensureDocsDir() {
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
}

/**
 * Get the absolute path to a workspace's docs file.
 * @param {string} workspaceId
 * @returns {string}
 */
function getDocsPath(workspaceId) {
  return path.join(DOCS_DIR, `${workspaceId}.md`);
}

/**
 * Parse a raw markdown string into structured sections.
 * Preserves unknown lines so hand-edits aren't lost.
 *
 * @param {string} raw - Raw markdown content
 * @returns {{ notes: Array, goals: Array, tasks: Array, roadmap: Array, preamble: string }}
 */
function parseDocs(raw) {
  const notes = [];
  const goals = [];
  const tasks = [];
  const roadmap = [];
  const rules = [];
  let preamble = '';

  let currentSection = null; // 'notes' | 'goals' | 'tasks' | 'roadmap' | 'rules' | null

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (/^## Notes\s*$/i.test(trimmed)) {
      currentSection = 'notes';
      continue;
    }
    if (/^## Goals\s*$/i.test(trimmed)) {
      currentSection = 'goals';
      continue;
    }
    if (/^## Tasks\s*$/i.test(trimmed)) {
      currentSection = 'tasks';
      continue;
    }
    if (/^## Roadmap\s*$/i.test(trimmed)) {
      currentSection = 'roadmap';
      continue;
    }
    if (/^## Rules\s*$/i.test(trimmed)) {
      currentSection = 'rules';
      continue;
    }
    // Any other ## header ends the current section
    if (/^## /.test(trimmed) && currentSection) {
      currentSection = null;
    }

    // Skip empty lines
    if (trimmed === '') continue;

    // Skip top-level heading (# Workspace: ...)
    if (/^# /.test(trimmed) && !currentSection) {
      preamble = trimmed;
      continue;
    }

    if (currentSection === 'notes' && trimmed.startsWith('- ')) {
      const content = trimmed.substring(2);
      // Parse "timestamp | text" format
      const pipeIdx = content.indexOf(' | ');
      if (pipeIdx > 0) {
        notes.push({
          timestamp: content.substring(0, pipeIdx).trim(),
          text: content.substring(pipeIdx + 3).trim(),
        });
      } else {
        notes.push({ timestamp: '', text: content });
      }
    } else if (currentSection === 'goals' && /^- \[[ xX]\] /.test(trimmed)) {
      const done = /^- \[[xX]\]/.test(trimmed);
      const text = trimmed.replace(/^- \[[ xX]\] /, '');
      goals.push({ text, done });
    } else if (currentSection === 'tasks' && /^- \[[ xX]\] /.test(trimmed)) {
      const done = /^- \[[xX]\]/.test(trimmed);
      const text = trimmed.replace(/^- \[[ xX]\] /, '');
      tasks.push({ text, done });
    } else if (currentSection === 'roadmap' && /^- \[(planned|active|done)\] /.test(trimmed)) {
      const statusMatch = trimmed.match(/^- \[(planned|active|done)\] (.*)/);
      if (statusMatch) {
        roadmap.push({ text: statusMatch[2], status: statusMatch[1] });
      }
    } else if (currentSection === 'rules' && trimmed.startsWith('- ')) {
      rules.push({ text: trimmed.substring(2) });
    }
    // Unknown lines in sections are silently skipped in parsed output
    // but preserved in the raw content
  }

  return { notes, goals, tasks, roadmap, rules, preamble };
}

/**
 * Build raw markdown from structured sections.
 * @param {string} title - Workspace name for the heading
 * @param {Array} notes
 * @param {Array} goals
 * @param {Array} tasks
 * @param {Array} [roadmap=[]] - Roadmap items with { text, status } (planned|active|done)
 * @returns {string}
 */
function buildMarkdown(title, notes, goals, tasks, roadmap = [], rules = []) {
  const lines = [];

  lines.push(`# Workspace: ${title}`);
  lines.push('');

  lines.push('## Notes');
  if (notes.length === 0) {
    lines.push('');
  } else {
    for (const n of notes) {
      if (n.timestamp) {
        lines.push(`- ${n.timestamp} | ${n.text}`);
      } else {
        lines.push(`- ${n.text}`);
      }
    }
    lines.push('');
  }

  lines.push('## Goals');
  if (goals.length === 0) {
    lines.push('');
  } else {
    for (const g of goals) {
      lines.push(`- [${g.done ? 'x' : ' '}] ${g.text}`);
    }
    lines.push('');
  }

  lines.push('## Tasks');
  if (tasks.length === 0) {
    lines.push('');
  } else {
    for (const t of tasks) {
      lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
    }
    lines.push('');
  }

  lines.push('## Roadmap');
  if (roadmap.length === 0) {
    lines.push('');
  } else {
    for (const r of roadmap) {
      lines.push(`- [${r.status || 'planned'}] ${r.text}`);
    }
    lines.push('');
  }

  lines.push('## Rules');
  if (rules.length === 0) {
    lines.push('');
  } else {
    for (const r of rules) {
      lines.push(`- ${r.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Read and parse a workspace's documentation.
 * @param {string} workspaceId
 * @returns {{ raw: string, notes: Array, goals: Array, tasks: Array, roadmap: Array } | null}
 */
function readDocs(workspaceId) {
  const filePath = getDocsPath(workspaceId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseDocs(raw);
  return {
    raw,
    notes: parsed.notes,
    goals: parsed.goals,
    tasks: parsed.tasks,
    roadmap: parsed.roadmap,
    rules: parsed.rules,
  };
}

/**
 * Write raw markdown content to a workspace's docs file.
 * @param {string} workspaceId
 * @param {string} content - Raw markdown string
 */
function writeDocs(workspaceId, content) {
  ensureDocsDir();
  const filePath = getDocsPath(workspaceId);
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Read docs or create a default empty structure.
 * @param {string} workspaceId
 * @param {string} workspaceName - Used for heading if creating new
 * @returns {{ raw: string, notes: Array, goals: Array, tasks: Array, roadmap: Array }}
 */
function readOrCreate(workspaceId, workspaceName) {
  const existing = readDocs(workspaceId);
  if (existing) return existing;
  // Create with empty sections
  const raw = buildMarkdown(workspaceName || 'Untitled', [], [], [], [], []);
  writeDocs(workspaceId, raw);
  return { raw, notes: [], goals: [], tasks: [], roadmap: [], rules: [] };
}

/**
 * Append a timestamped note to a workspace's docs.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} text
 */
function appendNote(workspaceId, workspaceName, text) {
  const docs = readOrCreate(workspaceId, workspaceName);
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');
  docs.notes.push({ timestamp, text });
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules || []);
  writeDocs(workspaceId, raw);
}

/**
 * Append a goal to a workspace's docs.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} text
 * @param {boolean} [done=false]
 */
function appendGoal(workspaceId, workspaceName, text, done = false) {
  const docs = readOrCreate(workspaceId, workspaceName);
  docs.goals.push({ text, done });
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules || []);
  writeDocs(workspaceId, raw);
}

/**
 * Append a task to a workspace's docs.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} text
 * @param {boolean} [done=false]
 */
function appendTask(workspaceId, workspaceName, text, done = false) {
  const docs = readOrCreate(workspaceId, workspaceName);
  docs.tasks.push({ text, done });
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules || []);
  writeDocs(workspaceId, raw);
}

/**
 * Toggle done state of an item in a section.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} section - 'goals' or 'tasks'
 * @param {number} index
 * @returns {boolean} success
 */
function toggleItem(workspaceId, workspaceName, section, index) {
  const docs = readOrCreate(workspaceId, workspaceName);
  const items = docs[section];
  if (!items || index < 0 || index >= items.length) return false;
  items[index].done = !items[index].done;
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules || []);
  writeDocs(workspaceId, raw);
  return true;
}

/**
 * Remove an item from a section by index.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} section - 'notes', 'goals', or 'tasks'
 * @param {number} index
 * @returns {boolean} success
 */
function removeItem(workspaceId, workspaceName, section, index) {
  const docs = readOrCreate(workspaceId, workspaceName);
  const items = docs[section];
  if (!items || index < 0 || index >= items.length) return false;
  items.splice(index, 1);
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules || []);
  writeDocs(workspaceId, raw);
  return true;
}

/**
 * Append a rule to a workspace's docs.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} text
 */
function appendRule(workspaceId, workspaceName, text) {
  const docs = readOrCreate(workspaceId, workspaceName);
  docs.rules = docs.rules || [];
  docs.rules.push({ text });
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules);
  writeDocs(workspaceId, raw);
}

/**
 * Append a roadmap item to a workspace's docs.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} text
 * @param {string} [status='planned'] - 'planned' | 'active' | 'done'
 */
function appendRoadmapItem(workspaceId, workspaceName, text, status = 'planned') {
  const docs = readOrCreate(workspaceId, workspaceName);
  docs.roadmap = docs.roadmap || [];
  docs.roadmap.push({ text, status });
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap, docs.rules || []);
  writeDocs(workspaceId, raw);
}

/**
 * Cycle a roadmap item's status: planned -> active -> done -> planned.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {number} index
 * @returns {boolean} success
 */
function cycleRoadmapStatus(workspaceId, workspaceName, index) {
  const docs = readOrCreate(workspaceId, workspaceName);
  docs.roadmap = docs.roadmap || [];
  if (index < 0 || index >= docs.roadmap.length) return false;
  const current = docs.roadmap[index].status;
  const cycle = { planned: 'active', active: 'done', done: 'planned' };
  docs.roadmap[index].status = cycle[current] || 'planned';
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap, docs.rules || []);
  writeDocs(workspaceId, raw);
  return true;
}

/**
 * Append a rule to a workspace's docs.
 * @param {string} workspaceId
 * @param {string} workspaceName
 * @param {string} text
 */
function appendRule(workspaceId, workspaceName, text) {
  const docs = readOrCreate(workspaceId, workspaceName);
  docs.rules = docs.rules || [];
  docs.rules.push({ text });
  const raw = buildMarkdown(workspaceName || 'Untitled', docs.notes, docs.goals, docs.tasks, docs.roadmap || [], docs.rules);
  writeDocs(workspaceId, raw);
}

/**
 * Delete a workspace's documentation file.
 * @param {string} workspaceId
 */
function deleteDocs(workspaceId) {
  const filePath = getDocsPath(workspaceId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // Ignore if file doesn't exist
  }
}

module.exports = {
  ensureDocsDir,
  getDocsPath,
  parseDocs,
  buildMarkdown,
  readDocs,
  writeDocs,
  readOrCreate,
  appendNote,
  appendGoal,
  appendTask,
  appendRoadmapItem,
  cycleRoadmapStatus,
  appendRule,
  toggleItem,
  removeItem,
  deleteDocs,
};
