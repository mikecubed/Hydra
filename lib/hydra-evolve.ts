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
import type { EvolveConfig } from './types.ts';
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

function countVerdictVotes(agentVerdicts: Record<string, string | null>): {
  approvals: number;
  rejections: number;
  totalVoters: number;
} {
  const verdictEntries = Object.entries(agentVerdicts || {}).filter(([, v]) => v != null); // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
  return {
    approvals: verdictEntries.filter(([, v]) => v === 'approve').length,
    rejections: verdictEntries.filter(([, v]) => v === 'reject').length,
    totalVoters: verdictEntries.length,
  };
}

function buildVerdictParts(
  agentVerdicts: Record<string, string | null>,
  agentScores: Record<string, unknown>,
): string[] {
  const parts: string[] = [];
  for (const agent of ['claude', 'gemini', 'codex']) {
    const v = agentVerdicts[agent];
    const s = (agentScores[agent] as Record<string, unknown> | null)?.['quality'] as
      | number
      | undefined;
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (v || s != null) {
      parts.push(`${agent[0].toUpperCase() + agent.slice(1)}: ${v ?? '?'}(${String(s ?? '?')})`);
    }
  }
  return parts;
}

function determineVerdictAndReason(
  aggregateScore: number,
  testsPassed: boolean,
  concerns: string[],
  approvals: number,
  rejections: number,
  totalVoters: number,
  minScore: number,
  requireAllTests: boolean,
): { verdict: string; reason: string } {
  const hasCriticalConcerns = concerns.some((c: string) =>
    /critical|breaking|security|data.?loss/i.test(c),
  );
  if (hasCriticalConcerns) {
    const criticalList = concerns
      .filter((c: string) => /critical|breaking|security|data.?loss/i.test(c))
      .join('; ');
    return { verdict: 'reject', reason: `Critical concerns identified: ${criticalList}` };
  }
  if (requireAllTests && !testsPassed) {
    return { verdict: 'reject', reason: 'Tests did not pass' };
  }
  if (rejections >= 2 && totalVoters >= 2) {
    return {
      verdict: 'reject',
      reason: `Majority reject (${String(rejections)}/${String(totalVoters)} agents) — score ${String(aggregateScore)}/10`,
    };
  }
  if (approvals >= 2 && totalVoters >= 2 && aggregateScore >= minScore - 1) {
    return {
      verdict: 'approve',
      reason: `Majority approve (${String(approvals)}/${String(totalVoters)} agents) — score ${String(aggregateScore)}/10, tests ${testsPassed ? 'passed' : 'N/A'}`,
    };
  }
  if (aggregateScore >= minScore) {
    return {
      verdict: 'approve',
      reason: `Score ${String(aggregateScore)}/10 meets minimum ${String(minScore)}/10, tests ${testsPassed ? 'passed' : 'N/A'}`,
    };
  }
  if (aggregateScore >= minScore - 2) {
    return {
      verdict: 'revise',
      reason: `Score ${String(aggregateScore)}/10 is close but below minimum ${String(minScore)}/10`,
    };
  }
  return {
    verdict: 'reject',
    reason: `Score ${String(aggregateScore)}/10 is below minimum ${String(minScore)}/10`,
  };
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
  const { approvals, rejections, totalVoters } = countVerdictVotes(agentVerdicts);
  const agentScores = analysis.agentScores ?? {};
  const verdictParts = buildVerdictParts(agentVerdicts, agentScores);
  const { verdict, reason } = determineVerdictAndReason(
    aggregateScore,
    testsPassed,
    concerns,
    approvals,
    rejections,
    totalVoters,
    minScore,
    requireAllTests,
  );
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

function generateSingleRoundLines(r: RoundResult): string[] {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const resultTag = r.verdict ? r.verdict.toUpperCase() : 'INCOMPLETE';
  const lines: string[] = [
    `## Round ${String(r.round)}: ${r.area}`,
    `- Research: ${r.researchSummary ?? 'N/A'}`,
    `- Selected: ${r.selectedImprovement ?? 'N/A'}`,
  ];
  if (r.testsWritten !== undefined) lines.push(`- Tests written: ${String(r.testsWritten)}`);
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
  if (r.branchName) lines.push(`- Branch: ${r.branchName}`);
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (r.learnings) lines.push(`- Learnings: ${r.learnings}`);
  if (r.investigations && r.investigations.count > 0) {
    lines.push(
      `- Investigations: ${String(r.investigations.count)} (healed: ${String(r.investigations.healed)})`,
    );
  }
  lines.push('');
  return lines;
}

function generateRoundSummaryLines(roundResults: RoundResult[]): string[] {
  const lines: string[] = [];
  for (const r of roundResults) {
    lines.push(...generateSingleRoundLines(r));
  }
  return lines;
}

function generateBudgetSummaryLines(budgetSummary: {
  consumed: number;
  hardLimit: number;
  avgPerRound: number;
  startTokens: number;
  endTokens: number;
  roundDeltas: Array<{ round: unknown; area: unknown; tokens: number; durationMs: unknown }>;
}): string[] {
  const lines = [
    '## Budget Summary',
    `- Start tokens: ${budgetSummary.startTokens.toLocaleString()}`,
    `- End tokens: ${budgetSummary.endTokens.toLocaleString()}`,
    `- Consumed: ${budgetSummary.consumed.toLocaleString()}`,
    `- Budget limit: ${budgetSummary.hardLimit.toLocaleString()}`,
    `- Avg per round: ${budgetSummary.avgPerRound.toLocaleString()}`,
  ];
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
  return lines;
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
    ...generateRoundSummaryLines(roundResults),
    '## Knowledge Base Growth',
    `- New entries: ${String(kbDelta.added)}`,
    `- Cumulative: ${String(kbDelta.total)} entries`,
    '',
  ];
  if (investigatorSummary && investigatorSummary.investigations > 0) {
    lines.push('## Self-Healing Investigator');
    lines.push(`- Investigations triggered: ${String(investigatorSummary.investigations)}`);
    lines.push(`- Healed (retry succeeded): ${String(investigatorSummary.healed)}`);
    lines.push(
      `- Investigator tokens: ~${(investigatorSummary.promptTokens + investigatorSummary.completionTokens).toLocaleString()}`,
    );
    lines.push('');
  }
  lines.push(...generateBudgetSummaryLines(budgetSummary));
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

type KnowledgeBase = ReturnType<typeof loadKnowledgeBase>;

type EvolveSessionVars = {
  startedAt: number;
  dateStr: string;
  sessionId: string;
  maxRounds: number;
  maxHoursMs: number;
  focusAreas: string[];
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS;
  roundResults: RoundResult[];
  kbStartCount: number;
  startRound: number;
  budget: EvolveBudgetTracker;
};

type EvolveRoundContext = {
  round: number;
  roundStart: number;
  area: string;
  roundResult: RoundResult;
  kb: KnowledgeBase;
  session: EvolveSessionVars;
  evolveDir: string;
  projectRoot: string;
  baseBranch: string;
  evolveConfig: EvolveConfig;
  activeSuggestion: SuggestionEntry | null;
  activeSuggestionId: string | null;
  reducedScope: boolean;
};

function resolveEvolveProject(options: Record<string, unknown>) {
  try {
    return resolveProject({ project: options['project'] as string | undefined });
  } catch (err: unknown) {
    log.error(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return null;
  }
}

function validateEvolvePreconditions(projectRoot: string, baseBranch: string): boolean {
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${baseBranch}' branch (currently on '${currentBranch}')`);
    process.exitCode = 1;
    return false;
  }
  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exitCode = 1;
    return false;
  }
  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);
  return true;
}

function initEvolveDirectories(coordDir: string): string {
  const evolveDir = path.join(coordDir, 'evolve');
  ensureDir(evolveDir);
  ensureDir(path.join(evolveDir, 'research'));
  ensureDir(path.join(evolveDir, 'specs'));
  ensureDir(path.join(evolveDir, 'decisions'));
  if (isInvestigatorAvailable()) {
    initInvestigator();
    log.ok('Self-healing investigator initialized');
  } else {
    log.dim('Investigator not available (no OPENAI_API_KEY or disabled in config)');
  }
  return evolveDir;
}

function initSessionFromCheckpoint(
  checkpoint: NonNullable<ReturnType<typeof loadCheckpoint>>,
  _options: Record<string, unknown>,
  evolveDir: string,
): EvolveSessionVars {
  log.info(pc.yellow('Resuming evolve session from checkpoint...'));
  log.dim(`Reason: ${checkpoint.reason ?? 'hot-restart'}`);
  const startedAt = checkpoint.startedAt ?? Date.now();
  const dateStr = checkpoint.dateStr ?? '';
  const sessionId =
    checkpoint.sessionId ??
    `evolve_${dateStr === '' ? new Date().toISOString().slice(0, 10) : dateStr}_${randomBytes(3).toString('hex')}`;
  const maxRounds = checkpoint.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxHoursMs = checkpoint.maxHoursMs ?? DEFAULT_MAX_HOURS * 60 * 60 * 1000;
  const focusAreas = checkpoint.focusAreas ?? DEFAULT_FOCUS_AREAS;
  const timeouts = { ...DEFAULT_PHASE_TIMEOUTS, ...(checkpoint.timeouts ?? {}) };
  const roundResults = checkpoint.completedRounds ?? [];
  const kbStartCount = checkpoint.kbStartCount ?? 0;
  const startRound = (checkpoint.lastRoundNum ?? 0) + 1;
  let budget: EvolveBudgetTracker;
  if (checkpoint.budgetState) {
    budget = EvolveBudgetTracker.deserialize(checkpoint.budgetState);
    log.dim(
      `Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${String(budget.roundDeltas.length)} rounds`,
    );
  } else {
    budget = new EvolveBudgetTracker(checkpoint.budgetOverrides ?? {});
    budget.recordStart();
  }
  deleteCheckpoint(evolveDir);
  log.ok(`Checkpoint consumed, resuming from round ${String(startRound)}`);
  return {
    startedAt,
    dateStr,
    sessionId,
    maxRounds,
    maxHoursMs,
    focusAreas,
    timeouts,
    roundResults,
    kbStartCount,
    startRound,
    budget,
  };
}

function resolveBudgetFromState(
  existingState: NonNullable<ReturnType<typeof loadSessionState>>,
  options: Record<string, unknown>,
): EvolveBudgetTracker {
  if (existingState.budgetState) {
    const budget = EvolveBudgetTracker.deserialize(existingState.budgetState);
    log.dim(
      `Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${String(budget.roundDeltas.length)} rounds`,
    );
    return budget;
  }
  const budgetOverrides: { hardLimit?: number; softLimit?: number } = {};
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (options['hard-limit'])
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
    budgetOverrides.hardLimit = Number.parseInt(String(options['hard-limit']), 10);
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (options['soft-limit'])
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
    budgetOverrides.softLimit = Number.parseInt(String(options['soft-limit']), 10);
  const budget = new EvolveBudgetTracker(budgetOverrides);
  budget.recordStart();
  return budget;
}

function resolveStateScalars(
  existingState: NonNullable<ReturnType<typeof loadSessionState>>,
  evolveConfig: EvolveConfig,
  kb: KnowledgeBase,
): {
  sessionId: string;
  dateStr: string;
  roundResults: RoundResult[];
  kbStartCount: number;
  startRound: number;
  focusAreas: string[];
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS;
} {
  const roundResults = existingState.completedRounds ?? [];
  return {
    sessionId: existingState.sessionId ?? '',
    dateStr: existingState.dateStr ?? '',
    roundResults,
    kbStartCount:
      existingState.kbStartCount ?? kb.entries.length - (existingState.summary?.totalKBAdded ?? 0),
    startRound: existingState.nextRound ?? roundResults.length + 1,
    focusAreas: existingState.focusAreas ?? evolveConfig.focusAreas ?? DEFAULT_FOCUS_AREAS,
    timeouts: {
      ...DEFAULT_PHASE_TIMEOUTS,
      ...(existingState.timeouts ?? {}),
      ...(evolveConfig.phases ?? {}),
    } as typeof DEFAULT_PHASE_TIMEOUTS,
  };
}

function resolveStateLimits(
  existingState: NonNullable<ReturnType<typeof loadSessionState>>,
  evolveConfig: EvolveConfig,
  options: Record<string, unknown>,
): { maxRounds: number; maxHoursMs: number } {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety: options values may be undefined
  const maxRounds = options['max-rounds']
    ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
      Number.parseInt(String(options['max-rounds']), 10)
    : (existingState.maxRounds ?? evolveConfig.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const maxHoursMs =
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety: options values may be undefined
    (options['max-hours']
      ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
        Number.parseFloat(String(options['max-hours']))
      : (existingState.maxHours ?? evolveConfig.maxHours ?? DEFAULT_MAX_HOURS)) *
    60 *
    60 *
    1000;
  return { maxRounds, maxHoursMs };
}

function initSessionFromState(
  existingState: NonNullable<ReturnType<typeof loadSessionState>>,
  options: Record<string, unknown>,
  evolveConfig: EvolveConfig,
  kb: KnowledgeBase,
): EvolveSessionVars {
  log.info(pc.yellow('Resuming evolve session from session state...'));
  log.dim(`Session: ${existingState.sessionId ?? ''} (${existingState.status ?? ''})`);
  const { sessionId, dateStr, roundResults, kbStartCount, startRound, focusAreas, timeouts } =
    resolveStateScalars(existingState, evolveConfig, kb);
  const { maxRounds, maxHoursMs } = resolveStateLimits(existingState, evolveConfig, options);
  const startedAt = Date.now();
  const budget = resolveBudgetFromState(existingState, options);
  log.ok(`Session state restored, resuming from round ${String(startRound)}`);
  return {
    startedAt,
    dateStr,
    sessionId,
    maxRounds,
    maxHoursMs,
    focusAreas,
    timeouts,
    roundResults,
    kbStartCount,
    startRound,
    budget,
  };
}

function initFreshSession(
  checkpoint: ReturnType<typeof loadCheckpoint>,
  isResume: boolean,
  options: Record<string, unknown>,
  evolveConfig: EvolveConfig,
  kb: KnowledgeBase,
  evolveDir: string,
): EvolveSessionVars {
  if (checkpoint && !isResume) {
    log.warn('Stale checkpoint found but --resume not set. Starting fresh session.');
    deleteCheckpoint(evolveDir);
  }
  const startedAt = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];
  const sessionId = `evolve_${dateStr}_${randomBytes(3).toString('hex')}`;
  const startRound = 1;
  const roundResults: RoundResult[] = [];
  const kbStartCount = kb.entries.length;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const maxRounds = options['max-rounds']
    ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
      Number.parseInt(String(options['max-rounds']), 10)
    : evolveConfig.maxRounds || DEFAULT_MAX_ROUNDS; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
  const maxHoursMs =
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    (options['max-hours']
      ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
        Number.parseFloat(String(options['max-hours']))
      : evolveConfig.maxHours || DEFAULT_MAX_HOURS) * // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
    60 *
    60 *
    1000;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const focusAreas = options['focus']
    ? [options['focus'] as string]
    : (evolveConfig.focusAreas ?? DEFAULT_FOCUS_AREAS);
  const timeouts = {
    ...DEFAULT_PHASE_TIMEOUTS,
    ...(evolveConfig.phases ?? {}),
  } as typeof DEFAULT_PHASE_TIMEOUTS;
  const budgetOverrides: { hardLimit?: number; softLimit?: number } = {};
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (options['hard-limit'])
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
    budgetOverrides.hardLimit = Number.parseInt(String(options['hard-limit']), 10);
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (options['soft-limit'])
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- options values are string-compatible
    budgetOverrides.softLimit = Number.parseInt(String(options['soft-limit']), 10);
  const budget = new EvolveBudgetTracker(budgetOverrides);
  budget.recordStart();
  return {
    startedAt,
    dateStr,
    sessionId,
    maxRounds,
    maxHoursMs,
    focusAreas,
    timeouts,
    roundResults,
    kbStartCount,
    startRound,
    budget,
  };
}

function initSession(
  checkpoint: ReturnType<typeof loadCheckpoint>,
  isResume: boolean,
  existingState: ReturnType<typeof loadSessionState>,
  options: Record<string, unknown>,
  evolveConfig: EvolveConfig,
  kb: KnowledgeBase,
  evolveDir: string,
): EvolveSessionVars {
  if (checkpoint && isResume) {
    return initSessionFromCheckpoint(checkpoint, options, evolveDir);
  }
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (!checkpoint && isResume && existingState?.resumable) {
    return initSessionFromState(existingState, options, evolveConfig, kb);
  }
  return initFreshSession(checkpoint, isResume, options, evolveConfig, kb, evolveDir);
}

function handlePickSuggestion(
  suggestions: ReturnType<typeof loadSuggestions>,
  evolveDir: string,
  pick: { action: string; suggestion?: SuggestionEntry | null },
): { activeSuggestion: SuggestionEntry | null; activeSuggestionId: string | null } {
  const activeSuggestion = pick.suggestion ?? null;
  const activeSuggestionId = activeSuggestion?.id ?? null;
  updateSuggestion(suggestions, activeSuggestion?.id ?? '', { status: 'exploring' });
  saveSuggestions(evolveDir, suggestions);
  log.ok(`Using suggestion: ${(activeSuggestion?.title ?? '').slice(0, 80)}`);
  return { activeSuggestion, activeSuggestionId };
}

function handleFreeformSuggestion(
  suggestions: ReturnType<typeof loadSuggestions>,
  evolveDir: string,
  focusAreas: string[],
  text: string,
): { activeSuggestion: SuggestionEntry | null; activeSuggestionId: string | null } {
  const activeSuggestion = addSuggestion(suggestions, {
    source: 'user:manual',
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    area: focusAreas[0] || 'general',
    title: text.slice(0, 100),
    description: text,
    priority: 'high',
    tags: ['user-submitted'],
  });
  if (activeSuggestion) {
    const activeSuggestionId = activeSuggestion.id ?? null;
    updateSuggestion(suggestions, activeSuggestion.id ?? '', { status: 'exploring' });
    saveSuggestions(evolveDir, suggestions);
    log.ok(`Created suggestion: ${(activeSuggestion.title ?? '').slice(0, 80)}`);
    return { activeSuggestion, activeSuggestionId };
  }
  return { activeSuggestion: null, activeSuggestionId: null };
}

async function pickActiveSuggestion(
  evolveDir: string,
  suggestions: ReturnType<typeof loadSuggestions>,
  evolveConfig: EvolveConfig,
  focusAreas: string[],
): Promise<{ activeSuggestion: SuggestionEntry | null; activeSuggestionId: string | null }> {
  if (evolveConfig.suggestions?.enabled === false) {
    return { activeSuggestion: null, activeSuggestionId: null };
  }
  const pending = getPendingSuggestions(suggestions);
  if (pending.length === 0) return { activeSuggestion: null, activeSuggestionId: null };
  log.info(`${String(pending.length)} pending suggestion(s) in backlog`);
  const pick = await promptSuggestionPicker(pending, { maxDisplay: Math.min(5, pending.length) });
  if (pick.action === 'pick') {
    return handlePickSuggestion(suggestions, evolveDir, pick);
  }
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (pick.action === 'freeform' && pick.text) {
    return handleFreeformSuggestion(suggestions, evolveDir, focusAreas, pick.text);
  }
  log.dim(pick.action === 'discover' ? 'Agent discovery mode' : 'Skipped suggestions');
  return { activeSuggestion: null, activeSuggestionId: null };
}

function restoreActiveSuggestion(
  suggestions: ReturnType<typeof loadSuggestions>,
  existingState: ReturnType<typeof loadSessionState>,
  checkpoint: ReturnType<typeof loadCheckpoint>,
): { activeSuggestion: SuggestionEntry | null; activeSuggestionId: string | null } {
  const existingSugId = existingState?.activeSuggestionId ?? checkpoint?.activeSuggestionId;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (existingSugId) {
    const activeSuggestion = getSuggestionById(suggestions, existingSugId);
    if (activeSuggestion?.status === 'exploring') {
      log.dim(`Resumed with suggestion: ${(activeSuggestion.title ?? '').slice(0, 80)}`);
      return { activeSuggestion, activeSuggestionId: existingSugId };
    }
  }
  return { activeSuggestion: null, activeSuggestionId: null };
}

function saveRunningSessionState(
  evolveDir: string,
  session: EvolveSessionVars,
  activeSuggestionId: string | null,
): void {
  log.info(`Session: ${session.sessionId}`);
  log.info(`Budget: ${session.budget.hardLimit.toLocaleString()} token hard limit`);
  log.info(
    `Rounds: max ${String(session.maxRounds)} | Time: max ${formatDuration(session.maxHoursMs)}`,
  );
  saveSessionState(evolveDir, {
    sessionId: session.sessionId,
    status: 'running',
    startedAt: session.startedAt,
    dateStr: session.dateStr,
    maxRounds: session.maxRounds,
    maxHours: session.maxHoursMs / (60 * 60 * 1000),
    focusAreas: session.focusAreas,
    timeouts: session.timeouts,
    kbStartCount: session.kbStartCount,
    completedRounds: session.roundResults,
    nextRound: session.startRound,
    resumable: false,
    summary: { approved: 0, rejected: 0, skipped: 0, errors: 0, totalKBAdded: 0 },
    activeSuggestionId: activeSuggestionId ?? null,
    budgetState: session.budget.serialize(),
  });
}

function checkRoundBudgetGate(
  session: EvolveSessionVars,
  round: number,
): { breakLoop: boolean; stopReason: string | undefined; reducedScope: boolean } {
  if (Date.now() - session.startedAt > session.maxHoursMs) {
    log.warn(`Time limit reached (${formatDuration(session.maxHoursMs)}). Stopping.`);
    return { breakLoop: true, stopReason: 'time limit', reducedScope: false };
  }
  const budgetCheck = session.budget.check();
  if (budgetCheck.action === 'hard_stop') {
    log.error(`HARD STOP: ${budgetCheck.reason}`);
    return { breakLoop: true, stopReason: 'hard budget limit', reducedScope: false };
  }
  if (budgetCheck.action === 'soft_stop') {
    log.warn(`SOFT STOP: ${budgetCheck.reason}`);
    return { breakLoop: true, stopReason: 'soft budget limit', reducedScope: false };
  }
  if (budgetCheck.action === 'reduce_scope') log.warn(budgetCheck.reason);
  if (budgetCheck.action === 'warn') log.warn(budgetCheck.reason);
  if (!budgetCheck.canFitNextRound && round > 1) {
    log.warn(
      `Predicted next round (~${budgetCheck.avgPerRound.toLocaleString()} tokens) would exceed remaining budget. Stopping.`,
    );
    return { breakLoop: true, stopReason: 'predicted budget exceeded', reducedScope: false };
  }
  return {
    breakLoop: false,
    stopReason: undefined,
    reducedScope: budgetCheck.action === 'reduce_scope',
  };
}

function selectRoundArea(
  round: number,
  session: EvolveSessionVars,
  activeSuggestion: SuggestionEntry | null,
): string {
  const { focusAreas, roundResults, startRound } = session;
  const usingSuggestion = activeSuggestion !== null && round === startRound;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- usingSuggestion implies activeSuggestion !== null but TypeScript doesn't narrow through bool vars
  if (usingSuggestion && activeSuggestion !== null) {
    return activeSuggestion.area ?? focusAreas[0] ?? 'general'; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- defensive fallback
  }
  const recentAreas = roundResults.map((r: RoundResult) => r.area);
  const areaIndex = (round - 1) % focusAreas.length;
  let area = focusAreas[areaIndex];
  if (focusAreas.length > 1 && recentAreas.includes(area)) {
    area = focusAreas.find((a: string) => !recentAreas.includes(a)) ?? area;
  }
  return area;
}

function initRoundResult(
  round: number,
  area: string,
  activeSuggestion: SuggestionEntry | null,
  activeSuggestionId: string | null,
  startRound: number,
): RoundResult {
  const usingSuggestion = activeSuggestion !== null && round === startRound;
  return {
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
}

function saveIncrementalState(
  evolveDir: string,
  session: EvolveSessionVars,
  activeSuggestionId: string | null,
  kb: KnowledgeBase,
  round: number,
): void {
  const approved = session.roundResults.filter((r: RoundResult) => r.verdict === 'approve').length;
  const rejected = session.roundResults.filter((r: RoundResult) => r.verdict === 'reject').length;
  const skipped = session.roundResults.filter((r: RoundResult) => r.verdict === 'skipped').length;
  const errors = session.roundResults.filter((r: RoundResult) => r.verdict === 'error').length;
  saveSessionState(evolveDir, {
    sessionId: session.sessionId,
    status: 'running',
    startedAt: session.startedAt,
    dateStr: session.dateStr,
    maxRounds: session.maxRounds,
    maxHours: session.maxHoursMs / (60 * 60 * 1000),
    focusAreas: session.focusAreas,
    timeouts: session.timeouts,
    kbStartCount: session.kbStartCount,
    completedRounds: session.roundResults,
    nextRound: round + 1,
    resumable: false,
    activeSuggestionId: activeSuggestionId ?? null,
    summary: {
      approved,
      rejected,
      skipped,
      errors,
      totalKBAdded: kb.entries.length - session.kbStartCount,
    },
    budgetState: session.budget.serialize(),
  });
}

async function runTestPhaseWithInvestigation(
  plan: Awaited<ReturnType<typeof phasePlan>>,
  branchName: string,
  safetyPrompt: string,
  projectRoot: string,
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS,
): Promise<Awaited<ReturnType<typeof phaseTest>>> {
  let testResult = await phaseTest(plan, branchName, safetyPrompt, { cwd: projectRoot, timeouts });
  if (testResult.ok) return testResult;
  const usageCheck = detectUsageLimitError(
    'codex',
    testResult as unknown as Record<string, unknown>,
  );
  if (usageCheck.isUsageLimit) {
    const resetLabel = formatResetTime(usageCheck.resetInSeconds);
    log.warn(
      `Test phase: codex usage limit reached (resets in ${resetLabel}) — skipping investigation`,
    );
    disabledAgents.add('codex');
    return testResult;
  }
  if (!isInvestigatorAvailable()) return testResult;
  log.info('Test phase failed — investigating...');
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
    testResult = await phaseTest(plan, branchName, safetyPrompt, {
      cwd: projectRoot,
      timeouts,
      investigatorPreamble:
        testDiag.retryRecommendation.preamble ?? testDiag.corrective ?? undefined,
    });
  }
  return testResult;
}

async function runImplementInvestigation(
  implResult: Awaited<ReturnType<typeof phaseImplement>>,
  plan: Awaited<ReturnType<typeof phasePlan>>,
  branchName: string,
  safetyPrompt: string,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  projectRoot: string,
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS,
): Promise<Awaited<ReturnType<typeof phaseImplement>>> {
  log.info('Implement phase failed — investigating...');
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
    return phaseImplement(plan, branchName, safetyPrompt, {
      cwd: projectRoot,
      timeouts,
      deliberation,
      investigatorPreamble:
        implDiag.retryRecommendation.preamble ?? implDiag.corrective ?? undefined,
    });
  }
  return implResult;
}

async function runImplementPhaseWithInvestigation(
  plan: Awaited<ReturnType<typeof phasePlan>>,
  branchName: string,
  safetyPrompt: string,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  projectRoot: string,
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS,
): Promise<Awaited<ReturnType<typeof phaseImplement>>> {
  let implResult = await phaseImplement(plan, branchName, safetyPrompt, {
    cwd: projectRoot,
    timeouts,
    deliberation,
  });
  if (implResult.ok) return implResult;
  const usageCheck = detectUsageLimitError(
    'codex',
    implResult as unknown as Record<string, unknown>,
  );
  if (usageCheck.isUsageLimit) {
    log.warn(
      `Implement phase: codex usage limit reached (resets in ${formatResetTime(usageCheck.resetInSeconds)}) — skipping investigation`,
    );
    disabledAgents.add('codex');
  } else if (isInvestigatorAvailable()) {
    implResult = await runImplementInvestigation(
      implResult,
      plan,
      branchName,
      safetyPrompt,
      deliberation,
      projectRoot,
      timeouts,
    );
  }
  if (!implResult.ok && !disabledAgents.has('claude')) {
    log.warn('Implement: all Codex attempts failed — falling back to Claude...');
    const fallbackResult = await phaseImplement(plan, branchName, safetyPrompt, {
      cwd: projectRoot,
      timeouts,
      deliberation,
      agentOverride: 'claude',
    });
    if (fallbackResult.ok) {
      implResult = fallbackResult;
      log.dim(`Implement (Claude fallback): OK (${formatDuration(implResult.durationMs)})`);
    } else {
      log.warn('Implement (Claude fallback): also failed — proceeding with failed impl');
    }
  }
  return implResult;
}

async function runCorrectiveFix(
  analyzeDiag: { rootCause: string; corrective: string | null },
  td: { failures: Array<{ name: string; error?: string | null }> },
  safetyPrompt: string,
  projectRoot: string,
  branchName: string,
  baseBranch: string,
  plan: Awaited<ReturnType<typeof phasePlan>>,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS,
): Promise<Awaited<ReturnType<typeof phaseAnalyze>>> {
  log.info('Running corrective implementation pass...');
  let failingTestsSection = '';
  if (td.failures.length > 0) {
    failingTestsSection = `\n## Failing Tests\n${td.failures
      .slice(0, 10)
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      .map((f) => `- **${f.name}**${f.error ? `: ${f.error}` : ''}`)
      .join('\n')}\n`;
  }
  const fixPrompt = `# Corrective Fix — Tests Failing\n\nThe tests on this branch are failing. The investigator diagnosed the issue:\n\n**Root cause:** ${analyzeDiag.rootCause}\n**Corrective action:** ${analyzeDiag.corrective ?? ''}\n${failingTestsSection}\nFix the implementation to make the tests pass. Run \`node --test\` to verify.\n\n${safetyPrompt}`;
  await executeAgent('codex', fixPrompt, {
    cwd: projectRoot,
    timeoutMs: timeouts.implementTimeoutMs,
    phaseLabel: 'analyze: corrective fix',
  });
  const newDiff = getBranchDiff(projectRoot, branchName, baseBranch);
  const analysis = await phaseAnalyze(newDiff, branchName, plan, {
    cwd: projectRoot,
    timeouts,
    deliberation,
  });
  return analysis;
}

async function runAnalyzePhaseWithInvestigation(
  diff: string,
  branchName: string,
  plan: Awaited<ReturnType<typeof phasePlan>>,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  projectRoot: string,
  timeouts: typeof DEFAULT_PHASE_TIMEOUTS,
  safetyPrompt: string,
  baseBranch: string,
): Promise<Awaited<ReturnType<typeof phaseAnalyze>>> {
  let analysis = await phaseAnalyze(diff, branchName, plan, {
    cwd: projectRoot,
    timeouts,
    deliberation,
  });
  if (analysis.testsPassed || !isInvestigatorAvailable()) return analysis;
  const td = analysis.testDetails || {}; // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const errorSummary = td.summary
    ? `Tests failed: ${td.summary}`
    : 'Tests failed during analysis phase';
  const failureContext =
    td.failures.length > 0 ? `\nFailing tests: ${td.failures.map((f) => f.name).join(', ')}` : '';
  log.info('Tests failed in analysis — investigating...');
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
    analysis = await runCorrectiveFix(
      analyzeDiag,
      td,
      safetyPrompt,
      projectRoot,
      branchName,
      baseBranch,
      plan,
      deliberation,
      timeouts,
    );
  }
  return analysis;
}

function enrichRoundResult(
  roundResult: RoundResult,
  analysis: Awaited<ReturnType<typeof phaseAnalyze>>,
): void {
  roundResult.score = analysis.aggregateScore;
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
  if (sessionInvestigations.count > 0) {
    roundResult.investigations = { ...sessionInvestigations };
  }
}

function processDecision(
  ctx: EvolveRoundContext,
  decision: { verdict: string; reason: string; score: number },
  analysis: Awaited<ReturnType<typeof phaseAnalyze>>,
  violations: ReturnType<typeof scanBranchViolations>,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
): void {
  const { round, area, roundResult, kb, session, evolveDir } = ctx;
  const decisionPath = path.join(evolveDir, 'decisions', `ROUND_${String(round)}_DECISION.json`);
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
    improvement: deliberation.selectedImprovement,
    verdict: decision.verdict,
    reason: decision.reason,
    score: analysis.aggregateScore,
    confidence: analysis.aggregateConfidence ?? 0, // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- defensive fallback
    testsPassed: analysis.testsPassed,
    violations: violations.length,
    concerns: analysis.concerns,
    branchName: roundResult.branchName ?? '',
  };
  if (roundResult.testSummary) {
    decisionArtifact.testSummary = roundResult.testSummary;
    decisionArtifact.testFailures = (roundResult.testFailures ?? []).map((f: TestFailure) => ({
      name: f.name,
      error: f.error,
    }));
  }
  fs.writeFileSync(decisionPath, JSON.stringify(decisionArtifact, null, 2), 'utf8');
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
    date: session.dateStr,
    area,
    finding: deliberation.selectedImprovement,
    applicability:
      (deliberation.priority as { expectedImpact?: string } | null)?.expectedImpact ?? 'medium',
    attempted: true,
    outcome: decision.verdict,
    score: analysis.aggregateScore,
    learnings: decision.reason,
    tags: kbTags,
  });
}

function updateExistingSuggestion(
  evolveDir: string,
  roundResult: RoundResult,
  decision: { verdict: string; reason: string; score: number },
  analysis: Awaited<ReturnType<typeof phaseAnalyze>>,
  session: EvolveSessionVars,
  evolveConfig: EvolveConfig,
): void {
  const sg = loadSuggestions(evolveDir);
  const { suggestionId } = roundResult;
  if (suggestionId === null) return;
  const sug = getSuggestionById(sg, suggestionId);
  if (!sug) return;
  const newAttempts = (sug.attempts || 0) + 1; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
  const maxAllowed = sug.maxAttempts || evolveConfig.suggestions?.maxAttemptsPerSuggestion || 3; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
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
    lastAttemptDate: session.dateStr,
    lastAttemptVerdict: decision.verdict,
    lastAttemptScore: analysis.aggregateScore,
    lastAttemptLearnings: decision.reason,
  };
  if (decision.verdict === 'approve') {
    sugUpdates.status = 'completed';
  } else if (newAttempts >= maxAllowed) {
    sugUpdates.status = 'rejected';
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    sugUpdates.notes = `${sug.notes ? `${sug.notes}\n` : ''}Exhausted max attempts (${String(newAttempts)}).`;
  } else {
    sugUpdates.status = 'pending';
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    sugUpdates.notes = `${sug.notes ? `${sug.notes}\n` : ''}Attempt ${String(newAttempts)}: ${decision.verdict} (${String(analysis.aggregateScore)}/10).`;
  }
  updateSuggestion(sg, suggestionId, sugUpdates);
  saveSuggestions(evolveDir, sg);
}

function updateSuggestionAfterRound(
  ctx: EvolveRoundContext,
  decision: { verdict: string; reason: string; score: number },
  analysis: Awaited<ReturnType<typeof phaseAnalyze>>,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
): void {
  const { roundResult, evolveDir, session, evolveConfig } = ctx;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (roundResult.suggestionId) {
    updateExistingSuggestion(evolveDir, roundResult, decision, analysis, session, evolveConfig);
    return;
  }
  if (
    (decision.verdict === 'reject' || decision.verdict === 'revise') &&
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    deliberation.selectedImprovement &&
    deliberation.selectedImprovement !== 'No improvement selected' &&
    deliberation.selectedImprovement.length >= 10 &&
    evolveConfig.suggestions?.autoPopulateFromRejected !== false
  ) {
    const sg = loadSuggestions(evolveDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- runtime safety
    const created = createSuggestionFromRound(sg, roundResult as any, deliberation, {
      sessionId: session.sessionId,
      specPath: path.join(evolveDir, 'specs', `ROUND_${String(ctx.round)}_SPEC.md`),
      notes: `Auto-created from rejected round ${String(ctx.round)}. Reason: ${decision.reason}`,
    });
    if (created) {
      saveSuggestions(evolveDir, sg);
      log.dim(
        `Suggestion backlogged: ${String(created.id)} — ${(created.title ?? '').slice(0, 60)}`,
      );
    }
  }
}

function attemptHotRestart(
  ctx: EvolveRoundContext,
  _decision: { verdict: string; reason: string },
  roundResult: RoundResult,
  branchName: string,
): boolean {
  const { projectRoot, baseBranch, session, evolveDir, activeSuggestionId } = ctx;
  log.info(pc.yellow('Self-modification detected — initiating hot-restart'));
  const mergeResult = smartMerge(projectRoot, branchName, baseBranch, { log });
  if (!mergeResult.ok) {
    log.error(`Merge failed — ${String(mergeResult.conflicts.length)} conflicting file(s):`);
    for (const f of mergeResult.conflicts.slice(0, 10)) log.dim(`  ${f}`);
    log.info(`Branch ${branchName} preserved for manual resolution`);
    roundResult.learnings =
      `${roundResult.learnings ?? ''} | Merge conflict: ${mergeResult.conflicts.join(', ')}`.trim();
    roundResult.mergeConflicts = mergeResult.conflicts;
    return false;
  }
  log.ok(`Merged ${branchName} → ${baseBranch} (${mergeResult.method})`);
  roundResult.merged = true;
  roundResult.mergeMethod = mergeResult.method;
  roundResult.durationMs = Date.now() - ctx.roundStart;
  session.roundResults.push(roundResult);
  session.budget.recordRoundEnd(ctx.round, ctx.area, roundResult.durationMs);
  saveKnowledgeBase(evolveDir, ctx.kb);
  saveCheckpoint(evolveDir, {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    dateStr: session.dateStr,
    projectRoot,
    baseBranch,
    maxRounds: session.maxRounds,
    maxHoursMs: session.maxHoursMs,
    focusAreas: session.focusAreas,
    timeouts: session.timeouts,
    budgetOverrides: {},
    budgetState: session.budget.serialize(),
    completedRounds: session.roundResults,
    lastRoundNum: ctx.round,
    kbStartCount: session.kbStartCount,
    activeSuggestionId: activeSuggestionId ?? null,
    reason: 'hot-restart after approved self-modification',
  });
  destroyStatusBar();
  spawnNewProcess(projectRoot);
  log.info('Exiting for hot-restart...');
  process.exitCode = 0;
  return true;
}

function buildSuggestionDeliberation(
  activeSuggestion: SuggestionEntry,
  roundResult: RoundResult,
): { deliberation: Awaited<ReturnType<typeof phaseDeliberate>>; clearSuggestion: boolean } {
  log.phase('RESEARCH');
  log.dim('Skipped — using suggestion from backlog');
  log.phase('DELIBERATE');
  log.dim('Skipped — using suggestion from backlog');
  const deliberation = {
    synthesis: { suggestedImprovement: activeSuggestion.description ?? '' },
    critique: null,
    feasibility: null,
    priority: {
      selectedImprovement: activeSuggestion.description ?? '',
      rationale: `From suggestion backlog: ${activeSuggestion.title ?? ''}`,
      expectedImpact: activeSuggestion.priority ?? 'medium',
      risks: [],
      constraints: [],
    },
    selectedImprovement: activeSuggestion.description ?? '',
  };
  roundResult.selectedImprovement = activeSuggestion.description ?? null;
  roundResult.researchSummary = `[Suggestion ${activeSuggestion.id ?? ''}] ${activeSuggestion.title ?? ''}`;
  log.ok(`Selected: ${(activeSuggestion.title ?? '').slice(0, 100)}`);
  return { deliberation, clearSuggestion: true };
}

async function runResearchDeliberatePath(
  round: number,
  area: string,
  kb: KnowledgeBase,
  session: EvolveSessionVars,
  evolveDir: string,
  projectRoot: string,
  roundResult: RoundResult,
): Promise<Awaited<ReturnType<typeof phaseDeliberate>>> {
  const research = await phaseResearch(area, kb, {
    cwd: projectRoot,
    timeouts: session.timeouts,
    evolveDir,
  });
  const researchPath = path.join(evolveDir, 'research', `ROUND_${String(round)}_RESEARCH.json`);
  fs.writeFileSync(researchPath, JSON.stringify(research, null, 2), 'utf8');
  log.ok(`Research saved: ${path.basename(researchPath)}`);
  const allFindings = [
    ...((research as { claudeFindings?: { findings?: string[] } }).claudeFindings?.findings ?? []),
    ...((research as { geminiFindings?: { findings?: string[] } }).geminiFindings?.findings ?? []),
  ];
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  roundResult.researchSummary = allFindings.slice(0, 3).join('; ').slice(0, 200) || 'No findings';
  for (const finding of allFindings.slice(0, 5)) {
    addEntry(kb, {
      round,
      date: session.dateStr,
      area,
      finding,
      applicability: 'medium',
      attempted: false,
      tags: [area],
    });
  }
  const deliberation = await phaseDeliberate(research, kb, {
    cwd: projectRoot,
    timeouts: session.timeouts,
  });
  roundResult.selectedImprovement = deliberation.selectedImprovement;
  log.ok(`Selected: ${deliberation.selectedImprovement.slice(0, 100)}`);
  return deliberation;
}

function handleNoImprovementRound(
  roundResult: RoundResult,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  round: number,
  area: string,
  kb: KnowledgeBase,
  dateStr: string,
): void {
  log.warn('No actionable improvement from deliberation — skipping round');
  roundResult.verdict = 'skipped';
  roundResult.learnings = 'No actionable improvement from deliberation';
  addEntry(kb, {
    round,
    date: dateStr,
    area,
    finding: deliberation.selectedImprovement === '' ? 'empty' : deliberation.selectedImprovement,
    applicability: 'low',
    attempted: false,
    outcome: null,
    learnings: 'Deliberation did not produce actionable improvement',
    tags: [area, 'skipped'],
  });
}

function handleReducedScopeRound(
  roundResult: RoundResult,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  round: number,
  area: string,
  kb: KnowledgeBase,
  session: EvolveSessionVars,
  evolveDir: string,
  evolveConfig: EvolveConfig,
): void {
  log.warn('Reduced scope mode — skipping TEST, IMPLEMENT, ANALYZE phases');
  roundResult.verdict = 'skipped';
  roundResult.learnings = 'Budget-reduced: research and deliberation only';
  addEntry(kb, {
    round,
    date: session.dateStr,
    area,
    finding: deliberation.selectedImprovement,
    applicability:
      (deliberation.priority as { expectedImpact?: string } | null)?.expectedImpact ?? 'medium',
    attempted: false,
    outcome: null,
    learnings: 'Deferred due to budget constraints',
    tags: [area, 'deferred'],
  });
  if (
    evolveConfig.suggestions?.autoPopulateFromDeferred !== false &&
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    !roundResult.suggestionId
  ) {
    const sg = loadSuggestions(evolveDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- runtime safety
    const created = createSuggestionFromRound(sg, roundResult as any, deliberation, {
      sessionId: session.sessionId,
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
}

function applyViolationsToAnalysis(
  projectRoot: string,
  branchName: string,
  baseBranch: string,
  analysis: { concerns: string[] },
): ReturnType<typeof scanBranchViolations> {
  const violations = scanBranchViolations(projectRoot, branchName, baseBranch);
  if (violations.length > 0) {
    log.warn(`${String(violations.length)} violation(s) detected`);
    for (const v of violations) log.dim(`  [${v.severity}] ${v.detail}`);
    if (violations.some((v) => v.severity === 'critical'))
      analysis.concerns.push('Critical guardrail violations detected');
  }
  return violations;
}

async function runImprovementFlow(
  ctx: EvolveRoundContext,
  deliberation: Awaited<ReturnType<typeof phaseDeliberate>>,
  clearSuggestion: boolean,
): Promise<{ hotRestart: boolean; clearSuggestion: boolean }> {
  const {
    round,
    area,
    roundResult,
    kb,
    session,
    evolveDir,
    projectRoot,
    baseBranch,
    evolveConfig,
  } = ctx;
  const plan = await phasePlan(deliberation, area, kb, {
    cwd: projectRoot,
    timeouts: session.timeouts,
    evolveDir,
    roundNum: round,
  });
  const branchName = `evolve/${session.dateStr}/${String(round)}`;
  roundResult.branchName = branchName;
  if (!createBranch(projectRoot, branchName, baseBranch)) {
    log.error(`Failed to create branch: ${branchName}`);
    roundResult.verdict = 'error';
    roundResult.learnings = 'Branch creation failed';
    checkoutBranch(projectRoot, baseBranch);
    return { hotRestart: false, clearSuggestion };
  }
  log.ok(`Branch: ${branchName}`);
  const safetyPrompt = buildEvolveSafetyPrompt(branchName);
  await runTestPhaseWithInvestigation(
    plan,
    branchName,
    safetyPrompt,
    projectRoot,
    session.timeouts,
  );
  await runImplementPhaseWithInvestigation(
    plan,
    branchName,
    safetyPrompt,
    deliberation,
    projectRoot,
    session.timeouts,
  );
  const branchCheck = verifyBranch(projectRoot, branchName);
  if (!branchCheck.ok) git(['checkout', branchName], projectRoot);
  const diff = getBranchDiff(projectRoot, branchName, baseBranch);
  const analysis = await runAnalyzePhaseWithInvestigation(
    diff,
    branchName,
    plan,
    deliberation,
    projectRoot,
    session.timeouts,
    safetyPrompt,
    baseBranch,
  );
  enrichRoundResult(roundResult, analysis);
  const violations = applyViolationsToAnalysis(projectRoot, branchName, baseBranch, analysis);
  const decision = phaseDecide(analysis, evolveConfig as Record<string, unknown>);
  roundResult.verdict = decision.verdict;
  roundResult.learnings = decision.reason;
  processDecision(ctx, decision, analysis, violations, deliberation);
  updateSuggestionAfterRound(ctx, decision, analysis, deliberation);
  const stats = getBranchStats(projectRoot, branchName, baseBranch);
  log.ok(
    `Round ${String(round)} complete: ${decision.verdict.toUpperCase()} | ${String(stats.commits)} commits | ${String(stats.filesChanged)} files`,
  );
  if (decision.verdict === 'approve' && didModifyHydraCode(projectRoot, branchName, baseBranch)) {
    const hotRestarted = attemptHotRestart(ctx, decision, roundResult, branchName);
    if (hotRestarted) return { hotRestart: true, clearSuggestion };
  }
  return { hotRestart: false, clearSuggestion };
}

async function executeEvolveRound(
  ctx: EvolveRoundContext,
): Promise<{ hotRestart: boolean; clearSuggestion: boolean }> {
  const { round, area, roundResult, kb, session, evolveDir, projectRoot, reducedScope } = ctx;
  let deliberation: Awaited<ReturnType<typeof phaseDeliberate>>;
  let clearSuggestion = false;
  if (ctx.activeSuggestion === null) {
    deliberation = await runResearchDeliberatePath(
      round,
      area,
      kb,
      session,
      evolveDir,
      projectRoot,
      roundResult,
    );
  } else {
    ({ deliberation, clearSuggestion } = buildSuggestionDeliberation(
      ctx.activeSuggestion,
      roundResult,
    ));
  }
  if (
    deliberation.selectedImprovement === 'No improvement selected' ||
    deliberation.selectedImprovement.length < 5
  ) {
    handleNoImprovementRound(roundResult, deliberation, round, area, kb, session.dateStr);
    return { hotRestart: false, clearSuggestion };
  }
  if (reducedScope) {
    handleReducedScopeRound(
      roundResult,
      deliberation,
      round,
      area,
      kb,
      session,
      evolveDir,
      ctx.evolveConfig,
    );
    return { hotRestart: false, clearSuggestion };
  }
  return runImprovementFlow(ctx, deliberation, clearSuggestion);
}

function mergeApprovedBranches(
  roundResults: RoundResult[],
  projectRoot: string,
  baseBranch: string,
): void {
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
  const postMergeBranch = getCurrentBranch(projectRoot);
  if (postMergeBranch !== baseBranch) checkoutBranch(projectRoot, baseBranch);
}

function finalizeSuggestionsBacklog(evolveDir: string): void {
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

function buildAndSaveReports(
  session: EvolveSessionVars,
  evolveDir: string,
  kb: KnowledgeBase,
  stopReason: string | null,
  finishedAt: number,
): {
  mdPath: string;
  jsonPath: string;
  budgetSummary: ReturnType<EvolveBudgetTracker['getSummary']>;
  kbDelta: { added: number; total: number };
  investigatorSummary: ReturnType<typeof getInvestigatorStats> | null;
} {
  const budgetSummary = session.budget.getSummary();
  const kbDelta = { added: kb.entries.length - session.kbStartCount, total: kb.entries.length };
  const runMeta = {
    startedAt: session.startedAt,
    finishedAt,
    dateStr: session.dateStr,
    maxRounds: session.maxRounds,
    processedRounds: session.roundResults.length,
    stopReason,
  };
  const investigatorSummary = isInvestigatorAvailable() ? getInvestigatorStats() : null;
  const mdReport = generateSessionReport(
    session.roundResults,
    budgetSummary,
    runMeta,
    kbDelta,
    investigatorSummary,
  );
  const jsonReport = generateSessionJSON(
    session.roundResults,
    budgetSummary,
    runMeta,
    kbDelta,
    investigatorSummary,
  );
  const mdPath = path.join(evolveDir, `EVOLVE_${session.dateStr}.md`);
  const jsonPath = path.join(evolveDir, `EVOLVE_${session.dateStr}.json`);
  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');
  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);
  return { mdPath, jsonPath, budgetSummary, kbDelta, investigatorSummary };
}

function saveFinalSessionState(
  evolveDir: string,
  session: EvolveSessionVars,
  stopReason: string | null,
  kb: KnowledgeBase,
  finishedAt: number,
): void {
  const finalStatus = computeSessionStatus(
    session.roundResults,
    session.maxRounds,
    stopReason,
    false,
  );
  const actionNeeded = computeActionNeeded(session.roundResults, session.maxRounds, finalStatus);
  const approved = session.roundResults.filter((r: RoundResult) => r.verdict === 'approve').length;
  const rejected = session.roundResults.filter((r: RoundResult) => r.verdict === 'reject').length;
  const skipped = session.roundResults.filter((r: RoundResult) => r.verdict === 'skipped').length;
  const errors = session.roundResults.filter((r: RoundResult) => r.verdict === 'error').length;
  saveSessionState(evolveDir, {
    sessionId: session.sessionId,
    status: finalStatus,
    startedAt: session.startedAt,
    finishedAt,
    dateStr: session.dateStr,
    maxRounds: session.maxRounds,
    maxHours: session.maxHoursMs / (60 * 60 * 1000),
    focusAreas: session.focusAreas,
    timeouts: session.timeouts,
    kbStartCount: session.kbStartCount,
    completedRounds: session.roundResults,
    nextRound:
      session.roundResults.length + session.startRound > session.maxRounds
        ? undefined
        : session.roundResults.length + session.startRound,
    resumable: finalStatus === 'partial' || finalStatus === 'failed',
    stopReason,
    actionNeeded,
    summary: {
      approved,
      rejected,
      skipped,
      errors,
      totalKBAdded: kb.entries.length - session.kbStartCount,
    },
    budgetState: session.budget.serialize(),
  });
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  log.info(`Session status: ${finalStatus}${actionNeeded ? ` — ${actionNeeded}` : ''}`);
}

function printRoundDetails(roundResults: RoundResult[]): void {
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
    if (r.branchName) console.log(`    ${pc.dim('Branch:')} ${r.branchName}`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (r.learnings) console.log(`    ${pc.dim('Note:')} ${r.learnings.slice(0, 80)}`);
    console.log('');
  }
}

function printSessionSummary(
  session: EvolveSessionVars,
  stopReason: string | null,
  mdPath: string,
  jsonPath: string,
  finishedAt: number,
  budgetSummary: ReturnType<EvolveBudgetTracker['getSummary']>,
  kbDelta: { added: number; total: number },
  investigatorSummary: ReturnType<typeof getInvestigatorStats> | null,
  baseBranch: string,
): void {
  const W = 64;
  const hr = pc.dim('─'.repeat(W));
  const dhr = pc.cyan('═'.repeat(W));
  console.log('');
  console.log(dhr);
  console.log(pc.bold(pc.cyan('  EVOLVE SESSION COMPLETE')));
  console.log(dhr);
  console.log('');
  printRoundDetails(session.roundResults);
  console.log(hr);
  const approved = session.roundResults.filter((r: RoundResult) => r.verdict === 'approve').length;
  const rejected = session.roundResults.filter((r: RoundResult) => r.verdict === 'reject').length;
  const revised = session.roundResults.filter((r: RoundResult) => r.verdict === 'revise').length;
  const errors = session.roundResults.filter((r: RoundResult) => r.verdict === 'error').length;
  const skipped = session.roundResults.filter((r: RoundResult) => r.verdict === 'skipped').length;
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
    `  ${pc.bold('Rounds')}      ${String(session.roundResults.length)}/${String(session.maxRounds)}  ${verdictLine}`,
  );
  console.log(`  ${pc.bold('Duration')}    ${formatDuration(finishedAt - session.startedAt)}`);
  console.log(`  ${pc.bold('Tokens')}      ~${budgetSummary.consumed.toLocaleString()} consumed`);
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
  printBranchSummary(session.roundResults, baseBranch, hr, mdPath, jsonPath, dhr);
}

function printBranchSummary(
  roundResults: RoundResult[],
  baseBranch: string,
  hr: string,
  mdPath: string,
  jsonPath: string,
  dhr: string,
): void {
  const mergedBranches = roundResults.filter(
    (r: RoundResult) => r.branchName !== null && r.verdict === 'approve' && r.merged,
  );
  const conflictBranches = roundResults.filter(
    (r: RoundResult) => r.branchName !== null && r.verdict === 'approve' && !r.merged,
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
    (r: RoundResult) => r.branchName !== null && r.verdict === 'revise',
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

type RoundLoopState = {
  activeSuggestion: SuggestionEntry | null;
  activeSuggestionId: string | null;
  stopReason: string | null;
};

async function runRoundLoop(
  session: EvolveSessionVars,
  state: RoundLoopState,
  kb: KnowledgeBase,
  evolveDir: string,
  projectRoot: string,
  baseBranch: string,
  evolveConfig: EvolveConfig,
): Promise<boolean> {
  const capturedState = state; // const ref — avoids require-atomic-updates on post-await mutations
  let reducedScope = false;
  for (let round = session.startRound; round <= session.maxRounds; round++) {
    const roundStart = Date.now();
    const gate = checkRoundBudgetGate(session, round);
    if (gate.breakLoop) {
      state.stopReason = gate.stopReason ?? null;
      break;
    }
    if (gate.reducedScope) reducedScope = true;
    const area = selectRoundArea(round, session, state.activeSuggestion);
    log.round(
      `ROUND ${String(round)}/${String(session.maxRounds)}: ${area}${state.activeSuggestion !== null && round === session.startRound ? ' (suggestion)' : ''}`,
    );
    const roundResult = initRoundResult(
      round,
      area,
      state.activeSuggestion,
      state.activeSuggestionId,
      session.startRound,
    );
    let clearSuggestion = false;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential processing required
      const outcome = await executeEvolveRound({
        round,
        roundStart,
        area,
        roundResult,
        kb,
        session,
        evolveDir,
        projectRoot,
        baseBranch,
        evolveConfig,
        activeSuggestion: state.activeSuggestion,
        activeSuggestionId: state.activeSuggestionId,
        reducedScope,
      });
      clearSuggestion = outcome.clearSuggestion;
      if (outcome.hotRestart) return true;
    } catch (err: unknown) {
      log.error(
        `Round ${String(round)} error: ${err instanceof Error ? err.message : String(err)}`,
      );
      roundResult.verdict = 'error';
      roundResult.learnings = err instanceof Error ? err.message : String(err);
    }
    if (clearSuggestion) {
      capturedState.activeSuggestion = null;
      capturedState.activeSuggestionId = null;
    }
    const curBranch = getCurrentBranch(projectRoot);
    if (curBranch !== baseBranch) checkoutBranch(projectRoot, baseBranch);
    roundResult.durationMs = Date.now() - roundStart;
    session.roundResults.push(roundResult);
    session.budget.recordRoundEnd(round, area, roundResult.durationMs);
    saveIncrementalState(evolveDir, session, state.activeSuggestionId, kb, round);
  }
  return false;
}

async function main() {
  const { options } = parseArgs(process.argv);
  const isResume = options['resume'] === '1' || options['resume'] === 'true';
  const projectConfig = resolveEvolveProject(options);
  if (!projectConfig) return;
  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);
  const evolveConfig: EvolveConfig = loadHydraConfig().evolve ?? {};
  const baseBranch = evolveConfig.baseBranch ?? 'dev';
  if (!validateEvolvePreconditions(projectRoot, baseBranch)) return;
  const evolveDir = initEvolveDirectories(coordDir);
  const kb = loadKnowledgeBase(evolveDir);
  const checkpoint = loadCheckpoint(evolveDir);
  const existingState = loadSessionState(evolveDir);
  const session = initSession(
    checkpoint,
    isResume,
    existingState,
    options,
    evolveConfig,
    kb,
    evolveDir,
  );
  const suggestions = loadSuggestions(evolveDir);
  const loopState: RoundLoopState = {
    activeSuggestion: null,
    activeSuggestionId: null,
    stopReason: null,
  };
  if (isResume) {
    ({
      activeSuggestion: loopState.activeSuggestion,
      activeSuggestionId: loopState.activeSuggestionId,
    } = restoreActiveSuggestion(suggestions, existingState, checkpoint));
  } else {
    ({
      activeSuggestion: loopState.activeSuggestion,
      activeSuggestionId: loopState.activeSuggestionId,
    } = await pickActiveSuggestion(evolveDir, suggestions, evolveConfig, session.focusAreas));
  }
  saveRunningSessionState(evolveDir, session, loopState.activeSuggestionId);
  initStatusBar(['claude', 'gemini', 'codex']);
  const hotRestarted = await runRoundLoop(
    session,
    loopState,
    kb,
    evolveDir,
    projectRoot,
    baseBranch,
    evolveConfig,
  );
  if (hotRestarted) return;
  destroyStatusBar();
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== baseBranch) checkoutBranch(projectRoot, baseBranch);
  mergeApprovedBranches(session.roundResults, projectRoot, baseBranch);
  finalizeSuggestionsBacklog(evolveDir);
  saveKnowledgeBase(evolveDir, kb);
  log.ok('Knowledge base saved');
  const finishedAt = Date.now();
  const { mdPath, jsonPath, budgetSummary, kbDelta, investigatorSummary } = buildAndSaveReports(
    session,
    evolveDir,
    kb,
    loopState.stopReason,
    finishedAt,
  );
  saveFinalSessionState(evolveDir, session, loopState.stopReason, kb, finishedAt);
  printSessionSummary(
    session,
    loopState.stopReason,
    mdPath,
    jsonPath,
    finishedAt,
    budgetSummary,
    kbDelta,
    investigatorSummary,
    baseBranch,
  );
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
