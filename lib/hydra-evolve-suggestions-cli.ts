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

function getStatusColor(status: string | undefined): (s: string) => string {
  if (status === 'pending') return pc.cyan;
  if (status === 'completed') return pc.green;
  if (status === 'rejected') return pc.red;
  if (status === 'exploring') return pc.yellow;
  return pc.dim;
}

function getPriorityBadge(priority: string | undefined): string {
  if (priority === 'high') return pc.red('HIGH');
  if (priority === 'low') return pc.dim('low');
  return pc.yellow('med');
}

function buildEntryParts(s: SuggestionEntry): string[] {
  const statusColor = getStatusColor(s.status);
  const priorityBadge = getPriorityBadge(s.priority);
  const parts = [`status: ${statusColor(s.status ?? '')}`, `priority: ${priorityBadge}`];
  if ((s.attempts ?? 0) > 0) {
    parts.push(`attempts: ${String(s.attempts ?? 0)}/${String(s.maxAttempts ?? 0)}`);
    if (s.lastAttemptScore != null) parts.push(`last: ${String(s.lastAttemptScore)}/10`);
  }
  if (s.specPath != null && s.specPath !== '') parts.push('has spec');
  if (s.source != null && s.source !== '') parts.push(`source: ${s.source}`);
  return parts;
}

function formatEntry(s: SuggestionEntry) {
  const statusColor = getStatusColor(s.status);

  console.log(
    `  ${statusColor(s.id ?? '')} ${pc.yellow(s.area ?? '')}: ${(s.title ?? '').slice(0, 80)}`,
  );
  console.log(`    ${pc.dim(buildEntryParts(s).join(' | '))}`);

  if (s.notes != null && s.notes !== '') {
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
  const statusVal = options['status'] as string | undefined;
  const statusFilter = statusVal != null && statusVal !== '' ? statusVal : null;
  const areaVal = options['area'] as string | undefined;
  const areaFilter = areaVal != null && areaVal !== '' ? areaVal : undefined;
  const queryVal = options['query'] as string | undefined;
  const query = queryVal != null && queryVal !== '' ? queryVal : undefined;

  let entries;
  if (statusFilter === 'all') {
    entries = searchSuggestions(sg, query, { area: areaFilter });
  } else if (statusFilter === null) {
    entries =
      query !== undefined || areaFilter !== undefined
        ? searchSuggestions(sg, query, { status: 'pending', area: areaFilter })
        : getPendingSuggestions(sg);
  } else {
    entries = searchSuggestions(sg, query, { status: statusFilter, area: areaFilter });
  }

  const label = statusFilter === 'all' ? 'all' : (statusFilter ?? 'pending');
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

async function collectInteractiveInput(): Promise<{
  title: string;
  area: string;
  description: string;
  priority: string;
} | null> {
  const cfg = loadHydraConfig();
  const focusAreas = cfg.evolve?.focusAreas ?? [];

  const rl = createRL();
  try {
    const title = await askQuestion(rl, pc.cyan('  Title: '));
    if (title === '') {
      console.log(pc.yellow('  Cancelled — no title provided.'));
      return null;
    }

    if (focusAreas.length > 0) {
      console.log(pc.dim(`  Areas: ${focusAreas.join(', ')}`));
    }
    const area = await askQuestion(rl, pc.cyan('  Area: '));
    const description = await askQuestion(rl, pc.cyan('  Description (optional): '));
    const p = await askQuestion(rl, pc.cyan('  Priority [high/medium/low]: '));
    const priority = ['high', 'medium', 'low'].includes(p) ? p : 'medium';
    return { title, area, description, priority };
  } finally {
    rl.close();
  }
}

async function addCommand(evolveDir: string, options: Record<string, string | boolean>) {
  const sg = loadSuggestions(evolveDir);
  let title = (options['title'] as string | undefined) ?? '';
  let area = (options['area'] as string | undefined) ?? '';
  let description = (options['description'] as string | undefined) ?? '';
  let priority = (options['priority'] as string | undefined) ?? 'medium';

  if (title === '') {
    const input = await collectInteractiveInput();
    if (input == null) return;
    title = input.title;
    area = input.area;
    description = input.description;
    priority = input.priority;
  }

  if (area === '') area = 'general';
  if (description === '') description = title;

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

function resolveIdArg(options: Record<string, string | boolean>, positionals: string[]): string {
  const positional = positionals[1];
  if (positional !== '') return positional;
  const optId = options['id'] as string | undefined;
  return optId !== undefined && optId !== '' ? optId : '';
}

function removeCommand(
  evolveDir: string,
  options: Record<string, string | boolean>,
  positionals: string[],
) {
  const id = resolveIdArg(options, positionals);
  if (id === '') {
    console.error(pc.red('  Usage: remove <SUG_ID>'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const entry = getSuggestionById(sg, id);
  if (entry == null) {
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
  const id = resolveIdArg(options, positionals);
  if (id === '') {
    console.error(pc.red('  Usage: reset <SUG_ID>'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const entry = getSuggestionById(sg, id);
  if (entry == null) {
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

interface DecisionArtifact {
  verdict?: string;
  improvement?: string;
  branchName?: string;
  area?: string;
  score?: number;
  reason?: string;
}

function isRetryableDecision(raw: DecisionArtifact): boolean {
  return (
    (raw.verdict === 'reject' || raw.verdict === 'revise') &&
    raw.improvement != null &&
    raw.improvement !== 'No improvement selected' &&
    raw.improvement.length >= 10
  );
}

function buildSuggestionFromDecision(
  raw: DecisionArtifact,
  file: string,
  specPath: string | null,
  hasSpec: boolean,
): Parameters<typeof addSuggestion>[1] {
  return {
    source: 'auto:rejected-round',
    sourceRef: raw.branchName ?? file,
    area: raw.area ?? 'general',
    title: (raw.improvement ?? '').slice(0, 100),
    description: raw.improvement ?? '',
    specPath: hasSpec ? specPath : null,
    priority: (raw.score ?? 0) >= 5 ? 'high' : 'medium',
    tags: [raw.area ?? '', 'imported', raw.verdict].filter(
      (t): t is string => t != null && t !== '',
    ),
    notes: `Imported from ${file}. Score: ${String(raw.score ?? 0)}/10. ${raw.reason ?? ''}`.trim(),
  };
}

function processDecisionFile(
  file: string,
  decisionsDir: string,
  specsDir: string,
  sg: ReturnType<typeof loadSuggestions>,
): boolean {
  const raw = JSON.parse(
    fs.readFileSync(path.join(decisionsDir, file), 'utf8'),
  ) as DecisionArtifact;
  if (!isRetryableDecision(raw)) return false;

  const roundNum = file.match(/ROUND_(\d+)/)?.[1];
  const specPath = roundNum === undefined ? null : path.join(specsDir, `ROUND_${roundNum}_SPEC.md`);
  const hasSpec = specPath !== null && fs.existsSync(specPath);

  const entry = addSuggestion(sg, buildSuggestionFromDecision(raw, file, specPath, hasSpec));

  if (entry != null) {
    console.log(pc.green(`  + ${entry.id ?? ''}: ${(entry.title ?? '').slice(0, 70)}`));
    return true;
  }
  return false;
}

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
      if (processDecisionFile(file, decisionsDir, specsDir, sg)) {
        created++;
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
  console.log(`  Exploring:      ${pc.yellow(String(stats.totalExploring))}`);
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
  const positionalZero = positionals[0];
  const command = positionals.length > 0 && positionalZero !== '' ? positionalZero : 'list';

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
