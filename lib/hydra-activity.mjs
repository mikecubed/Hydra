#!/usr/bin/env node
/**
 * Hydra Activity Digest — Real-time activity summarization for the concierge.
 *
 * Provides:
 * - Situational query detection (regex-based, zero-cost)
 * - Activity annotation helpers (dispatch, handoff, completion narratives)
 * - In-memory ring buffer for recent annotated activity entries
 * - Activity digest builder (merges daemon state + local agent/metrics/worker state)
 * - Digest formatter for system prompt injection
 */

import { getAgentActivity, getAgentExecMode } from './hydra-statusbar.mjs';
import { getSessionUsage, getAgentMetrics } from './hydra-metrics.mjs';
import { request } from './hydra-utils.mjs';

// ── Situational Query Detection ─────────────────────────────────────────────

const SITUATIONAL_PATTERNS = [
  // General status
  { pattern: /what(?:'s| is) (?:going on|happening|the status|the state|up)\b/i, focus: 'all' },
  { pattern: /(?:status|progress) update/i, focus: 'all' },
  { pattern: /give me (?:a )?(?:status|update|summary|overview|sitrep|digest|report)\b/i, focus: 'all' },
  { pattern: /what(?:'s| is|'re| are) (?:the )?agents? (?:doing|working|up to)/i, focus: 'all' },
  { pattern: /how(?:'s| is) (?:it|everything|things?) going/i, focus: 'all' },
  { pattern: /any (?:progress|updates?|news|activity)\b/i, focus: 'all' },
  { pattern: /(?:^|\s)sitrep\b/i, focus: 'all' },

  // Agent-specific
  { pattern: /what(?:'s| is) (claude|gemini|codex) (?:doing|working on|up to)/i, focus: '$1' },
  { pattern: /how(?:'s| is) (claude|gemini|codex) (?:doing|going|progressing)/i, focus: '$1' },
  { pattern: /(?:^|\s)(claude|gemini|codex) status\b/i, focus: '$1' },
  { pattern: /what(?:'s| is) (claude|gemini|codex) (?:current|active)/i, focus: '$1' },
  { pattern: /where(?:'s| is) (claude|gemini|codex)\b/i, focus: '$1' },

  // Task-specific
  { pattern: /what tasks? (?:are|is) (?:open|pending|active|running)/i, focus: 'tasks' },
  { pattern: /what(?:'s| is) (?:being worked on|in progress|pending)\b/i, focus: 'tasks' },
  { pattern: /(?:open|active|pending|running) tasks/i, focus: 'tasks' },

  // Handoff-specific
  { pattern: /what(?:'s| is) (?:the|that) handoff/i, focus: 'handoffs' },
  { pattern: /(?:pending|recent|last) handoffs?/i, focus: 'handoffs' },
  { pattern: /what (?:was|got) handed off/i, focus: 'handoffs' },
  { pattern: /context (?:of|for) (?:the|that) handoff/i, focus: 'handoffs' },
  { pattern: /handoff (?:details?|context|summary)/i, focus: 'handoffs' },

  // Dispatch context
  { pattern: /what (?:was|did) (?:I|we) (?:just )?(?:dispatch|send|kick off)/i, focus: 'dispatch' },
  { pattern: /what(?:'s| is) (?:the )?last dispatch/i, focus: 'dispatch' },
  { pattern: /what(?:'s| was) dispatched/i, focus: 'dispatch' },
];

/**
 * Detect whether a user message is a situational/status query.
 * @param {string} message
 * @returns {{ isSituational: boolean, focus: string|null }}
 */
export function detectSituationalQuery(message) {
  if (!message || typeof message !== 'string') {
    return { isSituational: false, focus: null };
  }
  const trimmed = message.trim();
  for (const { pattern, focus } of SITUATIONAL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      // Resolve $1 capture for agent-specific patterns
      let resolved = focus;
      if (focus === '$1' && match[1]) {
        resolved = match[1].toLowerCase();
      }
      return { isSituational: true, focus: resolved };
    }
  }
  return { isSituational: false, focus: null };
}

// ── Activity Annotations ────────────────────────────────────────────────────

/**
 * Create a narrative annotation for a dispatch event.
 * @param {object} params
 * @param {string} params.prompt
 * @param {object} [params.classification]
 * @param {string} [params.mode]
 * @param {string} [params.route]
 * @param {string} [params.agent]
 * @returns {string}
 */
export function annotateDispatch({ prompt, classification, mode, route, agent }) {
  const shortPrompt = (prompt || '').slice(0, 120);
  const tier = classification?.tier || 'unknown';
  const taskType = classification?.taskType || '';
  const conf = classification?.confidence != null ? ` (${Math.round(classification.confidence * 100)}%)` : '';
  const agentStr = agent ? ` to ${agent}` : '';
  const routeStr = route ? ` via ${route}` : '';
  return `Dispatched "${shortPrompt}" - ${tier}/${taskType}${conf}${routeStr}${agentStr} [${mode || 'auto'}]`;
}

/**
 * Create a narrative annotation for a handoff event.
 * @param {object} params
 * @returns {string}
 */
export function annotateHandoff({ from, to, summary, taskTitle }) {
  const shortSummary = (summary || '').slice(0, 100);
  const task = taskTitle ? ` (task: "${taskTitle}")` : '';
  return `${from || '?'} handed off to ${to || '?'}: "${shortSummary}"${task}`;
}

/**
 * Create a narrative annotation for a task completion event.
 * @param {object} params
 * @returns {string}
 */
export function annotateCompletion({ agent, taskId, title, durationMs, outputSummary, status }) {
  const elapsed = durationMs ? `${Math.round(durationMs / 1000)}s` : '';
  const statusStr = status === 'error' ? 'FAILED' : 'completed';
  const summary = outputSummary ? `: "${(outputSummary || '').slice(0, 80)}"` : '';
  const taskStr = title ? ` "${title}"` : '';
  return `${agent || '?'} ${statusStr} ${taskId || '?'}${taskStr}${elapsed ? ` in ${elapsed}` : ''}${summary}`;
}

// ── In-Memory Activity Ring Buffer ──────────────────────────────────────────

const MAX_ACTIVITY_LOG = 50;
const activityLog = [];

/**
 * @typedef {object} ActivityEntry
 * @property {string} at - ISO timestamp
 * @property {'dispatch'|'handoff'|'completion'|'error'|'council_phase'} type
 * @property {string} narrative
 * @property {object} [meta]
 */

/**
 * Push an annotated activity entry.
 * @param {'dispatch'|'handoff'|'completion'|'error'|'council_phase'} type
 * @param {string} narrative
 * @param {object} [meta]
 */
export function pushActivity(type, narrative, meta) {
  activityLog.push({
    at: new Date().toISOString(),
    type,
    narrative,
    meta: meta || null,
  });
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.splice(0, activityLog.length - MAX_ACTIVITY_LOG);
  }
}

/**
 * Read the last N activity entries.
 * @param {number} [n=20]
 * @returns {ActivityEntry[]}
 */
export function getRecentActivity(n = 20) {
  return activityLog.slice(-n);
}

/**
 * Clear the activity log.
 */
export function clearActivityLog() {
  activityLog.length = 0;
}

// ── Activity Digest Builder ─────────────────────────────────────────────────

/**
 * Build a full activity digest by fetching daemon state + merging local state.
 * @param {object} opts
 * @param {string} opts.baseUrl - Daemon base URL
 * @param {Map<string,object>} [opts.workers] - Live worker map from operator
 * @param {string} [opts.focus] - 'all' | agent name | 'tasks' | 'handoffs' | 'dispatch'
 * @returns {Promise<object>} ActivityDigest
 */
export async function buildActivityDigest({ baseUrl, workers, focus }) {
  // Fetch daemon activity snapshot
  let daemonActivity = null;
  try {
    const focusParam = focus && focus !== 'all' ? `?focus=${encodeURIComponent(focus)}` : '';
    const res = await request('GET', baseUrl, `/activity${focusParam}`);
    daemonActivity = res?.activity || null;
  } catch {
    // Fall back to summary endpoint
    try {
      const res = await request('GET', baseUrl, '/summary');
      daemonActivity = { _fromSummary: true, summary: res?.summary || null };
    } catch { /* daemon unreachable */ }
  }

  // Merge local agent state
  const agents = ['claude', 'gemini', 'codex'].map((name) => {
    const activity = getAgentActivity(name);
    const metrics = getAgentMetrics(name);
    const execMode = getAgentExecMode(name);
    const worker = workers?.get(name);

    const daemonAgent = daemonActivity?.agents?.[name] || {};

    return {
      name,
      status: activity.status,
      action: activity.action,
      taskTitle: activity.taskTitle || daemonAgent.currentTask?.title || null,
      model: activity.model,
      phase: activity.phase,
      step: activity.step,
      execMode,
      elapsedMs: activity.updatedAt ? Date.now() - activity.updatedAt : 0,
      currentTask: daemonAgent.currentTask || null,
      pendingHandoffs: daemonAgent.pendingHandoffs || [],
      worker: worker ? {
        status: worker._state || worker.status || 'unknown',
        currentTaskId: worker._currentTask?.taskId || null,
        currentTaskTitle: worker._currentTask?.title || null,
        permissionMode: worker._permissionMode || null,
      } : null,
      metrics: metrics ? {
        callsToday: metrics.callsToday || 0,
        successRate: metrics.callsTotal > 0 ? Math.round((metrics.callsSuccess / metrics.callsTotal) * 100) : 100,
        avgDurationMs: metrics.avgDurationMs || 0,
        lastModel: metrics.lastModel || null,
      } : null,
    };
  });

  // Extract task info from daemon
  const tasks = daemonActivity?.tasks || daemonActivity?.summary?.openTasks || [];
  const activeTasks = Array.isArray(tasks)
    ? tasks
    : [
      ...(tasks.inProgress || []),
      ...(tasks.todo || []),
      ...(tasks.blocked || []),
    ];
  const recentCompletions = Array.isArray(tasks?.recentlyCompleted) ? tasks.recentlyCompleted : [];

  // Extract handoff info
  const handoffs = daemonActivity?.handoffs || {};
  const pendingHandoffs = handoffs.pending || [];
  const recentHandoffs = handoffs.recent || [];

  // Session metrics
  const sessionUsage = getSessionUsage();

  return {
    generatedAt: new Date().toISOString(),
    session: daemonActivity?.session || null,
    agents,
    activeTasks,
    recentCompletions: recentCompletions.slice(0, 5),
    pendingHandoffs,
    recentHandoffs: recentHandoffs.slice(0, 5),
    recentDecisions: daemonActivity?.decisions?.recent || [],
    lastDispatch: getLastDispatchFromLog(),
    activityLog: getRecentActivity(10),
    counts: daemonActivity?.counts || null,
    metrics: {
      totalCalls: sessionUsage.callCount || 0,
      totalTokens: sessionUsage.totalTokens || 0,
      totalCost: sessionUsage.costUsd || 0,
    },
  };
}

/** Pull the most recent dispatch entry from the activity log. */
function getLastDispatchFromLog() {
  for (let i = activityLog.length - 1; i >= 0; i--) {
    if (activityLog[i].type === 'dispatch') return activityLog[i];
  }
  return null;
}

// ── Digest Formatter ────────────────────────────────────────────────────────

/**
 * Format an ActivityDigest into a text block for system prompt injection.
 * @param {object} digest
 * @param {object} [opts]
 * @param {number} [opts.maxChars=6000]
 * @param {string} [opts.focus]
 * @returns {string}
 */
export function formatDigestForPrompt(digest, opts = {}) {
  const maxChars = opts.maxChars || 6000;
  const focus = opts.focus || 'all';
  const lines = ['=== ACTIVITY DIGEST ==='];

  // Session line
  if (digest.session) {
    const s = digest.session;
    const since = s.startedAt ? new Date(s.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
    lines.push(`Session: ${s.status || 'active'} since ${since} | Focus: "${(s.focus || 'general').slice(0, 60)}"`);
  }

  // Agents section (always show unless focus is very narrow)
  if (focus === 'all' || ['claude', 'gemini', 'codex'].includes(focus)) {
    lines.push('');
    lines.push('AGENTS:');
    const agentsToShow = focus === 'all' ? digest.agents : digest.agents.filter((a) => a.name === focus);
    for (const a of agentsToShow) {
      const execTag = a.execMode === 'worker' ? ' [W]' : a.execMode === 'terminal' ? ' [T]' : '';
      const elapsed = a.elapsedMs > 5000 ? ` ${formatElapsedCompact(a.elapsedMs)}` : '';
      const model = a.model ? ` (${a.model})` : '';
      const taskStr = a.taskTitle ? ` "${a.taskTitle.slice(0, 50)}"` : '';
      const phase = a.phase ? ` [${a.phase}${a.step ? ` ${a.step}` : ''}]` : '';
      lines.push(`- ${a.name} [${a.status}]${taskStr}${phase}${model}${execTag}${elapsed}`);
      if (a.pendingHandoffs.length > 0) {
        for (const h of a.pendingHandoffs.slice(0, 2)) {
          lines.push(`  ^ pending handoff from ${h.from}: "${(h.summary || '').slice(0, 60)}"`);
        }
      }
    }
  }

  // Tasks section
  if (focus === 'all' || focus === 'tasks' || ['claude', 'gemini', 'codex'].includes(focus)) {
    const tasksToShow = focus === 'all' || focus === 'tasks'
      ? digest.activeTasks
      : digest.activeTasks.filter((t) => t.owner === focus);

    if (tasksToShow.length > 0) {
      lines.push('');
      lines.push(`TASKS (${tasksToShow.length} active):`);
      for (const t of tasksToShow.slice(0, 8)) {
        const blocked = t.blockedBy?.length > 0 ? ` (blocked by ${t.blockedBy.join(', ')})` : '';
        lines.push(`- ${t.id} [${t.status}] ${t.owner || 'unassigned'} - "${(t.title || '').slice(0, 60)}"${blocked}`);
      }
      if (tasksToShow.length > 8) {
        lines.push(`  ... and ${tasksToShow.length - 8} more`);
      }
    }
  }

  // Handoffs section
  if (focus === 'all' || focus === 'handoffs') {
    if (digest.pendingHandoffs.length > 0 || digest.recentHandoffs.length > 0) {
      lines.push('');
      lines.push('HANDOFFS:');
      if (digest.pendingHandoffs.length > 0) {
        lines.push('  Pending:');
        for (const h of digest.pendingHandoffs.slice(0, 3)) {
          lines.push(`  - ${h.id}: ${h.from} -> ${h.to} "${(h.summary || '').slice(0, 80)}"`);
          if (h.nextStep) lines.push(`    Next: ${h.nextStep.slice(0, 80)}`);
        }
      }
      if (digest.recentHandoffs.length > 0) {
        lines.push('  Recent:');
        for (const h of digest.recentHandoffs.slice(0, 3)) {
          const acked = h.acknowledged ? ' (ack)' : '';
          lines.push(`  - ${h.id}: ${h.from} -> ${h.to} "${(h.summary || '').slice(0, 80)}"${acked}`);
        }
      }
    }
  }

  // Recent completions
  if (focus === 'all' || focus === 'tasks') {
    if (digest.recentCompletions.length > 0) {
      lines.push('');
      lines.push('RECENT COMPLETIONS:');
      for (const c of digest.recentCompletions.slice(0, 3)) {
        const elapsed = c.durationMs ? ` in ${Math.round(c.durationMs / 1000)}s` : '';
        lines.push(`- ${c.id || c.taskId}: ${c.owner || c.agent || '?'} done${elapsed} - "${(c.title || '').slice(0, 60)}"`);
      }
    }
  }

  // Last dispatch
  if (focus === 'all' || focus === 'dispatch') {
    const lastDispatch = digest.lastDispatch;
    if (lastDispatch) {
      lines.push('');
      lines.push('LAST DISPATCH:');
      lines.push(`- ${lastDispatch.narrative || 'unknown'}`);
    }
  }

  // Activity log
  if (focus === 'all') {
    const recentLog = digest.activityLog || [];
    if (recentLog.length > 0) {
      lines.push('');
      lines.push('ACTIVITY LOG (recent):');
      for (const entry of recentLog.slice(-5)) {
        const time = new Date(entry.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        lines.push(`- ${time} [${entry.type}] ${entry.narrative.slice(0, 100)}`);
      }
    }
  }

  // Session metrics footer
  if (digest.metrics && (digest.metrics.totalCalls > 0 || digest.metrics.totalTokens > 0)) {
    lines.push('');
    const cost = digest.metrics.totalCost > 0 ? ` | ~$${digest.metrics.totalCost.toFixed(2)}` : '';
    const tokens = digest.metrics.totalTokens > 0 ? ` | ${Math.round(digest.metrics.totalTokens / 1000)}K tokens` : '';
    lines.push(`Session: ${digest.metrics.totalCalls} calls${cost}${tokens}`);
  }

  lines.push('=== END DIGEST ===');

  // Enforce character budget
  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 20) + '\n... (truncated)\n=== END DIGEST ===';
  }
  return result;
}

function formatElapsedCompact(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
