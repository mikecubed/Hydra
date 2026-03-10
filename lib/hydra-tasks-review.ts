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

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter = (options['date'] as string) || null;
  const branches = listBranches(projectRoot, BRANCH_PREFIX, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No tasks branches found.'));
    if (dateFilter) console.log(pc.dim(`  Filter: ${BRANCH_PREFIX}/${dateFilter}/*`));
    return;
  }

  // Ensure we're on dev
  const current = getCurrentBranch(projectRoot);
  if (current !== BASE_BRANCH) {
    console.log(pc.yellow(`Switching to ${BASE_BRANCH} branch (was on ${current})`));
    checkoutBranch(projectRoot, BASE_BRANCH);
  }

  console.log(pc.bold(`\nTasks Review — ${String(branches.length)} branch(es)\n`));

  // Load the latest report if available
  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'tasks');
  const reportData = loadLatestReport(reportDir, REPORT_PREFIX, dateFilter) as Record<string, unknown> | null;

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const reportEntry = (reportData?.['results'] as Record<string, unknown>[] | undefined)?.find((r: Record<string, unknown>) => r['branch'] === branch);

    console.log(pc.bold(pc.cyan(`\n── ${branch} ──`)));

    // Show report info if available
    if (reportEntry) {
      const status = reportEntry['status'] as string | undefined;
      const statusColor = status === 'success' ? pc.green : pc.yellow;
      console.log(`  Status: ${statusColor((status ?? '').toUpperCase())}`);
      console.log(`  Agent: ${String(reportEntry['agent'] ?? '?')}`);
      const tokens = reportEntry['tokens'] as number | undefined;
      if (tokens) console.log(`  Tokens: ~${tokens.toLocaleString()}`);
      const verdict = reportEntry['verdict'] as string | undefined;
      if (verdict) console.log(`  Verdict: ${verdict}`);
      const verification = reportEntry['verification'] as Record<string, unknown> | undefined;
      if (verification?.['command']) {
        const vIcon = verification['passed'] ? pc.green('pass') : pc.red('FAIL');
        console.log(`  Verification: ${vIcon} (${String(verification['command'])})`);
      }
      const violations = reportEntry['violations'] as Array<Record<string, unknown>> | undefined;
      if (violations && violations.length > 0) {
        console.log(pc.red(`  Violations: ${String(violations.length)}`));
        for (const v of violations) {
          console.log(pc.red(`    [${String(v['severity'])}] ${String(v['detail'])}`));
        }
      }
    }

    // Show diff stat and commit log
    const { commitLog } = displayBranchInfo(projectRoot, branch, BASE_BRANCH);

    if (!commitLog) {
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

    // Live violation scan
    const liveViolations = scanBranchViolations(projectRoot, branch, {
      baseBranch: BASE_BRANCH,
      protectedFiles: PROTECTED_FILES,
      protectedPatterns: BASE_PROTECTED_PATTERNS,
    });
    if (liveViolations.length > 0 && !(reportEntry?.['violations'] as unknown[] | undefined)?.length) {
      console.log(pc.red(`\n  Live violation scan: ${liveViolations.length} issue(s)`));
      for (const v of liveViolations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    // Prompt action
    console.log('');
    const result = await handleBranchAction(rl, projectRoot, branch, BASE_BRANCH, {
      enablePR: isGhAvailable(),
    });
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${merged} merged, ${skipped} skipped`));
}

// ── Status Command ──────────────────────────────────────────────────────────

function statusCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const dateFilter = (options['date'] as string) || null;
  const branches = listBranches(projectRoot, BRANCH_PREFIX, dateFilter);

  console.log(pc.bold('\nTasks Status'));

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No tasks branches found.'));
  } else {
    console.log(`\n  Branches (${branches.length}):`);
    for (const b of branches) {
      const log = getBranchLog(projectRoot, b, BASE_BRANCH);
      const commitCount = log ? log.split('\n').length : 0;
      console.log(`    ${b} (${commitCount} commit${commitCount === 1 ? '' : 's'})`);
    }
  }

  // Show latest report
  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'tasks');
  const report = loadLatestReport(reportDir, REPORT_PREFIX, dateFilter) as Record<string, unknown> | null;
  if (report) {
    console.log(`\n  Latest Report: ${report['date']}`);
    console.log(`  Tasks: ${report['processedTasks']}/${report['totalTasks']}`);
    console.log(`  Successful: ${(report['successful'] as number) || 0}`);
    console.log(`  Failed: ${(report['failed'] as number) || 0}`);
    if (report['stopReason']) console.log(`  Stopped: ${report['stopReason']}`);
    console.log(`  Tokens: ~${(report['budget'] as any)?.consumed?.toLocaleString() || '?'}`);

    if (report['results']) {
      console.log('');
      for (const r of report['results'] as any[]) {
        const icon =
          r.status === 'success'
            ? pc.green('pass')
            : r.status === 'failed'
              ? pc.red('FAIL')
              : pc.yellow(r.status);
        const agentTag = pc.dim(` [${r.agent}]`);
        console.log(`    ${icon} ${r.slug || r.task?.slice(0, 40)} — ${r.status}${agentTag}`);
      }
    }
  } else {
    console.log(pc.dim('\n  No tasks report found.'));
  }

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot: string, options: Record<string, string | boolean>) {
  cleanBranches(projectRoot, BRANCH_PREFIX, BASE_BRANCH, (options['date'] as string) || null);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const command = positionals[0] || options['command'] || 'status';

  let config;
  try {
    config = resolveProject({ project: options['project'] ? String(options['project']) : undefined });
  } catch (err: unknown) {
    console.error(pc.red(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
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
      console.error('Usage: hydra-tasks-review.mjs [review|status|clean]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
