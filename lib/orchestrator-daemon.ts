#!/usr/bin/env node
/**
 * Orchestrator daemon for Gemini + Codex + Claude coordination.
 * Runs a local HTTP server that reads/writes the shared sync state.
 *
 * Graceful shutdown: On Unix, SIGINT/SIGTERM trigger a clean exit. On Windows,
 * process signals are not delivered the same way; use the HTTP /stop (or
 * orchestrator-client stop) endpoint for a Windows-safe graceful shutdown.
 */

import './hydra-env.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec, execSync, spawn } from 'node:child_process';
import {
  getAgent,
  KNOWN_OWNERS,
  AGENT_NAMES,
  classifyTask,
  getModelSummary,
  listAgents,
  resolvePhysicalAgent,
} from './hydra-agents.ts';
import { registerBuiltInSubAgents } from './hydra-sub-agents.ts';
import { syncHydraMd, getAgentInstructionFile } from './hydra-sync-md.ts';
import { hydraSplash, label as uiLabel, divider, SUCCESS, DIM } from './hydra-ui.ts';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import {
  git,
  getCurrentBranch as getGitCurrentBranch,
  smartMerge,
} from './hydra-shared/git-ops.ts';
import { getMetricsSummary, persistMetrics, loadPersistedMetrics } from './hydra-metrics.ts';
import { checkUsage } from './hydra-usage.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { handleReadRoute } from './daemon/read-routes.ts';
import { handleWriteRoute } from './daemon/write-routes.ts';
import {
  nowIso,
  toSessionId,
  getEventSeq,
  ensureCoordFiles,
  readState,
  writeState,
  appendSyncLog,
  appendEvent,
  replayEvents,
  type EventRecord,
} from './daemon/state.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HydraStateShape,
  TaskEntry,
  HandoffEntry,
  BlockerEntry,
  ArchiveState,
  WriteRouteCtx,
  UsageCheckResult,
  ModelSummaryEntry,
  AgentDef,
} from './types.ts';
import pc from 'picocolors';

const config = resolveProject();

const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const STATUS_PATH = config.statusPath;
const EVENTS_PATH = config.eventsPath;
const ARCHIVE_PATH = config.archivePath;

const DEFAULT_HOST = process.env['AI_ORCH_HOST'] ?? '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env['AI_ORCH_PORT'] ?? '4173', 10);
const ORCH_TOKEN = process.env['AI_ORCH_TOKEN'] ?? '';

const STATUS_VALUES = new Set(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
const KNOWN_AGENTS = KNOWN_OWNERS;

function nextId(prefix: string, items: unknown[]) {
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
 * @param {string | string[] | null | undefined} value
 * @returns {string[]}
 */
function parseList(value: unknown): string[] {
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

function runCommand(command: string) {
  try {
    return execSync(command, {
      cwd: config.projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

function getCurrentBranch() {
  const branch = runCommand('git branch --show-current');
  return branch === '' ? 'unknown' : branch;
}

function ensureKnownStatus(status: string) {
  if (!STATUS_VALUES.has(status)) {
    throw new Error(`Invalid status "${status}".`);
  }
}

function ensureKnownAgent(agent: string, allowUnassigned = true) {
  const allowed = allowUnassigned ? KNOWN_AGENTS : new Set(['human', 'gemini', 'codex', 'claude']);
  if (!allowed.has(agent)) {
    throw new Error(`Unknown agent "${agent}".`);
  }
}

function formatTask(task: TaskEntry) {
  const deps =
    Array.isArray(task.blockedBy) && task.blockedBy.length > 0
      ? ` blockedBy=${task.blockedBy.join(',')}`
      : '';
  return `${task.id} [${task.status}] owner=${task.owner}${deps} :: ${task.title}`;
}

function detectCycle(tasks: TaskEntry[], targetId: string, proposedBlockedBy: string[]) {
  const visited = new Set();
  const queue = [...proposedBlockedBy];
  while (queue.length > 0) {
    const current = queue.shift();
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

function autoUnblock(state: HydraStateShape, completedTaskId: string) {
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
      task.updatedAt = nowIso();
    }
  }
}

function buildPrompt(agent: string, state: HydraStateShape) {
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

  // Agent-specific file read instructions
  const instructionFile = getAgentInstructionFile(agent, config.projectRoot);
  const readInstructions = (
    getAgent(agent)?.readInstructions ?? (() => `Read ${instructionFile} first.`)
  )(instructionFile);

  return [
    `You are ${label} collaborating in the ${config.projectName} repository with Gemini Pro, Codex, and Claude Code.`,
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
    `Current branch: ${state.activeSession?.branch ?? getCurrentBranch()}`,
    '',
    'Open tasks:',
    openTasks === '' ? '- none' : openTasks,
  ]
    .filter(Boolean)
    .join('\n');
}

function getSummary(state: HydraStateShape) {
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

function suggestNext(state: HydraStateShape, agent: string) {
  ensureKnownAgent(agent, false);

  const completedIds = new Set(
    state.tasks
      .filter((t: TaskEntry) => ['done', 'cancelled'].includes(t.status))
      .map((t: TaskEntry) => t.id),
  );
  const openTasks = state.tasks.filter((task: TaskEntry) => {
    if (['done', 'cancelled'].includes(task.status)) {
      return false;
    }
    const deps = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return deps.every((dep: string) => completedIds.has(dep));
  });
  const openTasks2 = openTasks; // alias for type narrowing
  const inProgress = openTasks2.find(
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

  // Sort unassigned tasks by affinity for the requesting agent
  const agentConfig = getAgent(agent);
  const unassignedTodos = openTasks
    .filter(
      (task: TaskEntry) =>
        ['unassigned', 'human', ''].includes(task.owner) && task.status === 'todo',
    )
    .map((task: TaskEntry) => {
      const taskType = task.type === '' ? 'implementation' : task.type;
      const affinity =
        (agentConfig?.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0.5;
      // Check if a virtual agent has better affinity for this task type
      let preferredAgent = null;
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

  if (unassignedTodos.length > 0) {
    const unassignedTodo = unassignedTodos[0].task;
    const suggestion = {
      action: 'claim_unassigned_task',
      message: `${agent} can claim ${unassignedTodo.id} (type=${unassignedTodo.type}, affinity=${String(unassignedTodos[0].affinity)}).`,
      task: unassignedTodo,
    };
    if (unassignedTodos[0].preferredAgent != null && unassignedTodos[0].preferredAgent !== '') {
      (suggestion as Record<string, unknown>)['preferredAgent'] = unassignedTodos[0].preferredAgent;
    }
    return suggestion;
  }

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

function parseArgs(argv: string[]) {
  const [command = 'start', ...rest] = argv.slice(2);
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key !== '') {
        options[key] = rawValue.join('=').trim();
      }
    }
  }

  return { command, options };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  details: unknown = null,
) {
  sendJson(res, statusCode, {
    ok: false,
    error: message,
    details,
  });
}

function isAuthorized(req: IncomingMessage) {
  if (ORCH_TOKEN === '') {
    return true;
  }
  return req.headers['x-ai-orch-token'] === ORCH_TOKEN;
}

async function readJsonBody(req: IncomingMessage) {
  const chunks = [];
  let size = 0;
  const maxSize = 1024 * 1024;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxSize) {
      throw new Error('Payload too large.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function readEvents(limit = 50) {
  if (!fs.existsSync(EVENTS_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean);

  const parsed: EventRecord[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as EventRecord);
    } catch {
      // Skip malformed lines.
    }
  }
  return parsed.slice(-Math.max(1, Math.min(limit, 500)));
}

function readArchive(): ArchiveState {
  if (!fs.existsSync(ARCHIVE_PATH)) {
    return { tasks: [], handoffs: [], blockers: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8')) as ArchiveState;
  } catch {
    return { tasks: [], handoffs: [], blockers: [] };
  }
}

function writeArchive(archive: ArchiveState) {
  archive.archivedAt = nowIso();
  fs.writeFileSync(ARCHIVE_PATH, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
}

function archiveState(state: HydraStateShape) {
  const archive = readArchive();
  let moved = 0;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const completedTasks = state.tasks.filter((t: TaskEntry) =>
    ['done', 'cancelled'].includes(t.status),
  );
  const completedTaskIds = new Set(completedTasks.map((t: TaskEntry) => t.id));
  if (completedTasks.length > 0) {
    archive.tasks.push(...completedTasks);
    state.tasks = state.tasks.filter((t: TaskEntry) => !completedTaskIds.has(t.id));
    moved += completedTasks.length;

    for (const task of state.tasks) {
      if (Array.isArray(task.blockedBy)) {
        task.blockedBy = task.blockedBy.filter((dep: string) => !completedTaskIds.has(dep));
      }
    }
  }

  const oldHandoffs = state.handoffs.filter((h: HandoffEntry) => {
    if (h.acknowledgedAt == null || h.acknowledgedAt === '') {
      return false;
    }
    return new Date(h.acknowledgedAt).getTime() < oneHourAgo;
  });
  if (oldHandoffs.length > 0) {
    const oldHandoffIds = new Set(oldHandoffs.map((h: HandoffEntry) => h.id));
    archive.handoffs.push(...oldHandoffs);
    state.handoffs = state.handoffs.filter((h: HandoffEntry) => !oldHandoffIds.has(h.id));
    moved += oldHandoffs.length;
  }

  const resolvedBlockers = state.blockers.filter((b: BlockerEntry) => b.status === 'resolved');
  if (resolvedBlockers.length > 0) {
    const resolvedIds = new Set(resolvedBlockers.map((b: BlockerEntry) => b.id));
    archive.blockers.push(...resolvedBlockers);
    state.blockers = state.blockers.filter((b: BlockerEntry) => !resolvedIds.has(b.id));
    moved += resolvedBlockers.length;
  }

  if (moved > 0) {
    writeArchive(archive);
  }

  return moved;
}

function truncateEventsFile(maxLines = 500) {
  if (!fs.existsSync(EVENTS_PATH)) {
    return 0;
  }
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return 0;
  }
  const trimmed = lines.slice(-maxLines);
  fs.writeFileSync(EVENTS_PATH, `${trimmed.join('\n')}\n`, 'utf8');
  return lines.length - maxLines;
}

// ── Snapshots ──────────────────────────────────────────────────────────────

const SNAPSHOT_DIR = path.join(COORD_DIR, 'snapshots');

function createSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
    const state = readState();
    const seq = getEventSeq();
    const snapshot = {
      seq,
      createdAt: nowIso(),
      state,
    };
    const filename = `snapshot_${String(seq)}_${String(Date.now())}.json`;
    fs.writeFileSync(
      path.join(SNAPSHOT_DIR, filename),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
    return { ok: true, seq, filename };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function cleanOldSnapshots(retentionCount = 5) {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return 0;
    const files = fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - retentionCount));
    for (const f of toDelete) {
      try {
        fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
      } catch {
        /* skip */
      }
    }
    return toDelete.length;
  } catch {
    return 0;
  }
}

// ── Idempotency ──────────────────────────────────────────────────────────

const idempotencyLog = new Map(); // key → timestamp
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function checkIdempotency(key: string) {
  if (key === '') return false;
  const now = Date.now();
  // Prune stale entries periodically
  if (idempotencyLog.size > 200) {
    for (const [k, ts] of idempotencyLog) {
      if (now - ts > IDEMPOTENCY_TTL_MS) idempotencyLog.delete(k);
    }
  }
  if (idempotencyLog.has(key)) return true;
  idempotencyLog.set(key, now);
  return false;
}

async function requestJson(method: string, url: string, body: unknown = null) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (ORCH_TOKEN !== '') {
    headers['x-ai-orch-token'] = ORCH_TOKEN;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  return { response, payload };
}

function printHelp() {
  console.log(`
Hydra Orchestrator Daemon

Usage:
  node orchestrator-daemon.mjs start [host=127.0.0.1] [port=4173]
  node orchestrator-daemon.mjs status [url=http://127.0.0.1:4173]
  node orchestrator-daemon.mjs stop [url=http://127.0.0.1:4173]

Environment:
  AI_ORCH_HOST   Host bind (default: 127.0.0.1)
  AI_ORCH_PORT   Port bind (default: 4173)
  AI_ORCH_TOKEN  Optional API token for write endpoints
  HYDRA_PROJECT  Override target project directory
`);
}

async function commandStatus(options: Record<string, string>) {
  const url = options['url'] ?? `http://${DEFAULT_HOST}:${String(DEFAULT_PORT)}`;
  try {
    const { response, payload } = await requestJson('GET', `${url}/health`);
    if (!response.ok) {
      console.error(
        `Daemon status check failed (${String(response.status)}): ${((payload as Record<string, unknown>)['error'] as string | null | undefined) ?? 'unknown error'}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(`Daemon not reachable at ${url}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function commandStop(options: Record<string, string>) {
  const url = options['url'] ?? `http://${DEFAULT_HOST}:${String(DEFAULT_PORT)}`;
  try {
    const { response, payload } = await requestJson('POST', `${url}/shutdown`);
    if (!response.ok) {
      console.error(
        `Failed to stop daemon (${String(response.status)}): ${((payload as Record<string, unknown>)['error'] as string | null | undefined) ?? 'unknown error'}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('Stop signal sent to orchestrator daemon.');
  } catch (err) {
    console.error(`Unable to reach daemon at ${url}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ── Worktree Isolation Helpers ───────────────────────────────────────────────

/**
 * Creates a git worktree for a task at .hydra/worktrees/task-{taskId}.
 * Returns the absolute worktree path on success, null on failure (caller falls
 * back to non-isolated dispatch).
 *
 * @param {string} taskId
 * @returns {string|null}
 */
function createTaskWorktree(taskId: string) {
  const cfg = loadHydraConfig();
  const worktreeDir = cfg.routing.worktreeIsolation.worktreeDir ?? '.hydra/worktrees';
  const worktreePath = path.resolve(config.projectRoot, worktreeDir, `task-${taskId}`);
  const branch = `hydra/task/${taskId}`;

  try {
    const result = git(['worktree', 'add', worktreePath, '-b', branch, 'HEAD'], config.projectRoot);
    if (result.status !== 0) {
      const errMsg = ([result.stderr, result.stdout] as string[]).find((s) => s !== '') ?? '';
      const errMsgTrimmed = errMsg.trim();
      console.warn(`[worktree] Failed to create worktree for task ${taskId}: ${errMsgTrimmed}`);
      return null;
    }
    return worktreePath;
  } catch (err) {
    console.warn(
      `[worktree] Exception creating worktree for task ${taskId}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Merges the task's worktree branch back to the current branch via smartMerge.
 * Returns { ok: true } on clean merge, { ok: false, conflict: true } on conflict,
 * { ok: false, error: string } on unexpected error.
 *
 * @param {string} taskId
 * @returns {{ ok: boolean, conflict?: boolean, error?: string }}
 */
function mergeTaskWorktree(taskId: string) {
  const branch = `hydra/task/${taskId}`;
  const currentBranch = getGitCurrentBranch(config.projectRoot);

  try {
    const result = smartMerge(config.projectRoot, branch, currentBranch);
    if (!result.ok) {
      const conflictList =
        (result as Record<string, unknown>)['conflicts'] != null &&
        ((result as Record<string, unknown>)['conflicts'] as string[]).length > 0
          ? ((result as Record<string, unknown>)['conflicts'] as string[]).join(', ')
          : '(unknown)';
      console.warn(
        `[worktree] Conflict merging task ${taskId} branch into ${currentBranch}: ${conflictList}`,
      );
      return { ok: false, conflict: true };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[worktree] Exception merging task ${taskId}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Removes the git worktree and branch for a task. Best-effort — does not throw.
 * Pass force: true to remove even if the worktree has uncommitted changes.
 *
 * @param {string} taskId
 * @param {{ force?: boolean }} [opts]
 */
function cleanupTaskWorktree(taskId: string, { force = false } = {}) {
  const cfg = loadHydraConfig();
  const worktreeDir = cfg.routing.worktreeIsolation.worktreeDir ?? '.hydra/worktrees';
  const worktreePath = path.resolve(config.projectRoot, worktreeDir, `task-${taskId}`);
  const branch = `hydra/task/${taskId}`;

  // Remove worktree
  try {
    const removeArgs = force
      ? ['worktree', 'remove', worktreePath, '--force']
      : ['worktree', 'remove', worktreePath];
    const result = git(removeArgs, config.projectRoot);
    if (result.status !== 0) {
      console.warn(
        `[worktree] Could not remove worktree for task ${taskId}: ${result.stderr.trim()}`,
      );
    }
  } catch (err) {
    console.warn(
      `[worktree] Exception removing worktree for task ${taskId}: ${(err as Error).message}`,
    );
  }

  // Delete branch
  try {
    const branchFlag = force ? '-D' : '-d';
    const result = git(['branch', branchFlag, branch], config.projectRoot);
    if (result.status !== 0) {
      console.warn(`[worktree] Could not delete branch ${branch}: ${result.stderr.trim()}`);
    }
  } catch (err) {
    console.warn(`[worktree] Exception deleting branch ${branch}: ${(err as Error).message}`);
  }
}

function startDaemon(options: Record<string, string>) {
  ensureCoordFiles();

  // Register built-in virtual sub-agents
  try {
    registerBuiltInSubAgents();
  } catch {
    /* sub-agents optional */
  }

  // Sync HYDRA.md → agent instruction files (silent)
  try {
    syncHydraMd(config.projectRoot);
  } catch {
    /* non-critical */
  }

  const host = options['host'] ?? DEFAULT_HOST;
  const port = Number.parseInt(options['port'] ?? String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Invalid port: ${options['port']}`);
    process.exitCode = 1;
    return;
  }

  let isShuttingDown = false;
  const startedAt = nowIso();
  let lastEventAt = nowIso();
  let eventCount = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  const sseClients = new Set<ServerResponse>();

  function broadcastEvent(event: unknown) {
    if (sseClients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function writeStatus(extra: Record<string, unknown> = {}) {
    const state = readState();
    const payload = {
      service: 'hydra-orchestrator',
      project: config.projectName,
      projectRoot: config.projectRoot,
      running: !isShuttingDown,
      pid: process.pid,
      host,
      port,
      startedAt,
      updatedAt: nowIso(),
      uptimeSec: Math.floor(process.uptime()),
      stateUpdatedAt: state.updatedAt,
      activeSessionId: state.activeSession?.id ?? null,
      eventsRecorded: eventCount,
      lastEventAt,
      ...extra,
    };
    fs.writeFileSync(STATUS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function enqueueMutation<T>(
    label: string,
    mutator: (state: HydraStateShape) => T,
    detail: Record<string, unknown> = {},
  ) {
    const mutation = writeQueue.then(() => {
      const state = readState();
      const result = mutator(state);
      writeState(state);
      appendSyncLog(`[orch] ${label}`);
      const at = nowIso();
      const event = {
        id: `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
        seq: getEventSeq() + 1,
        at,
        type: 'mutation',
        payload: { label, ...detail },
      };
      appendEvent('mutation', { label, ...detail });
      broadcastEvent(event);
      lastEventAt = at;
      eventCount += 1;
      writeStatus();
      return result;
    });
    // Prevent queue poisoning: failed mutations must not block subsequent ones
    writeQueue = mutation.catch(() => {});
    return mutation;
  }

  function runVerification(taskId: string, plan: Record<string, unknown>) {
    if (plan['enabled'] !== true || plan['command'] == null || plan['command'] === '') {
      return;
    }

    appendEvent('verification_start', { taskId, command: plan['command'], source: plan['source'] });

    function handleVerificationResult(error: Error | null, stdout: string, stderr: string) {
      if (error) {
        const snippet = ([stderr, stdout, error.message] as string[]).find((s) => s !== '') ?? '';
        const snippetSliced = snippet.slice(0, 500);
        void enqueueMutation(
          `verify:fail id=${taskId}`,
          (state: HydraStateShape) => {
            const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
            if (task) {
              task.status = 'blocked';
              const note = `[AUTO-VERIFY FAILED] ${String(plan['command'])}:\n${snippetSliced}`;
              task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
              task.updatedAt = nowIso();
            }
          },
          { event: 'verify', taskId, passed: false, command: plan['command'] },
        );
        appendEvent('verification_complete', {
          taskId,
          passed: false,
          command: plan['command'],
          snippet: snippetSliced,
        });
        return;
      }

      void enqueueMutation(
        `verify:pass id=${taskId}`,
        (state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            const note = `[AUTO-VERIFY PASSED] ${String(plan['command'])} completed cleanly.`;
            task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
            task.updatedAt = nowIso();
          }
        },
        { event: 'verify', taskId, passed: true, command: plan['command'] },
      );
      appendEvent('verification_complete', { taskId, passed: true, command: plan['command'] });
    }

    // Prefer exec (captures stdout/stderr) when possible, but fall back to a
    // no-pipes spawn mode for restricted sandboxes that forbid stdio pipes.
    try {
      exec(
        plan['command'] as string,
        { cwd: config.projectRoot, timeout: plan['timeoutMs'] as number, encoding: 'utf8' },
        handleVerificationResult,
      );
      return;
    } catch {
      // Fall through to spawn-based implementation below.
    }

    // No-pipes fallback: redirect stdout/stderr to temp files and read them at the end.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-verify-'));
    const stdoutPath = path.join(tmpDir, 'stdout.txt');
    const stderrPath = path.join(tmpDir, 'stderr.txt');

    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    try {
      stdoutFd = fs.openSync(stdoutPath, 'w');
      stderrFd = fs.openSync(stderrPath, 'w');

      const child = spawn(plan['command'] as string, [], {
        cwd: config.projectRoot,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });

      // Parent can close immediately; child holds its own handles.
      try {
        fs.closeSync(stdoutFd);
      } catch {
        /* ignore */
      }
      try {
        fs.closeSync(stderrFd);
      } catch {
        /* ignore */
      }
      stdoutFd = null;
      stderrFd = null;

      let timedOut = false;
      let finished = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        },
        Math.max(1, (plan['timeoutMs'] as number) === 0 ? 60_000 : (plan['timeoutMs'] as number)),
      );

      function finish(err: Error | null, code: number | null) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        let out = '';
        let errText = '';
        try {
          out = fs.readFileSync(stdoutPath, 'utf8');
        } catch {
          /* ignore */
        }
        try {
          errText = fs.readFileSync(stderrPath, 'utf8');
        } catch {
          /* ignore */
        }
        const effectiveError =
          err ??
          (timedOut || code !== 0
            ? new Error(timedOut ? 'Verification timed out.' : `Exit ${String(code)}`)
            : null);
        handleVerificationResult(effectiveError, out, errText);
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }

      child.on('error', (err: Error) => {
        finish(err, null);
      });
      child.on('close', (code: number | null) => {
        finish(null, code);
      });
    } catch (err) {
      // If even the fallback can't start, treat as a failure but never throw.
      try {
        const msg = (
          (err as Error).message === '' ? 'Verification failed to start.' : (err as Error).message
        ).slice(0, 500);
        handleVerificationResult(new Error(msg), '', '');
      } catch {
        // ignore
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } finally {
      if (stdoutFd !== null) {
        try {
          fs.closeSync(stdoutFd);
        } catch {
          /* ignore */
        }
      }
      if (stderrFd !== null) {
        try {
          fs.closeSync(stderrFd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async HTTP handler, errors caught in try/catch block
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${host}:${String(port)}`}`,
    );
    const route = requestUrl.pathname;
    const method = req.method ?? 'GET';

    try {
      const handledReadRoute = await handleReadRoute({
        method,
        route,
        requestUrl,
        req,
        res,
        sendJson,
        sendError,
        writeStatus,
        readStatus: () =>
          JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as Record<string, unknown>,
        checkUsage: checkUsage as unknown as () => UsageCheckResult,
        getModelSummary: getModelSummary as () => Record<string, ModelSummaryEntry>,
        readState,
        getSummary,
        projectRoot: config.projectRoot,
        projectName: config.projectName,
        buildPrompt,
        suggestNext,
        readEvents,
        replayEvents,
        sseClients,
        readArchive,
        getMetricsSummary,
        getEventCount: () => eventCount,
      });
      if (handledReadRoute) {
        return;
      }

      if (!isAuthorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }

      const handledWriteRoute = await handleWriteRoute({
        method,
        route,
        req,
        res,
        readJsonBody,
        sendJson,
        sendError,
        enqueueMutation,
        ensureKnownAgent,
        ensureKnownStatus,
        parseList,
        getCurrentBranch,
        toSessionId,
        nowIso,
        classifyTask,
        nextId,
        detectCycle,
        autoUnblock: autoUnblock as (state: HydraStateShape, completedTaskId?: string) => void,
        readState,
        AGENT_NAMES,
        getAgent: getAgent as (name: string) => AgentDef | undefined,
        listAgents: listAgents as (...args: unknown[]) => AgentDef[],
        resolveVerificationPlan: resolveVerificationPlan as unknown as (
          ...args: unknown[]
        ) => Record<string, unknown>,
        projectRoot: config.projectRoot,
        runVerification: runVerification as (...args: unknown[]) => void,
        archiveState,
        truncateEventsFile,
        writeStatus,
        appendEvent,
        broadcastEvent,
        setIsShuttingDown: (value: boolean) => {
          isShuttingDown = value;
        },
        server,
        createSnapshot,
        cleanOldSnapshots,
        checkIdempotency,
        createTaskWorktree,
        mergeTaskWorktree,
        cleanupTaskWorktree,
      } as unknown as WriteRouteCtx);
      if (handledWriteRoute) {
        return;
      }

      sendError(res, 404, `Route not found: ${method} ${route}`);
    } catch (err) {
      sendError(res, 400, (err as Error).message === '' ? 'Bad request' : (err as Error).message);
    }
  });

  server.on('error', (error: Error) => {
    console.error(`Orchestrator server error: ${error.message}`);
    // eslint-disable-next-line n/no-process-exit -- server error handler requires forced exit
    process.exit(1);
  });

  function autoArchiveIfNeeded() {
    void enqueueMutation('auto_archive', (state: HydraStateShape) => {
      const completedCount = state.tasks.filter((t: TaskEntry) =>
        ['done', 'cancelled'].includes(t.status),
      ).length;
      if (completedCount > 20) {
        const moved = archiveState(state);
        if (moved > 0) {
          truncateEventsFile(500);
          return { moved };
        }
      }
      return { moved: 0 };
    })
      .then((result: Record<string, unknown>) => {
        if ((result['moved'] as number) > 0) {
          appendEvent('auto_archive', { moved: result['moved'] });
        }
      })
      .catch(() => {});
  }

  // Load persisted metrics from previous session
  loadPersistedMetrics(COORD_DIR);

  server.listen(port, host, () => {
    appendSyncLog(`[orch] daemon started at http://${host}:${String(port)}`);
    appendEvent('daemon_start', {
      host,
      port: String(port),
      pid: process.pid,
      project: config.projectName,
    });
    writeStatus();

    autoArchiveIfNeeded();

    console.log(hydraSplash());
    console.log(uiLabel('Project', pc.white(config.projectName)));
    console.log(uiLabel('Root', DIM(config.projectRoot)));
    console.log(uiLabel('URL', pc.white(`http://${host}:${String(port)}`)));
    console.log(uiLabel('PID', pc.white(String(process.pid))));
    console.log(uiLabel('State', DIM(path.relative(config.projectRoot, STATE_PATH))));
    console.log(uiLabel('Status', DIM(path.relative(config.projectRoot, STATUS_PATH))));
    console.log(divider());
    console.log(SUCCESS('  Daemon ready'));
    console.log('');
  });

  const statusInterval = setInterval(() => {
    writeStatus();
  }, 5000);

  const metricsInterval = setInterval(() => {
    persistMetrics(COORD_DIR);
  }, 30_000);

  const archiveInterval = setInterval(
    () => {
      autoArchiveIfNeeded();
    },
    30 * 60 * 1000,
  );

  // Stale task reaper: uses heartbeat timeout (fast) or updatedAt fallback (slow)
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — no-heartbeat fallback

  function markStaleTasks() {
    try {
      const cfg = loadHydraConfig();
      const heartbeatTimeoutMsRaw = Number(
        ((cfg as Record<string, unknown>)['workers'] as Record<string, unknown> | undefined)?.[
          'heartbeatTimeoutMs'
        ],
      );
      const heartbeatTimeoutMs = heartbeatTimeoutMsRaw === 0 ? 90_000 : heartbeatTimeoutMsRaw; // 90s default
      const maxAttemptsRaw = Number(
        (
          ((cfg as Record<string, unknown>)['workers'] as Record<string, unknown> | undefined)?.[
            'retry'
          ] as Record<string, unknown> | undefined
        )?.['maxAttempts'],
      );
      const maxAttempts = maxAttemptsRaw === 0 ? 3 : maxAttemptsRaw;
      const state = readState();
      const now = Date.now();
      let changed = false;

      for (const task of state.tasks) {
        if (task.status !== 'in_progress') continue;

        let isStale = false;

        if ((task as Record<string, unknown>)['lastHeartbeat'] == null) {
          // Legacy: use updatedAt/checkpoint (30 min)
          let lastActivity = task.updatedAt === '' ? 0 : new Date(task.updatedAt).getTime();
          if (Array.isArray(task.checkpoints) && task.checkpoints.length > 0) {
            const lastCp = task.checkpoints.at(-1);
            const cpTime = lastCp ? new Date(lastCp['savedAt'] as string).getTime() : 0;
            if (cpTime > lastActivity) lastActivity = cpTime;
          }
          isStale = now - lastActivity > STALE_THRESHOLD_MS;
        } else {
          const hbAge =
            now - new Date((task as Record<string, unknown>)['lastHeartbeat'] as string).getTime();
          isStale = hbAge > heartbeatTimeoutMs;
        }

        if (isStale && task.stale !== true) {
          task.stale = true;
          task.staleSince = nowIso();
          changed = true;

          // Heartbeat timeout: requeue or dead-letter based on failCount
          if ((task as Record<string, unknown>)['lastHeartbeat'] == null) {
            broadcastEvent({
              type: 'mutation',
              payload: {
                event: 'task_stale',
                taskId: task.id,
                owner: task.owner,
                title: task.title,
              },
            });
          } else {
            const currentFailCount = (task as Record<string, unknown>)['failCount'] as
              | number
              | undefined;
            const failCount = (currentFailCount ?? 0) + 1;
            (task as Record<string, unknown>)['failCount'] = failCount;

            if (failCount < maxAttempts) {
              // Requeue: reset to todo for retry
              task.status = 'todo';
              task.stale = false;
              delete task.staleSince;
              task.updatedAt = nowIso();
              broadcastEvent({
                type: 'mutation',
                payload: {
                  event: 'task:heartbeat_timeout',
                  taskId: task.id,
                  owner: task.owner,
                  action: 'requeue',
                  failCount,
                },
              });
              appendEvent('task:heartbeat_timeout', {
                taskId: task.id,
                owner: task.owner,
                action: 'requeue',
                failCount,
                category: 'heartbeat',
              });
            } else {
              // Exhausted retries → dead-letter queue
              if (!Array.isArray(state['deadLetter'])) state['deadLetter'] = [];
              (state['deadLetter'] as unknown[]).push({
                id: task.id,
                title: task.title,
                owner: task.owner,
                failCount,
                reason: 'heartbeat_timeout',
                movedAt: nowIso(),
              });
              (task as Record<string, unknown>)['status'] = 'failed';
              task.updatedAt = nowIso();
              broadcastEvent({
                type: 'mutation',
                payload: {
                  event: 'task:heartbeat_timeout',
                  taskId: task.id,
                  owner: task.owner,
                  action: 'dead_letter',
                  failCount,
                },
              });
              appendEvent('task:heartbeat_timeout', {
                taskId: task.id,
                owner: task.owner,
                action: 'dead_letter',
                failCount,
                category: 'heartbeat',
              });
            }
          }
        } else if (!isStale && task.stale === true) {
          task.stale = false;
          delete task.staleSince;
          changed = true;
        }
      }

      if (changed) {
        writeState(state);
      }
    } catch {
      // Non-critical — skip silently.
    }
  }

  const staleInterval = setInterval(() => {
    markStaleTasks();
  }, 60 * 1000); // 60s — frequent enough for heartbeat timeouts

  function gracefulExit(signal: string) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.log('');
    console.log(DIM(`  Shutting down (${signal})...`));
    appendSyncLog(`[orch] daemon stopping (${signal})`);
    appendEvent('daemon_stop', { signal, pid: process.pid });
    // Close all SSE clients
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    // Close MCP clients
    void import('./hydra-mcp.ts').then((m) => m.closeCodexMCP()).catch(() => {});
    persistMetrics(COORD_DIR);
    clearInterval(statusInterval);
    clearInterval(metricsInterval);
    clearInterval(archiveInterval);
    clearInterval(staleInterval);
    writeStatus({ running: false, stoppingAt: nowIso(), signal });
    server.close(() => {
      writeStatus({ running: false, stoppedAt: nowIso(), signal });
      console.log(SUCCESS('  Daemon stopped'));
      // eslint-disable-next-line n/no-process-exit -- server.close callback requires forced exit after cleanup
      process.exit(0);
    });
  }

  // SIGTERM is not reliably delivered on Windows; use HTTP POST /stop for graceful shutdown there.
  process.on('SIGINT', () => {
    gracefulExit('SIGINT');
  });
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => {
      gracefulExit('SIGTERM');
    });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'start':
      startDaemon(options);
      return;
    case 'status':
      await commandStatus(options);
      return;
    case 'stop':
      await commandStop(options);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

void main();
