#!/usr/bin/env node
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

import path from 'path';
import { resolveProject } from './hydra-config.mjs';
import { parseArgs } from './hydra-utils.mjs';
import { scanBranchViolations } from './hydra-nightly-guardrails.mjs';
import {
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchLog,
  deleteBranch,
} from './hydra-shared/git-ops.mjs';
import {
  createRL,
  ask,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './hydra-shared/review-common.mjs';
import { isGhAvailable } from './hydra-github.mjs';
import pc from 'picocolors';

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot, options) {
  const dateFilter = options.date || null;
  const branches = listBranches(projectRoot, 'nightly', dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No nightly branches found.'));
    if (dateFilter) console.log(pc.dim(`  Filter: nightly/${dateFilter}/*`));
    return;
  }

  // Ensure we're on dev
  const current = getCurrentBranch(projectRoot);
  if (current !== 'dev') {
    console.log(pc.yellow(`Switching to dev branch (was on ${current})`));
    checkoutBranch(projectRoot, 'dev');
  }

  console.log(pc.bold(`\nNightly Review — ${branches.length} branch(es)\n`));

  // Load the latest nightly report if available
  const nightlyDir = path.join(projectRoot, 'docs', 'coordination', 'nightly');
  const reportData = loadLatestReport(nightlyDir, 'NIGHTLY', dateFilter);

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const reportEntry = reportData?.results?.find((r) => r.branch === branch);

    console.log(pc.bold(pc.cyan(`\n── ${branch} ──`)));

    // Show report info if available
    if (reportEntry) {
      const statusColor = reportEntry.status === 'success' ? pc.green : pc.yellow;
      console.log(`  Status: ${statusColor(reportEntry.status.toUpperCase())}`);
      console.log(`  Agent: ${reportEntry.agent || 'claude'}`);
      if (reportEntry.tokensUsed) console.log(`  Tokens: ~${reportEntry.tokensUsed.toLocaleString()}`);
      console.log(`  Typecheck: ${reportEntry.verification || '?'}`);
      if (reportEntry.violations?.length > 0) {
        console.log(pc.red(`  Violations: ${reportEntry.violations.length}`));
        for (const v of reportEntry.violations) {
          console.log(pc.red(`    [${v.severity}] ${v.detail}`));
        }
      }
    }

    // Show diff stat and commit log
    const { commitLog } = displayBranchInfo(projectRoot, branch, 'dev');

    if (!commitLog) {
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

    // Also scan for violations live (may catch things the report missed)
    const liveViolations = scanBranchViolations(projectRoot, branch);
    if (liveViolations.length > 0 && !reportEntry?.violations?.length) {
      console.log(pc.red(`\n  Live violation scan: ${liveViolations.length} issue(s)`));
      for (const v of liveViolations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    // Prompt: merge / skip / diff / delete / pr
    console.log('');
    const result = await handleBranchAction(rl, projectRoot, branch, 'dev', { enablePR: isGhAvailable() });
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${merged} merged, ${skipped} skipped`));
}

// ── Status Command ──────────────────────────────────────────────────────────

function statusCommand(projectRoot, options) {
  const dateFilter = options.date || null;
  const branches = listBranches(projectRoot, 'nightly', dateFilter);

  console.log(pc.bold('\nNightly Status'));

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No nightly branches found.'));
  } else {
    console.log(`\n  Branches (${branches.length}):`);
    for (const b of branches) {
      const log = getBranchLog(projectRoot, b, 'dev');
      const commitCount = log ? log.split('\n').length : 0;
      console.log(`    ${b} (${commitCount} commit${commitCount !== 1 ? 's' : ''})`);
    }
  }

  // Show latest report
  const nightlyDir = path.join(projectRoot, 'docs', 'coordination', 'nightly');
  const report = loadLatestReport(nightlyDir, 'NIGHTLY', dateFilter);
  if (report) {
    console.log(`\n  Latest Report: ${report.date}`);
    console.log(`  Tasks: ${report.processedTasks}/${report.totalTasks}`);
    if (report.stopReason) console.log(`  Stopped: ${report.stopReason}`);
    console.log(`  Tokens: ~${report.budget?.consumed?.toLocaleString() || '?'}`);

    if (report.results) {
      console.log('');
      for (const r of report.results) {
        const icon = r.status === 'success' ? pc.green('✓') : r.status === 'partial' ? pc.yellow('~') : pc.red('✗');
        const agentTag = r.agent !== 'claude' ? pc.dim(` [${r.agent}]`) : '';
        console.log(`    ${icon} ${r.slug} — ${r.status}${agentTag}`);
      }
    }
  } else {
    console.log(pc.dim('\n  No nightly report found.'));
  }

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot, options) {
  cleanBranches(projectRoot, 'nightly', 'dev', options.date || null);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const command = positionals[0] || options.command || 'status';

  let config;
  try {
    config = resolveProject({ project: options.project });
  } catch (err) {
    console.error(pc.red(`Project resolution failed: ${err.message}`));
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
      console.error('Usage: hydra-nightly-review.mjs [review|status|clean]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
