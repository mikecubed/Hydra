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
 *
 * Now uses shared modules from hydra-shared/ for git helpers and review infrastructure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import { parseArgs } from './hydra-utils.ts';
import { scanBranchViolations } from './hydra-evolve-guardrails.ts';
import { loadKnowledgeBase, searchEntries, getStats } from './hydra-knowledge.ts';
import {
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchLog,
} from './hydra-shared/git-ops.ts';
import {
  createRL,
  ask,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './hydra-shared/review-common.ts';
import { isGhAvailable } from './hydra-github.ts';
import {
  loadSuggestions,
  saveSuggestions,
  addSuggestion,
  getPendingSuggestions,
  getSuggestionStats,
} from './hydra-evolve-suggestions.ts';
import pc from 'picocolors';

interface EvolveRoundEntry {
  round?: number;
  verdict?: string;
  area?: string;
  score?: number;
  selectedImprovement?: string;
  learnings?: string;
}
interface EvolveSessionState {
  status?: string;
  sessionId?: string;
  summary?: { approved?: number; rejected?: number; skipped?: number; errors?: number };
  completedRounds?: Array<{ verdict?: string; round?: number; area?: string; score?: number }>;
  actionNeeded?: string;
  resumable?: boolean;
}
interface ReportBudget {
  consumed?: number;
}

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch ?? 'dev';
  const dateFilter =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const branches = listBranches(projectRoot, 'evolve', dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No evolve branches found.'));
    if (dateFilter !== null) console.log(pc.dim(`  Filter: evolve/${dateFilter}/*`));
    return;
  }

  // Ensure we're on base branch
  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    console.log(pc.yellow(`Switching to ${baseBranch} branch (was on ${current})`));
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`\nEvolve Review — ${String(branches.length)} branch(es)\n`));

  // Load latest decision data
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const reportData = loadLatestReport(evolveDir, 'EVOLVE', dateFilter) as Record<
    string,
    unknown
  > | null;

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    // Try to find matching decision
    const roundMatch = branch.match(/\/(\d+)$/);
    const roundNum = roundMatch ? Number.parseInt(roundMatch[1], 10) : null;
    const roundEntry = (reportData?.['rounds'] as EvolveRoundEntry[] | undefined)?.find(
      (r: EvolveRoundEntry) => r.round === roundNum,
    );

    console.log(pc.bold(pc.cyan(`\n-- ${branch} --`)));

    // Show decision info if available
    if (roundEntry != null) {
      let verdictColor: (s: string) => string;
      if (roundEntry.verdict === 'approve') {
        verdictColor = pc.green;
      } else if (roundEntry.verdict === 'revise') {
        verdictColor = pc.yellow;
      } else {
        verdictColor = pc.red;
      }
      console.log(`  Area: ${roundEntry.area ?? ''}`);
      console.log(`  Verdict: ${verdictColor((roundEntry.verdict ?? '?').toUpperCase())}`);
      if (roundEntry.score != null && roundEntry.score > 0)
        console.log(`  Score: ${String(roundEntry.score)}/10`);
      if (roundEntry.selectedImprovement != null && roundEntry.selectedImprovement.length > 0) {
        console.log(`  Improvement: ${roundEntry.selectedImprovement.slice(0, 100)}`);
      }
      if (roundEntry.learnings != null && roundEntry.learnings.length > 0) {
        console.log(`  Learnings: ${roundEntry.learnings.slice(0, 150)}`);
      }
    }

    // Show diff stat and commit log
    const { commitLog } = displayBranchInfo(projectRoot, branch, baseBranch);

    if (commitLog.length === 0) {
      // eslint-disable-next-line no-await-in-loop -- sequential interactive user prompts
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

    // Live violation scan
    const violations = scanBranchViolations(projectRoot, branch, baseBranch);
    if (violations.length > 0) {
      console.log(pc.red(`\n  Violations: ${String(violations.length)}`));
      for (const v of violations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    // Offer retry-as-suggestion for rejected/revise rounds
    if (
      roundEntry != null &&
      (roundEntry.verdict === 'reject' || roundEntry.verdict === 'revise') &&
      roundEntry.selectedImprovement != null &&
      roundEntry.selectedImprovement.length > 0
    ) {
      // eslint-disable-next-line no-await-in-loop -- sequential interactive user prompts
      const retryAnswer = await ask(rl, `  ${pc.magenta('[r]')}etry as suggestion? (r/n) `);
      if (retryAnswer === 'r' || retryAnswer === 'retry') {
        const sg = loadSuggestions(evolveDir);
        const created = addSuggestion(sg, {
          source: 'review:retry',
          sourceRef: branch,
          area: roundEntry.area ?? '',
          title: roundEntry.selectedImprovement.slice(0, 100),
          description: roundEntry.selectedImprovement,
          priority: 'high',
          tags: [roundEntry.area ?? '', 'retry', 'review-flagged'],
          notes: `Flagged during review. Original score: ${String(roundEntry.score ?? '?')}/10. ${roundEntry.learnings ?? ''}`,
        });
        if (created) {
          saveSuggestions(evolveDir, sg);
          console.log(pc.green(`  + Suggestion created: ${created.id ?? ''}`));
        } else {
          console.log(pc.dim('  (similar suggestion already exists)'));
        }
      }
    }

    // Prompt
    console.log('');
    // eslint-disable-next-line no-await-in-loop -- sequential interactive user prompts
    const result = await handleBranchAction(rl, projectRoot, branch, baseBranch, {
      enablePR: isGhAvailable(),
    });
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${String(merged)} merged, ${String(skipped)} skipped`));
}

// ── Status Command ──────────────────────────────────────────────────────────

function loadSessionState(evolveDir: string): EvolveSessionState | null {
  const statePath = path.join(evolveDir, 'EVOLVE_SESSION_STATE.json');
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as EvolveSessionState;
  } catch {
    return null;
  }
}

function statusCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch ?? 'dev';
  const dateFilter =
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null;
  const branches = listBranches(projectRoot, 'evolve', dateFilter);
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');

  console.log(pc.bold('\nEvolve Status'));

  // ── Session state (live tracking) ───────────────────────────────────
  const sessionState = loadSessionState(evolveDir);
  if (sessionState != null) {
    const statusColors: Partial<Record<string, (s: string) => string>> = {
      running: pc.blue,
      completed: pc.green,
      partial: pc.yellow,
      failed: pc.red,
      interrupted: pc.red,
    };
    const statusColor = statusColors[sessionState.status ?? ''] ?? pc.dim;
    console.log(`\n  Session: ${pc.bold(sessionState.sessionId ?? '?')}`);
    console.log(`  Status:  ${statusColor(pc.bold((sessionState.status ?? '').toUpperCase()))}`);

    if (sessionState.summary != null) {
      const s = sessionState.summary;
      const parts = [];
      if ((s.approved ?? 0) > 0) parts.push(pc.green(`${String(s.approved)} approved`));
      if ((s.rejected ?? 0) > 0) parts.push(pc.red(`${String(s.rejected)} rejected`));
      if ((s.skipped ?? 0) > 0) parts.push(pc.dim(`${String(s.skipped)} skipped`));
      if ((s.errors ?? 0) > 0) parts.push(pc.red(`${String(s.errors)} errors`));
      if (parts.length > 0) {
        console.log(`  Summary: ${parts.join(pc.dim(' / '))}`);
      }
    }

    // Per-round breakdown
    if (sessionState.completedRounds != null && sessionState.completedRounds.length > 0) {
      console.log('');
      for (const r of sessionState.completedRounds) {
        let icon: string;
        if (r.verdict === 'approve') {
          icon = pc.green('+');
        } else if (r.verdict === 'reject') {
          icon = pc.red('x');
        } else if (r.verdict === 'skipped') {
          icon = pc.dim('-');
        } else if (r.verdict === 'error') {
          icon = pc.red('!');
        } else {
          icon = pc.dim('?');
        }
        const scoreStr = r.score == null ? '' : pc.dim(` (${String(r.score)}/10)`);
        console.log(
          `    ${icon} Round ${String(r.round ?? '')}: ${r.area ?? ''} — ${r.verdict ?? '?'}${scoreStr}`,
        );
      }
    }

    if (sessionState.actionNeeded != null && sessionState.actionNeeded.length > 0) {
      console.log(`\n  ${pc.yellow(sessionState.actionNeeded)}`);
    }

    if (sessionState.resumable === true) {
      console.log(`  ${pc.dim('Tip:')} ${pc.cyan(':evolve resume')} to continue this session`);
    }

    console.log('');
  }

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No evolve branches found.'));
  } else {
    console.log(`  Branches (${String(branches.length)}):`);
    for (const b of branches) {
      const commitLog = getBranchLog(projectRoot, b, baseBranch);
      const commitCount = commitLog.length > 0 ? commitLog.split('\n').length : 0;
      console.log(`    ${b} (${String(commitCount)} commit${commitCount === 1 ? '' : 's'})`);
    }
  }

  // Show latest report
  const report = loadLatestReport(evolveDir, 'EVOLVE', dateFilter) as Record<
    string,
    unknown
  > | null;

  if (report == null && sessionState == null) {
    console.log(pc.dim('\n  No evolve report found.'));
  } else if (report != null) {
    console.log(`\n  Latest Report: ${(report['dateStr'] as string | undefined) ?? ''}`);
    console.log(
      `  Rounds: ${String((report['processedRounds'] as number | undefined) ?? '')}/${String((report['maxRounds'] as number | undefined) ?? '')}`,
    );
    if (report['stopReason'] != null)
      console.log(`  Stopped: ${(report['stopReason'] as string | undefined) ?? ''}`);
    console.log(
      `  Tokens: ~${(report['budget'] as ReportBudget | undefined)?.consumed?.toLocaleString() ?? '?'}`,
    );

    if (report['rounds'] != null && sessionState == null) {
      console.log('');
      for (const r of report['rounds'] as EvolveRoundEntry[]) {
        let icon: string;
        if (r.verdict === 'approve') {
          icon = pc.green('+');
        } else if (r.verdict === 'revise') {
          icon = pc.yellow('~');
        } else if (r.verdict === 'skipped') {
          icon = pc.dim('-');
        } else {
          icon = pc.red('x');
        }
        console.log(
          `    ${icon} Round ${String(r.round ?? '')}: ${r.area ?? ''} — ${r.verdict ?? '?'}${r.score != null && r.score > 0 ? ` (${String(r.score)}/10)` : ''}`,
        );
      }
    }
  }

  // Knowledge base summary
  const kb = loadKnowledgeBase(evolveDir);
  const stats = getStats(kb);
  console.log(
    `\n  Knowledge Base: ${String(stats.totalResearched)} entries, ${String(stats.totalApproved)} approved, ${String(stats.totalRejected)} rejected`,
  );
  if (stats.topAreas.length > 0) {
    console.log(
      `  Top areas: ${stats.topAreas
        .slice(0, 5)
        .map((a) => `${a.area}(${String(a.count)})`)
        .join(', ')}`,
    );
  }

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch ?? 'dev';
  cleanBranches(
    projectRoot,
    'evolve',
    baseBranch,
    typeof options['date'] === 'string' && options['date'].length > 0 ? options['date'] : null,
  );
}

// ── Knowledge Command ───────────────────────────────────────────────────────

function knowledgeCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const kb = loadKnowledgeBase(evolveDir);
  const stats = getStats(kb);

  console.log(pc.bold('\nEvolve Knowledge Base'));
  console.log(`  Entries: ${String(stats.totalResearched)}`);
  console.log(`  Attempted: ${String(stats.totalAttempted)}`);
  console.log(`  Approved: ${pc.green(String(stats.totalApproved))}`);
  console.log(`  Rejected: ${pc.red(String(stats.totalRejected))}`);
  console.log(`  Revised: ${pc.yellow(String(stats.totalRevised))}`);

  if (stats.topAreas.length > 0) {
    console.log('\n  Areas:');
    for (const a of stats.topAreas) {
      console.log(`    ${a.area}: ${String(a.count)} entries`);
    }
  }

  // Search if query provided
  let query = '';
  if (typeof options['query'] === 'string' && options['query'].length > 0) {
    query = options['query'];
  } else if (typeof options['search'] === 'string' && options['search'].length > 0) {
    query = options['search'];
  }
  const tags =
    typeof options['tags'] === 'string' && options['tags'].length > 0
      ? options['tags'].split(',')
      : [];

  if (query.length > 0 || tags.length > 0) {
    const results = searchEntries(kb, query, tags);
    console.log(`\n  Search results (${String(results.length)}):`);
    for (const entry of results.slice(0, 20)) {
      let icon: string;
      if (entry.outcome === 'approve') {
        icon = pc.green('+');
      } else if (entry.outcome === 'reject') {
        icon = pc.red('x');
      } else if (entry.outcome === 'revise') {
        icon = pc.yellow('~');
      } else {
        icon = pc.dim('?');
      }
      console.log(
        `    ${icon} [${entry.id ?? ''}] ${entry.area ?? ''}: ${(entry.finding ?? '').slice(0, 80)}`,
      );
      if (entry.learnings != null && entry.learnings.length > 0) {
        console.log(pc.dim(`      Learnings: ${entry.learnings.slice(0, 80)}`));
      }
    }
  } else if (kb.entries.length > 0) {
    console.log('\n  Recent entries:');
    const recent = [...kb.entries]
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, 10);
    for (const entry of recent) {
      let icon: string;
      if (entry.outcome === 'approve') {
        icon = pc.green('+');
      } else if (entry.outcome === 'reject') {
        icon = pc.red('x');
      } else if (entry.outcome === 'revise') {
        icon = pc.yellow('~');
      } else {
        icon = pc.dim('?');
      }
      console.log(
        `    ${icon} [${entry.id ?? ''}] ${entry.area ?? ''}: ${(entry.finding ?? '').slice(0, 80)}`,
      );
    }
  }

  console.log('');
}

// ── Suggestions Command ─────────────────────────────────────────────────────

function suggestionsCommand(projectRoot: string, options: Record<string, string | boolean>) {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const sg = loadSuggestions(evolveDir);
  const statusFilter =
    typeof options['status'] === 'string' && options['status'].length > 0
      ? options['status']
      : null;
  const entries =
    statusFilter === null
      ? getPendingSuggestions(sg)
      : sg.entries.filter((e: { status?: unknown }) => e.status === statusFilter);

  const label = statusFilter === null ? 'pending suggestions' : `${statusFilter} suggestions`;
  console.log(pc.bold(`\nEvolve Suggestions — ${String(entries.length)} ${label}\n`));

  if (entries.length === 0) {
    console.log(pc.dim('  No suggestions found.'));
    console.log('');
    return;
  }

  for (const s of entries) {
    let statusColor: (t: string) => string;
    if (s.status === 'pending') {
      statusColor = pc.cyan;
    } else if (s.status === 'completed') {
      statusColor = pc.green;
    } else if (s.status === 'rejected') {
      statusColor = pc.red;
    } else if (s.status === 'exploring') {
      statusColor = pc.yellow;
    } else {
      statusColor = pc.dim;
    }
    let priorityBadge: string;
    if (s.priority === 'high') {
      priorityBadge = pc.red('HIGH');
    } else if (s.priority === 'low') {
      priorityBadge = pc.dim('low');
    } else {
      priorityBadge = pc.yellow('med');
    }

    console.log(
      `  ${statusColor(s.id ?? '')} ${pc.yellow(s.area ?? '')}: ${(s.title ?? '').slice(0, 80)}`,
    );
    const parts = [`status: ${statusColor(s.status ?? '')}`, `priority: ${priorityBadge}`];
    if ((s.attempts ?? 0) > 0) {
      parts.push(`attempts: ${String(s.attempts ?? '')}/${String(s.maxAttempts ?? '')}`);
      if (s.lastAttemptScore != null) parts.push(`last: ${String(s.lastAttemptScore ?? '')}/10`);
    }
    if (s.specPath != null && s.specPath.length > 0) parts.push('has spec');
    console.log(`    ${pc.dim(parts.join(' | '))}`);
    console.log('');
  }

  const stats = getSuggestionStats(sg);
  console.log(
    pc.dim(
      `  Stats: ${String(stats.totalPending)} pending, ${String(stats.totalCompleted)} completed, ${String(stats.totalRejected)} rejected, ${String(stats.totalAbandoned)} abandoned`,
    ),
  );
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);

  let command: string;
  if (typeof positionals[0] === 'string' && positionals[0].length > 0) {
    command = positionals[0];
  } else if (typeof options['command'] === 'string' && options['command'].length > 0) {
    command = options['command'];
  } else {
    command = 'status';
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
    case 'knowledge':
      knowledgeCommand(projectRoot, options);
      break;
    case 'suggestions':
      suggestionsCommand(projectRoot, options);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-evolve-review.mjs [review|status|clean|knowledge|suggestions]');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  // eslint-disable-next-line n/no-process-exit -- inside .catch() callback; return does not propagate
  process.exit(1);
});
