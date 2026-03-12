/**
 * Hydra Nightly Runner — Autonomous, config-driven task execution pipeline.
 *
 * 6-phase pipeline:
 *   1. SCAN       — Aggregate tasks from TODO comments, TODO.md, GitHub issues, config
 *   2. DISCOVER   — (Optional) AI agent suggests improvement tasks
 *   3. PRIORITIZE — Deduplicate, sort by priority/complexity, cap at maxTasks
 *   4. SELECT     — (Optional, --interactive) Interactive task selection & confirmation
 *   5. EXECUTE    — Per-task: branch → classify → dispatch agent → verify → violations
 *   6. REPORT     — Generate JSON + Markdown morning reports
 *
 * Project-agnostic: works for any repo with hydra.config.json.
 * Uses intelligent agent routing, model recovery, investigator self-healing,
 * and budget-aware handoff. EXECUTE phase shows a live progress dashboard.
 *
 * Usage:
 *   node lib/hydra-nightly.mjs                             # defaults from config
 *   node lib/hydra-nightly.mjs project=/path/to/YourProject # explicit project
 *   node lib/hydra-nightly.mjs max-tasks=3 max-hours=2     # override limits
 *   node lib/hydra-nightly.mjs --no-discovery              # skip AI discovery
 *   node lib/hydra-nightly.mjs --dry-run                   # scan + prioritize only
 *   node lib/hydra-nightly.mjs --interactive               # interactive task selection
 */

import './hydra-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';

import { loadHydraConfig, resolveProject } from './hydra-config.ts';
import { initAgentRegistry, classifyTask, bestAgentFor, getActiveModel } from './hydra-agents.ts';
import { parseArgs, ensureDir, runProcess } from './hydra-utils.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.ts';
import { getAgentInstructionFile } from './hydra-sync-md.ts';
import { BudgetTracker } from './hydra-shared/budget-tracker.ts';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.ts';
import { compactProgressBar, AGENT_COLORS, AGENT_ICONS as _AGENT_ICONS } from './hydra-ui.ts';
import {
  buildSafetyPrompt,
  verifyBranch,
  isCleanWorkingTree,
  scanBranchViolations,
} from './hydra-shared/guardrails.ts';
import {
  git,
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  branchExists,
  getBranchStats,
} from './hydra-shared/git-ops.ts';
import {
  BASE_PROTECTED_FILES,
  BASE_PROTECTED_PATTERNS,
  BLOCKED_COMMANDS,
} from './hydra-shared/constants.ts';
import {
  scanAllSources,
  createUserTask,
  deduplicateTasks,
  prioritizeTasks,
  taskToSlug as _taskToSlug,
  type ScannedTask,
} from './hydra-tasks-scanner.ts';
import { runDiscovery } from './hydra-nightly-discovery.ts';
import type { NightlyConfig } from './types.ts';

// ── Local interfaces ─────────────────────────────────────────────────────────

interface NightlyTaskResult {
  slug: string;
  title: string;
  branch: string;
  source: string;
  taskType: string;
  status: string;
  agent: string;
  tokensUsed: number;
  durationMs: number;
  commits: number;
  filesChanged: number;
  verification: string;
  violations: Array<{ severity: string; detail: string }>;
  error?: string;
}

interface BudgetSummary {
  consumed: number;
  hardLimit: number;
  avgPerTask?: number;
  taskDeltas?: Array<{ label: string; tokens: number; durationMs: number }>;
  [key: string]: unknown;
}

interface RunMeta {
  startedAt: number;
  finishedAt: number;
  date: string;
  baseBranch: string;
  sources?: Record<string, number>;
  totalTasks: number;
  processedTasks: number;
  stopReason?: string | null;
  [key: string]: unknown;
}

interface InvestigatorModule {
  investigate?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
}

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok: (msg: string) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg: string) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  task: (msg: string) => process.stderr.write(`\n${pc.bold(pc.cyan('>'))} ${pc.bold(msg)}\n`),
  dim: (msg: string) => process.stderr.write(`  ${pc.dim(msg)}\n`),
  phase: (name: string) => process.stderr.write(`\n${pc.bold(pc.magenta(`[${name}]`))}\n`),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${String(mins)}m ${String(remSecs)}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${String(hrs)}h ${String(remMins)}m`;
}

// ── Budget Thresholds ───────────────────────────────────────────────────────

function buildThresholds(budgetCfg: Record<string, unknown>) {
  return [
    { pct: 0.95, action: 'hard_stop', reason: 'Hard limit reached: {pct}% of budget used' },
    {
      pct: 0.85,
      action: 'soft_stop',
      reason: 'Soft limit reached: {pct}% budget ({consumed} tokens)',
    },
    {
      pct: (budgetCfg['handoffThreshold'] as number | undefined) ?? 0.7,
      action: 'handoff',
      reason: '{pct}% budget — handing remaining tasks to handoff agent',
      once: true,
    },
    { pct: 0.5, action: 'warn', reason: '{pct}% budget used ({consumed} tokens)' },
  ];
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildTaskPrompt(
  task: ScannedTask,
  branchName: string,
  projectRoot: string,
  agent: string,
  opts: { isHandoff?: boolean } = {},
) {
  const instructionFile = getAgentInstructionFile(agent, projectRoot);
  const safetyBlock = buildSafetyPrompt(branchName, {
    runner: 'nightly runner',
    reportName: 'morning report',
    protectedFiles: new Set(BASE_PROTECTED_FILES),
    blockedCommands: BLOCKED_COMMANDS,
    attribution: { pipeline: 'hydra-nightly', agent },
  });

  const bodySection = task.body == null ? '' : `\n## Details\n${task.body}\n`;

  const sourceNote =
    task.sourceRef.length > 0
      ? `**Source:** ${task.source} (${task.sourceRef})`
      : `**Source:** ${task.source}`;

  const handoffNote =
    opts.isHandoff === true
      ? `\n## Context\nYou are taking over from a previous agent to conserve budget. Be efficient.\n`
      : '';

  return `# Nightly Autonomous Task

**Task:** ${task.title}
**Branch:** \`${branchName}\` (already checked out)
**Project:** ${projectRoot}
${sourceNote}
${handoffNote}
## Instructions
1. Read the project's ${instructionFile} for conventions and patterns
2. Read relevant source files to understand the codebase
3. Implement the task with focused, minimal changes
4. Commit your work with a descriptive message
5. Run verification and fix any issues you introduce
${bodySection}
${safetyBlock}

## Begin
Start working on the task now.`;
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot: string) {
  const plan = resolveVerificationPlan(projectRoot);
  if (!plan.enabled) {
    return { ran: false, passed: true, command: '', output: '' };
  }

  log.dim(`Verifying: ${plan.command}`);
  const parts = plan.command.split(' ');
  const result = runProcess(parts[0], parts.slice(1), plan.timeoutMs, { cwd: projectRoot });

  return {
    ran: true,
    passed: result.ok,
    command: plan.command,
    output: result.stdout.slice(-2000) + result.stderr.slice(-1000),
  };
}

// ── Investigator (lazy-load) ────────────────────────────────────────────────

let _investigator: InvestigatorModule | null = null;
async function getInvestigator() {
  if (_investigator !== null) return _investigator;
  try {
    // eslint-disable-next-line require-atomic-updates -- singleton initialization; no real race condition
    _investigator = (await import('./hydra-investigator.ts')) as InvestigatorModule;
    return _investigator;
  } catch {
    return null;
  }
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReportJSON(
  results: NightlyTaskResult[],
  budgetSummary: BudgetSummary,
  runMeta: RunMeta,
) {
  return {
    ...runMeta,
    budget: budgetSummary,
    results: results.map((r) => ({
      slug: r.slug,
      title: r.title,
      branch: r.branch,
      source: r.source,
      taskType: r.taskType,
      status: r.status,
      agent: r.agent,
      tokensUsed: r.tokensUsed,
      durationMs: r.durationMs,
      commits: r.commits,
      filesChanged: r.filesChanged,
      verification: r.verification,
      violations: r.violations,
    })),
  };
}

function generateReportMd(
  results: NightlyTaskResult[],
  budgetSummary: BudgetSummary,
  runMeta: RunMeta,
) {
  const {
    startedAt,
    finishedAt,
    date,
    baseBranch,
    sources,
    totalTasks,
    processedTasks,
    stopReason,
  } = runMeta;

  const startStr = new Date(startedAt).toLocaleTimeString('en-US', { hour12: false });
  const endStr = new Date(finishedAt).toLocaleTimeString('en-US', { hour12: false });
  const durationStr = formatDuration(finishedAt - startedAt);
  const tokensStr = `~${budgetSummary.consumed.toLocaleString()}`;

  const sourceSummary = Object.entries(sources ?? {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');

  const lines = [
    `# Nightly Run - ${date}`,
    `Started: ${startStr} | Finished: ${endStr} | Duration: ${durationStr}`,
    `Tasks: ${String(processedTasks)}/${String(totalTasks)} processed${
      stopReason == null ? '' : ` (stopped: ${stopReason})`
    } | Tokens: ${tokensStr}`,
    `Base branch: ${baseBranch} | Sources: ${sourceSummary.length > 0 ? sourceSummary : 'n/a'}`,
    '',
    '## Results',
  ];

  for (const [i, r] of results.entries()) {
    const tokenNote = r.tokensUsed > 0 ? ` - ~${r.tokensUsed.toLocaleString()} tokens` : '';
    const statusTag = r.status.toUpperCase();
    const agentNote = ` (${r.agent})`;

    lines.push(`### ${String(i + 1)}. ${r.slug} [${statusTag}]${tokenNote}${agentNote}`);
    lines.push(`- Branch: \`${r.branch}\``);
    lines.push(`- Source: ${r.source} | Type: ${r.taskType}`);
    lines.push(
      `- Commits: ${String(r.commits)} | Files: ${String(r.filesChanged)} | Verification: ${r.verification}`,
    );
    if (r.violations.length > 0) {
      lines.push(`- **Violations:** ${String(r.violations.length)}`);
      for (const v of r.violations) {
        lines.push(`  - [${v.severity}] ${v.detail}`);
      }
    }
    lines.push(`- Duration: ${formatDuration(r.durationMs)}`);
    lines.push(`- Review: \`git log ${baseBranch}..${r.branch} --oneline\``);
    lines.push('');
  }

  lines.push('## Quick Commands');
  lines.push('```');
  lines.push(`git branch --list "nightly/${date}/*"    # list branches`);
  lines.push(`git diff ${baseBranch}...nightly/${date}/<slug>     # review changes`);
  lines.push('npm run nightly:review                    # interactive merge');
  lines.push('npm run nightly:clean                     # delete all nightly branches');
  lines.push('```');
  lines.push('');
  lines.push('## Budget Summary');
  lines.push(
    `- Consumed: ${budgetSummary.consumed.toLocaleString()} of ${budgetSummary.hardLimit.toLocaleString()} limit`,
  );
  lines.push(`- Avg per task: ${(budgetSummary.avgPerTask ?? 0).toLocaleString()}`);
  if ((budgetSummary.taskDeltas?.length ?? 0) > 0) {
    lines.push('');
    lines.push('| Task | Tokens | Duration |');
    lines.push('|------|--------|----------|');
    for (const d of budgetSummary.taskDeltas) {
      lines.push(`| ${d.label} | ${d.tokens.toLocaleString()} | ${formatDuration(d.durationMs)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ── Phase 1: SCAN ───────────────────────────────────────────────────────────

function phaseScan(projectRoot: string, nightlyCfg: NightlyConfig) {
  log.phase('SCAN');
  const sources = nightlyCfg.sources ?? {};
  const sourceCounts: Record<string, number> = {};

  // Multi-source scan via tasks-scanner
  const scanned = scanAllSources(projectRoot, {
    todoComments: sources['todoComments'] as boolean | undefined,
    todoMd: sources['todoMd'] as boolean | undefined,
    githubIssues: sources['githubIssues'] as boolean | undefined,
  });

  // Count by source type
  for (const t of scanned) {
    sourceCounts[t.source] = (sourceCounts[t.source] ?? 0) + 1;
  }

  // Config-defined static tasks
  const configTasks: ScannedTask[] = [];
  if (sources['configTasks'] === true && (nightlyCfg.tasks?.length ?? 0) > 0) {
    for (const text of nightlyCfg.tasks ?? []) {
      configTasks.push(createUserTask(String(text)));
    }
    sourceCounts['config'] = configTasks.length;
  }

  const allTasks = [...scanned, ...configTasks];
  log.info(
    `Scanned ${String(allTasks.length)} tasks from ${String(Object.keys(sourceCounts).length)} source(s)`,
  );
  for (const [src, count] of Object.entries(sourceCounts)) {
    log.dim(`  ${src}: ${String(count)}`);
  }

  return { tasks: allTasks, sourceCounts };
}

// ── Phase 2: DISCOVER ───────────────────────────────────────────────────────

async function phaseDiscover(
  projectRoot: string,
  existingTasks: ScannedTask[],
  nightlyCfg: NightlyConfig,
) {
  if (nightlyCfg.sources?.['aiDiscovery'] !== true) {
    log.dim('AI discovery: disabled');
    return [];
  }

  log.phase('DISCOVER');
  const discoveryCfg = nightlyCfg.aiDiscovery ?? {};

  const discovered = await runDiscovery(projectRoot, {
    agent: discoveryCfg.agent,
    maxSuggestions: discoveryCfg.maxSuggestions,
    focus: discoveryCfg.focus,
    timeoutMs: discoveryCfg.timeoutMs,
    existingTasks: existingTasks.map((t) => t.title),
  });

  return discovered;
}

// ── Phase 3: PRIORITIZE ─────────────────────────────────────────────────────

function phasePrioritize(allTasks: ScannedTask[], maxTasks: number) {
  log.phase('PRIORITIZE');
  const deduped = deduplicateTasks(allTasks);
  const sorted = prioritizeTasks(deduped);
  const selected = sorted.slice(0, maxTasks);

  log.info(
    `${String(allTasks.length)} total -> ${String(deduped.length)} deduped -> ${String(selected.length)} selected`,
  );
  for (const t of selected) {
    let prioColor;
    if (t.priority === 'high') {
      prioColor = pc.red;
    } else if (t.priority === 'low') {
      prioColor = pc.dim;
    } else {
      prioColor = pc.yellow;
    }
    log.dim(`  ${prioColor(t.priority.padEnd(6))} [${t.source}] ${t.title}`);
  }

  return selected;
}

// ── Phase 3b: SELECT (interactive) ─────────────────────────────────────────

const SOURCE_ORDER = ['todo-md', 'todo-comment', 'github-issue', 'config', 'ai-discovery'];

function sourceRank(source: string) {
  const idx = SOURCE_ORDER.indexOf(source);
  return idx >= 0 ? idx : SOURCE_ORDER.length;
}

function askLine(rl: readline.Interface, question: string) {
  return new Promise<string>((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

async function phaseSelect(sortedTasks: ScannedTask[], maxTasks: number) {
  log.phase('SELECT');

  if (sortedTasks.length === 0) {
    log.warn('No tasks found to select from.');
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const recommended = sortedTasks.slice(0, maxTasks);

    // Display all tasks grouped by source
    const grouped = new Map<string, ScannedTask[]>();
    for (const t of sortedTasks) {
      const src = t.source;
      if (!grouped.has(src)) grouped.set(src, []);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- just set above
      grouped.get(src)!.push(t);
    }

    // Sort groups by SOURCE_ORDER
    const sortedGroups = [...grouped.entries()].sort((a, b) => sourceRank(a[0]) - sourceRank(b[0]));

    // Display numbered list
    let globalIdx = 0;
    const indexMap = new Map<number, ScannedTask>(); // globalIdx -> task
    const recommendedSet = new Set(recommended);

    process.stderr.write('\n');
    for (const [source, tasks] of sortedGroups) {
      process.stderr.write(`  ${pc.bold(pc.blue(source))} (${String(tasks.length)})\n`);
      for (const t of tasks) {
        globalIdx++;
        indexMap.set(globalIdx, t);
        const marker = recommendedSet.has(t) ? pc.green('*') : ' ';
        let prioColor;
        if (t.priority === 'high') {
          prioColor = pc.red;
        } else if (t.priority === 'low') {
          prioColor = pc.dim;
        } else {
          prioColor = pc.yellow;
        }
        const num = String(globalIdx).padStart(3);
        const agent = t.suggestedAgent === '' ? 'auto' : t.suggestedAgent;
        process.stderr.write(
          `  ${marker}${pc.bold(num)}. ${prioColor(t.priority.padEnd(6))} ${t.title} ${pc.dim(`[${agent}]`)}\n`,
        );
      }
      process.stderr.write('\n');
    }

    process.stderr.write(pc.dim(`  * = recommended (top ${String(recommended.length)})\n\n`));

    // Initial action prompt
    process.stderr.write(pc.dim(`  Options:\n`));
    process.stderr.write(
      pc.dim(`    Enter        Accept recommended ${String(recommended.length)} tasks\n`),
    );
    process.stderr.write(pc.dim(`    1,3,5        Pick specific tasks by number\n`));
    process.stderr.write(
      pc.dim(`    all          Select all ${String(sortedTasks.length)} tasks\n`),
    );
    process.stderr.write(pc.dim(`    add          Add a custom freeform task\n`));
    process.stderr.write(pc.dim(`    q            Cancel nightly run\n\n`));

    const answer = await askLine(rl, pc.bold('  Select tasks: '));

    let selected: ScannedTask[];
    if (answer === '') {
      // Accept recommended
      selected = [...recommended];
      log.ok(`Accepted ${String(selected.length)} recommended tasks`);
    } else if (answer === 'q' || answer === 'quit') {
      rl.close();
      return null;
    } else if (answer === 'all') {
      selected = [...sortedTasks];
      log.ok(`Selected all ${String(selected.length)} tasks`);
    } else if (answer === 'add') {
      selected = [];
      let adding = true;
      while (adding) {
        // eslint-disable-next-line no-await-in-loop -- interactive readline; sequential by design
        const text = await askLine(rl, '  Enter task description (empty to stop): ');
        if (text.length > 0) {
          selected.push(createUserTask(text));
          log.ok(`Added: ${text}`);
        } else {
          adding = false;
        }
      }
      if (selected.length === 0) {
        rl.close();
        return null;
      }
    } else {
      // Parse comma-separated numbers
      const indices = answer
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((i) => i >= 1 && indexMap.has(i));

      if (indices.length === 0) {
        log.warn('No valid selections.');
        rl.close();
        return null;
      }
      selected = indices.map((i) => indexMap.get(i) as ScannedTask);
      log.ok(`Selected ${String(selected.length)} task(s)`);
    }

    // Offer to add more freeform tasks
    const addMore = await askLine(rl, pc.dim('  Add custom tasks? (y/N): '));
    if (addMore === 'y' || addMore === 'yes') {
      let adding = true;
      while (adding) {
        // eslint-disable-next-line no-await-in-loop -- interactive readline; sequential by design
        const text = await askLine(rl, '  Enter task description (empty to stop): ');
        if (text.length > 0) {
          selected.push(createUserTask(text));
          log.ok(`Added: ${text}`);
        } else {
          adding = false;
        }
      }
    }

    // Show final selection summary
    process.stderr.write(`\n  ${pc.bold('Final selection')} (${String(selected.length)} tasks):\n`);
    for (const [i, t] of selected.entries()) {
      const agent = t.suggestedAgent === '' ? 'auto' : t.suggestedAgent;
      process.stderr.write(
        `    ${pc.bold(String(i + 1).padStart(2))}. ${t.title} ${pc.dim(`[${t.source}] → ${agent}`)}\n`,
      );
    }
    process.stderr.write('\n');

    const confirm = await askLine(rl, pc.bold('  Proceed? (Y/n): '));
    if (confirm === 'n' || confirm === 'no') {
      rl.close();
      return null;
    }

    rl.close();
    return selected;
  } catch (err) {
    rl.close();
    log.error(`Selection error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Progress Dashboard ─────────────────────────────────────────────────────

const STATUS_ICONS = {
  pending: pc.dim('[ ]'),
  running: pc.bold(pc.cyan('[~]')),
  success: pc.green('[+]'),
  error: pc.red('[x]'),
  skipped: pc.yellow('[-]'),
  timeout: pc.yellow('[!]'),
  partial: pc.yellow('[~]'),
};

function getAgentColor(agent: string): ((str: string) => string) | undefined {
  return (AGENT_COLORS as Record<string, ((str: string) => string) | undefined>)[agent];
}

function truncate(str: string, maxLen: number) {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}\u2026`;
}

function renderProgress(
  tasks: ScannedTask[],
  results: NightlyTaskResult[],
  budget: BudgetTracker,
  startedAt: number,
  maxHoursMs: number,
  currentIdx: number,
) {
  const lines = [];
  const elapsed = Date.now() - startedAt;
  const elapsedStr = formatDuration(elapsed);
  const maxStr = formatDuration(maxHoursMs);

  lines.push('');
  lines.push(`  ${pc.bold('Task Progress:')}`);

  for (const [i, t] of tasks.entries()) {
    const r = results[i] as NightlyTaskResult | undefined; // undefined if not yet processed
    const agent = r?.agent ?? (t.suggestedAgent === '' ? 'auto' : t.suggestedAgent);
    const colorFn = getAgentColor(agent) ?? pc.white;
    const title = truncate(t.title, 42);

    if (r !== undefined) {
      // Completed task
      const icon = (STATUS_ICONS as Record<string, string>)[r.status] ?? STATUS_ICONS.pending;
      const dur = formatDuration(r.durationMs);
      const tok = r.tokensUsed > 0 ? `~${(r.tokensUsed / 1000).toFixed(0)}K tok` : '';
      lines.push(
        `    ${icon} ${pc.bold(String(i + 1).padStart(2))}. ${title}  ${colorFn(agent.padEnd(7))} ${pc.dim(dur.padStart(7))}  ${pc.dim(tok)}`,
      );
    } else if (i === currentIdx) {
      // Currently running
      lines.push(
        `    ${STATUS_ICONS.running} ${pc.bold(String(i + 1).padStart(2))}. ${pc.bold(title)}  ${colorFn(agent.padEnd(7))} ${pc.dim('...')}`,
      );
    } else {
      // Pending
      lines.push(
        `    ${STATUS_ICONS.pending} ${pc.bold(String(i + 1).padStart(2))}. ${pc.dim(title)}  ${pc.dim(agent)}`,
      );
    }
  }

  // Budget gauge
  const summary = budget.getSummary();
  const pct =
    (summary['hardLimit'] as number) > 0
      ? ((summary['consumed'] as number) / (summary['hardLimit'] as number)) * 100
      : 0;
  const gauge = compactProgressBar(pct, 15);
  const remaining = tasks.length - results.length;
  const remainStr = remaining > 0 ? `  Remaining: ~${String(remaining)} tasks` : '';

  lines.push('');
  lines.push(`  Budget: ${gauge} ${pct.toFixed(1)}%  Time: ${elapsedStr} / ${maxStr}${remainStr}`);
  lines.push('');

  process.stderr.write(`${lines.join('\n')}\n`);
}

// ── Phase 4: EXECUTE ────────────────────────────────────────────────────────

async function phaseExecute(
  tasks: ScannedTask[],
  projectRoot: string,
  nightlyCfg: NightlyConfig,
  startedAt: number,
) {
  log.phase('EXECUTE');

  const budgetCfg = nightlyCfg.budget ?? {};
  const baseBranch = nightlyCfg.baseBranch ?? 'dev';
  const branchPrefix = nightlyCfg.branchPrefix ?? 'nightly';
  const perTaskTimeoutMs = nightlyCfg.perTaskTimeoutMs ?? 60_000;
  const maxHoursMs = (nightlyCfg.maxHours ?? 4) * 60 * 60 * 1000;
  const dateStr = new Date().toISOString().split('T')[0];

  // Initialize budget tracker
  const budget = new BudgetTracker({
    softLimit: budgetCfg.softLimit,
    hardLimit: budgetCfg.hardLimit,
    unitEstimate: budgetCfg.perTaskEstimate,
    unitLabel: 'task',
    thresholds: buildThresholds(budgetCfg),
  });
  budget.recordStart();
  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);

  const results: NightlyTaskResult[] = [];
  let stopReason: string | null = null;
  let useHandoff = false;

  // Initial overview
  renderProgress(tasks, results, budget, startedAt, maxHoursMs, 0);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const branchName = `${branchPrefix}/${dateStr}/${task.slug}`;

    // Time limit check
    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

    // Budget check
    const budgetCheck = budget.check();

    if (budgetCheck.action === 'hard_stop') {
      stopReason = 'hard budget limit';
      log.error(`HARD STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'soft_stop') {
      stopReason = 'soft budget limit';
      log.warn(`SOFT STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'handoff') {
      useHandoff = true;
      log.warn(budgetCheck.reason);
      log.info(
        `Remaining tasks will use ${budgetCfg.handoffAgent ?? ''} (${budgetCfg.handoffModel ?? ''})`,
      );
    }

    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    if (budgetCheck['canFitNextTask'] !== true && i > 0) {
      stopReason = 'predicted budget exceeded';
      log.warn(`Predicted next task would exceed remaining budget. Stopping.`);
      break;
    }

    // Select agent
    let agent: string;
    let modelOverride: string | undefined;
    if (useHandoff) {
      agent = budgetCfg.handoffAgent ?? 'codex';
      modelOverride = budgetCfg.handoffModel ?? 'o4-mini';
    } else {
      const taskType = classifyTask(task.title);
      agent = task.suggestedAgent === '' ? bestAgentFor(taskType) : task.suggestedAgent;
      modelOverride = undefined;
    }

    log.task(
      `Task ${String(i + 1)}/${String(tasks.length)}: ${task.title} [${agent}${modelOverride == null ? '' : `:${modelOverride}`}]`,
    );

    // Skip if branch already exists (e.g., from a previous aborted run)
    if (branchExists(projectRoot, branchName)) {
      log.warn(`Branch already exists: ${branchName} — skipping`);
      results.push({
        slug: task.slug,
        title: task.title,
        branch: branchName,
        source: task.source,
        taskType: task.taskType === '' ? 'unknown' : task.taskType,
        status: 'skipped',
        agent,
        tokensUsed: 0,
        durationMs: 0,
        commits: 0,
        filesChanged: 0,
        verification: 'SKIP',
        violations: [],
      });
      continue;
    }

    // Create branch from baseBranch
    if (!createBranch(projectRoot, branchName, baseBranch)) {
      log.error(`Failed to create branch: ${branchName}`);
      results.push({
        slug: task.slug,
        title: task.title,
        branch: branchName,
        source: task.source,
        taskType: task.taskType === '' ? 'unknown' : task.taskType,
        status: 'error',
        agent,
        tokensUsed: 0,
        durationMs: 0,
        commits: 0,
        filesChanged: 0,
        verification: 'SKIP',
        violations: [],
        error: 'Branch creation failed',
      });
      checkoutBranch(projectRoot, baseBranch);
      continue;
    }
    log.ok(`Branch: ${branchName}`);

    // Build prompt
    const prompt = buildTaskPrompt(task, branchName, projectRoot, agent, {
      isHandoff: useHandoff,
    });

    // Dispatch agent with progress feedback
    const handle = recordCallStart(agent, modelOverride ?? getActiveModel(agent));
    log.dim(`Dispatching ${agent}${modelOverride == null ? '' : ` (${modelOverride})`}...`);

    // eslint-disable-next-line no-await-in-loop -- task loop; intentionally sequential
    let agentResult = await executeAgentWithRecovery(agent, prompt, {
      cwd: projectRoot,
      timeoutMs: perTaskTimeoutMs,
      modelOverride,
      progressIntervalMs: 15_000,
      onProgress: (elapsed, outputKB) => {
        const elStr = formatDuration(elapsed);
        const kbStr = outputKB > 0 ? ` | ${String(outputKB)}KB` : '';
        process.stderr.write(
          `\r  ${pc.dim(`${agent}: working... ${elStr}${kbStr}`)}${' '.repeat(20)}`,
        );
      },
    });
    process.stderr.write(`\r${' '.repeat(80)}\r`); // clear progress line

    // Investigator self-healing on failure
    if (!agentResult.ok && nightlyCfg.investigator?.['enabled'] === true) {
      // eslint-disable-next-line no-await-in-loop -- failure path only; sequential by design
      const inv = await getInvestigator();
      if (inv !== null) {
        try {
          log.dim('Investigating failure...');
          // eslint-disable-next-line no-await-in-loop -- investigator retry; sequential by design
          const diagnosis = await inv.investigate?.({
            agent,
            prompt,
            error: agentResult.error,
            output: agentResult.stdout,
            projectRoot,
          });

          const diag = diagnosis as { category?: string } | null | undefined;
          if (diag != null && (diag.category === 'transient' || diag.category === 'fixable')) {
            log.info(`Investigator: ${diag.category} — retrying...`);
            // eslint-disable-next-line require-atomic-updates, no-await-in-loop -- agentResult retry; no real race condition
            agentResult = await executeAgentWithRecovery(agent, prompt, {
              cwd: projectRoot,
              timeoutMs: perTaskTimeoutMs,
              modelOverride,
            });
          }
        } catch (invErr) {
          log.dim(
            `Investigator error: ${invErr instanceof Error ? invErr.message : String(invErr)}`,
          );
        }
      }
    }

    // Doctor notification on persistent failure
    if (!agentResult.ok) {
      void import('./hydra-doctor.ts')
        .then((doc) => {
          if (doc.isDoctorEnabled())
            void doc.diagnose({
              pipeline: 'nightly',
              phase: 'execute',
              agent,
              error: agentResult.error,
              exitCode: agentResult.exitCode,
              signal: agentResult.signal,
              command: agentResult.command,
              args: agentResult.args,
              promptSnippet: agentResult.promptSnippet,
              stderr: agentResult.stderr,
              stdout: agentResult.stdout ?? agentResult.output,
              errorCategory: agentResult.errorCategory,
              errorDetail: agentResult.errorDetail,
              errorContext: agentResult.errorContext,
              timedOut: agentResult.timedOut,
              taskTitle: task.title,
              branchName,
            } as never);
        })
        .catch(() => {});
    }

    if (agentResult.ok) {
      recordCallComplete(handle, agentResult);
    } else {
      recordCallError(handle, new Error(agentResult.error ?? 'unknown'));
    }

    const taskDurationMs = agentResult.durationMs > 0 ? agentResult.durationMs : 0;
    const tokenDelta = budget.recordUnitEnd(task.slug, taskDurationMs);

    if (agentResult.timedOut) {
      log.warn(`Task timed out after ${formatDuration(perTaskTimeoutMs)}`);
    }

    // Verify branch integrity
    const branchCheck = verifyBranch(projectRoot, branchName);
    if (!branchCheck.ok) {
      log.error(
        `Branch escape detected! Expected '${branchName}', on '${branchCheck.currentBranch}'`,
      );
      try {
        git(['checkout', branchName], projectRoot);
      } catch {
        /* best effort */
      }
    }

    // Run verification
    const verification = runVerification(projectRoot);
    let verificationStatus: string;
    if (!verification.ran) {
      verificationStatus = 'SKIP';
    } else if (verification.passed) {
      verificationStatus = 'PASS';
    } else {
      verificationStatus = 'FAIL';
    }
    if (verification.ran) {
      if (verification.passed) log.ok(`Verification: PASS`);
      else log.warn(`Verification: FAIL`);
    }

    // Scan for violations
    const violations = scanBranchViolations(projectRoot, branchName, {
      baseBranch,
      protectedFiles: new Set(BASE_PROTECTED_FILES),
      protectedPatterns: [...BASE_PROTECTED_PATTERNS],
    });
    if (violations.length > 0) {
      log.warn(`${String(violations.length)} violation(s) detected`);
      for (const v of violations) {
        log.dim(`  [${v.severity}] ${v.detail}`);
      }
    }

    // Get commit/file stats
    const stats = getBranchStats(projectRoot, branchName, baseBranch);

    // Determine status
    let status = 'success';
    if (agentResult.timedOut) status = 'timeout';
    else if (!agentResult.ok) status = 'error';
    else if (!verification.passed && verification.ran) status = 'partial';

    const taskTokens = tokenDelta.tokens;
    log.ok(
      `Done: ${status} | ${String(stats.commits)} commits | ${String(stats.filesChanged)} files | ~${taskTokens.toLocaleString()} tokens | ${formatDuration(taskDurationMs)}`,
    );

    results.push({
      slug: task.slug,
      title: task.title,
      branch: branchName,
      source: task.source,
      taskType: task.taskType === '' ? 'unknown' : task.taskType,
      status,
      agent,
      tokensUsed: taskTokens,
      durationMs: taskDurationMs,
      commits: stats.commits,
      filesChanged: stats.filesChanged,
      verification: verificationStatus,
      violations,
    });

    // Return to baseBranch for next task
    checkoutBranch(projectRoot, baseBranch);

    // Refresh progress dashboard
    renderProgress(tasks, results, budget, startedAt, maxHoursMs, i + 1);
  }

  // Always return to baseBranch
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  return { results, budget, stopReason };
}

// ── Phase 5: REPORT ─────────────────────────────────────────────────────────

function phaseReport(
  results: NightlyTaskResult[],
  budget: BudgetTracker,
  runMeta: RunMeta,
  coordDir: string,
) {
  log.phase('REPORT');

  const nightlyDir = path.join(coordDir, 'nightly');
  ensureDir(nightlyDir);

  const budgetSummary = budget.getSummary() as BudgetSummary;

  const mdReport = generateReportMd(results, budgetSummary, runMeta);
  const jsonReport = generateReportJSON(results, budgetSummary, runMeta);

  const mdPath = path.join(nightlyDir, `NIGHTLY_${runMeta.date}.md`);
  const jsonPath = path.join(nightlyDir, `NIGHTLY_${runMeta.date}.json`);

  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);

  return { mdPath, jsonPath, budgetSummary };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const startedAt = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];

  // Resolve project
  let projectConfig;
  try {
    projectConfig = resolveProject({ project: options['project'] as string | undefined });
  } catch (err) {
    log.error(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  // Initialize agent registry
  initAgentRegistry();

  // Load config
  const cfg = loadHydraConfig();
  const nightlyCfg = cfg.nightly;
  if (!nightlyCfg) {
    log.error('Nightly config not found in hydra.config.json');
    process.exitCode = 1;
    return;
  }
  const baseBranch = nightlyCfg.baseBranch;

  // Apply CLI overrides
  if ('max-tasks' in options)
    nightlyCfg.maxTasks = Number.parseInt(options['max-tasks'] as string, 10);
  if ('max-hours' in options)
    nightlyCfg.maxHours = Number.parseFloat(options['max-hours'] as string);
  if ('no-discovery' in options && nightlyCfg.sources != null)
    nightlyCfg.sources['aiDiscovery'] = false;

  const isDryRun = 'dry-run' in options;

  // Validate preconditions
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${String(baseBranch)}' branch (currently on '${currentBranch}')`);
    process.exitCode = 1;
    return;
  }

  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exitCode = 1;
    return;
  }

  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);

  // Phase 1: SCAN
  const { tasks: scannedTasks, sourceCounts } = phaseScan(projectRoot, nightlyCfg);

  // Phase 2: DISCOVER
  const discoveredTasks = await phaseDiscover(projectRoot, scannedTasks, nightlyCfg);
  const allTasks = [...scannedTasks, ...discoveredTasks] as ScannedTask[];
  if (discoveredTasks.length > 0) {
    sourceCounts['ai-discovery'] = discoveredTasks.length;
  }

  // Phase 3: PRIORITIZE + optional SELECT
  const isInteractive = 'interactive' in options;

  let selectedTasks;
  if (isInteractive && !isDryRun && process.stdin.isTTY) {
    // Deduplicate and sort, but let the user pick
    log.phase('PRIORITIZE');
    const deduped = deduplicateTasks(allTasks);
    const sorted = prioritizeTasks(deduped);
    log.info(
      `${String(allTasks.length)} total -> ${String(deduped.length)} unique -> interactive selection`,
    );

    const userSelected = await phaseSelect(sorted, nightlyCfg.maxTasks ?? 5);
    if (userSelected === null || userSelected.length === 0) {
      log.warn('Cancelled.');
      // eslint-disable-next-line n/no-process-exit -- top-level main function; safe to exit
      process.exit(0);
    }
    selectedTasks = userSelected;
  } else {
    selectedTasks = phasePrioritize(allTasks, nightlyCfg.maxTasks ?? 5);
  }

  if (selectedTasks.length === 0) {
    log.warn('No tasks to execute. Nothing to do.');
    // eslint-disable-next-line n/no-process-exit -- top-level main function; safe to exit
    process.exit(0);
  }

  // Dry run: stop here
  if (isDryRun) {
    console.log('');
    console.log(pc.bold('=== Dry Run Complete ==='));
    console.log(`  Would execute ${String(selectedTasks.length)} task(s):`);
    for (const t of selectedTasks) {
      console.log(
        `    - [${t.source}] ${t.title} -> ${t.suggestedAgent === '' ? 'auto' : t.suggestedAgent}`,
      );
    }
    console.log('');
    // eslint-disable-next-line n/no-process-exit -- top-level main function; safe to exit
    process.exit(0);
  }

  // Phase 4: EXECUTE
  const { results, budget, stopReason } = await phaseExecute(
    selectedTasks,
    projectRoot,
    nightlyCfg,
    startedAt,
  );

  // Phase 5: REPORT
  const finishedAt = Date.now();
  const runMeta: RunMeta = {
    startedAt,
    finishedAt,
    date: dateStr,
    project: projectRoot,
    baseBranch,
    sources: sourceCounts,
    totalTasks: selectedTasks.length,
    processedTasks: results.length,
    stopReason,
  };

  const { budgetSummary } = phaseReport(results, budget, runMeta, coordDir);

  // Summary
  const successCount = results.filter((r) => r.status === 'success').length;
  const failCount = results.filter((r) => r.status !== 'success' && r.status !== 'skipped').length;
  const skipCount = results.filter((r) => r.status === 'skipped').length;

  console.log('');
  console.log(pc.bold('=== Nightly Run Complete ==='));
  console.log(
    `  Tasks: ${pc.green(`${String(successCount)} passed`)}${failCount > 0 ? `, ${pc.red(`${String(failCount)} failed`)}` : ''}${skipCount > 0 ? `, ${pc.dim(`${String(skipCount)} skipped`)}` : ''} of ${String(selectedTasks.length)} queued`,
  );
  console.log(`  Tokens: ~${budgetSummary.consumed.toLocaleString()} consumed`);
  console.log(`  Duration: ${formatDuration(finishedAt - startedAt)}`);
  if (stopReason !== null) console.log(`  Stopped: ${stopReason}`);
  console.log(`  Review: npm run nightly:review`);
  console.log('');
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  // Always try to get back to baseBranch
  try {
    const cfg = loadHydraConfig();
    const baseBranch = cfg.nightly?.baseBranch ?? 'dev';
    const projectRoot = process.cwd();
    const branch = getCurrentBranch(projectRoot);
    if (branch !== baseBranch && branch.startsWith('nightly/')) {
      checkoutBranch(projectRoot, baseBranch);
    }
  } catch {
    /* last resort */
  }
  // eslint-disable-next-line n/no-process-exit -- inside .catch() callback; return does not propagate
  process.exit(1);
});
