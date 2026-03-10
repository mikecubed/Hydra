/**
 * Hydra Cleanup — Scanners and executors for the :cleanup command.
 *
 * Finds stale/completed items across the system (daemon tasks, branches,
 * suggestions, artifacts) and provides executors to clean them up.
 * All scanners are fault-tolerant (return [] on error).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ActionItem, PipelineResult } from './hydra-action-pipeline.ts';

// ── Scanners ─────────────────────────────────────────────────────────────────

/**
 * Scan for completed/cancelled daemon tasks that can be archived.
 */
export async function scanArchivableTasks(baseUrl: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { request } = await import('./hydra-utils.ts');
    const status = await request('GET', baseUrl, '/status');
    const statusData = status as Record<string, unknown>;
    const tasks = statusData['tasks'];
    if (!Array.isArray(tasks)) return items;

    for (const task of tasks as Record<string, unknown>[]) {
      const taskStatus = task['status'] as string;
      const taskId = task['id'] as string;
      const taskTitle = task['title'] as string | undefined;
      const taskCompletedAt = task['completedAt'] as string | undefined;
      if (taskStatus === 'done' || taskStatus === 'cancelled') {
        items.push({
          id: `archive-task-${taskId}`,
          title: `Archive ${taskStatus} task: ${taskTitle ?? taskId}`,
          description: `Status: ${taskStatus}, completed ${taskCompletedAt ?? 'recently'}`,
          category: 'archive',
          severity: 'low',
          source: 'daemon',
          meta: { taskId, daemonTask: task },
        });
      }
    }
  } catch {
    /* daemon unavailable */
  }
  return items;
}

/**
 * Scan for old acknowledged handoffs.
 */
export async function scanOldHandoffs(baseUrl: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { request } = await import('./hydra-utils.ts');
    const status = await request('GET', baseUrl, '/status');
    const statusData = status as Record<string, unknown>;
    const handoffs = statusData['handoffs'];
    if (!Array.isArray(handoffs)) return items;

    const cutoffMs = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    for (const handoff of handoffs as Record<string, unknown>[]) {
      if (handoff['acknowledged'] === true) {
        const ts = handoff['ts'] as string | number | undefined;
        const createdAt = handoff['createdAt'] as string | number | undefined;
        const age = now - new Date(ts ?? createdAt ?? 0).getTime();
        if (age > cutoffMs) {
          const handoffId = handoff['id'] as string;
          const summary = handoff['summary'] as string | undefined;
          items.push({
            id: `handoff-${handoffId}`,
            title: `Old handoff: ${(summary ?? handoffId).slice(0, 60)}`,
            description: `Acknowledged ${String(Math.round(age / 60000))}min ago`,
            category: 'archive',
            severity: 'low',
            source: 'daemon',
            meta: { handoffId },
          });
        }
      }
    }
  } catch {
    /* daemon unavailable */
  }
  return items;
}

/**
 * Scan for unmerged feature branches (evolve/*, nightly/*, tasks/*).
 */
export async function scanStaleBranches(projectRoot: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { listBranches, branchHasCommits } = await import('./hydra-shared/git-ops.ts');

    for (const prefix of ['evolve', 'nightly', 'tasks']) {
      const branches = listBranches(projectRoot, prefix);
      for (const branch of branches) {
        const hasCommits = branchHasCommits(projectRoot, branch, 'dev');
        items.push({
          id: `branch-${branch}`,
          title: `${hasCommits ? 'Unmerged' : 'Empty'} branch: ${branch}`,
          description: hasCommits ? 'Has unmerged commits vs dev' : 'No commits beyond dev',
          category: 'delete',
          severity: hasCommits ? 'medium' : 'low',
          source: 'branches',
          meta: { branch, prefix, hasCommits },
        });
      }
    }
  } catch {
    /* git unavailable */
  }
  return items;
}

/**
 * Scan for stale daemon tasks (in_progress but no update for 30+ min).
 */
export async function scanStaleTasks(baseUrl: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { request } = await import('./hydra-utils.ts');
    const status = await request('GET', baseUrl, '/status');
    const statusData = status as Record<string, unknown>;
    const tasks = statusData['tasks'];
    if (!Array.isArray(tasks)) return items;

    const cutoffMs = 30 * 60 * 1000;
    const now = Date.now();

    for (const task of tasks as Record<string, unknown>[]) {
      const taskStatus = task['status'] as string;
      if (taskStatus === 'in_progress') {
        const taskId = task['id'] as string;
        const taskTitle = task['title'] as string | undefined;
        const updatedAt = task['updatedAt'] as string | undefined;
        const claimedAt = task['claimedAt'] as string | undefined;
        const createdAt = task['createdAt'] as string | undefined;
        const lastUpdate = new Date(updatedAt ?? claimedAt ?? createdAt ?? 0).getTime();
        const age = now - lastUpdate;
        if (age > cutoffMs) {
          const ageMin = String(Math.round(age / 60000));
          items.push({
            id: `stale-task-${taskId}`,
            title: `Stale task (${ageMin}min): ${taskTitle ?? taskId}`,
            description: `In progress but no update for ${ageMin} minutes`,
            category: 'requeue',
            severity: 'medium',
            source: 'daemon',
            meta: { taskId, daemonTask: task },
          });
        }
      }
    }
  } catch {
    /* daemon unavailable */
  }
  return items;
}

/**
 * Scan for abandoned suggestions (old, multiple failed attempts).
 */
export async function scanAbandonedSuggestions(): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { loadSuggestions, getPendingSuggestions } =
      await import('./hydra-evolve-suggestions.ts');
    const sg = loadSuggestions(undefined as unknown as string);
    const pending = getPendingSuggestions(sg);

    for (const s of pending) {
      const sAttempts = s.attempts ?? 0;
      const maxAttempts = 3;
      if (sAttempts >= maxAttempts) {
        items.push({
          id: `suggestion-${s.id ?? ''}`,
          title: `Abandoned suggestion: ${(s.title ?? s.id ?? '').slice(0, 60)}`,
          description: `${String(sAttempts)} failed attempts, created ${s.createdAt ?? 'unknown'}`,
          category: 'cleanup',
          severity: 'low',
          source: 'suggestions',
          meta: { suggestionId: s.id, suggestion: s as unknown as Record<string, unknown> },
        });
      }
    }
  } catch {
    /* suggestions unavailable */
  }
  return items;
}

/**
 * Scan for old council checkpoint files.
 */
export function scanOldCheckpoints(projectRoot: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const coordDir = path.join(projectRoot, 'docs', 'coordination');
    if (!fs.existsSync(coordDir)) return Promise.resolve(items);

    // Council checkpoints
    const councilDir = path.join(coordDir, 'council');
    if (fs.existsSync(councilDir)) {
      const files = fs.readdirSync(councilDir).filter((f) => f.endsWith('.json'));
      const cutoffMs = 7 * 24 * 60 * 60 * 1000; // 7 days
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(councilDir, file);
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > cutoffMs) {
          items.push({
            id: `checkpoint-${file}`,
            title: `Old checkpoint: ${file}`,
            description: `Last modified ${String(Math.round(age / (24 * 60 * 60 * 1000)))} days ago`,
            category: 'delete',
            severity: 'low',
            source: 'checkpoints',
            meta: { filePath, file },
          });
        }
      }
    }
  } catch {
    /* fs unavailable */
  }
  return Promise.resolve(items);
}

/**
 * Scan for large/old coordination artifacts (logs, reports).
 */
export function scanOldArtifacts(projectRoot: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const coordDir = path.join(projectRoot, 'docs', 'coordination');
    if (!fs.existsSync(coordDir)) return Promise.resolve(items);

    // Check doctor log size
    const doctorLog = path.join(coordDir, 'doctor', 'DOCTOR_LOG.ndjson');
    if (fs.existsSync(doctorLog)) {
      const stat = fs.statSync(doctorLog);
      const sizeKB = Math.round(stat.size / 1024);
      if (sizeKB > 500) {
        items.push({
          id: 'artifact-doctor-log',
          title: `Large doctor log (${String(sizeKB)}KB)`,
          description: 'Truncate old entries to reduce size',
          category: 'cleanup',
          severity: 'low',
          source: 'artifacts',
          meta: { filePath: doctorLog, sizeKB },
        });
      }
    }

    // Check old report files (tasks, nightly)
    for (const subDir of ['tasks', 'nightly']) {
      const dir = path.join(coordDir, subDir);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.md'));
      const cutoffMs = 14 * 24 * 60 * 60 * 1000; // 14 days
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > cutoffMs) {
          items.push({
            id: `artifact-${subDir}-${file}`,
            title: `Old ${subDir} report: ${file}`,
            description: `${String(Math.round(age / (24 * 60 * 60 * 1000)))} days old`,
            category: 'delete',
            severity: 'low',
            source: 'artifacts',
            meta: { filePath, file, subDir },
          });
        }
      }
    }
  } catch {
    /* fs unavailable */
  }
  return Promise.resolve(items);
}

/**
 * Scan for stale task worktrees in .hydra/worktrees/task-*.
 * A worktree is considered stale if its directory mtime is older than 24 hours.
 */
export async function scanStaleTaskWorktrees(projectRoot: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { loadHydraConfig } = await import('./hydra-config.ts');
    const cfg = loadHydraConfig();
    const worktreeDir = cfg.routing.worktreeIsolation.worktreeDir ?? '.hydra/worktrees';
    const worktreesPath = path.join(projectRoot, worktreeDir);

    if (!fs.existsSync(worktreesPath)) return items;

    const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    const entries = fs.readdirSync(worktreesPath);
    for (const name of entries) {
      if (!name.startsWith('task-')) continue;
      const fullPath = path.join(worktreesPath, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        const ageMs = now - stat.mtimeMs;
        if (ageMs > STALE_MS) {
          const taskId = name.slice('task-'.length);
          const ageHours = Math.round(ageMs / (60 * 60 * 1000));
          items.push({
            id: `worktree-${name}`,
            title: `Stale task worktree: ${name} (${String(ageHours)}h old)`,
            description: `Worktree at ${path.relative(projectRoot, fullPath)} has not been updated in ${String(ageHours)} hours. Safe to remove if task is done.`,
            category: 'worktree',
            severity: 'medium',
            source: 'worktrees',
            meta: { worktreePath: fullPath, taskId, branch: `hydra/task/${taskId}`, ageHours },
          });
        }
      } catch {
        /* stat failed — skip */
      }
    }
  } catch {
    /* fs or config unavailable */
  }
  return items;
}

// ── AI Enrichment ───────────────────────────────────────────────────────────

/**
 * Enrich cleanup items with situational context.
 */
export function enrichCleanupWithSitrep(
  items: ActionItem[],
  _opts?: Record<string, unknown>,
): Promise<ActionItem[]> {
  // Non-fatal: just return items as-is if enrichment fails
  // Enrichment is less critical for cleanup than for doctor fix
  return Promise.resolve(items);
}

// ── Executor ────────────────────────────────────────────────────────────────

/**
 * Execute a single cleanup action based on its category.
 */
export async function executeCleanupAction(
  item: ActionItem,
  opts: Record<string, unknown> = {},
): Promise<PipelineResult> {
  const startMs = Date.now();
  const baseUrl = opts['baseUrl'] as string | undefined;
  const projectRoot = opts['projectRoot'] as string | undefined;

  try {
    switch (item.category) {
      case 'archive': {
        return await executeArchive(item, baseUrl ?? '', startMs);
      }
      case 'delete': {
        return await executeDelete(item, projectRoot ?? '', startMs);
      }
      case 'requeue': {
        return await executeRequeue(item, baseUrl ?? '', startMs);
      }
      case 'cleanup': {
        return await executeCleanup(item, startMs);
      }
      case 'worktree': {
        return await executeWorktreeCleanup(item, projectRoot ?? '', startMs);
      }
      case 'fix':
      case 'acknowledge': {
        return { item, ok: true, output: 'No action needed', durationMs: Date.now() - startMs };
      }
    }
  } catch (err) {
    return {
      item,
      ok: false,
      error: (err as Error).message,
      durationMs: Date.now() - startMs,
    };
  }
}

// ── Category Executors ──────────────────────────────────────────────────────

async function executeArchive(
  item: ActionItem,
  baseUrl: string,
  startMs: number,
): Promise<PipelineResult> {
  const taskId = item.meta?.['taskId'] as string | undefined;
  if (item.source === 'daemon' && taskId !== undefined) {
    try {
      const { request } = await import('./hydra-utils.ts');
      await request('POST', baseUrl, `/task/update`, { id: taskId, status: 'cancelled' });
      return { item, ok: true, output: 'Task archived', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }
  return { item, ok: true, output: 'No action needed', durationMs: Date.now() - startMs };
}

async function executeDelete(
  item: ActionItem,
  projectRoot: string,
  startMs: number,
): Promise<PipelineResult> {
  const branch = item.meta?.['branch'] as string | undefined;
  const filePath = item.meta?.['filePath'] as string | undefined;

  // Branch deletion
  if (item.source === 'branches' && branch !== undefined) {
    try {
      const { deleteBranch } = await import('./hydra-shared/git-ops.ts');
      const ok = deleteBranch(projectRoot, branch);
      return {
        item,
        ok,
        output: ok ? 'Branch deleted' : 'Failed to delete branch',
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }

  // File deletion (checkpoints, artifacts)
  if (filePath !== undefined) {
    try {
      fs.unlinkSync(filePath);
      return { item, ok: true, output: 'File deleted', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }

  return { item, ok: false, error: 'No delete target found', durationMs: Date.now() - startMs };
}

async function executeRequeue(
  item: ActionItem,
  baseUrl: string,
  startMs: number,
): Promise<PipelineResult> {
  const taskId = item.meta?.['taskId'] as string | undefined;
  if (taskId !== undefined) {
    try {
      const { request } = await import('./hydra-utils.ts');
      await request('POST', baseUrl, `/task/update`, { id: taskId, status: 'todo' });
      return { item, ok: true, output: 'Task requeued', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }
  return { item, ok: false, error: 'No task ID for requeue', durationMs: Date.now() - startMs };
}

async function executeCleanup(item: ActionItem, startMs: number): Promise<PipelineResult> {
  const suggestionId = item.meta?.['suggestionId'] as string | undefined;
  const filePath = item.meta?.['filePath'] as string | undefined;

  // Suggestion removal
  if (item.source === 'suggestions' && suggestionId !== undefined) {
    try {
      const { loadSuggestions, saveSuggestions, removeSuggestion } =
        await import('./hydra-evolve-suggestions.ts');
      const sg = loadSuggestions(undefined as unknown as string);
      removeSuggestion(sg, suggestionId);
      saveSuggestions(undefined as unknown as string, sg);
      return { item, ok: true, output: 'Suggestion removed', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }

  // Doctor log truncation
  if (item.id === 'artifact-doctor-log' && filePath !== undefined) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      // Keep last 100 entries
      const kept = lines.slice(-100);
      fs.writeFileSync(filePath, `${kept.join('\n')}\n`, 'utf8');
      return {
        item,
        ok: true,
        output: `Truncated from ${String(lines.length)} to ${String(kept.length)} entries`,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }

  // Generic file deletion for artifacts
  if (filePath !== undefined) {
    try {
      fs.unlinkSync(filePath);
      return { item, ok: true, output: 'File removed', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
    }
  }

  return { item, ok: true, output: 'No action needed', durationMs: Date.now() - startMs };
}

async function executeWorktreeCleanup(
  item: ActionItem,
  projectRoot: string,
  startMs: number,
): Promise<PipelineResult> {
  const worktreePath = (item.meta?.['worktreePath'] ?? '') as string;
  const branch = item.meta?.['branch'] as string | undefined;

  if (worktreePath === '') {
    return { item, ok: false, error: 'No worktree path found', durationMs: Date.now() - startMs };
  }

  try {
    const { git } = await import('./hydra-shared/git-ops.ts');

    // Remove worktree (force in case of uncommitted changes in a stale tree)
    const removeResult = git(['worktree', 'remove', worktreePath, '--force'], projectRoot);
    if (removeResult.status !== 0) {
      // Fallback: delete directory directly and prune
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      git(['worktree', 'prune'], projectRoot);
    }

    // Delete the associated branch (best-effort)
    if (branch !== undefined) {
      git(['branch', '-D', branch], projectRoot);
    }

    return {
      item,
      ok: true,
      output: `Removed stale worktree ${path.basename(worktreePath)}`,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return { item, ok: false, error: (err as Error).message, durationMs: Date.now() - startMs };
  }
}
