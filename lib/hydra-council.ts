/**
 * Hydra Council Mode
 *
 * Agent-aware multi-round deliberation:
 * Claude (propose) -> Gemini (critique) -> Claude (refine) -> Codex (implement)
 * Then optionally publishes decisions/tasks/handoffs into Hydra daemon.
 *
 * Usage:
 *   node hydra-council.mjs prompt="Investigate auth race"
 *   node hydra-council.mjs prompt="Investigate auth race" mode=preview
 */

import './hydra-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentContext } from './hydra-context.ts';
import { getAgent, AGENT_NAMES, getMode, setMode } from './hydra-agents.ts';
import { commandExists } from './hydra-setup.ts';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import { checkUsage } from './hydra-usage.ts';
import {
  nowIso,
  runId,
  parseArgs,
  getPrompt,
  boolFlag,
  short,
  parseJsonLoose,
  request,
  ensureDir,
  sanitizeOwner,
  normalizeTask,
  dedupeTasks,
  classifyPrompt,
  generateSpec,
} from './hydra-utils.ts';
import {
  sectionHeader,
  label,
  colorAgent,
  createSpinner,
  divider,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
  formatElapsed,
} from './hydra-ui.ts';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.ts';
import { detectRateLimitError, calculateBackoff } from './hydra-model-recovery.ts';
import { diagnose as notifyDoctor, isDoctorEnabled } from './hydra-doctor.ts';
import { isPersonaEnabled, getAgentFraming } from './hydra-persona.ts';
import pc from 'picocolors';

const config = resolveProject();
const RUNS_DIR = config.runsDir;

/**
 * Simple deterministic hash of a string, returns first 12 hex chars.
 */
function simpleHash(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit then hex, pad, and use first 12 chars
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  // Mix in length for more entropy
  const h2 = ((h >>> 0) ^ (str.length * 2654435761)) >>> 0;
  return (hex + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

interface CheckpointData {
  prompt: string;
  transcript: Array<{ round: number; agent: string; phase: string; [key: string]: unknown }>;
  round: number;
  stepIdx: number;
  specContent: string | null;
  startedAt?: string;
  updatedAt?: string;
}

function checkpointPath(promptHash: string) {
  return path.join(RUNS_DIR, `COUNCIL_CHECKPOINT_${promptHash}.json`);
}

function loadCheckpoint(promptHash: string, prompt: string): CheckpointData | null {
  const cpPath = checkpointPath(promptHash);
  if (!fs.existsSync(cpPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cpPath, 'utf8')) as CheckpointData;
    if (data.prompt !== prompt) return null; // prompt mismatch
    return data;
  } catch {
    return null;
  }
}

function saveCheckpoint(
  promptHash: string,
  prompt: string,
  round: number,
  stepIdx: number,
  transcript: unknown[],
  specContent: string | null,
) {
  ensureDir(RUNS_DIR);
  const data = {
    promptHash,
    prompt,
    round,
    stepIdx,
    transcript,
    specContent: specContent ?? null,
    startedAt:
      ((transcript[0] as Record<string, unknown>)['startedAt'] as string | undefined) ?? nowIso(),
    updatedAt: nowIso(),
  };
  fs.writeFileSync(checkpointPath(promptHash), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function deleteCheckpoint(promptHash: string) {
  const cpPath = checkpointPath(promptHash);
  try {
    fs.unlinkSync(cpPath);
  } catch {
    /* ignore */
  }
}

const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

/**
 * Council flow: Claude→Gemini→Claude→Codex
 * Each step has a specific phase and agent-aware prompt.
 * Copilot is an optional advisor step appended when available.
 */
const COUNCIL_FLOW = [
  {
    agent: 'claude',
    phase: 'propose',
    promptLabel: 'Analyze this objective and propose a detailed plan with task breakdown.',
  },
  {
    agent: 'gemini',
    phase: 'critique',
    promptLabel:
      'Review this plan critically. Identify risks, edge cases, missed files, and regressions. Cite specific code.',
  },
  {
    agent: 'claude',
    phase: 'refine',
    promptLabel:
      'Incorporate the critique. Produce the final plan with concrete task specs for implementation.',
  },
  {
    agent: 'codex',
    phase: 'implement',
    promptLabel:
      'Given this finalized plan, produce exact file paths, function signatures, and implementation steps for each task.',
  },
  {
    agent: 'copilot',
    phase: 'advise',
    optional: true,
    promptLabel:
      'Review the plan and implementation from a GitHub integration perspective. Identify relevant open issues, CI concerns, PR workflow improvements, or GitHub Actions optimizations.',
  },
];

const MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' };
export const COUNCIL_DECISION_CRITERIA = [
  { key: 'correctness', label: 'Correctness' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'reversibility', label: 'Reversibility' },
  { key: 'user_impact', label: 'User impact' },
];

const HUMAN_OWNERS = new Set(['human', 'unassigned']);

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConfidence(value: unknown) {
  const normalized = cleanText(value).toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : '';
}

function normalizeNextAction(value: unknown) {
  const normalized = cleanText(value).toLowerCase().replace(/\s+/g, '_');
  if (normalized === '') {
    return '';
  }
  if (['handoff', 'delegate', 'ship'].includes(normalized)) {
    return 'handoff';
  }
  if (['council', 'deeper_council', 'open_council', 'continue_council'].includes(normalized)) {
    return 'council';
  }
  if (['human', 'human_decision', 'ask_human', 'needs_human'].includes(normalized)) {
    return 'human_decision';
  }
  return '';
}

function normalizeTradeoffs(raw: unknown) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const entries: Record<string, string> = {};
  for (const { key } of COUNCIL_DECISION_CRITERIA) {
    const camelKey = key.replace(/_([a-z])/g, (_m: string, c: string) => c.toUpperCase());
    const value = cleanText(r[key] ?? r[camelKey]);
    if (value !== '') {
      entries[key] = value;
    }
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

function normalizeDecisionOption(item: unknown, index: number) {
  if (item == null || typeof item !== 'object') {
    return null;
  }
  const i = item as Record<string, unknown>;
  const option = cleanText(i['option'] ?? i['name'] ?? i['title']);
  const summary = cleanText(i['summary'] ?? i['description'] ?? i['view']);
  const tradeoffs = normalizeTradeoffs(i['tradeoffs'] ?? i['criteria'] ?? i['decision_criteria']);
  const preferred = i['preferred'] === true;
  if (option === '' && summary === '' && !tradeoffs) {
    return null;
  }
  return {
    option: option === '' ? `option_${String(index + 1)}` : option,
    summary,
    preferred,
    tradeoffs,
  };
}

function mergeTruthy(base: unknown, update: unknown) {
  const out = {
    ...(base != null && typeof base === 'object' ? (base as Record<string, unknown>) : {}),
  };
  for (const [key, value] of Object.entries(
    update != null && typeof update === 'object' ? (update as Record<string, unknown>) : {},
  )) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function dedupeBy(items: unknown[], keySelector: (item: unknown) => string) {
  const seen = new Map<string, unknown>();
  for (const item of items) {
    if (item == null) {
      continue;
    }
    const key = cleanText(keySelector(item)).toLowerCase();
    if (key === '') {
      continue;
    }
    const existing = seen.get(key);
    seen.set(key, mergeTruthy(existing, item));
  }
  return [...seen.values()];
}

function usageGuard(_agent: string) {
  try {
    const usage = checkUsage();
    if (usage.level === 'critical') {
      const currentMode = getMode();
      const nextMode = (MODE_DOWNSHIFT as Record<string, string>)[currentMode];
      if (nextMode === '') {
        process.stderr.write(
          `  ${WARNING('\u26A0')} Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 already in economy mode\n`,
        );
      } else {
        process.stderr.write(
          `  ${WARNING('\u26A0')} Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 downshifting mode: ${currentMode} \u2192 ${nextMode}\n`,
        );
        setMode(nextMode);
      }
    } else if (usage.level === 'warning') {
      process.stderr.write(`  ${DIM('\u26A0')} Token usage at ${usage.percent.toFixed(1)}%\n`);
    }
  } catch {
    /* non-critical */
  }
}

/**
 * Async agent call with self-healing (model recovery + rate limit retry).
 * Replaces the old sync callAgent → modelCall path, fixing stdin issues
 * and adding defense-in-depth on par with evolve.
 */
async function callAgentAsync(agent: string, prompt: string, timeoutMs: number) {
  usageGuard(agent);
  const result = await executeAgentWithRecovery(agent, prompt, {
    timeoutMs,
    useStdin: true,
    cwd: config.projectRoot,
  });
  const raw = result as unknown as Record<string, unknown>;
  return {
    ok: result.ok,
    stdout: result.output === '' ? result.stdout : result.output,
    stderr: result.stderr,
    error: result.error ?? '',
    exitCode: result.exitCode,
    command: result.command,
    args: result.args,
    promptSnippet: result.promptSnippet,
    recovered: result.recovered ?? false,
    originalModel: result.originalModel,
    newModel: result.newModel,
    timedOut: raw['timedOut'] as boolean | undefined,
    signal: raw['signal'] as string | null | undefined,
    output: raw['output'] as string | undefined,
    errorCategory: raw['errorCategory'] as string | null | undefined,
    errorDetail: raw['errorDetail'] as string | null | undefined,
    errorContext: raw['errorContext'] as string | null | undefined,
    _compactedRetry: false as boolean | undefined,
  };
}

function extractTasksFromOutput(parsed: unknown, fallbackOwner = 'unassigned') {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const buckets = [
    p['task_allocations'],
    p['recommended_tasks'],
    p['tasks'],
    (p['delegation'] as Record<string, unknown> | undefined)?.['task_splits'],
  ];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      const normalized = normalizeTask(item, fallbackOwner);
      if (normalized) {
        out.push(normalized);
      }
    }
  }
  return out;
}

function extractQuestions(parsed: unknown) {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const questions = [];
  const buckets = [p['questions'], p['final_questions'], p['open_questions']];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const q of bucket) {
      if (typeof q === 'string' && q.trim() !== '') {
        questions.push({ to: 'human', question: q.trim() });
      } else if (q != null && typeof q === 'object') {
        const qi = q as Record<string, unknown>;
        const question = (
          (qi['question'] as string | undefined) ??
          (qi['text'] as string | undefined) ??
          ''
        ).trim();
        if (question === '') {
          continue;
        }
        questions.push({
          to: sanitizeOwner((qi['to'] as string | undefined) ?? 'human'),
          question,
        });
      }
    }
  }
  return questions;
}

function extractRisks(parsed: unknown) {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const risks = [];
  const buckets = [p['risks'], p['sanity_checks'], p['edge_cases']];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim() !== '') {
        risks.push(item.trim());
      }
    }
  }
  return risks;
}

function extractCouncilSignal(parsed: unknown) {
  if (parsed == null || typeof parsed !== 'object') {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  const boolCandidates = [p['should_open_council'], p['needs_council'], p['council_needed']];
  let vote = null;
  for (const candidate of boolCandidates) {
    if (typeof candidate === 'boolean') {
      vote = candidate;
      break;
    }
  }
  if (vote === null) {
    return null;
  }
  const reason = (
    (p['council_reason'] as string | undefined) ??
    (p['reason'] as string | undefined) ??
    ''
  ).trim();
  return { vote, reason };
}

export function extractDecisionOptions(parsed?: unknown): unknown[] {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const buckets = [p['decision_options'], p['options'], p['candidate_options']];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const [index, item] of bucket.entries()) {
      const normalized = normalizeDecisionOption(item, index);
      if (normalized) {
        out.push(normalized);
      }
    }
  }
  return dedupeBy(out, (item: unknown) => {
    const d = item as { option: string; summary: string };
    return `${d.option}|${d.summary}`;
  });
}

function normalizeAssumptionItem(item: unknown): {
  assumption: string;
  status: string;
  evidence: string;
  impact: string;
  owner: string;
} | null {
  if (typeof item === 'string' && item.trim() !== '') {
    return {
      assumption: item.trim(),
      status: 'open',
      evidence: '',
      impact: '',
      owner: 'unassigned',
    };
  }
  if (item == null || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  const assumption = cleanText(i['assumption'] ?? i['name'] ?? i['summary'] ?? i['question']);
  if (assumption === '') return null;
  const status = cleanText(i['status']).toLowerCase();
  return {
    assumption,
    status: ['validated', 'open', 'rejected'].includes(status) ? status : 'open',
    evidence: cleanText(i['evidence'] ?? i['basis']),
    impact: cleanText(i['impact'] ?? i['risk']),
    owner: sanitizeOwner(
      (i['owner'] as string | undefined) ?? (i['to'] as string | undefined) ?? 'unassigned',
    ),
  };
}

export function extractAssumptions(parsed?: unknown): unknown[] {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const buckets = [p['assumptions'], p['open_assumptions'], p['key_assumptions']];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      const normalized = normalizeAssumptionItem(item);
      if (normalized) out.push(normalized);
    }
  }
  return dedupeBy(
    out,
    (item: unknown) => (item as Record<string, unknown>)['assumption'] as string,
  );
}

function normalizeAttackItem(item: unknown): {
  assumption: string;
  challenge: string;
  impact: string;
  by: string;
} | null {
  if (typeof item === 'string' && item.trim() !== '') {
    return { assumption: '', challenge: item.trim(), impact: '', by: 'unassigned' };
  }
  if (item == null || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  const challenge = cleanText(i['attack_vector'] ?? i['challenge'] ?? i['critique'] ?? i['text']);
  const assumption = cleanText(i['target_agent'] ?? i['assumption'] ?? i['target']);
  if (challenge === '' && assumption === '') return null;
  return {
    assumption,
    challenge,
    impact: cleanText(i['impact'] ?? i['risk']),
    by: sanitizeOwner(
      (i['by'] as string | undefined) ?? (i['owner'] as string | undefined) ?? 'unassigned',
    ),
  };
}

export function extractAssumptionAttacks(parsed?: unknown): unknown[] {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const buckets = [p['assumption_attacks'], p['assumption_challenges'], p['counterarguments']];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      const normalized = normalizeAttackItem(item);
      if (normalized) out.push(normalized);
    }
  }
  return dedupeBy(out, (item: unknown) => {
    const i = item as Record<string, unknown>;
    return `${(i['assumption'] as string | undefined) ?? ''}|${(i['challenge'] as string | undefined) ?? ''}`;
  });
}

function extractDisagreements(parsed: unknown) {
  if (parsed == null || typeof parsed !== 'object') {
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const buckets = [p['disagreements'], p['unresolved_tensions'], p['conflicts']];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim() !== '') {
        out.push(item.trim());
      }
    }
  }
  return [...new Set(out)];
}

function resolveDecisionRaw(p: Record<string, unknown>): Record<string, unknown> {
  return p['decision'] != null && typeof p['decision'] === 'object'
    ? (p['decision'] as Record<string, unknown>)
    : ({} as Record<string, unknown>);
}

function extractDecisionSummary(
  decisionRaw: Record<string, unknown>,
  p: Record<string, unknown>,
): string {
  return cleanText(
    decisionRaw['summary'] ??
      decisionRaw['choice'] ??
      decisionRaw['recommendation'] ??
      p['consensus'] ??
      p['view'],
  );
}

function extractDecisionWhy(
  decisionRaw: Record<string, unknown>,
  p: Record<string, unknown>,
): string {
  return cleanText(
    decisionRaw['why'] ??
      decisionRaw['rationale'] ??
      decisionRaw['reason'] ??
      p['decision_rationale'],
  );
}

function extractDecisionFields(p: Record<string, unknown>) {
  const decisionRaw = resolveDecisionRaw(p);
  return {
    summary: extractDecisionSummary(decisionRaw, p),
    why: extractDecisionWhy(decisionRaw, p),
    owner: sanitizeOwner(
      (decisionRaw['owner'] as string | undefined) ??
        (decisionRaw['decider'] as string | undefined) ??
        'unassigned',
    ),
    confidence: normalizeConfidence(decisionRaw['confidence'] ?? p['confidence']),
    nextAction: normalizeNextAction(
      decisionRaw['next_action'] ?? decisionRaw['nextAction'] ?? p['next_action'],
    ),
    reversibleFirstStep: cleanText(
      decisionRaw['reversible_first_step'] ??
        decisionRaw['reversibleFirstStep'] ??
        p['reversible_first_step'],
    ),
    tradeoffs: normalizeTradeoffs(
      decisionRaw['tradeoffs'] ??
        decisionRaw['criteria'] ??
        p['tradeoffs'] ??
        p['decision_criteria'],
    ),
  };
}

export function extractFinalDecision(
  parsed?: unknown,
  fallback: { agent?: string; phase?: string } = {},
): {
  summary: string;
  why: string;
  owner: string;
  confidence: string;
  nextAction: string;
  reversibleFirstStep: string;
  tradeoffs: Record<string, string> | null;
  sourceAgent: string;
  sourcePhase: string;
} | null {
  if (parsed == null || typeof parsed !== 'object') {
    return null;
  }
  const fields = extractDecisionFields(parsed as Record<string, unknown>);

  if (
    fields.summary === '' &&
    fields.why === '' &&
    fields.confidence === '' &&
    fields.nextAction === '' &&
    fields.reversibleFirstStep === '' &&
    !fields.tradeoffs
  ) {
    return null;
  }

  return {
    ...fields,
    owner: fallback.agent === undefined ? fields.owner : sanitizeOwner(fallback.agent),
    sourceAgent: fallback.agent ?? 'unassigned',
    sourcePhase: fallback.phase ?? '',
  };
}

function countOpenAssumptions(assumptions: Array<{ status: string }>) {
  return assumptions.filter((item: { status: string }) => item.status !== 'validated').length;
}

function needsCouncilEscalation(
  openAssumptions: number,
  humanQuestions: number,
  crossAgentQuestions: number,
  riskItems: number,
  disagreementItems: number,
  positiveCouncilSignals: number,
  confidence: string,
): boolean {
  if (confidence === 'low' && (openAssumptions > 0 || humanQuestions > 0 || riskItems > 0))
    return true;
  if (riskItems >= 4 || disagreementItems > 0 || crossAgentQuestions > 1) return true;
  return positiveCouncilSignals > 0 && (openAssumptions > 0 || riskItems > 0);
}

function determineRecommendedMode({
  explicitNextAction,
  confidence,
  openAssumptions,
  humanQuestions,
  crossAgentQuestions,
  riskItems,
  disagreementItems,
  positiveCouncilSignals,
}: {
  explicitNextAction: string;
  confidence: string;
  openAssumptions: number;
  humanQuestions: number;
  crossAgentQuestions: number;
  riskItems: number;
  disagreementItems: number;
  positiveCouncilSignals: number;
}): string {
  if (explicitNextAction === 'council' || explicitNextAction === 'human_decision') {
    return 'council';
  }
  if (explicitNextAction === 'handoff') {
    const synthesisLooksWeak = confidence === 'low' || disagreementItems > 1 || riskItems >= 6;
    return synthesisLooksWeak ? 'council' : 'handoff';
  }
  return needsCouncilEscalation(
    openAssumptions,
    humanQuestions,
    crossAgentQuestions,
    riskItems,
    disagreementItems,
    positiveCouncilSignals,
    confidence,
  )
    ? 'council'
    : 'handoff';
}

export function deriveCouncilRecommendation({
  finalDecision,
  assumptions = [] as Array<{ status: string }>,
  questions = [] as Array<{ to: string }>,
  risks = [] as unknown[],
  disagreements = [] as unknown[],
  councilVotes = [] as Array<{ vote: boolean }>,
}: {
  finalDecision?: { nextAction?: string; confidence?: string; owner?: string } | null;
  assumptions?: Array<{ status: string }>;
  questions?: Array<{ to: string }>;
  risks?: unknown[];
  disagreements?: unknown[];
  councilVotes?: Array<{ vote: boolean }>;
} = {}): { recommendedMode: string; nextAction: string; rationale: string } {
  const openAssumptions = countOpenAssumptions(assumptions);
  const humanQuestions = questions.filter((q) => q.to === 'human').length;
  const crossAgentQuestions = questions.filter((q) =>
    ['gemini', 'codex', 'claude'].includes(q.to),
  ).length;
  const riskItems = risks.length;
  const disagreementItems = disagreements.length;
  const positiveCouncilSignals = councilVotes.filter((item) => item.vote).length;
  const explicitNextAction = finalDecision?.nextAction ?? '';
  const confidence = finalDecision?.confidence ?? '';

  const recommendedMode = determineRecommendedMode({
    explicitNextAction,
    confidence,
    openAssumptions,
    humanQuestions,
    crossAgentQuestions,
    riskItems,
    disagreementItems,
    positiveCouncilSignals,
  });

  const defaultAction = recommendedMode === 'council' ? 'council' : 'handoff';
  const nextAction = explicitNextAction === '' ? defaultAction : explicitNextAction;

  return {
    recommendedMode,
    nextAction,
    rationale: buildRecommendationRationale({
      owner: finalDecision?.owner,
      confidence,
      nextAction,
      openAssumptions,
      humanQuestions,
      crossAgentQuestions,
      disagreementItems,
      riskItems,
      positiveCouncilSignals,
    }),
  };
}

function buildRecommendationRationale(vals: {
  owner?: string;
  confidence: string;
  nextAction: string;
  openAssumptions: number;
  humanQuestions: number;
  crossAgentQuestions: number;
  disagreementItems: number;
  riskItems: number;
  positiveCouncilSignals: number;
}): string {
  return [
    `decision_owner=${vals.owner ?? 'n/a'}`,
    `decision_confidence=${vals.confidence === '' ? 'n/a' : vals.confidence}`,
    `decision_next_action=${vals.nextAction}`,
    `open_assumptions=${String(vals.openAssumptions)}`,
    `human_questions=${String(vals.humanQuestions)}`,
    `cross_agent_questions=${String(vals.crossAgentQuestions)}`,
    `disagreement_items=${String(vals.disagreementItems)}`,
    `risk_items=${String(vals.riskItems)}`,
    `positive_council_signals=${String(vals.positiveCouncilSignals)}`,
  ].join('; ');
}

interface AccumulatedData {
  taskCandidates: unknown[];
  questions: Array<{ to: string; question: string }>;
  risks: unknown[];
  councilVotes: Array<{ agent: unknown; phase: unknown; vote: boolean; reason: string }>;
  decisionOptions: unknown[];
  assumptions: Array<{ status: string; [key: string]: unknown }>;
  assumptionAttacks: unknown[];
  disagreements: unknown[];
  decisions: unknown[];
}

function accumulateTranscriptData(parsedEntries: Array<Record<string, unknown>>): AccumulatedData {
  const data: AccumulatedData = {
    taskCandidates: [],
    questions: [],
    risks: [],
    councilVotes: [],
    decisionOptions: [],
    assumptions: [],
    assumptionAttacks: [],
    disagreements: [],
    decisions: [],
  };

  for (const entry of parsedEntries) {
    data.taskCandidates.push(...extractTasksFromOutput(entry['parsed'], entry['agent'] as string));
    data.questions.push(
      ...(extractQuestions(entry['parsed']) as Array<{ to: string; question: string }>),
    );
    data.risks.push(...extractRisks(entry['parsed']));
    data.decisionOptions.push(...extractDecisionOptions(entry['parsed']));
    data.assumptions.push(
      ...(extractAssumptions(entry['parsed']) as Array<{ status: string; [key: string]: unknown }>),
    );
    data.assumptionAttacks.push(...extractAssumptionAttacks(entry['parsed']));
    data.disagreements.push(...extractDisagreements(entry['parsed']));

    const signal = extractCouncilSignal(entry['parsed']);
    if (signal) {
      data.councilVotes.push({
        agent: entry['agent'],
        phase: entry['phase'],
        vote: signal.vote,
        reason: signal.reason,
      });
    }

    const decision = extractFinalDecision(entry['parsed'], {
      agent: entry['agent'] as string,
      phase: entry['phase'] as string,
    });
    if (decision) data.decisions.push(decision);
  }
  return data;
}

function deduplicateAccumulatedData(data: AccumulatedData) {
  return {
    questions: dedupeBy(data.questions, (item: unknown) => {
      const q = item as { to: string; question: string };
      return `${q.to}|${q.question}`;
    }),
    risks: [...new Set(data.risks.map((item: unknown) => cleanText(item)).filter(Boolean))],
    decisionOptions: dedupeBy(data.decisionOptions, (item: unknown) => {
      const d = item as { option: string; summary: string };
      return `${d.option}|${d.summary}`;
    }),
    assumptions: dedupeBy(
      data.assumptions,
      (item: unknown) => (item as Record<string, unknown>)['assumption'] as string,
    ),
    assumptionAttacks: dedupeBy(data.assumptionAttacks, (item: unknown) => {
      const a = item as { assumption: unknown; challenge: unknown };
      return `${(a.assumption as string | undefined) ?? ''}|${(a.challenge as string | undefined) ?? ''}`;
    }),
    disagreements: [
      ...new Set(data.disagreements.map((item: unknown) => cleanText(item)).filter(Boolean)),
    ],
  };
}

export function synthesizeCouncilTranscript(
  prompt: string,
  transcript: unknown[],
): {
  prompt: string;
  consensus: string;
  tasks: unknown[];
  questions: unknown[];
  risks: string[];
  councilVotes: unknown[];
  decisionOptions: unknown[];
  assumptions: unknown[];
  assumptionAttacks: unknown[];
  disagreements: string[];
  finalDecision: unknown;
  recommendedMode: string;
  recommendedNextAction: string;
  recommendationRationale: string;
} {
  const parsedEntries = (transcript as Array<Record<string, unknown>>).filter(
    (entry) => entry['parsed'] != null && typeof entry['parsed'] === 'object',
  );
  const lastCodex = parsedEntries.filter((entry) => entry['agent'] === 'codex').at(-1);
  const lastClaudeRefine = parsedEntries
    .filter((entry) => entry['agent'] === 'claude' && entry['phase'] === 'refine')
    .at(-1);
  const lastClaude = parsedEntries.filter((entry) => entry['agent'] === 'claude').at(-1);

  const data = accumulateTranscriptData(parsedEntries);
  const deduped = deduplicateAccumulatedData(data);

  const finalDecision = data.decisions.at(-1) ?? null;
  const finalDecisionObj = finalDecision as null | Record<string, unknown>;
  const consensus = cleanText(
    finalDecisionObj?.['summary'] ??
      (lastCodex?.['parsed'] as Record<string, unknown> | undefined)?.['consensus'] ??
      (lastClaudeRefine?.['parsed'] as Record<string, unknown> | undefined)?.['view'] ??
      (lastClaude?.['parsed'] as Record<string, unknown> | undefined)?.['view'],
  );
  const recommendation = deriveCouncilRecommendation({
    finalDecision,
    assumptions: deduped.assumptions as Array<{ status: string }>,
    questions: deduped.questions as Array<{ to: string }>,
    risks: deduped.risks,
    disagreements: deduped.disagreements,
    councilVotes: data.councilVotes,
  });

  return {
    prompt,
    consensus,
    tasks:
      data.taskCandidates.length > 0
        ? dedupeTasks(data.taskCandidates as Parameters<typeof dedupeTasks>[0])
        : defaultTasks(prompt),
    questions: deduped.questions,
    risks: deduped.risks,
    councilVotes: data.councilVotes,
    decisionOptions: deduped.decisionOptions,
    assumptions: deduped.assumptions,
    assumptionAttacks: deduped.assumptionAttacks,
    disagreements: deduped.disagreements,
    finalDecision,
    recommendedMode: recommendation.recommendedMode,
    recommendedNextAction: recommendation.nextAction,
    recommendationRationale: recommendation.rationale,
  };
}

function buildContextSummary(transcript: unknown[]) {
  return (transcript as Array<Record<string, unknown>>)
    .slice(-6)
    .map((entry) => {
      const content = entry['parsed'] == null ? entry['rawText'] : JSON.stringify(entry['parsed']);
      return `${String(entry['agent']).toUpperCase()} (${(entry['phase'] as string | undefined) ?? `R${String(entry['round'])}`}): ${short(content as string, 500)}`;
    })
    .join('\n');
}

function formatCriteriaInstruction() {
  return COUNCIL_DECISION_CRITERIA.map((item) => `${item.key}: ${item.label}`).join('; ');
}

const TRADEOFFS_SCHEMA =
  '{"correctness":"string","complexity":"string","reversibility":"string","user_impact":"string"}';
const DECISION_SCHEMA = `"decision":{"summary":"string","why":"string","owner":"gemini|codex|claude|human","confidence":"low|medium|high","next_action":"handoff|deeper_council|human_decision","reversible_first_step":"string","tradeoffs":${TRADEOFFS_SCHEMA}}`;
const OPTION_SCHEMA = `"decision_options":[{"option":"string","summary":"string","preferred":true|false,"tradeoffs":${TRADEOFFS_SCHEMA}}],`;
const ASSUMPTION_SCHEMA =
  '"assumptions":[{"assumption":"string","status":"open|validated|rejected","evidence":"string","impact":"string","owner":"gemini|codex|claude|human"}],';
const ASSUMPTION_ATTACK_SCHEMA =
  '"assumption_attacks":[{"assumption":"string","challenge":"string","impact":"string","by":"gemini|codex|claude|human"}],';

function getPhaseJsonSchema(phase: string): string {
  const schemas: Record<string, string> = {
    propose: [
      '{',
      '  "view": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${OPTION_SCHEMA}`,
      `  ${ASSUMPTION_SCHEMA}`,
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    critique: [
      '{',
      '  "critique": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${OPTION_SCHEMA}`,
      `  ${ASSUMPTION_SCHEMA}`,
      `  ${ASSUMPTION_ATTACK_SCHEMA}`,
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "edge_cases": ["string"],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    refine: [
      '{',
      '  "view": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${DECISION_SCHEMA},`,
      `  ${OPTION_SCHEMA}`,
      `  ${ASSUMPTION_SCHEMA}`,
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    implement: [
      '{',
      '  "consensus": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${DECISION_SCHEMA},`,
      `  ${ASSUMPTION_SCHEMA}`,
      '  "disagreements": ["string"],',
      '  "task_allocations": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "review_chain": [{"from":"gemini|codex|claude","to":"gemini|codex|claude","purpose":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "risks": ["string"],',
      '  "next_round_focus": "string"',
      '}',
    ].join('\n'),
  };
  return schemas[phase] ?? '{}';
}

function getPhaseFocusInstruction(phase: string): string {
  if (phase === 'critique')
    return 'Focus: attack the strongest assumption in the current leading option before listing smaller issues. Cite specific file paths and line numbers.';
  if (phase === 'implement')
    return 'Focus: act as the final synthesizer. Name the decision owner, best next action, reversible first step, and review ordering. Do not write code.';
  if (phase === 'refine')
    return 'Focus: resolve critique into a single decision using the criteria above, then produce concrete task specs for Codex (file paths, signatures, DoD).';
  return 'Focus: surface distinct options, state tradeoffs across the decision criteria, and identify assumptions that need to be challenged.';
}

export function buildStepPrompt(
  step: { agent: string; phase: string; promptLabel: string },
  userPrompt: string,
  transcript: unknown[],
  round: number,
  totalRounds: number,
  specContent: string | null = null,
): string {
  const { agent, phase, promptLabel } = step;
  const agentConfig = getAgent(agent);
  const context = buildAgentContext(agent, {}, config, userPrompt);
  const framing = isPersonaEnabled()
    ? getAgentFraming(agent)
    : `You are ${agentConfig?.label ?? agent.toUpperCase()}`;

  const cs = buildContextSummary(transcript);

  return [
    `${framing} Council round ${String(round)}/${String(totalRounds)}, phase: ${phase}.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    context,
    '',
    'Return JSON only with keys:',
    getPhaseJsonSchema(phase),
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent != null && specContent !== ''
      ? `Anchoring Specification — do not deviate from these requirements:\n${specContent}\n`
      : '',
    `Phase instruction: ${promptLabel}`,
    '',
    `Decision criteria for convergence: ${formatCriteriaInstruction()}.`,
    'Do not use majority vote. Compare options explicitly, challenge assumptions directly, and prefer the most reversible path that still satisfies correctness.',
    '',
    'Recent council context:',
    cs === '' ? '(none)' : cs,
    '',
    getPhaseFocusInstruction(phase),
    'Set should_open_council=true only if deeper multi-round deliberation is necessary.',
  ].join('\n');
}

function defaultTasks(userPrompt: string) {
  return [
    {
      owner: 'claude',
      title: `Coordinate approach for: ${short(userPrompt, 80)}`,
      rationale: 'Establish scope and risk controls.',
      done: 'Clear sequencing and open questions documented.',
    },
    {
      owner: 'gemini',
      title: `Stress-test plan assumptions for: ${short(userPrompt, 80)}`,
      rationale: 'Catch regressions and edge cases.',
      done: 'Critical edge-case list and critiques documented.',
    },
    {
      owner: 'codex',
      title: `Prepare implementation packet for: ${short(userPrompt, 80)}`,
      rationale: 'Produce actionable engineering steps.',
      done: 'Concrete tasks and verification plan ready.',
    },
  ];
}

function formatTradeoffs(tradeoffs: unknown, bulletPrefix = '- ') {
  if (tradeoffs == null || typeof tradeoffs !== 'object') {
    return [];
  }
  const t = tradeoffs as Record<string, unknown>;
  return COUNCIL_DECISION_CRITERIA.filter((item) => cleanText(t[item.key]) !== '').map(
    (item) => `${bulletPrefix}${item.label}: ${(t[item.key] as string | undefined) ?? ''}`,
  );
}

function colorOwner(owner: string) {
  return HUMAN_OWNERS.has(owner) ? pc.white(owner) : colorAgent(owner);
}

function formatAgentTasks(tasks: Array<Record<string, unknown>>, agent: string): string {
  const myTasks = tasks.filter((t) => t['owner'] === agent || t['owner'] === 'unassigned');
  if (myTasks.length === 0) {
    return '- No explicit task assigned; review consensus and propose next actions.';
  }
  return myTasks
    .map(
      (t) =>
        `- ${(t['title'] as string | undefined) ?? ''}${t['done'] == null ? '' : ` (DoD: ${(t['done'] as string | undefined) ?? ''})`}${t['rationale'] == null ? '' : ` [${(t['rationale'] as string | undefined) ?? ''}]`}`,
    )
    .join('\n');
}

function formatAgentQuestions(questions: Array<Record<string, unknown>>, agent: string): string {
  const myQuestions = questions.filter((q) => q['to'] === agent || q['to'] === 'human');
  if (myQuestions.length === 0) return '- none';
  return myQuestions
    .map(
      (q) =>
        `- to ${(q['to'] as string | undefined) ?? ''}: ${(q['question'] as string | undefined) ?? ''}`,
    )
    .join('\n');
}

function formatUnresolvedAssumptions(assumptions: Array<Record<string, unknown>>): string {
  const unresolved = assumptions.filter((item) => item['status'] !== 'validated');
  if (unresolved.length === 0) return '- none';
  return unresolved
    .slice(0, 5)
    .map(
      (item) =>
        `- ${(item['assumption'] as string | undefined) ?? ''}${item['owner'] != null && item['owner'] !== 'unassigned' ? ` [owner: ${(item['owner'] as string | undefined) ?? ''}]` : ''}`,
    )
    .join('\n');
}

function formatDecisionLines(
  finalDecision: Record<string, unknown> | null,
  report: Record<string, unknown>,
): string[] {
  if (finalDecision == null)
    return ['- No explicit final decision captured; use transcript summary.'];
  return [
    `Decision owner: ${(finalDecision['owner'] as string | undefined) ?? ''}`,
    `Decision confidence: ${(finalDecision['confidence'] as string | undefined) ?? 'n/a'}`,
    `Next action: ${(report['recommendedNextAction'] as string | undefined) ?? (finalDecision['nextAction'] as string | undefined) ?? (report['recommendedMode'] as string | undefined) ?? 'handoff'}`,
    `Reversible first step: ${(finalDecision['reversibleFirstStep'] as string | undefined) ?? 'not specified'}`,
    ...formatTradeoffs(finalDecision['tradeoffs']),
  ];
}

function buildAgentBrief(agent: string, objective: string, report: Record<string, unknown>) {
  const agentConfig = getAgent(agent);
  const tasks = Array.isArray(report['tasks'])
    ? (report['tasks'] as Array<Record<string, unknown>>)
    : [];
  const questions = Array.isArray(report['questions'])
    ? (report['questions'] as Array<Record<string, unknown>>)
    : [];
  const transcript = Array.isArray(report['transcript']) ? report['transcript'] : [];
  const consensus = cleanText(report['consensus']);
  const finalDecision = (report['finalDecision'] as Record<string, unknown> | null) ?? null;

  return [
    `Hydra Council assignment for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    `Objective: ${objective}`,
    `Consensus: ${consensus === '' ? 'No consensus text generated; use transcript summary.' : consensus}`,
    'Decision synthesis:',
    formatDecisionLines(finalDecision, report).join('\n'),
    'Assigned tasks:',
    formatAgentTasks(tasks, agent),
    'Unresolved assumptions:',
    formatUnresolvedAssumptions(
      Array.isArray(report['assumptions'])
        ? (report['assumptions'] as Array<Record<string, unknown>>)
        : [],
    ),
    'Open questions:',
    formatAgentQuestions(questions, agent),
    'Latest council excerpts:',
    buildContextSummary(transcript),
    'Next step: Start with top task and handoff milestone or blocker via Hydra.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// Adversarial Council Mode
// Flow: DIVERGE (parallel, no shared context) → ATTACK (parallel,
// assumption targeting) → SYNTHESIZE (Claude as decider) → IMPLEMENT (Codex)
// ─────────────────────────────────────────────────────────────

function buildDivergePrompt(agent: string, userPrompt: string, specContent: string | null) {
  const agentConfig = getAgent(agent);
  const context = buildAgentContext(agent, {}, config, userPrompt);
  const framing = isPersonaEnabled()
    ? getAgentFraming(agent)
    : `You are ${agentConfig?.label ?? agent.toUpperCase()}`;
  const tradeoffsSchema =
    '{"correctness":"string","complexity":"string","reversibility":"string","user_impact":"string"}';
  return [
    `${framing} You are in the DIVERGE phase of an adversarial council.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    context,
    '',
    "IMPORTANT: Answer completely independently. You will not see other agents' answers at this stage. Produce your own genuine view — do not anchor to any shared framing.",
    '',
    'Return JSON only with keys:',
    '{',
    '  "view": "string — your independent analysis and approach",',
    `  "decision_options": [{"option":"string","summary":"string","preferred":true|false,"tradeoffs":${tradeoffsSchema}}],`,
    `  "assumptions": [{"assumption":"string","status":"open","evidence":"string","impact":"string","owner":"${agent}"}],`,
    '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
    '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
    '  "risks": ["string"],',
    '  "sanity_checks": ["string"]',
    '}',
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent != null && specContent !== '' ? `Anchoring Specification:\n${specContent}\n` : '',
    `Decision criteria: ${formatCriteriaInstruction()}.`,
    'Focus: surface distinct options, state tradeoffs across the criteria, and identify your strongest assumptions.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAttackPrompt(
  agent: string,
  userPrompt: string,
  divergeEntries: Array<Record<string, unknown>>,
  specContent: string | null,
) {
  const agentConfig = getAgent(agent);
  const context = buildAgentContext(agent, {}, config, userPrompt);
  const framing = isPersonaEnabled()
    ? getAgentFraming(agent)
    : `You are ${agentConfig?.label ?? agent.toUpperCase()}`;
  const othersOutput = divergeEntries
    .filter((e) => e['agent'] !== agent)
    .map((e) => {
      const content = e['parsed'] == null ? e['rawText'] : JSON.stringify(e['parsed']);
      return `${String(e['agent']).toUpperCase()} independent view:\n${short(content as string, 1200)}`;
    })
    .join('\n\n');
  return [
    `${framing} You are in the ATTACK phase of an adversarial council.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    context,
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent != null && specContent !== '' ? `Anchoring Specification:\n${specContent}\n` : '',
    'Other agents submitted independent views (you did not see these before now):',
    '',
    othersOutput,
    '',
    "For each other agent's view, identify their single strongest (most load-bearing) assumption and provide a concrete attack vector — a scenario or counterexample that would break that assumption.",
    '',
    'Return JSON only with keys:',
    '{',
    '  "assumption_attacks": [',
    '    {"target_agent":"gemini|codex|claude","assumption":"string","attack_vector":"string","severity":"low|medium|high","suggested_fix":"string"}',
    '  ],',
    '  "strongest_own_assumption": "string — the most load-bearing assumption in your own diverge answer",',
    '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}]',
    '}',
    '',
    'Be precise and adversarial. Target load-bearing assumptions only — if the assumption is wrong, the whole approach fails.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSynthesizePrompt(
  userPrompt: string,
  divergeEntries: Array<Record<string, unknown>>,
  attackEntries: Array<Record<string, unknown>>,
  specContent: string | null,
) {
  const agentConfig = getAgent('claude');
  const context = buildAgentContext('claude', {}, config, userPrompt);
  const framing = isPersonaEnabled()
    ? getAgentFraming('claude')
    : `You are ${agentConfig?.label ?? 'Claude'}`;
  const tradeoffsSchema =
    '{"correctness":"string","complexity":"string","reversibility":"string","user_impact":"string"}';
  const allDiverge = divergeEntries
    .map(
      (e) =>
        `${String(e['agent']).toUpperCase()} independent view:\n${short(e['parsed'] == null ? (e['rawText'] as string) : JSON.stringify(e['parsed']), 1000)}`,
    )
    .join('\n\n');
  const allAttacks = attackEntries
    .map(
      (e) =>
        `${String(e['agent']).toUpperCase()} attacks:\n${short(e['parsed'] == null ? (e['rawText'] as string) : JSON.stringify(e['parsed']), 800)}`,
    )
    .join('\n\n');
  return [
    `${framing} You are in the SYNTHESIZE phase of an adversarial council. You are the designated decision owner.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    context,
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent != null && specContent !== '' ? `Anchoring Specification:\n${specContent}\n` : '',
    '== Independent Views (Diverge Phase) ==',
    allDiverge,
    '',
    '== Assumption Attacks (Attack Phase) ==',
    allAttacks,
    '',
    'Synthesize this into a single decision. Do NOT use majority vote. Compare options explicitly using the decision criteria.',
    'When agents disagree, prefer the most reversible option unless there is clear evidence for a less reversible one.',
    '',
    `Decision criteria: ${formatCriteriaInstruction()}.`,
    '',
    'Return JSON only with keys:',
    '{',
    '  "view": "string — synthesis narrative: what you decided and why",',
    '  "decision": {',
    '    "summary": "string",',
    '    "why": "string — which tradeoffs you prioritized and why",',
    '    "owner": "claude",',
    '    "confidence": "low|medium|high",',
    '    "next_action": "handoff|deeper_council|human_decision",',
    '    "reversible_first_step": "string — the most reversible concrete first action",',
    `    "tradeoffs": ${tradeoffsSchema}`,
    '  },',
    '  "criteria_scores": {',
    '    "claude_view": {"correctness":0-10,"complexity":0-10,"reversibility":0-10,"user_impact":0-10},',
    '    "gemini_view": {"correctness":0-10,"complexity":0-10,"reversibility":0-10,"user_impact":0-10},',
    '    "codex_view": {"correctness":0-10,"complexity":0-10,"reversibility":0-10,"user_impact":0-10}',
    '  },',
    '  "surviving_assumptions": [{"assumption":"string","owner":"gemini|codex|claude","evidence":"string"}],',
    '  "killed_assumptions": [{"assumption":"string","killed_by":"string","why":"string"}],',
    '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
    '  "risks": ["string"]',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Resolve the ordered list of active agents for adversarial council.
 * Preserves default ordering ['claude','gemini','codex'] and filters to the allowlist.
 */
export function resolveActiveAgents(
  agentsFilter: string[] | null,
  defaults = ['claude', 'gemini', 'codex'],
): string[] {
  if (agentsFilter == null || agentsFilter.length === 0) return [...defaults];
  return defaults.filter((a) => agentsFilter.includes(a));
}

/** Ordered adversarial phase names (excluding implement which runs once after all rounds). */
const ADV_PHASE_ORDER = Object.freeze(['diverge', 'attack', 'synthesize']);

/**
 * Compute the resume point for an adversarial run from existing transcript entries.
 * Returns { startRound, startPhaseIdx } where startPhaseIdx indexes ADV_PHASE_ORDER.
 * Returns { startRound: Infinity } when implement was already completed.
 */
export function computeAdversarialResumePoint(transcript: unknown[]): {
  startRound: number;
  startPhaseIdx: number;
} {
  if (transcript.length === 0) return { startRound: 1, startPhaseIdx: 0 };
  const last = transcript.at(-1) as Record<string, unknown>;
  if (last['phase'] === 'implement') return { startRound: Infinity, startPhaseIdx: 0 };
  const lastPhaseIdx = ADV_PHASE_ORDER.indexOf(last['phase'] as string);
  const rawRound = last['round'] as number;
  const lastRound = rawRound !== 0 && !Number.isNaN(rawRound) ? rawRound : 1;
  // After synthesize (last phase in a round), advance to next round
  if (lastPhaseIdx < 0 || lastPhaseIdx >= ADV_PHASE_ORDER.length - 1) {
    return { startRound: lastRound + 1, startPhaseIdx: 0 };
  }
  return { startRound: lastRound, startPhaseIdx: lastPhaseIdx + 1 };
}

interface AdversarialContext {
  prompt: string;
  transcript: Array<Record<string, unknown>>;
  activeAgents: string[];
  preview: boolean;
  timeoutMs: number;
  specContent: string | null;
  promptHash: string;
  rounds: number;
}

function makeTranscriptEntry(
  round: number,
  agent: string,
  phase: string,
  result: {
    ok: boolean;
    stdout?: string;
    stderr: string;
    error: string;
    recovered: boolean;
    originalModel?: string;
    newModel?: string;
  },
): Record<string, unknown> {
  return {
    round,
    agent,
    phase,
    timestamp: new Date().toISOString(),
    ok: result.ok,
    rawText: result.stdout ?? '',
    parsed: parseJsonLoose(result.stdout ?? ''),
    error: result.error === '' ? result.stderr : result.error,
    recovered: result.recovered,
    recoveredFrom: result.originalModel,
    recoveredTo: result.newModel,
  };
}

async function executeParallelPhase(
  ctx: AdversarialContext,
  round: number,
  phase: string,
  buildPromptFn: (agent: string) => string,
): Promise<void> {
  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'start', phase, round, agents: ctx.activeAgents })}\n`,
  );
  const spinner = createSpinner(
    `${DIM(phase)} ${ctx.activeAgents.map(colorAgent).join(' ')} ${DIM(`(round ${String(round)}/${String(ctx.rounds)}, parallel)`)}`,
    { style: 'orbital' },
  );
  spinner.start();

  if (ctx.preview) {
    for (const agent of ctx.activeAgents) {
      ctx.transcript.push({
        round,
        agent,
        phase,
        timestamp: new Date().toISOString(),
        ok: true,
        rawText: '{}',
        parsed:
          phase === 'diverge' ? { view: `${agent} ${phase} preview` } : { assumption_attacks: [] },
        error: '',
      });
    }
    spinner.succeed(`${DIM(phase)} complete (preview, round ${String(round)})`);
  } else {
    const phaseStart = Date.now();
    const results = await Promise.allSettled(
      ctx.activeAgents.map(async (agent) => {
        const p = buildPromptFn(agent);
        const result = await callAgentAsync(agent, p, ctx.timeoutMs);
        return { agent, result };
      }),
    );
    spinner.succeed(
      `${DIM(phase)} complete ${DIM(`(round ${String(round)}, ${formatElapsed(Date.now() - phaseStart)})`)}`,
    );
    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const { agent, result } = settled.value;
        ctx.transcript.push(makeTranscriptEntry(round, agent, phase, result));
      }
    }
    const phaseIdx = phase === 'diverge' ? 0 : 1;
    saveCheckpoint(ctx.promptHash, ctx.prompt, round, phaseIdx, ctx.transcript, ctx.specContent);
  }
  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'complete', phase, round })}\n`,
  );
}

async function executeSynthesizePhase(
  ctx: AdversarialContext,
  round: number,
  synthesizeAgent: string,
  divergeEntries: Array<Record<string, unknown>>,
  attackEntries: Array<Record<string, unknown>>,
): Promise<void> {
  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'start', phase: 'synthesize', round, agent: synthesizeAgent })}\n`,
  );
  const spinner = createSpinner(
    `${colorAgent(synthesizeAgent)} ${DIM(`synthesize (round ${String(round)}/${String(ctx.rounds)})`)}`,
    { style: 'orbital' },
  );
  spinner.start();

  if (ctx.preview) {
    ctx.transcript.push({
      round,
      agent: synthesizeAgent,
      phase: 'synthesize',
      timestamp: new Date().toISOString(),
      ok: true,
      rawText: '{}',
      parsed: {
        view: 'synthesize preview',
        decision: {
          summary: 'preview',
          confidence: 'high',
          next_action: 'handoff',
          reversible_first_step: 'preview step',
          tradeoffs: {},
        },
      },
      error: '',
    });
    spinner.succeed(
      `${colorAgent(synthesizeAgent)} ${DIM('synthesize')} complete (preview, round ${String(round)})`,
    );
  } else {
    const synthesizeStart = Date.now();
    const synthesizeResult = await callAgentAsync(
      synthesizeAgent,
      buildSynthesizePrompt(ctx.prompt, divergeEntries, attackEntries, ctx.specContent),
      ctx.timeoutMs,
    );
    spinner.succeed(
      `${colorAgent(synthesizeAgent)} ${DIM('synthesize')} complete ${DIM(`(round ${String(round)}, ${formatElapsed(Date.now() - synthesizeStart)})`)}`,
    );
    ctx.transcript.push(
      makeTranscriptEntry(round, synthesizeAgent, 'synthesize', synthesizeResult),
    );
    saveCheckpoint(ctx.promptHash, ctx.prompt, round, 2, ctx.transcript, ctx.specContent);
  }
  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'complete', phase: 'synthesize', round, agent: synthesizeAgent })}\n`,
  );
}

async function executeImplementPhase(ctx: AdversarialContext): Promise<void> {
  const foundImpl = COUNCIL_FLOW.find((s) => s.phase === 'implement');
  if (foundImpl == null) throw new Error('No implement step in COUNCIL_FLOW');
  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'start', phase: 'implement', agent: 'codex' })}\n`,
  );
  const spinner = createSpinner(`${colorAgent('codex')} ${DIM('implement')}`, {
    style: 'orbital',
  });
  spinner.start();
  const implementStart = Date.now();
  const implementResult = await callAgentAsync(
    'codex',
    buildStepPrompt(foundImpl, ctx.prompt, ctx.transcript, 1, 1, ctx.specContent),
    ctx.timeoutMs,
  );
  spinner.succeed(
    `${colorAgent('codex')} ${DIM('implement')} complete ${DIM(`(${formatElapsed(Date.now() - implementStart)})`)}`,
  );
  ctx.transcript.push(makeTranscriptEntry(ctx.rounds, 'codex', 'implement', implementResult));
  saveCheckpoint(ctx.promptHash, ctx.prompt, ctx.rounds, 3, ctx.transcript, ctx.specContent);
  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'complete', phase: 'implement', agent: 'codex' })}\n`,
  );
}

function computeResumeState(transcript: Array<Record<string, unknown>>, rounds: number) {
  let startRound = 1;
  let startPhaseIdx = 0;
  let implementAlreadyDone = false;

  if (transcript.length === 0) return { startRound, startPhaseIdx, implementAlreadyDone };

  const resume = computeAdversarialResumePoint(transcript);
  if (resume.startRound === Infinity) {
    implementAlreadyDone = true;
    startRound = rounds + 1;
  } else {
    startRound = resume.startRound;
    startPhaseIdx = resume.startPhaseIdx;
  }
  const cached = transcript.length;
  const resumePhase = ADV_PHASE_ORDER[startPhaseIdx];
  process.stderr.write(
    `  Resuming adversarial council from round ${String(Math.min(startRound, rounds + 1))}, phase ${resumePhase} (${String(cached)} phases cached)\n`,
  );
  return { startRound, startPhaseIdx, implementAlreadyDone };
}

async function executeAdversarialRound(
  ctx: AdversarialContext,
  round: number,
  synthesizeAgent: string,
  specContent: string | null,
  prompt: string,
  report: { transcript: Array<Record<string, unknown>> },
  startRound: number,
  startPhaseIdx: number,
): Promise<void> {
  const skipDiverge = round < startRound || (round === startRound && startPhaseIdx > 0);
  const skipAttack = round < startRound || (round === startRound && startPhaseIdx > 1);
  const skipSynth = round < startRound || (round === startRound && startPhaseIdx > 2);

  if (!skipDiverge) {
    await executeParallelPhase(ctx, round, 'diverge', (agent) =>
      buildDivergePrompt(agent, prompt, specContent),
    );
  }

  const divergeEntries = report.transcript.filter(
    (e) => e['phase'] === 'diverge' && e['round'] === round,
  );

  if (!skipAttack) {
    await executeParallelPhase(ctx, round, 'attack', (agent) =>
      buildAttackPrompt(agent, prompt, divergeEntries, specContent),
    );
  }

  const attackEntries = report.transcript.filter(
    (e) => e['phase'] === 'attack' && e['round'] === round,
  );

  if (!skipSynth) {
    await executeSynthesizePhase(ctx, round, synthesizeAgent, divergeEntries, attackEntries);
  }
}

async function runAdversarialCouncil(
  prompt: string,
  report: {
    transcript: Array<Record<string, unknown>>;
    councilFlow: string[];
    specId?: string;
    [key: string]: unknown;
  },
  {
    preview,
    timeoutMs,
    specContent,
    promptHash,
    agentsFilter,
    rounds,
  }: {
    preview: boolean;
    timeoutMs: number;
    specContent: string | null;
    promptHash: string;
    agentsFilter: string[] | null;
    rounds: number;
  },
) {
  const activeAgents = resolveActiveAgents(agentsFilter);
  const fallbackAgent = activeAgents[0] ?? 'claude';
  const synthesizeAgent = activeAgents.includes('claude') ? 'claude' : fallbackAgent;

  report.councilFlow = [
    ...activeAgents.map((a) => `${a}:diverge`),
    ...activeAgents.map((a) => `${a}:attack`),
    `${synthesizeAgent}:synthesize`,
    ...(activeAgents.includes('codex') ? ['codex:implement'] : []),
  ];

  process.stderr.write(
    `${JSON.stringify({ type: 'council_mode', mode: 'adversarial', participants: activeAgents, rounds })}\n`,
  );

  const ctx: AdversarialContext = {
    prompt,
    transcript: report.transcript,
    activeAgents,
    preview,
    timeoutMs,
    specContent,
    promptHash,
    rounds,
  };

  const { startRound, startPhaseIdx, implementAlreadyDone } = computeResumeState(
    report.transcript,
    rounds,
  );

  for (let round = 1; round <= rounds; round++) {
    // eslint-disable-next-line no-await-in-loop
    await executeAdversarialRound(
      ctx,
      round,
      synthesizeAgent,
      specContent,
      prompt,
      report,
      startRound,
      startPhaseIdx,
    );
  }

  if (!implementAlreadyDone && activeAgents.includes('codex') && !preview) {
    await executeImplementPhase(ctx);
  }
}

interface MainOptions {
  prompt: string;
  preview: boolean;
  publish: boolean;
  rounds: number;
  timeoutMs: number;
  url: string;
  emit: string;
  save: boolean;
  agentsFilter: string[] | null;
}

function parseMainOptions(): MainOptions {
  const { options, positionals } = parseArgs(process.argv);
  const prompt = getPrompt(options, positionals);

  if (prompt === '') {
    throw new Error(
      'Missing prompt. Example: node hydra-council.mjs prompt="Investigate startup regressions"',
    );
  }

  const mode = String(options['mode'] ?? 'live').toLowerCase();
  const preview = mode === 'preview' || boolFlag(options['preview'], false);
  const publish = boolFlag(options['publish'], !preview);
  const parsedRounds = Number.parseInt(String(options['rounds'] ?? '2'), 10);
  const rounds = Math.max(
    1,
    Math.min(4, parsedRounds !== 0 && !Number.isNaN(parsedRounds) ? parsedRounds : 2),
  );
  const timeoutMs = Number.parseInt(String(options['timeoutMs'] ?? DEFAULT_TIMEOUT_MS), 10);
  const url = String(options['url'] ?? DEFAULT_URL);
  const emit = String(options['emit'] ?? 'summary').toLowerCase();
  const save = boolFlag(options['save'] as string | boolean | undefined, emit !== 'json');
  const agentsRaw = options['agents'];
  const agentsFilter =
    typeof agentsRaw === 'string' && agentsRaw !== ''
      ? agentsRaw
          .split(',')
          .map((a: string) => a.trim().toLowerCase())
          .filter((a) => a !== '')
      : null;

  return { prompt, preview, publish, rounds, timeoutMs, url, emit, save, agentsFilter };
}

type CouncilReport = ReturnType<typeof createReport>;

function createReport(opts: MainOptions) {
  return {
    id: runId('HYDRA_COUNCIL'),
    startedAt: nowIso(),
    finishedAt: null as string | null,
    prompt: opts.prompt,
    mode: opts.preview ? 'preview' : 'live',
    publish: opts.publish,
    rounds: opts.rounds,
    councilFlow: (opts.agentsFilter === null
      ? COUNCIL_FLOW
      : COUNCIL_FLOW.filter((s) => opts.agentsFilter?.includes(s.agent) === true)
    ).map((s) => `${s.agent}:${s.phase}`),
    url: opts.url,
    project: config.projectName,
    daemonSummary: null as unknown,
    specId: undefined as string | undefined,
    transcript: [] as Array<{
      round: number;
      agent: string;
      phase: string;
      timestamp?: string;
      ok: boolean;
      rawText: string;
      parsed: unknown;
      error: string;
      recovered: boolean;
      recoveredFrom?: string;
      recoveredTo?: string;
      compactedRetry?: boolean;
    }>,
    consensus: '',
    tasks: [] as Array<{
      owner?: string;
      title?: string;
      description?: string;
      rationale?: string;
      done?: string;
    }>,
    questions: [] as Array<{ to: string; question: string }>,
    risks: [] as unknown[],
    decisionOptions: [] as unknown[],
    assumptions: [] as Array<{ status: string; [key: string]: unknown }>,
    assumptionAttacks: [] as Array<{ challenge?: string; assumption?: string }>,
    disagreements: [] as unknown[],
    finalDecision: null as null | {
      owner?: string;
      confidence?: string;
      nextAction?: string;
      reversibleFirstStep?: string;
      summary?: string;
      why?: string;
      tradeoffs?: unknown;
    },
    councilVotes: [] as unknown[],
    recommendedMode: 'handoff',
    recommendedNextAction: 'handoff',
    recommendationRationale: '',
    published: null as null | {
      ok: boolean;
      skipped?: boolean;
      error?: string;
      decision?: unknown;
      tasks?: unknown[];
      handoffs?: unknown[];
      reason?: string;
    },
  };
}

function buildPreviewEntry(step: { agent: string; phase: string }, prompt: string, _round: number) {
  return {
    view: `${step.agent} ${step.phase} preview response`,
    consensus: `${step.agent} ${step.phase} preview consensus`,
    decision_options: [
      {
        option: 'reversible_probe',
        summary: `Preview option from ${step.agent}`,
        preferred: step.phase !== 'critique',
        tradeoffs: {
          correctness: 'Safe preview choice',
          complexity: 'Low',
          reversibility: 'High',
          user_impact: 'Low risk',
        },
      },
    ],
    assumptions: [
      {
        assumption: `Preview assumption from ${step.agent}`,
        status: step.phase === 'implement' ? 'validated' : 'open',
        evidence: 'Preview evidence',
        impact: 'Preview impact',
        owner: step.agent,
      },
    ],
    decision: {
      summary: `${step.agent} ${step.phase} preview synthesis`,
      why: 'Preview rationale',
      owner: step.agent,
      confidence: step.phase === 'implement' ? 'high' : 'medium',
      next_action: step.phase === 'implement' ? 'handoff' : 'deeper_council',
      reversible_first_step: `Preview reversible first step from ${step.agent}`,
      tradeoffs: {
        correctness: 'Preview correctness note',
        complexity: 'Preview complexity note',
        reversibility: 'Preview reversibility note',
        user_impact: 'Preview impact note',
      },
    },
    recommended_tasks: defaultTasks(prompt).map((t) => ({
      owner: t.owner,
      title: t.title,
      rationale: t.rationale,
      definition_of_done: t.done,
    })),
    questions: [{ to: 'human', question: `Preview question from ${step.agent} (${step.phase})` }],
  };
}

function resolveErrorMessage(result: { error: string; stderr: string }): string {
  if (result.error !== '') return result.error;
  if (result.stderr !== '') return result.stderr;
  return 'unknown failure';
}

async function executeWithRetries(
  step: { agent: string; phase: string },
  promptText: string,
  opts: MainOptions,
  round: number,
  specContent: string | null,
  spinner: ReturnType<typeof createSpinner>,
): Promise<ReturnType<typeof callAgentAsync>> {
  const initialResult = await callAgentAsync(step.agent, promptText, opts.timeoutMs);

  let afterRlResult = initialResult;
  if (!initialResult.ok) {
    const rlCheck = detectRateLimitError(step.agent, initialResult);
    if (rlCheck.isRateLimit) {
      const delay = calculateBackoff(0, { retryAfterMs: rlCheck.retryAfterMs ?? undefined });
      spinner.update(
        `${colorAgent(step.agent)} ${DIM(step.phase)} rate limited, retrying in ${(delay / 1000).toFixed(0)}s...`,
      );
      await new Promise<void>((r) => {
        globalThis.setTimeout(r, delay);
      });
      afterRlResult = await callAgentAsync(step.agent, promptText, opts.timeoutMs);
    }
  }

  if (afterRlResult.ok || afterRlResult.timedOut !== true) return afterRlResult;

  const compactedPrompt = buildStepPrompt(
    step as (typeof COUNCIL_FLOW)[number],
    opts.prompt,
    [],
    round,
    opts.rounds,
    specContent,
  );
  spinner.update(
    `${colorAgent(step.agent)} ${DIM(step.phase)} timed out — retrying with compacted context...`,
  );
  const compactedResult = await callAgentAsync(step.agent, compactedPrompt, opts.timeoutMs);
  if (compactedResult.ok) compactedResult._compactedRetry = true;
  return compactedResult;
}

function formatPhaseSpinnerResult(
  step: { agent: string; phase: string },
  result: ReturnType<typeof callAgentAsync> extends Promise<infer R> ? R : never,
  spinner: ReturnType<typeof createSpinner>,
): void {
  if (result.ok) {
    let suffix = '';
    if (result.recovered) {
      suffix = ` ${DIM(`(recovered: ${result.newModel ?? ''})`)}`;
    } else if (result._compactedRetry === true) {
      suffix = ` ${DIM('(compacted retry)')}`;
    }
    spinner.succeed(`${colorAgent(step.agent)} ${DIM(step.phase)} complete${suffix}`);
  } else {
    spinner.fail(`${colorAgent(step.agent)} ${DIM(step.phase)} failed`);
  }
}

async function notifyDoctorOnFailure(
  step: { agent: string; phase: string },
  result: {
    ok: boolean;
    error: string;
    stderr: string;
    exitCode?: number | null;
    signal?: string | null;
    output?: string;
    stdout?: string;
  },
  round: number,
): Promise<void> {
  if (result.ok) return;
  if (!isDoctorEnabled()) return;
  try {
    await notifyDoctor({
      pipeline: 'council',
      phase: step.phase,
      agent: step.agent,
      error: resolveErrorMessage(result),
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      stderr: result.stderr,
      stdout: result.output ?? result.stdout,
      context: `Council phase ${step.phase} failed in round ${String(round)}`,
    });
  } catch {
    /* doctor notification non-critical */
  }
}

async function executeSequentialPhase(
  step: { agent: string; phase: string; promptLabel: string },
  opts: MainOptions,
  report: CouncilReport,
  round: number,
  stepIdx: number,
  specContent: string | null,
  promptHash: string,
  activeFlow: typeof COUNCIL_FLOW,
): Promise<void> {
  const stepNum = stepIdx + 1;
  const totalSteps = activeFlow.length;
  const promptText = buildStepPrompt(
    step,
    opts.prompt,
    report.transcript,
    round,
    opts.rounds,
    specContent,
  );

  if (opts.preview) {
    const parsed = buildPreviewEntry(step, opts.prompt, round);
    report.transcript.push({
      round,
      agent: step.agent,
      phase: step.phase,
      timestamp: new Date().toISOString(),
      ok: true,
      rawText: JSON.stringify(parsed),
      parsed: parsed as unknown,
      error: '',
      recovered: false,
    });
    return;
  }

  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'start', round, step: stepNum, totalSteps, agent: step.agent, phase: step.phase })}\n`,
  );

  const spinner = createSpinner(
    `${colorAgent(step.agent)} ${DIM(step.phase)} (round ${String(round)}/${String(opts.rounds)})`,
    { style: 'orbital' },
  );
  spinner.start();
  const phaseStartMs = Date.now();
  const result = await executeWithRetries(step, promptText, opts, round, specContent, spinner);

  const parsed = parseJsonLoose(result.stdout);
  const durationMs = Date.now() - phaseStartMs;
  formatPhaseSpinnerResult(step, result, spinner);
  await notifyDoctorOnFailure(step, result, round);

  process.stderr.write(
    `${JSON.stringify({ type: 'council_phase', action: 'complete', round, step: stepNum, totalSteps, agent: step.agent, phase: step.phase, ok: result.ok, durationMs, recovered: result.recovered || false })}\n`,
  );

  report.transcript.push({
    round,
    agent: step.agent,
    phase: step.phase,
    timestamp: new Date().toISOString(),
    ok: result.ok,
    rawText: result.stdout ?? '',
    parsed,
    error: result.error === '' ? result.stderr : result.error,
    recovered: result.recovered,
    recoveredFrom: result.originalModel,
    recoveredTo: result.newModel,
    compactedRetry: result._compactedRetry ?? false,
  });

  saveCheckpoint(promptHash, opts.prompt, round, stepIdx, report.transcript, specContent);
}

async function publishCouncilResults(report: CouncilReport, opts: MainOptions): Promise<void> {
  const localReport = report;
  if (!opts.publish) {
    localReport.published = { ok: true, skipped: true, reason: 'publish=false' };
    return;
  }

  const publishResult = await executePublish(report, opts);
  localReport.published = publishResult;
}

function buildCouncilParticipants(
  agents: string[],
  transcript: unknown[],
): Array<Record<string, unknown>> {
  const transcriptEntries = transcript.filter(
    (entry): entry is Record<string, unknown> =>
      entry != null && typeof entry === 'object' && !Array.isArray(entry),
  );
  return agents.map((agent) => {
    const agentEntries = transcriptEntries.filter((entry) => entry['agent'] === agent);
    const failed = agentEntries.some((entry) => entry['ok'] === false);
    const startedAt =
      typeof agentEntries[0]?.['timestamp'] === 'string' ? agentEntries[0]['timestamp'] : null;
    const endedAt =
      typeof agentEntries.at(-1)?.['timestamp'] === 'string'
        ? agentEntries.at(-1)?.['timestamp']
        : null;
    let state: 'completed' | 'failed' | 'waiting' = 'waiting';
    if (failed) {
      state = 'failed';
    } else if (agentEntries.length > 0) {
      state = 'completed';
    }
    return {
      agent,
      role: null,
      state,
      startedAt,
      endedAt,
    };
  });
}

function stringifyCouncilField(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return fallback;
}

function buildCouncilTransitions(transcript: unknown[]): Array<Record<string, unknown>> {
  return transcript
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry != null && typeof entry === 'object' && !Array.isArray(entry),
    )
    .map((entry) => ({
      label: `Round ${stringifyCouncilField(entry['round'], '?')} - ${stringifyCouncilField(entry['agent'], 'unknown')} ${stringifyCouncilField(entry['phase'], 'phase')}`,
      status: entry['ok'] === false ? 'failed' : 'completed',
      timestamp:
        typeof entry['timestamp'] === 'string' && entry['timestamp'].trim() !== ''
          ? entry['timestamp']
          : new Date().toISOString(),
      detail: short(
        typeof entry['rawText'] === 'string' && entry['rawText'].trim() !== ''
          ? entry['rawText']
          : JSON.stringify(entry['parsed'] ?? ''),
        220,
      ),
    }));
}

function resolveCouncilStatus(transcript: unknown[]): 'completed' | 'failed' {
  const transcriptEntries = transcript.filter(
    (entry): entry is Record<string, unknown> =>
      entry != null && typeof entry === 'object' && !Array.isArray(entry),
  );
  return transcriptEntries.some((entry) => entry['ok'] === false) ? 'failed' : 'completed';
}

async function executePublish(
  report: CouncilReport,
  opts: MainOptions,
): Promise<NonNullable<CouncilReport['published']>> {
  try {
    const health = await request('GET', opts.url, '/health');
    if ((health as Record<string, unknown>)['ok'] !== true) {
      throw new Error('Hydra daemon is not healthy.');
    }

    const publishAgents = opts.agentsFilter ?? AGENT_NAMES;
    const councilParticipants = buildCouncilParticipants(publishAgents, report.transcript);
    const councilTransitions = buildCouncilTransitions(report.transcript);
    const councilStatus = resolveCouncilStatus(report.transcript);
    const createdTasks: unknown[] = [];
    for (const task of report.tasks) {
      // eslint-disable-next-line no-await-in-loop
      const created = await request('POST', opts.url, '/task/add', {
        title: task.title,
        owner: task.owner,
        status: 'todo',
        mode: 'council',
        notes:
          task.rationale != null && task.rationale !== ''
            ? `Council rationale: ${task.rationale}`
            : '',
      });
      createdTasks.push((created as Record<string, unknown>)['task']);
    }

    const councilRationale = report.finalDecision?.why ?? report.consensus;
    const decisionTitle = `Hydra Council: ${short(opts.prompt, 90)}`;
    const decisionResult = await request('POST', opts.url, '/decision', {
      title: decisionTitle,
      owner: 'human',
      rationale:
        councilRationale === ''
          ? 'Council completed without explicit consensus.'
          : councilRationale,
      impact: `Rounds=${String(opts.rounds)}; Tasks=${String(createdTasks.length)}; Flow=Claude\u2192Gemini\u2192Claude\u2192Codex; next=${report.recommendedNextAction}`,
      route: 'council',
      mode: 'council',
      taskIds: (createdTasks as Array<{ id?: string }>).flatMap((task) =>
        typeof task.id === 'string' && task.id !== '' ? [task.id] : [],
      ),
      councilParticipants,
      councilTransitions,
      councilFinalOutcome:
        report.finalDecision?.summary ?? (councilRationale === '' ? null : councilRationale),
      councilStatus,
    });

    const handoffs: unknown[] = [];
    for (const agent of publishAgents) {
      const agentTaskIds = (createdTasks as Array<{ owner?: string; id?: string }>)
        .filter((t) => t.owner === agent || t.owner === 'unassigned')
        .map((t) => t.id);
      const summary = buildAgentBrief(
        agent,
        opts.prompt,
        report as unknown as Record<string, unknown>,
      );
      // eslint-disable-next-line no-await-in-loop
      const handoff = await request('POST', opts.url, '/handoff', {
        from: 'human',
        to: agent,
        summary,
        nextStep: 'Acknowledge this council handoff and start highest-priority task.',
        tasks: agentTaskIds,
      });
      handoffs.push((handoff as Record<string, unknown>)['handoff']);
    }

    return {
      ok: true,
      decision: (decisionResult as Record<string, unknown>)['decision'],
      tasks: createdTasks,
      handoffs,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function printPhaseHealth(report: CouncilReport): void {
  if (report.transcript.length === 0) return;
  console.log('');
  console.log(sectionHeader('Phase Health'));
  for (const entry of report.transcript) {
    if (entry.ok) {
      console.log(
        `  ${SUCCESS('\u2713')} ${colorAgent(entry.agent)} ${DIM(entry.phase)} ${DIM(`(round ${String(entry.round)})`)}`,
      );
    } else {
      const failLabel = entry.error.includes('ETIMEDOUT') ? 'TIMEOUT' : 'FAILED';
      console.log(
        `  ${ERROR('\u2717')} ${colorAgent(entry.agent)} ${DIM(entry.phase)} ${DIM(`(round ${String(entry.round)})`)} ${ERROR(failLabel)}`,
      );
      if (entry.error !== '') {
        console.log(`    ${DIM('\u2192')} ${DIM(short(entry.error.split('\n')[0], 72))}`);
      }
    }
  }
}

function printConvergence(report: CouncilReport): void {
  console.log('');
  console.log(sectionHeader('Convergence'));
  if (report.finalDecision == null) {
    console.log(`  ${DIM('No explicit final decision captured.')}`);
    return;
  }
  const decision = report.finalDecision;
  console.log(label('Decision owner', colorOwner(decision.owner ?? 'unassigned')));
  console.log(label('Confidence', pc.white(decision.confidence ?? 'n/a')));
  console.log(
    label(
      'Next action',
      pc.white(
        report.recommendedNextAction === ''
          ? (decision.nextAction ?? report.recommendedMode)
          : report.recommendedNextAction,
      ),
    ),
  );
  if (decision.reversibleFirstStep != null && decision.reversibleFirstStep !== '') {
    console.log(label('Reversible step', pc.white(short(decision.reversibleFirstStep, 72))));
  }
  const unresolvedAssumptions = Array.isArray(report.assumptions)
    ? report.assumptions.filter((item) => item.status !== 'validated').length
    : 0;
  console.log(label('Open assumptions', pc.white(String(unresolvedAssumptions))));
  const tradeoffLines = formatTradeoffs(decision.tradeoffs, '  - ');
  if (tradeoffLines.length > 0) {
    console.log('');
    console.log(DIM('  Criteria tradeoffs:'));
    for (const line of tradeoffLines) console.log(pc.white(line));
  }
}

function printConsensus(report: CouncilReport): void {
  console.log('');
  console.log(sectionHeader('Consensus'));
  if (report.consensus === '') {
    const failedCount = report.transcript.filter((t) => !t.ok).length;
    console.log(
      failedCount > 0
        ? `  ${WARNING(`No consensus reached (${String(failedCount)} phase(s) failed)`)}`
        : `  ${DIM('(none)')}`,
    );
    return;
  }
  const words = report.consensus.split(/\s+/);
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > 76) {
      console.log(`  ${pc.white(line)}`);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') console.log(`  ${pc.white(line)}`);
}

function printRisks(risks: unknown[]): void {
  if (risks.length === 0) return;
  console.log('');
  console.log(sectionHeader('Risks'));
  for (const risk of risks) {
    const r = risk as Record<string, unknown> | string;
    const text =
      typeof r === 'string'
        ? r
        : ((r['risk'] as string | undefined) ??
          (r['description'] as string | undefined) ??
          JSON.stringify(r));
    console.log(`  ${WARNING('\u26A0')} ${pc.white(short(text, 72))}`);
  }
}

function printDisagreementsAndAttacks(
  disagreements: unknown[],
  assumptionAttacks: Array<{ challenge?: string; assumption?: string }>,
): void {
  if (disagreements.length > 0) {
    console.log('');
    console.log(sectionHeader('Disagreements'));
    for (const item of disagreements) {
      console.log(`  ${WARNING('\u26A0')} ${pc.white(short(item, 72))}`);
    }
  }

  if (assumptionAttacks.length > 0) {
    console.log('');
    console.log(sectionHeader('Assumption Challenges'));
    for (const item of assumptionAttacks) {
      const challenge = cleanText(item.challenge ?? item.assumption);
      if (challenge !== '') console.log(`  ${ACCENT('!')} ${pc.white(short(challenge, 72))}`);
    }
  }
}

function printCouncilQuestions(questions: Array<{ to: string; question: string }>): void {
  if (questions.length === 0) return;
  console.log('');
  console.log(sectionHeader('Questions'));
  for (const q of questions) {
    const to = q.to === '' ? 'human' : q.to;
    console.log(
      `  ${ACCENT('?')} ${DIM('\u2192')} ${colorOwner(to)}${DIM(':')} ${pc.white(short(q.question, 65))}`,
    );
  }
}

function printCouncilDetails(report: CouncilReport): void {
  if (report.tasks.length > 0) {
    console.log('');
    console.log(sectionHeader(`Tasks (${String(report.tasks.length)})`));
    for (const [i, task] of report.tasks.entries()) {
      const owner = task.owner ?? 'unassigned';
      const title = short(task.title ?? task.description ?? '', 55);
      console.log(`  ${DIM(`${String(i + 1)}.`)} ${colorOwner(owner)}  ${pc.white(title)}`);
    }
  }

  printRisks(report.risks);
  printDisagreementsAndAttacks(report.disagreements, report.assumptionAttacks);
  printCouncilQuestions(report.questions);
}

function printCouncilFooter(report: CouncilReport): void {
  console.log('');
  console.log(divider());
  const recColor = report.recommendedMode === 'council' ? WARNING : SUCCESS;
  console.log(label('Recommended', recColor(report.recommendedMode)));
  console.log(
    label(
      'Rationale',
      DIM(
        short(report.recommendationRationale === '' ? 'n/a' : report.recommendationRationale, 120),
      ),
    ),
  );
  let publishedLabel = DIM('no');
  if (report.published?.ok === true && report.published.skipped === true) {
    publishedLabel = DIM('skipped');
  } else if (report.published?.ok === true) {
    publishedLabel = SUCCESS('yes');
  }
  console.log(label('Published', publishedLabel));
  if (report.published?.ok === true && report.published.skipped !== true) {
    console.log('');
    console.log(DIM('  Pull commands:'));
    console.log(DIM('    npm run hydra:next -- agent=claude'));
    console.log(DIM('    npm run hydra:next -- agent=gemini'));
    console.log(DIM('    npm run hydra:next -- agent=codex'));
  }
  if (report.published != null && !report.published.ok) {
    console.log(label('Publish error', ERROR(report.published.error)));
  }
}

function printCouncilSummary(report: CouncilReport, opts: MainOptions): void {
  console.log(sectionHeader('Hydra Council Summary'));
  console.log(label('ID', DIM(report.id)));
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Mode', ACCENT(report.mode)));
  console.log(label('Rounds', pc.white(String(opts.rounds))));
  if (report.startedAt !== '' && report.finishedAt != null && report.finishedAt !== '') {
    const durationMs = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
    if (durationMs > 0) console.log(label('Duration', pc.white(formatElapsed(durationMs))));
  }

  printPhaseHealth(report);
  printConvergence(report);
  printConsensus(report);
  printCouncilDetails(report);
  printCouncilFooter(report);
}

async function resolveSpec(
  prompt: string,
  reportId: string,
  preview: boolean,
  projectRoot: string,
): Promise<{ specContent: string | null; specId?: string }> {
  const classification = classifyPrompt(prompt);
  if (classification.tier !== 'complex' || preview) return { specContent: null };
  try {
    const spec = await generateSpec(prompt, reportId, { cwd: projectRoot });
    if (spec) return { specContent: spec.specContent as string | null, specId: spec.specId };
  } catch {
    /* non-critical */
  }
  return { specContent: null };
}

function resolveCheckpoint(
  promptHash: string,
  prompt: string,
  preview: boolean,
  activeFlow: typeof COUNCIL_FLOW,
  existingSpecContent: string | null,
): {
  transcript: CouncilReport['transcript'];
  startRound: number;
  startStepIdx: number;
  specContent: string | null;
} {
  const empty = {
    transcript: [] as CouncilReport['transcript'],
    startRound: 1,
    startStepIdx: 0,
    specContent: existingSpecContent,
  };
  if (preview) return empty;
  const checkpoint = loadCheckpoint(promptHash, prompt);
  if (
    checkpoint == null ||
    !Array.isArray(checkpoint.transcript) ||
    checkpoint.transcript.length === 0
  )
    return empty;
  const transcript = checkpoint.transcript as CouncilReport['transcript'];
  let specContent = existingSpecContent;
  if (
    checkpoint.specContent != null &&
    checkpoint.specContent !== '' &&
    (specContent == null || specContent === '')
  ) {
    specContent = checkpoint.specContent;
  }
  const last = checkpoint.transcript.at(-1);
  if (last == null) return { transcript, startRound: 1, startStepIdx: 0, specContent };
  let startRound = last.round;
  let startStepIdx = activeFlow.findIndex((s) => s.agent === last.agent && s.phase === last.phase);
  if (startStepIdx >= 0) {
    startStepIdx += 1;
    if (startStepIdx >= activeFlow.length) {
      startStepIdx = 0;
      startRound += 1;
    }
  } else {
    startStepIdx = 0;
  }
  process.stderr.write(
    `  Resuming council from round ${String(startRound)}, step ${String(startStepIdx + 1)} (${String(checkpoint.transcript.length)} phases cached)\n`,
  );
  return { transcript, startRound, startStepIdx, specContent };
}

function buildActiveFlow(agentsFilter: string[] | null): typeof COUNCIL_FLOW {
  return (
    agentsFilter === null
      ? COUNCIL_FLOW
      : COUNCIL_FLOW.filter((step) => agentsFilter.includes(step.agent))
  ).filter((step) => {
    if (!('optional' in step) || step.optional !== true) return true;
    const agentDef = getAgent(step.agent);
    const cliName = agentDef?.cli ?? step.agent;
    return Boolean(agentDef?.enabled) && commandExists(cliName);
  });
}

async function main() {
  const opts = parseMainOptions();
  const report = createReport(opts);

  try {
    const summaryResponse = await request('GET', opts.url, '/summary');
    report.daemonSummary = (summaryResponse as Record<string, unknown>)['summary'] ?? null;
  } catch {
    report.daemonSummary = null;
  }

  const specResult = await resolveSpec(opts.prompt, report.id, opts.preview, config.projectRoot);
  report.specId = specResult.specId;

  const activeFlow = buildActiveFlow(opts.agentsFilter);
  const promptHash = simpleHash(opts.prompt);
  const ckpt = resolveCheckpoint(
    promptHash,
    opts.prompt,
    opts.preview,
    activeFlow,
    specResult.specContent,
  );
  report.transcript = ckpt.transcript;

  const councilMode = loadHydraConfig().routing.councilMode ?? 'sequential';
  if (councilMode === 'adversarial') {
    await runAdversarialCouncil(opts.prompt, report, {
      preview: opts.preview,
      timeoutMs: opts.timeoutMs,
      specContent: ckpt.specContent,
      promptHash,
      agentsFilter: opts.agentsFilter,
      rounds: opts.rounds,
    });
  } else {
    for (let round = 1; round <= opts.rounds; round += 1) {
      for (let stepIdx = 0; stepIdx < activeFlow.length; stepIdx++) {
        if (round < ckpt.startRound || (round === ckpt.startRound && stepIdx < ckpt.startStepIdx))
          continue;
        // eslint-disable-next-line no-await-in-loop
        await executeSequentialPhase(
          activeFlow[stepIdx],
          opts,
          report,
          round,
          stepIdx,
          ckpt.specContent,
          promptHash,
          activeFlow,
        );
      }
    }
  }

  if (!opts.preview) deleteCheckpoint(promptHash);
  Object.assign(report, synthesizeCouncilTranscript(opts.prompt, report.transcript));
  await publishCouncilResults(report, opts);
  report.finishedAt = nowIso();

  if (opts.emit === 'json') {
    console.log(JSON.stringify({ ok: true, report }, null, 2));
    return;
  }

  if (opts.save) {
    ensureDir(RUNS_DIR);
    const outPath = path.join(RUNS_DIR, `${report.id}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Hydra council report saved: ${path.relative(config.projectRoot, outPath)}`);
  }

  printCouncilSummary(report, opts);
}

const isMain = path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Hydra council failed: ${msg}`);
    throw new Error(msg);
  });
}
