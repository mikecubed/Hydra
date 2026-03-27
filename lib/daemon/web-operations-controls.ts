/**
 * Operations Controls — daemon-authoritative control discovery, eligibility,
 * authority, revision tokens, and mutation execution.
 *
 * The daemon is the sole authority for which controls are actionable, what
 * options are available, and whether a mutation request is accepted, rejected,
 * stale, or superseded. The browser and gateway never infer eligibility.
 */

import crypto from 'node:crypto';
import type { HydraStateShape, TaskEntry } from '../types.ts';
import type {
  ControlKind,
  ControlAvailability,
  ControlAuthority,
  OperationalControlView,
  DetailAvailability,
} from '@hydra/web-contracts';
import type {
  ControlOutcome,
  SubmitControlActionRequest,
  WorkItemControlEntry,
} from '@hydra/web-contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ControlMutationResult {
  outcome: ControlOutcome;
  control: OperationalControlView;
  workItemId: string;
  resolvedAt: string;
  message?: string;
}

export interface ControlContext {
  loadConfig: () => { mode: string; routing: { mode: string } };
  agentNames: readonly string[];
  nowIso: () => string;
}

// ── Revision Tokens ───────────────────────────────────────────────────────────

/**
 * Compute a deterministic revision token from the task's mutable control-relevant
 * fields. This token changes whenever routing, mode, owner, or status mutates,
 * providing optimistic concurrency for control mutations.
 */
export function computeRevisionToken(task: TaskEntry): string {
  const parts = [
    task.id,
    task.owner,
    task.status,
    task.updatedAt,
    JSON.stringify((task as Record<string, unknown>)['routingHistory'] ?? ''),
  ];
  // Use a deterministic SHA-256 hash for revision tokens — we care about stability, not secrecy.
  // crypto.createHash is available in Node.js without external deps.
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// ── Terminal / Non-Actionable Detection ───────────────────────────────────────

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);

function isTerminalTask(task: TaskEntry): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

// ── Option Builders ───────────────────────────────────────────────────────────

interface ControlOption {
  optionId: string;
  label: string;
  selected: boolean;
  available: boolean;
}

const ASSIGNMENT_STATE_BY_TASK_STATUS: Readonly<Record<string, string>> = {
  todo: 'waiting',
  in_progress: 'active',
  blocked: 'waiting',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

function getRoutingStrategy(task: TaskEntry, config: ControlContext): string {
  const taskValue = (task as Record<string, unknown>)['routingStrategy'];
  if (typeof taskValue === 'string' && taskValue !== '') {
    return taskValue;
  }

  try {
    return config.loadConfig().routing.mode;
  } catch {
    return 'balanced';
  }
}

function ensureHistoryList(task: TaskEntry, key: string): Record<string, unknown>[] {
  const existing = (task as Record<string, unknown>)[key];
  if (Array.isArray(existing)) {
    return existing.filter(
      (entry): entry is Record<string, unknown> =>
        entry != null && typeof entry === 'object' && !Array.isArray(entry),
    );
  }

  return [];
}

function closeLatestAssignment(task: TaskEntry, now: string, state: string): void {
  const history = ensureHistoryList(task, 'assignmentHistory');
  const latest = history.at(-1);
  if (latest == null) {
    (task as Record<string, unknown>)['assignmentHistory'] = history;
    return;
  }

  latest['state'] = state;
  latest['endedAt'] = now;
  (task as Record<string, unknown>)['assignmentHistory'] = history;
}

function appendAssignmentHistory(task: TaskEntry, now: string, agent: string, state: string): void {
  const history = ensureHistoryList(task, 'assignmentHistory');
  history.push({
    agent,
    role: null,
    state,
    startedAt: now,
    endedAt: ['completed', 'failed', 'cancelled'].includes(state) ? now : null,
  });
  (task as Record<string, unknown>)['assignmentHistory'] = history;
}

function buildRoutingModeOptions(task: TaskEntry, config: ControlContext): ControlOption[] {
  const modes = ['auto', 'smart', 'council', 'dispatch', 'chat'];
  const currentMode = getCurrentMode(task, config);
  return modes.map((mode) => ({
    optionId: `mode-${mode}`,
    label: mode.charAt(0).toUpperCase() + mode.slice(1),
    selected: mode === currentMode,
    available: !isTerminalTask(task),
  }));
}

function getCurrentMode(task: TaskEntry, config: ControlContext): string {
  const routingHistory = (task as Record<string, unknown>)['routingHistory'];
  let currentMode: string | null = null;
  if (Array.isArray(routingHistory) && routingHistory.length > 0) {
    for (let index = routingHistory.length - 1; index >= 0; index -= 1) {
      const latest: unknown = routingHistory[index];
      if (latest == null || typeof latest !== 'object') {
        continue;
      }
      const entry = latest as Record<string, unknown>;
      if (typeof entry['route'] !== 'string' || entry['route'] === '') {
        continue;
      }
      if (typeof entry['mode'] === 'string' && entry['mode'] !== '') {
        currentMode = entry['mode'];
        break;
      }
    }
  }
  if (currentMode == null) {
    try {
      currentMode = config.loadConfig().mode;
    } catch {
      currentMode = 'auto';
    }
  }
  return currentMode;
}

function buildAgentOptions(task: TaskEntry, config: ControlContext): ControlOption[] {
  const currentOwner = task.owner;
  return config.agentNames.map((agent) => ({
    optionId: `agent-${agent}`,
    label: agent,
    selected: agent === currentOwner,
    available: !isTerminalTask(task),
  }));
}

function buildRoutingStrategyOptions(task: TaskEntry, config: ControlContext): ControlOption[] {
  const strategies = ['economy', 'balanced', 'performance'];
  const current = getRoutingStrategy(task, config);
  return strategies.map((s) => ({
    optionId: `routing-${s}`,
    label: s.charAt(0).toUpperCase() + s.slice(1),
    selected: s === current,
    available: !isTerminalTask(task),
  }));
}

function buildCouncilOptions(task: TaskEntry): ControlOption[] {
  const councilHistory = (task as Record<string, unknown>)['councilHistory'];
  const hasCouncil = councilHistory != null;
  return [
    {
      optionId: 'council-request',
      label: 'Request Council',
      selected: hasCouncil,
      available: !isTerminalTask(task) && !hasCouncil,
    },
  ];
}

// ── Control Discovery ─────────────────────────────────────────────────────────

interface ControlSpec {
  kind: ControlKind;
  label: string;
  buildOptions: (task: TaskEntry, config: ControlContext) => ControlOption[];
}

const CONTROL_SPECS: readonly ControlSpec[] = [
  { kind: 'routing', label: 'Routing Strategy', buildOptions: buildRoutingStrategyOptions },
  { kind: 'mode', label: 'Dispatch Mode', buildOptions: buildRoutingModeOptions },
  { kind: 'agent', label: 'Agent Assignment', buildOptions: buildAgentOptions },
  { kind: 'council', label: 'Council Deliberation', buildOptions: buildCouncilOptions },
];

function resolveAvailability(task: TaskEntry): ControlAvailability {
  if (isTerminalTask(task)) return 'read-only';
  return 'actionable';
}

function resolveAuthority(task: TaskEntry): ControlAuthority {
  if (isTerminalTask(task)) return 'unavailable';
  return 'granted';
}

function resolveReason(task: TaskEntry): string | null {
  if (isTerminalTask(task)) return `Work item is ${task.status}`;
  return null;
}

/**
 * Discover all controls for a single work item.
 * Each control includes daemon-authoritative eligibility, authority,
 * options, and a revision token for optimistic concurrency.
 */
export function discoverControls(
  task: TaskEntry,
  config: ControlContext,
): readonly OperationalControlView[] {
  const availability = resolveAvailability(task);
  const authority = resolveAuthority(task);
  const reason = resolveReason(task);
  const revision = availability === 'actionable' ? computeRevisionToken(task) : null;

  return CONTROL_SPECS.map((spec) => ({
    controlId: `${task.id}:${spec.kind}`,
    kind: spec.kind,
    label: spec.label,
    availability,
    authority,
    reason,
    options: spec.buildOptions(task, config),
    expectedRevision: revision,
    lastResolvedAt: null,
  }));
}

/**
 * Discover controls for multiple work items in batch.
 */
export function discoverControlsBatch(
  state: HydraStateShape,
  workItemIds: readonly string[],
  config: ControlContext,
  kindFilter?: ControlKind,
): readonly WorkItemControlEntry[] {
  return workItemIds.map((workItemId) => {
    const task = state.tasks.find((t) => t.id === workItemId);
    if (task == null) {
      return {
        workItemId,
        controls: [],
        availability: 'unavailable' as DetailAvailability,
      };
    }
    let controls = discoverControls(task, config);
    if (kindFilter != null) {
      controls = controls.filter((c) => c.kind === kindFilter);
    }
    return {
      workItemId,
      controls,
      availability: 'ready' as DetailAvailability,
    };
  });
}

// ── Control Mutations ─────────────────────────────────────────────────────────

function buildResult(
  outcome: ControlOutcome,
  control: OperationalControlView,
  workItemId: string,
  resolvedAt: string,
  message?: string,
): ControlMutationResult {
  return { outcome, control, workItemId, resolvedAt, message };
}

function findCurrentControl(
  task: TaskEntry,
  controlId: string,
  config: ControlContext,
): OperationalControlView | undefined {
  return discoverControls(task, config).find((c) => c.controlId === controlId);
}

function buildOutcomeControl(
  outcome: ControlOutcome,
  control: OperationalControlView,
  resolvedAt: string,
  reason?: string,
): OperationalControlView {
  return {
    ...control,
    availability: outcome,
    reason: reason ?? control.reason,
    lastResolvedAt: resolvedAt,
  };
}

function buildRejectedResult(
  controlId: string,
  kind: ControlKind,
  workItemId: string,
  resolvedAt: string,
  reason: string,
  message: string,
): ControlMutationResult {
  return buildResult(
    'rejected',
    buildRejectedControl(controlId, kind, reason),
    workItemId,
    resolvedAt,
    message,
  );
}

interface MutationSetup {
  readonly now: string;
  readonly task: TaskEntry;
  readonly kind: ControlKind;
}

function resolveMutationSetup(
  state: HydraStateShape,
  request: SubmitControlActionRequest,
  config: ControlContext,
): MutationSetup | ControlMutationResult {
  const now = config.nowIso();
  const { workItemId, controlId, expectedRevision } = request;
  const task = state.tasks.find((entry) => entry.id === workItemId);
  const kind = extractKindFromControlId(controlId, workItemId);
  if (task == null) {
    return buildRejectedResult(
      controlId,
      kind ?? 'routing',
      workItemId,
      now,
      'Work item not found',
      `Work item ${workItemId} not found`,
    );
  }

  if (kind == null) {
    return buildRejectedResult(
      controlId,
      'routing',
      workItemId,
      now,
      'Invalid control ID',
      `Invalid control ID: ${controlId}`,
    );
  }

  if (expectedRevision !== computeRevisionToken(task)) {
    const currentControl = findCurrentControl(task, controlId, config);
    const control =
      currentControl == null
        ? buildStaleControl(controlId, kind, now)
        : buildOutcomeControl('stale', currentControl, now, 'Revision mismatch');
    return buildResult(
      'stale',
      control,
      workItemId,
      now,
      'Revision token mismatch — the work item state has changed since the last read',
    );
  }

  if (isTerminalTask(task)) {
    const control =
      findCurrentControl(task, controlId, config) ??
      buildRejectedControl(controlId, kind, `Work item is ${task.status}`);
    return buildResult(
      'rejected',
      control,
      workItemId,
      now,
      `Work item is ${task.status} and cannot be mutated`,
    );
  }

  return { now, task, kind };
}

/**
 * Execute a control mutation against daemon state.
 * Validates revision token, eligibility, and option availability.
 * Returns the authoritative outcome.
 */
export function executeControlMutation(
  state: HydraStateShape,
  request: SubmitControlActionRequest,
  config: ControlContext,
): ControlMutationResult {
  const { workItemId, controlId, requestedOptionId } = request;
  const setup = resolveMutationSetup(state, request, config);
  if ('outcome' in setup) {
    return setup;
  }
  const { now, task, kind } = setup;

  const spec = CONTROL_SPECS.find((s) => s.kind === kind);
  if (spec == null)
    return buildRejectedResult(
      controlId,
      kind,
      workItemId,
      now,
      'Unknown control kind',
      `Unknown control kind: ${kind}`,
    );

  const options = spec.buildOptions(task, config);
  const requestedOption = options.find((o) => o.optionId === requestedOptionId);
  if (requestedOption == null)
    return buildRejectedResult(
      controlId,
      kind,
      workItemId,
      now,
      'Unknown option',
      `Unknown option: ${requestedOptionId}`,
    );
  if (!requestedOption.available)
    return buildRejectedResult(
      controlId,
      kind,
      workItemId,
      now,
      'Option not available',
      `Option ${requestedOptionId} is not available`,
    );

  if (requestedOption.selected) {
    const currentControl = findCurrentControl(task, controlId, config);
    const ctrl =
      currentControl == null
        ? buildAcceptedControl(controlId, kind, now, 'superseded')
        : buildOutcomeControl('superseded', currentControl, now);
    return buildResult(
      'superseded',
      ctrl,
      workItemId,
      now,
      'Requested option is already the current value',
    );
  }
  applyControlMutation(task, kind, requestedOptionId, config);
  const updatedControl = findCurrentControl(task, controlId, config);
  return buildResult(
    'accepted',
    updatedControl == null
      ? buildAcceptedControl(controlId, kind, now, 'accepted')
      : buildOutcomeControl('accepted', updatedControl, now),
    workItemId,
    now,
    `Control ${kind} updated successfully`,
  );
}

// ── Mutation Applicators ──────────────────────────────────────────────────────

function applyControlMutation(
  task: TaskEntry,
  kind: ControlKind,
  optionId: string,
  config: ControlContext,
): void {
  const now = config.nowIso();
  switch (kind) {
    case 'mode': {
      const mode = optionId.replace('mode-', '');
      appendRoutingHistoryEntry(task, now, task.owner, mode, `Dispatch mode changed to ${mode}`);
      break;
    }
    case 'agent': {
      const agent = optionId.replace('agent-', '');
      const assignmentState = ASSIGNMENT_STATE_BY_TASK_STATUS[task.status] ?? 'waiting';
      const currentMode = getCurrentMode(task, config);
      closeLatestAssignment(task, now, assignmentState);
      task.owner = agent;
      appendRoutingHistoryEntry(task, now, agent, currentMode, `Agent reassigned to ${agent}`);
      appendAssignmentHistory(task, now, agent, assignmentState);
      break;
    }
    case 'routing': {
      const strategy = optionId.replace('routing-', '');
      (task as Record<string, unknown>)['routingStrategy'] = strategy;
      const currentMode = getCurrentMode(task, config);
      appendRoutingHistoryEntry(
        task,
        now,
        task.owner,
        currentMode,
        `Routing strategy changed to ${strategy}`,
      );
      break;
    }
    case 'council': {
      // Mark council as requested
      (task as Record<string, unknown>)['councilHistory'] = {
        status: 'waiting',
        participants: [],
        transitions: [],
        finalOutcome: null,
      };
      appendRoutingHistoryEntry(task, now, task.owner, 'council', 'Council deliberation requested');
      break;
    }
  }
  task.updatedAt = now;
}

function appendRoutingHistoryEntry(
  task: TaskEntry,
  now: string,
  route: string,
  mode: string | null,
  reason: string,
): void {
  const existing: unknown = (task as Record<string, unknown>)['routingHistory'];
  const history: Record<string, unknown>[] = Array.isArray(existing)
    ? (existing as Record<string, unknown>[])
    : [];
  history.push({ route, mode, changedAt: now, reason });
  (task as Record<string, unknown>)['routingHistory'] = history;
}

// ── Control View Builders ─────────────────────────────────────────────────────

function extractKindFromControlId(controlId: string, workItemId: string): ControlKind | null {
  const prefix = `${workItemId}:`;
  if (!controlId.startsWith(prefix)) return null;
  const kind = controlId.slice(prefix.length);
  const validKinds = new Set(['routing', 'mode', 'agent', 'council']);
  if (!validKinds.has(kind)) return null;
  return kind as ControlKind;
}

function buildRejectedControl(
  controlId: string,
  kind: ControlKind,
  reason: string,
): OperationalControlView {
  return {
    controlId,
    kind,
    label: 'Unknown',
    availability: 'rejected',
    authority: 'unavailable',
    reason,
    options: [],
    expectedRevision: null,
    lastResolvedAt: null,
  };
}

function buildStaleControl(
  controlId: string,
  kind: ControlKind,
  resolvedAt: string,
): OperationalControlView {
  return {
    controlId,
    kind,
    label: 'Unknown',
    availability: 'stale',
    authority: 'unavailable',
    reason: 'Revision mismatch',
    options: [],
    expectedRevision: null,
    lastResolvedAt: resolvedAt,
  };
}

function buildAcceptedControl(
  controlId: string,
  kind: ControlKind,
  resolvedAt: string,
  availability: Extract<ControlOutcome, 'accepted' | 'superseded'> = 'accepted',
): OperationalControlView {
  return {
    controlId,
    kind,
    label: 'Unknown',
    availability,
    authority: 'granted',
    reason: null,
    options: [],
    expectedRevision: null,
    lastResolvedAt: resolvedAt,
  };
}
