/**
 * Hydra Tasks Review — Post-run interactive review, status, and cleanup.
 *
 * Subcommands:
 *   review  — Walk through tasks/* branches, show diffs, merge approved ones
 *   status  — Show latest tasks report summary
 *   clean   — Delete all tasks/* branches (or filter by date)
 *
 * Usage:
 *   node lib/hydra-tasks-review.mjs review
 *   node lib/hydra-tasks-review.mjs status
 *   node lib/hydra-tasks-review.mjs clean
 *   node lib/hydra-tasks-review.mjs clean date=2026-02-10
 */

import path from 'node:path';
import { resolveProject } from './hydra-config.ts';
import { parseArgs } from './hydra-utils.ts';
import {
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchLog,
  deleteBranch as _deleteBranch,
} from './hydra-shared/git-ops.ts';
import {
  createRL,
  ask as _ask,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './hydra-shared/review-common.ts';
import { scanBranchViolations } from './hydra-shared/guardrails.ts';
import { BASE_PROTECTED_FILES, BASE_PROTECTED_PATTERNS } from './hydra-shared/constants.ts';
import { isGhAvailable } from './hydra-github.ts';
import pc from 'picocolors';

const BRANCH_PREFIX = 'tasks';
const REPORT_PREFIX = 'TASKS';
const BASE_BRANCH = 'dev';

const PROTECTED_FILES = new Set([...BASE_PROTECTED_FILES, 'hydra.config.json']);

function printTasksEntryViolations(violations: Array<Record<string, unknown>>): void {
  console.log(pc.red(`  Violations: ${String(violations.length)}`));
  for (const v of violations) {
    console.log(pc.red(`    [${String(v['severity'])}] ${String(v['detail'])}`));
  }
}

function printTasksReportEntry(reportEntry: Record<string, unknown> | undefined): void {
  if (!reportEntry) return;
  const status = reportEntry['status'] as string | undefined;
  const statusColor = status === 'success' ? pc.green : pc.yellow;
  console.log(`  Status: ${statusColor((status ?? '').toUpperCase())}`);
  console.log(`  Agent: ${(reportEntry['agent'] as string | undefined) ?? '?'}`);
  const tokens = reportEntry['tokens'] as number | undefined;
  if (tokens != null && tokens !== 0) console.log(`  Tokens: ~${tokens.toLocaleString()}`);
  const verdict = reportEntry['verdict'] as string | undefined;
  if (verdict != null && verdict !== '') console.log(`  Verdict: ${verdict}`);
  const verification = reportEntry['verification'] as Record<string, unknown> | undefined;
  if (verification?.['command'] != null) {
    const vIcon = verification['passed'] === true ? pc.green('pass') : pc.red('FAIL');
    console.log(`  Verification: ${vIcon} (${verification['command'] as string})`);
  }
  const violations = reportEntry['violations'] as Array<Record<string, unknown>> | undefined;
  if (violations && violations.length > 0) {
    printTasksEntryViolations(violations);
  }
}

function printTasksLiveViolations(
  liveViolations: Array<{ severity: string; detail: string }>,
  reportEntry: Record<string, unknown> | undefined,
): void {
  if (
    liveViolations.length > 0 &&
    ((reportEntry?.['violations'] as unknown[] | undefined)?.length ?? 0) === 0
  ) {
    console.log(pc.red(`\n  Live violation scan: ${String(liveViolations.length)} issue(s)`));
    for (const v of liveViolations) {
      console.log(pc.red(`    [${v.severity}] ${v.detail}`));
    }
  }
}

async function processTasksBranch(
  rl: ReturnType<typeof createRL>,
  projectRoot: string,
  branch: string,
  reportEntry: Record<string, unknown> | undefined,
): Promise<string | null> {
  console.log(pc.bold(pc.cyan(`\n── ${branch} ──`)));
  printTasksReportEntry(reportEntry);

  const { commitLog } = displayBranchInfo(projectRoot, branch, BASE_BRANCH);
  if (commitLog === '') {
    await handleEmptyBranch(rl, projectRoot, branch);
    return null;
  }

  const liveViolations = scanBranchViolations(projectRoot, branch, {
    baseBranch: BASE_BRANCH,
    protectedFiles: PROTECTED_FILES,
    protectedPatterns: BASE_PROTECTED_PATTERNS,
  });
  printTasksLiveViolations(liveViolations, reportEntry);

  console.log('');
  return await handleBranchAction(rl, projectRoot, branch, BASE_BRANCH, {
    enablePR: isGhAvailable(),
  });
}

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const rawDateReview = options['date'];
  const dateFilter =
    typeof rawDateReview === 'string' && rawDateReview !== '' ? rawDateReview : null;
  const branches = listBranches(projectRoot, BRANCH_PREFIX, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No tasks branches found.'));
    if (dateFilter != null && dateFilter !== '')
      console.log(pc.dim(`  Filter: ${BRANCH_PREFIX}/${dateFilter}/*`));
    return;
  }

  const current = getCurrentBranch(projectRoot);
  if (current !== BASE_BRANCH) {
    console.log(pc.yellow(`Switching to ${BASE_BRANCH} branch (was on ${current})`));
    checkoutBranch(projectRoot, BASE_BRANCH);
  }

  console.log(pc.bold(`\nTasks Review — ${String(branches.length)} branch(es)\n`));

  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'tasks');
  const reportData = loadLatestReport(reportDir, REPORT_PREFIX, dateFilter) as Record<
    string,
    unknown
  > | null;

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const reportEntry = (reportData?.['results'] as Record<string, unknown>[] | undefined)?.find(
      (r: Record<string, unknown>) => r['branch'] === branch,
    );
    // eslint-disable-next-line no-await-in-loop -- sequential branch review
    const result = await processTasksBranch(rl, projectRoot, branch, reportEntry);
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${String(merged)} merged, ${String(skipped)} skipped`));
}

function printTasksResultRow(r: Record<string, unknown>): void {
  let icon: string;
  if (r['status'] === 'success') {
    icon = pc.green('pass');
  } else if (r['status'] === 'failed') {
    icon = pc.red('FAIL');
  } else {
    icon = pc.yellow(String(r['status']));
  }
  const agentTag = pc.dim(` [${String(r['agent'])}]`);
  const slug =
    (r['slug'] as string | undefined) ?? (r['task'] as string | undefined)?.slice(0, 40) ?? '';
  console.log(`    ${icon} ${slug} — ${String(r['status'])}${agentTag}`);
}

function printTasksStatusReport(report: Record<string, unknown> | null): void {
  if (!report) {
    console.log(pc.dim('\n  No tasks report found.'));
    return;
  }
  console.log(`\n  Latest Report: ${String(report['date'])}`);
  console.log(`  Tasks: ${String(report['processedTasks'])}/${String(report['totalTasks'])}`);
  console.log(`  Successful: ${String((report['successful'] as number | undefined) ?? 0)}`);
  console.log(`  Failed: ${String((report['failed'] as number | undefined) ?? 0)}`);
  if (report['stopReason'] != null && report['stopReason'] !== '')
    console.log(`  Stopped: ${report['stopReason'] as string}`);
  const budget = report['budget'] as Record<string, unknown> | undefined;
  const tokensConsumed =
    typeof budget?.['consumed'] === 'number' ? budget['consumed'].toLocaleString() : '?';
  console.log(`  Tokens: ~${tokensConsumed}`);

  if (report['results'] != null) {
    console.log('');
    for (const r of report['results'] as Record<string, unknown>[]) {
      printTasksResultRow(r);
    }
  }
}

// ── Status Command ──────────────────────────────────────────────────────────

function statusCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter = (options['date'] as string | undefined) ?? null;
  const branches = listBranches(projectRoot, BRANCH_PREFIX, dateFilter);

  console.log(pc.bold('\nTasks Status'));

  if (branches.length === 0) {
    console.log(pc.dim('  No tasks branches found.'));
  } else {
    console.log(`\n  Branches (${String(branches.length)}):`);
    for (const b of branches) {
      const log = getBranchLog(projectRoot, b, BASE_BRANCH);
      const commitCount = log === '' ? 0 : log.split('\n').length;
      console.log(`    ${b} (${String(commitCount)} commit${commitCount === 1 ? '' : 's'})`);
    }
  }

  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'tasks');
  const report = loadLatestReport(reportDir, REPORT_PREFIX, dateFilter) as Record<
    string,
    unknown
  > | null;
  printTasksStatusReport(report);

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot: string, options: Record<string, string | boolean>) {
  cleanBranches(
    projectRoot,
    BRANCH_PREFIX,
    BASE_BRANCH,
    (options['date'] as string | undefined) ?? null,
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const command =
    (positionals[0] as string | undefined) ??
    (options['command'] as string | true | undefined) ??
    'status';

  let config;
  try {
    config = resolveProject({
      project:
        typeof options['project'] === 'string' && options['project'] !== ''
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

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- 'true' from boolean CLI flag falls to default
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
      console.error(pc.red(`Unknown command: ${String(command)}`));
      console.error('Usage: hydra-tasks-review.mjs [review|status|clean]');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
