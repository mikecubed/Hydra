/**
 * Hydra Tasks Scanner — Aggregate work items from multiple sources.
 *
 * Sources:
 *   1. TODO/FIXME/HACK/XXX comments in code (via git grep)
 *   2. Unchecked items from docs/TODO.md
 *   3. GitHub issues (via gh CLI)
 *   4. User-provided freeform tasks
 *
 * Exports:
 *   scanAllSources(), scanTodoComments(), scanTodoMd(), scanGitHubIssues(),
 *   createUserTask(), deduplicateTasks(), prioritizeTasks()
 *
 * Usage:
 *   import { scanAllSources } from './hydra-tasks-scanner.ts';
 *   const tasks = await scanAllSources(projectRoot);
 */

import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — cross-spawn has no bundled types; pre-existing across codebase
import spawnRaw from 'cross-spawn';
import { classifyTask, bestAgentFor } from './hydra-agents.ts';
import { classifyPrompt } from './hydra-utils.ts';
import { listIssues, isGhAvailable, isGhAuthenticated } from './hydra-github.ts';
import { loadHydraConfig } from './hydra-config.ts';
import { stripGitEnv } from './hydra-shared/git-ops.ts';
import pc from 'picocolors';
import { exit } from './hydra-process.ts';

interface SpawnSyncResult {
  status: number | null;
  stdout: string;
  stderr?: string;
}

interface SpawnModule {
  sync(cmd: string, args: string[], opts?: Record<string, unknown>): SpawnSyncResult;
}

const spawn = spawnRaw as unknown as SpawnModule;

// ── ScannedTask Shape ───────────────────────────────────────────────────────

export interface ScannedTask {
  id: string;
  title: string;
  slug: string;
  source: 'todo-comment' | 'todo-md' | 'github-issue' | 'user-input';
  sourceRef: string;
  taskType: string;
  suggestedAgent: string;
  complexity: string;
  priority: 'high' | 'medium' | 'low';
  body: string | null;
  issueNumber: number | null;
}

// ── Slug Generator ──────────────────────────────────────────────────────────

export function taskToSlug(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim leading/trailing hyphens
    .slice(0, 50); // Cap length
}

// ── Priority Heuristics ─────────────────────────────────────────────────────

const HIGH_PRIORITY_PATTERNS = [
  /\bFIXME\b/i,
  /\bbug\b/i,
  /\bcrash\b/i,
  /\bbroken\b/i,
  /\bcritical\b/i,
  /\bsecurity\b/i,
  /\brace condition\b/i,
];

const LOW_PRIORITY_PATTERNS = [
  /\bHACK\b/i,
  /\bXXX\b/i,
  /\bcleanup\b/i,
  /\brefactor\b/i,
  /\bnit\b/i,
  /\bcosmetic\b/i,
  /\bdocs?\b/i,
];

function classifyPriority(text: string): 'high' | 'medium' | 'low' {
  if (HIGH_PRIORITY_PATTERNS.some((p) => p.test(text))) return 'high';
  if (LOW_PRIORITY_PATTERNS.some((p) => p.test(text))) return 'low';
  return 'medium';
}

// ── Classify & Build Task ───────────────────────────────────────────────────

function buildTask(
  id: string,
  title: string,
  source: ScannedTask['source'],
  sourceRef: string,
  body: string | null = null,
  issueNumber: number | null = null,
): ScannedTask {
  const taskType = classifyTask(title);
  const agent = bestAgentFor(taskType);
  const { tier } = classifyPrompt(title) as { tier: string };
  const priority = classifyPriority(title);

  return {
    id,
    title,
    slug: taskToSlug(title),
    source,
    sourceRef,
    taskType,
    suggestedAgent: agent,
    complexity: tier,
    priority,
    body,
    issueNumber,
  };
}

// ── Source 1: TODO/FIXME Comments in Code ────────────────────────────────────

/**
 * Scan code for TODO/FIXME/HACK/XXX comments using git grep.
 * Fast, respects .gitignore.
 *
 * @param {string} projectRoot
 * @returns {ScannedTask[]}
 */
export function scanTodoComments(projectRoot: string): ScannedTask[] {
  const result = spawn.sync(
    'git',
    [
      'grep',
      '-n',
      '-i',
      '-E',
      '\\b(TODO|FIXME|HACK|XXX)\\b',
      '--',
      '*.mjs',
      '*.js',
      '*.ts',
      '*.tsx',
      '*.jsx',
      '*.py',
      '*.rs',
      '*.go',
      '*.sh',
      '*.yml',
      '*.yaml',
      '*.sql',
      '.env.example',
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: stripGitEnv(),
    },
  );

  if (result.status !== 0 || !result.stdout) return [];

  const tasks: ScannedTask[] = [];
  const seen = new Set<string>();

  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;

    // Format: file:line:content
    const match = line.match(/^(.+?):(\d+):(.+)$/);
    if (!match) continue;

    const [, filePath, lineNum, content] = match;

    // Skip test files, node_modules, coordination docs
    if (filePath.includes('node_modules/')) continue;
    if (filePath.includes('docs/coordination/')) continue;

    // Extract the comment text after the marker
    const markerMatch = content.match(/((?:\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b)[\s:(]*(.*))/i);
    if (!markerMatch) continue;

    const fullComment = markerMatch[1].trim();
    const rawComment = markerMatch[2].trim();
    const commentBody = rawComment.length > 0 ? rawComment : fullComment;

    // Skip very short/meaningless comments
    if (commentBody.length < 5) continue;

    // Dedup by file+comment
    const dedupeKey = `${filePath}:${commentBody.slice(0, 40)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const title = commentBody.replace(/\*\/\s*$/, '').trim();
    const ref = `${filePath}:${lineNum}`;
    const id = `todo-comment:${ref}`;

    tasks.push(buildTask(id, title, 'todo-comment', ref));
  }

  return tasks;
}

// ── Source 2: docs/TODO.md ──────────────────────────────────────────────────

/**
 * Priority sections in TODO.md, ordered by urgency.
 */
const TODO_SECTION_PRIORITY = [
  'Alpha Blockers',
  'Active Technical Debt',
  'Backlog - Tier 1',
  'Backlog - Tier 2',
  'Known Issues',
];

/**
 * Scan docs/TODO.md for unchecked task items.
 *
 * @param {string} projectRoot
 * @returns {ScannedTask[]}
 */
export function scanTodoMd(projectRoot: string): ScannedTask[] {
  const todoPath = path.join(projectRoot, 'docs', 'TODO.md');
  if (!fs.existsSync(todoPath)) return [];

  let content: string;
  try {
    content = fs.readFileSync(todoPath, 'utf8');
  } catch {
    return [];
  }

  const tasks: ScannedTask[] = [];
  const lines = content.split('\n');
  let currentSection = '';

  // Build section → tasks map
  const sectionTasks = new Map<string, { text: string; section: string }[]>();

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    const sectionMatch = trimmed.match(/^##\s+(?:\d+\.\s+)?(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Unchecked items only
    const unchecked = trimmed.match(/^-\s+\[\s\]\s+(.+)/);
    if (unchecked && currentSection) {
      const taskText = unchecked[1]
        .replace(/\*\*/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
      if (taskText.length >= 5) {
        if (!sectionTasks.has(currentSection)) {
          sectionTasks.set(currentSection, []);
        }
        sectionTasks.get(currentSection)!.push({ text: taskText, section: currentSection });
      }
    }
  }

  // Flatten by priority order
  const ordered = [];
  for (const sectionName of TODO_SECTION_PRIORITY) {
    for (const [key, items] of sectionTasks) {
      if (
        key.includes(sectionName) ||
        sectionName.includes(key.replace(/[^a-zA-Z ]/g, '').trim())
      ) {
        ordered.push(...items);
      }
    }
  }
  // Remaining sections
  for (const [key, items] of sectionTasks) {
    const alreadyAdded = TODO_SECTION_PRIORITY.some(
      (p) => key.includes(p) || p.includes(key.replace(/[^a-zA-Z ]/g, '').trim()),
    );
    if (!alreadyAdded) ordered.push(...items);
  }

  for (const item of ordered) {
    const slug = taskToSlug(item.text);
    const id = `todo-md:${slug}`;
    tasks.push(buildTask(id, item.text, 'todo-md', item.section));
  }

  return tasks;
}

// ── Source 3: GitHub Issues ─────────────────────────────────────────────────

/**
 * Scan GitHub issues via gh CLI.
 *
 * @param {string} projectRoot
 * @param {{ labels?: string[], limit?: number }} [opts={}]
 * @returns {ScannedTask[]}
 */
interface GitHubIssueOpts {
  labels?: string[];
  limit?: number;
}

export function scanGitHubIssues(projectRoot: string, opts: GitHubIssueOpts = {}): ScannedTask[] {
  if (!isGhAvailable() || !isGhAuthenticated()) return [];

  const issues = listIssues({
    cwd: projectRoot,
    state: 'open',
    labels: opts.labels ?? [],
    limit: opts.limit ?? 50,
  }) as Array<{ title?: string; number: number; body?: string }>;

  return issues.map((issue) => {
    const title = issue.title ?? `Issue #${String(issue.number)}`;
    const id = `github:${String(issue.number)}`;
    const body = issue.body ?? null;

    return buildTask(id, title, 'github-issue', `#${String(issue.number)}`, body, issue.number);
  });
}

// ── Source 4: User-Provided Task ────────────────────────────────────────────

/**
 * Create a ScannedTask from freeform user input.
 *
 * @param {string} text
 * @returns {ScannedTask}
 */
export function createUserTask(text: string): ScannedTask {
  const slug = taskToSlug(text);
  return buildTask(`user:${slug}`, text, 'user-input', 'manual');
}

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Deduplicate tasks by title similarity. Uses slug comparison.
 *
 * @param {ScannedTask[]} tasks
 * @returns {ScannedTask[]}
 */
export function deduplicateTasks(tasks: ScannedTask[]): ScannedTask[] {
  const seen = new Map<string, ScannedTask>();
  const result: ScannedTask[] = [];

  for (const task of tasks) {
    // Normalize slug for comparison
    const key = task.slug;
    if (seen.has(key)) continue;
    seen.set(key, task);
    result.push(task);
  }

  return result;
}

// ── Prioritization ──────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const COMPLEXITY_ORDER = { simple: 0, moderate: 1, complex: 2 };

/**
 * Sort tasks by priority (high first), then complexity (simple first).
 *
 * @param {ScannedTask[]} tasks
 * @returns {ScannedTask[]}
 */
export function prioritizeTasks(tasks: ScannedTask[]): ScannedTask[] {
  return [...tasks].sort((a, b) => {
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pDiff !== 0) return pDiff;
    const aComp = COMPLEXITY_ORDER[a.complexity as keyof typeof COMPLEXITY_ORDER];
    const bComp = COMPLEXITY_ORDER[b.complexity as keyof typeof COMPLEXITY_ORDER];
    return aComp - bComp;
  });
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Scan all configured sources and return a deduplicated, prioritized task list.
 *
 * @param {string} projectRoot
 * @param {{ todoComments?: boolean, todoMd?: boolean, githubIssues?: boolean, githubLabels?: string[] }} [opts={}]
 * @returns {ScannedTask[]}
 */
interface ScanAllOpts {
  todoComments?: boolean;
  todoMd?: boolean;
  githubIssues?: boolean;
  githubLabels?: string[];
}

export function scanAllSources(projectRoot: string, opts: ScanAllOpts = {}): ScannedTask[] {
  const cfg = loadHydraConfig() as { tasks?: { sources?: Record<string, boolean> } };
  const sources = cfg.tasks?.sources ?? {};

  // Sources typed as Record<string, boolean>; ?? true fallback for non-standard source keys
  const enableComments = opts.todoComments ?? sources['todoComments'];
  const enableMd = opts.todoMd ?? sources['todoMd'];
  const enableGh = opts.githubIssues ?? sources['githubIssues'];

  const allTasks: ScannedTask[] = [];

  if (enableComments) {
    allTasks.push(...scanTodoComments(projectRoot));
  }

  if (enableMd) {
    allTasks.push(...scanTodoMd(projectRoot));
  }

  if (enableGh) {
    allTasks.push(...scanGitHubIssues(projectRoot, { labels: opts.githubLabels }));
  }

  return prioritizeTasks(deduplicateTasks(allTasks));
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

if (isDirectRun) {
  (async () => {
    const projectRoot = process.argv[2] || process.cwd();

    // Initialize agent registry for classifyTask/bestAgentFor
    const { initAgentRegistry } = await import('./hydra-agents.ts');
    initAgentRegistry();

    console.log(pc.bold('\nHydra Tasks Scanner\n'));

    const comments = scanTodoComments(projectRoot);
    const mdTasks = scanTodoMd(projectRoot);
    const ghTasks = scanGitHubIssues(projectRoot);

    console.log(`  Code comments: ${pc.cyan(String(comments.length))}`);
    console.log(`  TODO.md items: ${pc.cyan(String(mdTasks.length))}`);
    console.log(`  GitHub issues: ${pc.cyan(String(ghTasks.length))}`);

    const all = prioritizeTasks(deduplicateTasks([...comments, ...mdTasks, ...ghTasks]));
    console.log(`  Total (deduped): ${pc.bold(String(all.length))}\n`);

    for (const task of all.slice(0, 30)) {
      let prioColor: (s: string) => string;
      if (task.priority === 'high') prioColor = pc.red;
      else if (task.priority === 'low') prioColor = pc.dim;
      else prioColor = pc.yellow;
      console.log(
        `  ${prioColor(task.priority.padEnd(6))} ${pc.dim(task.source.padEnd(13))} ${task.title}`,
      );
      console.log(
        `  ${pc.dim('       ')} ${pc.dim(`[${task.taskType}] agent:${task.suggestedAgent} complexity:${task.complexity} ref:${task.sourceRef}`)}`,
      );
    }

    if (all.length > 30) {
      console.log(pc.dim(`\n  ... and ${String(all.length - 30)} more`));
    }

    console.log('');
  })().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    exit(1);
  });
}
