/**
 * Shared Review Infrastructure — Common helpers for nightly and evolve review tools.
 *
 * Provides:
 *   - Interactive readline prompt helpers
 *   - Report loading patterns
 *   - Branch walk-through rendering
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import {
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchDiffStat,
  getBranchDiff,
  getBranchLog,
  mergeBranch,
  smartMerge,
  deleteBranch,
} from './git-ops.ts';
import { pushBranchAndCreatePR } from '../hydra-github.ts';

// ── Interactive Prompt ──────────────────────────────────────────────────────

/**
 * Create a readline interface for interactive prompts.
 * @returns {readline.Interface}
 */
export function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

/**
 * Ask a question and return the trimmed lowercase answer.
 * @param {readline.Interface} rl
 * @param {string} question
 * @returns {Promise<string>}
 */
export function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Report Loading ──────────────────────────────────────────────────────────

/**
 * Load the latest report JSON from a coordination directory.
 *
 * @param {string} reportDir - Path to the report directory
 * @param {string} prefix - Report filename prefix (e.g., 'NIGHTLY', 'EVOLVE')
 * @param {string|null} [dateFilter] - Optional date filter
 * @returns {object|null}
 */
export function loadLatestReport(
  reportDir: string,
  prefix: string,
  dateFilter: string | null = null,
): unknown {
  if (!fs.existsSync(reportDir)) return null;

  if (dateFilter !== null && dateFilter !== '') {
    const jsonPath = path.join(reportDir, `${prefix}_${dateFilter}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  try {
    const files = fs
      .readdirSync(reportDir)
      .filter((f) => f.startsWith(`${prefix}_`) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8'));
  } catch {
    return null;
  }
}

// ── Branch Walk-through ─────────────────────────────────────────────────────

/**
 * Display branch info (commits, diff stat).
 * @param {string} projectRoot
 * @param {string} branch
 * @param {string} baseBranch
 * @returns {{ commitLog: string, diffStat: string }}
 */
export function displayBranchInfo(
  projectRoot: string,
  branch: string,
  baseBranch: string,
): { commitLog: string; diffStat: string } {
  const diffStat = getBranchDiffStat(projectRoot, branch, baseBranch);
  const commitLog = getBranchLog(projectRoot, branch, baseBranch);

  if (commitLog !== '') {
    console.log(pc.dim('\n  Commits:'));
    for (const line of commitLog.split('\n')) {
      console.log(pc.dim(`    ${line}`));
    }
  }
  if (diffStat !== '') {
    console.log(pc.dim('\n  Changes:'));
    for (const line of diffStat.split('\n')) {
      console.log(pc.dim(`    ${line}`));
    }
  }

  return { commitLog, diffStat };
}

/**
 * Handle the interactive merge/skip/diff/delete/pr prompt for a branch.
 *
 * @param {readline.Interface} rl
 * @param {string} projectRoot
 * @param {string} branch
 * @param {string} baseBranch
 * @param {{ enablePR?: boolean }} [opts={}]
 * @returns {Promise<'merged'|'skipped'|'deleted'|'pr-created'>}
 */
export interface HandleBranchActionOpts {
  enablePR?: boolean;
  useSmartMerge?: boolean;
}

function doMerge(
  projectRoot: string,
  branch: string,
  baseBranch: string,
  useSmartMerge: boolean,
  withLog: boolean,
): boolean {
  if (!useSmartMerge) return mergeBranch(projectRoot, branch, baseBranch);
  if (!withLog) return smartMerge(projectRoot, branch, baseBranch).ok;
  return smartMerge(projectRoot, branch, baseBranch, {
    log: {
      info: (m: string) => {
        console.log(pc.dim(`  ${m}`));
      },
      ok: (m: string) => {
        console.log(pc.green(`  ${m}`));
      },
      warn: (m: string) => {
        console.log(pc.yellow(`  ${m}`));
      },
    },
  }).ok;
}

function tryCreatePR(
  projectRoot: string,
  branch: string,
  baseBranch: string,
): 'pr-created' | 'skipped' {
  const result = pushBranchAndCreatePR({ cwd: projectRoot, branch, baseBranch });
  if (result.ok) {
    console.log(pc.green(`  + PR created: ${result.url ?? ''}`));
    return 'pr-created';
  }
  console.log(pc.red(`  x PR creation failed: ${result.error ?? 'unknown error'}`));
  return 'skipped';
}

async function handlePR(
  rl: readline.Interface,
  projectRoot: string,
  branch: string,
  baseBranch: string,
  enablePR: boolean,
): Promise<'pr-created' | 'skipped'> {
  if (!enablePR) {
    console.log(pc.dim('  Skipped.'));
    return 'skipped';
  }
  const outcome = tryCreatePR(projectRoot, branch, baseBranch);
  if (outcome === 'pr-created') {
    const delAnswer = await ask(rl, `  Delete local branch? (y/N) `);
    if (delAnswer === 'y' || delAnswer === 'yes') {
      checkoutBranch(projectRoot, baseBranch);
      deleteBranch(projectRoot, branch);
      console.log(pc.dim('  Branch deleted.'));
    }
  }
  return outcome;
}

async function handleMerge(
  rl: readline.Interface,
  projectRoot: string,
  branch: string,
  baseBranch: string,
  useSmartMerge: boolean,
): Promise<'merged' | 'skipped'> {
  const ok = doMerge(projectRoot, branch, baseBranch, useSmartMerge, true);
  if (!ok) {
    console.log(pc.red(`  x Merge failed — resolve conflicts manually`));
    console.log(pc.dim(`    git merge ${branch}`));
    return 'skipped';
  }
  console.log(pc.green(`  + Merged ${branch} into ${baseBranch}`));
  const delAnswer = await ask(rl, `  Delete branch after merge? (Y/n) `);
  if (delAnswer !== 'n' && delAnswer !== 'no') {
    deleteBranch(projectRoot, branch);
    console.log(pc.dim('  Branch deleted.'));
  }
  return 'merged';
}

function handlePostDiffAction(
  postDiff: string,
  projectRoot: string,
  branch: string,
  baseBranch: string,
  opts: HandleBranchActionOpts,
): 'merged' | 'skipped' | 'deleted' | 'pr-created' {
  if ((postDiff === 'p' || postDiff === 'pr') && opts.enablePR === true) {
    return tryCreatePR(projectRoot, branch, baseBranch);
  }
  if (postDiff === 'm' || postDiff === 'merge') {
    const ok = doMerge(projectRoot, branch, baseBranch, opts.useSmartMerge === true, false);
    if (ok) {
      console.log(pc.green(`  + Merged ${branch} into ${baseBranch}`));
      deleteBranch(projectRoot, branch);
      console.log(pc.dim('  Branch deleted.'));
      return 'merged';
    }
    console.log(pc.red(`  x Merge failed`));
    return 'skipped';
  }
  if (postDiff === 'x' || postDiff === 'delete') {
    deleteBranch(projectRoot, branch);
    console.log(pc.dim('  Branch deleted.'));
    return 'deleted';
  }
  console.log(pc.dim('  Skipped.'));
  return 'skipped';
}

async function handleDiff(
  rl: readline.Interface,
  projectRoot: string,
  branch: string,
  baseBranch: string,
  opts: HandleBranchActionOpts,
): Promise<'merged' | 'skipped' | 'deleted' | 'pr-created'> {
  const fullDiff = getBranchDiff(projectRoot, branch, baseBranch);
  console.log(`\n${fullDiff}\n`);
  const prLabel2 = opts.enablePR === true ? `[${pc.magenta('p')}]r  ` : '';
  const postDiff = await ask(
    rl,
    `  After review: ${prLabel2}[${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.red('x')}]delete  ? `,
  );
  return handlePostDiffAction(postDiff, projectRoot, branch, baseBranch, opts);
}

export async function handleBranchAction(
  rl: readline.Interface,
  projectRoot: string,
  branch: string,
  baseBranch: string,
  opts: HandleBranchActionOpts = {},
): Promise<'merged' | 'skipped' | 'deleted' | 'pr-created'> {
  const prLabel = opts.enablePR === true ? `[${pc.magenta('p')}]r  ` : '';
  const answer = await ask(
    rl,
    `  ${prLabel}[${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.blue('d')}]iff  [${pc.red('x')}]delete  ? `,
  );

  switch (answer) {
    case 'p':
    case 'pr':
      return handlePR(rl, projectRoot, branch, baseBranch, opts.enablePR === true);
    case 'm':
    case 'merge':
      return handleMerge(rl, projectRoot, branch, baseBranch, opts.useSmartMerge === true);
    case 'd':
    case 'diff':
      return handleDiff(rl, projectRoot, branch, baseBranch, opts);
    case 'x':
    case 'delete':
      deleteBranch(projectRoot, branch);
      console.log(pc.dim('  Branch deleted.'));
      return 'deleted';
    default:
      console.log(pc.dim('  Skipped.'));
      return 'skipped';
  }
}

/**
 * Handle empty branch (no commits) with delete prompt.
 * @param {readline.Interface} rl
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<void>}
 */
export async function handleEmptyBranch(
  rl: readline.Interface,
  projectRoot: string,
  branch: string,
): Promise<void> {
  console.log(pc.dim('  (no commits on this branch)'));
  const cleanAnswer = await ask(rl, `\n  ${pc.yellow('Delete empty branch?')} (y/N) `);
  if (cleanAnswer === 'y' || cleanAnswer === 'yes') {
    deleteBranch(projectRoot, branch);
    console.log(pc.dim('  Deleted.'));
  }
}

/**
 * Clean (delete) all branches matching a prefix.
 * @param {string} projectRoot
 * @param {string} prefix
 * @param {string} baseBranch
 * @param {string|null} dateFilter
 */
export function cleanBranches(
  projectRoot: string,
  prefix: string,
  baseBranch: string,
  dateFilter: string | null = null,
): void {
  const branches = listBranches(projectRoot, prefix, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow(`No ${prefix} branches to clean.`));
    return;
  }

  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`Cleaning ${String(branches.length)} ${prefix} branch(es)...`));

  let deleted = 0;
  for (const branch of branches) {
    const ok = deleteBranch(projectRoot, branch);
    if (ok) {
      console.log(pc.dim(`  Deleted: ${branch}`));
      deleted++;
    } else {
      console.log(pc.red(`  Failed: ${branch}`));
    }
  }

  console.log(pc.green(`\nDone: ${String(deleted)}/${String(branches.length)} branches deleted.`));
}
