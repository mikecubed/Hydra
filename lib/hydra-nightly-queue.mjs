#!/usr/bin/env node
/**
 * Hydra Nightly Queue - Task queue parser for autonomous overnight runs.
 *
 * Reads tasks from nightly-queue.md (user-curated) or falls back to TODO.md.
 * Parses markdown task lists, extracts optional config overrides, and filters
 * out human-required tasks via skip patterns.
 *
 * Usage:
 *   import { loadNightlyQueue } from './hydra-nightly-queue.mjs';
 *   const { tasks, config, source } = loadNightlyQueue(projectRoot);
 */

import fs from 'fs';
import path from 'path';

// ── Skip Patterns ───────────────────────────────────────────────────────────
// Tasks matching these patterns require human involvement and should be skipped.

const SKIP_PATTERNS = [
  /\btesting sprint\b/i,
  /\bapp store\b/i,
  /\btestflight\b/i,
  /\bapple developer\b/i,
  /\bpurchase\b/i,
  /\b\$\d+/,                         // Dollar amounts (purchases)
  /\brequires.*account\b/i,
  /\brequires.*setup\b/i,
  /\bmanual\b/i,
  /\bcoordination\b/i,
  /\bdm\b.*\bsession\b/i,
  /\bfriend session\b/i,
  /\breview with\b/i,
  /\btest.*device/i,
  /\bgps verification at actual/i,
  /\bcollect feedback\b/i,
  /\benrollment\b/i,
  /\bsubmission\b/i,
];

// ── Config Defaults ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  maxTasks: 5,
  maxHours: 6,
  mode: 'economy',
  agent: 'claude',
  perTaskTimeoutMin: 15,
};

// ── Queue File Parser ───────────────────────────────────────────────────────

/**
 * Parse a nightly-queue.md file.
 * Format:
 *   ## Tasks
 *   - Task description here
 *   - Another task
 *
 *   ## Config
 *   <!-- max-tasks: 3 -->
 *   <!-- max-hours: 4 -->
 *   <!-- mode: economy -->
 *   <!-- agent: claude -->
 *
 * @param {string} content - Raw markdown content
 * @returns {{ tasks: string[], config: object }}
 */
function parseQueueFile(content) {
  const tasks = [];
  const config = { ...DEFAULT_CONFIG };

  const lines = content.split('\n');
  let inTasksSection = false;
  let inConfigSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Section detection
    if (/^##\s+Tasks/i.test(trimmed)) {
      inTasksSection = true;
      inConfigSection = false;
      continue;
    }
    if (/^##\s+Config/i.test(trimmed)) {
      inConfigSection = true;
      inTasksSection = false;
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      inTasksSection = false;
      inConfigSection = false;
      continue;
    }

    // Parse tasks: lines starting with - or * (not checkboxes that are checked)
    if (inTasksSection) {
      const taskMatch = trimmed.match(/^[-*]\s+(?:\[[ ]\]\s+)?(.+)/);
      if (taskMatch) {
        const taskText = taskMatch[1].replace(/\*\*/g, '').trim();
        if (taskText) tasks.push(taskText);
      }
    }

    // Parse config: HTML comments with key: value
    if (inConfigSection) {
      const configMatch = trimmed.match(/<!--\s*([\w-]+)\s*:\s*(.+?)\s*-->/);
      if (configMatch) {
        const [, key, value] = configMatch;
        const normalizedKey = key.toLowerCase().replace(/-/g, '');
        switch (normalizedKey) {
          case 'maxtasks':
            config.maxTasks = parseInt(value, 10) || DEFAULT_CONFIG.maxTasks;
            break;
          case 'maxhours':
            config.maxHours = parseFloat(value) || DEFAULT_CONFIG.maxHours;
            break;
          case 'mode':
            config.mode = value.trim().toLowerCase();
            break;
          case 'agent':
            config.agent = value.trim().toLowerCase();
            break;
          case 'pertasktimeout':
          case 'pertasktimeoutmin':
            config.perTaskTimeoutMin = parseInt(value, 10) || DEFAULT_CONFIG.perTaskTimeoutMin;
            break;
        }
      }
    }
  }

  return { tasks, config };
}

// ── TODO.md Fallback Parser ─────────────────────────────────────────────────

/**
 * Priority sections in TODO.md, ordered by urgency.
 * We extract unchecked items from these sections.
 */
const TODO_SECTION_PRIORITY = [
  'Alpha Blockers',
  'Active Technical Debt',
  'Backlog - Tier 1',
  'Backlog - Tier 2',
  'Known Issues',
];

/**
 * Parse TODO.md and extract unchecked tasks by priority section.
 *
 * @param {string} content - Raw TODO.md content
 * @returns {string[]} Tasks ordered by priority
 */
function parseTodoFile(content) {
  const tasks = [];
  const lines = content.split('\n');
  let currentSection = '';

  // Build a map of section -> tasks
  const sectionTasks = new Map();

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers (## N. Section Name)
    const sectionMatch = trimmed.match(/^##\s+\d+\.\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Also catch plain ## headers
    const plainSection = trimmed.match(/^##\s+(.+)/);
    if (plainSection && !sectionMatch) {
      currentSection = plainSection[1].trim();
      continue;
    }

    // Only look for unchecked items (- [ ] ...)
    const unchecked = trimmed.match(/^-\s+\[\s\]\s+(.+)/);
    if (unchecked && currentSection) {
      const taskText = unchecked[1].replace(/\*\*/g, '').trim();
      // Remove markdown links
      const cleaned = taskText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
      if (cleaned) {
        if (!sectionTasks.has(currentSection)) {
          sectionTasks.set(currentSection, []);
        }
        sectionTasks.get(currentSection).push(cleaned);
      }
    }
  }

  // Flatten by priority order
  for (const sectionName of TODO_SECTION_PRIORITY) {
    for (const [key, items] of sectionTasks) {
      if (key.includes(sectionName) || sectionName.includes(key.replace(/[^a-zA-Z ]/g, '').trim())) {
        tasks.push(...items);
      }
    }
  }

  // Add any remaining sections not in priority list
  for (const [key, items] of sectionTasks) {
    const alreadyAdded = TODO_SECTION_PRIORITY.some(
      (p) => key.includes(p) || p.includes(key.replace(/[^a-zA-Z ]/g, '').trim())
    );
    if (!alreadyAdded) {
      tasks.push(...items);
    }
  }

  return tasks;
}

// ── Task Filtering ──────────────────────────────────────────────────────────

/**
 * Filter out tasks that require human involvement.
 * @param {string[]} tasks
 * @returns {string[]}
 */
function filterHumanTasks(tasks) {
  return tasks.filter((task) => {
    return !SKIP_PATTERNS.some((pattern) => pattern.test(task));
  });
}

/**
 * Generate a URL-safe branch slug from a task description.
 * @param {string} task
 * @returns {string}
 */
export function taskToSlug(task) {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')     // Remove special chars
    .replace(/\s+/g, '-')              // Spaces to hyphens
    .replace(/-+/g, '-')               // Collapse multiple hyphens
    .replace(/^-|-$/g, '')             // Trim leading/trailing hyphens
    .slice(0, 50);                     // Cap length
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Load the nightly task queue from nightly-queue.md or fall back to TODO.md.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [options]
 * @param {number} [options.maxTasks] - Override max tasks
 * @returns {{ tasks: Array<{title: string, slug: string}>, config: object, source: string }}
 */
export function loadNightlyQueue(projectRoot, options = {}) {
  const queuePath = path.join(projectRoot, 'nightly-queue.md');
  const todoPath = path.join(projectRoot, 'docs', 'TODO.md');

  let rawTasks = [];
  let config = { ...DEFAULT_CONFIG };
  let source = 'none';

  // Try nightly-queue.md first
  if (fs.existsSync(queuePath)) {
    const content = fs.readFileSync(queuePath, 'utf8');
    const parsed = parseQueueFile(content);
    if (parsed.tasks.length > 0) {
      rawTasks = parsed.tasks;
      config = { ...config, ...parsed.config };
      source = 'nightly-queue.md';
    }
  }

  // Fall back to TODO.md
  if (rawTasks.length === 0 && fs.existsSync(todoPath)) {
    const content = fs.readFileSync(todoPath, 'utf8');
    rawTasks = parseTodoFile(content);
    source = 'TODO.md';
  }

  // Filter human-required tasks
  const filtered = filterHumanTasks(rawTasks);

  // Apply max tasks limit
  const maxTasks = options.maxTasks || config.maxTasks;
  const capped = filtered.slice(0, maxTasks);

  // Build structured task list
  const tasks = capped.map((title) => ({
    title,
    slug: taskToSlug(title),
  }));

  return { tasks, config, source };
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))) {
  const projectRoot = process.argv[2] || process.cwd();
  const { tasks, config, source } = loadNightlyQueue(projectRoot);

  console.log(`Source: ${source}`);
  console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  console.log(`\nTasks (${tasks.length}):`);
  for (const task of tasks) {
    console.log(`  - [${task.slug}] ${task.title}`);
  }
}
