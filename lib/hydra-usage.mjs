#!/usr/bin/env node
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
 *   import { checkUsage } from './hydra-usage.mjs';
 *   const result = checkUsage();
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadHydraConfig, resolveProject } from './hydra-config.mjs';
import { setActiveModel, AGENT_NAMES, getModelSummary } from './hydra-agents.mjs';
import { getMetricsSummary } from './hydra-metrics.mjs';
import pc from 'picocolors';

// ── Stats Cache Location ────────────────────────────────────────────────────

/**
 * Find Claude Code's stats-cache.json.
 * Checks config override first, then standard location.
 */
export function findStatsCache() {
  const cfg = loadHydraConfig();
  const configPath = cfg.usage?.claudeStatsPath;

  if (configPath && configPath !== 'auto') {
    if (fs.existsSync(configPath)) return configPath;
  }

  // Standard location: ~/.claude/stats-cache.json
  const homeDir = os.homedir();
  const standard = path.join(homeDir, '.claude', 'stats-cache.json');
  if (fs.existsSync(standard)) return standard;

  // Windows alternative
  const appData = process.env.APPDATA;
  if (appData) {
    const winPath = path.join(appData, '.claude', 'stats-cache.json');
    if (fs.existsSync(winPath)) return winPath;
  }

  return null;
}

// ── Stats Parsing ───────────────────────────────────────────────────────────

/**
 * Parse stats-cache.json and extract today's usage data.
 * @param {string} filePath - Path to stats-cache.json
 * @returns {object} Parsed usage data
 */
export function parseStatsCache(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { found: false, error: 'Stats cache not found' };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Extract today's token usage by model
    let dailyTokens = Array.isArray(data.dailyModelTokens)
      ? data.dailyModelTokens.find((d) => d.date === today)
      : null;

    // If no data for today, check if the most recent day is yesterday
    // (stats-cache may not be updated yet for the current day)
    let stale = false;
    if (!dailyTokens && Array.isArray(data.dailyModelTokens) && data.dailyModelTokens.length > 0) {
      const latest = data.dailyModelTokens[data.dailyModelTokens.length - 1];
      const latestDate = new Date(latest.date + 'T00:00:00');
      const todayDate = new Date(today + 'T00:00:00');
      const diffMs = todayDate.getTime() - latestDate.getTime();
      // Use yesterday's data as a proxy if within 48h
      if (diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000) {
        dailyTokens = latest;
        stale = true;
      }
    }

    const tokensByModel = dailyTokens?.tokensByModel || {};
    const totalTokensToday = Object.values(tokensByModel).reduce((sum, n) => sum + (Number(n) || 0), 0);

    // Estimate today's tokens from activity if we have no direct data
    const todayActivity = Array.isArray(data.dailyActivity)
      ? data.dailyActivity.find((d) => d.date === today)
      : null;
    let estimatedFromActivity = 0;
    if (todayActivity && totalTokensToday === 0) {
      // Estimate ~150 tokens per message as rough heuristic
      estimatedFromActivity = (todayActivity.messageCount || 0) * 150;
    }

    // Extract today's activity
    const dailyActivity = Array.isArray(data.dailyActivity)
      ? data.dailyActivity.find((d) => d.date === today)
      : null;

    // Overall model usage stats (cumulative)
    const modelUsage = data.modelUsage || {};

    // Calculate burn rate from recent data
    const recentDays = Array.isArray(data.dailyModelTokens)
      ? data.dailyModelTokens.slice(-7)
      : [];

    // Use activity for today even if token data is stale
    const activityEntry = todayActivity || dailyActivity;

    return {
      found: true,
      today,
      tokensByModel,
      totalTokensToday: totalTokensToday || estimatedFromActivity,
      estimatedFromActivity,
      stale,
      activity: activityEntry ? {
        messageCount: activityEntry.messageCount || 0,
        sessionCount: activityEntry.sessionCount || 0,
        toolCallCount: activityEntry.toolCallCount || 0,
      } : null,
      modelUsage,
      recentDays: recentDays.length,
      version: data.version || 'unknown',
    };
  } catch (err) {
    return { found: false, error: `Failed to parse stats cache: ${err.message}` };
  }
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumObjectValues(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  return Object.values(obj).reduce((sum, value) => sum + safeNumber(value), 0);
}

function roundPercent(value) {
  return Math.round(safeNumber(value) * 10) / 10;
}

function levelFromPercent(percent, warningPct, criticalPct) {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= criticalPct) return 'critical';
  if (percent >= warningPct) return 'warning';
  return 'normal';
}

function getDailyResetInfo() {
  const now = new Date();
  const reset = new Date(now);
  reset.setHours(24, 0, 0, 0);
  const resetInMs = Math.max(0, reset.getTime() - now.getTime());
  return { resetAt: reset.toISOString(), resetInMs };
}

function deriveConfidence(stats) {
  const hoursSinceStart = stats?.activity
    ? Math.min(stats.activity.sessionCount || 0, 24)
    : 0;
  if (hoursSinceStart >= 4) return 'high';
  if (hoursSinceStart >= 1) return 'medium';
  return 'low';
}

function modelBelongsToAgent(modelId, agent) {
  const lower = String(modelId || '').toLowerCase();
  if (!lower) return false;
  if (agent === 'claude') return lower.startsWith('claude-');
  if (agent === 'gemini') return lower.startsWith('gemini-');
  if (agent === 'codex') {
    return lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4') || lower.startsWith('o5') || lower.startsWith('codex');
  }
  return false;
}

function pickHighestTrackedModel(tokensByModel, budgets) {
  let best = null;
  for (const [modelId, usedRaw] of Object.entries(tokensByModel || {})) {
    const budget = safeNumber(budgets?.[modelId]);
    if (budget <= 0) continue;
    const used = safeNumber(usedRaw);
    const percent = budget > 0 ? (used / budget) * 100 : 0;
    if (!best || percent > best.percent) {
      best = { model: modelId, used, budget, percent };
    }
  }
  return best;
}

function readPersistedEstimatedTokens() {
  const out = Object.fromEntries(AGENT_NAMES.map((agent) => [agent, 0]));
  try {
    const project = resolveProject({ skipValidation: true });
    const metricsPath = path.join(project.coordDir, 'hydra-metrics.json');
    if (!fs.existsSync(metricsPath)) return out;

    const raw = fs.readFileSync(metricsPath, 'utf8');
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    const started = String(data.startedAt || '').slice(0, 10);
    if (started !== today) return out;

    for (const agent of AGENT_NAMES) {
      out[agent] = safeNumber(data?.agents?.[agent]?.estimatedTokensToday);
    }
  } catch {
    // best-effort fallback only
  }
  return out;
}

function collectEstimatedTokensByAgent() {
  const out = readPersistedEstimatedTokens();
  try {
    const metrics = getMetricsSummary();
    for (const agent of AGENT_NAMES) {
      const live = safeNumber(metrics?.agents?.[agent]?.estimatedTokensToday);
      out[agent] = Math.max(out[agent] || 0, live);
    }
  } catch {
    // best-effort fallback only
  }
  return out;
}

// ── Usage Check ─────────────────────────────────────────────────────────────

/**
 * Check current usage level against configured thresholds.
 * @param {object} [options]
 * @param {string} [options.statsPath] - Override stats cache path
 * @returns {object} Usage assessment
 */
export function checkUsage(options = {}) {
  const cfg = loadHydraConfig();
  const warningPct = cfg.usage?.warningThresholdPercent || 80;
  const criticalPct = cfg.usage?.criticalThresholdPercent || 90;
  const budgets = cfg.usage?.dailyTokenBudget || {};
  const resetInfo = getDailyResetInfo();

  const statsPath = options.statsPath || findStatsCache();
  const stats = parseStatsCache(statsPath);
  const modelSummary = getModelSummary();
  const estimatedTokensByAgent = collectEstimatedTokensByAgent();

  const tokensByModel = stats.found ? (stats.tokensByModel || {}) : {};
  const defaultConfidence = stats.found ? deriveConfidence(stats) : 'none';
  const agentUsage = {};

  for (const agent of AGENT_NAMES) {
    const activeModel = modelSummary?.[agent]?.active || null;
    const agentModelTokens = {};
    for (const [modelId, used] of Object.entries(tokensByModel)) {
      if (modelBelongsToAgent(modelId, agent)) {
        agentModelTokens[modelId] = safeNumber(used);
      }
    }

    const modelBreakdown = agentModelTokens;
    const directUsed = sumObjectValues(agentModelTokens);
    const estimatedUsed = safeNumber(estimatedTokensByAgent[agent]);
    const used = directUsed > 0 ? directUsed : estimatedUsed;
    const source =
      directUsed > 0
        ? 'stats-cache'
        : estimatedUsed > 0
          ? 'hydra-metrics-estimate'
          : 'none';

    const activeBudget = activeModel ? safeNumber(budgets[activeModel]) : 0;
    let tracked = null;
    if (activeBudget > 0) {
      tracked = {
        model: activeModel,
        budget: activeBudget,
        used: safeNumber(agentModelTokens[activeModel]) || used,
      };
      tracked.percent = tracked.budget > 0 ? (tracked.used / tracked.budget) * 100 : 0;
    } else {
      tracked = pickHighestTrackedModel(agentModelTokens, budgets);
    }

    const hasBudget = Boolean(tracked?.budget && tracked.budget > 0);
    const percent = hasBudget ? roundPercent(tracked.percent) : 0;
    const level = hasBudget ? levelFromPercent(percent, warningPct, criticalPct) : 'unknown';
    const remaining = hasBudget ? Math.max(0, tracked.budget - tracked.used) : null;
    const confidence = source === 'stats-cache' ? defaultConfidence : (source === 'hydra-metrics-estimate' ? 'low' : 'none');

    agentUsage[agent] = {
      agent,
      level,
      percent,
      todayTokens: used,
      used: hasBudget ? tracked.used : used,
      budget: hasBudget ? tracked.budget : null,
      remaining,
      model: hasBudget ? tracked.model : activeModel,
      activeModel,
      source,
      tracked: hasBudget,
      confidence,
      resetAt: hasBudget ? resetInfo.resetAt : null,
      resetInMs: hasBudget ? resetInfo.resetInMs : null,
      modelBreakdown,
    };
  }

  const trackedAgents = Object.values(agentUsage).filter((entry) => entry.tracked);
  const highest = trackedAgents.reduce((best, entry) =>
    (!best || entry.percent > best.percent ? entry : best), null
  );
  const totalTokens = Object.values(agentUsage).reduce((sum, entry) => sum + safeNumber(entry.todayTokens), 0);

  let level = 'unknown';
  let percent = 0;
  let confidence = 'none';
  let message = '';
  let model = null;
  let budget = 0;
  let used = 0;
  let remaining = null;
  let resetAt = null;
  let resetInMs = null;

  if (highest) {
    level = highest.level;
    percent = highest.percent;
    confidence = highest.confidence;
    model = highest.model;
    budget = highest.budget;
    used = highest.used;
    remaining = highest.remaining;
    resetAt = highest.resetAt;
    resetInMs = highest.resetInMs;
    message = `${highest.agent} usage ${highest.percent.toFixed(1)}% — highest tracked load`;
  } else if (!stats.found) {
    message = stats.error || 'Claude stats cache not found. Usage tracking unavailable.';
  } else {
    message = 'Usage data found, but no token budget is configured for active models.';
  }

  if (stats.stale && message) {
    message += ' (token data from previous day — current day not yet computed)';
  } else if (stats.estimatedFromActivity && !highest) {
    message = `Estimated ~${formatTokens(stats.estimatedFromActivity)} tokens from activity (${stats.activity?.messageCount || 0} messages today)`;
  }

  return {
    ok: level !== 'critical',
    level,
    percent,
    todayTokens: totalTokens,
    model,
    budget,
    used,
    remaining,
    resetAt,
    resetInMs,
    message,
    confidence,
    stats: stats.found ? stats : null,
    agents: agentUsage,
  };
}

// ── Contingency Options ─────────────────────────────────────────────────────

/**
 * Generate contingency options based on usage level.
 * @param {object} usageResult - Result from checkUsage()
 * @returns {Array} Available contingency actions
 */
export function getContingencyOptions(usageResult) {
  if (!usageResult || usageResult.level === 'normal') return [];

  const options = [];
  const trackedAgents = usageResult.agents
    ? Object.values(usageResult.agents).filter((entry) => entry && entry.tracked)
    : [];
  const highestTracked = trackedAgents.reduce((best, entry) =>
    (!best || entry.percent > best.percent ? entry : best), null
  );
  const targetAgent = highestTracked?.agent || 'claude';

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
 * @param {object} option - One of the options from getContingencyOptions()
 * @param {object} [context] - Additional context (e.g. daemon URL)
 * @returns {object} Result of the action
 */
export function executeContingency(option, context = {}) {
  switch (option.action) {
    case 'setActiveModel': {
      const resolved = setActiveModel(option.args.agent, option.args.model);
      return { ok: true, message: `Switched ${option.args.agent} to ${resolved}` };
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

function renderUsageBar(percent, width = 30) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let colorFn = pc.green;
  if (clamped >= 90) colorFn = pc.red;
  else if (clamped >= 80) colorFn = pc.yellow;

  const bar = colorFn('\u2588'.repeat(filled)) + pc.gray('\u2591'.repeat(empty));
  return `${bar} ${colorFn(`${clamped.toFixed(1)}%`)}`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatResetCountdown(ms) {
  const clamped = Math.max(0, safeNumber(ms));
  const totalMinutes = Math.floor(clamped / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function agentBadgeCompact(agent) {
  const map = {
    claude: { icon: '\u2666', color: pc.magenta },
    gemini: { icon: '\u2726', color: pc.cyan },
    codex: { icon: '\u25B6', color: pc.green },
  };
  const cfg = map[agent] || { icon: '\u2022', color: pc.white };
  return cfg.color(`${cfg.icon} ${String(agent || '').toUpperCase()}`);
}

function renderUsageDashboard(usage) {
  const lines = [];
  const d = pc.gray;
  const b = pc.bold;

  lines.push('');
  lines.push(`${b(pc.magenta('HYDRA'))} ${d('|')} ${d('Usage Monitor')}`);
  lines.push(d('\u2500'.repeat(56)));

  if (usage.level === 'unknown') {
    lines.push(`  ${pc.yellow('\u26A0')} ${usage.message}`);
  } else {
    // Usage bar
    lines.push(`  ${d('Usage:')} ${renderUsageBar(usage.percent)}`);
    lines.push(`  ${d('Tokens today:')} ${pc.white(formatTokens(usage.todayTokens))}`);
    if (usage.budget) {
      const remaining = usage.remaining !== null && usage.remaining !== undefined
        ? formatTokens(usage.remaining)
        : 'n/a';
      lines.push(`  ${d('Budget:')} ${pc.white(formatTokens(usage.budget))} ${d(`(${usage.model})`)}`);
      lines.push(`  ${d('Remaining:')} ${pc.white(remaining)}`);
      if (usage.resetInMs !== null && usage.resetInMs !== undefined) {
        lines.push(`  ${d('Reset in:')} ${pc.white(formatResetCountdown(usage.resetInMs))}`);
      }
    }
    lines.push(`  ${d('Confidence:')} ${pc.white(usage.confidence)}`);
  }

  if (usage.stats?.activity) {
    const a = usage.stats.activity;
    lines.push('');
    lines.push(`  ${d('Messages:')} ${pc.white(String(a.messageCount))}  ${d('Sessions:')} ${pc.white(String(a.sessionCount))}  ${d('Tool calls:')} ${pc.white(String(a.toolCallCount))}`);
  }

  // Per-model breakdown
  if (usage.stats?.tokensByModel && Object.keys(usage.stats.tokensByModel).length > 0) {
    lines.push('');
    lines.push(`  ${b('Model breakdown:')}`);
    for (const [model, tokens] of Object.entries(usage.stats.tokensByModel)) {
      const shortName = model.replace(/^claude-/, '').replace(/^gemini-/, '');
      lines.push(`    ${d(shortName)} ${pc.white(formatTokens(tokens))}`);
    }
  }

  if (usage.agents && Object.keys(usage.agents).length > 0) {
    lines.push('');
    lines.push(`  ${b('Agent breakdown:')}`);
    for (const agent of AGENT_NAMES) {
      const row = usage.agents[agent];
      if (!row) continue;
      const statusColors = { normal: pc.green, warning: pc.yellow, critical: pc.red, unknown: pc.gray };
      const statusFn = statusColors[row.level] || pc.white;
      const status = statusFn((row.level || 'unknown').toUpperCase());
      if (row.budget) {
        const used = formatTokens(row.used || 0);
        const budget = formatTokens(row.budget || 0);
        const remaining = formatTokens(row.remaining || 0);
        const reset = row.resetInMs !== null && row.resetInMs !== undefined ? formatResetCountdown(row.resetInMs) : 'n/a';
        lines.push(`    ${agentBadgeCompact(agent)} ${status} ${pc.white(`${row.percent.toFixed(1)}%`)}  ${d('used')} ${pc.white(used)}${d('/')} ${pc.white(budget)}  ${d('left')} ${pc.white(remaining)}  ${d('reset')} ${pc.white(reset)}`);
      } else {
        const used = formatTokens(row.todayTokens || 0);
        lines.push(`    ${agentBadgeCompact(agent)} ${status} ${d('used')} ${pc.white(used)}  ${d('budget')} ${pc.white('n/a')}  ${d('source')} ${pc.white(row.source || 'none')}`);
      }
    }
  }

  // Status line
  const statusColors = { normal: pc.green, warning: pc.yellow, critical: pc.red, unknown: pc.gray };
  const statusFn = statusColors[usage.level] || pc.white;
  lines.push('');
  lines.push(`  ${d('Status:')} ${statusFn(usage.level.toUpperCase())} ${d(`\u2014 ${usage.message}`)}`);

  // Contingency options
  const contingencies = getContingencyOptions(usage);
  if (contingencies.length > 0) {
    lines.push('');
    lines.push(`  ${b(pc.yellow('Contingency options:'))}`);
    for (let i = 0; i < contingencies.length; i++) {
      const opt = contingencies[i];
      lines.push(`    ${pc.yellow(`${i + 1})`)} ${pc.white(opt.label)} ${d(`\u2014 ${opt.description}`)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('hydra-usage.mjs') ||
  process.argv[1].replace(/\\/g, '/').endsWith('hydra-usage.mjs')
);

if (isMainModule) {
  const usage = checkUsage();
  console.log(renderUsageDashboard(usage));
  process.exit(usage.level === 'critical' ? 1 : 0);
}

export { renderUsageDashboard, renderUsageBar, formatTokens };
