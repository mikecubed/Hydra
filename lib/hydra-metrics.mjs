#!/usr/bin/env node
/**
 * Hydra Metrics Collection
 *
 * In-memory metrics store with file persistence. Tracks per-agent call counts,
 * durations, estimated tokens, and success rates.
 *
 * Usage:
 *   import { recordCallStart, recordCallComplete, getMetrics } from './hydra-metrics.mjs';
 *   const handle = recordCallStart('claude', 'claude-opus-4-6');
 *   // ... agent call ...
 *   recordCallComplete(handle, result);
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

// ── Metrics Event Emitter ───────────────────────────────────────────────────

export const metricsEmitter = new EventEmitter();

const MAX_HISTORY = 20;
const TOKENS_PER_CHAR_ESTIMATE = 0.25; // rough estimate: 4 chars ≈ 1 token

// ── Metrics Store ───────────────────────────────────────────────────────────

let metricsStore = createEmptyStore();

function createEmptyStore() {
  return {
    startedAt: new Date().toISOString(),
    agents: {},
  };
}

function ensureAgent(agentName) {
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
    };
  }
  return metricsStore.agents[agentName];
}

// ── Recording ───────────────────────────────────────────────────────────────

let handleCounter = 0;
const activeHandles = new Map();

/**
 * Record the start of an agent call.
 * @param {string} agentName - claude, gemini, or codex
 * @param {string} [model] - Model ID being used
 * @returns {string} Handle ID for recordCallComplete/Error
 */
export function recordCallStart(agentName, model) {
  handleCounter += 1;
  const handle = `call_${handleCounter}_${Date.now()}`;
  activeHandles.set(handle, {
    agent: agentName,
    model: model || 'unknown',
    startedAt: Date.now(),
    startIso: new Date().toISOString(),
  });
  metricsEmitter.emit('call:start', { agent: agentName, model: model || 'unknown' });
  return handle;
}

/**
 * Record successful completion of an agent call.
 * @param {string} handle - Handle from recordCallStart
 * @param {object} result - Process result with stdout/stderr
 */
export function recordCallComplete(handle, result) {
  const meta = activeHandles.get(handle);
  if (!meta) return;
  activeHandles.delete(handle);

  const durationMs = Date.now() - meta.startedAt;
  const agent = ensureAgent(meta.agent);
  const outputLen = (result?.stdout || '').length + (result?.stderr || '').length;
  const estimatedTokens = Math.round(outputLen * TOKENS_PER_CHAR_ESTIMATE);

  agent.callsTotal += 1;
  agent.callsToday += 1;
  agent.callsSuccess += 1;
  agent.estimatedTokensToday += estimatedTokens;
  agent.totalDurationMs += durationMs;
  agent.avgDurationMs = Math.round(agent.totalDurationMs / agent.callsTotal);
  agent.lastCallAt = new Date().toISOString();
  agent.lastModel = meta.model;

  agent.history.push({
    at: meta.startIso,
    model: meta.model,
    durationMs,
    estimatedTokens,
    ok: true,
    outputLen,
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
export function recordCallError(handle, error) {
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
    error: String(error?.message || error || 'unknown'),
  });
  if (agent.history.length > MAX_HISTORY) {
    agent.history = agent.history.slice(-MAX_HISTORY);
  }
  metricsEmitter.emit('call:error', { agent: meta.agent, error: String(error?.message || error || 'unknown') });
}

// ── Querying ────────────────────────────────────────────────────────────────

/**
 * Get the full metrics store.
 */
export function getMetrics() {
  return { ...metricsStore };
}

/**
 * Get metrics for a specific agent.
 */
export function getAgentMetrics(agentName) {
  return metricsStore.agents[agentName] || null;
}

/**
 * Get a summary suitable for dashboard display.
 */
export function getMetricsSummary() {
  const agents = {};
  let totalCalls = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const [name, data] of Object.entries(metricsStore.agents)) {
    agents[name] = {
      callsToday: data.callsToday,
      callsSuccess: data.callsSuccess,
      callsFailed: data.callsFailed,
      estimatedTokensToday: data.estimatedTokensToday,
      avgDurationMs: data.avgDurationMs,
      lastModel: data.lastModel,
      lastCallAt: data.lastCallAt,
      successRate: data.callsTotal > 0
        ? Math.round((data.callsSuccess / data.callsTotal) * 100)
        : 100,
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
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

const METRICS_FILENAME = 'hydra-metrics.json';

/**
 * Save metrics to a JSON file in the given directory.
 */
export function persistMetrics(coordDir) {
  if (!coordDir) return;
  try {
    if (!fs.existsSync(coordDir)) {
      fs.mkdirSync(coordDir, { recursive: true });
    }
    const filePath = path.join(coordDir, METRICS_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(metricsStore, null, 2) + '\n', 'utf8');
  } catch {
    // Non-critical — skip silently
  }
}

/**
 * Load previously persisted metrics.
 */
export function loadPersistedMetrics(coordDir) {
  if (!coordDir) return;
  try {
    const filePath = path.join(coordDir, METRICS_FILENAME);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const loaded = JSON.parse(raw);
    if (loaded && typeof loaded === 'object' && loaded.agents) {
      metricsStore = loaded;
      // Reset today counters if date changed
      const today = new Date().toISOString().slice(0, 10);
      const startDate = (metricsStore.startedAt || '').slice(0, 10);
      if (startDate !== today) {
        for (const agent of Object.values(metricsStore.agents)) {
          agent.callsToday = 0;
          agent.estimatedTokensToday = 0;
        }
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
export function resetMetrics() {
  metricsStore = createEmptyStore();
}
