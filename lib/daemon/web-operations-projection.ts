/**
 * Queue snapshot projection — normalizes daemon state into browser-safe
 * WorkQueueItemView DTOs for the operations panels.
 *
 * The daemon is the authority for status normalization, ordering, and
 * relationship hints. The browser renders these projections without
 * inferring state from raw internals.
 */

import type { ActiveSessionEntry, HydraStateShape, TaskEntry, TaskStatus } from '../types.ts';
import type { WorkItemStatus, WorkQueueItemView, RiskSignal } from '@hydra/web-contracts';

// ── Status Normalization ───────────────────────────────────────────────────

export const DAEMON_TO_WORK_ITEM_STATUS: Readonly<Record<TaskStatus, WorkItemStatus>> = {
  todo: 'waiting',
  in_progress: 'active',
  blocked: 'blocked',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function normalizeTaskStatus(status: string): WorkItemStatus {
  return Object.hasOwn(DAEMON_TO_WORK_ITEM_STATUS, status)
    ? DAEMON_TO_WORK_ITEM_STATUS[status as TaskStatus]
    : 'waiting';
}

function resolveProjectedStatus(
  task: TaskEntry,
  activeSession: ActiveSessionEntry | null | undefined,
): WorkItemStatus {
  if (
    task.status === 'in_progress' &&
    activeSession?.status === 'paused' &&
    activeSession.owner === task.owner
  ) {
    return 'paused';
  }

  return normalizeTaskStatus(task.status);
}

// ── Ordering ───────────────────────────────────────────────────────────────

const STATUS_ORDER: Readonly<Record<WorkItemStatus, number>> = {
  active: 0,
  paused: 1,
  blocked: 2,
  waiting: 3,
  completed: 4,
  failed: 5,
  cancelled: 6,
};

function compareQueueItems(a: WorkQueueItemView, b: WorkQueueItemView): number {
  const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (statusDiff !== 0) return statusDiff;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

// ── Risk Signals ───────────────────────────────────────────────────────────

function buildRiskSignals(task: TaskEntry, normalized: WorkItemStatus): readonly RiskSignal[] {
  const signals: RiskSignal[] = [];

  if (task.stale === true) {
    signals.push({
      kind: 'stale',
      severity: 'warning',
      summary: 'Task has not been updated recently',
      scope: `task:${task.id}`,
    });
  }

  if (normalized === 'blocked' && Array.isArray(task.blockedBy) && task.blockedBy.length > 0) {
    signals.push({
      kind: 'waiting',
      severity: 'info',
      summary: `Blocked by ${String(task.blockedBy.length)} task(s): ${task.blockedBy.join(', ')}`,
      scope: `task:${task.id}`,
    });
  }

  return signals;
}

// ── Projection ─────────────────────────────────────────────────────────────

function projectTaskToQueueItem(
  task: TaskEntry,
  activeSession: ActiveSessionEntry | null | undefined,
): WorkQueueItemView {
  const status = resolveProjectedStatus(task, activeSession);
  const checkpoints = task.checkpoints ?? [];
  const lastCheckpoint = checkpoints.at(-1) ?? null;
  const ownerLabel = task.owner === '' ? null : task.owner;
  const updatedAt = task.updatedAt === '' ? new Date().toISOString() : task.updatedAt;

  return {
    id: task.id,
    title: task.title,
    status,
    position: null, // assigned after ordering
    relatedConversationId: null, // not yet tracked in daemon state
    relatedSessionId: null, // set only when daemon has authoritative linkage
    ownerLabel,
    lastCheckpointSummary: lastCheckpoint?.note ?? null,
    updatedAt,
    riskSignals: buildRiskSignals(task, status),
    detailAvailability: 'partial', // full detail requires per-item query (US2)
  };
}

export interface QueueSnapshotOptions {
  statusFilter?: readonly WorkItemStatus[];
  limit?: number;
  cursor?: string;
}

export interface QueueSnapshotResult {
  queue: readonly WorkQueueItemView[];
  health: null;
  budget: null;
  availability: 'ready' | 'empty' | 'partial' | 'unavailable';
  lastSynchronizedAt: string | null;
  nextCursor: string | null;
}

export function projectQueueSnapshot(
  state: HydraStateShape,
  options: QueueSnapshotOptions = {},
): QueueSnapshotResult {
  const { statusFilter, limit } = options;

  let items: WorkQueueItemView[] = state.tasks.map((task) =>
    projectTaskToQueueItem(task, state.activeSession),
  );

  if (statusFilter != null && statusFilter.length > 0) {
    const filterSet = new Set<WorkItemStatus>(statusFilter);
    items = items.filter((item) => filterSet.has(item.status));
  }

  items.sort(compareQueueItems);

  // Assign position numbers: non-terminal items get sequential positions
  let position = 0;
  for (const item of items) {
    if (TERMINAL_STATUSES.has(item.status)) {
      (item as { position: number | null }).position = null;
    } else {
      (item as { position: number | null }).position = position;
      position += 1;
    }
  }

  if (options.cursor != null && options.cursor !== '') {
    const cursorIndex = items.findIndex((item) => item.id === options.cursor);
    if (cursorIndex >= 0) {
      items = items.slice(cursorIndex + 1);
    }
  }

  let nextCursor: string | null = null;
  if (limit != null && limit > 0 && items.length > limit) {
    nextCursor = items[limit - 1].id;
    items = items.slice(0, limit);
  }

  const availability = items.length > 0 || state.tasks.length > 0 ? 'ready' : 'empty';

  return {
    queue: items,
    health: null, // daemon health projection is a later US
    budget: null, // budget projection is a later US
    availability,
    lastSynchronizedAt: state.updatedAt ?? null,
    nextCursor,
  };
}
