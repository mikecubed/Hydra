/**
 * Task and agent helper functions extracted from orchestrator-daemon.ts.
 * Pure utilities and lightweight helpers that do not depend on HTTP or file-system state.
 */

import { execSync } from 'node:child_process';
import { getAgent, KNOWN_OWNERS, listAgents, resolvePhysicalAgent } from '../hydra-agents.ts';
import { getAgentInstructionFile } from '../hydra-sync-md.ts';
import type { TaskEntry, HydraStateShape, BlockerEntry, HandoffEntry } from '../types.ts';

export const STATUS_VALUES = new Set([
  'todo',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
]);

/**
 * Generate the next sequential ID for a prefix (e.g. 'T' → 'T001', 'T002', …).
 */
export function nextId(prefix: string, items: unknown[]): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);

  for (const item of items) {
    const match = (
      ((item as Record<string, unknown>)['id'] as string | null | undefined) ?? ''
    ).match(pattern);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }

  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/**
 * Split a value into a trimmed string array. Splits on commas only.
 */
export function parseList(value?: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => String(item).trim()).filter(Boolean);
  }
  return (value as string)
    .split(/,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Run a shell command synchronously in the given project root directory.
 * Returns stdout trimmed, or an empty string on failure.
 */
export function runCommand(command: string, projectRoot: string): string {
  try {
    return execSync(command, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Get the current git branch name for the given project root.
 */
export function getCurrentBranch(projectRoot: string): string {
  const branch = runCommand('git branch --show-current', projectRoot);
  return branch === '' ? 'unknown' : branch;
}

/**
 * Validate that the given status string is a recognised Hydra task status.
 * Throws if invalid.
 */
export function ensureKnownStatus(status: string): void {
  if (!STATUS_VALUES.has(status)) {
    throw new Error(`Invalid status "${status}".`);
  }
}

/**
 * Validate that the given agent name is recognised.
 * When allowUnassigned is true (default) the full KNOWN_OWNERS set is used;
 * when false, only the four physical agents plus human are permitted.
 */
export function ensureKnownAgent(agent: string, allowUnassigned = true): void {
  const allowed = allowUnassigned ? KNOWN_OWNERS : new Set(['human', 'gemini', 'codex', 'claude']);
  if (!allowed.has(agent)) {
    throw new Error(`Unknown agent "${agent}".`);
  }
}

/**
 * Format a task entry as a single-line human-readable string.
 */
export function formatTask(task: TaskEntry): string {
  const deps =
    Array.isArray(task.blockedBy) && task.blockedBy.length > 0
      ? ` blockedBy=${task.blockedBy.join(',')}`
      : '';
  return `${task.id} [${task.status}] owner=${task.owner}${deps} :: ${task.title}`;
}

/**
 * Detect whether adding proposedBlockedBy to targetId would create a cycle.
 * Returns true if a cycle is detected.
 */
export function detectCycle(
  tasks: TaskEntry[],
  targetId: string,
  proposedBlockedBy: string[],
): boolean {
  const visited = new Set<string>();
  const queue = [...proposedBlockedBy];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === targetId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const task = tasks.find((t: TaskEntry) => t.id === current);
    if (task && Array.isArray(task.blockedBy)) {
      queue.push(...task.blockedBy);
    }
  }
  return false;
}

/**
 * Automatically move blocked tasks to 'todo' when all their dependencies are complete.
 * Mutates task entries in-place.
 */
export function autoUnblock(state: HydraStateShape, completedTaskId: string): void {
  const completedIds = new Set(
    state.tasks
      .filter((t: TaskEntry) => ['done', 'cancelled'].includes(t.status))
      .map((t: TaskEntry) => t.id),
  );
  completedIds.add(completedTaskId);

  for (const task of state.tasks) {
    if (!Array.isArray(task.blockedBy) || task.blockedBy.length === 0) {
      continue;
    }
    if (task.status !== 'blocked') {
      continue;
    }
    const allDepsComplete = task.blockedBy.every((dep: string) => completedIds.has(dep));
    if (allDepsComplete) {
      task.status = 'todo';
      const note = `[AUTO] All dependencies completed (${task.blockedBy.join(',')}), moved to todo.`;
      task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
      task.updatedAt = new Date().toISOString();
    }
  }
}

/**
 * Build the prompt context string for a given agent and current state.
 */
export function buildPrompt(
  agent: string,
  state: HydraStateShape,
  projectRoot: string,
  projectName: string,
): string {
  const agentConfig = getAgent(agent);
  let label: string;
  if (agentConfig) {
    label = agentConfig.label;
  } else if (agent === 'human') {
    label = 'Human Operator';
  } else {
    label = 'AI Assistant';
  }
  const rolePrompt = agentConfig ? agentConfig.rolePrompt : '';

  const openTasks = state.tasks
    .filter((task: TaskEntry) => !['done', 'cancelled'].includes(task.status))
    .slice(0, 10)
    .map((task: TaskEntry) => `- ${formatTask(task)}`)
    .join('\n');

  const instructionFile = getAgentInstructionFile(agent, projectRoot);
  const readInstructions = (
    getAgent(agent)?.readInstructions ?? (() => `Read ${instructionFile} first.`)
  )(instructionFile);

  return [
    `You are ${label} collaborating in the ${projectName} repository with Gemini Pro, Codex, and Claude Code.`,
    '',
    rolePrompt ?? '',
    '',
    readInstructions,
    '',
    'Rules for this run:',
    '- Claim or update one task before editing.',
    '- Keep task status current: todo/in_progress/blocked/done.',
    '- Record decisions and blockers as they happen.',
    '- Add a handoff entry before switching agents.',
    ...(getAgent(agent)?.taskRules ?? []),
    '',
    `Current focus: ${state.activeSession?.focus ?? 'not set'}`,
    `Current branch: ${state.activeSession?.branch ?? getCurrentBranch(projectRoot)}`,
    '',
    'Open tasks:',
    openTasks === '' ? '- none' : openTasks,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a summary of the current state (open tasks, blockers, decisions, handoffs).
 */
export function getSummary(state: HydraStateShape): Record<string, unknown> {
  const completedIds = new Set(
    state.tasks
      .filter((t: TaskEntry) => ['done', 'cancelled'].includes(t.status))
      .map((t: TaskEntry) => t.id),
  );
  const openTasks = state.tasks
    .filter((task: TaskEntry) => !['done', 'cancelled'].includes(task.status))
    .map((task: TaskEntry) => {
      const deps = Array.isArray(task.blockedBy) ? task.blockedBy : [];
      const pendingDependencies = deps.filter((dep: string) => !completedIds.has(dep));
      return { ...task, pendingDependencies };
    });
  const openBlockers = state.blockers.filter((item: BlockerEntry) => item.status !== 'resolved');
  const recentDecision = state.decisions.at(-1) ?? null;
  const latestHandoff = state.handoffs.at(-1) ?? null;

  return {
    updatedAt: state.updatedAt,
    activeSession: state.activeSession,
    counts: {
      tasksOpen: openTasks.length,
      blockersOpen: openBlockers.length,
      decisions: state.decisions.length,
      handoffs: state.handoffs.length,
    },
    openTasks,
    openBlockers,
    recentDecision,
    latestHandoff,
  };
}

function getOpenTasks(state: HydraStateShape): TaskEntry[] {
  const completedIds = new Set(
    state.tasks
      .filter((t: TaskEntry) => ['done', 'cancelled'].includes(t.status))
      .map((t: TaskEntry) => t.id),
  );
  return state.tasks.filter((task: TaskEntry) => {
    if (['done', 'cancelled'].includes(task.status)) return false;
    const deps = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return deps.every((dep: string) => completedIds.has(dep));
  });
}

function buildUnassignedSuggestion(
  scored: ScoredTask[],
  agent: string,
): { action: string; message: string; task: TaskEntry; preferredAgent?: string } | null {
  if (scored.length === 0) return null;
  const { task, affinity, preferredAgent } = scored[0];
  const result: { action: string; message: string; task: TaskEntry; preferredAgent?: string } = {
    action: 'claim_unassigned_task',
    message: `${agent} can claim ${task.id} (type=${task.type}, affinity=${String(affinity)}).`,
    task,
  };
  if (preferredAgent != null && preferredAgent !== '') result.preferredAgent = preferredAgent;
  return result;
}

interface ScoredTask {
  task: TaskEntry;
  affinity: number;
  preferredAgent: string | null;
}

function scoreUnassignedTodos(openTasks: TaskEntry[], agent: string): ScoredTask[] {
  const agentConfig = getAgent(agent);
  return openTasks
    .filter(
      (task: TaskEntry) =>
        ['unassigned', 'human', ''].includes(task.owner) && task.status === 'todo',
    )
    .map((task: TaskEntry) => {
      const taskType = task.type === '' ? 'implementation' : task.type;
      const affinity =
        (agentConfig?.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0.5;
      let preferredAgent: string | null = null;
      const virtualAgents = listAgents({ type: 'virtual', enabled: true });
      for (const va of virtualAgents) {
        const physical = resolvePhysicalAgent(va.name);
        if (
          physical?.name === agent &&
          ((va.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0) > affinity
        ) {
          preferredAgent = va.name;
        }
      }
      return { task, affinity, preferredAgent };
    })
    .sort((a: { affinity: number }, b: { affinity: number }) => b.affinity - a.affinity);
}

/**
 * Suggest the next action for the given agent based on current state.
 */
export function suggestNext(
  state: HydraStateShape,
  agent: string,
): {
  action: string;
  message?: string;
  task?: Record<string, unknown>;
  handoff?: Record<string, unknown>;
} & Record<string, unknown> {
  ensureKnownAgent(agent, false);
  const openTasks = getOpenTasks(state);

  const inProgress = openTasks.find(
    (task: TaskEntry) => task.owner === agent && task.status === 'in_progress',
  );
  if (inProgress) {
    return {
      action: 'continue_task',
      message: `${agent} should continue ${inProgress.id}.`,
      task: inProgress,
    };
  }

  const pendingHandoff = [...state.handoffs]
    .reverse()
    .find(
      (handoff: HandoffEntry) =>
        handoff.to === agent && (handoff.acknowledgedAt == null || handoff.acknowledgedAt === ''),
    );
  if (pendingHandoff) {
    const relatedTask =
      pendingHandoff.tasks == null
        ? null
        : openTasks.find((task: TaskEntry) => (pendingHandoff.tasks as string[]).includes(task.id));
    return {
      action: 'pickup_handoff',
      message: `${agent} has an unacknowledged handoff ${pendingHandoff.id}.`,
      handoff: pendingHandoff,
      relatedTask,
    };
  }

  const ownedTodo = openTasks.find(
    (task: TaskEntry) => task.owner === agent && task.status === 'todo',
  );
  if (ownedTodo) {
    return {
      action: 'claim_owned_task',
      message: `${agent} should move ${ownedTodo.id} to in_progress.`,
      task: ownedTodo,
    };
  }

  const unassignedTodos = scoreUnassignedTodos(openTasks, agent);
  const unassignedSuggestion = buildUnassignedSuggestion(unassignedTodos, agent);
  if (unassignedSuggestion) return unassignedSuggestion;

  const blockedMine = openTasks.find(
    (task: TaskEntry) => task.owner === agent && task.status === 'blocked',
  );
  if (blockedMine) {
    return {
      action: 'resolve_blocker',
      message: `${agent} has blocked task ${blockedMine.id}.`,
      task: blockedMine,
    };
  }

  return {
    action: 'idle',
    message: `No actionable task for ${agent}.`,
  };
}
