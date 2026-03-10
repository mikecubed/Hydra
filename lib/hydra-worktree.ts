#!/usr/bin/env node
/**
 * Hydra Git Worktree Isolation
 *
 * Provides per-task git worktree management for parallel agent work
 * without file conflicts. Each task gets an isolated filesystem
 * that shares the repo's history.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadHydraConfig } from './hydra-config.mjs';
import { git, getCurrentBranch } from './hydra-shared/git-ops.ts';

/**
 * Get worktree config with defaults.
 */
function getWorktreeConfig() {
  const cfg = loadHydraConfig();
  const branchPrefix = cfg.worktrees?.branchPrefix || 'hydra/';

  // Security: Validate branchPrefix to prevent shell injection
  if (!/^[\w\/\.-]+$/.test(branchPrefix)) {
    throw new Error(
      `Invalid branchPrefix "${branchPrefix}". Only alphanumeric, /, ., -, and _ are allowed.`,
    );
  }

  return {
    enabled: cfg.worktrees?.enabled || false,
    basePath: cfg.worktrees?.basePath || '.hydra/worktrees',
    autoCleanup: cfg.worktrees?.autoCleanup !== false,
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

export async function createWorktree(
  taskId: string,
  projectRoot: string,
  baseBranch: string | undefined = undefined,
): Promise<{ worktreePath: string; branch: string }> {
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
  const base = baseBranch || getCurrentBranch(projectRoot) || 'HEAD';

  // Create branch and worktree
  const r = git(['worktree', 'add', '-b', branch, gitPath, base], projectRoot);
  if (r.status !== 0) {
    const r2 = git(['worktree', 'add', gitPath, branch], projectRoot);
    if (r2.status !== 0) {
      throw new Error(
        `Failed to create worktree for ${taskId}: ${r2.stderr || r.stderr || 'unknown error'}`,
      );
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
export async function removeWorktree(
  taskId: string,
  projectRoot: string,
  opts: { deleteBranch?: boolean } = {},
): Promise<void> {
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

  if (opts.deleteBranch) {
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
export async function listWorktrees(projectRoot: string): Promise<WorktreeInfo[]> {
  const r = git(['worktree', 'list', '--porcelain'], projectRoot);
  if (r.status !== 0) return [];
  const output = (r.stdout || '').trim();

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line === '' && current.path) {
      worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);

  return worktrees;
}

/**
 * Merge a worktree branch back into a target branch.
 * @param {string} taskId
 * @param {string} projectRoot
 * @param {string} [targetBranch] - Branch to merge into (default: current branch)
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function mergeWorktree(
  taskId: string,
  projectRoot: string,
  targetBranch: string | undefined = undefined,
): Promise<{ ok: boolean; message: string }> {
  const config = getWorktreeConfig();
  const branch = `${config.branchPrefix}${taskId}`;
  const target = targetBranch || getCurrentBranch(projectRoot) || 'main';

  const r = git(['merge', branch, '--no-edit'], projectRoot);
  if (r.status === 0) {
    return { ok: true, message: (r.stdout || '').trim() || `Merged ${branch} into ${target}` };
  }
  return {
    ok: false,
    message: `Merge failed: ${(r.stderr || r.stdout || 'unknown error').trim()}`,
  };
}

/**
 * Check if worktree isolation is enabled in config.
 */
export function isWorktreeEnabled() {
  return getWorktreeConfig().enabled;
}
