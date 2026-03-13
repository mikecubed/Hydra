/**
 * Daemon worktree helpers: task git-worktree lifecycle management.
 * Extracted from orchestrator-daemon.ts for focused reuse.
 */

import path from 'node:path';
import { resolveProject, loadHydraConfig } from '../hydra-config.ts';
import {
  git,
  getCurrentBranch as getGitCurrentBranch,
  smartMerge,
} from '../hydra-shared/git-ops.ts';

const config = resolveProject();

// ── Worktree Isolation Helpers ────────────────────────────────────────────

/**
 * Creates a git worktree for a task at .hydra/worktrees/task-{taskId}.
 * Returns the absolute worktree path on success, null on failure (caller falls
 * back to non-isolated dispatch).
 */
export function createTaskWorktree(taskId: string): string | null {
  const cfg = loadHydraConfig();
  const worktreeDir = cfg.routing.worktreeIsolation.worktreeDir ?? '.hydra/worktrees';
  const worktreePath = path.resolve(config.projectRoot, worktreeDir, `task-${taskId}`);
  const branch = `hydra/task/${taskId}`;

  try {
    const result = git(['worktree', 'add', worktreePath, '-b', branch, 'HEAD'], config.projectRoot);
    if (result.status !== 0) {
      const errMsg = ([result.stderr, result.stdout] as string[]).find((s) => s !== '') ?? '';
      const errMsgTrimmed = errMsg.trim();
      console.warn(`[worktree] Failed to create worktree for task ${taskId}: ${errMsgTrimmed}`);
      return null;
    }
    return worktreePath;
  } catch (err) {
    console.warn(
      `[worktree] Exception creating worktree for task ${taskId}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Merges the task's worktree branch back to the current branch via smartMerge.
 * Returns { ok: true } on clean merge, { ok: false, conflict: true } on conflict,
 * { ok: false, error: string } on unexpected error.
 */
export function mergeTaskWorktree(taskId: string): {
  ok: boolean;
  conflict?: boolean;
  error?: string;
} {
  const branch = `hydra/task/${taskId}`;
  const currentBranch = getGitCurrentBranch(config.projectRoot);

  try {
    const result = smartMerge(config.projectRoot, branch, currentBranch);
    if (!result.ok) {
      const conflictList =
        (result as Record<string, unknown>)['conflicts'] != null &&
        ((result as Record<string, unknown>)['conflicts'] as string[]).length > 0
          ? ((result as Record<string, unknown>)['conflicts'] as string[]).join(', ')
          : '(unknown)';
      console.warn(
        `[worktree] Conflict merging task ${taskId} branch into ${currentBranch}: ${conflictList}`,
      );
      return { ok: false, conflict: true };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[worktree] Exception merging task ${taskId}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Removes the git worktree and branch for a task. Best-effort — does not throw.
 * Pass force: true to remove even if the worktree has uncommitted changes.
 */
export function cleanupTaskWorktree(taskId: string, { force = false } = {}): void {
  const cfg = loadHydraConfig();
  const worktreeDir = cfg.routing.worktreeIsolation.worktreeDir ?? '.hydra/worktrees';
  const worktreePath = path.resolve(config.projectRoot, worktreeDir, `task-${taskId}`);
  const branch = `hydra/task/${taskId}`;

  // Remove worktree
  try {
    const removeArgs = force
      ? ['worktree', 'remove', worktreePath, '--force']
      : ['worktree', 'remove', worktreePath];
    const result = git(removeArgs, config.projectRoot);
    if (result.status !== 0) {
      console.warn(
        `[worktree] Could not remove worktree for task ${taskId}: ${result.stderr.trim()}`,
      );
    }
  } catch (err) {
    console.warn(
      `[worktree] Exception removing worktree for task ${taskId}: ${(err as Error).message}`,
    );
  }

  // Delete branch
  try {
    const branchFlag = force ? '-D' : '-d';
    const result = git(['branch', branchFlag, branch], config.projectRoot);
    if (result.status !== 0) {
      console.warn(`[worktree] Could not delete branch ${branch}: ${result.stderr.trim()}`);
    }
  } catch (err) {
    console.warn(`[worktree] Exception deleting branch ${branch}: ${(err as Error).message}`);
  }
}
