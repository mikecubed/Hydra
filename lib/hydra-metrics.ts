/**
 * Hydra Metrics Collection
 *
 * In-memory metrics store with file persistence. Tracks per-agent call counts,
 * durations, estimated tokens, and success rates.
 *
 * Usage (from a consumer module):
 *   import { recordCallStart, recordCallComplete, getMetrics } from './hydra-metrics.ts';
 *   const handle = recordCallStart('claude', 'claude-opus-4-6');
 *   // ... agent call ...
 *   recordCallComplete(handle, result);
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import type { IMetricsRecorder, MetricsCallResult } from './types.ts';

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  callCount: number;
}

interface RealTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

interface HistoryEntry {
  at: string;
  model: string;
  durationMs: number;
  estimatedTokens: number;
  realTokens?: RealTokens | null;
  costUsd?: number | null;
  ok: boolean;
  outputLen?: number;
  outcome?: string;
  error?: string;
}

interface AgentMetrics {
  callsTotal: number;
  callsToday: number;
  callsSuccess: number;
  callsFailed: number;
  estimatedTokensToday: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastCallAt: string | null;
  lastModel: string | null;
  history: HistoryEntry[];
  sessionTokens: SessionUsage;
}

interface MetricsStore {
  startedAt: string;
  agents: Record<string, AgentMetrics>;
  sessionUsage: SessionUsage;
}

interface ActiveHandle {
  agent: string;
  model: string;
  startedAt: number;
  startIso: string;
}

interface CallResult {
  stdout?: string;
  output?: string;
  stderr?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  } | null;
  costUsd?: number | null;
  outcome?: string;
}

interface PercentileResult {
  p50?: number;
  p95?: number;
  p99?: number;
  [key: string]: number | undefined;
}

interface SloThresholds {
  maxP95Ms?: number;
  maxErrorRate?: number;
}

interface SloViolation {
  agent: string;
  metric: string;
  value: number;
  threshold: number;
}

interface FlowStep {
  agent: string;
}

interface TokenWindowResult {
  real: number;
  estimated: number;
  total: number;
  entries: number;
}

interface OutcomeResult {
  count: number;
  totalCost: number;
}

// ── Metrics Event Emitter ───────────────────────────────────────────────────

export const metricsEmitter = new EventEmitter();

const MAX_HISTORY = 20;
const TOKENS_PER_CHAR_ESTIMATE = 0.25; // rough estimate: 4 chars ≈ 1 token

// ── Percentile Calculation ──────────────────────────────────────────────────

function calculatePercentiles(
  values: number[],
  percentiles: number[] = [50, 95, 99],
): PercentileResult {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const result: PercentileResult = {};
  for (const p of percentiles) {
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    result[`p${String(p)}`] = sorted[idx];
  }
  return result;
}

// ── Metrics Store ───────────────────────────────────────────────────────────

let metricsStore: MetricsStore = createEmptyStore();

function createEmptySessionUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    callCount: 0,
  };
}

function createEmptyStore(): MetricsStore {
  return {
    startedAt: new Date().toISOString(),
    agents: {},
    sessionUsage: createEmptySessionUsage(),
  };
}

function ensureAgent(agentName: string): AgentMetrics {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
  if (!metricsStore.agents[agentName]) {
    metricsStore.agents[agentName] = {
      callsTotal: 0,
      callsToday: 0,
      callsSuccess: 0,
      callsFailed: 0,
      estimatedTokensToday: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      lastCallAt: null,
      lastModel: null,
      history: [],
      sessionTokens: createEmptySessionUsage(),
    };
  }
  // Backfill sessionTokens for stores loaded from disk before this field existed
  const agentEntry = metricsStore.agents[agentName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
  if (agentEntry && !agentEntry.sessionTokens) {
    agentEntry.sessionTokens = createEmptySessionUsage();
  }
  return metricsStore.agents[agentName];
}

// ── Recording ───────────────────────────────────────────────────────────────

let handleCounter = 0;
const activeHandles = new Map<string, ActiveHandle>();

/**
 * Record the start of an agent call.
 * @param {string} agentName - gemini, codex, or claude
 * @param {string} [model] - Model ID being used
 * @returns {string} Handle ID for recordCallComplete/Error
 */
function parseCallTokenUsage(result: CallResult): {
  realTokens: RealTokens | null;
  costUsd: number;
} {
  let realTokens: RealTokens | null = null;
  let costUsd = 0;
  if (result.tokenUsage) {
    const tu = result.tokenUsage;
    realTokens = {
      inputTokens: tu.inputTokens ?? 0,
      outputTokens: tu.outputTokens ?? 0,
      cacheCreationTokens: tu.cacheCreationTokens ?? 0,
      cacheReadTokens: tu.cacheReadTokens ?? 0,
      totalTokens: tu.totalTokens ?? (tu.inputTokens ?? 0) + (tu.outputTokens ?? 0),
    };
  }
  if (result.costUsd != null) {
    costUsd = result.costUsd;
  }
  return { realTokens, costUsd };
}

function accumulateTokensIntoSession(
  agent: AgentMetrics,
  realTokens: RealTokens,
  costUsd: number,
): void {
  agent.sessionTokens.inputTokens += realTokens.inputTokens;
  agent.sessionTokens.outputTokens += realTokens.outputTokens;
  agent.sessionTokens.cacheCreationTokens += realTokens.cacheCreationTokens;
  agent.sessionTokens.cacheReadTokens += realTokens.cacheReadTokens;
  agent.sessionTokens.totalTokens += realTokens.totalTokens;
  agent.sessionTokens.costUsd += costUsd;
  agent.sessionTokens.callCount += 1;

  metricsStore.sessionUsage.inputTokens += realTokens.inputTokens;
  metricsStore.sessionUsage.outputTokens += realTokens.outputTokens;
  metricsStore.sessionUsage.cacheCreationTokens += realTokens.cacheCreationTokens;
  metricsStore.sessionUsage.cacheReadTokens += realTokens.cacheReadTokens;
  metricsStore.sessionUsage.totalTokens += realTokens.totalTokens;
  metricsStore.sessionUsage.costUsd += costUsd;
  metricsStore.sessionUsage.callCount += 1;
}

export function recordCallStart(agentName: string, model?: string): string {
  handleCounter += 1;
  const handle = `call_${String(handleCounter)}_${String(Date.now())}`;
  activeHandles.set(handle, {
    agent: agentName,
    model: model ?? 'unknown',
    startedAt: Date.now(),
    startIso: new Date().toISOString(),
  });
  metricsEmitter.emit('call:start', { agent: agentName, model: model ?? 'unknown' });
  return handle;
}

/**
 * Record successful completion of an agent call.
 * @param {string} handle - Handle from recordCallStart
 * @param {object} result - Process result with stdout/stderr
 */
export function recordCallComplete(handle: string, result: CallResult): void {
  const meta = activeHandles.get(handle);
  if (!meta) return;
  activeHandles.delete(handle);

  const durationMs = Date.now() - meta.startedAt;
  const agent = ensureAgent(meta.agent);
  // Accept both field names: shared agent-executor returns 'output', workers return 'stdout'
  const stdout = result.stdout ?? result.output ?? '';
  const stderr = result.stderr ?? '';
  const outputLen = stdout.length + stderr.length;
  const estimatedTokens = Math.round(outputLen * TOKENS_PER_CHAR_ESTIMATE);

  const { realTokens, costUsd } = parseCallTokenUsage(result);

  agent.callsTotal += 1;
  agent.callsToday += 1;
  agent.callsSuccess += 1;
  agent.estimatedTokensToday += estimatedTokens;
  agent.totalDurationMs += durationMs;
  agent.avgDurationMs = Math.round(agent.totalDurationMs / agent.callsTotal);
  agent.lastCallAt = new Date().toISOString();
  agent.lastModel = meta.model;

  // Accumulate real token usage into session counters
  if (realTokens) {
    accumulateTokensIntoSession(agent, realTokens, costUsd);
  }

  agent.history.push({
    at: meta.startIso,
    model: meta.model,
    durationMs,
    estimatedTokens,
    realTokens: realTokens ? { ...realTokens } : null,
    costUsd: costUsd === 0 ? null : costUsd,
    ok: true,
    outputLen,
    outcome: result.outcome ?? 'success',
  });
  if (agent.history.length > MAX_HISTORY) {
    agent.history = agent.history.slice(-MAX_HISTORY);
  }
  metricsEmitter.emit('call:complete', { agent: meta.agent, ok: true });
}

/**
 * Record a failed agent call.
 * @param {string} handle - Handle from recordCallStart
 * @param {Error|string} error - Error info
 */
export function recordCallError(handle: string, error: unknown): void {
  const meta = activeHandles.get(handle);
  if (!meta) return;
  activeHandles.delete(handle);

  const durationMs = Date.now() - meta.startedAt;
  const agent = ensureAgent(meta.agent);

  agent.callsTotal += 1;
  agent.callsToday += 1;
  agent.callsFailed += 1;
  agent.totalDurationMs += durationMs;
  agent.avgDurationMs = Math.round(agent.totalDurationMs / agent.callsTotal);
  agent.lastCallAt = new Date().toISOString();
  agent.lastModel = meta.model;

  agent.history.push({
    at: meta.startIso,
    model: meta.model,
    durationMs,
    estimatedTokens: 0,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    outcome: 'failed',
  });
  if (agent.history.length > MAX_HISTORY) {
    agent.history = agent.history.slice(-MAX_HISTORY);
  }
  metricsEmitter.emit('call:error', {
    agent: meta.agent,
    error: error instanceof Error ? error.message : String(error),
  });
}

// ── Convenience wrapper ─────────────────────────────────────────────────────

/**
 * Convenience wrapper that manages the full recordCallStart → complete/error lifecycle.
 * Use this when the entire async operation fits within a single try/catch.
 * For complex cases (handle passed through helpers, branching on result.ok, etc.),
 * use the individual recordCallStart/Complete/Error functions directly.
 */
export async function recordExecution<T extends MetricsCallResult>(
  agentName: string,
  model: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = recordCallStart(agentName, model);
  try {
    const result = await fn();
    recordCallComplete(handle, result as unknown as CallResult);
    return result;
  } catch (err: unknown) {
    recordCallError(handle, err);
    throw err;
  }
}

// ── Querying ────────────────────────────────────────────────────────────────

/**
 * Get the full metrics store.
 */
export function getMetrics(): MetricsStore {
  return { ...metricsStore };
}

/**
 * Get metrics for a specific agent, including latency percentiles.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function getAgentMetrics(agentName: string) {
  const agent = metricsStore.agents[agentName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
  if (!agent) return null;

  const durations = agent.history.filter((h) => h.ok).map((h) => h.durationMs);
  const latency = {
    avg: agent.avgDurationMs,
    ...calculatePercentiles(durations),
  };

  return { ...agent, latency };
}

/**
 * Get a summary suitable for dashboard display.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function getMetricsSummary() {
  const agents: Record<string, unknown> = {};
  let totalCalls = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const [name, data] of Object.entries(metricsStore.agents)) {
    const durations = data.history.filter((h) => h.ok).map((h) => h.durationMs);
    agents[name] = {
      callsToday: data.callsToday,
      callsSuccess: data.callsSuccess,
      callsFailed: data.callsFailed,
      estimatedTokensToday: data.estimatedTokensToday,
      avgDurationMs: data.avgDurationMs,
      latency: { avg: data.avgDurationMs, ...calculatePercentiles(durations) },
      lastModel: data.lastModel,
      lastCallAt: data.lastCallAt,
      successRate:
        data.callsTotal > 0 ? Math.round((data.callsSuccess / data.callsTotal) * 100) : 100,
      sessionTokens: data.sessionTokens,
    };
    totalCalls += data.callsToday;
    totalTokens += data.estimatedTokensToday;
    totalDurationMs += data.totalDurationMs;
  }

  const uptimeSec = Math.floor((Date.now() - new Date(metricsStore.startedAt).getTime()) / 1000);

  return {
    startedAt: metricsStore.startedAt,
    uptimeSec,
    totalCalls,
    totalTokens,
    totalDurationMs,
    agents,
    sessionUsage: metricsStore.sessionUsage,
  };
}

/**
 * Get session-level real token usage (accumulated from Claude JSON output).
 */
export function getSessionUsage(): SessionUsage {
  return metricsStore.sessionUsage;
}

/**
 * Sum tokens consumed by an agent within a recent time window.
 * Uses realTokens.totalTokens when available, otherwise estimatedTokens.
 * @param {string} agentName - Agent name (or null for all agents)
 * @param {number} windowMs - Time window in milliseconds
 * @returns {{ real: number, estimated: number, total: number, entries: number }}
 */
export function getRecentTokens(
  agentName: string | null | undefined,
  windowMs: number,
): TokenWindowResult {
  const cutoff = Date.now() - windowMs;
  let real = 0;
  let estimated = 0;
  let entries = 0;

  const agentNames =
    agentName != null && agentName !== '' ? [agentName] : Object.keys(metricsStore.agents);
  for (const name of agentNames) {
    const agent = metricsStore.agents[name];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
    if (!agent?.history) continue;
    for (const entry of agent.history) {
      if (!entry.ok) continue;
      const entryTime = new Date(entry.at).getTime();
      if (entryTime < cutoff) continue;
      entries++;
      if (entry.realTokens) {
        real += entry.realTokens.totalTokens;
      } else {
        estimated += entry.estimatedTokens;
      }
    }
  }

  return { real, estimated, total: real + estimated, entries };
}

/**
 * Aggregate cost by outcome for an agent (or all agents).
 * @param {string} [agentName] - Agent name, or null/undefined for all
 * @returns {Object<string, {count: number, totalCost: number}>}
 */
export function getCostByOutcome(agentName?: string | null): Record<string, OutcomeResult> {
  const result: Record<string, OutcomeResult> = {};
  const agentNames =
    agentName != null && agentName !== '' ? [agentName] : Object.keys(metricsStore.agents);

  for (const name of agentNames) {
    const agent = metricsStore.agents[name];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
    if (!agent?.history) continue;
    for (const entry of agent.history) {
      const outcome = entry.outcome ?? (entry.ok ? 'success' : 'failed');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
      if (!result[outcome]) result[outcome] = { count: 0, totalCost: 0 };
      result[outcome].count += 1;
      result[outcome].totalCost += entry.costUsd ?? 0;
    }
  }
  return result;
}

/**
 * Check per-agent SLOs against current metrics.
 * @param {object} sloConfig - e.g. { claude: { maxP95Ms: 180000, maxErrorRate: 0.10 }, ... }
 * @returns {Array<{agent: string, metric: string, value: number, threshold: number}>}
 */
export function checkSLOs(
  sloConfig: Record<string, SloThresholds> | null | undefined,
): SloViolation[] {
  if (!sloConfig) return [];
  const violations: SloViolation[] = [];

  for (const [agentName, thresholds] of Object.entries(sloConfig)) {
    const agent = metricsStore.agents[agentName];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
    if (!agent) continue;

    // Latency SLO
    if (thresholds.maxP95Ms != null && thresholds.maxP95Ms !== 0) {
      const durations = agent.history.filter((h) => h.ok).map((h) => h.durationMs);
      const pcts = calculatePercentiles(durations);
      if (pcts.p95 != null && pcts.p95 > thresholds.maxP95Ms) {
        violations.push({
          agent: agentName,
          metric: 'p95_latency',
          value: pcts.p95,
          threshold: thresholds.maxP95Ms,
        });
      }
    }

    // Error rate SLO
    if (thresholds.maxErrorRate != null && agent.callsTotal > 0) {
      const errorRate = agent.callsFailed / agent.callsTotal;
      if (errorRate > thresholds.maxErrorRate) {
        violations.push({
          agent: agentName,
          metric: 'error_rate',
          value: Math.round(errorRate * 1000) / 1000,
          threshold: thresholds.maxErrorRate,
        });
      }
    }
  }

  return violations;
}

// ── ETA Estimation ──────────────────────────────────────────────────────────

// Realistic fallback durations (ms) per agent when no metrics history exists.
// Based on typical cold-start times for each agent CLI.
const DEFAULT_AGENT_DURATION_MS = { gemini: 90_000, codex: 180_000, claude: 120_000 };

/**
 * Estimate total duration (ms) for a sequence of agent calls.
 * Uses historical avgDurationMs when available, otherwise falls back to defaults.
 * @param {Array<{agent: string}>} flow - Ordered list of agent steps
 * @param {number} [rounds=1] - Number of rounds through the flow
 * @returns {number} Estimated total duration in ms
 */
export function estimateFlowDuration(flow: FlowStep[], rounds = 1): number {
  let total = 0;
  for (const step of flow) {
    const data = metricsStore.agents[step.agent];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const avg = data?.avgDurationMs ?? 0;
    total +=
      avg > 0
        ? avg
        : ((DEFAULT_AGENT_DURATION_MS as Record<string, number>)[step.agent] ?? 120_000);
  }
  return total * rounds;
}

// ── Persistence ─────────────────────────────────────────────────────────────

const METRICS_FILENAME = 'hydra-metrics.json';

/**
 * Save metrics to a JSON file in the given directory.
 */
export function persistMetrics(coordDir: string): void {
  if (coordDir === '') return;
  try {
    if (!fs.existsSync(coordDir)) {
      fs.mkdirSync(coordDir, { recursive: true });
    }
    const filePath = path.join(coordDir, METRICS_FILENAME);
    fs.writeFileSync(filePath, `${JSON.stringify(metricsStore, null, 2)}\n`, 'utf8');
  } catch {
    // Non-critical — skip silently
  }
}

/**
 * Load previously persisted metrics.
 */
export function loadPersistedMetrics(coordDir: string): void {
  if (coordDir === '') return;
  try {
    const filePath = path.join(coordDir, METRICS_FILENAME);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse result
    const loaded = JSON.parse(raw);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unsafe-member-access -- dynamic value
    if (loaded && typeof loaded === 'object' && loaded.agents) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- loaded from disk
      metricsStore = loaded;
      // Backfill startedAt if missing or invalid (older/corrupt files)
      if (typeof metricsStore.startedAt !== 'string') {
        metricsStore.startedAt = new Date().toISOString();
      }
      // Backfill sessionUsage if loaded from older format
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
      if (!metricsStore.sessionUsage) {
        metricsStore.sessionUsage = createEmptySessionUsage();
      }
      // Reset today counters if date changed
      const today = new Date().toISOString().slice(0, 10);
      const startDate = metricsStore.startedAt.slice(0, 10);
      if (startDate !== today) {
        for (const agent of Object.values(metricsStore.agents)) {
          agent.callsToday = 0;
          agent.estimatedTokensToday = 0;
          agent.sessionTokens = createEmptySessionUsage();
        }
        metricsStore.sessionUsage = createEmptySessionUsage();
        metricsStore.startedAt = new Date().toISOString();
      }
    }
  } catch {
    // Non-critical — start fresh
  }
}

/**
 * Reset all metrics.
 */
export function resetMetrics(): void {
  metricsStore = createEmptyStore();
}

// ── IMetricsRecorder-typed export ────────────────────────────────────────────

/**
 * Injectable object satisfying the IMetricsRecorder interface contract.
 * Consumers can depend on IMetricsRecorder for testability and DI.
 */
export const metricsRecorder: IMetricsRecorder = {
  recordCallStart,
  recordCallComplete,
  recordCallError,
  recordExecution,
};
