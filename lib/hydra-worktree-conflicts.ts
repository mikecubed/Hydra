import path from 'node:path';

export interface ConflictWorktreeInfo {
  id: string;
  title: string;
  relPath: string;
  branch: string;
}

/**
 * Extracts display info for conflict worktrees from daemon task state.
 * Falls back to `hydra/task/{id}` when worktreePath or worktreeBranch is absent.
 */
export function formatConflictWorktrees(
  tasks: Array<{
    id: string;
    title?: string;
    worktreePath?: string | null;
    worktreeConflict?: boolean;
    worktreeBranch?: string | null;
  }>,
  projectRoot: string,
): ConflictWorktreeInfo[] {
  return tasks
    .filter((t) => t.worktreeConflict === true)
    .map((t) => ({
      id: t.id,
      title: t.title ?? '(no title)',
      relPath:
        t.worktreePath != null && t.worktreePath !== ''
          ? path.relative(projectRoot, t.worktreePath)
          : `hydra/task/${t.id}`,
      branch: t.worktreeBranch ?? `hydra/task/${t.id}`,
    }));
}
