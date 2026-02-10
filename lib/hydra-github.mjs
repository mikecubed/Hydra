/**
 * Hydra GitHub Integration — gh CLI wrapper for PR management and repo operations.
 *
 * Shells out to `gh` CLI (same pattern as git() in git-ops.mjs).
 * 30s timeout for network operations.
 */

import { spawnSync } from 'child_process';
import { loadHydraConfig } from './hydra-config.mjs';
import { pushBranch, getCurrentBranch, getBranchLog } from './hydra-shared/git-ops.mjs';

/**
 * Run a gh CLI command synchronously.
 * @param {string[]} args
 * @param {string} [cwd=process.cwd()]
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
export function gh(args, cwd = process.cwd()) {
  return spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    shell: process.platform === 'win32',
  });
}

/**
 * Check if `gh` CLI is installed and accessible.
 * @returns {boolean}
 */
export function isGhAvailable() {
  try {
    const r = gh(['--version']);
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if `gh` is authenticated with GitHub.
 * @returns {boolean}
 */
export function isGhAuthenticated() {
  try {
    const r = gh(['auth', 'status']);
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect the current GitHub repository.
 * @param {string} [cwd=process.cwd()]
 * @returns {{ owner: string, repo: string, defaultBranch: string } | null}
 */
export function detectRepo(cwd = process.cwd()) {
  const r = gh(['repo', 'view', '--json', 'owner,name,defaultBranchRef'], cwd);
  if (r.status !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    return {
      owner: data.owner?.login || data.owner || '',
      repo: data.name || '',
      defaultBranch: data.defaultBranchRef?.name || 'main',
    };
  } catch {
    return null;
  }
}

/**
 * Create a pull request.
 * @param {{ cwd?: string, head: string, base: string, title: string, body?: string, draft?: boolean, labels?: string[], reviewers?: string[] }} opts
 * @returns {{ ok: boolean, url?: string, number?: number, error?: string }}
 */
export function createPR({ cwd = process.cwd(), head, base, title, body = '', draft = false, labels = [], reviewers = [] }) {
  const args = ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body || ''];
  if (draft) args.push('--draft');
  for (const l of labels) args.push('--label', l);
  for (const r of reviewers) args.push('--reviewer', r);

  const result = gh(args, cwd);
  if (result.status === 0) {
    const url = (result.stdout || '').trim();
    const numMatch = url.match(/\/pull\/(\d+)/);
    return { ok: true, url, number: numMatch ? parseInt(numMatch[1], 10) : undefined };
  }
  return { ok: false, error: (result.stderr || result.stdout || '').trim() };
}

/**
 * List pull requests.
 * @param {{ cwd?: string, state?: string, base?: string, head?: string }} [opts={}]
 * @returns {Array<{ number: number, title: string, headRefName: string, author: string, state: string }>}
 */
export function listPRs({ cwd = process.cwd(), state = 'open', base, head } = {}) {
  const args = ['pr', 'list', '--json', 'number,title,headRefName,author,state', '--state', state];
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);

  const r = gh(args, cwd);
  if (r.status !== 0) return [];
  try {
    const data = JSON.parse(r.stdout);
    return data.map(pr => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      author: pr.author?.login || pr.author || '',
      state: pr.state,
    }));
  } catch {
    return [];
  }
}

/**
 * Get details for a specific pull request.
 * @param {{ cwd?: string, ref: string|number }} opts
 * @returns {object|null}
 */
export function getPR({ cwd = process.cwd(), ref }) {
  const r = gh(['pr', 'view', String(ref), '--json', 'number,title,state,headRefName,baseRefName,url,additions,deletions,reviewRequests,author,body'], cwd);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Merge a pull request.
 * @param {{ cwd?: string, ref: string|number, method?: 'merge'|'squash'|'rebase', deleteAfter?: boolean }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function mergePR({ cwd = process.cwd(), ref, method = 'merge', deleteAfter = true }) {
  const args = ['pr', 'merge', String(ref), `--${method}`];
  if (deleteAfter) args.push('--delete-branch');
  const r = gh(args, cwd);
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
}

/**
 * Close a pull request without merging.
 * @param {{ cwd?: string, ref: string|number }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function closePR({ cwd = process.cwd(), ref }) {
  const r = gh(['pr', 'close', String(ref)], cwd);
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
}

/**
 * Get the github config section with defaults.
 * @returns {{ enabled: boolean, defaultBase: string, draft: boolean, labels: string[], reviewers: string[], prBodyFooter: string }}
 */
export function getGitHubConfig() {
  const cfg = loadHydraConfig();
  return {
    enabled: false,
    defaultBase: '',
    draft: false,
    labels: [],
    reviewers: [],
    prBodyFooter: '',
    ...cfg.github,
  };
}

/**
 * Push a branch to origin and create a PR. Auto-generates title/body from branch name and commit log.
 * Applies config defaults (labels, reviewers, draft, footer).
 *
 * @param {{ cwd?: string, branch?: string, baseBranch?: string, title?: string, body?: string, draft?: boolean }} [opts={}]
 * @returns {{ ok: boolean, url?: string, number?: number, error?: string }}
 */
export function pushBranchAndCreatePR(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const branch = opts.branch || getCurrentBranch(cwd);
  const ghCfg = getGitHubConfig();

  // Determine base branch
  let baseBranch = opts.baseBranch || ghCfg.defaultBase;
  if (!baseBranch) {
    const repo = detectRepo(cwd);
    baseBranch = repo?.defaultBranch || 'main';
  }

  // Push the branch
  const pushResult = pushBranch(cwd, branch, { setUpstream: true });
  if (!pushResult.ok) {
    return { ok: false, error: `Push failed: ${pushResult.stderr}` };
  }

  // Auto-generate title from branch name if not provided
  const title = opts.title || branch
    .replace(/^(evolve|nightly)\//, '')
    .replace(/[/_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || branch;

  // Auto-generate body from commit log if not provided
  let body = opts.body || '';
  if (!body) {
    const log = getBranchLog(cwd, branch, baseBranch);
    if (log) {
      body = `## Commits\n\n${log.split('\n').map(l => `- ${l}`).join('\n')}`;
    }
  }

  // Append footer from config
  if (ghCfg.prBodyFooter) {
    body = body ? `${body}\n\n---\n${ghCfg.prBodyFooter}` : ghCfg.prBodyFooter;
  }

  const draft = opts.draft !== undefined ? opts.draft : ghCfg.draft;

  return createPR({
    cwd,
    head: branch,
    base: baseBranch,
    title,
    body,
    draft,
    labels: ghCfg.labels,
    reviewers: ghCfg.reviewers,
  });
}
