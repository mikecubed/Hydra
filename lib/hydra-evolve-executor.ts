import path from 'node:path';
import fs from 'node:fs';
import {
  detectModelError,
  detectCodexError,
  recoverFromModelError,
  detectRateLimitError,
  detectUsageLimitError,
  formatResetTime,
  calculateBackoff,
  verifyAgentQuota,
} from './hydra-model-recovery.ts';
import { executeAgent as sharedExecuteAgent } from './hydra-shared/agent-executor.ts';
import type { ExecuteResult, ExecuteAgentOpts } from './hydra-shared/agent-executor.ts';
import { setAgentActivity } from './hydra-statusbar.ts';
import { loadHydraConfig } from './hydra-config.ts';
import { getAgent } from './hydra-agents.ts';
import { isInvestigatorAvailable, investigate } from './hydra-evolve-investigator.ts';
import type { loadKnowledgeBase } from './hydra-evolve-knowledge.ts';
import { getPriorLearnings, formatStatsForPrompt } from './hydra-evolve-knowledge.ts';
import { ensureDir, parseJsonLoose, runProcess, parseTestOutput } from './hydra-utils.ts';
import pc from 'picocolors';

// ── Local type aliases ───────────────────────────────────────────────────────
type KnowledgeBase = ReturnType<typeof loadKnowledgeBase>;
type KBEntry = KnowledgeBase['entries'][number];
// Extended ExecuteResult with evolve-specific dynamic properties
export type EvolveResult = ExecuteResult & {
  rateLimited?: boolean;
  startupFailureDisabled?: boolean;
  investigation?: unknown;
  _shouldRetry?: boolean;
  _corrective?: string | null;
  _preamble?: string | null;
  skipped?: boolean;
  usageLimited?: boolean;
  usageLimitConfirmed?: boolean;
  usageLimitFalsePositive?: boolean;
  usageLimitStructured?: boolean;
  resetInSeconds?: number;
  recovered?: boolean;
  originalModel?: string;
  newModel?: string;
  modelError?: unknown;
  startupFailure?: boolean;
};

type ResearchResult = {
  area: string;
  claudeFindings: {
    findings?: string[];
    applicableIdeas?: string[];
    sources?: unknown[];
  };
  geminiFindings: {
    findings?: string[];
    applicableIdeas?: string[];
    sources?: unknown[];
  };
  codexFindings: {
    existingPatterns?: string[];
    gaps?: string[];
    implementationIdeas?: string[];
    relevantFiles?: unknown[];
  };
};

type DeliberationResult = {
  synthesis: Record<string, unknown> | null;
  critique: Record<string, unknown> | null;
  feasibility: Record<string, unknown> | null;
  priority: Record<string, unknown> | null;
  selectedImprovement: string;
};

type PlanData = {
  objectives?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  filesToModify?: Array<{ path: string; changes: string }>;
  testPlan?: {
    scenarios?: string[];
    edgeCases?: string[];
    variables?: string[];
    expectedBehaviors?: string[];
  };
  rollbackCriteria?: string[];
};

type PlanResult = {
  plan: PlanData | null;
  specPath: string;
};

type ExecutionPhaseResult = {
  ok: boolean;
  output: string;
  stderr: string;
  error: string | null | undefined;
  durationMs: number;
  timedOut: boolean;
};

type AnalysisResult = {
  agentScores: {
    claude: Record<string, unknown> | null;
    gemini: Record<string, unknown> | null;
    codex: Record<string, unknown> | null;
  };
  agentVerdicts: {
    claude: string | null;
    gemini: string | null;
    codex: string | null;
  };
  aggregateScore: number;
  aggregateConfidence: number;
  concerns: string[];
  testsPassed: boolean;
  testOutput: string;
  testDetails: ReturnType<typeof parseTestOutput>;
};

// ── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_PHASE_TIMEOUTS = {
  researchTimeoutMs: 5 * 60 * 1000,
  deliberateTimeoutMs: 7 * 60 * 1000,
  planTimeoutMs: 5 * 60 * 1000,
  testTimeoutMs: 10 * 60 * 1000,
  implementTimeoutMs: 15 * 60 * 1000,
  analyzeTimeoutMs: 7 * 60 * 1000,
};

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok: (msg: string) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg: string) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  phase: (msg: string) => process.stderr.write(`\n${pc.bold(pc.magenta('>>>'))} ${pc.bold(msg)}\n`),
  dim: (msg: string) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// ── Doctor (lazy, fire-and-forget) ───────────────────────────────────────────

function notifyDoctor(failure: unknown) {
  void import('./hydra-doctor.ts')
    .then((doc) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- runtime safety
      if (doc.isDoctorEnabled()) void doc.diagnose(failure as any);
    })
    .catch(() => {});
}

/** Build a doctor notification object from an agent result. */
function doctorPayload(
  agent: string,
  result: ExecuteResult,
  opts: ExecuteAgentOpts,
  extra: Record<string, unknown> = {},
) {
  return {
    pipeline: 'evolve',
    phase: opts.phaseLabel ?? 'agent',
    agent,
    error: result.error,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    command: result.command,
    args: result.args,
    promptSnippet: result.promptSnippet,
    stderr: result.stderr,
    stdout: result.output,
    errorCategory: result.errorCategory ?? undefined,
    errorDetail: result.errorDetail ?? undefined,
    errorContext: result.errorContext ?? undefined,
    ...extra,
  };
}

// ── Project Context (for Codex prompts) ─────────────────────────────────────

let _projectContextCache: string | null = null;

function getProjectContext() {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (_projectContextCache) return _projectContextCache;
  _projectContextCache = `## Hydra Project Context
Key modules:
  lib/hydra-operator.ts — Interactive REPL + dispatch pipeline (main entry)
  lib/hydra-agents.ts — Agent definitions, invoke commands, model config
  lib/hydra-utils.ts — HTTP helpers, classifyPrompt, parseJsonLoose
  lib/hydra-ui.ts — Terminal colors (picocolors), formatters, dashboard
  lib/hydra-metrics.ts — In-memory + file metrics, EventEmitter
  lib/hydra-statusbar.ts — ANSI scroll region status bar
  lib/hydra-worker.ts — Headless background agent workers
  lib/hydra-council.ts — Multi-agent deliberation
  lib/hydra-dispatch.ts — Task dispatch to agents
  lib/hydra-worktree.ts — Git worktree isolation
  lib/hydra-concierge.ts — Conversational front-end
  lib/hydra-config.ts — Config loading (hydra.config.json)
  lib/hydra-evolve.ts — Self-improvement session orchestration (main, phaseDecide, reporting)
  lib/hydra-evolve-executor.ts — Phase execution engine (executeAgent/retry, phaseResearch/Deliberate/Plan/Test/Implement/Analyze)
  lib/hydra-evolve-state.ts — Session state, checkpoint helpers, status types
  lib/hydra-evolve-guardrails.ts — Safety guardrails for evolve
  lib/hydra-evolve-knowledge.ts — Knowledge base persistence

Test files: test/hydra-*.test.mjs (node:test + assert/strict)
Config: hydra.config.json
Stack: Node.js ESM, picocolors for colors, no framework deps`;
  return _projectContextCache;
}

// ── Agent Execution ─────────────────────────────────────────────────────────

const AGENT_LABELS = { claude: '❋ Claude', gemini: '✦ Gemini', codex: '֎ Codex' };
const PROGRESS_INTERVAL_MS = 15_000; // tick every 15s

// Track agents that fail repeatedly — skip them for the rest of the session
export const disabledAgents = new Set();

/**
 * Local wrapper for shared executeAgent that adds evolve-specific UI callbacks.
 */
export function executeAgent(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts = {},
): Promise<EvolveResult> {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const label = (AGENT_LABELS as Record<string, string>)[agent] || agent;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const context = opts.phaseLabel ? ` [${opts.phaseLabel}]` : '';

  return sharedExecuteAgent(agent, prompt, {
    progressIntervalMs: PROGRESS_INTERVAL_MS,
    ...opts,
    onProgress: (elapsed, outputKB, status) => {
      const elapsedStr = formatDuration(elapsed);
      const bytes = outputKB > 0 ? ` | ${String(outputKB)}KB received` : '';
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      const statusSuffix = status ? ` | ${status}` : '';
      log.dim(`${label}: working... ${elapsedStr}${bytes}${statusSuffix}${context}`);
    },
    onStatusBar: (agentName, meta) => {
      setAgentActivity(agentName, meta.step === 'running' ? 'working' : 'idle', meta.phase ?? '');
    },
  }) as Promise<EvolveResult>;
}

/**
 * Execute an agent with investigation-guided retry on failure.
 * Uses the investigator (if available) to diagnose failures and decide
 * whether to retry as-is, retry with a modified prompt, or give up.
 * If an agent fails twice, it's disabled for the rest of the session.
 */
export async function executeAgentWithRetry(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts = {},
): Promise<EvolveResult> {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const label = (AGENT_LABELS as Record<string, string>)[agent] || agent;

  // Skip agents that are known-broken this session
  if (disabledAgents.has(agent)) {
    return {
      ok: false,
      output: '',
      stderr: '',
      error: `${agent} disabled for session`,
      durationMs: 0,
      timedOut: false,
      skipped: true,
      exitCode: null,
      signal: null,
    } as EvolveResult;
  }

  const result = await executeAgent(agent, prompt, opts);
  if (result.ok) return result;

  // Don't retry timeouts (already took too long)
  if (result.timedOut) return result;

  // ── Usage limit check (multi-day quota — NO retries, immediate disable) ──
  // Verify with API first to avoid false positives from pattern matching.
  const usageCheck = detectUsageLimitError(agent, result as unknown as Record<string, unknown>);
  if (usageCheck.isUsageLimit) {
    const verification = await verifyAgentQuota(agent);
    if (verification['verified'] === true) {
      // API confirmed quota exhausted — disable the agent.
      const resetLabel = formatResetTime(usageCheck.resetInSeconds);
      log.warn(`${label}: usage limit confirmed by API — resets in ${resetLabel}`);
      log.dim(`  Triggered by: "${usageCheck.errorMessage.slice(0, 120)}"`);
      disabledAgents.add(agent);
      notifyDoctor(
        doctorPayload(agent, result, opts, {
          error: usageCheck.errorMessage,
          context: `Usage limit confirmed by API — resets in ${resetLabel}`,
        }),
      );
      result.usageLimited = true;
      result.usageLimitConfirmed = true;
      result.resetInSeconds = usageCheck.resetInSeconds ?? undefined;
      return result;
    } else if (
      verification['verified'] === 'unknown' &&
      result.errorCategory === 'codex-jsonl-error'
    ) {
      // Structured JSONL event from the Codex CLI — authoritative, not a text
      // pattern match. Trust it even without API key (Codex uses OAuth, no key).
      const resetLabel = formatResetTime(usageCheck.resetInSeconds);
      log.warn(
        `${label}: usage limit (structured JSONL — no API key to verify, but source is authoritative) — resets in ${resetLabel}`,
      );
      log.dim(`  Triggered by: "${usageCheck.errorMessage.slice(0, 120)}"`);
      disabledAgents.add(agent);
      notifyDoctor(
        doctorPayload(agent, result, opts, {
          error: usageCheck.errorMessage,
          context: `Usage limit from structured JSONL — resets in ${resetLabel}`,
        }),
      );
      result.usageLimited = true;
      result.usageLimitConfirmed = true;
      result.usageLimitStructured = true;
      result.resetInSeconds = usageCheck.resetInSeconds ?? undefined;
      return result;
    } else {
      // verified === false (API says account active) OR verified === 'unknown'
      // without a structured error source — cannot confirm quota exhaustion.
      // Fall through to rate-limit handling (may be a false positive).
      const reason =
        verification['verified'] === false
          ? 'API says account is active (false positive)'
          : `cannot verify — ${(verification['reason'] as string | undefined) ?? 'no API key'}`;
      log.dim(
        `${label}: usage limit pattern matched but ${reason} — pattern: "${usageCheck.errorMessage.slice(0, 80)}"`,
      );
      const localRef = result;
      localRef.usageLimitFalsePositive = true;
    }
  }

  // ── Rate limit recovery (cheapest check — no API calls, just backoff) ──
  const rlCheck = detectRateLimitError(agent, result as unknown as Record<string, unknown>);
  if (rlCheck.isRateLimit) {
    const cfg = loadHydraConfig();
    const rlCfg = cfg.rateLimits ?? {};
    const maxRetries = (rlCfg['maxRetries'] as number | undefined) ?? 3;
    const baseDelayMs = (rlCfg['baseDelayMs'] as number | undefined) ?? 5000;
    const maxDelayMs = (rlCfg['maxDelayMs'] as number | undefined) ?? 60_000;

    log.warn(`${label}: rate limited — ${rlCheck.errorMessage.slice(0, 100)}`);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delay = calculateBackoff(attempt, {
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: rlCheck.retryAfterMs ?? undefined,
      });
      log.dim(
        `${label}: waiting ${(delay / 1000).toFixed(0)}s before retry (${String(attempt + 1)}/${String(maxRetries)})`,
      );
      setAgentActivity(
        agent,
        'waiting',
        `Rate limited, retry ${String(attempt + 1)}/${String(maxRetries)}`,
      );
      // eslint-disable-next-line no-await-in-loop -- sequential processing required
      await new Promise<void>((r) => {
        setTimeout(r, delay);
      });

      // eslint-disable-next-line no-await-in-loop -- sequential processing required
      const retry = await executeAgent(agent, prompt, opts);
      if (retry.ok) {
        log.dim(`${label} retry: OK (${formatDuration(retry.durationMs)})`);
        return retry;
      }

      // Check if still rate limited
      const retryRlCheck = detectRateLimitError(agent, retry as unknown as Record<string, unknown>);
      if (!retryRlCheck.isRateLimit) {
        // Different error — fall through to normal error handling below
        log.dim(`${label}: no longer rate limited, but failed with: ${String(retry.error)}`);
        // Don't disable — let the investigator handle it if available
        return retry;
      }
      // Update retry-after from newest response
      rlCheck.retryAfterMs = retryRlCheck.retryAfterMs;
    }

    // Exhausted rate limit retries — disable agent
    disabledAgents.add(agent);
    log.warn(`${label} disabled for session (rate limited after ${String(maxRetries)} retries)`);
    notifyDoctor(
      doctorPayload(agent, result, opts, {
        error: result.error ?? 'rate limited',
        context: `Rate limited after ${String(maxRetries)} retries`,
      }),
    );
    result.rateLimited = true;
    return result;
  }

  // ── Model error recovery (cheap check before expensive investigator) ──
  const modelCheck = detectModelError(agent, result as unknown as Record<string, unknown>);
  if (modelCheck.isModelError) {
    log.warn(`${label}: model error detected — ${modelCheck.errorMessage}`);
    const recovery = await recoverFromModelError(agent, modelCheck.failedModel ?? '');
    if (recovery.recovered) {
      log.info(`${label}: recovered with fallback model ${String(recovery.newModel)} — retrying`);
      const retryResult = await executeAgent(agent, prompt, {
        ...opts,
        modelOverride: recovery.newModel ?? undefined,
      });
      retryResult.recovered = true;
      retryResult.originalModel = modelCheck.failedModel ?? undefined;
      retryResult.newModel = recovery.newModel ?? undefined;
      return retryResult;
    }
    // Recovery failed — disable agent and return
    log.warn(`${label}: no fallback model available — disabling for session`);
    disabledAgents.add(agent);
    notifyDoctor(
      doctorPayload(agent, result, opts, {
        error: modelCheck.errorMessage,
        context: `Model error: ${String(modelCheck.failedModel)}`,
      }),
    );
    result.modelError = modelCheck;
    return result;
  }

  // ── JSONL structured error check (auth/sandbox/invocation — no model fallback) ──
  // detectCodexError is currently codex-specific; this guard will extend to other
  // jsonOutput agents when they support structured error reporting.
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (getAgent(agent)?.features.jsonOutput) {
    const codexCheck = detectCodexError(agent, result as unknown as Record<string, unknown>);
    const retryableCodexCategories = ['transient', 'internal', 'codex-jsonl-error'];
    if (codexCheck.isCodexError && !retryableCodexCategories.includes(codexCheck.category)) {
      const catLabel = `[${codexCheck.category}] ${codexCheck.errorMessage}`;
      log.warn(`${label}: ${catLabel}`);
      disabledAgents.add(agent);
      notifyDoctor(
        doctorPayload(agent, result, opts, {
          error: catLabel,
          context: `Codex error: ${codexCheck.category}`,
        }),
      );
      return result;
    }

    // "something went wrong" within 5s of startup = config/env issue, not a transient runtime error.
    // Don't waste an investigator call — disable and report immediately with actionable guidance.
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (codexCheck.isCodexError && codexCheck.category === 'internal' && result.startupFailure) {
      const diagLabel = `[startup-failure] ${codexCheck.errorMessage === '' ? (result.errorDetail ?? result.error ?? '') : codexCheck.errorMessage}`;
      log.warn(`${label}: ${diagLabel}`);
      log.dim(
        `  Process exited after ${String(result.durationMs)}ms — check: API key validity, model ID "${result.args?.find((_a, i) => result.args?.[i - 1] === '--model') ?? 'unknown'}", CLI version, and environment.`,
      );
      disabledAgents.add(agent);
      notifyDoctor(
        doctorPayload(agent, result, opts, {
          error: diagLabel,
          context: `Codex startup failure (${String(result.durationMs)}ms runtime) — generic internal error at process start; likely misconfiguration, invalid API key, bad model flags, or incompatible CLI version`,
        }),
      );
      result.startupFailureDisabled = true;
      return result;
    }
  }

  // Log structured error diagnosis (now enriched by diagnoseAgentError)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
  if (!result.ok) {
    log.warn(`${label}: ${String(result.error)}`);
  }

  // ── Investigation-guided retry ──────────────────────────────────────
  if (isInvestigatorAvailable()) {
    log.info(`${label} failed — investigating...`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const structuredError = result.errorCategory
      ? `[${result.errorCategory}] ${String(result.errorDetail ?? result.error)}`
      : result.error;
    const diagnosis = await investigate({
      phase: 'agent',
      agent,
      error: structuredError ?? undefined,
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      stdout: (result.output || '').slice(-2000),
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      signal: result.signal,
      errorCategory: result.errorCategory ?? undefined,
      errorDetail: result.errorDetail ?? undefined,
      errorContext: result.errorContext ?? undefined,
      context: `Phase: ${opts.phaseLabel ?? 'unknown'}`,
      attemptNumber: 1,
      ...(result.durationMs == null ? {} : { durationMs: result.durationMs }), // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- runtime safety for dynamic result shape
      ...(result.startupFailure == null ? {} : { startupFailure: result.startupFailure }),
    } as Parameters<typeof investigate>[0]);

    log.dim(`Investigation: ${diagnosis.diagnosis} — ${diagnosis.explanation}`);

    if (diagnosis.diagnosis === 'fundamental') {
      log.warn(`${label}: fundamental failure — skipping retry`);
      disabledAgents.add(agent);
      notifyDoctor(
        doctorPayload(agent, result, opts, { context: `Fundamental: ${diagnosis.explanation}` }),
      );
      result.investigation = diagnosis;
      return result;
    }

    // Build retry prompt (possibly modified by investigator)
    let retryPrompt = prompt;
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (diagnosis.diagnosis === 'fixable' && diagnosis.retryRecommendation.modifiedPrompt) {
      retryPrompt = `${diagnosis.retryRecommendation.modifiedPrompt}\n\n${prompt}`;
      log.dim(`Retrying with corrective preamble`);
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    } else if (diagnosis.diagnosis === 'fixable' && diagnosis.retryRecommendation.preamble) {
      retryPrompt = `${diagnosis.retryRecommendation.preamble}\n\n${prompt}`;
      log.dim(`Retrying with diagnostic preamble`);
    }

    // Try alternative agent if recommended
    let retryAgent = agent;
    if (
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      diagnosis.retryRecommendation.retryAgent &&
      diagnosis.retryRecommendation.retryAgent !== agent
    ) {
      retryAgent = diagnosis.retryRecommendation.retryAgent;
      log.dim(`Switching to alternative agent: ${retryAgent}`);
    }

    await new Promise<void>((r) => {
      setTimeout(r, 2000);
    });
    const retry = await executeAgent(retryAgent, retryPrompt, opts);
    log.dim(
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      `${(AGENT_LABELS as Record<string, string>)[retryAgent] || retryAgent} retry: ${retry.ok ? 'OK' : 'FAIL'} (${formatDuration(retry.durationMs)})`,
    );
    retry.investigation = diagnosis;

    if (!retry.ok) {
      disabledAgents.add(agent);
      log.warn(`${label} disabled for remainder of session (investigation + retry failed)`);
      notifyDoctor(
        doctorPayload(agent, retry, opts, {
          error: retry.error ?? result.error,
          context: `Investigation + retry failed: ${diagnosis.explanation}`,
        }),
      );
    }

    return retry;
  }

  // ── Fallback: blind retry (no investigator) ─────────────────────────
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const diagLabel = result.errorCategory ? ` [${result.errorCategory}]` : '';
  log.warn(`${label} failed${diagLabel}, retrying once after 3s...`);
  await new Promise<void>((r) => {
    setTimeout(r, 3000);
  });

  const retry = await executeAgent(agent, prompt, opts);
  log.dim(
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    `${(AGENT_LABELS as Record<string, string>)[agent] || agent} retry: ${retry.ok ? 'OK' : 'FAIL'} (${formatDuration(retry.durationMs)})`,
  );

  if (!retry.ok) {
    disabledAgents.add(agent);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const retryDiag = retry.errorCategory
      ? `[${retry.errorCategory}] ${String(retry.errorDetail)}`
      : (retry.error ?? result.error);
    log.warn(
      `${label} disabled for remainder of session (consecutive failures: ${String(retryDiag)})`,
    );
    notifyDoctor(
      doctorPayload(agent, retry, opts, {
        error: retryDiag,
        context: `Consecutive failures without investigator. First: ${result.errorCategory ?? 'unknown'}, Second: ${retry.errorCategory ?? 'unknown'}`,
      }),
    );
  }

  return retry;
}

/**
 * Extract text content from an agent's JSON output.
 * If the parsed object already contains evolve-specific keys, return it directly
 * (it's the final data, not a wrapper) to avoid double-unwrapping that strips payloads.
 */
function extractOutput(rawOutput: string | null | undefined): string {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (!rawOutput) return '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
    const parsed = JSON.parse(rawOutput);
    // Detect evolve-specific payloads — return directly, don't unwrap
    if (typeof parsed === 'object' && parsed !== null) {
      const evolveKeys = [
        'selectedImprovement',
        'suggestedImprovement',
        'synthesis',
        'critique',
        'quality',
        'feasibility',
        'topPatterns',
        'applicableToHydra',
        'concerns',
        'feasibilityScore',
        'implementationNotes',
        'recommendation',
      ];
      if (evolveKeys.some((k) => k in parsed)) return rawOutput;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (parsed.result) return parsed.result; // Claude --output-format json
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (parsed.response) return parsed.response; // Gemini -o json
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (parsed.content) return parsed.content;
    if (typeof parsed === 'string') return parsed;
  } catch {
    /* use raw */
  }
  return rawOutput;
}

// ── Session-level investigation tracking ─────────────────────────────────────

export const sessionInvestigations: {
  count: number;
  healed: number;
  diagnoses: Array<{ phase: string; diagnosis: string; explanation: string }>;
} = { count: 0, healed: 0, diagnoses: [] };

export function recordInvestigation(
  phaseName: string,
  diagnosis: {
    diagnosis: string;
    explanation: string;
    retryRecommendation?: { retryPhase?: boolean };
  },
): void {
  sessionInvestigations.count++;
  sessionInvestigations.diagnoses.push({
    phase: phaseName,
    diagnosis: diagnosis.diagnosis,
    explanation: diagnosis.explanation,
  });
  if (
    (diagnosis.diagnosis === 'fixable' || diagnosis.diagnosis === 'transient') &&
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    diagnosis.retryRecommendation?.retryPhase
  ) {
    sessionInvestigations.healed++;
  }
}

/**
 * Wrap a phase function call with investigation-guided retry on failure.
 *
 * @param {string} phaseName - Phase identifier (test, implement, analyze)
 * @param {Function} phaseFn - The async phase function to call
 * @param {Array} phaseArgs - Arguments to pass to phaseFn
 * @param {object} context - Additional context for the investigator
 * @returns {Promise<object>} Phase result (possibly from retry)
 */
const _executePhaseWithInvestigation = async (
  phaseName: string,
  phaseFn: (...args: unknown[]) => Promise<{ ok: boolean; [key: string]: unknown }>,
  phaseArgs: unknown[],
  context: Record<string, unknown> = {},
) => {
  const result = await phaseFn(...phaseArgs);

  // Phase succeeded — return as-is
  if (result.ok) return result;

  // Investigator not available — return original failure
  if (!isInvestigatorAvailable()) return result;

  const cfg = loadHydraConfig();
  const maxAttempts =
    (cfg.evolve?.investigator?.['maxAttemptsPerPhase'] as number | undefined) ?? 2;
  if (maxAttempts <= 1) return result;

  log.info(`Phase ${phaseName} failed — investigating...`);
  const diagnosis = await investigate({
    phase: phaseName,
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    agent: (context['agent'] as string) || 'codex',
    error: (result['error'] as string | undefined) ?? `Phase ${phaseName} returned ok=false`,
    stderr: ((result['stderr'] as string | undefined) ?? '').slice(-2000),
    stdout: ((result['output'] as string | undefined) ?? '').slice(-2000),
    timedOut: (result['timedOut'] as boolean | undefined) || false, // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- runtime safety
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    context: (context['planSummary'] as string) || '',
    attemptNumber: 1,
  });

  recordInvestigation(phaseName, diagnosis);
  log.dim(`Investigation: ${diagnosis.diagnosis} — ${diagnosis.explanation}`);

  if (diagnosis.diagnosis === 'fundamental') {
    log.warn(`Phase ${phaseName}: fundamental failure — no retry`);
    (result as unknown as EvolveResult).investigation = diagnosis;
    return result;
  }

  if (!diagnosis.retryRecommendation.retryPhase) {
    (result as unknown as EvolveResult).investigation = diagnosis;
    return result;
  }

  // Retry the phase — if investigator provided a modified prompt, we need to
  // rebuild the phase args. For simplicity, we pass the corrective context
  // through the context object and let the caller handle prompt modification.
  log.info(`Phase ${phaseName}: retrying with investigator guidance...`);
  (result as unknown as EvolveResult).investigation = diagnosis;
  (result as unknown as EvolveResult)._shouldRetry = true;
  (result as unknown as EvolveResult)._corrective = diagnosis.corrective;
  (result as unknown as EvolveResult)._preamble =
    diagnosis.retryRecommendation.preamble ?? diagnosis.retryRecommendation.modifiedPrompt;
  return result;
};
void (_executePhaseWithInvestigation as unknown);

// ── Phase Implementations ───────────────────────────────────────────────────

/**
 * Phase 1: RESEARCH — Agents investigate external systems (web-first).
 */
export async function phaseResearch(
  area: string,
  kb: KnowledgeBase,
  {
    cwd,
    timeouts,
    evolveDir,
  }: { cwd: string; timeouts: typeof DEFAULT_PHASE_TIMEOUTS; evolveDir: string },
): Promise<ResearchResult> {
  log.phase(`RESEARCH — ${area}`);

  const kbContext = formatStatsForPrompt(kb);
  const priorLearnings = getPriorLearnings(kb, area);
  const priorContext =
    priorLearnings.length > 0
      ? `\n\nPrior learnings for "${area}":\n${priorLearnings
          .slice(0, 5)
          .map((e: KBEntry) => `- [${e.outcome ?? 'researched'}] ${e.finding?.slice(0, 200) ?? ''}`)
          .join('\n')}`
      : '';

  const claudePrompt = `# Evolve Research: ${area}

You are researching "${area}" for the Hydra multi-agent orchestration system.

Search the web for current implementations, changelogs, documentation, GitHub repos, and blog posts related to this area. Focus on:
- Current state of relevant tools and frameworks
- Novel patterns and approaches
- Recent changes or breakthroughs
- Benchmarks and comparisons

Specific search queries to try:
${getSearchQueries(area)
  .map((q: string) => `- "${q}"`)
  .join('\n')}

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "sources": [{"url": "...", "title": "...", "relevance": "high|medium|low"}],
  "findings": ["finding 1", "finding 2", ...],
  "applicableIdeas": ["idea 1", "idea 2", ...],
  "confidence": 0.0-1.0
}`;

  const geminiPrompt = `# Evolve Research: ${area}

You are researching "${area}" for the Hydra multi-agent orchestration system. Use Google Search grounding to find live results.

Search for implementations, GitHub repos, documentation, and recent discussions about:
${getSearchQueries(area)
  .map((q: string) => `- ${q}`)
  .join('\n')}

Focus on practical patterns that could be applied to a Node.js multi-agent CLI system.

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "sources": [{"url": "...", "title": "...", "relevance": "high|medium|low"}],
  "findings": ["finding 1", "finding 2", ...],
  "applicableIdeas": ["idea 1", "idea 2", ...],
  "confidence": 0.0-1.0
}`;

  const codexPrompt = `# Evolve Research: ${area} (Codebase Analysis)

${getProjectContext()}

You are analyzing the Hydra codebase to research "${area}" from an implementation perspective.

Read the existing code in the lib/ directory (see module list above) and evaluate:
1. How does Hydra currently handle aspects related to "${area}"?
2. What existing patterns, utilities, or modules could be leveraged or extended?
3. What gaps, technical debt, or bottlenecks exist in this area?
4. What concrete implementation approaches would fit the existing architecture?
5. Are there any dependencies or constraints that would affect changes in this area?

Focus on practical, code-level insights — not theory. Reference specific files, functions, and patterns you find.

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "existingPatterns": ["pattern1", "pattern2", ...],
  "gaps": ["gap1", "gap2", ...],
  "implementationIdeas": ["idea 1", "idea 2", ...],
  "relevantFiles": [{"path": "lib/file.ts", "relevance": "..."}],
  "feasibilityNotes": "...",
  "confidence": 0.0-1.0
}`;

  // Dispatch all three agents in parallel (with retry on failure)
  log.dim('Dispatching research to Claude + Gemini + Codex in parallel...');
  const [claudeResult, geminiResult, codexResult] = await Promise.all([
    executeAgentWithRetry('claude', claudePrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area}`,
    }),
    executeAgentWithRetry('gemini', geminiPrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area}`,
    }),
    executeAgentWithRetry('codex', codexPrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area} (codebase)`,
    }),
  ]);

  log.dim(
    `Claude: ${claudeResult.ok ? 'OK' : 'FAIL'} (${formatDuration(claudeResult.durationMs)})`,
  );
  log.dim(
    `Gemini: ${geminiResult.ok ? 'OK' : 'FAIL'} (${formatDuration(geminiResult.durationMs)})`,
  );
  log.dim(`Codex:  ${codexResult.ok ? 'OK' : 'FAIL'} (${formatDuration(codexResult.durationMs)})`);

  // Log warnings for agent failures with stderr context
  for (const [name, result] of [
    ['Claude', claudeResult],
    ['Gemini', geminiResult],
    ['Codex', codexResult],
  ] as Array<[string, EvolveResult]>) {
    if (!result.ok) {
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      const stderrSnippet = result.stderr ? result.stderr.slice(-500).trim() : '';
      log.warn(
        `${name} research failed: ${result.error ?? 'unknown'}${result.timedOut ? ' (TIMEOUT)' : ''}`,
      );
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      if (stderrSnippet) log.dim(`  stderr: ${stderrSnippet.slice(0, 200)}`);
    }
  }

  const claudeData = parseJsonLoose(extractOutput(claudeResult.output));
  const geminiData = parseJsonLoose(extractOutput(geminiResult.output));
  const codexData = parseJsonLoose(extractOutput(codexResult.output));

  // Log warnings for successful agents that returned unparseable output
  for (const [name, result, data] of [
    ['Claude', claudeResult, claudeData],
    ['Gemini', geminiResult, geminiData],
    ['Codex', codexResult, codexData],
  ] as Array<[string, EvolveResult, unknown]>) {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (result.ok && !data) {
      const rawSnippet = extractOutput(result.output).slice(0, 200);
      log.warn(`${name} returned OK but output could not be parsed as JSON`);
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      if (rawSnippet) log.dim(`  raw: ${rawSnippet}`);
    }
  }

  const combined = {
    area,
    claudeFindings: (claudeData as {
      findings?: string[];
      applicableIdeas?: string[];
      sources?: unknown[];
    } | null) ?? {
      findings: [] as string[],
      applicableIdeas: [] as string[],
      sources: [] as unknown[],
    },
    geminiFindings: (geminiData as {
      findings?: string[];
      applicableIdeas?: string[];
      sources?: unknown[];
    } | null) ?? {
      findings: [] as string[],
      applicableIdeas: [] as string[],
      sources: [] as unknown[],
    },
    codexFindings: (codexData as {
      existingPatterns?: string[];
      gaps?: string[];
      implementationIdeas?: string[];
      relevantFiles?: unknown[];
    } | null) ?? {
      existingPatterns: [] as string[],
      gaps: [] as string[],
      implementationIdeas: [] as string[],
      relevantFiles: [] as unknown[],
    },
  };

  // Save research artifact
  const researchDir = path.join(evolveDir, 'research');
  ensureDir(researchDir);

  return combined;
}

/**
 * Extract an improvement description from raw agent text when JSON parsing fails.
 * Looks for labeled lines ("Improvement:", "Selected:", etc.) or first substantial sentence.
 */
function extractImprovementFromText(rawOutput: string | null | undefined) {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (!rawOutput || typeof rawOutput !== 'string') return null;
  const lines = rawOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Look for labeled lines
  for (const line of lines) {
    const match = line.match(
      /^(?:improvement|suggested|selected|recommendation|proposal)\s*:\s*(.+)/i,
    );
    if (match && match[1].length > 20) return match[1].trim();
  }

  // Look for the first substantial sentence that isn't a JSON fragment
  for (const line of lines) {
    if (line.startsWith('{') || line.startsWith('[') || line.startsWith('```')) continue;
    if (line.length > 20 && /[a-zA-Z]/.test(line)) return line;
  }

  return null;
}

/**
 * Make a deliberation step resilient: parse JSON, fall back to text extraction.
 * Returns parsed data or a minimal fallback object, plus a warning if fallback was used.
 */
function resilientParse(
  rawOutput: string | null | undefined,
  resultOk: boolean,
  stepName: string,
  fallbackKey: string,
): { data: Record<string, unknown> | null; fallback: boolean } {
  const extracted = extractOutput(rawOutput);
  const parsed = parseJsonLoose(extracted) as Record<string, unknown> | null;
  if (parsed) return { data: parsed, fallback: false };

  if (!resultOk) return { data: null, fallback: false };

  // Agent succeeded but JSON parsing failed — try text extraction
  const snippet = (typeof extracted === 'string' ? extracted : (rawOutput ?? '')).slice(0, 300);
  log.warn(`${stepName}: JSON parse failed, trying text extraction`);
  log.dim(`  raw: ${snippet}`);

  const text = extractImprovementFromText(typeof extracted === 'string' ? extracted : rawOutput);
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (text) {
    log.dim(`  extracted: ${text.slice(0, 100)}`);
    return { data: { [fallbackKey]: text }, fallback: true };
  }

  return { data: null, fallback: false };
}

/**
 * Phase 2: DELIBERATE — Council discusses findings.
 */
export async function phaseDeliberate(
  research: ResearchResult,
  kb: KnowledgeBase,
  { cwd, timeouts }: { cwd: string; timeouts: typeof DEFAULT_PHASE_TIMEOUTS },
): Promise<DeliberationResult> {
  log.phase('DELIBERATE');

  const kbContext = formatStatsForPrompt(kb);
  const findingsBlock = JSON.stringify(research, null, 2);

  // Step 1: Claude synthesizes
  /* eslint-disable @typescript-eslint/no-unsafe-member-access */
  const synthesizePrompt = `# Evolve Deliberation: Synthesize Research

You are synthesizing research findings about "${research.area}" for the Hydra multi-agent orchestration system.

## Research Findings
${findingsBlock}

## Knowledge Base Context
${kbContext}

Analyze all findings and produce a synthesis:
1. What are the most important patterns/ideas found externally (Claude + Gemini research)?
2. Which are actually applicable to Hydra (a Node.js multi-agent CLI orchestrator)?
3. What codebase gaps and existing patterns did Codex identify that inform the approach?
4. What's the highest-impact single improvement we could make?

Respond with JSON:
{
  "synthesis": "...",
  "topPatterns": ["pattern1", "pattern2", ...],
  "applicableToHydra": ["idea1", "idea2", ...],
  "suggestedImprovement": "...",
  "rationale": "..."
}`;
  /* eslint-enable @typescript-eslint/no-unsafe-member-access */

  log.dim('Step 1/4: Claude synthesizing research findings...');
  const synthResult = await executeAgent('claude', synthesizePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: synthesize',
  });
  const synthParsed = resilientParse(
    synthResult.output,
    synthResult.ok,
    'Synthesize',
    'suggestedImprovement',
  );
  const synthData = synthParsed.data;
  log.dim(
    `Synthesis: ${synthResult.ok ? 'OK' : 'FAIL'}${synthParsed.fallback ? ' (fallback)' : ''} (${formatDuration(synthResult.durationMs)})`,
  );

  // Step 2: Gemini critiques
  /* eslint-disable @typescript-eslint/no-unsafe-member-access */
  const critiquePrompt = `# Evolve Deliberation: Critique

Review this synthesis of research findings about "${research.area}" for the Hydra project:

${JSON.stringify(synthData ?? { synthesis: 'No synthesis available' }, null, 2)}

Critically evaluate:
1. Are the conclusions well-supported by the research?
2. Is the suggested improvement actually feasible for a Node.js CLI tool?
3. What risks or downsides are being overlooked?
4. Is there a better alternative improvement?

Respond with JSON:
{
  "critique": "...",
  "concerns": ["concern1", "concern2", ...],
  "risks": ["risk1", "risk2", ...],
  "alternativeIdea": "..." or null,
  "feasibilityScore": 1-10
}`;
  /* eslint-enable @typescript-eslint/no-unsafe-member-access */

  log.dim('Step 2/4: Gemini critiquing synthesis...');
  const critiqueResult = await executeAgentWithRetry('gemini', critiquePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: critique',
  });
  const critiqueParsed = resilientParse(
    critiqueResult.output,
    critiqueResult.ok,
    'Critique',
    'critique',
  );
  const critiqueData = critiqueParsed.data;
  log.dim(
    `Critique: ${critiqueResult.ok ? 'OK' : 'FAIL'}${critiqueParsed.fallback ? ' (fallback)' : ''} (${formatDuration(critiqueResult.durationMs)})`,
  );

  // Step 3: Codex feasibility assessment
  const feasibilityPrompt = `# Evolve Deliberation: Feasibility Assessment

${getProjectContext()}

You are evaluating the implementation feasibility of a proposed improvement to the Hydra project.

## Proposed Improvement
${JSON.stringify((synthData as { suggestedImprovement?: string } | null)?.suggestedImprovement ?? 'See synthesis', null, 2)}

## Synthesis
${JSON.stringify(synthData ?? {}, null, 2)}

## Critique & Concerns
${JSON.stringify(critiqueData ?? {}, null, 2)}

Read the relevant source files in lib/ and evaluate from an implementation perspective:
1. How complex is this change? (estimate lines of code, files touched)
2. Does it conflict with existing patterns or architecture?
3. What's the test strategy? Can it be tested with node:test?
4. Are there hidden dependencies or side effects?
5. Can it be implemented incrementally or is it all-or-nothing?

Respond with JSON:
{
  "feasibility": "high|medium|low",
  "complexity": "trivial|moderate|complex|major",
  "estimatedFiles": 1-10,
  "conflicts": ["conflict1", ...] or [],
  "testStrategy": "...",
  "implementationNotes": "...",
  "recommendation": "proceed|simplify|reconsider"
}`;

  log.dim('Step 3/4: Codex assessing implementation feasibility...');
  const feasibilityResult = await executeAgentWithRetry('codex', feasibilityPrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: feasibility',
  });
  const feasibilityParsed = resilientParse(
    feasibilityResult.output,
    feasibilityResult.ok,
    'Feasibility',
    'implementationNotes',
  );
  const feasibilityData = feasibilityParsed.data;
  log.dim(
    `Feasibility: ${feasibilityResult.ok ? 'OK' : 'FAIL'}${feasibilityParsed.fallback ? ' (fallback)' : ''} (${formatDuration(feasibilityResult.durationMs)})`,
  );

  // Step 4: Claude prioritizes and selects
  const prioritizePrompt = `# Evolve Deliberation: Final Selection

Based on the synthesis, critique, and feasibility assessment, select the single best improvement to attempt.

## Synthesis
${JSON.stringify(synthData ?? {}, null, 2)}

## Critique
${JSON.stringify(critiqueData ?? {}, null, 2)}

## Feasibility Assessment
${JSON.stringify(feasibilityData ?? {}, null, 2)}

Consider the critique's concerns, risks, and the feasibility assessment. Select the improvement that:
- Has the highest positive impact
- Is most feasible to implement (per Codex's assessment)
- Has acceptable risk level
- Can be tested with the existing test infrastructure

Respond with JSON:
{
  "selectedImprovement": "...",
  "rationale": "...",
  "expectedImpact": "high|medium|low",
  "risks": ["risk1", ...],
  "constraints": ["constraint1", ...]
}`;

  log.dim('Step 4/4: Claude selecting best improvement...');
  const priorityResult = await executeAgent('claude', prioritizePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: prioritize',
  });
  const priorityParsed = resilientParse(
    priorityResult.output,
    priorityResult.ok,
    'Prioritize',
    'selectedImprovement',
  );
  const priorityData = priorityParsed.data;
  log.dim(
    `Priority: ${priorityResult.ok ? 'OK' : 'FAIL'}${priorityParsed.fallback ? ' (fallback)' : ''} (${formatDuration(priorityResult.durationMs)})`,
  );

  // Determine selected improvement with cascading fallbacks
  let selectedImprovement =
    (priorityData as { selectedImprovement?: string } | null)?.selectedImprovement ??
    (synthData as { suggestedImprovement?: string } | null)?.suggestedImprovement;

  // Research-based fallback: extract top idea directly from research findings
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (!selectedImprovement) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
    const researchFallback =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
      research.claudeFindings.applicableIdeas?.[0] ??
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
      research.geminiFindings.applicableIdeas?.[0] ??
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
      research.codexFindings.implementationIdeas?.[0];
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (researchFallback) {
      log.warn('Using top research finding as improvement (deliberation parsing failed)');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
      selectedImprovement = researchFallback;
    }
  }

  selectedImprovement ??= 'No improvement selected';

  return {
    synthesis: synthData,
    critique: critiqueData,
    feasibility: feasibilityData,
    priority: priorityData,
    selectedImprovement,
  };
}

/**
 * Phase 3: PLAN — Create improvement spec + test plan.
 */
export async function phasePlan(
  deliberation: {
    selectedImprovement: string;
    synthesis?: Record<string, unknown> | null;
    critique?: Record<string, unknown> | null;
    feasibility?: Record<string, unknown> | null;
    priority?: Record<string, unknown> | null;
  },
  area: string,
  kb: KnowledgeBase,
  {
    cwd,
    timeouts,
    evolveDir,
    roundNum,
  }: { cwd: string; timeouts: typeof DEFAULT_PHASE_TIMEOUTS; evolveDir: string; roundNum: number },
): Promise<PlanResult> {
  log.phase('PLAN');

  const priorLearnings = getPriorLearnings(kb, area);
  const learningsBlock =
    priorLearnings.length > 0
      ? `\n## Prior Learnings for "${area}" (avoid repeating these mistakes)\n${priorLearnings
          .slice(0, 5)
          .map((e: KBEntry) => `- [${String(e.outcome)}] ${String(e.learnings ?? e.finding)}`)
          .join('\n')}`
      : '';

  /* eslint-disable @typescript-eslint/strict-boolean-expressions */
  const planPrompt = `# Evolve Plan: Improvement Specification

Create a detailed implementation plan for the following improvement to the Hydra project:

## Selected Improvement
${deliberation.selectedImprovement}

## Rationale
${((deliberation.priority as Record<string, unknown> | null)?.['rationale'] as string) || ((deliberation.synthesis as Record<string, unknown> | null)?.['rationale'] as string) || 'N/A'}

## Key Patterns Found
${JSON.stringify((deliberation.synthesis as Record<string, unknown> | null)?.['topPatterns'] ?? [], null, 2)}

## Concerns to Watch For
${JSON.stringify((deliberation.critique as Record<string, unknown> | null)?.['concerns'] ?? [], null, 2)}

## Implementation Notes (from feasibility assessment)
${((deliberation.feasibility as Record<string, unknown> | null)?.['implementationNotes'] as string) || 'N/A'}

## Risks & Constraints
${JSON.stringify((deliberation.priority as Record<string, unknown> | null)?.['risks'] ?? [], null, 2)}
${JSON.stringify((deliberation.priority as Record<string, unknown> | null)?.['constraints'] ?? [], null, 2)}
${learningsBlock}

## Hydra Project Context
- Node.js multi-agent orchestration system (Claude/Gemini/Codex)
- Main modules: hydra-operator.ts, hydra-utils.ts, hydra-agents.ts, hydra-ui.ts, hydra-metrics.ts, hydra-statusbar.ts
- Uses picocolors for terminal colors, no external deps besides that
- Tests use Node.js built-in test runner (node --test)

## Required Output
Respond with JSON:
{
  "objectives": ["obj1", "obj2", ...],
  "constraints": ["constraint1", ...],
  "acceptanceCriteria": ["criterion1", ...],
  "filesToModify": [{"path": "lib/file.ts", "changes": "description"}],
  "testPlan": {
    "scenarios": ["scenario1", ...],
    "edgeCases": ["edge1", ...],
    "variables": ["var1", ...],
    "expectedBehaviors": ["behavior1", ...]
  },
  "rollbackCriteria": ["criterion1", ...]
}`;
  /* eslint-enable @typescript-eslint/strict-boolean-expressions */

  const planResult = await executeAgent('claude', planPrompt, {
    cwd,
    timeoutMs: timeouts.planTimeoutMs,
    phaseLabel: 'plan: spec',
  });
  const planData = parseJsonLoose(extractOutput(planResult.output)) as {
    objectives?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    filesToModify?: Array<{ path: string; changes: string }>;
    testPlan?: { scenarios?: string[]; edgeCases?: string[] };
    rollbackCriteria?: string[];
  } | null;
  log.dim(`Plan: ${planResult.ok ? 'OK' : 'FAIL'} (${formatDuration(planResult.durationMs)})`);

  // Save spec artifact
  const specsDir = path.join(evolveDir, 'specs');
  ensureDir(specsDir);
  const specPath = path.join(specsDir, `ROUND_${String(roundNum)}_SPEC.md`);

  const specContent = `# Evolve Round ${String(roundNum)} Spec — ${area}
## Improvement
${deliberation.selectedImprovement}

## Objectives
${(planData?.objectives ?? []).map((o: string) => `- ${o}`).join('\n')}

## Constraints
${(planData?.constraints ?? []).map((c: string) => `- ${c}`).join('\n')}

## Acceptance Criteria
${(planData?.acceptanceCriteria ?? []).map((a: string) => `- ${a}`).join('\n')}

## Files to Modify
${(planData?.filesToModify ?? []).map((f: { path: string; changes: string }) => `- \`${f.path}\`: ${f.changes}`).join('\n')}

## Test Plan
### Scenarios
${(planData?.testPlan?.scenarios ?? []).map((s: string) => `- ${s}`).join('\n')}

### Edge Cases
${(planData?.testPlan?.edgeCases ?? []).map((e: string) => `- ${e}`).join('\n')}

## Rollback Criteria
${(planData?.rollbackCriteria ?? []).map((r: string) => `- ${r}`).join('\n')}
`;

  fs.writeFileSync(specPath, specContent, 'utf8');
  log.ok(`Spec saved: ${specPath}`);

  return { plan: planData, specPath };
}

/**
 * Phase 4: TEST — Write comprehensive tests (TDD).
 */
export async function phaseTest(
  plan: { plan?: PlanData | null },
  _branchName: string,
  safetyPrompt: string,
  {
    cwd,
    timeouts,
    investigatorPreamble,
  }: { cwd: string; timeouts: typeof DEFAULT_PHASE_TIMEOUTS; investigatorPreamble?: string },
): Promise<ExecutionPhaseResult> {
  log.phase('TEST');

  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const preambleBlock = investigatorPreamble
    ? `## Investigator Guidance (from prior failure analysis)\n${investigatorPreamble}\n\n`
    : '';

  const testPrompt = `# Evolve: Write Tests (TDD)

${preambleBlock}Write comprehensive tests for the following improvement plan. Tests MUST be written BEFORE the implementation.

## Plan
${JSON.stringify(plan.plan ?? {}, null, 2)}

## Requirements
- Use Node.js built-in test runner: \`import { test, describe } from 'node:test'\`
- Use \`import assert from 'node:assert/strict'\`
- Cover: happy path, edge cases, error states, boundary conditions
- Tests should be in a new file under \`test/\` directory
- Make tests specific and descriptive
- Tests should verify behavior, not implementation details

## Important
- Write tests that CAN fail (they test functionality that doesn't exist yet)
- Include at least one test per scenario and edge case from the plan
- Commit the test file(s) when done

${safetyPrompt}`;

  const testResult = await executeAgent('codex', testPrompt, {
    cwd,
    timeoutMs: timeouts.testTimeoutMs,
    phaseLabel: 'test: write TDD tests',
  });

  if (testResult.ok) {
    log.dim(`Tests: OK (${formatDuration(testResult.durationMs)})`);
  } else {
    log.warn(`Tests: FAIL (${formatDuration(testResult.durationMs)})`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (testResult.error) log.dim(`  Error: ${testResult.error}`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const stderrLines = (testResult.stderr || '').trim().split('\n').filter(Boolean);
    if (stderrLines.length > 0) {
      for (const line of stderrLines.slice(-3)) {
        log.dim(`  ${line.trim()}`);
      }
    }
  }
  return {
    ok: testResult.ok,
    output: testResult.output,
    stderr: testResult.stderr,
    error: testResult.error,
    durationMs: testResult.durationMs,
    timedOut: testResult.timedOut,
  };
}

/**
 * Phase 5: IMPLEMENT — Make changes on isolated branch.
 */
export async function phaseImplement(
  plan: { plan?: PlanData | null },
  _branchName: string,
  safetyPrompt: string,
  {
    cwd,
    timeouts,
    investigatorPreamble,
    deliberation,
    agentOverride = null,
  }: {
    cwd: string;
    timeouts: typeof DEFAULT_PHASE_TIMEOUTS;
    investigatorPreamble?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime safety
    deliberation?: any;
    agentOverride?: string | null;
  },
): Promise<ExecutionPhaseResult> {
  const implAgent = agentOverride ?? 'codex';
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  log.phase(agentOverride ? `IMPLEMENT (${agentOverride})` : 'IMPLEMENT');

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- runtime safety
  const improvementDesc =
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- runtime safety
    deliberation?.selectedImprovement ?? plan.plan?.objectives?.[0] ?? 'See plan for details';
  const acceptanceCriteria = ((plan.plan?.['acceptanceCriteria'] as string[]) || []) // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
    .map((c: string) => `- ${c}`)
    .join('\n');

  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const preambleBlock = investigatorPreamble
    ? `## Investigator Guidance (from prior failure analysis)\n${investigatorPreamble}\n\n`
    : '';

  /* eslint-disable @typescript-eslint/strict-boolean-expressions */
  const implPrompt = `# Evolve: Implement Improvement

${preambleBlock}Implement the improvement described in the spec below. Tests already exist on this branch — make them pass.

## Improvement Goal
${String(improvementDesc)}

## Plan
${JSON.stringify(plan.plan ?? {}, null, 2)}

${acceptanceCriteria ? `## Acceptance Criteria\n${acceptanceCriteria}\n` : ''}
## Requirements
- Read existing code before making changes
- Make focused, minimal changes
- Run \`node --test\` to verify tests pass
- Commit your changes with a descriptive message
- Do NOT modify test files — only implementation files

${safetyPrompt}`;
  /* eslint-enable @typescript-eslint/strict-boolean-expressions */

  const implResult = await executeAgent(implAgent, implPrompt, {
    cwd,
    timeoutMs: timeouts.implementTimeoutMs,
    phaseLabel: 'implement: make tests pass',
  });

  if (implResult.ok) {
    log.dim(`Implement: OK (${formatDuration(implResult.durationMs)})`);
  } else {
    log.warn(`Implement: FAIL (${formatDuration(implResult.durationMs)})`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    if (implResult.error) log.dim(`  Error: ${implResult.error}`);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const stderrLines = (implResult.stderr || '').trim().split('\n').filter(Boolean);
    if (stderrLines.length > 0) {
      for (const line of stderrLines.slice(-3)) {
        log.dim(`  ${line.trim()}`);
      }
    }
  }
  return {
    ok: implResult.ok,
    output: implResult.output,
    stderr: implResult.stderr,
    error: implResult.error,
    durationMs: implResult.durationMs,
    timedOut: implResult.timedOut,
  };
}

/**
 * Phase 6: ANALYZE — Multi-agent review of results.
 */
export async function phaseAnalyze(
  diff: string,
  _branchName: string,
  plan: { plan?: PlanData | null },
  {
    cwd,
    timeouts,
    deliberation,
  }: {
    cwd: string;
    timeouts: typeof DEFAULT_PHASE_TIMEOUTS;
    deliberation?: { selectedImprovement?: string } | null;
  } = { cwd: '', timeouts: DEFAULT_PHASE_TIMEOUTS },
): Promise<AnalysisResult> {
  log.phase('ANALYZE');

  const diffBlock = diff.length > 8000 ? `${diff.slice(0, 8000)}\n...(truncated)` : diff;
  const improvementGoal =
    deliberation?.selectedImprovement ?? plan.plan?.objectives?.[0] ?? 'See plan for details';
  const acceptanceCriteria = ((plan.plan?.['acceptanceCriteria'] as string[]) || []) // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
    .map((c: string) => `- ${c}`)
    .join('\n');

  /* eslint-disable @typescript-eslint/strict-boolean-expressions */
  const reviewPrompt = (_agent: string, focus: string) => `# Evolve Analysis: ${focus}

Review the implementation diff below for a Hydra improvement.

## Improvement Goal
${improvementGoal}

${acceptanceCriteria ? `## Acceptance Criteria\n${acceptanceCriteria}\n` : ''}
## Diff
\`\`\`
${diffBlock}
\`\`\`

## Your Focus: ${focus}
Score the implementation on:
- quality (1-10): Code quality, style consistency, correctness
- confidence (1-10): How confident are you in this assessment

Respond with JSON:
{
  "quality": 1-10,
  "confidence": 1-10,
  "concerns": ["concern1", ...],
  "suggestions": ["suggestion1", ...],
  "verdict": "approve" | "reject" | "revise"
}`;
  /* eslint-enable @typescript-eslint/strict-boolean-expressions */

  log.dim('Dispatching analysis to Claude + Gemini + Codex in parallel...');
  const [claudeResult, geminiResult, codexResult] = await Promise.all([
    executeAgentWithRetry(
      'claude',
      reviewPrompt('claude', 'Architectural quality, code style, spec alignment'),
      {
        cwd,
        timeoutMs: timeouts.analyzeTimeoutMs,
        phaseLabel: 'analyze: architecture review',
      },
    ),
    executeAgentWithRetry(
      'gemini',
      reviewPrompt('gemini', 'Regression risk, pattern consistency, codebase fit'),
      {
        cwd,
        timeoutMs: timeouts.analyzeTimeoutMs,
        phaseLabel: 'analyze: regression review',
      },
    ),
    executeAgentWithRetry(
      'codex',
      reviewPrompt('codex', 'Test coverage, implementation correctness, runtime safety'),
      {
        cwd,
        timeoutMs: timeouts.analyzeTimeoutMs,
        phaseLabel: 'analyze: correctness review',
      },
    ),
  ]);

  const claudeAnalysis = parseJsonLoose(extractOutput(claudeResult.output)) as Record<
    string,
    unknown
  > | null;
  const geminiAnalysis = parseJsonLoose(extractOutput(geminiResult.output)) as Record<
    string,
    unknown
  > | null;
  const codexAnalysis = parseJsonLoose(extractOutput(codexResult.output)) as Record<
    string,
    unknown
  > | null;

  log.dim(`Claude analysis: ${claudeResult.ok ? 'OK' : 'FAIL'}`);
  log.dim(`Gemini analysis: ${geminiResult.ok ? 'OK' : 'FAIL'}`);
  log.dim(`Codex analysis:  ${codexResult.ok ? 'OK' : 'FAIL'}`);

  // Also run tests
  log.dim('Running test suite...');
  setAgentActivity('codex', 'working', 'Running test suite');
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  const testRun = runProcess('node', ['--test'], timeouts.testTimeoutMs || 600_000, { cwd });
  const testsPassed = testRun.ok;
  const testDetails = parseTestOutput(testRun.stdout, testRun.stderr);
  setAgentActivity(
    'codex',
    testsPassed ? 'idle' : 'error',
    testsPassed ? 'Tests passed' : 'Tests failed',
  );

  if (testsPassed) {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const durStr = testDetails.durationMs
      ? ` (${(testDetails.durationMs / 1000).toFixed(1)}s)`
      : '';
    log.ok(
      `Tests: PASS — ${testDetails.total > 0 ? `${String(testDetails.passed)}/${String(testDetails.total)}` : 'OK'}${durStr}`,
    );
  } else {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    const durStr = testDetails.durationMs
      ? ` (${(testDetails.durationMs / 1000).toFixed(1)}s)`
      : '';
    const countStr =
      testDetails.total > 0
        ? ` — ${String(testDetails.failed)}/${String(testDetails.total)} failed`
        : '';
    log.warn(`Tests: FAIL${countStr}${durStr}`);
    for (const f of testDetails.failures.slice(0, 5)) {
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
      const errSuffix = f.error ? ` — ${f.error}` : '';
      log.dim(`  x ${f.name}${errSuffix}`);
    }
  }

  // Aggregate scores
  const scores = [claudeAnalysis, geminiAnalysis, codexAnalysis].filter(
    (x): x is Record<string, unknown> => Boolean(x),
  );
  const avgQuality =
    scores.length > 0
      ? scores.reduce(
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          (s: number, a: Record<string, unknown>) => s + ((a['quality'] as number) || 0),
          0,
        ) / scores.length
      : 0;
  const avgConfidence =
    scores.length > 0
      ? scores.reduce(
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
          (s: number, a: Record<string, unknown>) => s + ((a['confidence'] as number) || 0),
          0,
        ) / scores.length
      : 0;
  const allConcerns = scores.flatMap(
    (s: Record<string, unknown>) => (s['concerns'] as string[]) || [], // eslint-disable-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
  );

  // Collect per-agent verdicts
  const agentVerdicts = {
    claude: (claudeAnalysis?.['verdict'] as string | null) ?? null,
    gemini: (geminiAnalysis?.['verdict'] as string | null) ?? null,
    codex: (codexAnalysis?.['verdict'] as string | null) ?? null,
  };

  return {
    agentScores: { claude: claudeAnalysis, gemini: geminiAnalysis, codex: codexAnalysis },
    agentVerdicts,
    aggregateScore: Math.round(avgQuality * 10) / 10,
    aggregateConfidence: Math.round(avgConfidence * 10) / 10,
    concerns: allConcerns,
    testsPassed,
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
    testOutput: (testRun.stdout || '').slice(-2000),
    testDetails,
  };
}

function getSearchQueries(area: string): string[] {
  const queries = {
    'orchestration-patterns': [
      'CrewAI task delegation approach 2026',
      'AutoGen multi-agent conversation patterns',
      'LangGraph agent orchestration',
      'MetaGPT multi-agent programming',
      'multi-agent orchestration framework comparison',
    ],
    'ai-coding-tools': [
      'Cursor AI coding assistant architecture',
      'Aider AI pair programming patterns',
      'Cline VS Code AI assistant',
      'AI coding tool CLI design patterns',
      'Windsurf AI coding features',
    ],
    'testing-reliability': [
      'testing AI agent systems reliability',
      'property-based testing AI outputs',
      'flaky test mitigation strategies',
      'AI system testing best practices 2026',
      'deterministic testing for LLM applications',
    ],
    'developer-experience': [
      'CLI developer experience best practices',
      'terminal UI patterns Node.js',
      'REPL design patterns developer tools',
      'progressive disclosure CLI design',
      'AI tool developer onboarding UX',
    ],
    'model-routing': [
      'mixture of agents model routing',
      'LLM routing strategies cost optimization',
      'multi-model selection algorithms',
      'AI model cascade patterns',
      'prompt routing classifier design',
    ],
    'daemon-architecture': [
      'task queue daemon architecture Node.js',
      'Temporal workflow engine patterns',
      'BullMQ job processing patterns',
      'event-driven daemon design patterns',
      'long-running process management Node.js',
    ],
  };
  return (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions -- runtime safety
    (queries as Record<string, string[]>)[area] || [
      `${area} best practices 2026`,
      `${area} implementation patterns`,
      `${area} tools and frameworks`,
    ]
  );
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${String(mins)}m ${String(remSecs)}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${String(hrs)}h ${String(remMins)}m`;
}
