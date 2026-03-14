/**
 * Hydra Evolve Investigator — Self-healing failure diagnosis for the evolve pipeline.
 *
 * When an evolve phase fails (test doesn't compile, implementation breaks tests,
 * agent returns garbage), this module calls a high-reasoning OpenAI model to
 * diagnose the root cause and recommend corrective action.
 *
 * Diagnosis buckets:
 *   transient    — Retry as-is (network flake, rate limit, temporary API issue)
 *   fixable      — Retry with modified prompt/preamble (bad instructions, missing context)
 *   fundamental  — Don't retry (impossible task, missing dependency, wrong approach)
 */

import fs from 'node:fs';
import path from 'node:path';
import { streamCompletion } from './hydra-openai.ts';
import { loadHydraConfig } from './hydra-config.ts';

// ── State ────────────────────────────────────────────────────────────────────

interface InvestigatorConfig {
  enabled: boolean;
  model: string;
  reasoningEffort: string;
  maxAttemptsPerPhase: number;
  phases: string[];
  maxTokensBudget: number;
  tryAlternativeAgent: boolean;
  logToFile: boolean;
}

interface DiagnosisResult {
  diagnosis: string;
  explanation: string;
  rootCause: string;
  corrective: string | null;
  retryRecommendation: {
    retryPhase: boolean;
    modifiedPrompt: string | null;
    preamble: string | null;
    retryAgent: string | null;
  };
  tokens?: { prompt: number; completion: number };
}

interface EvolveFailure {
  phase: string;
  agent?: string;
  error?: string;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
  context?: string;
  attemptNumber?: number;
  exitCode?: number | null;
  signal?: string | null;
  errorCategory?: string;
  errorDetail?: string;
  errorContext?: string;
  command?: string;
  args?: string[];
  promptSnippet?: string;
  durationMs?: number;
  startupFailure?: boolean;
}

let _investigatorReady = false;
void _investigatorReady; // suppress noUnusedLocals — state flag written by init/reset
let stats = { investigations: 0, healed: 0, promptTokens: 0, completionTokens: 0 };
let tokenBudgetUsed = 0;
let config: InvestigatorConfig | null = null;

// ── Config ───────────────────────────────────────────────────────────────────

function getInvestigatorConfig(): InvestigatorConfig {
  if (config) return config;
  const cfg = loadHydraConfig();
  const inv = cfg.evolve?.investigator ?? {};
  config = {
    enabled: inv['enabled'] !== false,
    model: (inv['model'] as string | undefined) ?? 'gpt-5.2',
    reasoningEffort: (inv['reasoningEffort'] as string | undefined) ?? 'high',
    maxAttemptsPerPhase: (inv['maxAttemptsPerPhase'] as number | undefined) ?? 2,
    phases: (inv['phases'] as string[] | undefined) ?? ['test', 'implement', 'analyze', 'agent'],
    maxTokensBudget: (inv['maxTokensBudget'] as number | undefined) ?? 50_000,
    tryAlternativeAgent: inv['tryAlternativeAgent'] !== false,
    logToFile: inv['logToFile'] !== false,
  };
  return config;
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the investigator. Validates API key and loads config.
 * @param {object} [overrides] - Optional config overrides
 */
export function initInvestigator(overrides: Partial<InvestigatorConfig> = {}): void {
  config = null; // Force reload
  const cfg = getInvestigatorConfig();

  // Apply overrides
  if (overrides.model !== undefined && overrides.model !== '') cfg.model = overrides.model;
  if (overrides.reasoningEffort !== undefined && overrides.reasoningEffort !== '')
    cfg.reasoningEffort = overrides.reasoningEffort;
  if (
    overrides.maxTokensBudget !== undefined &&
    overrides.maxTokensBudget !== 0 &&
    !Number.isNaN(overrides.maxTokensBudget)
  )
    cfg.maxTokensBudget = overrides.maxTokensBudget;

  config = cfg;
  stats = { investigations: 0, healed: 0, promptTokens: 0, completionTokens: 0 };
  tokenBudgetUsed = 0;
  _investigatorReady = true;
}

/**
 * Check if the investigator is available (enabled + API key present).
 */
export function isInvestigatorAvailable(): boolean {
  const cfg = getInvestigatorConfig();
  if (!cfg.enabled) return false;
  return Boolean(process.env['OPENAI_API_KEY']);
}

/**
 * Get session stats for the investigator.
 */
export function getInvestigatorStats(): {
  investigations: number;
  healed: number;
  promptTokens: number;
  completionTokens: number;
  tokenBudgetUsed: number;
  tokenBudgetMax: number;
} {
  return { ...stats, tokenBudgetUsed, tokenBudgetMax: getInvestigatorConfig().maxTokensBudget };
}

/**
 * Reset investigator state for a new session.
 */
export function resetInvestigator(): void {
  stats = { investigations: 0, healed: 0, promptTokens: 0, completionTokens: 0 };
  tokenBudgetUsed = 0;
  config = null;
  _investigatorReady = false;
}

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are the Hydra Evolve Investigator — a failure diagnostician for the Hydra multi-agent orchestration system's autonomous self-improvement pipeline.

Your job: When an evolve phase fails, you analyze the error context and classify the failure so the pipeline can self-heal or gracefully give up.

## Hydra Context
Hydra orchestrates Claude, Gemini, and Codex agents. The evolve pipeline runs 7 phases per round:
1. RESEARCH — agents search the web for patterns/tools
2. DELIBERATE — council discusses findings
3. PLAN — create improvement spec + test plan
4. TEST — write comprehensive tests (TDD, using Codex)
5. IMPLEMENT — make changes on isolated branch (using Codex)
6. ANALYZE — multi-agent review of results
7. DECIDE — consensus: keep/reject/revise

Each agent runs as a headless CLI process (claude, gemini, codex) that receives a prompt via stdin and writes output to stdout.

## Diagnosis Buckets

**transient** — The failure is temporary. Retry the same operation as-is.
Examples: rate limit hit, network timeout, API 500/503, agent process crash, temporary file lock

**fixable** — The failure has a specific cause that can be corrected by modifying the prompt or approach.
Examples: test file has syntax error, missing import, wrong test framework used, agent misunderstood the task, wrong file path in prompt, context too large

**fundamental** — The failure cannot be fixed by retrying. The task itself is problematic.
Examples: feature requires dependency not available, task is architecturally impossible, circular dependency, spec is contradictory

## Response Format
Respond with ONLY a JSON object (no markdown, no explanation outside JSON):
{
  "diagnosis": "transient" | "fixable" | "fundamental",
  "explanation": "Brief human-readable explanation of what went wrong",
  "rootCause": "Technical root cause",
  "corrective": "Specific corrective action (for fixable) or null",
  "retryRecommendation": {
    "retryPhase": true | false,
    "modifiedPrompt": "Additional context/instructions to prepend to the retry prompt, or null",
    "preamble": "Short preamble to add before the original prompt, or null",
    "retryAgent": "alternative agent name if tryAlternativeAgent applies, or null"
  }
}`;
}

// ── Core Investigation ───────────────────────────────────────────────────────

function makeBudgetExhaustedResult(budgetUsed: number, maxBudget: number): DiagnosisResult {
  return {
    diagnosis: 'fundamental',
    explanation: 'Investigator token budget exhausted',
    rootCause: `Used ${String(budgetUsed)}/${String(maxBudget)} tokens`,
    corrective: null,
    retryRecommendation: {
      retryPhase: false,
      modifiedPrompt: null,
      preamble: null,
      retryAgent: null,
    },
    tokens: { prompt: 0, completion: 0 },
  };
}

function makePhaseNotConfiguredResult(phase: string): DiagnosisResult {
  return {
    diagnosis: 'fundamental',
    explanation: `Phase '${phase}' not configured for investigation`,
    rootCause: 'Phase not in investigator.phases config',
    corrective: null,
    retryRecommendation: {
      retryPhase: false,
      modifiedPrompt: null,
      preamble: null,
      retryAgent: null,
    },
    tokens: { prompt: 0, completion: 0 },
  };
}

function makeTimeoutDiagnosis(failure: EvolveFailure): DiagnosisResult {
  return {
    diagnosis: 'transient',
    explanation: `${failure.agent ?? failure.phase} timed out`,
    rootCause: 'Operation exceeded timeout limit',
    corrective: null,
    retryRecommendation: {
      retryPhase: true,
      modifiedPrompt: null,
      preamble: null,
      retryAgent: null,
    },
    tokens: { prompt: 0, completion: 0 },
  };
}

function buildFailureOptionalDetails(failure: EvolveFailure): string {
  const parts: string[] = [];
  if (failure.errorCategory !== undefined && failure.errorCategory !== '')
    parts.push(`Error Category: ${failure.errorCategory}`);
  if (failure.errorDetail !== undefined && failure.errorDetail !== '')
    parts.push(`Error Detail: ${failure.errorDetail}`);
  if (failure.errorContext !== undefined && failure.errorContext !== '')
    parts.push(`Error Context: ${failure.errorContext}`);
  if (failure.command !== undefined && failure.command !== '')
    parts.push(`Command: ${failure.command} ${failure.args?.join(' ') ?? ''}`);
  if (failure.promptSnippet !== undefined && failure.promptSnippet !== '')
    parts.push(`Prompt Snippet: ${failure.promptSnippet}...`);
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

function buildSnippetSections(failure: EvolveFailure): string {
  const stderrSnippet = (failure.stderr ?? '').slice(-2000);
  const stdoutSnippet = (failure.stdout ?? '').slice(-2000);
  const contextSnippet = (failure.context ?? '').slice(-3000);
  const parts: string[] = [];
  if (stderrSnippet.length > 0)
    parts.push(`## stderr (last 2KB)\n\`\`\`\n${stderrSnippet}\n\`\`\``);
  if (stdoutSnippet.length > 0)
    parts.push(`## stdout (last 2KB)\n\`\`\`\n${stdoutSnippet}\n\`\`\``);
  if (contextSnippet.length > 0) parts.push(`## Additional Context\n${contextSnippet}`);
  return parts.length > 0 ? `\n${parts.join('\n')}\n` : '';
}

function buildFailureUserMessage(failure: EvolveFailure): string {
  const exitCode = failure.exitCode == null ? 'N/A' : String(failure.exitCode);
  const details = buildFailureOptionalDetails(failure);
  const snippets = buildSnippetSections(failure);
  return `## Failed Phase: ${failure.phase}\nAgent: ${failure.agent ?? 'N/A'}\nAttempt: ${String(failure.attemptNumber ?? 1)}\nExit Code: ${exitCode}\nSignal: ${failure.signal ?? 'N/A'}\nError: ${failure.error ?? 'Unknown'}${details}\nTimed Out: no\n${snippets}\nDiagnose this failure and provide a structured recommendation.`;
}

async function runInvestigatorStream(
  failure: EvolveFailure,
  cfg: InvestigatorConfig,
): Promise<DiagnosisResult> {
  const userMessage = buildFailureUserMessage(failure);
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userMessage },
  ];
  const { fullResponse, usage } = await streamCompletion(messages, {
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
  });
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  stats.promptTokens += promptTokens;
  stats.completionTokens += completionTokens;
  tokenBudgetUsed += promptTokens + completionTokens;
  stats.investigations++;
  const diagnosis = parseInvestigatorResponse(fullResponse);
  diagnosis.tokens = { prompt: promptTokens, completion: completionTokens };
  if (
    (diagnosis.diagnosis === 'fixable' || diagnosis.diagnosis === 'transient') &&
    diagnosis.retryRecommendation.retryPhase
  ) {
    stats.healed++;
  }
  logInvestigation(failure, diagnosis);
  return diagnosis;
}

function makeInvestigatorErrorResult(err: unknown): DiagnosisResult {
  const errMsg = err instanceof Error ? err.message : String(err);
  return {
    diagnosis: 'fundamental',
    explanation: `Investigator call failed: ${errMsg}`,
    rootCause: errMsg,
    corrective: null,
    retryRecommendation: {
      retryPhase: false,
      modifiedPrompt: null,
      preamble: null,
      retryAgent: null,
    },
    tokens: { prompt: 0, completion: 0 },
  };
}

/**
 * Investigate a phase failure and return a diagnosis.
 *
 * @param {object} failure
 * @param {string} failure.phase - Phase name (test, implement, analyze, agent, etc.)
 * @param {string} [failure.agent] - Agent that failed (claude, gemini, codex)
 * @param {string} [failure.error] - Error message
 * @param {string} [failure.stderr] - Agent stderr output (last ~2KB)
 * @param {string} [failure.stdout] - Agent stdout output (last ~2KB)
 * @param {boolean} [failure.timedOut] - Whether the failure was a timeout
 * @param {string} [failure.context] - Additional context (plan excerpt, test code, etc.)
 * @param {number} [failure.attemptNumber] - Which attempt this is (1-based)
 * @returns {Promise<object>} Diagnosis object
 */
export async function investigate(failure: EvolveFailure): Promise<DiagnosisResult> {
  const cfg = getInvestigatorConfig();
  if (tokenBudgetUsed >= cfg.maxTokensBudget)
    return makeBudgetExhaustedResult(tokenBudgetUsed, cfg.maxTokensBudget);
  if (!cfg.phases.includes(failure.phase)) return makePhaseNotConfiguredResult(failure.phase);
  if (failure.timedOut === true) {
    const result = makeTimeoutDiagnosis(failure);
    logInvestigation(failure, result);
    stats.investigations++;
    return result;
  }
  try {
    return await runInvestigatorStream(failure, cfg);
  } catch (err) {
    stats.investigations++;
    const fallback = makeInvestigatorErrorResult(err);
    logInvestigation(failure, fallback);
    return fallback;
  }
}

// ── Response Parsing ─────────────────────────────────────────────────────────

interface ParsedDiagnosis {
  diagnosis?: unknown;
  explanation?: unknown;
  rootCause?: unknown;
  corrective?: unknown;
  retryRecommendation?: {
    retryPhase?: unknown;
    modifiedPrompt?: unknown;
    preamble?: unknown;
    retryAgent?: unknown;
  };
}

function parseInvestigatorResponse(raw: string): DiagnosisResult {
  // Try to extract JSON from the response (may have markdown fencing)
  let text = raw.trim();

  // Strip markdown code fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    text = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text) as ParsedDiagnosis;
    return {
      diagnosis: typeof parsed.diagnosis === 'string' ? parsed.diagnosis : 'fundamental',
      explanation:
        typeof parsed.explanation === 'string' ? parsed.explanation : 'No explanation provided',
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : 'Unknown',
      corrective: typeof parsed.corrective === 'string' ? parsed.corrective : null,
      retryRecommendation: {
        retryPhase:
          typeof parsed.retryRecommendation?.retryPhase === 'boolean'
            ? parsed.retryRecommendation.retryPhase
            : false,
        modifiedPrompt:
          typeof parsed.retryRecommendation?.modifiedPrompt === 'string'
            ? parsed.retryRecommendation.modifiedPrompt
            : null,
        preamble:
          typeof parsed.retryRecommendation?.preamble === 'string'
            ? parsed.retryRecommendation.preamble
            : null,
        retryAgent:
          typeof parsed.retryRecommendation?.retryAgent === 'string'
            ? parsed.retryRecommendation.retryAgent
            : null,
      },
    };
  } catch {
    // Couldn't parse — treat as fundamental
    return {
      diagnosis: 'fundamental',
      explanation: 'Investigator returned unparseable response',
      rootCause: raw.slice(0, 200),
      corrective: null,
      retryRecommendation: {
        retryPhase: false,
        modifiedPrompt: null,
        preamble: null,
        retryAgent: null,
      },
    };
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

function logInvestigation(failure: EvolveFailure, diagnosis: DiagnosisResult) {
  const cfg = getInvestigatorConfig();
  if (!cfg.logToFile) return;

  try {
    // Find the evolve dir — look for docs/coordination/evolve relative to this module
    const hydraRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '..',
    );
    const logDir = path.join(hydraRoot, 'docs', 'coordination', 'evolve');

    // Ensure dir exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logPath = path.join(logDir, 'INVESTIGATION_LOG.ndjson');
    const entry = {
      ts: new Date().toISOString(),
      phase: failure.phase,
      agent: failure.agent ?? null,
      error: (failure.error ?? '').slice(0, 500),
      timedOut: failure.timedOut ?? false,
      attempt: failure.attemptNumber ?? 1,
      diagnosis: diagnosis.diagnosis,
      explanation: diagnosis.explanation,
      rootCause: diagnosis.rootCause,
      corrective: diagnosis.corrective,
      retryPhase: diagnosis.retryRecommendation.retryPhase,
      tokens: diagnosis.tokens ?? { prompt: 0, completion: 0 },
    };

    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Best effort — don't let logging failures break the pipeline
  }
}
