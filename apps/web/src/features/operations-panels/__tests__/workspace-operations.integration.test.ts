/**
 * T014 — Workspace × operations integration tests.
 *
 * Pure-state integration tests verifying that the operations reducer,
 * selectors, and initial state produce the correct derived values for
 * the UI layer. Uses node:test (no DOM, no vitest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GetOperationsSnapshotResponse, WorkQueueItemView } from '@hydra/web-contracts';

import {
  createInitialOperationsState,
  reduceOperationsState,
  type OperationsAction,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectFilteredQueueItems,
  selectFreshness,
  selectHasPendingControl,
  selectQueueItems,
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
});
