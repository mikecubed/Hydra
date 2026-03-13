/**
 * Hydra Evolve — Autonomous self-improvement runner.
 *
 * Runs deliberative research-implement-analyze rounds where Hydra autonomously
 * researches external systems, deliberates on findings, writes tests, implements
 * improvements, analyzes results, and accumulates knowledge.
 *
 * Each round has 7 phases:
 *   1. RESEARCH    — Agents investigate external systems (web-first)
 *   2. DELIBERATE  — Council discusses findings
 *   3. PLAN        — Create improvement spec + test plan
 *   4. TEST        — Write comprehensive tests (TDD)
 *   5. IMPLEMENT   — Make changes on isolated branch
 *   6. ANALYZE     — Multi-agent review of results
 *   7. DECIDE      — Consensus: keep/reject + document
 *
 * Usage:
 *   node lib/hydra-evolve.ts                              # defaults
 *   node lib/hydra-evolve.ts project=/path/to/YourProject # explicit project
 *   node lib/hydra-evolve.ts max-rounds=1 max-hours=1     # overrides
 *   node lib/hydra-evolve.ts focus=testing-reliability     # specific area
 */

import './hydra-env.ts';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  EvolveBudgetTracker,
  buildEvolveSafetyPrompt,
  scanBranchViolations,
  verifyBranch,
  isCleanWorkingTree,
} from './hydra-evolve-guardrails.ts';
import {
  initInvestigator,
  isInvestigatorAvailable,
  investigate,
  getInvestigatorStats,
} from './hydra-evolve-investigator.ts';
import { loadKnowledgeBase, saveKnowledgeBase, addEntry } from './hydra-evolve-knowledge.ts';
import {
  loadSuggestions,
  saveSuggestions,
  addSuggestion,
  updateSuggestion,
  getPendingSuggestions,
  getSuggestionById,
  createSuggestionFromRound,
  promptSuggestionPicker,
  type SuggestionEntry,
} from './hydra-evolve-suggestions.ts';
import { resolveProject, loadHydraConfig, HYDRA_ROOT } from './hydra-config.ts';
import { detectUsageLimitError, formatResetTime } from './hydra-model-recovery.ts';
import { ensureDir, parseArgs } from './hydra-utils.ts';
import type { TestFailure } from './hydra-utils.ts';
import { type RoundResult } from './hydra-evolve-state.ts';
import { initStatusBar, destroyStatusBar } from './hydra-statusbar.ts';
import {
  git,
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  getBranchStats,
  getBranchDiff,
  smartMerge,
} from './hydra-shared/git-ops.ts';
import {
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  loadSessionState,
  saveSessionState,
  computeSessionStatus,
  computeActionNeeded,
} from './hydra-evolve-state.ts';
import pc from 'picocolors';
import {
  DEFAULT_PHASE_TIMEOUTS,
  disabledAgents,
  sessionInvestigations,
  recordInvestigation,
  executeAgent,
  formatDuration,
  phaseResearch,
  phaseDeliberate,
  phasePlan,
  phaseTest,
  phaseImplement,
  phaseAnalyze,
} from './hydra-evolve-executor.ts';

export type { RoundResult } from './hydra-evolve-state.ts';

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_HOURS = 4;
const DEFAULT_MAX_ROUNDS = 3;

const DEFAULT_FOCUS_AREAS = [
  'orchestration-patterns',
  'ai-coding-tools',
  'testing-reliability',
  'developer-experience',
  'model-routing',
  'daemon-architecture',
];

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok: (msg: string) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg: string) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  phase: (msg: string) => process.stderr.write(`\n${pc.bold(pc.magenta('>>>'))} ${pc.bold(msg)}\n`),
  round: (msg: string) =>
    process.stderr.write(
      `\n${pc.bold(pc.cyan('=== '))}${pc.bold(msg)}${pc.bold(pc.cyan(' ==='))}\n`,
    ),
  dim: (msg: string) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// Git helpers are now imported from hydra-shared/git-ops.ts

// getBranchStats, getBranchDiff, stageAndCommit, smartMerge are now imported from hydra-shared/git-ops.ts

// ── Checkpoint & Hot-Restart ─────────────────────────────────────────────────

// All session state logic is now imported from hydra-evolve-state.ts

/**
 * Check if an evolve branch modified Hydra's own lib/ code (not the target project).
 * Only returns true when the diff touches files in Hydra's own directory.
 */
function didModifyHydraCode(projectRoot: string, branchName: string, baseBranch: string) {
  // Only relevant when evolve is running against Hydra itself
  const normalizedHydra = path.resolve(HYDRA_ROOT).toLowerCase();
  const normalizedProject = path.resolve(projectRoot).toLowerCase();
  if (normalizedHydra !== normalizedProject) return false;

  const r = git(['diff', '--name-only', `${baseBranch}...${branchName}`], projectRoot);
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .some((f) => f.startsWith('lib/'));
}

/**
 * Spawn a new detached PowerShell process to resume the evolve session.
 */
function spawnNewProcess(projectRoot: string) {
  const ps1Path = path.join(HYDRA_ROOT, 'bin', 'hydra-evolve.ps1');
  const child = spawn(
    'pwsh',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps1Path,
      '-Project',
      projectRoot,
      '-ResumeSession',
    ],
    {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    },
  );
  child.unref();
  log.ok(`Spawned new evolve process (PID ${String(child.pid)})`);
}

/**
 * Phase 7: DECIDE — Consensus verdict.
 */
function phaseDecide(
  analysis: {
    aggregateScore: number;
    aggregateConfidence?: number;
    testsPassed: boolean;
    concerns: string[];
    agentVerdicts: Record<string, string | null>;
    agentScores?: Record<string, unknown>;
    testOutput?: string;
    testDetails?: unknown;
  },
  config: Record<string, unknown>,
) {
  log.phase('DECIDE');

  const { aggregateScore, testsPassed, concerns, agentVerdicts } = analysis;
  const minScore = (config['approval'] as { minScore?: number } | undefined)?.minScore || 7; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
  const requireAllTests =
    (config['approval'] as { requireAllTestsPass?: boolean } | undefined)?.requireAllTestsPass !==
    false;

  // Count per-agent verdicts
  const verdictEntries = Object.entries(agentVerdicts || {}).filter(([, v]) => v != null); // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
  const approvals = verdictEntries.filter(([, v]) => v === 'approve').length;
  const rejections = verdictEntries.filter(([, v]) => v === 'reject').length;
  const totalVoters = verdictEntries.length;

  // Log per-agent breakdown
  const agentScores = analysis.agentScores ?? {};
  const verdictParts: string[] = [];
  for (const agent of ['claude', 'gemini', 'codex']) {
    const v = agentVerdicts[agent];
    const s = (agentScores[agent] as Record<string, unknown> | null)?.['quality'] as
      | number
      | undefined;
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (v || s != null) {
      verdictParts.push(
        `${agent[0].toUpperCase() + agent.slice(1)}: ${v ?? '?'}(${String(s ?? '?')})`,
      );
    }
  }

  let verdict;
  let reason;

  const hasCriticalConcerns = concerns.some((c: string) =>
    /critical|breaking|security|data.?loss/i.test(c),
  );

  if (hasCriticalConcerns) {
    verdict = 'reject';
    reason = `Critical concerns identified: ${concerns.filter((c: string) => /critical|breaking|security|data.?loss/i.test(c)).join('; ')}`;
  } else if (requireAllTests && !testsPassed) {
    verdict = 'reject';
    reason = 'Tests did not pass';
  } else if (rejections >= 2 && totalVoters >= 2) {
    // Majority reject overrides score
    verdict = 'reject';
    reason = `Majority reject (${String(rejections)}/${String(totalVoters)} agents) — score ${String(aggregateScore)}/10`;
  } else if (approvals >= 2 && totalVoters >= 2 && aggregateScore >= minScore - 1) {
    // Majority approve with score close enough → approve
    verdict = 'approve';
    reason = `Majority approve (${String(approvals)}/${String(totalVoters)} agents) — score ${String(aggregateScore)}/10, tests ${testsPassed ? 'passed' : 'N/A'}`;
  } else if (aggregateScore >= minScore) {
    verdict = 'approve';
    reason = `Score ${String(aggregateScore)}/10 meets minimum ${String(minScore)}/10, tests ${testsPassed ? 'passed' : 'N/A'}`;
  } else if (aggregateScore >= minScore - 2) {
    verdict = 'revise';
    reason = `Score ${String(aggregateScore)}/10 is close but below minimum ${String(minScore)}/10`;
  } else {
    verdict = 'reject';
    reason = `Score ${String(aggregateScore)}/10 is below minimum ${String(minScore)}/10`;
  }

  const verdictSummary =
    verdictParts.length > 0
      ? ` | ${verdictParts.join(' | ')} → ${verdict.toUpperCase()}${totalVoters >= 2 ? ` (${String(approvals)}/${String(totalVoters)} approve)` : ''}`
      : '';
  log.info(`Verdict: ${verdict.toUpperCase()} — ${reason}${verdictSummary}`);
  return { verdict, reason, score: aggregateScore };
}

// ── Search Query Generation ─────────────────────────────────────────────────

// ── Report Generation ───────────────────────────────────────────────────────

function compactTokenBar(tokens: number, budget: number, width = 16) {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const ratio = Math.min(tokens / (budget || 1), 1);
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (ratio * 100).toFixed(0);
  return pc.dim(`[${bar}] ${pct.padStart(3)}%`);
}

function generateSessionReport(
  roundResults: RoundResult[],
  budgetSummary: {
    consumed: number;
    hardLimit: number;
    softLimit?: number;
    percentUsed?: number;
    roundDeltas: Array<{ round: unknown; area: unknown; tokens: number; durationMs: unknown }>;
    avgPerRound: number;
    durationMs?: number;
    startTokens: number;
    endTokens: number;
  },
  runMeta: Record<string, unknown>,
  kbDelta: { added: number; total: number },
  investigatorSummary: {
    investigations: number;
    healed: number;
    promptTokens: number;
    completionTokens: number;
  } | null,
): string {
  const { startedAt, finishedAt, dateStr, maxRounds } = runMeta as {
    startedAt: number;
    finishedAt: number;
    dateStr: string;
    maxRounds: number;
  };
  const durationStr = formatDuration(finishedAt - startedAt);
  const tokensStr = `~${budgetSummary.consumed.toLocaleString()}`;

  const lines = [
    `# Evolve Session — ${dateStr}`,
    `Rounds: ${String(roundResults.length)}/${String(maxRounds)} | Duration: ${durationStr} | Tokens: ${tokensStr}`,
    '',
  ];

  for (const r of roundResults) {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const resultTag = r.verdict ? r.verdict.toUpperCase() : 'INCOMPLETE';
    lines.push(`## Round ${String(r.round)}: ${r.area}`);
    lines.push(`- Research: ${r.researchSummary ?? 'N/A'}`);
    lines.push(`- Selected: ${r.selectedImprovement ?? 'N/A'}`);
    if (r.testsWritten !== undefined) {
      lines.push(`- Tests written: ${String(r.testsWritten)}`);
    }
    if (r.testSummary) {
      const ts = r.testSummary;
      if (ts.failed > 0) {
        lines.push(`- Tests: FAIL (${String(ts.failed)}/${String(ts.total)} failed)`);
        for (const f of (r.testFailures ?? []).slice(0, 5)) {
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          lines.push(`  - ${f.name}${f.error ? `: ${f.error}` : ''}`);
        }
      } else {
        lines.push(`- Tests: PASS (${String(ts.passed)}/${String(ts.total)})`);
      }
    }
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    lines.push(`- Result: ${resultTag}${r.score ? ` (score: ${String(r.score)}/10)` : ''}`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.branchName) {
      lines.push(`- Branch: ${r.branchName}`);
    }
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.learnings) {
      lines.push(`- Learnings: ${r.learnings}`);
    }
    if (r.investigations && r.investigations.count > 0) {
      lines.push(
        `- Investigations: ${String(r.investigations.count)} (healed: ${String(r.investigations.healed)})`,
      );
    }
    lines.push('');
  }

  lines.push('## Knowledge Base Growth');
  lines.push(`- New entries: ${String(kbDelta.added)}`);
  lines.push(`- Cumulative: ${String(kbDelta.total)} entries`);
  lines.push('');

  // Investigation summary
  if (investigatorSummary && investigatorSummary.investigations > 0) {
    lines.push('## Self-Healing Investigator');
    lines.push(`- Investigations triggered: ${String(investigatorSummary.investigations)}`);
    lines.push(`- Healed (retry succeeded): ${String(investigatorSummary.healed)}`);
    lines.push(
      `- Investigator tokens: ~${(investigatorSummary.promptTokens + investigatorSummary.completionTokens).toLocaleString()}`,
    );
    lines.push('');
  }

  lines.push('## Budget Summary');
  lines.push(`- Start tokens: ${budgetSummary.startTokens.toLocaleString()}`);
  lines.push(`- End tokens: ${budgetSummary.endTokens.toLocaleString()}`);
  lines.push(`- Consumed: ${budgetSummary.consumed.toLocaleString()}`);
  lines.push(`- Budget limit: ${budgetSummary.hardLimit.toLocaleString()}`);
  lines.push(`- Avg per round: ${budgetSummary.avgPerRound.toLocaleString()}`);
  if (budgetSummary.roundDeltas.length > 0) {
    lines.push('');
    lines.push('| Round | Area | Tokens | Duration |');
    lines.push('|-------|------|--------|----------|');
    for (const d of budgetSummary.roundDeltas) {
      lines.push(
        `| ${String(d.round)} | ${String(d.area)} | ${d.tokens.toLocaleString()} | ${formatDuration(d.durationMs as number)} |`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

function generateSessionJSON(
  roundResults: RoundResult[],
  budgetSummary: {
    consumed: number;
    hardLimit: number;
    softLimit?: number;
    percentUsed?: number;
    roundDeltas: Array<{ round: unknown; area: unknown; tokens: number; durationMs: unknown }>;
    avgPerRound: number;
    durationMs?: number;
    startTokens: number;
    endTokens: number;
  },
  runMeta: Record<string, unknown>,
  kbDelta: { added: number; total: number },
  investigatorSummary: {
    investigations: number;
    healed: number;
    promptTokens: number;
    completionTokens: number;
  } | null,
) {
  return {
    ...runMeta,
    budget: budgetSummary,
    knowledgeBaseDelta: kbDelta,
    investigator: investigatorSummary ?? null,
    rounds: roundResults.map((r) => ({
      round: r.round,
      area: r.area,
      selectedImprovement: r.selectedImprovement,
      verdict: r.verdict,
      score: r.score,
      branchName: r.branchName,
      learnings: r.learnings,
      durationMs: r.durationMs,
      investigations: r.investigations ?? null,
      testSummary: r.testSummary ?? null,
      testFailures: r.testFailures ?? null,
      merged: r.merged || false,
      mergeMethod: r.mergeMethod ?? null,
      mergeConflicts: r.mergeConflicts ?? null,
    })),
  };
}

// ── Main Runner ─────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const isResume = options['resume'] === '1' || options['resume'] === 'true';

  // ── Resolve project ───────────────────────────────────────────────────
  let projectConfig;
  try {
    projectConfig = resolveProject({ project: options['project'] as string | undefined });
  } catch (err: unknown) {
    log.error(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  // ── Load evolve config ────────────────────────────────────────────────
  const hydraConfig = loadHydraConfig();
  const evolveConfig = hydraConfig.evolve ?? {};
  const baseBranch = evolveConfig.baseBranch ?? 'dev';

  // ── Validate preconditions ────────────────────────────────────────────
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${baseBranch}' branch (currently on '${currentBranch}')`);
    process.exitCode = 1;
    return;
  }

  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exitCode = 1;
    return;
  }

  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);

  // ── Initialize evolve directory ───────────────────────────────────────
  const evolveDir = path.join(coordDir, 'evolve');
  ensureDir(evolveDir);
  ensureDir(path.join(evolveDir, 'research'));
  ensureDir(path.join(evolveDir, 'specs'));
  ensureDir(path.join(evolveDir, 'decisions'));

  // ── Initialize investigator ─────────────────────────────────────────
  if (isInvestigatorAvailable()) {
    initInvestigator();
    log.ok('Self-healing investigator initialized');
  } else {
    log.dim('Investigator not available (no OPENAI_API_KEY or disabled in config)');
  }

  // ── Check for session checkpoint (resume) ─────────────────────────────

  const checkpoint = loadCheckpoint(evolveDir);

  const existingState = loadSessionState(evolveDir);
  let startedAt: number,
    dateStr: string,
    maxRounds: number,
    maxHoursMs: number,
    focusAreas: string[],
    timeouts: typeof DEFAULT_PHASE_TIMEOUTS;
  let roundResults: RoundResult[],
    kbStartCount: number,
    budget: EvolveBudgetTracker,
    startRound: number,
    sessionId: string;

  const kb = loadKnowledgeBase(evolveDir);

  if (checkpoint && isResume) {
    // ── Resume from checkpoint ──────────────────────────────────────────
    log.info(pc.yellow('Resuming evolve session from checkpoint...'));

    log.dim(`Reason: ${checkpoint.reason ?? 'hot-restart'}`);

    startedAt = checkpoint.startedAt ?? Date.now();
    dateStr = checkpoint.dateStr ?? '';
    sessionId =
      checkpoint.sessionId ??
      `evolve_${dateStr === '' ? new Date().toISOString().slice(0, 10) : dateStr}_${randomBytes(3).toString('hex')}`;
    maxRounds = checkpoint.maxRounds ?? DEFAULT_MAX_ROUNDS;
    maxHoursMs = checkpoint.maxHoursMs ?? DEFAULT_MAX_HOURS * 60 * 60 * 1000;
    focusAreas = checkpoint.focusAreas ?? DEFAULT_FOCUS_AREAS;
    timeouts = { ...DEFAULT_PHASE_TIMEOUTS, ...(checkpoint.timeouts ?? {}) };
    roundResults = checkpoint.completedRounds ?? [];
    kbStartCount = checkpoint.kbStartCount ?? 0;
    startRound = (checkpoint.lastRoundNum ?? 0) + 1;

    // Restore budget tracker
    if (checkpoint.budgetState) {
      budget = EvolveBudgetTracker.deserialize(checkpoint.budgetState);
      log.dim(
        `Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${String(budget.roundDeltas.length)} rounds`,
      );
    } else {
      budget = new EvolveBudgetTracker(checkpoint.budgetOverrides ?? {});
      budget.recordStart();
    }

    // Consume (delete) the checkpoint
    deleteCheckpoint(evolveDir);
    log.ok(`Checkpoint consumed, resuming from round ${String(startRound)}`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  } else if (!checkpoint && isResume && existingState?.resumable) {
    // ── Resume from session state ───────────────────────────────────────
    log.info(pc.yellow('Resuming evolve session from session state...'));

    log.dim(`Session: ${existingState.sessionId ?? ''} (${existingState.status ?? ''})`);

    sessionId = existingState.sessionId ?? '';
    dateStr = existingState.dateStr ?? '';
    roundResults = existingState.completedRounds ?? [];
    kbStartCount =
      existingState.kbStartCount ?? kb.entries.length - (existingState.summary?.totalKBAdded ?? 0);
    startRound = existingState.nextRound ?? roundResults.length + 1;
    focusAreas = existingState.focusAreas ?? evolveConfig.focusAreas ?? DEFAULT_FOCUS_AREAS;
    timeouts = {
      ...DEFAULT_PHASE_TIMEOUTS,
      ...(existingState.timeouts ?? {}),
      ...(evolveConfig.phases ?? {}),
    };

    // Parse options for overrides on resume
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety: options values may be undefined
    maxRounds = options['max-rounds']
      ? Number.parseInt(String(options['max-rounds']), 10)
      : (existingState.maxRounds ?? evolveConfig.maxRounds ?? DEFAULT_MAX_ROUNDS);
    maxHoursMs =
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety: options values may be undefined
      (options['max-hours']
        ? Number.parseFloat(String(options['max-hours']))
        : (existingState.maxHours ?? evolveConfig.maxHours ?? DEFAULT_MAX_HOURS)) *
      60 *
      60 *
      1000;

    // Fresh time limit for resumed sessions
    startedAt = Date.now();

    // Restore budget tracker
    if (existingState.budgetState) {
      budget = EvolveBudgetTracker.deserialize(existingState.budgetState);
      log.dim(
        `Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${String(budget.roundDeltas.length)} rounds`,
      );
    } else {
      const budgetOverrides: { hardLimit?: number; softLimit?: number } = {};
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      if (options['hard-limit'])
        budgetOverrides.hardLimit = Number.parseInt(String(options['hard-limit']), 10);
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      if (options['soft-limit'])
        budgetOverrides.softLimit = Number.parseInt(String(options['soft-limit']), 10);
      budget = new EvolveBudgetTracker(budgetOverrides);
      budget.recordStart();
    }

    log.ok(`Session state restored, resuming from round ${String(startRound)}`);
  } else {
    // ── Fresh session ───────────────────────────────────────────────────

    if (checkpoint && !isResume) {
      log.warn('Stale checkpoint found but --resume not set. Starting fresh session.');
      deleteCheckpoint(evolveDir);
    }

    startedAt = Date.now();
    dateStr = new Date().toISOString().split('T')[0];
    sessionId = `evolve_${dateStr}_${randomBytes(3).toString('hex')}`;
    startRound = 1;
    roundResults = [];
    kbStartCount = kb.entries.length;

    // Parse options
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    maxRounds = options['max-rounds']
      ? Number.parseInt(String(options['max-rounds']), 10)
      : evolveConfig.maxRounds || DEFAULT_MAX_ROUNDS; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
    maxHoursMs =
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      (options['max-hours']
        ? Number.parseFloat(String(options['max-hours']))
        : evolveConfig.maxHours || DEFAULT_MAX_HOURS) * // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
      60 *
      60 *
      1000;
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    focusAreas = options['focus']
      ? [options['focus'] as string]
      : (evolveConfig.focusAreas ?? DEFAULT_FOCUS_AREAS);
    timeouts = { ...DEFAULT_PHASE_TIMEOUTS, ...(evolveConfig.phases ?? {}) };

    const budgetOverrides: { hardLimit?: number; softLimit?: number } = {};
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (options['hard-limit'])
      budgetOverrides.hardLimit = Number.parseInt(String(options['hard-limit']), 10);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (options['soft-limit'])
      budgetOverrides.softLimit = Number.parseInt(String(options['soft-limit']), 10);

    budget = new EvolveBudgetTracker(budgetOverrides);
    budget.recordStart();
  }

  // ── Suggestions backlog ─────────────────────────────────────────────
  const suggestions = loadSuggestions(evolveDir);
  let activeSuggestion: SuggestionEntry | null = null;
  let activeSuggestionId = null;

  if (!isResume && evolveConfig.suggestions?.enabled !== false) {
    const pending = getPendingSuggestions(suggestions);
    if (pending.length > 0) {
      log.info(`${String(pending.length)} pending suggestion(s) in backlog`);
      const pick = await promptSuggestionPicker(pending, {
        maxDisplay: Math.min(5, pending.length),
      });

      if (pick.action === 'pick') {
        activeSuggestion = pick.suggestion ?? null;
        activeSuggestionId = activeSuggestion?.id ?? null;
        updateSuggestion(suggestions, activeSuggestion?.id ?? '', { status: 'exploring' });
        saveSuggestions(evolveDir, suggestions);
        log.ok(`Using suggestion: ${(activeSuggestion?.title ?? '').slice(0, 80)}`);
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      } else if (pick.action === 'freeform' && pick.text) {
        activeSuggestion = addSuggestion(suggestions, {
          source: 'user:manual',
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          area: focusAreas[0] || 'general',
          title: pick.text.slice(0, 100),
          description: pick.text,
          priority: 'high',
          tags: ['user-submitted'],
        });
        if (activeSuggestion) {
          activeSuggestionId = activeSuggestion.id ?? null;
          updateSuggestion(suggestions, activeSuggestion.id ?? '', { status: 'exploring' });
          saveSuggestions(evolveDir, suggestions);
          log.ok(`Created suggestion: ${(activeSuggestion.title ?? '').slice(0, 80)}`);
        }
      } else {
        log.dim(pick.action === 'discover' ? 'Agent discovery mode' : 'Skipped suggestions');
      }
    }
  } else if (isResume) {
    // Restore active suggestion from session state on resume

    const existingSugId = existingState?.activeSuggestionId ?? checkpoint?.activeSuggestionId;
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (existingSugId) {
      activeSuggestion = getSuggestionById(suggestions, existingSugId);
      if (activeSuggestion?.status === 'exploring') {
        activeSuggestionId = existingSugId;
        log.dim(`Resumed with suggestion: ${(activeSuggestion.title ?? '').slice(0, 80)}`);
      } else {
        activeSuggestion = null;
      }
    }
  }

  log.info(`Session: ${sessionId}`);
  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);
  log.info(`Rounds: max ${String(maxRounds)} | Time: max ${formatDuration(maxHoursMs)}`);

  // ── Save initial session state ──────────────────────────────────────
  saveSessionState(evolveDir, {
    sessionId,
    status: 'running',
    startedAt,
    dateStr,
    maxRounds,
    maxHours: maxHoursMs / (60 * 60 * 1000),
    focusAreas,
    timeouts,
    kbStartCount,
    completedRounds: roundResults,
    nextRound: startRound,
    resumable: false,
    summary: {
      approved: 0,
      rejected: 0,
      skipped: 0,
      errors: 0,
      totalKBAdded: 0,
    },

    activeSuggestionId: activeSuggestionId ?? null,
    budgetState: budget.serialize(),
  });

  // ── Initialize status bar ─────────────────────────────────────────────
  initStatusBar(['claude', 'gemini', 'codex']);

  // ── Round loop ────────────────────────────────────────────────────────
  let stopReason = null;
  let reducedScope = false;

  for (let round = startRound; round <= maxRounds; round++) {
    const roundStart = Date.now();

    // Time limit check
    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

    // Budget gate check
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

    if (budgetCheck.action === 'reduce_scope') {
      reducedScope = true;
      log.warn(budgetCheck.reason);
    }

    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    if (!budgetCheck.canFitNextRound && round > 1) {
      stopReason = 'predicted budget exceeded';
      log.warn(
        `Predicted next round (~${budgetCheck.avgPerRound.toLocaleString()} tokens) would exceed remaining budget. Stopping.`,
      );
      break;
    }

    // Select focus area (rotate, skip recently covered)
    const recentAreas = roundResults.map((r: RoundResult) => r.area);
    let area;
    const usingSuggestion = activeSuggestion !== null && round === startRound;

    if (usingSuggestion && activeSuggestion !== null) {
      area = activeSuggestion.area ?? focusAreas[0] ?? 'general'; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- defensive fallback
    } else {
      const areaIndex = (round - 1) % focusAreas.length;
      area = focusAreas[areaIndex];
      // If we only have one focus area specified, use it; otherwise try to avoid repeats
      if (focusAreas.length > 1 && recentAreas.includes(area)) {
        area = focusAreas.find((a: string) => !recentAreas.includes(a)) ?? area;
      }
    }

    log.round(
      `ROUND ${String(round)}/${String(maxRounds)}: ${area}${usingSuggestion ? ' (suggestion)' : ''}`,
    );

    const roundResult: RoundResult = {
      round,
      area,
      selectedImprovement: null,
      verdict: null,
      score: null,
      branchName: null,
      learnings: null,
      durationMs: 0,
      researchSummary: null,
      investigations: null,
      testSummary: null,
      testFailures: null,
      merged: false,
      mergeMethod: null,
      mergeConflicts: null,

      suggestionId: usingSuggestion ? activeSuggestionId : null,
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let deliberation: any;

      if (usingSuggestion && activeSuggestion !== null) {
        // ── SUGGESTION PATH: Skip RESEARCH + DELIBERATE ────────────────
        log.phase('RESEARCH');
        log.dim('Skipped — using suggestion from backlog');
        log.phase('DELIBERATE');
        log.dim('Skipped — using suggestion from backlog');

        deliberation = {
          synthesis: { suggestedImprovement: activeSuggestion.description },
          critique: null,
          feasibility: null,
          priority: {
            selectedImprovement: activeSuggestion.description,
            rationale: `From suggestion backlog: ${activeSuggestion.title ?? ''}`,
            expectedImpact: activeSuggestion.priority ?? 'medium',
            risks: [],
            constraints: [],
          },
          selectedImprovement: activeSuggestion.description,
        };

        roundResult.selectedImprovement = activeSuggestion.description ?? null;
        roundResult.researchSummary = `[Suggestion ${activeSuggestion.id ?? ''}] ${activeSuggestion.title ?? ''}`;
        log.ok(`Selected: ${(activeSuggestion.title ?? '').slice(0, 100)}`);

        // Clear for subsequent rounds
        activeSuggestion = null;
        activeSuggestionId = null;
      } else {
        // ── NORMAL PATH: RESEARCH + DELIBERATE ─────────────────────────
        // ── Phase 1: RESEARCH ──────────────────────────────────────────
        // eslint-disable-next-line no-await-in-loop -- sequential processing required
        const research = await phaseResearch(area, kb, { cwd: projectRoot, timeouts, evolveDir });

        // Save research artifact
        const researchPath = path.join(
          evolveDir,
          'research',
          `ROUND_${String(round)}_RESEARCH.json`,
        );
        fs.writeFileSync(researchPath, JSON.stringify(research, null, 2), 'utf8');
        log.ok(`Research saved: ${path.basename(researchPath)}`);

        // Summarize research for report
        const allFindings = [
          ...((research as { claudeFindings?: { findings?: string[] } }).claudeFindings?.findings ??
            []),
          ...((research as { geminiFindings?: { findings?: string[] } }).geminiFindings?.findings ??
            []),
        ];
        roundResult.researchSummary =
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          allFindings.slice(0, 3).join('; ').slice(0, 200) || 'No findings';

        // Add research findings to KB
        for (const finding of allFindings.slice(0, 5)) {
          addEntry(kb, {
            round,
            date: dateStr,
            area,
            finding,
            applicability: 'medium',
            attempted: false,
            tags: [area],
          });
        }

        // ── Phase 2: DELIBERATE ──────────────────────────────────────────
        // eslint-disable-next-line no-await-in-loop -- sequential processing required
        deliberation = await phaseDeliberate(research, kb, { cwd: projectRoot, timeouts });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- runtime safety
        roundResult.selectedImprovement = deliberation.selectedImprovement;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- runtime safety
        log.ok(`Selected: ${String(deliberation.selectedImprovement.slice(0, 100))}`);
      }

      // If deliberation produced no actionable improvement, skip this round
      if (
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
        deliberation.selectedImprovement === 'No improvement selected' ||
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
        (deliberation.selectedImprovement?.length ?? 0) < 5
      ) {
        log.warn('No actionable improvement from deliberation — skipping round');
        roundResult.verdict = 'skipped';
        roundResult.learnings = 'No actionable improvement from deliberation';

        addEntry(kb, {
          round,
          date: dateStr,
          area,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- runtime safety
          finding: deliberation.selectedImprovement ?? 'empty',
          applicability: 'low',
          attempted: false,
          outcome: null,
          learnings: 'Deliberation did not produce actionable improvement',
          tags: [area, 'skipped'],
        });

        roundResults.push(roundResult);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }

      // If reduced scope, skip implementation phases
      if (reducedScope) {
        log.warn('Reduced scope mode — skipping TEST, IMPLEMENT, ANALYZE phases');
        roundResult.verdict = 'skipped';
        roundResult.learnings = 'Budget-reduced: research and deliberation only';

        addEntry(kb, {
          round,
          date: dateStr,
          area,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- runtime safety
          finding: deliberation.selectedImprovement,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- runtime safety
          applicability: deliberation.priority?.expectedImpact ?? 'medium',
          attempted: false,
          outcome: null,
          learnings: 'Deferred due to budget constraints',
          tags: [area, 'deferred'],
        });

        // Auto-create suggestion for deferred improvement
        if (
          evolveConfig.suggestions?.autoPopulateFromDeferred !== false &&
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          !roundResult.suggestionId
        ) {
          const sg = loadSuggestions(evolveDir);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- runtime safety
          const created = createSuggestionFromRound(sg, roundResult as any, deliberation, {
            sessionId,
            source: 'auto:deferred',
            notes: 'Deferred due to budget constraints',
          });
          if (created) {
            saveSuggestions(evolveDir, sg);
            log.dim(
              `Suggestion backlogged: ${String(created.id)} — ${(created.title ?? '').slice(0, 60)}`,
            );
          }
        }

        roundResults.push(roundResult);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }

      // ── Phase 3: PLAN ──────────────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, no-await-in-loop -- sequential processing required
      const plan = await phasePlan(deliberation, area, kb, {
        cwd: projectRoot,
        timeouts,
        evolveDir,
        roundNum: round,
      });

      // ── Create branch ──────────────────────────────────────────────────
      const branchName = `evolve/${dateStr}/${String(round)}`;
      roundResult.branchName = branchName;

      if (!createBranch(projectRoot, branchName, baseBranch)) {
        log.error(`Failed to create branch: ${branchName}`);
        roundResult.verdict = 'error';
        roundResult.learnings = 'Branch creation failed';
        roundResults.push(roundResult);
        checkoutBranch(projectRoot, baseBranch);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }
      log.ok(`Branch: ${branchName}`);

      const safetyPrompt = buildEvolveSafetyPrompt(branchName);

      // ── Phase 4: TEST (with investigation) ────────────────────────────
      // eslint-disable-next-line no-await-in-loop -- sequential processing required
      let testResult = await phaseTest(plan, branchName, safetyPrompt, {
        cwd: projectRoot,
        timeouts,
      });

      if (!testResult.ok) {
        // Skip investigation for usage limits — investigator would also fail
        const testUsageCheck = detectUsageLimitError(
          'codex',
          testResult as unknown as Record<string, unknown>,
        );
        if (testUsageCheck.isUsageLimit) {
          const resetLabel = formatResetTime(testUsageCheck.resetInSeconds);
          log.warn(
            `Test phase: codex usage limit reached (resets in ${resetLabel}) — skipping investigation`,
          );
          disabledAgents.add('codex');
        } else if (isInvestigatorAvailable()) {
          log.info('Test phase failed — investigating...');
          // eslint-disable-next-line no-await-in-loop -- sequential processing required
          const testDiag = await investigate({
            phase: 'test',
            agent: 'codex',
            error: testResult.error ?? 'phaseTest returned ok=false',
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
            stderr: (testResult.stderr || '').slice(-2000),
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
            stdout: (testResult.output || '').slice(-2000),
            timedOut: testResult.timedOut || false,
            context: JSON.stringify(plan.plan ?? {}).slice(0, 3000),
            attemptNumber: 1,
          });
          recordInvestigation('test', testDiag);
          log.dim(`Test investigation: ${testDiag.diagnosis} — ${testDiag.explanation}`);

          if (testDiag.retryRecommendation.retryPhase && testDiag.diagnosis !== 'fundamental') {
            log.info('Retrying test phase with investigator guidance...');
            // eslint-disable-next-line no-await-in-loop -- sequential processing required
            testResult = await phaseTest(plan, branchName, safetyPrompt, {
              cwd: projectRoot,
              timeouts,
              investigatorPreamble:
                testDiag.retryRecommendation.preamble ?? testDiag.corrective ?? undefined,
            });
          }
        }
      }

      // ── Phase 5: IMPLEMENT (with investigation) ────────────────────────
      // eslint-disable-next-line no-await-in-loop -- sequential processing required
      let implResult = await phaseImplement(plan, branchName, safetyPrompt, {
        cwd: projectRoot,
        timeouts,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
        deliberation,
      });

      if (!implResult.ok) {
        // Skip investigation for usage limits — investigator would also fail
        const implUsageCheck = detectUsageLimitError(
          'codex',
          implResult as unknown as Record<string, unknown>,
        );
        if (implUsageCheck.isUsageLimit) {
          const resetLabel = formatResetTime(implUsageCheck.resetInSeconds);
          log.warn(
            `Implement phase: codex usage limit reached (resets in ${resetLabel}) — skipping investigation`,
          );
          disabledAgents.add('codex');
        } else if (isInvestigatorAvailable()) {
          log.info('Implement phase failed — investigating...');
          // eslint-disable-next-line no-await-in-loop -- sequential processing required
          const implDiag = await investigate({
            phase: 'implement',
            agent: 'codex',
            error: implResult.error ?? 'phaseImplement returned ok=false',
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
            stderr: (implResult.stderr || '').slice(-2000),
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
            stdout: (implResult.output || '').slice(-2000),
            timedOut: implResult.timedOut || false,
            context: JSON.stringify(plan.plan ?? {}).slice(0, 3000),
            attemptNumber: 1,
          });
          recordInvestigation('implement', implDiag);
          log.dim(`Implement investigation: ${implDiag.diagnosis} — ${implDiag.explanation}`);

          if (implDiag.retryRecommendation.retryPhase && implDiag.diagnosis !== 'fundamental') {
            log.info('Retrying implement phase with investigator guidance...');
            // eslint-disable-next-line no-await-in-loop -- sequential processing required
            implResult = await phaseImplement(plan, branchName, safetyPrompt, {
              cwd: projectRoot,
              timeouts,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
              deliberation,
              investigatorPreamble:
                implDiag.retryRecommendation.preamble ?? implDiag.corrective ?? undefined,
            });
          }
        }
      }

      // Agent fallback: if Codex failed all attempts and Claude is available, try it
      if (!implResult.ok && !disabledAgents.has('claude')) {
        log.warn('Implement: all Codex attempts failed — falling back to Claude...');
        // eslint-disable-next-line no-await-in-loop -- sequential processing required
        const fallbackResult = await phaseImplement(plan, branchName, safetyPrompt, {
          cwd: projectRoot,
          timeouts,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
          deliberation,
          agentOverride: 'claude',
        });
        if (fallbackResult.ok) {
          implResult = fallbackResult;
          log.dim(`Implement (Claude fallback): OK (${formatDuration(implResult.durationMs)})`);
        } else {
          log.warn(`Implement (Claude fallback): also failed — proceeding with failed impl`);
        }
      }

      // Verify we're still on the right branch
      const branchCheck = verifyBranch(projectRoot, branchName);
      if (!branchCheck.ok) {
        log.error(`Branch escape! Expected '${branchName}', on '${branchCheck.currentBranch}'`);
        git(['checkout', branchName], projectRoot);
      }

      // ── Phase 6: ANALYZE ───────────────────────────────────────────────
      const diff = getBranchDiff(projectRoot, branchName, baseBranch);
      // eslint-disable-next-line no-await-in-loop -- sequential processing required
      let analysis = await phaseAnalyze(diff, branchName, plan, {
        cwd: projectRoot,
        timeouts,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
        deliberation,
      });

      // If tests failed during analysis, investigate and attempt a fix pass
      if (!analysis.testsPassed && isInvestigatorAvailable()) {
        const td = analysis.testDetails || {}; // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
        const errorSummary = td.summary
          ? `Tests failed: ${td.summary}`
          : 'Tests failed during analysis phase';
        const failureContext =
          td.failures.length > 0
            ? `\nFailing tests: ${td.failures.map((f) => f.name).join(', ')}`
            : '';

        log.info('Tests failed in analysis — investigating...');
        // eslint-disable-next-line no-await-in-loop -- sequential processing required
        const analyzeDiag = await investigate({
          phase: 'analyze',
          agent: 'codex',
          error: errorSummary,
          stderr: '',
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          stdout: (analysis.testOutput || '').slice(-2000),
          timedOut: false,
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          context: `Test output: ${(analysis.testOutput || '').slice(-1500)}${failureContext}`,
          attemptNumber: 1,
        });
        recordInvestigation('analyze', analyzeDiag);
        log.dim(`Analyze investigation: ${analyzeDiag.diagnosis} — ${analyzeDiag.explanation}`);

        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
        if (analyzeDiag.diagnosis === 'fixable' && analyzeDiag.corrective) {
          log.info('Running corrective implementation pass...');

          // Build failing tests section for the fix prompt
          let failingTestsSection = '';
          if (td.failures.length > 0) {
            failingTestsSection = `\n## Failing Tests\n${td.failures
              .slice(0, 10)
              // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
              .map((f) => `- **${f.name}**${f.error ? `: ${f.error}` : ''}`)
              .join('\n')}\n`;
          }

          const fixPrompt = `# Corrective Fix — Tests Failing

The tests on this branch are failing. The investigator diagnosed the issue:

**Root cause:** ${analyzeDiag.rootCause}
**Corrective action:** ${analyzeDiag.corrective}
${failingTestsSection}
Fix the implementation to make the tests pass. Run \`node --test\` to verify.

${safetyPrompt}`;

          // eslint-disable-next-line no-await-in-loop -- sequential processing required
          await executeAgent('codex', fixPrompt, {
            cwd: projectRoot,
            timeoutMs: timeouts.implementTimeoutMs,
            phaseLabel: 'analyze: corrective fix',
          });

          // Re-run analysis after fix attempt
          const newDiff = getBranchDiff(projectRoot, branchName, baseBranch);
          // eslint-disable-next-line no-await-in-loop -- sequential processing required
          analysis = await phaseAnalyze(newDiff, branchName, plan, {
            cwd: projectRoot,
            timeouts,
          });
        }
      }

      roundResult.score = analysis.aggregateScore;

      // Enrich roundResult with test details
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
      if (analysis.testDetails) {
        const td = analysis.testDetails;
        roundResult.testSummary = {
          total: td.total,
          passed: td.passed,
          failed: td.failed,
          summary: td.summary,
        };
        roundResult.testFailures = td.failures.slice(0, 10);
      }

      // Snapshot investigation stats for this round
      if (sessionInvestigations.count > 0) {
        roundResult.investigations = { ...sessionInvestigations };
      }

      // ── Phase 7: DECIDE ────────────────────────────────────────────────
      // Check for violations
      const violations = scanBranchViolations(projectRoot, branchName, baseBranch);
      if (violations.length > 0) {
        log.warn(`${String(violations.length)} violation(s) detected`);
        for (const v of violations) {
          log.dim(`  [${v.severity}] ${v.detail}`);
        }
        // Critical violations force reject
        if (violations.some((v) => v.severity === 'critical')) {
          analysis.concerns.push('Critical guardrail violations detected');
        }
      }

      const decision = phaseDecide(analysis, evolveConfig);
      roundResult.verdict = decision.verdict;
      roundResult.learnings = decision.reason;

      // Save decision artifact
      const decisionPath = path.join(
        evolveDir,
        'decisions',
        `ROUND_${String(round)}_DECISION.json`,
      );
      const decisionArtifact: {
        round: number;
        area: string;
        improvement: string;
        verdict: string;
        reason: string;
        score: number;
        confidence: number;
        testsPassed: boolean;
        violations: number;
        concerns: string[];
        branchName: string;
        testSummary?: { total: number; passed: number; failed: number; summary: string };
        testFailures?: Array<{ name: string; error?: string | null | undefined }>;
      } = {
        round,
        area,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- runtime safety
        improvement: deliberation.selectedImprovement,
        verdict: decision.verdict,
        reason: decision.reason,
        score: analysis.aggregateScore,
        confidence: analysis.aggregateConfidence ?? 0, // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- defensive fallback
        testsPassed: analysis.testsPassed,
        violations: violations.length,
        concerns: analysis.concerns,
        branchName,
      };
      if (roundResult.testSummary) {
        decisionArtifact.testSummary = roundResult.testSummary;
        decisionArtifact.testFailures = (roundResult.testFailures ?? []).map((f: TestFailure) => ({
          name: f.name,
          error: f.error,
        }));
      }
      fs.writeFileSync(decisionPath, JSON.stringify(decisionArtifact, null, 2), 'utf8');

      // Update knowledge base with decision (include investigation tags if any)
      const kbTags = [area, decision.verdict];
      if (sessionInvestigations.count > 0) {
        kbTags.push('investigation');
        for (const d of sessionInvestigations.diagnoses) {
          if (!kbTags.includes(d.diagnosis)) kbTags.push(d.diagnosis);
          if (!kbTags.includes(d.phase)) kbTags.push(d.phase);
        }
      }
      addEntry(kb, {
        round,
        date: dateStr,
        area,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- runtime safety
        finding: deliberation.selectedImprovement,
        applicability:
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
          (deliberation.priority as { expectedImpact?: string } | null)?.expectedImpact ?? 'medium',
        attempted: true,
        outcome: decision.verdict,
        score: analysis.aggregateScore,
        learnings: decision.reason,
        tags: kbTags,
      });

      // ── Update suggestion backlog ───────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      if (roundResult.suggestionId) {
        // This round used a suggestion — update its status
        const sg = loadSuggestions(evolveDir);
        const sug = getSuggestionById(sg, roundResult.suggestionId);
        if (sug) {
          const newAttempts = (sug.attempts || 0) + 1; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
          const sugUpdates: {
            attempts: number;
            lastAttemptDate: string;
            lastAttemptVerdict: string;
            lastAttemptScore: number;
            lastAttemptLearnings: string;
            status?: string;
            notes?: string;
          } = {
            attempts: newAttempts,
            lastAttemptDate: dateStr,
            lastAttemptVerdict: decision.verdict,
            lastAttemptScore: analysis.aggregateScore,
            lastAttemptLearnings: decision.reason,
          };

          if (decision.verdict === 'approve') {
            sugUpdates.status = 'completed';
          } else if (
            newAttempts >=
            (sug.maxAttempts || evolveConfig.suggestions?.maxAttemptsPerSuggestion || 3) // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
          ) {
            sugUpdates.status = 'rejected';
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
            sugUpdates.notes = `${sug.notes ? `${sug.notes}\n` : ''}Exhausted max attempts (${String(newAttempts)}).`;
          } else {
            sugUpdates.status = 'pending'; // Return to queue
            // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
            sugUpdates.notes = `${sug.notes ? `${sug.notes}\n` : ''}Attempt ${String(newAttempts)}: ${decision.verdict} (${String(analysis.aggregateScore)}/10).`;
          }

          updateSuggestion(sg, roundResult.suggestionId, sugUpdates);
          saveSuggestions(evolveDir, sg);
        }
      } else if (
        (decision.verdict === 'reject' || decision.verdict === 'revise') &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/strict-boolean-expressions -- runtime safety
        deliberation.selectedImprovement &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
        deliberation.selectedImprovement !== 'No improvement selected' &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
        deliberation.selectedImprovement.length >= 10 &&
        evolveConfig.suggestions?.autoPopulateFromRejected !== false
      ) {
        // Auto-create suggestion from rejected round with valid improvement
        const sg = loadSuggestions(evolveDir);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- runtime safety
        const created = createSuggestionFromRound(sg, roundResult as any, deliberation, {
          sessionId,
          specPath: path.join(evolveDir, 'specs', `ROUND_${String(round)}_SPEC.md`),
          notes: `Auto-created from rejected round ${String(round)}. Reason: ${decision.reason}`,
        });
        if (created) {
          saveSuggestions(evolveDir, sg);
          log.dim(
            `Suggestion backlogged: ${String(created.id)} — ${(created.title ?? '').slice(0, 60)}`,
          );
        }
      }

      const stats = getBranchStats(projectRoot, branchName, baseBranch);
      log.ok(
        `Round ${String(round)} complete: ${decision.verdict.toUpperCase()} | ${String(stats.commits)} commits | ${String(stats.filesChanged)} files`,
      );

      // ── Hot-restart: self-modification detected ───────────────────────
      if (
        decision.verdict === 'approve' &&
        didModifyHydraCode(projectRoot, branchName, baseBranch)
      ) {
        log.info(pc.yellow('Self-modification detected — initiating hot-restart'));

        // 1. Merge approved branch to base using smart merge
        const mergeResult = smartMerge(projectRoot, branchName, baseBranch, { log });
        if (mergeResult.ok) {
          log.ok(`Merged ${branchName} → ${baseBranch} (${mergeResult.method})`);
          roundResult.merged = true;
          roundResult.mergeMethod = mergeResult.method;

          // Record this round before saving checkpoint
          roundResult.durationMs = Date.now() - roundStart;
          roundResults.push(roundResult);
          budget.recordRoundEnd(round, area, roundResult.durationMs);

          // 2. Save knowledge base (so new process has latest data)
          saveKnowledgeBase(evolveDir, kb);

          // 3. Save session checkpoint
          const cpPath = saveCheckpoint(evolveDir, {
            sessionId,
            startedAt,
            dateStr,
            projectRoot,
            baseBranch,
            maxRounds,
            maxHoursMs,
            focusAreas,
            timeouts,
            budgetOverrides: {},
            budgetState: budget.serialize(),
            completedRounds: roundResults,
            lastRoundNum: round,
            kbStartCount,

            activeSuggestionId: activeSuggestionId ?? null,
            reason: 'hot-restart after approved self-modification',
          });
          log.ok(`Checkpoint saved: ${cpPath}`);

          // 4. Destroy status bar and spawn new process
          destroyStatusBar();
          spawnNewProcess(projectRoot);
          log.info('Exiting for hot-restart...');
          process.exitCode = 0; // eslint-disable-line require-atomic-updates -- intentional

          return;
        } else {
          log.error(`Merge failed — ${String(mergeResult.conflicts.length)} conflicting file(s):`);
          for (const f of mergeResult.conflicts.slice(0, 10)) {
            log.dim(`  ${f}`);
          }
          log.info(`Branch ${branchName} preserved for manual resolution`);
          roundResult.learnings += ` | Merge conflict: ${mergeResult.conflicts.join(', ')}`;
          roundResult.mergeConflicts = mergeResult.conflicts;
          // Continue without hot-restart — branch stays for manual merge
        }
      }
    } catch (err: unknown) {
      log.error(
        `Round ${String(round)} error: ${err instanceof Error ? err.message : String(err)}`,
      );
      roundResult.verdict = 'error';
      roundResult.learnings = err instanceof Error ? err.message : String(err);
    }

    // Return to base branch
    const currentAfterRound = getCurrentBranch(projectRoot);
    if (currentAfterRound !== baseBranch) {
      checkoutBranch(projectRoot, baseBranch);
    }

    roundResult.durationMs = Date.now() - roundStart;
    roundResults.push(roundResult);
    budget.recordRoundEnd(round, area, roundResult.durationMs);

    // ── Incremental session state save ─────────────────────────────────
    const approved = roundResults.filter((r: RoundResult) => r.verdict === 'approve').length;
    const rejected = roundResults.filter((r: RoundResult) => r.verdict === 'reject').length;
    const skippedSoFar = roundResults.filter((r: RoundResult) => r.verdict === 'skipped').length;
    const errorsSoFar = roundResults.filter((r: RoundResult) => r.verdict === 'error').length;
    saveSessionState(evolveDir, {
      sessionId,
      status: 'running',
      startedAt,
      dateStr,
      maxRounds,
      maxHours: maxHoursMs / (60 * 60 * 1000),
      focusAreas,
      timeouts,
      kbStartCount,
      completedRounds: roundResults,
      nextRound: round + 1,
      resumable: false,
      activeSuggestionId: activeSuggestionId ?? null,
      summary: {
        approved,
        rejected,
        skipped: skippedSoFar,
        errors: errorsSoFar,
        totalKBAdded: kb.entries.length - kbStartCount,
      },
      budgetState: budget.serialize(),
    });
  }

  // ── Destroy status bar ──────────────────────────────────────────────────
  destroyStatusBar();

  // ── Always return to base branch ──────────────────────────────────────
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  // ── Auto-merge approved branches ──────────────────────────────────────
  for (const r of roundResults) {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.verdict === 'approve' && r.branchName && !r.merged) {
      log.info(`Merging approved branch: ${r.branchName}`);
      checkoutBranch(projectRoot, baseBranch);
      const result = smartMerge(projectRoot, r.branchName, baseBranch, { log });
      r.merged = result.ok;
      r.mergeMethod = result.method;
      if (result.ok) {
        log.ok(`Merged ${r.branchName} → ${baseBranch} (${result.method})`);
      } else {
        log.warn(
          `Could not auto-merge ${r.branchName} — ${String(result.conflicts.length)} conflict(s)`,
        );
        for (const f of result.conflicts.slice(0, 5)) log.dim(`  ${f}`);
        r.mergeConflicts = result.conflicts;
      }
    }
  }
  // Ensure we're on base branch after merge attempts
  const postMergeBranch = getCurrentBranch(projectRoot);
  if (postMergeBranch !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  // ── Finalize suggestions backlog ─────────────────────────────────────
  // Reset any suggestions stuck in 'exploring' status (safety net)
  {
    const sg = loadSuggestions(evolveDir);
    let resetCount = 0;
    for (const entry of sg.entries) {
      if (entry.status === 'exploring') {
        entry.status = 'pending';
        resetCount++;
      }
    }
    if (resetCount > 0) {
      saveSuggestions(evolveDir, sg);
      log.dim(`Reset ${String(resetCount)} suggestion(s) from exploring → pending`);
    }
  }

  // ── Save knowledge base ───────────────────────────────────────────────
  saveKnowledgeBase(evolveDir, kb);
  log.ok('Knowledge base saved');

  // ── Generate reports ──────────────────────────────────────────────────
  const finishedAt = Date.now();
  const budgetSummary = budget.getSummary();
  const kbDelta = { added: kb.entries.length - kbStartCount, total: kb.entries.length };
  const runMeta = {
    startedAt,
    finishedAt,
    dateStr,
    maxRounds,
    processedRounds: roundResults.length,
    stopReason,
  };

  const investigatorSummary = isInvestigatorAvailable() ? getInvestigatorStats() : null;
  const mdReport = generateSessionReport(
    roundResults,
    budgetSummary,
    runMeta,
    kbDelta,
    investigatorSummary,
  );
  const jsonReport = generateSessionJSON(
    roundResults,
    budgetSummary,
    runMeta,
    kbDelta,
    investigatorSummary,
  );

  const mdPath = path.join(evolveDir, `EVOLVE_${dateStr}.md`);
  const jsonPath = path.join(evolveDir, `EVOLVE_${dateStr}.json`);

  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);

  // ── Finalize session state ──────────────────────────────────────────
  const finalStatus = computeSessionStatus(roundResults, maxRounds, stopReason, false);
  const actionNeeded = computeActionNeeded(roundResults, maxRounds, finalStatus);
  const finalApproved = roundResults.filter((r: RoundResult) => r.verdict === 'approve').length;
  const finalRejected = roundResults.filter((r: RoundResult) => r.verdict === 'reject').length;
  const finalSkipped = roundResults.filter((r: RoundResult) => r.verdict === 'skipped').length;
  const finalErrors = roundResults.filter((r: RoundResult) => r.verdict === 'error').length;

  saveSessionState(evolveDir, {
    sessionId,
    status: finalStatus,
    startedAt,
    finishedAt,
    dateStr,
    maxRounds,
    maxHours: maxHoursMs / (60 * 60 * 1000),
    focusAreas,
    timeouts,
    kbStartCount,
    completedRounds: roundResults,
    nextRound:
      roundResults.length + startRound > maxRounds ? undefined : roundResults.length + startRound,
    resumable: finalStatus === 'partial' || finalStatus === 'failed',
    stopReason,
    actionNeeded,
    summary: {
      approved: finalApproved,
      rejected: finalRejected,
      skipped: finalSkipped,
      errors: finalErrors,
      totalKBAdded: kbDelta.added,
    },
    budgetState: budget.serialize(),
  });

  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  log.info(`Session status: ${finalStatus}${actionNeeded ? ` — ${actionNeeded}` : ''}`);

  // ── Summary ───────────────────────────────────────────────────────────
  const approved = finalApproved;
  const rejected = finalRejected;
  const revised = roundResults.filter((r: RoundResult) => r.verdict === 'revise').length;
  const errors = finalErrors;
  const skipped = finalSkipped;
  const totalTokens = budgetSummary.consumed;

  const W = 64; // box width
  const hr = pc.dim('─'.repeat(W));
  const dhr = pc.cyan('═'.repeat(W));

  console.log('');
  console.log(dhr);
  console.log(pc.bold(pc.cyan('  EVOLVE SESSION COMPLETE')));
  console.log(dhr);
  console.log('');

  // ── Per-round detail ──────────────────────────────────────────────
  for (const r of roundResults) {
    let verdictColor;
    if (r.verdict === 'approve') {
      verdictColor = pc.green;
    } else if (r.verdict === 'reject' || r.verdict === 'error') {
      verdictColor = pc.red;
    } else if (r.verdict === 'revise') {
      verdictColor = pc.yellow;
    } else {
      verdictColor = pc.dim;
    }
    const tag = verdictColor(pc.bold((r.verdict ?? 'incomplete').toUpperCase()));
    const scoreStr = r.score == null ? '' : pc.dim(` score:${String(r.score)}/10`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const dur = r.durationMs ? pc.dim(` ${formatDuration(r.durationMs)}`) : '';

    console.log(`  ${pc.bold(pc.cyan(`Round ${String(r.round)}`))} ${pc.dim('·')} ${r.area}`);
    console.log(`    ${tag}${scoreStr}${dur}`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.selectedImprovement && r.selectedImprovement !== 'No improvement selected') {
      console.log(`    ${pc.dim('Goal:')} ${r.selectedImprovement.slice(0, 80)}`);
    }
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.branchName) {
      console.log(`    ${pc.dim('Branch:')} ${r.branchName}`);
    }
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.learnings) {
      console.log(`    ${pc.dim('Note:')} ${r.learnings.slice(0, 80)}`);
    }
    console.log('');
  }

  console.log(hr);

  // ── Aggregate stats ───────────────────────────────────────────────
  const verdictLine = [
    approved > 0 ? pc.green(`${String(approved)} approved`) : null,
    revised > 0 ? pc.yellow(`${String(revised)} revised`) : null,
    rejected > 0 ? pc.red(`${String(rejected)} rejected`) : null,
    errors > 0 ? pc.red(`${String(errors)} error`) : null,
    skipped > 0 ? pc.dim(`${String(skipped)} skipped`) : null,
  ]
    .filter(Boolean)
    .join(pc.dim(' / '));

  console.log(
    `  ${pc.bold('Rounds')}      ${String(roundResults.length)}/${String(maxRounds)}  ${verdictLine}`,
  );
  console.log(`  ${pc.bold('Duration')}    ${formatDuration(finishedAt - startedAt)}`);
  console.log(`  ${pc.bold('Tokens')}      ~${totalTokens.toLocaleString()} consumed`);
  console.log(
    `  ${pc.bold('Knowledge')}   +${String(kbDelta.added)} entries (${String(kbDelta.total)} total)`,
  );

  if (investigatorSummary && investigatorSummary.investigations > 0) {
    const invTokens = investigatorSummary.promptTokens + investigatorSummary.completionTokens;
    console.log(
      `  ${pc.bold('Investigator')} ${String(investigatorSummary.investigations)} triggered, ${String(investigatorSummary.healed)} healed (~${invTokens.toLocaleString()} tokens)`,
    );
  }

  if (budgetSummary.roundDeltas.length > 0) {
    console.log('');
    console.log(`  ${pc.dim('Per-round tokens:')}`);
    for (const d of budgetSummary.roundDeltas) {
      const bar = compactTokenBar(d.tokens, budgetSummary.hardLimit);
      console.log(
        `    R${String(d.round)} ${String(d.area).padEnd(24).slice(0, 24)} ${bar} ${d.tokens.toLocaleString().padStart(8)}`,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (stopReason) {
    console.log('');
    console.log(`  ${pc.yellow('Stopped:')} ${stopReason}`);
  }

  // ── Branches to review ────────────────────────────────────────────
  const mergedBranches = roundResults.filter(
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    (r: RoundResult) => r.branchName && r.verdict === 'approve' && r.merged,
  );
  const conflictBranches = roundResults.filter(
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    (r: RoundResult) => r.branchName && r.verdict === 'approve' && !r.merged,
  );

  if (mergedBranches.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.green('Merged branches:'))}`);
    for (const r of mergedBranches) {
      console.log(`    ${pc.green('✓')} ${String(r.branchName)} (${String(r.mergeMethod)})`);
    }
  }

  if (conflictBranches.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.yellow('Branches with conflicts (manual merge needed):'))}`);
    for (const r of conflictBranches) {
      const conflictCount = r.mergeConflicts?.length ?? 0;
      console.log(
        `    ${pc.yellow('!')} ${String(r.branchName)}${conflictCount > 0 ? ` — ${String(conflictCount)} file(s)` : ''}`,
      );
      console.log(`      ${pc.dim('run:')} git merge ${String(r.branchName)}`);
    }
  }

  const branchesForReview = roundResults.filter(
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    (r: RoundResult) => r.branchName && r.verdict === 'revise',
  );
  if (branchesForReview.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.yellow('Branches needing revision:'))}`);
    for (const r of branchesForReview) {
      console.log(`    ${pc.yellow('~')} git diff ${baseBranch}...${String(r.branchName)}`);
    }
  }

  console.log('');
  console.log(hr);
  console.log(`  ${pc.dim('Report:')} ${mdPath}`);
  console.log(`  ${pc.dim('Data:')}   ${jsonPath}`);
  console.log(dhr);
  console.log('');
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  try {
    destroyStatusBar();
  } catch {
    /* best effort */
  }
  // Save interrupted session state so it can be resumed
  try {
    const projectRoot = process.cwd();
    const pCfg = resolveProject({ project: projectRoot });
    const evolveDir = path.join(pCfg.coordDir, 'evolve');

    const existingState = loadSessionState(evolveDir);

    if (existingState?.status === 'running') {
      existingState.status = 'interrupted';

      existingState.resumable = true;

      existingState.actionNeeded = `Interrupted: ${err instanceof Error ? err.message : String(err)}. Resume with :evolve resume`;

      existingState.interruptedAt = Date.now();
      saveSessionState(evolveDir, existingState);
      log.warn('Session state saved as interrupted — resume with :evolve resume');
    }
  } catch {
    /* best effort */
  }
  // Always try to get back to base branch
  try {
    const cfg = loadHydraConfig();
    const baseBranch = cfg.evolve?.baseBranch ?? 'dev';
    const projectRoot = process.cwd();
    const branch = getCurrentBranch(projectRoot);
    if (branch !== baseBranch && branch.startsWith('evolve/')) {
      checkoutBranch(projectRoot, baseBranch);
    }
  } catch {
    /* last resort */
  }
  process.exitCode = 1;
});
