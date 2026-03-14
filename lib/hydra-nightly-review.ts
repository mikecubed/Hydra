/**
 * Hydra Nightly Review — Morning review, interactive merge, and cleanup.
 *
 * Subcommands:
 *   review  — Walk through nightly branches, show diffs, merge approved ones
 *   status  — Show latest nightly report summary
 *   clean   — Delete all nightly/* branches (or filter by date)
 *
 * Usage:
 *   node lib/hydra-nightly-review.mjs review
 *   node lib/hydra-nightly-review.mjs status
 *   node lib/hydra-nightly-review.mjs clean
 *   node lib/hydra-nightly-review.mjs clean date=2026-02-09
 *
 * Now uses shared modules from hydra-shared/ for git helpers and review infrastructure.
 */

import path from 'node:path';
import { resolveProject } from './hydra-config.ts';
import { parseArgs } from './hydra-utils.ts';
import { scanBranchViolations } from './hydra-shared/guardrails.ts';
import {
  git,
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchLog,
} from './hydra-shared/git-ops.ts';
import { BASE_PROTECTED_FILES, BASE_PROTECTED_PATTERNS } from './hydra-shared/constants.ts';
import {
  createRL,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './hydra-shared/review-common.ts';
import { isGhAvailable } from './hydra-github.ts';
import pc from 'picocolors';
import { exit } from './hydra-process.ts';

interface ReportEntry {
  branch?: string;
  status?: string;
  agent?: string;
  source?: string;
  taskType?: string;
  tokensUsed?: number;
  verification?: string;
  violations?: Array<{ severity: string; detail: string }>;
}
interface NightlyResult {
  status?: string;
  agent?: string;
  slug?: string;
}
interface ReportBudget {
  consumed?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasBaseAdvanced(projectRoot: string, branch: string, baseBranch: string) {
  try {
    const r = git(['merge-base', '--is-ancestor', baseBranch, branch], projectRoot);
    return r.status !== 0; // diverged if baseBranch is NOT ancestor of branch
  } catch {
    return true;
  }
}

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const branches = listBranches(projectRoot, 'nightly', dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No nightly branches found.'));
    if (dateFilter !== null) console.log(pc.dim(`  Filter: nightly/${dateFilter}/*`));
    return;
  }

  // Load the latest nightly report to determine baseBranch
  const nightlyDir = path.join(projectRoot, 'docs', 'coordination', 'nightly');
  const reportData = loadLatestReport(nightlyDir, 'NIGHTLY', dateFilter) as Record<
    string,
    unknown
  > | null;
  const baseBranch = (reportData?.['baseBranch'] as string | undefined) ?? 'dev';

  // Ensure we're on baseBranch
  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    console.log(pc.yellow(`Switching to ${baseBranch} branch (was on ${current})`));
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`\nNightly Review — ${String(branches.length)} branch(es)\n`));

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const reportEntry = (reportData?.['results'] as ReportEntry[] | undefined)?.find(
      (r: ReportEntry) => r.branch === branch,
    );

    console.log(pc.bold(pc.cyan(`\n── ${branch} ──`)));

    // Show report info if available
    if (reportEntry != null) {
      const statusColor = reportEntry.status === 'success' ? pc.green : pc.yellow;
      console.log(`  Status: ${statusColor((reportEntry.status ?? '').toUpperCase())}`);
      console.log(`  Agent: ${reportEntry.agent ?? 'claude'}`);
      if (reportEntry.source != null && reportEntry.source.length > 0)
        console.log(
          `  Source: ${reportEntry.source}${reportEntry.taskType != null && reportEntry.taskType.length > 0 ? ` (${reportEntry.taskType})` : ''}`,
        );
      if (reportEntry.tokensUsed != null && reportEntry.tokensUsed > 0)
        console.log(`  Tokens: ~${reportEntry.tokensUsed.toLocaleString()}`);
      console.log(`  Verification: ${reportEntry.verification ?? '?'}`);
      if (reportEntry.violations != null && reportEntry.violations.length > 0) {
        console.log(pc.red(`  Violations: ${String(reportEntry.violations.length)}`));
        for (const v of reportEntry.violations) {
          console.log(pc.red(`    [${v.severity}] ${v.detail}`));
        }
      }
    }

    // Check if base has advanced (diverged)
    if (hasBaseAdvanced(projectRoot, branch, baseBranch)) {
      console.log(
        pc.yellow(
          `  ${baseBranch} has advanced since this branch was created — smart merge will rebase first`,
        ),
      );
    }

    // Show diff stat and commit log
    const { commitLog } = displayBranchInfo(projectRoot, branch, baseBranch);

    if (commitLog.length === 0) {
      // eslint-disable-next-line no-await-in-loop -- sequential interactive user prompts
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

    // Also scan for violations live (may catch things the report missed)
    const liveViolations = scanBranchViolations(projectRoot, branch, {
      baseBranch,
      protectedFiles: new Set(BASE_PROTECTED_FILES),
      protectedPatterns: [...BASE_PROTECTED_PATTERNS],
    });
    if (
      liveViolations.length > 0 &&
      !(reportEntry?.violations != null && reportEntry.violations.length > 0)
    ) {
      console.log(pc.red(`\n  Live violation scan: ${String(liveViolations.length)} issue(s)`));
      for (const v of liveViolations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    // Prompt: merge / skip / diff / delete / pr
    console.log('');
    // eslint-disable-next-line no-await-in-loop -- sequential interactive user prompts
    const result = await handleBranchAction(rl, projectRoot, branch, baseBranch, {
      enablePR: isGhAvailable(),
      useSmartMerge: true,
    });
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${String(merged)} merged, ${String(skipped)} skipped`));
}

// ── Status Command ──────────────────────────────────────────────────────────

function statusCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const branches = listBranches(projectRoot, 'nightly', dateFilter);

  // Load report first to determine baseBranch
  const nightlyDir = path.join(projectRoot, 'docs', 'coordination', 'nightly');
  const report = loadLatestReport(nightlyDir, 'NIGHTLY', dateFilter) as Record<
    string,
    unknown
  > | null;
  const baseBranch = (report?.['baseBranch'] as string | undefined) ?? 'dev';

  console.log(pc.bold('\nNightly Status'));

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No nightly branches found.'));
  } else {
    console.log(`\n  Branches (${String(branches.length)}):`);
    for (const b of branches) {
      const branchLog = getBranchLog(projectRoot, b, baseBranch);
      const commitCount = branchLog.length > 0 ? branchLog.split('\n').length : 0;
      console.log(`    ${b} (${String(commitCount)} commit${commitCount === 1 ? '' : 's'})`);
    }
  }
  if (report == null) {
    console.log(pc.dim('\n  No nightly report found.'));
  } else {
    console.log(`\n  Latest Report: ${(report['date'] as string | undefined) ?? ''}`);
    console.log(
      `  Tasks: ${String((report['processedTasks'] as string | number | undefined) ?? '')}/${String((report['totalTasks'] as string | number | undefined) ?? '')}`,
    );
    if (report['stopReason'] != null)
      console.log(`  Stopped: ${(report['stopReason'] as string | undefined) ?? ''}`);
    console.log(
      `  Tokens: ~${(report['budget'] as ReportBudget | undefined)?.consumed?.toLocaleString() ?? '?'}`,
    );

    if (report['results'] != null) {
      console.log('');
      for (const r of report['results'] as NightlyResult[]) {
        let icon: string;
        if (r.status === 'success') {
          icon = pc.green('✓');
        } else if (r.status === 'partial') {
          icon = pc.yellow('~');
        } else {
          icon = pc.red('✗');
        }
        const agentTag = r.agent === 'claude' ? '' : pc.dim(` [${r.agent ?? ''}]`);
        console.log(`    ${icon} ${r.slug ?? ''} — ${r.status ?? ''}${agentTag}`);
      }
    }
  }

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const nightlyDir = path.join(projectRoot, 'docs', 'coordination', 'nightly');
  const dateOpt =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const report = loadLatestReport(nightlyDir, 'NIGHTLY', dateOpt) as Record<string, unknown> | null;
  const baseBranch = (report?.['baseBranch'] as string | undefined) ?? 'dev';

  cleanBranches(projectRoot, 'nightly', baseBranch, dateOpt);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  let command = 'status';
  if (positionals.length > 0 && positionals[0].length > 0) {
    command = positionals[0];
  } else if (typeof options['command'] === 'string' && options['command'].length > 0) {
    command = options['command'];
  }

  let config;
  try {
    config = resolveProject({
      project:
        typeof options['project'] === 'string' && options['project'].length > 0
          ? options['project']
          : undefined,
    });
  } catch (err: unknown) {
    console.error(
      pc.red(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exitCode = 1;
    return;
  }

  const { projectRoot } = config;

  switch (command) {
    case 'review':
      await reviewCommand(projectRoot, options);
      break;
    case 'status':
      statusCommand(projectRoot, options);
      break;
    case 'clean':
      cleanCommand(projectRoot, options);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-nightly-review.mjs [review|status|clean]');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  exit(1);
});
