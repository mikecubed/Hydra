/**
 * Hydra Git Worktree Isolation
 *
 * Provides per-task git worktree management for parallel agent work
 * without file conflicts. Each task gets an isolated filesystem
 * that shares the repo's history.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadHydraConfig } from './hydra-config.ts';
import { git, getCurrentBranch } from './hydra-shared/git-ops.ts';

/**
 * Get worktree config with defaults.
 */
function getWorktreeConfig() {
  const cfg = loadHydraConfig();
  const wt = cfg.worktrees;
  const rawPrefix = (wt?.['branchPrefix'] as string | undefined) ?? '';
  const branchPrefix = rawPrefix === '' ? 'hydra/' : rawPrefix;

  // Security: Validate branchPrefix to prevent shell injection
  if (!/^[\w/.-]+$/.test(branchPrefix)) {
    throw new Error(
      `Invalid branchPrefix "${branchPrefix}". Only alphanumeric, /, ., -, and _ are allowed.`,
    );
  }

  const rawBasePath = (wt?.['basePath'] as string | undefined) ?? '';
  return {
    enabled: (wt?.['enabled'] as boolean | undefined) === true,
    basePath: rawBasePath === '' ? '.hydra/worktrees' : rawBasePath,
    autoCleanup: wt?.['autoCleanup'] !== false,
    branchPrefix,
  };
}

/**
 * Create a git worktree for a task.
 * @param {string} taskId - Task identifier (e.g. 'T001')
 * @param {string} projectRoot - Root of the git repo
 * @param {string} [baseBranch] - Branch to base the worktree on (default: current branch)
 * @returns {Promise<{ worktreePath: string, branch: string }>}
 */
interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

export function createWorktree(
  taskId: string,
  projectRoot: string,
  baseBranch?: string,
): { worktreePath: string; branch: string } {
  const config = getWorktreeConfig();
  const branch = `${config.branchPrefix}${taskId}`;
  const worktreePath = path.resolve(projectRoot, config.basePath, taskId);

  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Normalize to forward slashes for git args (avoids backslash quirks on Windows)
  const gitPath = worktreePath.replace(/\\/g, '/');

  // Determine base branch
  const resolvedBase = baseBranch ?? getCurrentBranch(projectRoot);
  const base = resolvedBase === '' ? 'HEAD' : resolvedBase;

  // Create branch and worktree
  const r = git(['worktree', 'add', '-b', branch, gitPath, base], projectRoot);
  if (r.status !== 0) {
    const r2 = git(['worktree', 'add', gitPath, branch], projectRoot);
    if (r2.status !== 0) {
      let errMsg = 'unknown error';
      if (r2.stderr !== '') {
        errMsg = r2.stderr;
      } else if (r.stderr !== '') {
        errMsg = r.stderr;
      }
      throw new Error(`Failed to create worktree for ${taskId}: ${errMsg}`);
    }
  }

  return { worktreePath, branch };
}

/**
 * Remove a git worktree for a task.
 * @param {string} taskId - Task identifier
 * @param {string} projectRoot - Root of the git repo
 * @param {{ deleteBranch?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function removeWorktree(
  taskId: string,
  projectRoot: string,
  opts: { deleteBranch?: boolean } = {},
): void {
  const config = getWorktreeConfig();
  const worktreePath = path.resolve(projectRoot, config.basePath, taskId);
  const branch = `${config.branchPrefix}${taskId}`;

  const r = git(['worktree', 'remove', worktreePath.replace(/\\/g, '/'), '--force'], projectRoot);
  if (r.status !== 0) {
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    git(['worktree', 'prune'], projectRoot);
  }

  if (opts.deleteBranch === true) {
    git(['branch', '-D', branch], projectRoot);
  }
}

/**
 * Get the worktree path for a task (without checking if it exists).
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {string}
 */
export function getWorktreePath(taskId: string, projectRoot: string): string {
  const config = getWorktreeConfig();
  return path.resolve(projectRoot, config.basePath, taskId);
}

/**
 * List all active worktrees.
 * @param {string} projectRoot
 * @returns {Promise<Array<{ path: string, branch: string, head: string }>>}
 */
export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  const r = git(['worktree', 'list', '--porcelain'], projectRoot);
  if (r.status !== 0) return [];
  const output = r.stdout.trim();

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path != null && current.path !== '') worktrees.push(current as WorktreeInfo);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line === '' && current.path != null && current.path !== '') {
      worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }
  if (current.path != null && current.path !== '') worktrees.push(current as WorktreeInfo);

  return worktrees;
}

/**
 * Merge a worktree branch back into a target branch.
 * @param {string} taskId
 * @param {string} projectRoot
 * @param {string} [targetBranch] - Branch to merge into (default: current branch)
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export function mergeWorktree(
  taskId: string,
  projectRoot: string,
  targetBranch?: string,
): { ok: boolean; message: string } {
  const config = getWorktreeConfig();
  const branch = `${config.branchPrefix}${taskId}`;
  const resolvedTarget = targetBranch ?? getCurrentBranch(projectRoot);
  const target = resolvedTarget === '' ? 'main' : resolvedTarget;

  const r = git(['merge', branch, '--no-edit'], projectRoot);
  if (r.status === 0) {
    const mergeOutput = r.stdout.trim();
    return {
      ok: true,
      message: mergeOutput === '' ? `Merged ${branch} into ${target}` : mergeOutput,
    };
  }
  const errStderr = r.stderr.trim();
  const errStdout = r.stdout.trim();
  let errDetail = 'unknown error';
  if (errStderr !== '') {
    errDetail = errStderr;
  } else if (errStdout !== '') {
    errDetail = errStdout;
  }
  return {
    ok: false,
    message: `Merge failed: ${errDetail}`,
  };
}

/**
 * Check if worktree isolation is enabled in config.
 */
export function isWorktreeEnabled(): boolean {
  return getWorktreeConfig().enabled;
}
