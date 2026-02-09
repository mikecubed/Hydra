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
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { resolveProject } from './hydra-config.mjs';
import { parseArgs } from './hydra-utils.mjs';
import { scanBranchViolations } from './hydra-nightly-guardrails.mjs';
import pc from 'picocolors';

// ── Git Helpers ─────────────────────────────────────────────────────────────

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
}

function getCurrentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return (r.stdout || '').trim();
}

function listNightlyBranches(cwd, dateFilter = null) {
  const pattern = dateFilter ? `nightly/${dateFilter}/*` : 'nightly/*';
  const r = git(['branch', '--list', pattern], cwd);
  if (!r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((b) => b.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);
}

function getBranchDiffStat(cwd, branch) {
  const r = git(['diff', '--stat', `dev...${branch}`], cwd);
  return (r.stdout || '').trim();
}

function getBranchDiffFull(cwd, branch) {
  const r = git(['diff', `dev...${branch}`], cwd);
  return (r.stdout || '').trim();
}

function getBranchLog(cwd, branch) {
  const r = git(['log', `dev..${branch}`, '--oneline', '--no-decorate'], cwd);
  return (r.stdout || '').trim();
}

function mergeBranch(cwd, branch) {
  // Ensure we're on dev
  const current = getCurrentBranch(cwd);
  if (current !== 'dev') {
    git(['checkout', 'dev'], cwd);
  }
  const r = git(['merge', branch, '--no-edit'], cwd);
  return r.status === 0;
}

function deleteBranch(cwd, branch) {
  const r = git(['branch', '-D', branch], cwd);
  return r.status === 0;
}

// ── Interactive Prompt ──────────────────────────────────────────────────────

function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim().toLowerCase()));
  });
}

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot, options) {
  const dateFilter = options.date || null;
  const branches = listNightlyBranches(projectRoot, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No nightly branches found.'));
    if (dateFilter) console.log(pc.dim(`  Filter: nightly/${dateFilter}/*`));
    return;
  }

  // Ensure we're on dev
  const current = getCurrentBranch(projectRoot);
  if (current !== 'dev') {
    console.log(pc.yellow(`Switching to dev branch (was on ${current})`));
    git(['checkout', 'dev'], projectRoot);
  }

  console.log(pc.bold(`\nNightly Review — ${branches.length} branch(es)\n`));

  // Load the latest nightly report if available
  const reportData = loadLatestReport(projectRoot, dateFilter);

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const slug = branch.split('/').pop();
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

    // Show diff stat
    const diffStat = getBranchDiffStat(projectRoot, branch);
    const commitLog = getBranchLog(projectRoot, branch);
    if (commitLog) {
      console.log(pc.dim('\n  Commits:'));
      for (const line of commitLog.split('\n')) {
        console.log(pc.dim(`    ${line}`));
      }
    }
    if (diffStat) {
      console.log(pc.dim('\n  Changes:'));
      for (const line of diffStat.split('\n')) {
        console.log(pc.dim(`    ${line}`));
      }
    }

    if (!commitLog) {
      console.log(pc.dim('  (no commits on this branch)'));
      const cleanAnswer = await ask(rl, `\n  ${pc.yellow('Delete empty branch?')} (y/N) `);
      if (cleanAnswer === 'y' || cleanAnswer === 'yes') {
        deleteBranch(projectRoot, branch);
        console.log(pc.dim('  Deleted.'));
      }
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

    // Prompt: merge / skip / diff / delete
    console.log('');
    const answer = await ask(rl, `  [${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.blue('d')}]iff  [${pc.red('x')}]delete  ? `);

    switch (answer) {
      case 'm':
      case 'merge': {
        const ok = mergeBranch(projectRoot, branch);
        if (ok) {
          console.log(pc.green(`  ✓ Merged ${branch} into dev`));
          merged++;
          // Optionally delete after merge
          const delAnswer = await ask(rl, `  Delete branch after merge? (Y/n) `);
          if (delAnswer !== 'n' && delAnswer !== 'no') {
            deleteBranch(projectRoot, branch);
            console.log(pc.dim('  Branch deleted.'));
          }
        } else {
          console.log(pc.red(`  ✗ Merge failed — resolve conflicts manually`));
          console.log(pc.dim(`    git merge ${branch}`));
        }
        break;
      }

      case 'd':
      case 'diff': {
        const fullDiff = getBranchDiffFull(projectRoot, branch);
        console.log('\n' + fullDiff + '\n');
        // Re-prompt after showing diff
        const postDiff = await ask(rl, `  After review: [${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.red('x')}]delete  ? `);
        if (postDiff === 'm' || postDiff === 'merge') {
          const ok = mergeBranch(projectRoot, branch);
          if (ok) {
            console.log(pc.green(`  ✓ Merged ${branch} into dev`));
            merged++;
            deleteBranch(projectRoot, branch);
            console.log(pc.dim('  Branch deleted.'));
          } else {
            console.log(pc.red(`  ✗ Merge failed`));
          }
        } else if (postDiff === 'x' || postDiff === 'delete') {
          deleteBranch(projectRoot, branch);
          console.log(pc.dim('  Branch deleted.'));
        } else {
          console.log(pc.dim('  Skipped.'));
          skipped++;
        }
        break;
      }

      case 'x':
      case 'delete': {
        deleteBranch(projectRoot, branch);
        console.log(pc.dim('  Branch deleted.'));
        break;
      }

      default: {
        console.log(pc.dim('  Skipped.'));
        skipped++;
        break;
      }
    }
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${merged} merged, ${skipped} skipped`));
}

// ── Status Command ──────────────────────────────────────────────────────────

function statusCommand(projectRoot, options) {
  const dateFilter = options.date || null;
  const branches = listNightlyBranches(projectRoot, dateFilter);

  console.log(pc.bold('\nNightly Status'));

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No nightly branches found.'));
  } else {
    console.log(`\n  Branches (${branches.length}):`);
    for (const b of branches) {
      const log = getBranchLog(projectRoot, b);
      const commitCount = log ? log.split('\n').length : 0;
      console.log(`    ${b} (${commitCount} commit${commitCount !== 1 ? 's' : ''})`);
    }
  }

  // Show latest report
  const report = loadLatestReport(projectRoot, dateFilter);
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
  const dateFilter = options.date || null;
  const branches = listNightlyBranches(projectRoot, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No nightly branches to clean.'));
    return;
  }

  // Ensure we're on dev
  const current = getCurrentBranch(projectRoot);
  if (current !== 'dev') {
    git(['checkout', 'dev'], projectRoot);
  }

  console.log(pc.bold(`Cleaning ${branches.length} nightly branch(es)...`));

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

  console.log(pc.green(`\nDone: ${deleted}/${branches.length} branches deleted.`));
}

// ── Report Loading ──────────────────────────────────────────────────────────

function loadLatestReport(projectRoot, dateFilter = null) {
  const nightlyDir = path.join(projectRoot, 'docs', 'coordination', 'nightly');
  if (!fs.existsSync(nightlyDir)) return null;

  if (dateFilter) {
    const jsonPath = path.join(nightlyDir, `NIGHTLY_${dateFilter}.json`);
    if (fs.existsSync(jsonPath)) {
      try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return null; }
    }
    return null;
  }

  // Find latest by filename
  const files = fs.readdirSync(nightlyDir)
    .filter((f) => f.startsWith('NIGHTLY_') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(nightlyDir, files[0]), 'utf8'));
  } catch {
    return null;
  }
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
