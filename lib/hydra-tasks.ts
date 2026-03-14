/**
 * Hydra Tasks Runner — Scan codebase for work items and execute them autonomously.
 *
 * Bridges the gap between nightly (pre-curated queue) and evolve (AI-discovered improvements).
 * Aggregates TODO/FIXME comments, docs/TODO.md items, and GitHub issues,
 * lets the user pick tasks and set budget limits, then executes autonomously
 * with self-healing, council-lite review, and per-task branch isolation.
 *
 * Usage:
 *   node lib/hydra-tasks.mjs                     # Interactive setup
 *   node lib/hydra-tasks.mjs preset=light         # Quick preset
 *   node lib/hydra-tasks.mjs max=3 hours=1        # Custom limits
 *
 * Per-task lifecycle:
 *   CLASSIFY → PLAN (complex only) → EXECUTE → VERIFY → DECIDE (complex only)
 */

import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — cross-spawn has no bundled types; pre-existing across codebase
import spawn from 'cross-spawn';
import pc from 'picocolors';

import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import { parseArgs, classifyPrompt as _classifyPrompt, ensureDir } from './hydra-utils.ts';
import {
  initAgentRegistry,
  classifyTask as _classifyTask,
  bestAgentFor as _bestAgentFor,
  getVerifier,
} from './hydra-agents.ts';
import { recordCallStart, recordCallComplete } from './hydra-metrics.ts';
import { checkUsage as _checkUsage } from './hydra-usage.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { BudgetTracker } from './hydra-shared/budget-tracker.ts';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.ts';
import {
  buildSafetyPrompt,
  verifyBranch,
  isCleanWorkingTree,
  scanBranchViolations,
  type ScanViolation,
} from './hydra-shared/guardrails.ts';
import {
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  branchExists,
  branchHasCommits,
  getBranchStats,
  getBranchDiff,
} from './hydra-shared/git-ops.ts';
import {
  BASE_PROTECTED_FILES,
  BASE_PROTECTED_PATTERNS,
  BLOCKED_COMMANDS,
} from './hydra-shared/constants.ts';
import {
  scanAllSources,
  createUserTask,
  taskToSlug as _taskToSlug,
  type ScannedTask,
} from './hydra-tasks-scanner.ts';
import { getAgentInstructionFile } from './hydra-sync-md.ts';
import type { HydraConfig, ExecuteResult } from './types.ts';

interface InvestigatorLike {
  isInvestigatorAvailable(): boolean;
  investigate(opts: Record<string, unknown>): Promise<{
    diagnosis: string;
    retryRecommendation?: { preamble?: string };
  }>;
}

// Lazy-load investigator (optional)
let _investigator: InvestigatorLike | null = null;
async function getInvestigator(): Promise<InvestigatorLike | null> {
  if (_investigator !== null) return _investigator;
  try {
    const loaded = (await import('./hydra-investigator.ts')) as unknown as InvestigatorLike;
    _investigator ??= loaded;
    return _investigator;
  } catch {
    return null;
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const RUNNER_NAME = 'tasks runner';
const REPORT_NAME = 'tasks report';
const BRANCH_PREFIX = 'tasks';

const BUDGET_PRESETS = {
  light: {
    maxHours: 0.5,
    budgetPct: 0.1,
    maxTasks: 3,
    label: 'Light (30min, 10% budget, 3 tasks)',
  },
  medium: { maxHours: 1, budgetPct: 0.2, maxTasks: 5, label: 'Medium (1hr, 20% budget, 5 tasks)' },
  heavy: { maxHours: 2, budgetPct: 0.4, maxTasks: 10, label: 'Heavy (2hr, 40% budget, 10 tasks)' },
};

const BUDGET_THRESHOLDS = [
  { pct: 0.95, action: 'hard_stop', reason: 'Budget at {pct}% — hard stop', once: false },
  {
    pct: 0.85,
    action: 'soft_stop',
    reason: 'Budget at {pct}% — soft stop (finishing current task)',
    once: true,
  },
  {
    pct: 0.7,
    action: 'handoff_cheap',
    reason: 'Budget at {pct}% — switching to economy tier',
    once: true,
  },
  { pct: 0.5, action: 'warn', reason: 'Budget at {pct}% ({consumed} tokens used)', once: true },
];

const PROTECTED_FILES = new Set([...BASE_PROTECTED_FILES, 'hydra.config.json']);

// ── Date Helpers ────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return `${String(m)}m ${String(s % 60)}s`;
}

// ── Simple Readline Fallback ────────────────────────────────────────────────

import readline from 'node:readline';
import { exit } from './hydra-process.ts';

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
}

function askLine(rl: readline.Interface, question: string) {
  return new Promise<string>((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

// ── Interactive Task Selection ──────────────────────────────────────────────

async function selectTasks(rl: readline.Interface, scannedTasks: ScannedTask[]) {
  console.log(pc.bold(`\nScanned Tasks (${String(scannedTasks.length)} found):\n`));

  const maxShow = Math.min(scannedTasks.length, 20);
  for (let i = 0; i < maxShow; i++) {
    const t = scannedTasks[i];
    let prioColor;
    if (t.priority === 'high') {
      prioColor = pc.red;
    } else if (t.priority === 'low') {
      prioColor = pc.dim;
    } else {
      prioColor = pc.yellow;
    }
    const num = pc.bold(String(i + 1).padStart(3));
    console.log(`  ${num}. ${prioColor(t.priority.padEnd(6))} ${t.title}`);
    console.log(
      `       ${pc.dim(`[${t.source}] ${t.taskType} → ${t.suggestedAgent} | ${t.sourceRef}`)}`,
    );
  }

  if (scannedTasks.length > maxShow) {
    console.log(
      pc.dim(
        `\n  ... and ${String(scannedTasks.length - maxShow)} more (enter 'all' to see full list)`,
      ),
    );
  }

  console.log('');
  console.log(
    pc.dim(
      '  Enter task numbers (e.g. 1,3,5), "all" for top 10, "add" for freeform, or "q" to quit',
    ),
  );
  const answer = await askLine(rl, pc.bold('  Select tasks: '));

  if (answer === '' || answer === 'q' || answer === 'quit') return null;

  if (answer === 'all') {
    return scannedTasks.slice(0, 10);
  }

  if (answer === 'add' || answer === 'freeform') {
    const text = await askLine(rl, '  Enter task description: ');
    if (text === '') return null;
    return [createUserTask(text)];
  }

  // Parse comma-separated numbers
  const indices = answer
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < scannedTasks.length);

  if (indices.length === 0) {
    console.log(pc.yellow('  No valid selections.'));
    return null;
  }

  return indices.map((i) => scannedTasks[i]);
}

// ── Budget Preset Selection ─────────────────────────────────────────────────

async function readCustomBudget(rl: readline.Interface) {
  const hoursRaw = await askLine(rl, '  Max hours: ');
  const hoursVal = Number.parseFloat(hoursRaw === '' ? '1' : hoursRaw);
  const hours = Number.isNaN(hoursVal) || hoursVal === 0 ? 1 : hoursVal;
  const pctRaw = await askLine(rl, '  Budget % (0-100): ');
  const pctVal = Number.parseFloat(pctRaw === '' ? '20' : pctRaw) / 100;
  const pct = Number.isNaN(pctVal) || pctVal === 0 ? 0.2 : pctVal;
  const maxRaw = await askLine(rl, '  Max tasks: ');
  const maxVal = Number.parseInt(maxRaw === '' ? '5' : maxRaw, 10);
  const max = Number.isNaN(maxVal) || maxVal === 0 ? 5 : maxVal;
  return {
    maxHours: hours,
    budgetPct: pct,
    maxTasks: max,
    label: `Custom (${String(hours)}hr, ${String(Math.round(pct * 100))}%, ${String(max)} tasks)`,
  };
}

async function selectBudget(rl: readline.Interface, cfg: HydraConfig) {
  const defaultPreset = cfg.tasks?.budget?.defaultPreset ?? 'medium';

  console.log(pc.bold('\nBudget Preset:\n'));
  const presetNames = Object.keys(BUDGET_PRESETS);
  for (const [i, name] of presetNames.entries()) {
    const preset = BUDGET_PRESETS[name as keyof typeof BUDGET_PRESETS];
    const marker = name === defaultPreset ? pc.green(' (default)') : '';
    console.log(`  ${String(i + 1)}. ${preset.label}${marker}`);
  }
  console.log(`  ${String(presetNames.length + 1)}. Custom`);

  const answer = await askLine(rl, pc.bold(`\n  Select [1-${String(presetNames.length + 1)}]: `));
  const idx = Number.parseInt(answer, 10) - 1;

  if (idx >= 0 && idx < presetNames.length) {
    return BUDGET_PRESETS[presetNames[idx] as keyof typeof BUDGET_PRESETS];
  }

  if (idx === presetNames.length) {
    return readCustomBudget(rl);
  }

  // Default
  return BUDGET_PRESETS[defaultPreset as keyof typeof BUDGET_PRESETS];
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot: string, cfg: HydraConfig) {
  const plan = resolveVerificationPlan(projectRoot, cfg);
  if (!plan.enabled || plan.command === '') {
    return { ran: false, passed: true, output: '', command: '' };
  }

  const parts = plan.command.split(/\s+/);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- cross-spawn has no bundled types
  const result = spawn.sync(parts[0], parts.slice(1), {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: plan.timeoutMs === 0 ? 60_000 : plan.timeoutMs,
    windowsHide: true,
  }) as { status: number | null; stdout: string; stderr: string };

  return {
    ran: true,
    passed: result.status === 0,
    output: (result.stdout + result.stderr).slice(0, 4096),
    command: plan.command,
  };
}

// ── Council-Lite (DECIDE Phase) ─────────────────────────────────────────────

async function councilLiteReview(
  agent: string,
  diff: string,
  projectRoot: string,
  _cfg: HydraConfig,
) {
  const verifier = getVerifier(agent);
  const truncatedDiff = diff.length > 8192 ? `${diff.slice(0, 8192)}\n... (truncated)` : diff;

  const reviewPrompt = `Review this code change and determine if it should be approved.

## Diff
\`\`\`
${truncatedDiff}
\`\`\`

## Instructions
- Check for bugs, security issues, and correctness
- Check that the change is focused and doesn't introduce unrelated modifications
- Respond with EXACTLY one of these verdicts on the first line:
  APPROVE - Change looks good
  REJECT - Change has significant issues
  NEEDS_REVISION - Change needs minor fixes

Then explain your reasoning briefly.`;

  const handle = recordCallStart(verifier);
  const result = await executeAgentWithRecovery(verifier, reviewPrompt, {
    cwd: projectRoot,
    timeoutMs: 5 * 60 * 1000,
    phaseLabel: 'council-lite review',
  });
  recordCallComplete(handle, result as unknown as Parameters<typeof recordCallComplete>[1]);

  if (!result.ok || result.output === '') {
    return { verdict: 'approve', reason: 'Verifier unavailable — defaulting to approve' };
  }

  const output = result.output.trim();
  const firstLine = output.split('\n')[0].toUpperCase();

  if (firstLine.includes('REJECT')) {
    return { verdict: 'reject', reason: output };
  }
  if (firstLine.includes('NEEDS_REVISION')) {
    return { verdict: 'needs-revision', reason: output };
  }
  return { verdict: 'approve', reason: output };
}

// ── executeTask Helpers ─────────────────────────────────────────────────────

function makeTaskResult(task: ScannedTask, branchName: string) {
  return {
    task: task.title,
    slug: task.slug,
    source: task.source,
    sourceRef: task.sourceRef,
    branch: branchName,
    agent: task.suggestedAgent,
    taskType: task.taskType,
    complexity: task.complexity,
    status: 'pending',
    phases: {} as Record<string, Record<string, unknown>>,
    tokens: 0,
    durationMs: 0,
    filesChanged: 0,
    commits: 0,
    verification: null as { ran: boolean; passed: boolean; command: string } | null,
    violations: [] as ScanViolation[],
    verdict: null as string | null,
  };
}

function logTaskHeader(phaseLabel: string, task: ScannedTask): Record<string, unknown> {
  console.log(pc.bold(`\n${'─'.repeat(60)}`));
  console.log(pc.bold(`  ${phaseLabel}: ${task.title}`));
  console.log(
    pc.dim(`  [${task.source}] ${task.taskType} → ${task.suggestedAgent} | ${task.complexity}`),
  );
  console.log(pc.bold('─'.repeat(60)));
  return {
    status: 'done',
    taskType: task.taskType,
    complexity: task.complexity,
    agent: task.suggestedAgent,
  };
}

async function handleExecFailure(
  task: ScannedTask,
  phaseLabel: string,
  branchName: string,
  projectRoot: string,
  cfg: HydraConfig,
  executePrompt: string,
  execResult: ExecuteResult,
  phases: Record<string, Record<string, unknown>>,
): Promise<boolean> {
  console.log(pc.red(`  [EXECUTE] Failed: ${execResult.error ?? 'unknown error'}`));
  const healed = await runSelfHealing(
    task,
    phaseLabel,
    projectRoot,
    cfg,
    executePrompt,
    execResult,
  );
  if (healed.diagnosisPhase) phases['investigate'] = healed.diagnosisPhase;
  if (healed.recovered) {
    phases['execute']['status'] = 'done';
    phases['execute']['retried'] = true;
    return false;
  }
  notifyDoctorOnFailure(task, branchName, execResult);
  return true;
}

async function runPlanPhase(
  task: ScannedTask,
  phaseLabel: string,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  if (task.complexity !== 'complex') return {};
  console.log(pc.dim(`  [PLAN] Generating implementation plan...`));
  const planPrompt = `Create a brief implementation plan (5-7 bullet points) for this task:

Task: ${task.title}
${task.body != null && task.body !== '' ? `\nDescription:\n${task.body}` : ''}
${task.sourceRef === 'manual' ? '' : `\nSource: ${task.sourceRef}`}

Focus on:
- Which files need to be modified
- What changes are needed
- Any edge cases to handle
- How to verify the change works

Be concise — this is a planning checklist, not a design doc.`;
  const planHandle = recordCallStart('claude');
  const planResult = await executeAgentWithRecovery('claude', planPrompt, {
    cwd: projectRoot,
    timeoutMs: 3 * 60 * 1000,
    phaseLabel: `${phaseLabel} plan`,
  });
  recordCallComplete(planHandle, planResult as unknown as Parameters<typeof recordCallComplete>[1]);
  if (!planResult.ok) {
    console.log(pc.yellow(`  [PLAN] Planning failed, proceeding with direct execution`));
  }
  return { status: planResult.ok ? 'done' : 'failed', output: planResult.output.slice(0, 2048) };
}

function buildExecutePrompt(
  task: ScannedTask,
  branchName: string,
  projectRoot: string,
  planOutput: string | undefined,
): string {
  const safetyRules = buildSafetyPrompt(branchName, {
    runner: RUNNER_NAME,
    reportName: REPORT_NAME,
    protectedFiles: PROTECTED_FILES,
    blockedCommands: BLOCKED_COMMANDS,
    attribution: { pipeline: 'hydra-tasks', agent: task.suggestedAgent },
  });
  const instructionFile = getAgentInstructionFile(task.suggestedAgent, projectRoot);
  const planSection =
    planOutput != null && planOutput !== '' ? `\n\n## Implementation Plan\n${planOutput}` : '';
  return `${safetyRules}

## Task
${task.title}
${task.body != null && task.body !== '' ? `\n### Description\n${task.body}` : ''}
${task.sourceRef === 'manual' ? '' : `\n### Source Reference\n${task.sourceRef}`}
${planSection}

## Instructions
1. Read the relevant code files first to understand the current state
2. Make the minimal changes needed to complete this task
3. Commit your changes with a clear commit message
4. Do NOT modify files outside the scope of this task

Read ${instructionFile} for project conventions.`;
}

async function invokeExecuteAgent(
  task: ScannedTask,
  phaseLabel: string,
  projectRoot: string,
  cfg: HydraConfig,
  executePrompt: string,
): Promise<{ ok: boolean; phase: Record<string, unknown>; raw: ExecuteResult }> {
  console.log(pc.dim(`  [EXECUTE] Dispatching to ${task.suggestedAgent}...`));
  const timeoutMs = cfg.tasks?.perTaskTimeoutMs ?? 15 * 60 * 1000;
  const execHandle = recordCallStart(task.suggestedAgent);
  const raw = await executeAgentWithRecovery(task.suggestedAgent, executePrompt, {
    cwd: projectRoot,
    timeoutMs,
    phaseLabel,
    progressIntervalMs: 30_000,
    onProgress: (elapsed) => {
      process.stderr.write(pc.dim(`  [${phaseLabel}] ${formatDuration(elapsed)} elapsed...\r`));
    },
    hubCwd: projectRoot,
    hubProject: path.basename(projectRoot),
    hubAgent: `${task.suggestedAgent}-forge`,
  });
  recordCallComplete(execHandle, raw as unknown as Parameters<typeof recordCallComplete>[1]);
  const phase: Record<string, unknown> = {
    status: raw.ok ? 'done' : 'failed',
    timedOut: raw.timedOut,
    error: raw.error ?? null,
    recovered: raw.recovered ?? false,
  };
  return { ok: raw.ok, phase, raw: raw as unknown as ExecuteResult };
}

async function applyDiagnosis(
  task: ScannedTask,
  phaseLabel: string,
  projectRoot: string,
  executePrompt: string,
  timeoutMs: number,
  diagnosis: { diagnosis: string; retryRecommendation?: { preamble?: string } },
): Promise<boolean> {
  const baseOpts = {
    cwd: projectRoot,
    timeoutMs,
    hubCwd: projectRoot,
    hubProject: path.basename(projectRoot),
    hubAgent: `${task.suggestedAgent}-forge`,
  };
  if (diagnosis.diagnosis === 'transient') {
    console.log(pc.yellow(`  [INVESTIGATE] Transient failure — retrying...`));
    const retry = await executeAgentWithRecovery(task.suggestedAgent, executePrompt, {
      ...baseOpts,
      phaseLabel: `${phaseLabel} retry`,
    });
    recordCallComplete(
      recordCallStart(task.suggestedAgent),
      retry as unknown as Parameters<typeof recordCallComplete>[1],
    );
    return retry.ok;
  }
  const preamble = diagnosis.retryRecommendation?.preamble;
  if (diagnosis.diagnosis === 'fixable' && preamble != null && preamble !== '') {
    console.log(pc.yellow(`  [INVESTIGATE] Fixable — retrying with corrective prompt...`));
    const corrected = `${preamble}\n\n${executePrompt}`;
    const retry = await executeAgentWithRecovery(task.suggestedAgent, corrected, {
      ...baseOpts,
      phaseLabel: `${phaseLabel} fix-retry`,
    });
    recordCallComplete(
      recordCallStart(task.suggestedAgent),
      retry as unknown as Parameters<typeof recordCallComplete>[1],
    );
    return retry.ok;
  }
  console.log(pc.red(`  [INVESTIGATE] Fundamental failure — skipping task`));
  return false;
}

async function runSelfHealing(
  task: ScannedTask,
  phaseLabel: string,
  projectRoot: string,
  cfg: HydraConfig,
  executePrompt: string,
  execResult: ExecuteResult,
): Promise<{ recovered: boolean; diagnosisPhase: Record<string, unknown> | null }> {
  const inv = await getInvestigator();
  if (!inv || cfg.tasks?.investigator?.['enabled'] === false || !inv.isInvestigatorAvailable()) {
    return { recovered: false, diagnosisPhase: null };
  }
  console.log(pc.dim(`  [INVESTIGATE] Diagnosing failure...`));
  try {
    const diagnosis = await inv.investigate({
      phase: 'agent',
      agent: task.suggestedAgent,
      error: execResult.error ?? execResult.stderr,
      output: execResult.output.slice(0, 2048),
      timedOut: execResult.timedOut || false,
    });
    const diagnosisPhase = { diagnosis: diagnosis.diagnosis };
    const timeoutMs = cfg.tasks?.perTaskTimeoutMs ?? 15 * 60 * 1000;
    const recovered = await applyDiagnosis(
      task,
      phaseLabel,
      projectRoot,
      executePrompt,
      timeoutMs,
      diagnosis,
    );
    return { recovered, diagnosisPhase };
  } catch (invErr) {
    console.log(
      pc.dim(
        `  [INVESTIGATE] Investigation failed: ${invErr instanceof Error ? invErr.message : String(invErr)}`,
      ),
    );
    return { recovered: false, diagnosisPhase: null };
  }
}

function notifyDoctorOnFailure(
  task: ScannedTask,
  branchName: string,
  execResult: ExecuteResult,
): void {
  void import('./hydra-doctor.ts')
    .then((doc) => {
      if (doc.isDoctorEnabled())
        void doc.diagnose({
          pipeline: 'tasks',
          phase: 'execute',
          agent: task.suggestedAgent,
          error: execResult.error ?? execResult.stderr,
          exitCode: execResult.exitCode ?? null,
          signal: execResult.signal ?? null,
          command: execResult.command,
          args: execResult.args,
          promptSnippet: execResult.promptSnippet,
          stderr: execResult.stderr,
          stdout: execResult.output,
          errorCategory: execResult.errorCategory ?? null,
          errorDetail: execResult.errorDetail ?? null,
          errorContext: execResult.errorContext ?? null,
          timedOut: execResult.timedOut || false,
          taskTitle: task.title,
          branchName,
        } as unknown as Parameters<typeof doc.diagnose>[0]);
    })
    .catch(() => {});
}

async function resolveVerdict(
  task: ScannedTask,
  projectRoot: string,
  branchName: string,
  baseBranch: string,
  cfg: HydraConfig,
  verification: { ran: boolean; passed: boolean; command: string },
  violations: ScanViolation[],
): Promise<{ value: string; phase: Record<string, unknown> }> {
  const councilCfg = cfg.tasks?.councilLite ?? {};
  const needsCouncil =
    councilCfg['enabled'] !== false &&
    (task.complexity === 'complex' ||
      (councilCfg['complexOnly'] !== true && (violations.length > 0 || !verification.passed)));
  if (!needsCouncil) {
    const value =
      (verification.passed || !verification.ran) && violations.length === 0
        ? 'approve'
        : 'needs-review';
    return { value, phase: { status: 'auto', verdict: value } };
  }
  console.log(pc.dim(`  [DECIDE] Council-lite review...`));
  const diff = getBranchDiff(projectRoot, branchName, baseBranch);
  if (diff === '') {
    return { value: 'approve', phase: { status: 'skipped', reason: 'no diff' } };
  }
  const review = await councilLiteReview(task.suggestedAgent, diff, projectRoot, cfg);
  let verdictColor: (s: string) => string;
  if (review.verdict === 'approve') verdictColor = pc.green;
  else if (review.verdict === 'reject') verdictColor = pc.red;
  else verdictColor = pc.yellow;
  console.log(`  [DECIDE] Verdict: ${verdictColor(review.verdict)}`);
  return { value: review.verdict, phase: { status: 'done', verdict: review.verdict } };
}

async function runVerifyAndDecide(
  task: ScannedTask,
  projectRoot: string,
  branchName: string,
  baseBranch: string,
  cfg: HydraConfig,
): Promise<{
  verification: { ran: boolean; passed: boolean; command: string };
  violations: ScanViolation[];
  verdict: string;
  phases: { verify: Record<string, unknown>; decide: Record<string, unknown> };
}> {
  console.log(pc.dim(`  [VERIFY] Running verification...`));
  const verResult = runVerification(projectRoot, cfg);
  if (verResult.ran) {
    console.log(
      verResult.passed
        ? pc.green(`  [VERIFY] Passed: ${verResult.command}`)
        : pc.red(`  [VERIFY] Failed: ${verResult.command}`),
    );
  }
  const violations = scanBranchViolations(projectRoot, branchName, {
    baseBranch,
    protectedFiles: PROTECTED_FILES,
    protectedPatterns: BASE_PROTECTED_PATTERNS,
    checkDeletedTests: true,
  });
  if (violations.length > 0) {
    console.log(pc.red(`  [VERIFY] ${String(violations.length)} violation(s) detected`));
    for (const v of violations) {
      console.log(pc.red(`    [${v.severity}] ${v.detail}`));
    }
  }
  const verifyPhase = { status: 'done', passed: verResult.passed, violations: violations.length };
  const verdictResult = await resolveVerdict(
    task,
    projectRoot,
    branchName,
    baseBranch,
    cfg,
    { ran: verResult.ran, passed: verResult.passed, command: verResult.command },
    violations,
  );
  return {
    verification: { ran: verResult.ran, passed: verResult.passed, command: verResult.command },
    violations,
    verdict: verdictResult.value,
    phases: { verify: verifyPhase, decide: verdictResult.phase },
  };
}

async function collectBranchResults(
  task: ScannedTask,
  projectRoot: string,
  branchName: string,
  baseBranch: string,
  cfg: HydraConfig,
  result: ReturnType<typeof makeTaskResult>,
): Promise<void> {
  const stats = getBranchStats(projectRoot, branchName, baseBranch);
  result.filesChanged = stats.filesChanged;
  result.commits = stats.commits;

  const vd = await runVerifyAndDecide(task, projectRoot, branchName, baseBranch, cfg);
  result.verification = vd.verification;
  result.violations = vd.violations;
  result.verdict = vd.verdict;
  Object.assign(result.phases, vd.phases);
}

// ── Per-Task Execution ──────────────────────────────────────────────────────

async function executeTask(
  task: ScannedTask,
  idx: number,
  total: number,
  projectRoot: string,
  baseBranch: string,
  cfg: HydraConfig,
  _budget: unknown,
  _sessionMode: unknown,
) {
  const date = todayStr();
  const branchName = `${BRANCH_PREFIX}/${date}/${task.slug}`;
  const startTime = Date.now();
  const result = makeTaskResult(task, branchName);
  const phaseLabel = `Task ${String(idx + 1)}/${String(total)}`;

  try {
    result.phases['classify'] = logTaskHeader(phaseLabel, task);

    if (getCurrentBranch(projectRoot) !== baseBranch) checkoutBranch(projectRoot, baseBranch);

    if (branchExists(projectRoot, branchName)) {
      console.log(pc.yellow(`  Branch ${branchName} already exists, skipping`));
      result.status = 'skipped';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    createBranch(projectRoot, branchName, baseBranch);
    checkoutBranch(projectRoot, branchName);

    const planPhaseResult = await runPlanPhase(task, phaseLabel, projectRoot);
    result.phases['plan'] = planPhaseResult;

    const executePrompt = buildExecutePrompt(
      task,
      branchName,
      projectRoot,
      planPhaseResult['output'] as string | undefined,
    );

    const execResult = await invokeExecuteAgent(task, phaseLabel, projectRoot, cfg, executePrompt);
    result.phases['execute'] = execResult.phase;

    if (!execResult.ok) {
      const shouldAbort = await handleExecFailure(
        task,
        phaseLabel,
        branchName,
        projectRoot,
        cfg,
        executePrompt,
        execResult.raw,
        result.phases,
      );
      if (shouldAbort) {
        result.status = 'failed';
        result.durationMs = Date.now() - startTime;
        checkoutBranch(projectRoot, baseBranch);
        return result;
      }
    }

    if (!branchHasCommits(projectRoot, branchName, baseBranch)) {
      console.log(pc.yellow(`  [EXECUTE] No commits produced — skipping`));
      result.status = 'empty';
      result.durationMs = Date.now() - startTime;
      checkoutBranch(projectRoot, baseBranch);
      return result;
    }

    await collectBranchResults(task, projectRoot, branchName, baseBranch, cfg, result);

    result.status = result.verdict === 'reject' ? 'rejected' : 'success';
  } catch (err) {
    result.status = 'error';
    const errMsg = err instanceof Error ? err.message : String(err);
    result.phases['error'] = { message: errMsg };
    console.log(pc.red(`  [ERROR] ${errMsg}`));
  }

  result.durationMs = Date.now() - startTime;
  try {
    checkoutBranch(projectRoot, baseBranch);
  } catch {
    /* best effort */
  }
  return result;
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReport(
  date: string,
  results: Array<{
    status: string;
    task: string;
    agent: string;
    tokens: number;
    durationMs: number;
    verdict: string | null;
  }>,
  budgetSummary: Record<string, unknown>,
  sessionConfig: unknown,
) {
  const successful = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped' || r.status === 'empty').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;

  // JSON report
  const jsonReport = {
    date,
    runner: 'hydra-tasks',
    totalTasks: results.length,
    processedTasks: results.filter((r) => r.status !== 'skipped').length,
    successful,
    failed,
    skipped,
    rejected,
    stopReason: null,
    budget: budgetSummary,
    config: sessionConfig,
    results,
  };

  // Markdown report
  let md = `# Hydra Tasks Report — ${date}\n\n`;
  md += `## Summary\n`;
  md += `- **Total tasks**: ${String(results.length)}\n`;
  md += `- **Successful**: ${String(successful)}\n`;
  md += `- **Failed**: ${String(failed)}\n`;
  md += `- **Skipped**: ${String(skipped)}\n`;
  md += `- **Rejected**: ${String(rejected)}\n\n`;

  md += `## Budget\n`;
  md += `- Consumed: ${(budgetSummary['consumed'] as number | undefined)?.toLocaleString() ?? '?'} tokens\n`;
  md += `- Limit: ${(budgetSummary['hardLimit'] as number | undefined)?.toLocaleString() ?? '?'} tokens\n`;
  md += `- Duration: ${formatDuration((budgetSummary['durationMs'] as number | undefined) ?? 0)}\n\n`;

  md += `## Tasks\n\n`;
  md += `| # | Task | Agent | Status | Tokens | Duration | Verdict |\n`;
  md += `|---|------|-------|--------|--------|----------|----------|\n`;

  for (const [i, r] of results.entries()) {
    let statusIcon: string;
    if (r.status === 'success') statusIcon = 'PASS';
    else if (r.status === 'failed') statusIcon = 'FAIL';
    else statusIcon = r.status;
    md += `| ${String(i + 1)} | ${r.task.slice(0, 40)} | ${r.agent} | ${statusIcon} | ${String(r.tokens)} | ${formatDuration(r.durationMs)} | ${(r.verdict as string | null | undefined) ?? '-'} |\n`;
  }

  md += '\n';

  return { json: jsonReport, markdown: md };
}

// ── Session Helpers ─────────────────────────────────────────────────────────

function optionAsStr(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return fallback;
}

function resolveBudgetFromOptions(
  options: Record<string, unknown>,
): { maxHours: number; budgetPct: number; maxTasks: number; label: string } | null {
  const presetName = options['preset'] as string | undefined;
  if (typeof presetName === 'string' && presetName in BUDGET_PRESETS) {
    return BUDGET_PRESETS[presetName as keyof typeof BUDGET_PRESETS];
  }
  if (options['max'] == null && options['hours'] == null && options['budget'] == null) return null;
  const hoursVal = Number.parseFloat(optionAsStr(options['hours'], '1'));
  const hours = Number.isNaN(hoursVal) || hoursVal === 0 ? 1 : hoursVal;
  const pctVal = Number.parseFloat(optionAsStr(options['budget'], '20')) / 100;
  const pct = Number.isNaN(pctVal) || pctVal === 0 ? 0.2 : pctVal;
  const maxVal = Number.parseInt(optionAsStr(options['max'], '5'), 10);
  const max = Number.isNaN(maxVal) || maxVal === 0 ? 5 : maxVal;
  return {
    maxHours: hours,
    budgetPct: pct,
    maxTasks: max,
    label: `Custom (${String(hours)}hr, ${String(Math.round(pct * 100))}%, ${String(max)} tasks)`,
  };
}

async function runTaskLoop(
  selectedTasks: ScannedTask[],
  budgetPreset: { maxHours: number; maxTasks: number; budgetPct: number; label: string },
  budget: BudgetTracker,
  projectRoot: string,
  baseBranch: string,
  cfg: HydraConfig,
): Promise<{ results: Awaited<ReturnType<typeof executeTask>>[]; stopReason: string | null }> {
  type LoopState = {
    results: Awaited<ReturnType<typeof executeTask>>[];
    stopReason: string | null;
  };
  const sessionStart = Date.now();
  const maxMs = budgetPreset.maxHours * 60 * 60 * 1000;

  const runOne = async (acc: LoopState, task: ScannedTask, i: number): Promise<LoopState> => {
    if (acc.stopReason !== null) return acc;
    if (Date.now() - sessionStart > maxMs) {
      return { ...acc, stopReason: `Time limit reached (${String(budgetPreset.maxHours)}hr)` };
    }
    const budgetCheck = budget.check();
    if (budgetCheck.action === 'hard_stop') {
      return { ...acc, stopReason: budgetCheck.reason };
    }
    const taskResult = await executeTask(
      task,
      i,
      selectedTasks.length,
      projectRoot,
      baseBranch,
      cfg,
      budget,
      null,
    );
    budget.recordUnitEnd(task.slug, taskResult.durationMs);
    const results = [...acc.results, taskResult];
    if (budgetCheck.action === 'soft_stop') {
      return { results, stopReason: budgetCheck.reason };
    }
    return { results, stopReason: null };
  };

  return selectedTasks.reduce<Promise<LoopState>>(
    (accPromise, task, i) => accPromise.then((acc) => runOne(acc, task, i)),
    Promise.resolve({ results: [], stopReason: null }),
  );
}

function printFinalSummary(
  results: Array<{
    status: string;
    task: string;
    agent: string;
    tokens: number;
    durationMs: number;
    verdict: string | null;
  }>,
  _selectedTasks: ScannedTask[],
  budgetSummary: Record<string, unknown>,
  stopReason: string | null,
  reportPath: string,
): void {
  const successful = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
  console.log(pc.bold('\n── Session Complete ──\n'));
  console.log(
    `  Tasks:    ${String(results.length)} (${pc.green(String(successful))} ok, ${pc.red(String(failed))} failed)`,
  );
  const consumed = (budgetSummary['consumed'] as number | undefined) ?? 0;
  console.log(`  Tokens:   ${consumed.toLocaleString()}`);
  console.log(
    `  Duration: ${formatDuration((budgetSummary['durationMs'] as number | undefined) ?? 0)}`,
  );
  if (stopReason != null) console.log(pc.yellow(`  Stopped:  ${stopReason}`));
  console.log(pc.dim(`\n  Report: ${reportPath}\n`));
}

// ── Main Session ────────────────────────────────────────────────────────────

function setupSession(
  options: Record<string, unknown>,
): { projectRoot: string; cfg: HydraConfig; baseBranch: string } | null {
  let config;
  try {
    config = resolveProject({ project: options['project'] as string | undefined });
  } catch (err) {
    console.error(
      pc.red(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exitCode = 1;
    return null;
  }
  const { projectRoot } = config;
  const cfg = loadHydraConfig();
  const baseBranch = cfg.tasks?.baseBranch ?? 'dev';
  const branchCheck = verifyBranch(projectRoot, baseBranch);
  if (!branchCheck.ok) {
    console.log(pc.yellow(`Switching to ${baseBranch} (was on ${branchCheck.currentBranch})`));
    checkoutBranch(projectRoot, baseBranch);
  }
  if (!isCleanWorkingTree(projectRoot)) {
    console.error(pc.red('Working tree is not clean. Commit or stash changes first.'));
    process.exitCode = 1;
    return null;
  }
  return { projectRoot, cfg, baseBranch };
}

async function selectTasksInteractively(
  options: Record<string, unknown>,
  scannedTasks: ScannedTask[],
  rl: ReturnType<typeof createRL>,
  cfg: HydraConfig,
): Promise<{
  tasks: ScannedTask[];
  budgetPreset: { label: string; maxHours: number; budgetPct: number; maxTasks: number };
} | null> {
  const selectedTasks =
    Boolean(options['preset']) || Boolean(options['max'])
      ? (() => {
          const parsed = Number.parseInt(
            String(options['max'] === false ? '' : options['max']),
            10,
          );
          return scannedTasks.slice(0, Number.isNaN(parsed) || parsed === 0 ? 5 : parsed);
        })()
      : await selectTasks(rl, scannedTasks);

  if (selectedTasks == null || selectedTasks.length === 0) {
    console.log(pc.dim('\nNo tasks selected. Exiting.'));
    rl.close();
    return null;
  }

  const cliPreset = resolveBudgetFromOptions(options);
  const budgetPreset = cliPreset ?? (await selectBudget(rl, cfg));
  rl.close();
  return { tasks: selectedTasks, budgetPreset };
}

function saveAndPrintReport(
  date: string,
  results: Awaited<ReturnType<typeof executeTask>>[],
  selectedTasks: ScannedTask[],
  budget: BudgetTracker,
  budgetPreset: { label: string; maxTasks: number; maxHours: number; budgetPct: number },
  tokenBudget: number,
  stopReason: string | null,
  projectRoot: string,
): void {
  const budgetSummary = budget.getSummary();
  if (stopReason != null) budgetSummary['stopReason'] = stopReason;
  const report = generateReport(date, results, budgetSummary, {
    preset: budgetPreset.label,
    maxTasks: budgetPreset.maxTasks,
    maxHours: budgetPreset.maxHours,
    tokenBudget,
  });
  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'tasks');
  ensureDir(reportDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(reportDir, `TASKS_${date}_${timestamp}.json`);
  const mdPath = path.join(reportDir, `TASKS_${date}_${timestamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report.json, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, report.markdown, 'utf8');
  printFinalSummary(results, selectedTasks, budgetSummary, stopReason, mdPath);
}

async function main() {
  initAgentRegistry();
  const { options } = parseArgs(process.argv);

  const session = setupSession(options);
  if (!session) return;
  const { projectRoot, cfg, baseBranch } = session;

  console.log(pc.bold('\nHydra Tasks Runner\n'));
  console.log(pc.dim('Scanning for work items...'));

  const scannedTasks = scanAllSources(projectRoot);
  if (scannedTasks.length === 0) {
    console.log(pc.yellow('\nNo tasks found. Add TODO/FIXME comments or create GitHub issues.'));
    return;
  }

  const rl = createRL();
  const selection = await selectTasksInteractively(options, scannedTasks, rl, cfg);
  if (!selection) return;
  const { budgetPreset } = selection;
  const selectedTasks = selection.tasks.slice(0, budgetPreset.maxTasks);

  const weeklyBudget = cfg.usage.weeklyTokenBudget?.['claude-opus-4-6'] ?? 25_000_000;
  const tokenBudget = Math.round(weeklyBudget * budgetPreset.budgetPct);
  const budget = new BudgetTracker({
    softLimit: Math.round(tokenBudget * 0.85),
    hardLimit: tokenBudget,
    unitEstimate: cfg.tasks?.budget?.perTaskEstimate ?? 100_000,
    unitLabel: 'task',
    thresholds: BUDGET_THRESHOLDS,
  });
  budget.recordStart();

  const date = todayStr();
  console.log(pc.bold('\n── Session Configuration ──\n'));
  console.log(`  Tasks: ${pc.cyan(String(selectedTasks.length))}`);
  console.log(`  Budget: ${pc.cyan(budgetPreset.label)}`);
  console.log(`  Token limit: ${pc.cyan(tokenBudget.toLocaleString())}`);
  console.log(`  Time limit: ${pc.cyan(`${String(budgetPreset.maxHours)}hr`)}`);
  console.log(`  Base branch: ${pc.cyan(baseBranch)}`);
  console.log('');
  for (const [i, t] of selectedTasks.entries()) {
    console.log(`  ${pc.dim(`${String(i + 1)}.`)} ${t.title} ${pc.dim(`[${t.suggestedAgent}]`)}`);
  }
  console.log('');

  const { results, stopReason } = await runTaskLoop(
    selectedTasks,
    budgetPreset,
    budget,
    projectRoot,
    baseBranch,
    cfg,
  );
  try {
    checkoutBranch(projectRoot, baseBranch);
  } catch {
    /* best effort */
  }

  saveAndPrintReport(
    date,
    results,
    selectedTasks,
    budget,
    budgetPreset,
    tokenBudget,
    stopReason,
    projectRoot,
  );
}

main().catch((err: unknown) => {
  console.error(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  exit(1);
});
