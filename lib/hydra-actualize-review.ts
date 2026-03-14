/**
 * Hydra Actualize Review — review/merge/clean branches created by hydra-actualize.
 *
 * Subcommands:
 *   review  — Walk through actualize branches, show diffs, merge approved ones
 *   status  — Show latest actualize report summary
 *   clean   — Delete all actualize/* branches (or filter by date)
 *
 * Usage:
 *   node lib/hydra-actualize-review.mjs review
 *   node lib/hydra-actualize-review.mjs status
 *   node lib/hydra-actualize-review.mjs clean
 *   node lib/hydra-actualize-review.mjs clean date=2026-02-09
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
interface ReportBudget {
  consumed?: number;
}
interface ReportArtifacts {
  selfSnapshot?: string;
  selfIndex?: string;
}

function hasBaseAdvanced(projectRoot: string, branch: string, baseBranch: string) {
  try {
    const r = git(['merge-base', '--is-ancestor', baseBranch, branch], projectRoot);
    return r.status !== 0;
  } catch {
    return true;
  }
}

async function reviewCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const branches = listBranches(projectRoot, 'actualize', dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No actualize branches found.'));
    if (dateFilter !== null) console.log(pc.dim(`  Filter: actualize/${dateFilter}/*`));
    return;
  }

  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'actualize');
  const reportData = loadLatestReport(reportDir, 'ACTUALIZE', dateFilter) as Record<
    string,
    unknown
  > | null;
  const baseBranch = (reportData?.['baseBranch'] as string | undefined) ?? 'dev';

  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    console.log(pc.yellow(`Switching to ${baseBranch} branch (was on ${current})`));
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`\nActualize Review — ${String(branches.length)} branch(es)\n`));

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const reportEntry = (reportData?.['results'] as ReportEntry[] | undefined)?.find(
      (r: ReportEntry) => r.branch === branch,
    );

    console.log(pc.bold(pc.cyan(`\n── ${branch} ──`)));

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

    if (hasBaseAdvanced(projectRoot, branch, baseBranch)) {
      console.log(
        pc.yellow(
          `  ${baseBranch} has advanced since this branch was created — smart merge will rebase first`,
        ),
      );
    }

    const { commitLog } = displayBranchInfo(projectRoot, branch, baseBranch);
    if (commitLog.length === 0) {
      // eslint-disable-next-line no-await-in-loop -- sequential interactive user prompts
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

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

function statusCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const branches = listBranches(projectRoot, 'actualize', dateFilter);

  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'actualize');
  const report = loadLatestReport(reportDir, 'ACTUALIZE', dateFilter) as Record<
    string,
    unknown
  > | null;
  const baseBranch = (report?.['baseBranch'] as string | undefined) ?? 'dev';

  console.log(pc.bold('\nActualize Status'));

  if (branches.length === 0) {
    console.log(pc.dim('  No actualize branches found.'));
  } else {
    console.log(`\n  Branches (${String(branches.length)}):`);
    for (const b of branches) {
      const branchLog = getBranchLog(projectRoot, b, baseBranch);
      const commitCount = branchLog.length > 0 ? branchLog.split('\n').length : 0;
      console.log(`    ${b} (${String(commitCount)} commit${commitCount === 1 ? '' : 's'})`);
    }
  }

  if (report == null) {
    console.log(pc.dim('\n  No actualize report found.'));
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
    const artifacts = report['artifacts'] as ReportArtifacts | undefined;
    if (artifacts?.selfSnapshot != null) console.log(`  Self snapshot: ${artifacts.selfSnapshot}`);
    if (artifacts?.selfIndex != null) console.log(`  Self index: ${artifacts.selfIndex}`);
  }

  console.log('');
}

function cleanCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'actualize');
  const dateOpt =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const report = loadLatestReport(reportDir, 'ACTUALIZE', dateOpt) as Record<
    string,
    unknown
  > | null;
  const baseBranch = (report?.['baseBranch'] as string | undefined) ?? 'dev';

  cleanBranches(projectRoot, 'actualize', baseBranch, dateOpt);
}

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
      console.error('Usage: hydra-actualize-review.mjs [review|status|clean]');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  exit(1);
});
