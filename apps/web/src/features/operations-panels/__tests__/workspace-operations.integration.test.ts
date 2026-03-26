/**
 * T014 / T023 — Workspace × operations integration tests.
 *
 * Pure-state integration tests verifying that the operations reducer,
 * selectors, and initial state produce the correct derived values for
 * the UI layer. Includes detail-sync workflows: selection triggers detail
 * fetch, checkpoint data flows through selectors, and snapshot refresh
 * reconciles detail state. Uses node:test (no DOM, no vitest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AgentAssignmentView,
  CheckpointRecordView,
  CouncilExecutionView,
  GetOperationsSnapshotResponse,
  GetWorkItemDetailResponse,
  RoutingDecisionView,
  WorkQueueItemView,
} from '@hydra/web-contracts';

import {
  createInitialOperationsState,
  reduceOperationsState,
  type OperationsAction,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectBudgetStatus,
  selectDetailAvailability,
  selectDetailFetchStatus,
  selectFilteredQueueItems,
  selectFreshness,
  selectHasPendingControl,
  selectHasDetail,
  selectHealthStatus,
  selectItemBudget,
  selectQueueItems,
  selectSelectedCheckpoints,
  selectSelectedCouncil,
  selectSelectedDetail,
  selectSelectedAssignments,
  selectSelectedRouting,
  selectSelectedWorkItemId,
  selectSnapshotStatus,
} from '../model/selectors.ts';
import type { OperationsWorkspaceState } from '../model/operations-types.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeQueueItem(overrides: Partial<WorkQueueItemView> = {}): WorkQueueItemView {
  return {
    id: 'wi-1',
    title: 'Test task',
    status: 'active',
    position: 0,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: null,
    lastCheckpointSummary: null,
    updatedAt: '2026-06-01T12:00:00.000Z',
    riskSignals: [],
    detailAvailability: 'ready',
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<GetOperationsSnapshotResponse> = {},
): GetOperationsSnapshotResponse {
  return {
    queue: [],
    health: null,
    budget: null,
    availability: 'ready',
    lastSynchronizedAt: '2026-06-01T12:00:00.000Z',
    nextCursor: null,
    ...overrides,
  };
}

function makeDetailResponse(
  overrides: Partial<GetWorkItemDetailResponse> = {},
): GetWorkItemDetailResponse {
  return {
    item: makeQueueItem(),
    checkpoints: [],
    routing: null,
    assignments: [],
    council: null,
    controls: [],
    itemBudget: null,
    availability: 'ready',
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<CheckpointRecordView> = {}): CheckpointRecordView {
  return {
    id: 'cp-1',
    sequence: 0,
    label: 'Init',
    status: 'reached',
    timestamp: '2026-06-01T12:00:00.000Z',
    detail: null,
    ...overrides,
  };
}

function makeRouting(overrides: Partial<RoutingDecisionView> = {}): RoutingDecisionView {
  return {
    currentRoute: 'codex',
    currentMode: 'auto',
    changedAt: '2026-06-01T12:00:00.000Z',
    history: [
      {
        id: 'route-1',
        route: 'codex',
        mode: 'auto',
        changedAt: '2026-06-01T12:00:00.000Z',
        reason: 'Fast path',
      },
    ],
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<AgentAssignmentView> = {}): AgentAssignmentView {
  return {
    participantId: 'codex',
    label: 'codex',
    role: 'implementer',
    state: 'active',
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

function makeCouncil(overrides: Partial<CouncilExecutionView> = {}): CouncilExecutionView {
  return {
    status: 'completed',
    participants: [
      makeAssignment({
        participantId: 'claude',
        label: 'claude',
        role: 'architect',
        state: 'completed',
      }),
      makeAssignment({
        participantId: 'gemini',
        label: 'gemini',
        role: 'analyst',
        state: 'completed',
      }),
    ],
    transitions: [
      {
        id: 'transition-1',
        label: 'Council decision',
        status: 'completed',
        timestamp: '2026-06-01T12:05:00.000Z',
        detail: 'Consensus reached',
      },
    ],
    finalOutcome: 'Ship with codex implementation.',
    ...overrides,
  };
}

function applyActions(
  state: OperationsWorkspaceState,
  actions: readonly OperationsAction[],
): OperationsWorkspaceState {
  let current = state;
  for (const action of actions) {
    current = reduceOperationsState(current, action);
  }
  return current;
}

// ─── Initial state ──────────────────────────────────────────────────────────

describe('workspace operations integration', () => {
  it('initial state is idle with empty queue', () => {
    const state = createInitialOperationsState();
    assert.equal(selectSnapshotStatus(state), 'idle');
    assert.deepEqual(selectQueueItems(state), []);
    assert.equal(selectAvailability(state), 'empty');
    assert.equal(selectFreshness(state), 'stale');
    assert.equal(selectSelectedWorkItemId(state), null);
  });

  // ─── Snapshot populates queue ───────────────────────────────────────────

  it('snapshot/success populates queue items for rendering', () => {
    const items = [
      makeQueueItem({ id: 'wi-1', title: 'Task A', status: 'active' }),
      makeQueueItem({ id: 'wi-2', title: 'Task B', status: 'waiting' }),
    ];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items, availability: 'ready' }) },
    ]);

    assert.equal(selectSnapshotStatus(state), 'ready');
    assert.equal(selectFreshness(state), 'live');
    assert.equal(selectAvailability(state), 'ready');

    const queue = selectQueueItems(state);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].title, 'Task A');
    assert.equal(queue[1].title, 'Task B');
  });

  // ─── Selection lifecycle ────────────────────────────────────────────────

  it('selecting a work item updates selection state', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
    ]);

    assert.equal(selectSelectedWorkItemId(state), 'wi-1');
  });

  it('deselecting clears selection', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/deselect' },
    ]);

    assert.equal(selectSelectedWorkItemId(state), null);
  });

  // ─── Filter lifecycle ───────────────────────────────────────────────────

  it('status filter restricts visible queue items', () => {
    const items = [
      makeQueueItem({ id: 'wi-1', status: 'active' }),
      makeQueueItem({ id: 'wi-2', status: 'waiting' }),
      makeQueueItem({ id: 'wi-3', status: 'completed' }),
    ];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'filters/set-status', statusFilter: ['active', 'waiting'] },
    ]);

    const filtered = selectFilteredQueueItems(state);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].id, 'wi-1');
    assert.equal(filtered[1].id, 'wi-2');
  });

  it('empty filter shows all queue items', () => {
    const items = [
      makeQueueItem({ id: 'wi-1', status: 'active' }),
      makeQueueItem({ id: 'wi-2', status: 'completed' }),
    ];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'filters/set-status', statusFilter: [] },
    ]);

    assert.equal(selectFilteredQueueItems(state).length, 2);
  });

  // ─── Snapshot refresh clears stale selection ────────────────────────────

  it('snapshot refresh clears selection when item disappears', () => {
    const items = [makeQueueItem({ id: 'wi-1' }), makeQueueItem({ id: 'wi-2' })];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-2' },
      // Refresh removes wi-2 from queue
      {
        type: 'snapshot/success',
        snapshot: makeSnapshot({ queue: [makeQueueItem({ id: 'wi-1' })] }),
      },
    ]);

    assert.equal(selectSelectedWorkItemId(state), null);
  });

  it('snapshot refresh preserves selection when item remains', () => {
    const items = [makeQueueItem({ id: 'wi-1' }), makeQueueItem({ id: 'wi-2' })];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      // Refresh keeps wi-1
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
    ]);

    assert.equal(selectSelectedWorkItemId(state), 'wi-1');
  });

  // ─── Pending control visibility ─────────────────────────────────────────

  it('pending control is visible for the targeted work item', () => {
    const state = applyActions(createInitialOperationsState(), [
      {
        type: 'controls/submit-pending',
        pending: {
          requestId: 'req-1',
          workItemId: 'wi-1',
          controlId: 'ctrl-1',
          submittedAt: '2026-06-01T12:00:00.000Z',
          requestedOptionId: 'opt-1',
        },
      },
    ]);

    assert.equal(selectHasPendingControl(state, 'wi-1'), true);
    assert.equal(selectHasPendingControl(state, 'wi-2'), false);
  });

  // ─── Error lifecycle ────────────────────────────────────────────────────

  it('snapshot failure transitions to error/stale', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/failure' },
    ]);

    assert.equal(selectSnapshotStatus(state), 'error');
    assert.equal(selectFreshness(state), 'stale');
  });

  it('snapshot failure after prior success preserves previous snapshot', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'snapshot/request' },
      { type: 'snapshot/failure' },
    ]);

    assert.equal(selectSnapshotStatus(state), 'error');
    assert.equal(selectQueueItems(state).length, 1);
  });

  it('keeps global health and budget separate from item-scoped risk signals', () => {
    const items = [
      makeQueueItem({
        id: 'wi-1',
        riskSignals: [
          { kind: 'budget', severity: 'warning', summary: 'Over budget', scope: 'task:wi-1' },
        ],
      }),
      makeQueueItem({ id: 'wi-2', riskSignals: [] }),
    ];
    const detail = makeDetailResponse({
      item: items[0],
      itemBudget: {
        status: 'unavailable',
        scope: 'work-item',
        scopeId: 'wi-1',
        summary: 'Per-item budget attribution is not yet available',
        used: null,
        limit: null,
        unit: null,
        complete: false,
      },
    });

    const state = applyActions(createInitialOperationsState(), [
      {
        type: 'snapshot/success',
        snapshot: makeSnapshot({
          queue: items,
          health: {
            status: 'degraded',
            scope: 'global',
            observedAt: '2026-06-01T12:00:00.000Z',
            message: 'Background probes are delayed',
            detailsAvailability: 'partial',
          },
          budget: {
            status: 'warning',
            scope: 'global',
            scopeId: null,
            summary: 'Budget usage at 85%',
            used: 8500,
            limit: 10_000,
            unit: 'tokens',
            complete: true,
          },
        }),
      },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(selectHealthStatus(state)?.scope, 'global');
    assert.equal(selectBudgetStatus(state)?.scope, 'global');
    assert.equal(selectBudgetStatus(state)?.status, 'warning');
    assert.equal(selectItemBudget(state)?.scope, 'work-item');
    assert.equal(selectItemBudget(state)?.scopeId, 'wi-1');
    assert.deepEqual(selectQueueItems(state)[0].riskSignals, [
      { kind: 'budget', severity: 'warning', summary: 'Over budget', scope: 'task:wi-1' },
    ]);
    assert.deepEqual(selectQueueItems(state)[1].riskSignals, []);
  });

  // ─── Detail selection + checkpoint workflow ─────────────────────────────

  it('selecting an item and loading detail makes checkpoints available via selector', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', sequence: 0, label: 'Init' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, label: 'Tests pass', status: 'waiting' }),
    ];
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wi-1' }),
      checkpoints,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(selectSelectedWorkItemId(state), 'wi-1');
    assert.equal(selectHasDetail(state), true);
    assert.equal(selectDetailAvailability(state), 'ready');

    const cps = selectSelectedCheckpoints(state);
    assert.equal(cps.length, 2);
    assert.equal(cps[0].label, 'Init');
    assert.equal(cps[1].label, 'Tests pass');
  });

  it('deselecting clears detail and checkpoint selectors', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wi-1' }),
      checkpoints: [makeCheckpoint()],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'selection/deselect' },
    ]);

    assert.equal(selectSelectedWorkItemId(state), null);
    assert.equal(selectHasDetail(state), false);
    assert.deepEqual(selectSelectedCheckpoints(state), []);
    assert.equal(selectDetailAvailability(state), null);
  });

  it('switching selection clears previous detail checkpoints', () => {
    const items = [makeQueueItem({ id: 'wi-1' }), makeQueueItem({ id: 'wi-2' })];
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wi-1' }),
      checkpoints: [makeCheckpoint({ id: 'cp-1', label: 'Step 1' })],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'selection/select', workItemId: 'wi-2' },
    ]);

    assert.equal(selectSelectedWorkItemId(state), 'wi-2');
    assert.equal(selectHasDetail(state), false);
    assert.deepEqual(selectSelectedCheckpoints(state), []);
  });

  it('snapshot refresh reconciles detail item when item remains', () => {
    const items = [makeQueueItem({ id: 'wi-1', status: 'active' })];
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wi-1', status: 'active' }),
      checkpoints: [makeCheckpoint()],
    });
    const updatedItems = [
      makeQueueItem({ id: 'wi-1', status: 'paused', detailAvailability: 'partial' }),
    ];

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: updatedItems }) },
    ]);

    assert.equal(selectSelectedWorkItemId(state), 'wi-1');
    assert.equal(selectHasDetail(state), true);
    const loadedDetail = selectSelectedDetail(state);
    assert.equal(loadedDetail?.item.status, 'paused');
    assert.equal(selectDetailAvailability(state), 'partial');
    // Checkpoints are preserved from the detail response
    assert.equal(selectSelectedCheckpoints(state).length, 1);
  });

  it('snapshot refresh clears detail when selected item disappears', () => {
    const items = [makeQueueItem({ id: 'wi-1' }), makeQueueItem({ id: 'wi-2' })];
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wi-1' }),
      checkpoints: [makeCheckpoint()],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
      {
        type: 'snapshot/success',
        snapshot: makeSnapshot({ queue: [makeQueueItem({ id: 'wi-2' })] }),
      },
    ]);

    assert.equal(selectSelectedWorkItemId(state), null);
    assert.equal(selectHasDetail(state), false);
    assert.deepEqual(selectSelectedCheckpoints(state), []);
  });

  it('detail-loaded exposes routing, assignment, and council history through the selected-item selectors', () => {
    const items = [makeQueueItem({ id: 'wi-1', detailAvailability: 'ready' })];
    const detail = makeDetailResponse({
      item: items[0],
      routing: makeRouting(),
      assignments: [makeAssignment()],
      council: makeCouncil(),
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(selectSelectedRouting(state)?.currentRoute, 'codex');
    assert.equal(selectSelectedAssignments(state).length, 1);
    assert.equal(selectSelectedAssignments(state)[0]?.participantId, 'codex');
    assert.equal(selectSelectedCouncil(state)?.participants.length, 2);
    assert.equal(selectSelectedCouncil(state)?.finalOutcome, 'Ship with codex implementation.');
  });

  it('snapshot refresh preserves loaded routing and participant history until a newer detail response arrives', () => {
    const queueItems = [
      makeQueueItem({ id: 'wi-1', status: 'active', detailAvailability: 'ready' }),
    ];
    const loadedDetail = makeDetailResponse({
      item: queueItems[0],
      routing: makeRouting({ currentRoute: 'codex' }),
      assignments: [makeAssignment({ participantId: 'codex', label: 'codex', state: 'active' })],
      council: makeCouncil(),
    });
    const refreshedQueueItems = [
      makeQueueItem({ id: 'wi-1', status: 'paused', detailAvailability: 'partial' }),
    ];
    const refreshedDetail = makeDetailResponse({
      item: refreshedQueueItems[0],
      routing: makeRouting({
        currentRoute: 'claude',
        currentMode: 'council',
        history: [
          {
            id: 'route-2',
            route: 'claude',
            mode: 'council',
            changedAt: '2026-06-01T12:10:00.000Z',
            reason: 'Council reroute',
          },
        ],
      }),
      assignments: [
        makeAssignment({ participantId: 'claude', label: 'claude', role: 'architect' }),
      ],
      council: makeCouncil({
        participants: [
          makeAssignment({
            participantId: 'claude',
            label: 'claude',
            role: 'architect',
            state: 'completed',
          }),
          makeAssignment({
            participantId: 'gemini',
            label: 'gemini',
            role: 'analyst',
            state: 'completed',
          }),
          makeAssignment({
            participantId: 'codex',
            label: 'codex',
            role: 'implementer',
            state: 'completed',
          }),
        ],
        finalOutcome: 'Route through council-approved claude handoff.',
      }),
      availability: 'ready',
    });

    const preservedState = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: queueItems }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loaded', detail: loadedDetail },
      {
        type: 'snapshot/success',
        snapshot: makeSnapshot({ queue: refreshedQueueItems, availability: 'partial' }),
      },
    ]);

    assert.equal(selectSelectedDetail(preservedState)?.item.status, 'paused');
    assert.equal(selectDetailAvailability(preservedState), 'partial');
    assert.equal(selectSelectedRouting(preservedState)?.currentRoute, 'codex');
    assert.equal(selectSelectedAssignments(preservedState)[0]?.participantId, 'codex');
    assert.equal(selectSelectedCouncil(preservedState)?.participants.length, 2);

    const convergedState = applyActions(preservedState, [
      { type: 'selection/detail-loaded', detail: refreshedDetail },
    ]);

    assert.equal(selectDetailAvailability(convergedState), 'ready');
    assert.equal(selectSelectedRouting(convergedState)?.currentRoute, 'claude');
    assert.equal(selectSelectedRouting(convergedState)?.currentMode, 'council');
    assert.equal(selectSelectedAssignments(convergedState)[0]?.participantId, 'claude');
    assert.equal(selectSelectedCouncil(convergedState)?.participants.length, 3);
    assert.equal(
      selectSelectedCouncil(convergedState)?.finalOutcome,
      'Route through council-approved claude handoff.',
    );
  });

  // ─── Detail fetch status lifecycle ──────────────────────────────────────

  it('detailFetchStatus is idle initially', () => {
    const state = createInitialOperationsState();
    assert.equal(selectDetailFetchStatus(state), 'idle');
  });

  it('detail-loading sets detailFetchStatus to loading', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loading' },
    ]);

    assert.equal(selectDetailFetchStatus(state), 'loading');
    assert.equal(selectHasDetail(state), false);
  });

  it('detail-loaded resets detailFetchStatus to idle', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];
    const detail = makeDetailResponse({ item: makeQueueItem({ id: 'wi-1' }) });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loading' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(selectDetailFetchStatus(state), 'idle');
    assert.equal(selectHasDetail(state), true);
  });

  it('detail-failed sets detailFetchStatus to error', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loading' },
      { type: 'selection/detail-failed' },
    ]);

    assert.equal(selectDetailFetchStatus(state), 'error');
    assert.equal(selectHasDetail(state), false);
  });

  it('switching selection resets detailFetchStatus to idle', () => {
    const items = [makeQueueItem({ id: 'wi-1' }), makeQueueItem({ id: 'wi-2' })];

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loading' },
      { type: 'selection/select', workItemId: 'wi-2' },
    ]);

    assert.equal(selectDetailFetchStatus(state), 'idle');
  });

  it('deselecting resets detailFetchStatus to idle from error', () => {
    const items = [makeQueueItem({ id: 'wi-1' })];

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: makeSnapshot({ queue: items }) },
      { type: 'selection/select', workItemId: 'wi-1' },
      { type: 'selection/detail-loading' },
      { type: 'selection/detail-failed' },
      { type: 'selection/deselect' },
    ]);

    assert.equal(selectDetailFetchStatus(state), 'idle');
  });
});
