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

import fs from 'node:fs';
import path from 'node:path';
import { getAgentActivity, getAgentExecMode } from './hydra-statusbar.ts';
import { getSessionUsage, getAgentMetrics } from './hydra-metrics.ts';
import { request } from './hydra-utils.ts';
import { detectAvailableProviders, streamWithFallback } from './hydra-concierge-providers.ts';
import { isPersonaEnabled, getPersonaConfig } from './hydra-persona.ts';
import { HYDRA_ROOT } from './hydra-config.ts';

// ── Type Definitions ────────────────────────────────────────────────────────

export type ActivityType = 'dispatch' | 'handoff' | 'completion' | 'error' | 'council_phase';

export interface ActivityEntry {
  at: string;
  type: ActivityType;
  narrative: string;
  meta: Record<string, unknown> | null;
}

interface Classification {
  tier?: string;
  taskType?: string;
  confidence?: number;
}

interface DispatchParams {
  prompt: string;
  classification?: Classification | null;
  mode?: string;
  route?: string;
  agent?: string;
}

interface HandoffParams {
  from?: string;
  to?: string;
  summary?: string;
  taskTitle?: string;
}

interface CompletionParams {
  agent?: string;
  taskId?: string;
  title?: string;
  durationMs?: number;
  outputSummary?: string;
  status?: string;
}

interface WorkerState {
  _state?: string;
  status?: string;
  _currentTask?: { taskId?: string; title?: string };
  _permissionMode?: string;
}

interface DaemonHandoff {
  id?: string;
  from?: string;
  to?: string;
  summary?: string;
  acknowledged?: boolean;
  nextStep?: string;
}

interface DaemonTask {
  id?: string;
  taskId?: string;
  title?: string;
  status?: string;
  owner?: string;
  agent?: string;
  blockedBy?: string[];
  durationMs?: number;
}

interface TasksGrouped {
  inProgress?: DaemonTask[];
  todo?: DaemonTask[];
  blocked?: DaemonTask[];
  recentlyCompleted?: DaemonTask[];
}

type TasksData = DaemonTask[] | TasksGrouped;

interface DaemonAgentInfo {
  currentTask?: { title?: string };
  pendingHandoffs?: DaemonHandoff[];
}

interface DaemonSession {
  startedAt?: string;
  status?: string;
  focus?: string;
}

interface DaemonActivityData {
  _fromSummary?: boolean;
  summary?: { openTasks?: DaemonTask[] | TasksGrouped } | null;
  agents?: Record<string, DaemonAgentInfo>;
  tasks?: TasksData;
  handoffs?: { pending?: DaemonHandoff[]; recent?: DaemonHandoff[] };
  session?: DaemonSession;
  decisions?: { recent?: unknown[] };
  counts?: { completed?: number; open?: number; blocked?: number };
}

interface AgentMetricsShape {
  callsToday?: number;
  callsSuccess: number;
  callsTotal: number;
  avgDurationMs?: number;
  lastModel?: string | null;
}

interface AgentDigestEntry {
  name: string;
  status: string;
  action: string;
  taskTitle: string | null;
  model: string | null;
  phase: string | null;
  step: string | null;
  execMode: string | null;
  elapsedMs: number;
  currentTask: { title?: string } | null;
  pendingHandoffs: DaemonHandoff[];
  worker: {
    status: string;
    currentTaskId: string | null;
    currentTaskTitle: string | null;
    permissionMode: string | null;
  } | null;
  metrics: {
    callsToday: number;
    successRate: number;
    avgDurationMs: number;
    lastModel: string | null;
  } | null;
}

export interface ActivityDigest {
  generatedAt: string;
  session: DaemonSession | null;
  agents: AgentDigestEntry[];
  activeTasks: DaemonTask[];
  recentCompletions: DaemonTask[];
  pendingHandoffs: DaemonHandoff[];
  recentHandoffs: DaemonHandoff[];
  recentDecisions: unknown[];
  lastDispatch: ActivityEntry | null;
  activityLog: ActivityEntry[];
  counts: { completed?: number; open?: number; blocked?: number } | null;
  metrics: { totalCalls: number; totalTokens: number; totalCost: number };
}

interface DigestOpts {
  maxChars?: number;
  focus?: string;
}

interface BudgetStatus {
  level?: string;
  weekly?: { level?: string; percentUsed?: number; message?: string };
  message?: string;
}

interface StatsData {
  uptime?: string;
  totalCalls?: number;
  totalTokens?: number;
}

interface BuildDigestOpts {
  baseUrl: string;
  workers?: Map<string, WorkerState>;
  focus?: string;
}

interface SitrepOpts {
  baseUrl?: string;
  workers?: Map<string, WorkerState>;
  budgetStatus?: BudgetStatus | null;
  gitBranch?: string;
  gitLog?: string;
  statsData?: StatsData | null;
}

interface SitrepResult {
  narrative: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  fallback: boolean;
  reason?: string;
  error?: string;
}

interface SessionSummaryEntry {
  timestamp: string;
  summary: string;
  activityCount: number;
}

// ── Situational Query Detection ─────────────────────────────────────────────

const SITUATIONAL_PATTERNS = [
  // General status
  { pattern: /what(?:'s| is) (?:going on|happening|the status|the state|up)\b/i, focus: 'all' },
  { pattern: /(?:status|progress) update/i, focus: 'all' },
  {
    pattern: /give me (?:a )?(?:status|update|summary|overview|sitrep|digest|report)\b/i,
    focus: 'all',
  },
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
 * @param message
 * @returns {{ isSituational: boolean, focus: string|null }}
 */
export function detectSituationalQuery(message: unknown): {
  isSituational: boolean;
  focus: string | null;
} {
  if (typeof message !== 'string') {
    return { isSituational: false, focus: null };
  }
  const trimmed = message.trim();
  for (const { pattern, focus } of SITUATIONAL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      // Resolve $1 capture for agent-specific patterns
      let resolved = focus;
      if (focus === '$1' && match[1] !== '') {
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
export function annotateDispatch({
  prompt,
  classification,
  mode,
  route,
  agent,
}: DispatchParams): string {
  const shortPrompt = prompt.slice(0, 120);
  const tier = classification?.tier ?? 'unknown';
  const taskType = classification?.taskType ?? '';
  const conf =
    classification?.confidence == null
      ? ''
      : ` (${String(Math.round(classification.confidence * 100))}%)`;
  const agentStr = agent == null ? '' : ` to ${agent}`;
  const routeStr = route == null ? '' : ` via ${route}`;
  return `Dispatched "${shortPrompt}" - ${tier}/${taskType}${conf}${routeStr}${agentStr} [${mode ?? 'auto'}]`;
}

/**
 * Create a narrative annotation for a handoff event.
 * @param {object} params
 * @returns {string}
 */
export function annotateHandoff({ from, to, summary, taskTitle }: HandoffParams): string {
  const shortSummary = (summary ?? '').slice(0, 100);
  const task = taskTitle == null ? '' : ` (task: "${taskTitle}")`;
  return `${from ?? '?'} handed off to ${to ?? '?'}: "${shortSummary}"${task}`;
}

/**
 * Create a narrative annotation for a task completion event.
 * @param {object} params
 * @returns {string}
 */
export function annotateCompletion({
  agent,
  taskId,
  title,
  durationMs,
  outputSummary,
  status,
}: CompletionParams): string {
  const elapsed = durationMs == null ? '' : `${String(Math.round(durationMs / 1000))}s`;
  const statusStr = status === 'error' ? 'FAILED' : 'completed';
  const summary = outputSummary == null ? '' : `: "${outputSummary.slice(0, 80)}"`;
  const taskStr = title == null ? '' : ` "${title}"`;
  return `${agent ?? '?'} ${statusStr} ${taskId ?? '?'}${taskStr}${elapsed.length > 0 ? ` in ${elapsed}` : ''}${summary}`;
}

// ── In-Memory Activity Ring Buffer ──────────────────────────────────────────

const MAX_ACTIVITY_LOG = 50;
const activityLog: ActivityEntry[] = [];

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
export function pushActivity(
  type: ActivityType,
  narrative: string,
  meta?: Record<string, unknown> | null,
): void {
  activityLog.push({
    at: new Date().toISOString(),
    type,
    narrative,
    meta: meta ?? null,
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
export function getRecentActivity(n = 20): ActivityEntry[] {
  return activityLog.slice(-n);
}

/**
 * Clear the activity log.
 */
export function clearActivityLog(): void {
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
function buildWorkerEntry(worker: WorkerState): AgentDigestEntry['worker'] {
  return {
    status: worker._state ?? worker.status ?? 'unknown',
    currentTaskId: worker._currentTask?.taskId ?? null,
    currentTaskTitle: worker._currentTask?.title ?? null,
    permissionMode: worker._permissionMode ?? null,
  };
}

function buildMetricsEntry(metrics: AgentMetricsShape): AgentDigestEntry['metrics'] {
  return {
    callsToday: metrics.callsToday ?? 0,
    successRate:
      metrics.callsTotal > 0 ? Math.round((metrics.callsSuccess / metrics.callsTotal) * 100) : 100,
    avgDurationMs: metrics.avgDurationMs ?? 0,
    lastModel: metrics.lastModel ?? null,
  };
}

function buildAgentDigestEntry(
  name: string,
  daemonActivity: DaemonActivityData | null,
  workers: BuildDigestOpts['workers'],
): AgentDigestEntry {
  const activity = getAgentActivity(name);
  const metrics = getAgentMetrics(name) as AgentMetricsShape | null;
  const execMode = getAgentExecMode(name);
  const worker = workers?.get(name);
  const daemonAgent: DaemonAgentInfo = daemonActivity?.agents?.[name] ?? {};

  return {
    name,
    status: activity.status,
    action: activity.action,
    taskTitle: activity.taskTitle ?? daemonAgent.currentTask?.title ?? null,
    model: activity.model,
    phase: activity.phase,
    step: activity.step,
    execMode,
    elapsedMs: activity.updatedAt > 0 ? Date.now() - activity.updatedAt : 0,
    currentTask: daemonAgent.currentTask ?? null,
    pendingHandoffs: daemonAgent.pendingHandoffs ?? [],
    worker: worker == null ? null : buildWorkerEntry(worker),
    metrics: metrics == null ? null : buildMetricsEntry(metrics),
  };
}

async function fetchDaemonActivity(
  baseUrl: string,
  focus: string | undefined,
): Promise<DaemonActivityData | null> {
  try {
    const focusParam =
      focus != null && focus !== 'all' ? `?focus=${encodeURIComponent(focus)}` : '';
    const res = await request<{ activity?: DaemonActivityData }>(
      'GET',
      baseUrl,
      `/activity${focusParam}`,
    );
    return res.activity ?? null;
  } catch {
    try {
      const res = await request<{ summary?: unknown }>('GET', baseUrl, '/summary');
      return {
        _fromSummary: true,
        summary: (res.summary as DaemonActivityData['summary']) ?? null,
      };
    } catch {
      return null;
    }
  }
}

export async function buildActivityDigest({
  baseUrl,
  workers,
  focus,
}: BuildDigestOpts): Promise<ActivityDigest> {
  const daemonActivity = await fetchDaemonActivity(baseUrl, focus);
  const agents: AgentDigestEntry[] = ['claude', 'gemini', 'codex'].map((name) =>
    buildAgentDigestEntry(name, daemonActivity, workers),
  );
  const { activeTasks, recentCompletions } = extractActiveTasksFromDaemon(daemonActivity);
  const handoffs = daemonActivity?.handoffs ?? {};
  const pendingHandoffs: DaemonHandoff[] = handoffs.pending ?? [];
  const recentHandoffs: DaemonHandoff[] = handoffs.recent ?? [];
  const sessionUsage = getSessionUsage();

  return {
    generatedAt: new Date().toISOString(),
    session: daemonActivity?.session ?? null,
    agents,
    activeTasks,
    recentCompletions: recentCompletions.slice(0, 5),
    pendingHandoffs,
    recentHandoffs: recentHandoffs.slice(0, 5),
    recentDecisions: daemonActivity?.decisions?.recent ?? [],
    lastDispatch: getLastDispatchFromLog(),
    activityLog: getRecentActivity(10),
    counts: daemonActivity?.counts ?? null,
    metrics: {
      totalCalls: sessionUsage.callCount,
      totalTokens: sessionUsage.totalTokens,
      totalCost: sessionUsage.costUsd,
    },
  };
}

function extractActiveTasksFromDaemon(daemonActivity: DaemonActivityData | null): {
  activeTasks: DaemonTask[];
  recentCompletions: DaemonTask[];
} {
  const rawTasks: TasksData = daemonActivity?.tasks ?? daemonActivity?.summary?.openTasks ?? [];
  const activeTasks: DaemonTask[] = Array.isArray(rawTasks)
    ? rawTasks
    : [...(rawTasks.inProgress ?? []), ...(rawTasks.todo ?? []), ...(rawTasks.blocked ?? [])];
  const grouped: TasksGrouped = Array.isArray(rawTasks) ? {} : rawTasks;
  const recentCompletions: DaemonTask[] = Array.isArray(grouped.recentlyCompleted)
    ? grouped.recentlyCompleted
    : [];
  return { activeTasks, recentCompletions };
}

/** Pull the most recent dispatch entry from the activity log. */
function getLastDispatchFromLog(): ActivityEntry | null {
  for (let i = activityLog.length - 1; i >= 0; i--) {
    if (activityLog[i].type === 'dispatch') return activityLog[i];
  }
  return null;
}

// ── Digest Formatter ────────────────────────────────────────────────────────

function formatSessionLine(session: DaemonSession): string {
  const since =
    session.startedAt == null
      ? '?'
      : new Date(session.startedAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
  return `Session: ${session.status ?? 'active'} since ${since} | Focus: "${(session.focus ?? 'general').slice(0, 60)}"`;
}

function formatAgentsSection(digest: ActivityDigest, focus: string): string[] {
  const lines: string[] = ['', 'AGENTS:'];
  const agentsToShow =
    focus === 'all' ? digest.agents : digest.agents.filter((a) => a.name === focus);
  for (const a of agentsToShow) {
    let execTag = '';
    if (a.execMode === 'worker') execTag = ' [W]';
    else if (a.execMode === 'terminal') execTag = ' [T]';
    const elapsed = a.elapsedMs > 5000 ? ` ${formatElapsedCompact(a.elapsedMs)}` : '';
    const model = a.model == null ? '' : ` (${a.model})`;
    const taskStr = a.taskTitle == null ? '' : ` "${a.taskTitle.slice(0, 50)}"`;
    const phase = a.phase == null ? '' : ` [${a.phase}${a.step == null ? '' : ` ${a.step}`}]`;
    lines.push(`- ${a.name} [${a.status}]${taskStr}${phase}${model}${execTag}${elapsed}`);
    for (const h of a.pendingHandoffs.slice(0, 2)) {
      lines.push(`  ^ pending handoff from ${h.from ?? '?'}: "${(h.summary ?? '').slice(0, 60)}"`);
    }
  }
  return lines;
}

function formatTasksSection(digest: ActivityDigest, focus: string): string[] {
  const tasksToShow =
    focus === 'all' || focus === 'tasks'
      ? digest.activeTasks
      : digest.activeTasks.filter((t) => t.owner === focus);
  if (tasksToShow.length === 0) return [];
  const lines: string[] = ['', `TASKS (${String(tasksToShow.length)} active):`];
  for (const t of tasksToShow.slice(0, 8)) {
    const blocked =
      (t.blockedBy?.length ?? 0) > 0 ? ` (blocked by ${(t.blockedBy ?? []).join(', ')})` : '';
    lines.push(
      `- ${t.id ?? t.taskId ?? '?'} [${t.status ?? '?'}] ${t.owner ?? 'unassigned'} - "${(t.title ?? '').slice(0, 60)}"${blocked}`,
    );
  }
  if (tasksToShow.length > 8) lines.push(`  ... and ${String(tasksToShow.length - 8)} more`);
  return lines;
}

function formatHandoffLine(h: DaemonHandoff, suffix = ''): string {
  return `  - ${h.id ?? '?'}: ${h.from ?? '?'} -> ${h.to ?? '?'} "${(h.summary ?? '').slice(0, 80)}"${suffix}`;
}

function formatHandoffsSection(digest: ActivityDigest): string[] {
  if (digest.pendingHandoffs.length === 0 && digest.recentHandoffs.length === 0) return [];
  const lines: string[] = ['', 'HANDOFFS:'];
  if (digest.pendingHandoffs.length > 0) {
    lines.push('  Pending:');
    for (const h of digest.pendingHandoffs.slice(0, 3)) {
      lines.push(formatHandoffLine(h));
      if (h.nextStep != null) lines.push(`    Next: ${h.nextStep.slice(0, 80)}`);
    }
  }
  if (digest.recentHandoffs.length > 0) {
    lines.push('  Recent:');
    for (const h of digest.recentHandoffs.slice(0, 3)) {
      lines.push(formatHandoffLine(h, h.acknowledged === true ? ' (ack)' : ''));
    }
  }
  return lines;
}

function formatCompletionsSection(digest: ActivityDigest): string[] {
  if (digest.recentCompletions.length === 0) return [];
  const lines: string[] = ['', 'RECENT COMPLETIONS:'];
  for (const c of digest.recentCompletions.slice(0, 3)) {
    const elapsed = c.durationMs == null ? '' : ` in ${String(Math.round(c.durationMs / 1000))}s`;
    lines.push(
      `- ${c.id ?? c.taskId ?? '?'}: ${c.owner ?? c.agent ?? '?'} done${elapsed} - "${(c.title ?? '').slice(0, 60)}"`,
    );
  }
  return lines;
}

function formatDispatchSection(digest: ActivityDigest): string[] {
  if (digest.lastDispatch == null) return [];
  const narrative =
    digest.lastDispatch.narrative.length > 0 ? digest.lastDispatch.narrative : 'unknown';
  return ['', 'LAST DISPATCH:', `- ${narrative}`];
}

function formatActivityLogSection(digest: ActivityDigest): string[] {
  if (digest.activityLog.length === 0) return [];
  const lines: string[] = ['', 'ACTIVITY LOG (recent):'];
  for (const entry of digest.activityLog.slice(-5)) {
    const time = new Date(entry.at).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    lines.push(`- ${time} [${entry.type}] ${entry.narrative.slice(0, 100)}`);
  }
  return lines;
}

function formatMetricsFooter(digest: ActivityDigest): string[] {
  if (digest.metrics.totalCalls === 0 && digest.metrics.totalTokens === 0) return [];
  const cost = digest.metrics.totalCost > 0 ? ` | ~$${digest.metrics.totalCost.toFixed(2)}` : '';
  const tokens =
    digest.metrics.totalTokens > 0
      ? ` | ${String(Math.round(digest.metrics.totalTokens / 1000))}K tokens`
      : '';
  return ['', `Session: ${String(digest.metrics.totalCalls)} calls${cost}${tokens}`];
}

function gatherDigestSections(digest: ActivityDigest, focus: string): string[] {
  const isAgentFocus = ['claude', 'gemini', 'codex'].includes(focus);
  const lines: string[] = [];

  if (digest.session != null) lines.push(formatSessionLine(digest.session));

  if (focus === 'all' || isAgentFocus) lines.push(...formatAgentsSection(digest, focus));

  if (focus === 'all' || focus === 'tasks' || isAgentFocus)
    lines.push(...formatTasksSection(digest, focus));

  if (focus === 'all' || focus === 'handoffs') lines.push(...formatHandoffsSection(digest));

  if (focus === 'all' || focus === 'tasks') lines.push(...formatCompletionsSection(digest));

  if (focus === 'all' || focus === 'dispatch') lines.push(...formatDispatchSection(digest));

  if (focus === 'all') lines.push(...formatActivityLogSection(digest));

  lines.push(...formatMetricsFooter(digest));
  return lines;
}

/**
 * Format an ActivityDigest into a text block for system prompt injection.
 * @param {object} digest
 * @param {object} [opts]
 * @param {number} [opts.maxChars=6000]
 * @param {string} [opts.focus]
 * @returns {string}
 */
export function formatDigestForPrompt(digest: ActivityDigest, opts: DigestOpts = {}): string {
  const maxChars = opts.maxChars ?? 6000;
  const focus = opts.focus ?? 'all';
  const body = gatherDigestSections(digest, focus);
  const lines = ['=== ACTIVITY DIGEST ===', ...body, '=== END DIGEST ==='];
  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = `${result.slice(0, maxChars - 20)}\n... (truncated)\n=== END DIGEST ===`;
  }
  return result;
}

function formatElapsedCompact(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${String(Math.round(ms / 60_000))}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ── Situation Report ─────────────────────────────────────────────────────────

function getSitrepSystemPrompt() {
  const personaName = isPersonaEnabled() ? (getPersonaConfig().name ?? 'Hydra') : 'Hydra';
  const narrator = isPersonaEnabled()
    ? `You are ${personaName}'s situation awareness perspective, narrating the current state of the system.`
    : 'You are a situation report narrator for Hydra, a multi-agent AI coding orchestration system.';
  return `${narrator} A developer is returning after a break and needs orientation. Given structured data about system state, git history, and task progress, produce a concise big-picture summary.

Structure your response with these three labeled sections (skip a section only if truly empty):

GOAL: Infer the project objective from session focus, branch name, and commit message themes. One or two sentences.

PROGRESS: What has been accomplished — completed tasks, commit highlights, current agent activity. Reference specific commits or task IDs when available.

REMAINING: Open/blocked tasks, pending handoffs, and 1-2 concrete next steps if resuming work now.

End with a single closing line that folds in resource status (budget level, token usage) if available, e.g. "Budget is healthy at 15% used." or "Approaching daily budget limit."

Rules:
- 200-300 words total
- Reference task IDs, agent names, commit messages when available
- If idle with no recent activity, say so briefly and suggest what to do next
- Synthesize, don't repeat raw data
- No markdown headers — use GOAL:, PROGRESS:, REMAINING: as plain text labels
- Write for a developer who just sat down and needs to get oriented fast`;
}

interface SitrepSupplementalOpts {
  sessionFocus: string | null;
  gitBranch?: string;
  gitLog?: string;
  counts: ActivityDigest['counts'];
  budgetStatus?: BudgetStatus | null;
  statsData?: StatsData | null;
}

function buildBudgetLine(budgetStatus: BudgetStatus): string {
  const lvl = budgetStatus.level ?? budgetStatus.weekly?.level ?? 'unknown';
  const pct =
    budgetStatus.weekly?.percentUsed == null
      ? ''
      : `${String(Math.round(budgetStatus.weekly.percentUsed))}%`;
  const msg = budgetStatus.message ?? budgetStatus.weekly?.message ?? '';
  return `Budget: ${lvl}${pct.length > 0 ? ` (${pct} used)` : ''}${msg.length > 0 ? ` — ${msg}` : ''}`;
}

function buildStatsLine(statsData: StatsData): string | null {
  const parts: string[] = [];
  if (statsData.uptime != null) parts.push(`uptime ${statsData.uptime}`);
  if (statsData.totalCalls != null) parts.push(`${String(statsData.totalCalls)} total calls`);
  if (statsData.totalTokens != null)
    parts.push(`${String(Math.round(statsData.totalTokens / 1000))}K tokens`);
  return parts.length > 0 ? `Daemon: ${parts.join(', ')}` : null;
}

function buildSitrepSupplemental(opts: SitrepSupplementalOpts): string[] {
  const { sessionFocus, gitBranch, gitLog, counts, budgetStatus, statsData } = opts;
  const supplemental: string[] = [];

  if (sessionFocus != null) supplemental.push(`Session focus: ${sessionFocus}`);
  if (gitBranch != null) supplemental.push(`Git branch: ${gitBranch}`);
  if (gitLog != null) supplemental.push(`Recent commits:\n${gitLog}`);

  if (counts != null) {
    const parts: string[] = [];
    if (counts.completed != null) parts.push(`${String(counts.completed)} completed`);
    if (counts.open != null) parts.push(`${String(counts.open)} open`);
    if (counts.blocked != null) parts.push(`${String(counts.blocked)} blocked`);
    if (parts.length > 0) supplemental.push(`Task progress: ${parts.join(', ')}`);
  }

  if (budgetStatus != null) supplemental.push(buildBudgetLine(budgetStatus));

  if (statsData != null) {
    const line = buildStatsLine(statsData);
    if (line != null) supplemental.push(line);
  }

  return supplemental;
}

function buildSitrepFallback(
  formattedDigest: string,
  sessionFocus: string | null,
  gitBranch: string | undefined,
): SitrepResult {
  const headerParts: string[] = [];
  if (sessionFocus != null) headerParts.push(`Focus: ${sessionFocus}`);
  if (gitBranch != null) headerParts.push(`Branch: ${gitBranch}`);
  const header = headerParts.length > 0 ? `${headerParts.join(' | ')}\n\n` : '';
  return { narrative: header + formattedDigest, fallback: true, reason: 'no_provider' };
}

/**
 * Generate an AI-narrated situation report.
 * Falls back to the raw formatted digest if no AI provider is available.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - Daemon base URL
 * @param {Map<string,object>} [opts.workers] - Live worker map
 * @param {object} [opts.budgetStatus] - From checkUsage()
 * @param {string} [opts.gitBranch] - Current git branch name
 * @param {string} [opts.gitLog] - Recent git log (one-line format)
 * @param {object} [opts.statsData] - Daemon /stats response
 * @returns {Promise<{narrative: string, provider?: string, model?: string, usage?: object, fallback: boolean}>}
 */
export async function generateSitrep(opts: SitrepOpts = {}): Promise<SitrepResult> {
  const { baseUrl, workers, budgetStatus, gitBranch, gitLog, statsData } = opts;

  const digest = await buildActivityDigest({ baseUrl: baseUrl ?? '', workers, focus: 'all' });
  const formattedDigest = formatDigestForPrompt(digest, { maxChars: 4000 });
  const sessionFocus = digest.session?.focus ?? null;

  const supplemental = buildSitrepSupplemental({
    sessionFocus,
    gitBranch,
    gitLog,
    counts: digest.counts,
    budgetStatus,
    statsData,
  });

  const userContent =
    supplemental.length > 0
      ? `${formattedDigest}\n\nSUPPLEMENTAL:\n${supplemental.join('\n')}`
      : formattedDigest;

  const providers = detectAvailableProviders();
  if (providers.length === 0) return buildSitrepFallback(formattedDigest, sessionFocus, gitBranch);

  const messages = [
    { role: 'system', content: getSitrepSystemPrompt() },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await streamWithFallback(
      messages,
      { maxTokens: 2000, reasoningEffort: 'low' },
      () => {},
    );
    const narrative = (typeof result.fullResponse === 'string' ? result.fullResponse : '').trim();
    if (narrative.length === 0) {
      return { narrative: formattedDigest, fallback: true, reason: 'empty_response' };
    }
    return {
      narrative,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      fallback: false,
    };
  } catch (err: unknown) {
    return {
      narrative: formattedDigest,
      fallback: true,
      reason: 'api_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Session Summaries Persistence ────────────────────────────────────────────

const SESSION_SUMMARIES_FILE = path.join(
  HYDRA_ROOT,
  'docs',
  'coordination',
  'session-summaries.json',
);
const MAX_SESSION_SUMMARIES = 10;

function loadSessionSummaries(): SessionSummaryEntry[] {
  try {
    const raw = fs.readFileSync(SESSION_SUMMARIES_FILE, 'utf8');
    const data = JSON.parse(raw) as { summaries?: SessionSummaryEntry[] };
    return Array.isArray(data.summaries) ? data.summaries : [];
  } catch {
    return [];
  }
}

/**
 * Persist a session summary for cross-session context.
 * @param {string} summary - Brief session summary text
 */
export function saveSessionSummary(summary: string): void {
  if (summary.length === 0) return;
  const summaries = loadSessionSummaries();
  summaries.push({
    timestamp: new Date().toISOString(),
    summary: summary.slice(0, 2000),
    activityCount: activityLog.length,
  });
  // Keep only the most recent N
  while (summaries.length > MAX_SESSION_SUMMARIES) {
    summaries.shift();
  }
  const dir = path.dirname(SESSION_SUMMARIES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_SUMMARIES_FILE, `${JSON.stringify({ summaries }, null, 2)}\n`);
}

/**
 * Get session context for concierge system prompt injection.
 * @returns {{ recentActivity: ActivityEntry[], priorSessions: Array<{timestamp: string, summary: string}> }}
 */
export function getSessionContext(): {
  recentActivity: ActivityEntry[];
  priorSessions: SessionSummaryEntry[];
} {
  const priorSessions = loadSessionSummaries().slice(-3);
  return {
    recentActivity: getRecentActivity(10),
    priorSessions,
  };
}
