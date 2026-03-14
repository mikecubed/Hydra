/**
 * Hydra Usage Monitor (Standalone)
 *
 * Reads Claude Code's stats-cache.json to track token consumption,
 * provides usage level assessments, and suggests contingency actions
 * when approaching rate limits.
 *
 * Works standalone (no daemon required):
 *   node lib/hydra-usage.mjs
 *
 * Programmatic:
 *   import { checkUsage } from './hydra-usage.ts';
 *   const result = checkUsage();
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHydraConfig, resolveProject } from './hydra-config.ts';
import { setActiveModel, AGENT_NAMES, getModelSummary, getAgent } from './hydra-agents.ts';
import { getMetricsSummary, getRecentTokens } from './hydra-metrics.ts';
import pc from 'picocolors';
import { isTruecolor } from './hydra-ui.ts';
import { exit } from './hydra-process.ts';

// ── Interfaces ──────────────────────────────────────────────────────────────

interface DailyModelEntry {
  date: string;
  tokensByModel: Record<string, number>;
}

interface DailyActivityEntry {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface StatsJsonData {
  dailyModelTokens?: DailyModelEntry[];
  dailyActivity?: DailyActivityEntry[];
  modelUsage?: Record<string, unknown>;
  version?: string;
  startedAt?: string;
  agents?: Record<string, { estimatedTokensToday?: number }>;
}

interface ParsedStatsCache {
  found: boolean;
  error?: string;
  today?: string;
  tokensByModel?: Record<string, number>;
  totalTokensToday?: number;
  estimatedFromActivity?: number;
  stale?: boolean;
  weeklyTokensByModel?: Record<string, number>;
  totalTokensWeekly?: number;
  weeklyDayCount?: number;
  activity?: { messageCount: number; sessionCount: number; toolCallCount: number } | null;
  modelUsage?: Record<string, unknown>;
  recentDays?: number;
  version?: string;
}

interface TrackedModel {
  model: string;
  used: number;
  budget: number;
  percent: number;
}

interface AgentWindowEntry {
  agent: string;
  level: string;
  percent: number;
  windowTokens: number;
  realTokens: number;
  estimatedTokens: number;
  windowBudget: number | null;
  windowHours: number;
  model: string | null;
  entries: number;
  hasData: boolean;
}

interface AgentUsageEntry {
  agent: string;
  level: string;
  percent: number;
  todayTokens: number;
  used: number;
  budget: number | null;
  remaining: number | null;
  model: string | null;
  activeModel: string | null;
  source: string;
  tracked: boolean;
  confidence: string;
  resetAt: string | null;
  resetInMs: number | null;
  modelBreakdown: Record<string, number>;
}

interface AgentWeeklyEntry {
  agent: string;
  level: string;
  percent: number;
  weeklyTokens: number;
  weeklyBudget: number | null;
  model: string | null;
  tracked: boolean;
  modelBreakdown: Record<string, number>;
  daysCovered: number;
}

interface WeeklyResult {
  ok: boolean;
  level: string;
  percent: number;
  agents: Record<string, AgentWeeklyEntry>;
  tightest: AgentWeeklyEntry | null;
  totalTokens: number;
  daysCovered: number;
}

interface WindowResult {
  ok: boolean;
  level: string;
  percent: number;
  windowHours: number;
  agents: Record<string, AgentWindowEntry>;
  tightest: AgentWindowEntry | null;
}

export interface ContingencyOption {
  id: string;
  label: string;
  description: string;
  action: string;
  args: Record<string, string>;
}

export interface UsageSummary {
  ok: boolean;
  level: string;
  percent: number;
  todayTokens: number;
  model: string | null;
  budget: number;
  used: number;
  remaining: number | null;
  resetAt: string | null;
  resetInMs: number | null;
  message: string;
  confidence: string;
  scope: string;
  accountUsageNote: string;
  stats: ParsedStatsCache | null;
  agents: Record<string, AgentUsageEntry>;
  window: WindowResult;
  weekly: WeeklyResult;
}

type MetricsSummaryType = {
  sessionUsage?: { totalTokens?: number; callCount?: number };
  agents?: Record<
    string,
    { sessionTokens?: { totalTokens?: number }; estimatedTokensToday?: number }
  >;
};

type ModelSummaryType = Record<string, { active?: string | null }>;

// ── Date Helpers ────────────────────────────────────────────────────────────

/**
 * Get today's date as YYYY-MM-DD in local timezone.
 * Claude Code's stats-cache.json uses local dates, not UTC.
 */
function getLocalDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${d}`;
}

// ── Stats Cache Location ────────────────────────────────────────────────────

/**
 * Find Claude Code's stats-cache.json.
 * Checks config override first, then standard location.
 */
export function findStatsCache(): string | null {
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const configPath = cfg.usage?.claudeStatsPath;

  if (configPath != null && configPath !== 'auto') {
    if (fs.existsSync(configPath)) return configPath;
  }

  // Standard location: ~/.claude/stats-cache.json
  const homeDir = os.homedir();
  const standard = path.join(homeDir, '.claude', 'stats-cache.json');
  if (fs.existsSync(standard)) return standard;

  // Windows alternative
  const appData = process.env['APPDATA'];
  if (appData != null) {
    const winPath = path.join(appData, '.claude', 'stats-cache.json');
    if (fs.existsSync(winPath)) return winPath;
  }

  return null;
}

// ── Stats Parsing ───────────────────────────────────────────────────────────

function resolveDailyEntry(
  data: StatsJsonData,
  today: string,
): { entry: DailyModelEntry | undefined; stale: boolean } {
  const entry = Array.isArray(data.dailyModelTokens)
    ? data.dailyModelTokens.find((d) => d.date === today)
    : undefined;
  if (entry != null) return { entry, stale: false };
  if (!Array.isArray(data.dailyModelTokens) || data.dailyModelTokens.length === 0) {
    return { entry: undefined, stale: false };
  }
  const latest = data.dailyModelTokens.at(-1);
  if (latest == null) return { entry: undefined, stale: false };
  const diffMs =
    new Date(`${today}T00:00:00`).getTime() - new Date(`${latest.date}T00:00:00`).getTime();
  if (diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000) return { entry: latest, stale: true };
  return { entry: undefined, stale: false };
}

function aggregateWeeklyTokens(
  data: StatsJsonData,
  weekAgoStr: string,
): { tokensByModel: Record<string, number>; dayCount: number } {
  const tokensByModel: Record<string, number> = {};
  let dayCount = 0;
  if (!Array.isArray(data.dailyModelTokens)) return { tokensByModel, dayCount };
  for (const entry of data.dailyModelTokens) {
    if (entry.date <= weekAgoStr) continue;
    dayCount++;
    for (const [model, tokens] of Object.entries(entry.tokensByModel)) {
      tokensByModel[model] = (tokensByModel[model] ?? 0) + tokens;
    }
  }
  return { tokensByModel, dayCount };
}

/**
 * Parse stats-cache.json and extract today's usage data.
 * @param {string} filePath - Path to stats-cache.json
 * @returns {ParsedStatsCache} Parsed usage data
 */
export function parseStatsCache(filePath: string): ParsedStatsCache {
  if (filePath === '' || !fs.existsSync(filePath)) {
    return { found: false, error: 'Stats cache not found' };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as StatsJsonData;
    const today = getLocalDateString();

    const { entry: dailyTokens, stale } = resolveDailyEntry(data, today);
    const tokensByModel = dailyTokens?.tokensByModel ?? {};
    const totalTokensToday = Object.values(tokensByModel).reduce((sum, n) => sum + n, 0);

    const todayActivity: DailyActivityEntry | undefined = Array.isArray(data.dailyActivity)
      ? data.dailyActivity.find((d) => d.date === today)
      : undefined;
    const estimatedFromActivity =
      todayActivity != null && totalTokensToday === 0 ? todayActivity.messageCount * 150 : 0;

    const modelUsage = data.modelUsage ?? {};
    const recentDays = Array.isArray(data.dailyModelTokens) ? data.dailyModelTokens.slice(-7) : [];

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const { tokensByModel: weeklyTokensByModel, dayCount: weeklyDayCount } = aggregateWeeklyTokens(
      data,
      getLocalDateString(weekAgo),
    );
    const totalTokensWeekly = Object.values(weeklyTokensByModel).reduce((s, n) => s + n, 0);

    return {
      found: true,
      today,
      tokensByModel,
      totalTokensToday: totalTokensToday === 0 ? estimatedFromActivity : totalTokensToday,
      estimatedFromActivity,
      stale,
      weeklyTokensByModel,
      totalTokensWeekly,
      weeklyDayCount,
      activity:
        todayActivity == null
          ? null
          : {
              messageCount: todayActivity.messageCount,
              sessionCount: todayActivity.sessionCount,
              toolCallCount: todayActivity.toolCallCount,
            },
      modelUsage,
      recentDays: recentDays.length,
      version: data.version ?? 'unknown',
    };
  } catch (err: unknown) {
    return { found: false, error: `Failed to parse stats cache: ${(err as Error).message}` };
  }
}

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumObjectValues(obj: unknown): number {
  if (obj == null || typeof obj !== 'object') return 0;
  return Object.values(obj as Record<string, unknown>).reduce(
    (sum: number, value: unknown) => sum + safeNumber(value),
    0,
  );
}

function roundPercent(value: unknown): number {
  return Math.round(safeNumber(value) * 10) / 10;
}

function levelFromPercent(percent: number, warningPct: number, criticalPct: number): string {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= criticalPct) return 'critical';
  if (percent >= warningPct) return 'warning';
  return 'normal';
}

function getDailyResetInfo(): { resetAt: string; resetInMs: number } {
  const now = new Date();
  const reset = new Date(now);
  reset.setHours(24, 0, 0, 0);
  const resetInMs = Math.max(0, reset.getTime() - now.getTime());
  return { resetAt: reset.toISOString(), resetInMs };
}

function deriveConfidence(stats: ParsedStatsCache): string {
  const hoursSinceStart = stats.activity == null ? 0 : Math.min(stats.activity.sessionCount, 24);
  if (hoursSinceStart >= 4) return 'high';
  if (hoursSinceStart >= 1) return 'medium';
  return 'low';
}

function modelBelongsToAgent(modelId: string, agent: string): boolean {
  return getAgent(agent)?.modelBelongsTo(modelId) ?? false;
}

function pickHighestTrackedModel(
  tokensByModel: Record<string, number>,
  budgets: Record<string, number>,
): TrackedModel | null {
  let best: TrackedModel | null = null;
  for (const [modelId, usedRaw] of Object.entries(tokensByModel)) {
    const budget = safeNumber(budgets[modelId]);
    if (budget <= 0) continue;
    const used = safeNumber(usedRaw);
    const percent = budget > 0 ? (used / budget) * 100 : 0;
    if (best == null || percent > best.percent) {
      best = { model: modelId, used, budget, percent };
    }
  }
  return best;
}

function resolveTrackedModel(
  activeModel: string | null,
  activeBudget: number,
  agentModelTokens: Record<string, number>,
  agentUsedTokens: number,
  budgets: Record<string, number>,
): TrackedModel | null {
  if (activeModel === null || activeBudget <= 0) {
    return pickHighestTrackedModel(agentModelTokens, budgets);
  }
  const trackedUsed =
    safeNumber(agentModelTokens[activeModel]) === 0
      ? agentUsedTokens
      : safeNumber(agentModelTokens[activeModel]);
  return {
    model: activeModel,
    budget: activeBudget,
    used: trackedUsed,
    percent: (trackedUsed / activeBudget) * 100,
  };
}

function deriveAgentConfidence(
  directUsed: number,
  estimatedUsed: number,
  hasRealTokens: boolean,
  defaultConfidence: string,
): string {
  if (directUsed > 0) return defaultConfidence;
  if (estimatedUsed > 0) return hasRealTokens ? 'medium' : 'low';
  return 'none';
}

function deriveSourceLabel(
  directUsed: number,
  hasRealTokens: boolean,
  estimatedUsed: number,
): string {
  if (directUsed > 0) return 'stats-cache';
  if (hasRealTokens) return 'hydra-metrics-real';
  if (estimatedUsed > 0) return 'hydra-metrics-estimate';
  return 'none';
}

function buildAgentWindowEntry(
  agent: string,
  recent: { total: number; real: number; estimated: number; entries: number },
  activeModel: string | null,
  windowBudgets: Record<string, number>,
  windowHours: number,
  warningPct: number,
  criticalPct: number,
): AgentWindowEntry {
  const windowBudget = activeModel == null ? 0 : safeNumber(windowBudgets[activeModel]);
  const used = recent.total;
  const percent = windowBudget > 0 ? (used / windowBudget) * 100 : 0;
  const level = windowBudget > 0 ? levelFromPercent(percent, warningPct, criticalPct) : 'unknown';
  return {
    agent,
    level,
    percent: roundPercent(percent),
    windowTokens: used,
    realTokens: recent.real,
    estimatedTokens: recent.estimated,
    windowBudget: windowBudget > 0 ? windowBudget : null,
    windowHours,
    model: activeModel,
    entries: recent.entries,
    hasData: recent.entries > 0,
  };
}

function readPersistedEstimatedTokens(): Record<string, number> {
  const out = Object.fromEntries(AGENT_NAMES.map((agent) => [agent, 0]));
  try {
    const project = resolveProject({ skipValidation: true });
    const metricsPath = path.join(project.coordDir, 'hydra-metrics.json');
    if (!fs.existsSync(metricsPath)) return out;

    const raw = fs.readFileSync(metricsPath, 'utf8');
    const data = JSON.parse(raw) as {
      startedAt?: string;
      agents?: Record<string, { estimatedTokensToday?: number }>;
    };
    const today = getLocalDateString();
    // startedAt is stored in UTC ISO format — convert to local date for comparison
    const started = data.startedAt == null ? '' : getLocalDateString(new Date(data.startedAt));
    if (started !== today) return out;

    for (const agent of AGENT_NAMES) {
      out[agent] = safeNumber(data.agents?.[agent]?.estimatedTokensToday);
    }
  } catch {
    // best-effort fallback only
  }
  return out;
}

function collectEstimatedTokensByAgent(): Record<string, number> {
  const out = readPersistedEstimatedTokens();
  try {
    const metrics = getMetricsSummary() as MetricsSummaryType;
    for (const agent of AGENT_NAMES) {
      // Prefer real session tokens (from Claude JSON output) when available
      const realTokens = safeNumber(metrics.agents?.[agent]?.sessionTokens?.totalTokens);
      if (realTokens > 0) {
        out[agent] = realTokens;
        continue;
      }
      const live = safeNumber(metrics.agents?.[agent]?.estimatedTokensToday);
      out[agent] = Math.max(out[agent] ?? 0, live);
    }
  } catch {
    // best-effort fallback only
  }
  return out;
}

// ── Sliding Window Budget ────────────────────────────────────────────────────

/**
 * Check token usage within a sliding time window.
 * Compares recent consumption against per-model window budgets.
 * @param {object} [options]
 * @param {number} [options.windowHours] - Override window size (default: from config)
 * @returns {WindowResult} Window budget assessment
 */
export function checkWindowBudget(options: { windowHours?: number } = {}): WindowResult {
  const cfg = loadHydraConfig();
  const windowHours = options.windowHours ?? cfg.usage.windowHours ?? 5;
  const windowBudgets = cfg.usage.windowTokenBudget ?? {};
  const warningPct = cfg.usage.warningThresholdPercent ?? 80;
  const criticalPct = cfg.usage.criticalThresholdPercent ?? 90;
  const windowMs = windowHours * 60 * 60 * 1000;

  const modelSummary = getModelSummary() as ModelSummaryType;
  const agentWindow: Record<string, AgentWindowEntry> = {};

  for (const agent of AGENT_NAMES) {
    const recent = getRecentTokens(agent, windowMs);
    const activeModel = modelSummary[agent].active ?? null;
    agentWindow[agent] = buildAgentWindowEntry(
      agent,
      recent,
      activeModel,
      windowBudgets,
      windowHours,
      warningPct,
      criticalPct,
    );
  }

  const tracked = Object.values(agentWindow).filter((a) => (a.windowBudget ?? 0) > 0);
  const highest = tracked.reduce<AgentWindowEntry | null>(
    (best, a) => (best == null || a.percent > best.percent ? a : best),
    null,
  );

  return {
    ok: highest?.level !== 'critical',
    level: highest?.level ?? 'unknown',
    percent: highest?.percent ?? 0,
    windowHours,
    agents: agentWindow,
    tightest: highest,
  };
}

// ── Usage Check ─────────────────────────────────────────────────────────────

interface AgentDailyConfig {
  warningPct: number;
  criticalPct: number;
  budgets: Record<string, number>;
  resetInfo: { resetAt: string; resetInMs: number };
  defaultConfidence: string;
}

function filterModelTokensByAgent(
  agent: string,
  tokensByModel: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [modelId, tokenCount] of Object.entries(tokensByModel)) {
    if (modelBelongsToAgent(modelId, agent)) {
      result[modelId] = safeNumber(tokenCount);
    }
  }
  return result;
}

function getAgentRealTokens(metricsSummary: MetricsSummaryType, agent: string): number {
  return safeNumber(metricsSummary.agents?.[agent]?.sessionTokens?.totalTokens);
}

function buildAgentUsageEntry(
  agent: string,
  config: AgentDailyConfig,
  tokensByModel: Record<string, number>,
  modelSummary: ModelSummaryType,
  estimatedTokensByAgent: Record<string, number>,
  metricsSummary: MetricsSummaryType,
): AgentUsageEntry {
  const { warningPct, criticalPct, budgets, resetInfo, defaultConfidence } = config;
  const activeModel = modelSummary[agent].active ?? null;
  const agentModelTokens = filterModelTokensByAgent(agent, tokensByModel);

  const directUsed = sumObjectValues(agentModelTokens);
  const estimatedUsed = safeNumber(estimatedTokensByAgent[agent]);
  const agentUsedTokens = directUsed > 0 ? directUsed : estimatedUsed;
  const activeBudget = activeModel == null ? 0 : safeNumber(budgets[activeModel]);
  const tracked = resolveTrackedModel(
    activeModel,
    activeBudget,
    agentModelTokens,
    agentUsedTokens,
    budgets,
  );
  const hasRealTokens = getAgentRealTokens(metricsSummary, agent) > 0;
  const confidence = deriveAgentConfidence(
    directUsed,
    estimatedUsed,
    hasRealTokens,
    defaultConfidence,
  );
  const sourceLabel = deriveSourceLabel(directUsed, hasRealTokens, estimatedUsed);

  if (tracked == null || tracked.budget <= 0) {
    return {
      agent,
      level: 'unknown',
      percent: 0,
      todayTokens: agentUsedTokens,
      used: agentUsedTokens,
      budget: null,
      remaining: null,
      model: activeModel,
      activeModel,
      source: sourceLabel,
      tracked: false,
      confidence,
      resetAt: null,
      resetInMs: null,
      modelBreakdown: agentModelTokens,
    };
  }

  const percent = roundPercent(tracked.percent);
  return {
    agent,
    level: levelFromPercent(percent, warningPct, criticalPct),
    percent,
    todayTokens: agentUsedTokens,
    used: tracked.used,
    budget: tracked.budget,
    remaining: Math.max(0, tracked.budget - tracked.used),
    model: tracked.model,
    activeModel,
    source: sourceLabel,
    tracked: true,
    confidence,
    resetAt: resetInfo.resetAt,
    resetInMs: resetInfo.resetInMs,
    modelBreakdown: agentModelTokens,
  };
}

function buildNoStatsMessage(
  metricsSummary: MetricsSummaryType,
  stats: ParsedStatsCache,
  totalTokens: number,
): { message: string; confidence: string } {
  const sessionTotal = safeNumber(metricsSummary.sessionUsage?.totalTokens);
  if (sessionTotal > 0) {
    const calls = safeNumber(metricsSummary.sessionUsage?.callCount);
    return {
      message: `Session: ${formatTokens(sessionTotal)} tokens from ${String(calls)} tracked calls (stats-cache unavailable)`,
      confidence: 'medium',
    };
  }
  if (totalTokens > 0) {
    return {
      message: `Session: ~${formatTokens(totalTokens)} estimated tokens (stats-cache unavailable)`,
      confidence: 'low',
    };
  }
  return {
    message: stats.error ?? 'Claude stats cache not found. Usage tracking unavailable.',
    confidence: 'none',
  };
}

interface DailySummary {
  level: string;
  percent: number;
  message: string;
  confidence: string;
  model: string | null;
  budget: number;
  used: number;
  remaining: number | null;
  resetAt: string | null;
  resetInMs: number | null;
}

function buildDailySummary(
  highest: AgentUsageEntry | null,
  stats: ParsedStatsCache,
  metricsSummary: MetricsSummaryType,
  totalTokens: number,
): DailySummary {
  const base: DailySummary = {
    level: 'unknown',
    percent: 0,
    message: '',
    confidence: 'none',
    model: null,
    budget: 0,
    used: 0,
    remaining: null,
    resetAt: null,
    resetInMs: null,
  };

  if (highest != null) {
    base.level = highest.level;
    base.percent = highest.percent;
    base.confidence = highest.confidence;
    base.model = highest.model;
    base.budget = highest.budget ?? 0;
    base.used = highest.used;
    base.remaining = highest.remaining;
    base.resetAt = highest.resetAt;
    base.resetInMs = highest.resetInMs;
    base.message = `${highest.agent} usage ${highest.percent.toFixed(1)}% — highest tracked load`;
  } else if (stats.found) {
    base.message = 'Usage data found, but no token budget is configured for active models.';
  } else {
    const { message, confidence } = buildNoStatsMessage(metricsSummary, stats, totalTokens);
    base.message = message;
    base.confidence = confidence;
  }

  if (stats.stale === true && base.message !== '') {
    base.message += ' (token data from previous day — current day not yet computed)';
  } else if ((stats.estimatedFromActivity ?? 0) > 0 && highest == null) {
    base.message = `Estimated ~${formatTokens(stats.estimatedFromActivity ?? 0)} tokens from activity (${String(stats.activity?.messageCount ?? 0)} messages today)`;
  }

  return base;
}

function buildAgentWeeklyEntry(
  agent: string,
  weeklyTokensByModel: Record<string, number>,
  weeklyBudgets: Record<string, number>,
  activeModel: string | null,
  warningPct: number,
  criticalPct: number,
  weeklyDayCount: number,
): AgentWeeklyEntry {
  const agentWeeklyTokens: Record<string, number> = {};
  for (const [modelId, wUsed] of Object.entries(weeklyTokensByModel)) {
    if (modelBelongsToAgent(modelId, agent)) {
      agentWeeklyTokens[modelId] = safeNumber(wUsed);
    }
  }
  const weeklyUsed = sumObjectValues(agentWeeklyTokens);
  let weeklyBudget = activeModel == null ? 0 : safeNumber(weeklyBudgets[activeModel]);
  let budgetModel = activeModel;
  if (weeklyBudget <= 0) {
    const best = pickHighestTrackedModel(agentWeeklyTokens, weeklyBudgets);
    if (best != null) {
      weeklyBudget = best.budget;
      budgetModel = best.model;
    }
  }
  const weeklyPercent = weeklyBudget > 0 ? (weeklyUsed / weeklyBudget) * 100 : 0;
  const weeklyLevel =
    weeklyBudget > 0 ? levelFromPercent(weeklyPercent, warningPct, criticalPct) : 'unknown';
  return {
    agent,
    level: weeklyLevel,
    percent: roundPercent(weeklyPercent),
    weeklyTokens: weeklyUsed,
    weeklyBudget: weeklyBudget > 0 ? weeklyBudget : null,
    model: budgetModel,
    tracked: weeklyBudget > 0,
    modelBreakdown: agentWeeklyTokens,
    daysCovered: weeklyDayCount,
  };
}

function buildWeeklyResult(
  weeklyBudgets: Record<string, number>,
  stats: ParsedStatsCache,
  modelSummary: ModelSummaryType,
  warningPct: number,
  criticalPct: number,
): WeeklyResult {
  const weeklyTokensByModel: Record<string, number> = stats.found
    ? (stats.weeklyTokensByModel ?? {})
    : {};
  const weeklyDayCount = stats.weeklyDayCount ?? 0;
  const agentWeekly: Record<string, AgentWeeklyEntry> = {};

  for (const agent of AGENT_NAMES) {
    const activeModel = modelSummary[agent].active ?? null;
    agentWeekly[agent] = buildAgentWeeklyEntry(
      agent,
      weeklyTokensByModel,
      weeklyBudgets,
      activeModel,
      warningPct,
      criticalPct,
      weeklyDayCount,
    );
  }

  const trackedWeekly = Object.values(agentWeekly).filter((a) => a.tracked);
  const highestWeekly = trackedWeekly.reduce<AgentWeeklyEntry | null>(
    (best, a) => (best == null || a.percent > best.percent ? a : best),
    null,
  );

  return {
    ok: highestWeekly?.level !== 'critical',
    level: highestWeekly?.level ?? 'unknown',
    percent: highestWeekly?.percent ?? 0,
    agents: agentWeekly,
    tightest: highestWeekly,
    totalTokens: safeNumber(stats.totalTokensWeekly),
    daysCovered: weeklyDayCount,
  };
}

function escalateLevel(
  current: { level: string; percent: number; message: string },
  highestWeekly: AgentWeeklyEntry | null,
  window: WindowResult,
): { level: string; percent: number; message: string } {
  const LEVEL_ORDER: Record<string, number> = { normal: 0, warning: 1, critical: 2, unknown: -1 };
  let { level, percent, message } = current;

  if (highestWeekly != null && highestWeekly.level !== 'unknown') {
    const weeklyOrder = LEVEL_ORDER[highestWeekly.level] ?? -1;
    if (weeklyOrder > (LEVEL_ORDER[level] ?? -1)) {
      level = highestWeekly.level;
      percent = highestWeekly.percent;
      message = `${highestWeekly.agent} weekly usage ${highestWeekly.percent.toFixed(1)}% — ${message}`;
    }
  }

  if (window.tightest != null && window.tightest.level !== 'unknown') {
    const windowOrder = LEVEL_ORDER[window.tightest.level] ?? -1;
    if (windowOrder > (LEVEL_ORDER[level] ?? -1)) {
      level = window.tightest.level;
      percent = window.tightest.percent;
      message = `${window.tightest.agent} window usage ${window.tightest.percent.toFixed(1)}% (${String(window.windowHours)}h sliding) — ${message}`;
    }
  }

  return { level, percent, message };
}

/**
 * Check current usage level against configured thresholds.
 * @param {object} [options]
 * @param {string} [options.statsPath] - Override stats cache path
 * @returns {UsageSummary} Usage assessment
 */
export function checkUsage(options: { statsPath?: string } = {}): UsageSummary {
  const cfg = loadHydraConfig();
  const warningPct = cfg.usage.warningThresholdPercent ?? 80;
  const criticalPct = cfg.usage.criticalThresholdPercent ?? 90;
  const budgets = cfg.usage.dailyTokenBudget ?? {};
  const resetInfo = getDailyResetInfo();

  const statsPath = options.statsPath ?? findStatsCache();
  const stats = parseStatsCache(statsPath ?? '');
  const modelSummary = getModelSummary() as ModelSummaryType;
  const estimatedTokensByAgent = collectEstimatedTokensByAgent();
  const tokensByModel = stats.found ? (stats.tokensByModel ?? {}) : {};
  const defaultConfidence = stats.found ? deriveConfidence(stats) : 'none';
  const metricsSummary = getMetricsSummary() as MetricsSummaryType;

  const agentDailyConfig: AgentDailyConfig = {
    warningPct,
    criticalPct,
    budgets,
    resetInfo,
    defaultConfidence,
  };

  const agentUsage: Record<string, AgentUsageEntry> = {};
  for (const agent of AGENT_NAMES) {
    agentUsage[agent] = buildAgentUsageEntry(
      agent,
      agentDailyConfig,
      tokensByModel,
      modelSummary,
      estimatedTokensByAgent,
      metricsSummary,
    );
  }

  const trackedAgents = Object.values(agentUsage).filter((entry) => entry.tracked);
  const highest = trackedAgents.reduce<AgentUsageEntry | null>(
    (best, entry) => (best == null || entry.percent > best.percent ? entry : best),
    null,
  );
  const totalTokens = Object.values(agentUsage).reduce(
    (sum, entry) => sum + safeNumber(entry.todayTokens),
    0,
  );

  const daily = buildDailySummary(highest, stats, metricsSummary, totalTokens);
  const weekly = buildWeeklyResult(
    cfg.usage.weeklyTokenBudget ?? {},
    stats,
    modelSummary,
    warningPct,
    criticalPct,
  );
  const window = checkWindowBudget();
  const escalated = escalateLevel(
    { level: daily.level, percent: daily.percent, message: daily.message },
    weekly.tightest,
    window,
  );

  return {
    ok: escalated.level !== 'critical',
    level: escalated.level,
    percent: escalated.percent,
    todayTokens: totalTokens,
    model: daily.model,
    budget: daily.budget,
    used: daily.used,
    remaining: daily.remaining,
    resetAt: daily.resetAt,
    resetInMs: daily.resetInMs,
    message: escalated.message,
    confidence: daily.confidence,
    scope: 'cli-only',
    accountUsageNote: 'CLI tokens only. Full account: claude.ai/settings/usage',
    stats: stats.found ? stats : null,
    agents: agentUsage,
    window,
    weekly,
  };
}

// ── Contingency Options ─────────────────────────────────────────────────────

/**
 * Generate contingency options based on usage level.
 * @param {UsageSummary | null} usageResult - Result from checkUsage()
 * @returns {ContingencyOption[]} Available contingency actions
 */
export function getContingencyOptions(usageResult: UsageSummary | null): ContingencyOption[] {
  if (usageResult == null || usageResult.level === 'normal') return [];

  const options: ContingencyOption[] = [];
  const trackedAgents = Object.values(usageResult.agents).filter((entry) => entry.tracked);
  const highestTracked = trackedAgents.reduce<AgentUsageEntry | null>(
    (best, entry) => (best == null || entry.percent > best.percent ? entry : best),
    null,
  );
  const targetAgent = highestTracked?.agent ?? 'claude';

  if (usageResult.level === 'warning' || usageResult.level === 'critical') {
    options.push({
      id: 'switch_model',
      label: `Switch ${targetAgent} to faster/cheaper model`,
      description: `Use ${targetAgent}'s fast preset to reduce token consumption`,
      action: 'setActiveModel',
      args: { agent: targetAgent, model: 'fast' },
    });
  }

  if (usageResult.level === 'critical') {
    options.push({
      id: 'handoff_gemini',
      label: 'Hand off to Gemini',
      description: 'Create a Hydra handoff with progress summary for Gemini to continue',
      action: 'handoff',
      args: { to: 'gemini' },
    });
    options.push({
      id: 'handoff_codex',
      label: 'Hand off to Codex',
      description: 'Create a Hydra handoff for Codex to handle implementation tasks',
      action: 'handoff',
      args: { to: 'codex' },
    });
    options.push({
      id: 'save_progress',
      label: 'Save progress and pause',
      description: 'Generate a handoff document capturing current state',
      action: 'save_progress',
      args: {},
    });
  }

  return options;
}

/**
 * Execute a contingency option.
 * @param {ContingencyOption} option - One of the options from getContingencyOptions()
 * @param {unknown} [_context] - Additional context (e.g. daemon URL)
 * @returns {object} Result of the action
 */
export function executeContingency(
  option: ContingencyOption,
  _context: unknown = {},
): { ok: boolean; message: string; requiresDaemon?: boolean; instruction?: ContingencyOption } {
  switch (option.action) {
    case 'setActiveModel': {
      const resolved = setActiveModel(option.args['agent'], option.args['model']);
      return { ok: true, message: `Switched ${option.args['agent']} to ${String(resolved)}` };
    }
    case 'handoff':
    case 'save_progress':
      // These require daemon interaction — return instruction for caller
      return {
        ok: true,
        requiresDaemon: true,
        message: `Action "${option.action}" requires daemon. Use operator :usage or client stats command.`,
        instruction: option,
      };
    default:
      return { ok: false, message: `Unknown contingency action: ${option.action}` };
  }
}

// ── CLI Rendering ───────────────────────────────────────────────────────────

function renderUsageBar(percent: number, width = 30): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let colorFn = pc.green;
  if (clamped >= 90) colorFn = pc.red;
  else if (clamped >= 80) colorFn = pc.yellow;

  const bar = colorFn('\u2588'.repeat(filled)) + pc.gray('\u2591'.repeat(empty));
  return `${bar} ${colorFn(`${clamped.toFixed(1)}%`)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatResetCountdown(ms: number): string {
  const clamped = Math.max(0, safeNumber(ms));
  const totalMinutes = Math.floor(clamped / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${String(minutes)}m`;
}

function agentBadgeCompact(agent: string): string {
  const map: Record<string, { icon: string; color: (s: string) => string }> = {
    gemini: { icon: '\u2726', color: pc.cyan },
    codex: { icon: '\u25B6', color: pc.green },
    claude: {
      icon: '\u2666',
      color: isTruecolor ? (str: string) => `\x1b[38;2;232;134;58m${str}\x1b[39m` : pc.yellow,
    },
  };
  const cfg = map[agent] ?? { icon: '\u2022', color: pc.white };
  return cfg.color(`${cfg.icon} ${agent.toUpperCase()}`);
}

function renderWeeklySection(wk: WeeklyResult): string[] {
  if (wk.tightest?.tracked !== true) return [];
  const d = pc.gray;
  const b = pc.bold;
  const lines: string[] = [''];
  lines.push(`  ${b('Weekly')} ${d(`(${String(wk.daysCovered)} days)`)}`);
  lines.push(`  ${d('Usage:')} ${renderUsageBar(wk.percent)}`);
  lines.push(`  ${d('Tokens (7d):')} ${pc.white(formatTokens(wk.totalTokens))}`);
  if ((wk.tightest.weeklyBudget ?? 0) > 0) {
    const wkBudget = wk.tightest.weeklyBudget ?? 0;
    const wkRemaining = Math.max(0, wkBudget - wk.tightest.weeklyTokens);
    lines.push(
      `  ${d('Budget:')} ${pc.white(formatTokens(wkBudget))} ${d(`(${String(wk.tightest.model)})`)}`,
    );
    lines.push(`  ${d('Remaining:')} ${pc.white(formatTokens(wkRemaining))}`);
  }
  return lines;
}

function renderDailySection(usage: UsageSummary): string[] {
  const d = pc.gray;
  const b = pc.bold;
  const lines: string[] = ['', `  ${b('Today')}`];
  if (usage.budget > 0) {
    lines.push(`  ${d('Usage:')} ${renderUsageBar(usage.percent)}`);
  }
  lines.push(`  ${d('Tokens today:')} ${pc.white(formatTokens(usage.todayTokens))}`);
  if (usage.budget > 0) {
    const remaining = usage.remaining == null ? 'n/a' : formatTokens(usage.remaining);
    lines.push(
      `  ${d('Budget:')} ${pc.white(formatTokens(usage.budget))} ${d(`(${String(usage.model)})`)}`,
    );
    lines.push(`  ${d('Remaining:')} ${pc.white(remaining)}`);
    if (usage.resetInMs != null) {
      lines.push(`  ${d('Reset in:')} ${pc.white(formatResetCountdown(usage.resetInMs))}`);
    }
  }
  lines.push(`  ${d('Confidence:')} ${pc.white(usage.confidence)}`);
  return lines;
}

function renderAgentRow(agent: string, row: AgentUsageEntry): string {
  const d = pc.gray;
  const statusColors: Record<string, (s: string) => string> = {
    normal: pc.green,
    warning: pc.yellow,
    critical: pc.red,
    unknown: pc.gray,
  };
  const statusFn = statusColors[row.level] ?? pc.white;
  const status = statusFn((row.level === '' ? 'unknown' : row.level).toUpperCase());
  if ((row.budget ?? 0) > 0) {
    const rowUsed = formatTokens(row.used === 0 ? 0 : row.used);
    const rowBudget = formatTokens(row.budget ?? 0);
    const rowRemaining = formatTokens(row.remaining ?? 0);
    const reset = row.resetInMs == null ? 'n/a' : formatResetCountdown(row.resetInMs);
    return `    ${agentBadgeCompact(agent)} ${status} ${pc.white(`${row.percent.toFixed(1)}%`)}  ${d('used')} ${pc.white(rowUsed)}${d('/')} ${pc.white(rowBudget)}  ${d('left')} ${pc.white(rowRemaining)}  ${d('reset')} ${pc.white(reset)}`;
  }
  const rowUsed = formatTokens(row.todayTokens === 0 ? 0 : row.todayTokens);
  return `    ${agentBadgeCompact(agent)} ${status} ${d('used')} ${pc.white(rowUsed)}  ${d('budget')} ${pc.white('n/a')}  ${d('source')} ${pc.white(row.source === '' ? 'none' : row.source)}`;
}

function renderAgentBreakdown(usage: UsageSummary): string[] {
  if (Object.keys(usage.agents).length === 0) return [];
  const b = pc.bold;
  const lines: string[] = ['', `  ${b('Agent breakdown (today):')}`];
  for (const agent of AGENT_NAMES) {
    const row = usage.agents[agent];
    if (row == null) continue; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- defensive null guard
    lines.push(renderAgentRow(agent, row));
  }
  return lines;
}

function renderUsageDashboard(usage: UsageSummary): string {
  const d = pc.gray;
  const b = pc.bold;

  const lines: string[] = [
    '',
    `${b(pc.magenta('HYDRA'))} ${d('|')} ${d('Claude Code Token Usage')}`,
    d('\u2500'.repeat(56)),
    `  ${d('CLI usage only \u2014 does not include web or desktop usage')}`,
    `  ${d('Full account:')} ${pc.white('claude.ai/settings/usage')}`,
  ];

  if (usage.level === 'unknown') {
    lines.push('', `  ${pc.yellow('\u26A0')} ${usage.message}`);
  } else {
    lines.push(...renderWeeklySection(usage.weekly));
    lines.push(...renderDailySection(usage));
  }

  if (usage.stats?.activity != null) {
    const a = usage.stats.activity;
    lines.push(
      '',
      `  ${d('Messages:')} ${pc.white(String(a.messageCount))}  ${d('Sessions:')} ${pc.white(String(a.sessionCount))}  ${d('Tool calls:')} ${pc.white(String(a.toolCallCount))}`,
    );
  }

  if (usage.stats?.tokensByModel != null && Object.keys(usage.stats.tokensByModel).length > 0) {
    lines.push('', `  ${b('Model breakdown (today):')}`);
    for (const [model, tokens] of Object.entries(usage.stats.tokensByModel)) {
      const shortName = model.replace(/^claude-/, '').replace(/^gemini-/, '');
      lines.push(`    ${d(shortName)} ${pc.white(formatTokens(tokens))}`);
    }
  }

  lines.push(...renderAgentBreakdown(usage));

  const statusColors: Record<string, (s: string) => string> = {
    normal: pc.green,
    warning: pc.yellow,
    critical: pc.red,
    unknown: pc.gray,
  };
  const statusFn = statusColors[usage.level] ?? pc.white;
  lines.push(
    '',
    `  ${d('Status:')} ${statusFn(usage.level.toUpperCase())} ${d(`\u2014 ${usage.message}`)}`,
  );

  const contingencies = getContingencyOptions(usage);
  if (contingencies.length > 0) {
    lines.push('', `  ${b(pc.yellow('Contingency options:'))}`);
    for (const [i, opt] of contingencies.entries()) {
      lines.push(
        `    ${pc.yellow(`${String(i + 1)})`)} ${pc.white(opt.label)} ${d(`\u2014 ${opt.description}`)}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

const isMainModule =
  process.argv[1] !== '' &&
  (process.argv[1].endsWith('hydra-usage.mjs') ||
    process.argv[1].replace(/\\/g, '/').endsWith('hydra-usage.mjs'));

if (isMainModule) {
  const usage = checkUsage();
  console.log(renderUsageDashboard(usage));
  exit(usage.level === 'critical' ? 1 : 0);
}

export { renderUsageDashboard, renderUsageBar, formatTokens };
