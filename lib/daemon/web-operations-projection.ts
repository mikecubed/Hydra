/**
 * Queue snapshot projection — normalizes daemon state into browser-safe
 * WorkQueueItemView DTOs for the operations panels.
 *
 * The daemon is the authority for status normalization, ordering, and
 * relationship hints. The browser renders these projections without
 * inferring state from raw internals.
 */

import type { ActiveSessionEntry, HydraStateShape, TaskEntry, TaskStatus } from '../types.ts';
import type { UsageCheckResult } from '../types.ts';
import type {
  WorkItemStatus,
  WorkQueueItemView,
  RiskSignal,
  CheckpointStatus,
  CheckpointRecordView,
  DetailAvailability,
  DaemonHealthView,
  DaemonHealthStatus,
  HealthDetailsAvailability,
  BudgetStatusView,
  BudgetSeverity,
} from '@hydra/web-contracts';

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

// ── Health Projection ──────────────────────────────────────────────────────

export function projectDaemonHealth(
  statusData: Record<string, unknown> | null,
): DaemonHealthView {
  const observedAt = new Date().toISOString();

  if (statusData === null) {
    return {
      status: 'unavailable',
      scope: 'global',
      observedAt,
      message: 'Daemon status is not available',
      detailsAvailability: 'unavailable',
    };
  }

  const running = statusData['running'];

  let status: DaemonHealthStatus;
  let message: string | null = null;
  let detailsAvailability: HealthDetailsAvailability = 'ready';

  if (running === true) {
    status = 'healthy';
  } else if (running === false) {
    status = 'unavailable';
    message = 'Daemon is not running';
    detailsAvailability = 'partial';
  } else {
    status = 'unavailable';
    message = 'Daemon status could not be determined';
    detailsAvailability = 'unavailable';
  }

  return { status, scope: 'global', observedAt, message, detailsAvailability };
}

// ── Budget Projection ──────────────────────────────────────────────────────

const USAGE_LEVEL_TO_SEVERITY: Readonly<Record<string, BudgetSeverity>> = {
  normal: 'normal',
  warning: 'warning',
  critical: 'warning',
};

function resolveBudgetSeverity(
  usage: UsageCheckResult,
  used: number | null,
  limit: number | null,
  percent: number | null,
): BudgetSeverity {
  const isExceeded =
    (used !== null && limit !== null && used >= limit) || (percent !== null && percent >= 100);

  if (isExceeded) {
    return 'exceeded';
  }

  return USAGE_LEVEL_TO_SEVERITY[usage.level] ?? 'unavailable';
}

function resolveBudgetSummary(severity: BudgetSeverity, percent: number | null): string {
  if (severity === 'unavailable') {
    return 'Budget data is not available';
  }

  if (severity === 'exceeded') {
    return 'Daily token budget exceeded';
  }

  if (severity === 'warning') {
    return `Budget usage at ${String(percent ?? '?')}%`;
  }

  return 'Budget usage is within normal limits';
}

export function projectGlobalBudget(usage: UsageCheckResult): BudgetStatusView {
  const used = typeof usage.used === 'number' ? usage.used : null;
  const limit = typeof usage.budget === 'number' ? usage.budget : null;
  const percent = typeof usage.percent === 'number' ? usage.percent : null;
  const hasNumericData = used !== null && limit !== null;
  const severity = resolveBudgetSeverity(usage, used, limit, percent);
  const summary = resolveBudgetSummary(severity, percent);

  return {
    status: severity,
    scope: 'global',
    scopeId: null,
    summary,
    used,
    limit,
    unit: hasNumericData ? 'tokens' : null,
    complete: hasNumericData,
  };
}

export function projectItemBudget(workItemId: string): BudgetStatusView {
  return {
    status: 'unavailable',
    scope: 'work-item',
    scopeId: workItemId,
    summary: 'Per-item budget attribution is not yet available',
    used: null,
    limit: null,
    unit: null,
    complete: false,
  };
}

// ── Health/Budget Context ──────────────────────────────────────────────────

export interface HealthBudgetContext {
  statusData: Record<string, unknown>;
  usage: UsageCheckResult;
}

// ── Projection ─────────────────────────────────────────────────────────────

/** Deterministic epoch fallback when neither task nor daemon state carry a timestamp. */
const EPOCH_FALLBACK = '1970-01-01T00:00:00.000Z';

function resolveStateUpdatedAt(updatedAt: string | null | undefined): string {
  return updatedAt != null && updatedAt !== '' ? updatedAt : EPOCH_FALLBACK;
}

function resolveLastSynchronizedAt(updatedAt: string | null | undefined): string | null {
  return updatedAt != null && updatedAt !== '' ? updatedAt : null;
}

function projectTaskToQueueItem(
  task: TaskEntry,
  activeSession: ActiveSessionEntry | null | undefined,
  stateUpdatedAt: string,
): WorkQueueItemView {
  const status = resolveProjectedStatus(task, activeSession);
  const checkpoints = task.checkpoints ?? [];
  const lastCheckpoint = checkpoints.at(-1) ?? null;
  const ownerLabel = task.owner === '' ? null : task.owner;
  const updatedAt = task.updatedAt === '' ? stateUpdatedAt : task.updatedAt;

  const lastSummary =
    lastCheckpoint == null ? '' : resolveCheckpointLabel(lastCheckpoint as Record<string, unknown>);

  return {
    id: task.id,
    title: task.title,
    status,
    position: null, // assigned after ordering
    relatedConversationId: null, // not yet tracked in daemon state
    relatedSessionId: null, // set only when daemon has authoritative linkage
    ownerLabel,
    lastCheckpointSummary:
      lastSummary === '' || lastSummary === UNNAMED_CHECKPOINT_LABEL ? null : lastSummary,
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
  health: DaemonHealthView | null;
  budget: BudgetStatusView | null;
  availability: 'ready' | 'empty' | 'partial' | 'unavailable';
  lastSynchronizedAt: string | null;
  nextCursor: string | null;
}

function filterQueueItems(
  items: readonly WorkQueueItemView[],
  statusFilter: readonly WorkItemStatus[] | undefined,
): WorkQueueItemView[] {
  if (statusFilter == null || statusFilter.length === 0) {
    return [...items];
  }

  const filterSet = new Set<WorkItemStatus>(statusFilter);
  return items.filter((item) => filterSet.has(item.status));
}

function paginateQueueItems(
  items: readonly WorkQueueItemView[],
  cursor: string | undefined,
  limit: number | undefined,
): { items: WorkQueueItemView[]; nextCursor: string | null } {
  let nextItems = [...items];

  if (cursor != null && cursor !== '') {
    const cursorIndex = nextItems.findIndex((item) => item.id === cursor);
    if (cursorIndex >= 0) {
      nextItems = nextItems.slice(cursorIndex + 1);
    }
  }

  if (limit == null || limit <= 0 || nextItems.length <= limit) {
    return { items: nextItems, nextCursor: null };
  }

  return {
    items: nextItems.slice(0, limit),
    nextCursor: nextItems[limit - 1].id,
  };
}

/**
 * Assign sequential position numbers to a **sorted** list of queue items.
 * Non-terminal items receive 0-based positions; terminal items keep `null`.
 *
 * Extracted so that both snapshot and detail projections use the same logic.
 */
function assignQueuePositions(items: WorkQueueItemView[]): void {
  let pos = 0;
  for (const item of items) {
    if (TERMINAL_STATUSES.has(item.status)) {
      item.position = null;
    } else {
      item.position = pos;
      pos += 1;
    }
  }
}

function resolveHealthBudgetContext(
  statusData: Record<string, unknown> | null,
  usage: UsageCheckResult | null,
): HealthBudgetContext | null {
  if (statusData === null || usage === null) {
    return null;
  }

  return { statusData, usage };
}

export function projectQueueSnapshot(
  state: HydraStateShape,
  options: QueueSnapshotOptions = {},
  healthBudgetCtx?: HealthBudgetContext | null,
): QueueSnapshotResult {
  const stateUpdatedAt = resolveStateUpdatedAt(state.updatedAt);

  const projectedItems: WorkQueueItemView[] = state.tasks.map((task) =>
    projectTaskToQueueItem(task, state.activeSession, stateUpdatedAt),
  );

  // Sort and assign positions on the FULL queue first so that position numbers
  // are globally consistent with projectWorkItemDetail (which also uses the
  // full sorted queue).  Filtering and pagination happen afterwards and
  // preserve the already-assigned positions.
  projectedItems.sort(compareQueueItems);
  assignQueuePositions(projectedItems);

  const items = filterQueueItems(projectedItems, options.statusFilter);

  const { items: pagedItems, nextCursor } = paginateQueueItems(
    items,
    options.cursor,
    options.limit,
  );

  const availability = pagedItems.length > 0 || state.tasks.length > 0 ? 'ready' : 'empty';

  const resolvedHealthBudgetCtx = resolveHealthBudgetContext(
    healthBudgetCtx?.statusData ?? null,
    healthBudgetCtx?.usage ?? null,
  );
  let health: DaemonHealthView | null = null;
  let budget: BudgetStatusView | null = null;

  if (resolvedHealthBudgetCtx !== null) {
    health = projectDaemonHealth(resolvedHealthBudgetCtx.statusData);
    budget = projectGlobalBudget(resolvedHealthBudgetCtx.usage);
  }

  return {
    queue: pagedItems,
    health,
    budget,
    availability,
    lastSynchronizedAt: resolveLastSynchronizedAt(state.updatedAt),
    nextCursor,
  };
}

// ── Checkpoint Projection ──────────────────────────────────────────────────

const VALID_CHECKPOINT_STATUSES: ReadonlySet<string> = new Set([
  'reached',
  'waiting',
  'resumed',
  'recovered',
  'skipped',
]);

function resolveCheckpointStatus(raw: unknown): CheckpointStatus {
  if (typeof raw === 'string' && VALID_CHECKPOINT_STATUSES.has(raw)) {
    return raw as CheckpointStatus;
  }
  return 'reached';
}

/**
 * Resolve the human-readable label from a checkpoint entry.
 *
 * The daemon persists checkpoints with `{ name, savedAt, context, agent }` but
 * some legacy/test paths use `{ note, at, detail }`. We accept both shapes.
 */
/** Deterministic fallback when neither legacy `note` nor daemon `name` carry a value. */
const UNNAMED_CHECKPOINT_LABEL = '(checkpoint)';

function resolveCheckpointLabel(entry: Record<string, unknown>): string {
  const note = entry['note'];
  if (typeof note === 'string' && note !== '') return note;
  const name = entry['name'];
  if (typeof name === 'string' && name !== '') return name;
  return UNNAMED_CHECKPOINT_LABEL;
}

function resolveCheckpointTimestamp(entry: Record<string, unknown>): string {
  const at = entry['at'];
  if (typeof at === 'string' && at !== '') return at;
  const savedAt = entry['savedAt'];
  if (typeof savedAt === 'string' && savedAt !== '') return savedAt;
  return EPOCH_FALLBACK;
}

function resolveCheckpointDetail(entry: Record<string, unknown>): string | null {
  const detail = entry['detail'];
  if (typeof detail === 'string' && detail !== '') return detail;
  const context = entry['context'];
  if (typeof context === 'string' && context !== '') return context;
  return null;
}

export function projectCheckpoints(task: TaskEntry): readonly CheckpointRecordView[] {
  const entries = task.checkpoints ?? [];
  return entries.map((entry, index) => ({
    id: `${task.id}-cp-${String(index)}`,
    sequence: index,
    label: resolveCheckpointLabel(entry),
    status: resolveCheckpointStatus(entry['status']),
    timestamp: resolveCheckpointTimestamp(entry),
    detail: resolveCheckpointDetail(entry),
  }));
}

// ── Work Item Detail Projection ────────────────────────────────────────────

export interface WorkItemDetailResult {
  item: WorkQueueItemView;
  checkpoints: readonly CheckpointRecordView[];
  routing: null;
  assignments: readonly [];
  council: null;
  controls: readonly [];
  itemBudget: BudgetStatusView;
  availability: DetailAvailability;
}

export function projectWorkItemDetail(
  state: HydraStateShape,
  workItemId: string,
): WorkItemDetailResult | null {
  const task = state.tasks.find((t) => t.id === workItemId);
  if (task == null) return null;

  const stateUpdatedAt = resolveStateUpdatedAt(state.updatedAt);

  // Project ALL items and assign positions with the same ordering used by
  // projectQueueSnapshot so the detail position is always consistent.
  const allItems: WorkQueueItemView[] = state.tasks.map((t) =>
    projectTaskToQueueItem(t, state.activeSession, stateUpdatedAt),
  );
  allItems.sort(compareQueueItems);
  assignQueuePositions(allItems);

  const item = allItems.find((i) => i.id === workItemId);
  if (item == null) return null; // unreachable — task exists so its projection exists
  const checkpoints = projectCheckpoints(task);

  return {
    item,
    checkpoints,
    routing: null, // not yet tracked in daemon state
    assignments: [], // not yet tracked in daemon state
    council: null, // not yet tracked in daemon state
    controls: [], // not yet tracked in daemon state
    itemBudget: projectItemBudget(workItemId),
    availability: 'partial', // routing/assignments/council are untracked → partial
  };
}
