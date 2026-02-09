#!/usr/bin/env node
/**
 * Hydra Evolve Review — Post-session review, merge, cleanup, and knowledge browsing.
 *
 * Subcommands:
 *   review    — Walk through evolve branches, show diffs, merge approved ones
 *   status    — Show latest evolve report summary
 *   clean     — Delete all evolve/* branches (or filter by date)
 *   knowledge — Display knowledge base stats, search entries
 *
 * Usage:
 *   node lib/hydra-evolve-review.mjs review
 *   node lib/hydra-evolve-review.mjs status
 *   node lib/hydra-evolve-review.mjs clean
 *   node lib/hydra-evolve-review.mjs clean date=2026-02-09
 *   node lib/hydra-evolve-review.mjs knowledge
 *   node lib/hydra-evolve-review.mjs knowledge query=routing
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { resolveProject, loadHydraConfig } from './hydra-config.mjs';
import { parseArgs } from './hydra-utils.mjs';
import { scanBranchViolations } from './hydra-evolve-guardrails.mjs';
import { loadKnowledgeBase, searchEntries, getStats } from './hydra-evolve-knowledge.mjs';
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

function listEvolveBranches(cwd, dateFilter = null) {
  const pattern = dateFilter ? `evolve/${dateFilter}/*` : 'evolve/*';
  const r = git(['branch', '--list', pattern], cwd);
  if (!r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((b) => b.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);
}

function getBranchDiffStat(cwd, branch, baseBranch) {
  const r = git(['diff', '--stat', `${baseBranch}...${branch}`], cwd);
  return (r.stdout || '').trim();
}

function getBranchDiffFull(cwd, branch, baseBranch) {
  const r = git(['diff', `${baseBranch}...${branch}`], cwd);
  return (r.stdout || '').trim();
}

function getBranchLog(cwd, branch, baseBranch) {
  const r = git(['log', `${baseBranch}..${branch}`, '--oneline', '--no-decorate'], cwd);
  return (r.stdout || '').trim();
}

function mergeBranch(cwd, branch, baseBranch) {
  const current = getCurrentBranch(cwd);
  if (current !== baseBranch) {
    git(['checkout', baseBranch], cwd);
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
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch || 'dev';
  const dateFilter = options.date || null;
  const branches = listEvolveBranches(projectRoot, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No evolve branches found.'));
    if (dateFilter) console.log(pc.dim(`  Filter: evolve/${dateFilter}/*`));
    return;
  }

  // Ensure we're on base branch
  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    console.log(pc.yellow(`Switching to ${baseBranch} branch (was on ${current})`));
    git(['checkout', baseBranch], projectRoot);
  }

  console.log(pc.bold(`\nEvolve Review — ${branches.length} branch(es)\n`));

  // Load latest decision data
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const reportData = loadLatestReport(evolveDir, dateFilter);

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    // Try to find matching decision
    const roundMatch = branch.match(/\/(\d+)$/);
    const roundNum = roundMatch ? parseInt(roundMatch[1], 10) : null;
    const roundEntry = reportData?.rounds?.find(r => r.round === roundNum);

    console.log(pc.bold(pc.cyan(`\n-- ${branch} --`)));

    // Show decision info if available
    if (roundEntry) {
      const verdictColor = roundEntry.verdict === 'approve' ? pc.green
        : roundEntry.verdict === 'revise' ? pc.yellow
        : pc.red;
      console.log(`  Area: ${roundEntry.area}`);
      console.log(`  Verdict: ${verdictColor(roundEntry.verdict?.toUpperCase() || '?')}`);
      if (roundEntry.score) console.log(`  Score: ${roundEntry.score}/10`);
      if (roundEntry.selectedImprovement) {
        console.log(`  Improvement: ${roundEntry.selectedImprovement.slice(0, 100)}`);
      }
      if (roundEntry.learnings) {
        console.log(`  Learnings: ${roundEntry.learnings.slice(0, 150)}`);
      }
    }

    // Show diff stat
    const diffStat = getBranchDiffStat(projectRoot, branch, baseBranch);
    const commitLog = getBranchLog(projectRoot, branch, baseBranch);

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

    // Live violation scan
    const violations = scanBranchViolations(projectRoot, branch, baseBranch);
    if (violations.length > 0) {
      console.log(pc.red(`\n  Violations: ${violations.length}`));
      for (const v of violations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    // Prompt
    console.log('');
    const answer = await ask(rl, `  [${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.blue('d')}]iff  [${pc.red('x')}]delete  ? `);

    switch (answer) {
      case 'm':
      case 'merge': {
        const ok = mergeBranch(projectRoot, branch, baseBranch);
        if (ok) {
          console.log(pc.green(`  + Merged ${branch} into ${baseBranch}`));
          merged++;
          const delAnswer = await ask(rl, `  Delete branch after merge? (Y/n) `);
          if (delAnswer !== 'n' && delAnswer !== 'no') {
            deleteBranch(projectRoot, branch);
            console.log(pc.dim('  Branch deleted.'));
          }
        } else {
          console.log(pc.red(`  x Merge failed — resolve conflicts manually`));
          console.log(pc.dim(`    git merge ${branch}`));
        }
        break;
      }

      case 'd':
      case 'diff': {
        const fullDiff = getBranchDiffFull(projectRoot, branch, baseBranch);
        console.log('\n' + fullDiff + '\n');
        const postDiff = await ask(rl, `  After review: [${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.red('x')}]delete  ? `);
        if (postDiff === 'm' || postDiff === 'merge') {
          const ok = mergeBranch(projectRoot, branch, baseBranch);
          if (ok) {
            console.log(pc.green(`  + Merged ${branch} into ${baseBranch}`));
            merged++;
            deleteBranch(projectRoot, branch);
            console.log(pc.dim('  Branch deleted.'));
          } else {
            console.log(pc.red(`  x Merge failed`));
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

function loadSessionState(evolveDir) {
  const statePath = path.join(evolveDir, 'EVOLVE_SESSION_STATE.json');
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function statusCommand(projectRoot, options) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch || 'dev';
  const dateFilter = options.date || null;
  const branches = listEvolveBranches(projectRoot, dateFilter);
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');

  console.log(pc.bold('\nEvolve Status'));

  // ── Session state (live tracking) ───────────────────────────────────
  const sessionState = loadSessionState(evolveDir);
  if (sessionState) {
    const statusColors = {
      running: pc.blue,
      completed: pc.green,
      partial: pc.yellow,
      failed: pc.red,
      interrupted: pc.red,
    };
    const statusColor = statusColors[sessionState.status] || pc.dim;
    console.log(`\n  Session: ${pc.bold(sessionState.sessionId || '?')}`);
    console.log(`  Status:  ${statusColor(pc.bold(sessionState.status.toUpperCase()))}`);

    if (sessionState.summary) {
      const s = sessionState.summary;
      const parts = [];
      if (s.approved > 0) parts.push(pc.green(`${s.approved} approved`));
      if (s.rejected > 0) parts.push(pc.red(`${s.rejected} rejected`));
      if (s.skipped > 0) parts.push(pc.dim(`${s.skipped} skipped`));
      if (s.errors > 0) parts.push(pc.red(`${s.errors} errors`));
      if (parts.length > 0) {
        console.log(`  Summary: ${parts.join(pc.dim(' / '))}`);
      }
    }

    // Per-round breakdown
    if (sessionState.completedRounds?.length > 0) {
      console.log('');
      for (const r of sessionState.completedRounds) {
        const icon = r.verdict === 'approve' ? pc.green('+')
          : r.verdict === 'reject' ? pc.red('x')
          : r.verdict === 'skipped' ? pc.dim('-')
          : r.verdict === 'error' ? pc.red('!')
          : pc.dim('?');
        const scoreStr = r.score != null ? pc.dim(` (${r.score}/10)`) : '';
        console.log(`    ${icon} Round ${r.round}: ${r.area} — ${r.verdict || '?'}${scoreStr}`);
      }
    }

    if (sessionState.actionNeeded) {
      console.log(`\n  ${pc.yellow(sessionState.actionNeeded)}`);
    }

    if (sessionState.resumable) {
      console.log(`  ${pc.dim('Tip:')} ${pc.cyan(':evolve resume')} to continue this session`);
    }

    console.log('');
  }

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No evolve branches found.'));
  } else {
    console.log(`  Branches (${branches.length}):`);
    for (const b of branches) {
      const commitLog = getBranchLog(projectRoot, b, baseBranch);
      const commitCount = commitLog ? commitLog.split('\n').length : 0;
      console.log(`    ${b} (${commitCount} commit${commitCount !== 1 ? 's' : ''})`);
    }
  }

  // Show latest report
  const report = loadLatestReport(evolveDir, dateFilter);

  if (report) {
    console.log(`\n  Latest Report: ${report.dateStr}`);
    console.log(`  Rounds: ${report.processedRounds}/${report.maxRounds}`);
    if (report.stopReason) console.log(`  Stopped: ${report.stopReason}`);
    console.log(`  Tokens: ~${report.budget?.consumed?.toLocaleString() || '?'}`);

    if (report.rounds && !sessionState) {
      console.log('');
      for (const r of report.rounds) {
        const icon = r.verdict === 'approve' ? pc.green('+')
          : r.verdict === 'revise' ? pc.yellow('~')
          : r.verdict === 'skipped' ? pc.dim('-')
          : pc.red('x');
        console.log(`    ${icon} Round ${r.round}: ${r.area} — ${r.verdict || '?'}${r.score ? ` (${r.score}/10)` : ''}`);
      }
    }
  } else if (!sessionState) {
    console.log(pc.dim('\n  No evolve report found.'));
  }

  // Knowledge base summary
  const kb = loadKnowledgeBase(evolveDir);
  const stats = getStats(kb);
  console.log(`\n  Knowledge Base: ${stats.totalResearched} entries, ${stats.totalApproved} approved, ${stats.totalRejected} rejected`);
  if (stats.topAreas.length > 0) {
    console.log(`  Top areas: ${stats.topAreas.slice(0, 5).map(a => `${a.area}(${a.count})`).join(', ')}`);
  }

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot, options) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch || 'dev';
  const dateFilter = options.date || null;
  const branches = listEvolveBranches(projectRoot, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No evolve branches to clean.'));
    return;
  }

  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    git(['checkout', baseBranch], projectRoot);
  }

  console.log(pc.bold(`Cleaning ${branches.length} evolve branch(es)...`));

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

// ── Knowledge Command ───────────────────────────────────────────────────────

function knowledgeCommand(projectRoot, options) {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const kb = loadKnowledgeBase(evolveDir);
  const stats = getStats(kb);

  console.log(pc.bold('\nEvolve Knowledge Base'));
  console.log(`  Entries: ${stats.totalResearched}`);
  console.log(`  Attempted: ${stats.totalAttempted}`);
  console.log(`  Approved: ${pc.green(String(stats.totalApproved))}`);
  console.log(`  Rejected: ${pc.red(String(stats.totalRejected))}`);
  console.log(`  Revised: ${pc.yellow(String(stats.totalRevised))}`);

  if (stats.topAreas.length > 0) {
    console.log('\n  Areas:');
    for (const a of stats.topAreas) {
      console.log(`    ${a.area}: ${a.count} entries`);
    }
  }

  // Search if query provided
  const query = options.query || options.search || '';
  const tags = options.tags ? options.tags.split(',') : [];

  if (query || tags.length > 0) {
    const results = searchEntries(kb, query, tags);
    console.log(`\n  Search results (${results.length}):`);
    for (const entry of results.slice(0, 20)) {
      const icon = entry.outcome === 'approve' ? pc.green('+')
        : entry.outcome === 'reject' ? pc.red('x')
        : entry.outcome === 'revise' ? pc.yellow('~')
        : pc.dim('?');
      console.log(`    ${icon} [${entry.id}] ${entry.area}: ${entry.finding.slice(0, 80)}`);
      if (entry.learnings) {
        console.log(pc.dim(`      Learnings: ${entry.learnings.slice(0, 80)}`));
      }
    }
  } else if (kb.entries.length > 0) {
    console.log('\n  Recent entries:');
    const recent = [...kb.entries].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10);
    for (const entry of recent) {
      const icon = entry.outcome === 'approve' ? pc.green('+')
        : entry.outcome === 'reject' ? pc.red('x')
        : entry.outcome === 'revise' ? pc.yellow('~')
        : pc.dim('?');
      console.log(`    ${icon} [${entry.id}] ${entry.area}: ${entry.finding.slice(0, 80)}`);
    }
  }

  console.log('');
}

// ── Report Loading ──────────────────────────────────────────────────────────

function loadLatestReport(evolveDir, dateFilter = null) {
  if (!fs.existsSync(evolveDir)) return null;

  if (dateFilter) {
    const jsonPath = path.join(evolveDir, `EVOLVE_${dateFilter}.json`);
    if (fs.existsSync(jsonPath)) {
      try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return null; }
    }
    return null;
  }

  // Find latest by filename
  try {
    const files = fs.readdirSync(evolveDir)
      .filter((f) => f.startsWith('EVOLVE_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(evolveDir, files[0]), 'utf8'));
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
    case 'knowledge':
      knowledgeCommand(projectRoot, options);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-evolve-review.mjs [review|status|clean|knowledge]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
