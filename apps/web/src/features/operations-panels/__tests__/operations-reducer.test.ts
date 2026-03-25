/**
 * Tests for the operations panels reducer and selectors.
 *
 * Covers initial state construction, snapshot hydration, filter updates,
 * work-item selection/deselection, detail loading, control discovery,
 * pending control lifecycle, freshness transitions, and all pure selectors.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  BatchControlDiscoveryResponse,
  GetOperationsSnapshotResponse,
  GetWorkItemDetailResponse,
  OperationalControlView,
  PendingControlRequest,
  WorkQueueItemView,
} from '@hydra/web-contracts';

import {
  createInitialOperationsState,
  createRouteInitialOperationsState,
  reduceOperationsState,
  type OperationsAction,
} from '../model/operations-reducer.ts';

import type { OperationsWorkspaceState } from '../model/operations-types.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';
const LATER = '2026-06-01T12:05:00.000Z';

function makeQueueItem(overrides: Partial<WorkQueueItemView> = {}): WorkQueueItemView {
  return {
    id: 'wq-1',
    title: 'Task A',
    status: 'active',
    position: 0,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: null,
    lastCheckpointSummary: null,
    updatedAt: NOW,
    riskSignals: [],
    detailAvailability: 'ready',
    ...overrides,
  };
}

function makeControl(overrides: Partial<OperationalControlView> = {}): OperationalControlView {
  return {
    controlId: 'ctrl-1',
    kind: 'routing',
    label: 'Route override',
    availability: 'actionable',
    authority: 'granted',
    reason: null,
    options: [
      { optionId: 'opt-1', label: 'Option A', selected: false, available: true },
      { optionId: 'opt-2', label: 'Option B', selected: true, available: true },
    ],
    expectedRevision: 'rev-1',
    lastResolvedAt: null,
    ...overrides,
  };
}

function makeSnapshotResponse(
  overrides: Partial<GetOperationsSnapshotResponse> = {},
): GetOperationsSnapshotResponse {
  return {
    queue: [makeQueueItem()],
    health: null,
    budget: null,
    availability: 'ready',
    lastSynchronizedAt: NOW,
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
    controls: [makeControl()],
    itemBudget: null,
    availability: 'ready',
    ...overrides,
  };
}

function applyActions(
  state: OperationsWorkspaceState,
  actions: readonly OperationsAction[],
): OperationsWorkspaceState {
  return actions.reduce((s, action) => reduceOperationsState(s, action), state);
}

// ─── createInitialOperationsState ───────────────────────────────────────────

describe('createInitialOperationsState', () => {
  it('returns a valid idle state with empty collections', () => {
    const state = createInitialOperationsState();

    assert.equal(state.snapshotStatus, 'idle');
    assert.equal(state.snapshot, null);
    assert.equal(state.freshness, 'stale');
    assert.equal(state.availability, 'empty');
    assert.equal(state.lastSynchronizedAt, null);
    assert.deepEqual(state.filters.statusFilter, []);
    assert.equal(state.selection.selectedWorkItemId, null);
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
    assert.equal(state.controls.pendingByWorkItem.size, 0);
    assert.equal(state.controls.discovery, null);
  });
});

// ─── createRouteInitialOperationsState ──────────────────────────────────────

describe('createRouteInitialOperationsState', () => {
  it('starts as loading/refreshing so first paint shows the loading state', () => {
    const state = createRouteInitialOperationsState();

    assert.equal(state.snapshotStatus, 'loading');
    assert.equal(state.freshness, 'refreshing');
    assert.equal(state.snapshot, null);
    assert.equal(state.availability, 'empty');
  });
});

// ─── Snapshot lifecycle ─────────────────────────────────────────────────────

describe('snapshot lifecycle', () => {
  it('transitions to loading on snapshot/request', () => {
    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'snapshot/request',
    });

    assert.equal(state.snapshotStatus, 'loading');
    assert.equal(state.freshness, 'refreshing');
  });

  it('applies snapshot data on snapshot/success', () => {
    const snapshot = makeSnapshotResponse();
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.snapshotStatus, 'ready');
    assert.equal(state.freshness, 'live');
    assert.equal(state.availability, 'ready');
    assert.equal(state.lastSynchronizedAt, NOW);
    assert.deepEqual(state.snapshot, snapshot);
  });

  it('transitions to error on snapshot/failure', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/failure' },
    ]);

    assert.equal(state.snapshotStatus, 'error');
    assert.equal(state.freshness, 'stale');
  });

  it('preserves previous snapshot on failure after a prior success', () => {
    const snapshot = makeSnapshotResponse();
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
      { type: 'snapshot/request' },
      { type: 'snapshot/failure' },
    ]);

    assert.equal(state.snapshotStatus, 'error');
    assert.deepEqual(state.snapshot, snapshot);
    assert.equal(state.freshness, 'stale');
  });

  it('replaces snapshot on successive success', () => {
    const first = makeSnapshotResponse();
    const second = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-2', title: 'Task B' })],
      lastSynchronizedAt: LATER,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot: first },
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot: second },
    ]);

    assert.equal(state.snapshot?.queue.length, 1);
    assert.equal(state.snapshot?.queue[0].id, 'wq-2');
    assert.equal(state.lastSynchronizedAt, LATER);
  });

  it('clears selection and detail when the selected work item disappears on refresh', () => {
    const first = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-1', status: 'active', detailAvailability: 'ready' })],
    });
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1', status: 'active', detailAvailability: 'ready' }),
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: first },
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'snapshot/success', snapshot: makeSnapshotResponse({ queue: [] }) },
    ]);

    assert.equal(state.selection.selectedWorkItemId, null);
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
  });

  it('reconciles selected detail from refreshed snapshot queue data', () => {
    const first = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-1', status: 'active', detailAvailability: 'ready' })],
    });
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1', status: 'active', detailAvailability: 'ready' }),
      availability: 'ready',
    });
    const second = makeSnapshotResponse({
      queue: [
        makeQueueItem({ id: 'wq-1', status: 'completed', detailAvailability: 'unavailable' }),
      ],
      lastSynchronizedAt: LATER,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: first },
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'snapshot/success', snapshot: second },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.equal(state.selection.detail?.item.status, 'completed');
    assert.equal(state.selection.detail?.availability, 'unavailable');
    assert.equal(state.selection.detailAvailability, 'unavailable');
  });

  it('sets availability from the snapshot response', () => {
    const snapshot = makeSnapshotResponse({ availability: 'partial' });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.availability, 'partial');
  });
});

// ─── Filter updates ─────────────────────────────────────────────────────────

describe('filter updates', () => {
  it('sets status filter', () => {
    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'filters/set-status',
      statusFilter: ['active', 'paused'],
    });

    assert.deepEqual(state.filters.statusFilter, ['active', 'paused']);
  });

  it('clears status filter with an empty array', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'filters/set-status', statusFilter: ['active'] },
      { type: 'filters/set-status', statusFilter: [] },
    ]);

    assert.deepEqual(state.filters.statusFilter, []);
  });

  it('does not affect other state slices', () => {
    const initial = createInitialOperationsState();
    const state = reduceOperationsState(initial, {
      type: 'filters/set-status',
      statusFilter: ['failed'],
    });

    assert.equal(state.snapshotStatus, initial.snapshotStatus);
    assert.equal(state.snapshot, initial.snapshot);
    assert.equal(state.selection.selectedWorkItemId, initial.selection.selectedWorkItemId);
  });
});

// ─── Selection lifecycle ────────────────────────────────────────────────────

describe('selection lifecycle', () => {
  it('selects a work item by ID', () => {
    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'selection/select',
      workItemId: 'wq-1',
    });

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
  });

  it('clears detail when selecting a different item', () => {
    const detail = makeDetailResponse();
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'selection/select', workItemId: 'wq-2' },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-2');
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
  });

  it('preserves detail when re-selecting the same item', () => {
    const detail = makeDetailResponse();
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'selection/select', workItemId: 'wq-1' },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.deepEqual(state.selection.detail, detail);
  });

  it('clears selection on deselect', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/deselect' },
    ]);

    assert.equal(state.selection.selectedWorkItemId, null);
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
  });

  it('loads detail for selected item', () => {
    const detail = makeDetailResponse();
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.deepEqual(state.selection.detail, detail);
    assert.equal(state.selection.detailAvailability, 'ready');
  });

  it('ignores detail-loaded for a mismatched work item', () => {
    const detail = makeDetailResponse({ item: makeQueueItem({ id: 'wq-other' }) });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
  });
});

// ─── Controls lifecycle ─────────────────────────────────────────────────────

describe('controls lifecycle', () => {
  it('records a pending control action', () => {
    const pending: PendingControlRequest = {
      requestId: 'req-1',
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      submittedAt: NOW,
      requestedOptionId: 'opt-1',
    };

    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'controls/submit-pending',
      pending,
    });

    assert.equal(state.controls.pendingByWorkItem.size, 1);
    assert.deepEqual(state.controls.pendingByWorkItem.get('wq-1'), pending);
  });

  it('resolves a pending control on success', () => {
    const pending: PendingControlRequest = {
      requestId: 'req-1',
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      submittedAt: NOW,
      requestedOptionId: 'opt-1',
    };

    const state = applyActions(createInitialOperationsState(), [
      { type: 'controls/submit-pending', pending },
      { type: 'controls/submit-resolved', workItemId: 'wq-1' },
    ]);

    assert.equal(state.controls.pendingByWorkItem.size, 0);
  });

  it('resolves a pending control on rejection', () => {
    const pending: PendingControlRequest = {
      requestId: 'req-1',
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      submittedAt: NOW,
      requestedOptionId: 'opt-1',
    };

    const state = applyActions(createInitialOperationsState(), [
      { type: 'controls/submit-pending', pending },
      { type: 'controls/submit-resolved', workItemId: 'wq-1' },
    ]);

    assert.equal(state.controls.pendingByWorkItem.size, 0);
  });

  it('does not error when resolving an already-absent pending', () => {
    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'controls/submit-resolved',
      workItemId: 'wq-999',
    });

    assert.equal(state.controls.pendingByWorkItem.size, 0);
  });

  it('applies batch control discovery response', () => {
    const discovery: BatchControlDiscoveryResponse = {
      items: [
        {
          workItemId: 'wq-1',
          controls: [makeControl()],
          availability: 'ready',
        },
      ],
    };

    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'controls/discovery-loaded',
      discovery,
    });

    assert.deepEqual(state.controls.discovery, discovery);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('deselecting when nothing is selected is a no-op', () => {
    const state = createInitialOperationsState();
    const next = reduceOperationsState(state, { type: 'selection/deselect' });
    assert.equal(next, state);
  });
});
