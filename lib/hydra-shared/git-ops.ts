/**
 * Shared Git Helpers — Common git operations for nightly and evolve pipelines.
 *
 * Adopts evolve's parameterized versions as the superset.
 * Nightly callers simply pass baseBranch='dev'.
 */

import { spawnSyncCapture } from '../hydra-proc.ts';

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  signal: string | null;
}

/**
 * Run a git command synchronously.
 */
export function git(args: string[], cwd: string): GitResult {
  const r = spawnSyncCapture('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error, signal: r.signal };
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(cwd: string): string {
  const r = git(['branch', '--show-current'], cwd);
  return (r.stdout || '').trim();
}

/** Checkout a branch. */
export function checkoutBranch(cwd: string, branch: string): GitResult {
  return git(['checkout', branch], cwd);
}

/** Check if a branch exists. */
export function branchExists(cwd: string, branchName: string): boolean {
  const r = git(['rev-parse', '--verify', branchName], cwd);
  return r.status === 0;
}

/** Create a new branch from a base branch. Deletes stale branch if it exists. Returns true on success. */
export function createBranch(cwd: string, branchName: string, fromBranch: string): boolean {
  if (branchExists(cwd, branchName)) {
    git(['branch', '-D', branchName], cwd);
  }
  const r = git(['checkout', '-b', branchName, fromBranch], cwd);
  return r.status === 0;
}

/** Check if a branch has commits beyond baseBranch. */
export function branchHasCommits(cwd: string, branchName: string, baseBranch = 'dev'): boolean {
  const r = git(['log', `${baseBranch}..${branchName}`, '--oneline'], cwd);
  return (r.stdout || '').trim().length > 0;
}

/** Get commit count and files changed for a branch vs base. */
export function getBranchStats(
  cwd: string,
  branchName: string,
  baseBranch = 'dev',
): { commits: number; filesChanged: number } {
  const logResult = git(['log', `${baseBranch}..${branchName}`, '--oneline'], cwd);
  const commits = (logResult.stdout || '').trim().split('\n').filter(Boolean).length;

  const diffResult = git(['diff', '--stat', `${baseBranch}...${branchName}`], cwd);
  const statLines = (diffResult.stdout || '').trim().split('\n').filter(Boolean);
  const filesChanged = Math.max(0, statLines.length - 1);

  return { commits, filesChanged };
}

/** Get the full diff between a branch and its base. */
export function getBranchDiff(cwd: string, branchName: string, baseBranch = 'dev'): string {
  const r = git(['diff', `${baseBranch}...${branchName}`], cwd);
  return (r.stdout || '').trim();
}

/** Stage all changes and commit. Returns true on success. */
export function stageAndCommit(
  cwd: string,
  message: string,
  opts: { originatedBy?: string; executedBy?: string } = {},
): boolean {
  git(['add', '-A'], cwd);
  let fullMessage = message;
  const trailers = [];
  if (opts.originatedBy) trailers.push(`Originated-By: ${opts.originatedBy}`);
  if (opts.executedBy) trailers.push(`Executed-By: ${opts.executedBy}`);
  if (trailers.length) fullMessage = `${message.trimEnd()}\n\n${trailers.join('\n')}`;
  const r = git(['commit', '-m', fullMessage, '--allow-empty'], cwd);
  return r.status === 0;
}

/** Smart merge: rebase-first strategy with conflict detection. */
export function smartMerge(
  cwd: string,
  branchName: string,
  baseBranch: string,
  opts: {
    log?: { info: (msg: string) => void; ok: (msg: string) => void; warn: (msg: string) => void };
  } = {},
): { ok: boolean; method: string; conflicts: string[] } {
  const _log = opts.log ?? { info: () => {}, ok: () => {}, warn: () => {} };

  const isAncestor = git(['merge-base', '--is-ancestor', baseBranch, branchName], cwd);
  const baseDiverged = isAncestor.status !== 0;

  if (baseDiverged) {
    _log.info(`Base branch '${baseBranch}' has diverged — attempting rebase...`);

    const rebase = git(['rebase', baseBranch, branchName], cwd);
    if (rebase.status === 0) {
      _log.ok(`Rebased ${branchName} onto ${baseBranch}`);
      checkoutBranch(cwd, baseBranch);
      const ff = git(['merge', branchName, '--ff-only'], cwd);
      if (ff.status === 0) {
        return { ok: true, method: 'rebase+ff', conflicts: [] };
      }
    } else {
      git(['rebase', '--abort'], cwd);
      _log.warn('Rebase had conflicts — falling back to merge...');
    }
  }

  checkoutBranch(cwd, baseBranch);
  const merge = git(['merge', branchName, '--no-edit'], cwd);
  if (merge.status === 0) {
    return { ok: true, method: baseDiverged ? 'merge' : 'fast-forward', conflicts: [] };
  }

  const conflictFiles = git(['diff', '--name-only', '--diff-filter=U'], cwd);
  const conflicts = (conflictFiles.stdout || '').trim().split('\n').filter(Boolean);
  git(['merge', '--abort'], cwd);

  return { ok: false, method: 'failed', conflicts };
}

// ── Review-specific git helpers ─────────────────────────────────────────────

/** List branches matching a prefix pattern. */
export function listBranches(
  cwd: string,
  prefix: string,
  dateFilter: string | null = null,
): string[] {
  const pattern = dateFilter ? `${prefix}/${dateFilter}/*` : `${prefix}/*`;
  const r = git(['branch', '--list', pattern], cwd);
  if (!r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((b) => b.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);
}

/** Get diff stat for a branch vs base. */
export function getBranchDiffStat(cwd: string, branch: string, baseBranch = 'dev'): string {
  const r = git(['diff', '--stat', `${baseBranch}...${branch}`], cwd);
  return (r.stdout || '').trim();
}

/** Get one-line commit log for a branch vs base. */
export function getBranchLog(cwd: string, branch: string, baseBranch = 'dev'): string {
  const r = git(['log', `${baseBranch}..${branch}`, '--oneline', '--no-decorate'], cwd);
  return (r.stdout || '').trim();
}

/** Merge a branch into the current branch (or baseBranch). Returns true on success. */
export function mergeBranch(cwd: string, branch: string, baseBranch = 'dev'): boolean {
  const current = getCurrentBranch(cwd);
  if (current !== baseBranch) {
    git(['checkout', baseBranch], cwd);
  }
  const r = git(['merge', branch, '--no-edit'], cwd);
  return r.status === 0;
}

/** Delete a branch (force). Returns true on success. */
export function deleteBranch(cwd: string, branch: string): boolean {
  const r = git(['branch', '-D', branch], cwd);
  return r.status === 0;
}

// ── Remote sync helpers ─────────────────────────────────────────────────────

/** Get the URL of a remote. Returns empty string if not found. */
export function getRemoteUrl(cwd: string, remote = 'origin'): string {
  const r = git(['remote', 'get-url', remote], cwd);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/** Parse an SSH or HTTPS git remote URL into owner/repo. */
export function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null {
  if (!url || typeof url !== 'string') return null;
  // SSH: git@github.com:owner/repo.git
  const ssh = url.match(/^[\w+-]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  // HTTPS: https://github.com/owner/repo.git
  try {
    const u = new URL(url);
    const parts = u.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/');
    if (parts.length >= 2) return { host: u.host, owner: parts[0], repo: parts[1] };
  } catch {
    /* not a URL */
  }
  return null;
}

/** Fetch from origin (optionally a specific branch). */
export function fetchOrigin(
  cwd: string,
  branch: string | null = null,
): { ok: boolean; stderr: string } {
  const args = branch ? ['fetch', 'origin', branch] : ['fetch', 'origin'];
  const r = git(args, cwd);
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

/** Push a branch to origin. */
export function pushBranch(
  cwd: string,
  branch: string,
  opts: { force?: boolean; setUpstream?: boolean } = {},
): { ok: boolean; stderr: string } {
  const args = ['push', 'origin', branch];
  if (opts.setUpstream) args.splice(1, 0, '-u');
  if (opts.force) args.splice(1, 0, '--force-with-lease');
  const r = git(args, cwd);
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

/** Check if a named remote exists. */
export function hasRemote(cwd: string, remote = 'origin'): boolean {
  const r = git(['remote'], cwd);
  if (r.status !== 0) return false;
  return (r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .includes(remote);
}

/** Get the tracking (upstream) branch for the current or given branch. */
export function getTrackingBranch(cwd: string, branch: string | null = null): string {
  const ref = branch ? `${branch}@{u}` : '@{u}';
  const r = git(['rev-parse', '--abbrev-ref', ref], cwd);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/** Check how many commits the local branch is ahead/behind its remote tracking branch. */
export function isAheadOfRemote(cwd: string): { ahead: number; behind: number } {
  const r = git(['status', '-b', '--porcelain=v1'], cwd);
  if (r.status !== 0) return { ahead: 0, behind: 0 };
  const first = (r.stdout || '').split('\n')[0] || '';
  const aheadMatch = first.match(/ahead (\d+)/);
  const behindMatch = first.match(/behind (\d+)/);
  return {
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}
