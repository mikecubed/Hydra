/**
 * Hydra Evolve Suggestions CLI — Manage the improvement suggestions backlog.
 *
 * Subcommands:
 *   list     — List suggestions (default: pending; use status=all for all)
 *   add      — Add a new suggestion (title=... area=... description=...)
 *   remove   — Remove a suggestion by ID (set to abandoned)
 *   reset    — Reset a suggestion back to pending
 *   import   — Scan decision artifacts and create suggestions for retryable rounds
 *   stats    — Show suggestion backlog statistics
 *
 * Usage:
 *   node lib/hydra-evolve-suggestions-cli.mjs
 *   node lib/hydra-evolve-suggestions-cli.mjs list status=all
 *   node lib/hydra-evolve-suggestions-cli.mjs add title="..." area=testing-reliability
 *   node lib/hydra-evolve-suggestions-cli.mjs remove SUG_003
 *   node lib/hydra-evolve-suggestions-cli.mjs reset SUG_003
 *   node lib/hydra-evolve-suggestions-cli.mjs import
 *   node lib/hydra-evolve-suggestions-cli.mjs stats
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import { parseArgs } from './hydra-utils.ts';
import {
  loadSuggestions,
  saveSuggestions,
  addSuggestion,
  updateSuggestion,
  removeSuggestion,
  getPendingSuggestions,
  getSuggestionById,
  searchSuggestions,
  getSuggestionStats,
} from './hydra-evolve-suggestions.ts';
import { type SuggestionEntry } from './hydra-evolve-suggestions.ts';
import pc from 'picocolors';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
}

function askQuestion(
  rl: ReturnType<typeof readline.createInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

function formatEntry(s: SuggestionEntry) {
  let statusColor: (s: string) => string;
  if (s.status === 'pending') statusColor = pc.cyan;
  else if (s.status === 'completed') statusColor = pc.green;
  else if (s.status === 'rejected') statusColor = pc.red;
  else if (s.status === 'exploring') statusColor = pc.yellow;
  else statusColor = pc.dim;

  let priorityBadge: string;
  if (s.priority === 'high') priorityBadge = pc.red('HIGH');
  else if (s.priority === 'low') priorityBadge = pc.dim('low');
  else priorityBadge = pc.yellow('med');

  console.log(
    `  ${statusColor(s.id ?? '')} ${pc.yellow(s.area ?? '')}: ${(s.title ?? '').slice(0, 80)}`,
  );

  const parts = [`status: ${statusColor(s.status ?? '')}`, `priority: ${priorityBadge}`];
  if ((s.attempts ?? 0) > 0) {
    parts.push(`attempts: ${String(s.attempts ?? 0)}/${String(s.maxAttempts ?? 0)}`);
    if (s.lastAttemptScore != null) parts.push(`last: ${String(s.lastAttemptScore)}/10`);
  }
  if (s.specPath) parts.push('has spec');
  if (s.source) parts.push(`source: ${s.source}`);
  console.log(`    ${pc.dim(parts.join(' | '))}`);

  if (s.notes) {
    const noteLines = s.notes.split('\n').filter(Boolean);
    for (const line of noteLines.slice(0, 2)) {
      console.log(`    ${pc.dim(line.slice(0, 100))}`);
    }
  }
  console.log('');
}

// ── List Command ────────────────────────────────────────────────────────────

function listCommand(evolveDir: string, options: Record<string, string | boolean>) {
  const sg = loadSuggestions(evolveDir);
  const statusFilter = (options['status'] as string) || null;
  const areaFilter = (options['area'] as string) || undefined;
  const query = (options['query'] as string) || undefined;

  let entries;
  if (statusFilter === 'all') {
    entries = searchSuggestions(sg, query, { area: areaFilter });
  } else if (statusFilter) {
    entries = searchSuggestions(sg, query, { status: statusFilter, area: areaFilter });
  } else {
    entries =
      query || areaFilter
        ? searchSuggestions(sg, query, { status: 'pending', area: areaFilter })
        : getPendingSuggestions(sg);
  }

  const label = statusFilter === 'all' ? 'all' : statusFilter ?? 'pending';
  console.log(pc.bold(`\nSuggestions — ${String(entries.length)} ${label}\n`));

  if (entries.length === 0) {
    console.log(pc.dim('  No suggestions found.'));
    console.log('');
    return;
  }

  for (const s of entries) {
    formatEntry(s);
  }
}

// ── Add Command ─────────────────────────────────────────────────────────────

async function addCommand(evolveDir: string, options: Record<string, string | boolean>) {
  const sg = loadSuggestions(evolveDir);
  let title = (options['title'] as string) || '';
  let area = (options['area'] as string) || '';
  let description = (options['description'] as string) || '';
  let priority = (options['priority'] as string) || 'medium';

  // Interactive mode if title not provided
  if (!title) {
    const cfg = loadHydraConfig();
    const focusAreas = cfg.evolve?.focusAreas ?? [];

    const rl = createRL();
    try {
      title = await askQuestion(rl, pc.cyan('  Title: '));
      if (!title) {
        console.log(pc.yellow('  Cancelled — no title provided.'));
        return;
      }

      if (focusAreas.length > 0) {
        console.log(pc.dim(`  Areas: ${focusAreas.join(', ')}`));
      }
      area = await askQuestion(rl, pc.cyan('  Area: '));
      description = await askQuestion(rl, pc.cyan('  Description (optional): '));
      const p = await askQuestion(rl, pc.cyan('  Priority [high/medium/low]: '));
      if (['high', 'medium', 'low'].includes(p)) priority = p;
    } finally {
      rl.close();
    }
  }

  if (!area) area = 'general';
  if (!description) description = title;

  const created = addSuggestion(sg, {
    source: 'user:manual',
    area,
    title,
    description,
    priority,
    tags: [area, 'user-submitted'],
  });

  if (created) {
    saveSuggestions(evolveDir, sg);
    console.log(pc.green(`\n  + Created: ${created.id ?? ''} — ${created.title ?? ''}`));
  } else {
    console.log(pc.yellow('\n  Similar suggestion already exists.'));
  }
  console.log('');
}

// ── Remove Command ──────────────────────────────────────────────────────────

function removeCommand(
  evolveDir: string,
  options: Record<string, string | boolean>,
  positionals: string[],
) {
  const id = positionals[1] || (options['id'] as string);
  if (!id) {
    console.error(pc.red('  Usage: remove <SUG_ID>'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const entry = getSuggestionById(sg, id);
  if (!entry) {
    console.error(pc.red(`  Suggestion ${id} not found.`));
    return;
  }

  removeSuggestion(sg, id);
  saveSuggestions(evolveDir, sg);
  console.log(pc.yellow(`  ${id} marked as abandoned: ${(entry.title ?? '').slice(0, 60)}`));
}

// ── Reset Command ───────────────────────────────────────────────────────────

function resetCommand(
  evolveDir: string,
  options: Record<string, string | boolean>,
  positionals: string[],
) {
  const id = positionals[1] || (options['id'] as string);
  if (!id) {
    console.error(pc.red('  Usage: reset <SUG_ID>'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const entry = getSuggestionById(sg, id);
  if (!entry) {
    console.error(pc.red(`  Suggestion ${id} not found.`));
    return;
  }

  updateSuggestion(sg, id, {
    status: 'pending',
    attempts: 0,
    lastAttemptDate: null,
    lastAttemptVerdict: null,
    lastAttemptScore: null,
    lastAttemptLearnings: null,
  });
  saveSuggestions(evolveDir, sg);
  console.log(pc.green(`  ${id} reset to pending: ${(entry.title ?? '').slice(0, 60)}`));
}

// ── Import Command ──────────────────────────────────────────────────────────

function importCommand(evolveDir: string) {
  const decisionsDir = path.join(evolveDir, 'decisions');
  const specsDir = path.join(evolveDir, 'specs');

  if (!fs.existsSync(decisionsDir)) {
    console.log(pc.yellow('  No decisions directory found.'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const files = fs.readdirSync(decisionsDir).filter((f) => f.match(/^ROUND_\d+_DECISION\.json$/));
  let created = 0;

  for (const file of files) {
    try {
      const decision = JSON.parse(fs.readFileSync(path.join(decisionsDir, file), 'utf8'));
      // Only import rejected rounds with valid improvement text
      if (
        (decision.verdict === 'reject' || decision.verdict === 'revise') &&
        decision.improvement &&
        decision.improvement !== 'No improvement selected' &&
        decision.improvement.length >= 10
      ) {
        const roundNum = file.match(/ROUND_(\d+)/)?.[1];
        const specPath = roundNum ? path.join(specsDir, `ROUND_${roundNum}_SPEC.md`) : null;
        const hasSpec = specPath && fs.existsSync(specPath);

        const entry = addSuggestion(sg, {
          source: 'auto:rejected-round',
          sourceRef: String(decision.branchName ?? file),
          area: decision.area ?? 'general',
          title: decision.improvement.slice(0, 100),
          description: decision.improvement,
          specPath: hasSpec ? specPath : null,
          priority: decision.score >= 5 ? 'high' : 'medium',
          tags: [decision.area, 'imported', decision.verdict].filter(Boolean),
          notes:
            `Imported from ${file}. Score: ${String(decision.score as number)}/10. ${(decision.reason as string | undefined) ?? ''}`.trim(),
        });

        if (entry) {
          created++;
          console.log(pc.green(`  + ${entry.id ?? ''}: ${(entry.title ?? '').slice(0, 70)}`));
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  if (created > 0) {
    saveSuggestions(evolveDir, sg);
    console.log(pc.bold(`\n  Imported ${String(created)} suggestion(s).`));
  } else {
    console.log(
      pc.dim('  No new suggestions to import (all already exist or no retryable rounds).'),
    );
  }
  console.log('');
}

// ── Stats Command ───────────────────────────────────────────────────────────

function statsCommand(evolveDir: string) {
  const sg = loadSuggestions(evolveDir);
  const stats = getSuggestionStats(sg);

  console.log(pc.bold('\nSuggestions Backlog Stats\n'));
  console.log(`  Total entries:  ${String(sg.entries.length)}`);
  console.log(`  Pending:        ${pc.cyan(String(stats.totalPending))}`);
  console.log(`  Exploring:      ${pc.yellow(String(stats.totalExploring || 0))}`);
  console.log(`  Completed:      ${pc.green(String(stats.totalCompleted))}`);
  console.log(`  Rejected:       ${pc.red(String(stats.totalRejected))}`);
  console.log(`  Abandoned:      ${pc.dim(String(stats.totalAbandoned))}`);

  // Area breakdown
  const areas: Record<string, number> = {};
  for (const e of sg.entries.filter((entry: SuggestionEntry) => entry.status === 'pending')) {
    const area = e.area ?? 'unknown';
    areas[area] = (areas[area] ?? 0) + 1;
  }
  if (Object.keys(areas).length > 0) {
    console.log(pc.bold('\n  Pending by area:'));
    for (const [area, count] of Object.entries(areas).sort(
      (a: [string, number], b: [string, number]) => b[1] - a[1],
    )) {
      console.log(`    ${pc.yellow(area)}: ${String(count)}`);
    }
  }

  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const command = positionals[0] || 'list';

  let config: ReturnType<typeof resolveProject> | undefined;
  try {
    config = resolveProject({ project: options['project'] as string });
  } catch (err: unknown) {
    console.error(
      pc.red(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exitCode = 1;
    return;
  }

  const { projectRoot } = config;
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');

  switch (command) {
    case 'list':
      listCommand(evolveDir, options);
      break;
    case 'add':
      await addCommand(evolveDir, options);
      break;
    case 'remove':
      removeCommand(evolveDir, options, positionals);
      break;
    case 'reset':
      resetCommand(evolveDir, options, positionals);
      break;
    case 'import':
      importCommand(evolveDir);
      break;
    case 'stats':
      statsCommand(evolveDir);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-evolve-suggestions-cli.mjs [list|add|remove|reset|import|stats]');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
