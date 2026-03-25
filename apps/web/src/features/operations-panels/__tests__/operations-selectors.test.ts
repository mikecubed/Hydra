import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  GetOperationsSnapshotResponse,
  GetWorkItemDetailResponse,
  OperationalControlView,
  PendingControlRequest,
  WorkQueueItemView,
} from '@hydra/web-contracts';
import {
  createInitialOperationsState,
  reduceOperationsState,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectControlsForSelectedItem,
  selectFilteredQueueItems,
  selectFreshness,
  selectHasPendingControl,
  selectHealthStatus,
  selectQueueItems,
  selectSelectedDetail,
  selectSelectedWorkItemId,
  selectSnapshotStatus,
  selectStatusFilter,
} from '../model/selectors.ts';

const NOW = '2026-03-22T10:00:00.000Z';

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
    health: {
      status: 'healthy',
      scope: 'global',
      observedAt: NOW,
      message: null,
      detailsAvailability: 'ready',
    },
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
    controls: [],
    itemBudget: null,
    availability: 'ready',
    ...overrides,
  };
}

describe('selectSnapshotStatus', () => {
  it('returns the current snapshot status', () => {
    assert.equal(selectSnapshotStatus(createInitialOperationsState()), 'idle');
  });
});

describe('selectQueueItems', () => {
  it('returns empty array when snapshot is null', () => {
    assert.deepEqual(selectQueueItems(createInitialOperationsState()), []);
  });

  it('returns queue items from snapshot', () => {
    const snapshot = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-1' }), makeQueueItem({ id: 'wq-2' })],
    });
    const state = reduceOperationsState(
      reduceOperationsState(createInitialOperationsState(), { type: 'snapshot/request' }),
      { type: 'snapshot/success', snapshot },
    );

    const items = selectQueueItems(state);
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'wq-1');
    assert.equal(items[1].id, 'wq-2');
  });
});

describe('selectFilteredQueueItems', () => {
  it('returns all items when no filter is set', () => {
    const snapshot = makeSnapshotResponse({
      queue: [
        makeQueueItem({ id: 'wq-1', status: 'active' }),
        makeQueueItem({ id: 'wq-2', status: 'completed' }),
      ],
    });
    const state = reduceOperationsState(
      reduceOperationsState(createInitialOperationsState(), { type: 'snapshot/request' }),
      { type: 'snapshot/success', snapshot },
    );

    assert.equal(selectFilteredQueueItems(state).length, 2);
  });

  it('filters items by status', () => {
    const snapshot = makeSnapshotResponse({
      queue: [
        makeQueueItem({ id: 'wq-1', status: 'active' }),
        makeQueueItem({ id: 'wq-2', status: 'completed' }),
        makeQueueItem({ id: 'wq-3', status: 'active' }),
      ],
    });
    let state = createInitialOperationsState();
    state = reduceOperationsState(state, { type: 'snapshot/request' });
    state = reduceOperationsState(state, { type: 'snapshot/success', snapshot });
    state = reduceOperationsState(state, { type: 'filters/set-status', statusFilter: ['active'] });

    const items = selectFilteredQueueItems(state);
    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.status === 'active'));
  });
});

describe('selectSelectedWorkItemId', () => {
  it('returns null initially', () => {
    assert.equal(selectSelectedWorkItemId(createInitialOperationsState()), null);
  });

  it('returns selected ID after selection', () => {
    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'selection/select',
      workItemId: 'wq-1',
    });
    assert.equal(selectSelectedWorkItemId(state), 'wq-1');
  });
});

describe('selectSelectedDetail', () => {
  it('returns null when no detail is loaded', () => {
    assert.equal(selectSelectedDetail(createInitialOperationsState()), null);
  });

  it('returns detail after loading', () => {
    const detail = makeDetailResponse();
    let state = createInitialOperationsState();
    state = reduceOperationsState(state, { type: 'selection/select', workItemId: 'wq-1' });
    state = reduceOperationsState(state, { type: 'selection/detail-loaded', detail });

    assert.deepEqual(selectSelectedDetail(state), detail);
  });
});

describe('selectStatusFilter', () => {
  it('returns empty array initially', () => {
    assert.deepEqual(selectStatusFilter(createInitialOperationsState()), []);
  });

  it('returns current filter after update', () => {
    const state = reduceOperationsState(createInitialOperationsState(), {
      type: 'filters/set-status',
      statusFilter: ['waiting', 'blocked'],
    });

    assert.deepEqual(selectStatusFilter(state), ['waiting', 'blocked']);
  });
});

describe('selectFreshness', () => {
  it('returns stale initially', () => {
    assert.equal(selectFreshness(createInitialOperationsState()), 'stale');
  });

  it('returns live after successful snapshot', () => {
    let state = createInitialOperationsState();
    state = reduceOperationsState(state, { type: 'snapshot/request' });
    state = reduceOperationsState(state, {
      type: 'snapshot/success',
      snapshot: makeSnapshotResponse(),
    });
    assert.equal(selectFreshness(state), 'live');
  });
});

describe('selectAvailability', () => {
  it('returns empty initially', () => {
    assert.equal(selectAvailability(createInitialOperationsState()), 'empty');
  });

  it('reflects snapshot availability after loading', () => {
    let state = createInitialOperationsState();
    state = reduceOperationsState(state, { type: 'snapshot/request' });
    state = reduceOperationsState(state, {
      type: 'snapshot/success',
      snapshot: makeSnapshotResponse({ availability: 'partial' }),
    });
    assert.equal(selectAvailability(state), 'partial');
  });
});

describe('selectHealthStatus', () => {
  it('returns null when no snapshot', () => {
    assert.equal(selectHealthStatus(createInitialOperationsState()), null);
  });

  it('returns health from snapshot', () => {
    const health = {
      status: 'healthy' as const,
      scope: 'global' as const,
      observedAt: NOW,
      message: null,
      detailsAvailability: 'ready' as const,
    };
    let state = createInitialOperationsState();
    state = reduceOperationsState(state, { type: 'snapshot/request' });
    state = reduceOperationsState(state, {
      type: 'snapshot/success',
      snapshot: makeSnapshotResponse({ health }),
    });

    assert.deepEqual(selectHealthStatus(state), health);
  });
});

describe('selectHasPendingControl', () => {
  it('returns false when no pending controls', () => {
    assert.equal(selectHasPendingControl(createInitialOperationsState(), 'wq-1'), false);
  });

  it('returns true when a control is pending for the given work item', () => {
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

    assert.equal(selectHasPendingControl(state, 'wq-1'), true);
    assert.equal(selectHasPendingControl(state, 'wq-2'), false);
  });
});

describe('selectControlsForSelectedItem', () => {
  it('returns empty array when no item is selected', () => {
    assert.deepEqual(selectControlsForSelectedItem(createInitialOperationsState()), []);
  });

  it('returns controls from the selected item detail', () => {
    const control = makeControl();
    const detail = makeDetailResponse({ controls: [control] });
    let state = createInitialOperationsState();
    state = reduceOperationsState(state, { type: 'selection/select', workItemId: 'wq-1' });
    state = reduceOperationsState(state, { type: 'selection/detail-loaded', detail });

    const controls = selectControlsForSelectedItem(state);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].controlId, 'ctrl-1');
  });
});
