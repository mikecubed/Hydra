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

  // ── T013: snapshotErrorMessage tracking ─────────────────────────────────

  it('sets default snapshotErrorMessage on snapshot/failure without explicit message', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/failure' },
    ]);

    assert.equal(state.snapshotStatus, 'error');
    assert.equal(typeof state.snapshotErrorMessage, 'string');
    assert.ok((state.snapshotErrorMessage ?? '').length > 0);
  });

  it('sets explicit snapshotErrorMessage on snapshot/failure with errorMessage', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/failure', errorMessage: 'Gateway 503: daemon unreachable' },
    ]);

    assert.equal(state.snapshotErrorMessage, 'Gateway 503: daemon unreachable');
  });

  it('clears snapshotErrorMessage on snapshot/request', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/failure', errorMessage: 'first error' },
      { type: 'snapshot/request' },
    ]);

    assert.equal(state.snapshotErrorMessage, null);
  });

  it('clears snapshotErrorMessage on snapshot/success', () => {
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/failure', errorMessage: 'error' },
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot: makeSnapshotResponse() },
    ]);

    assert.equal(state.snapshotErrorMessage, null);
  });

  it('initial state has null snapshotErrorMessage', () => {
    const state = createInitialOperationsState();
    assert.equal(state.snapshotErrorMessage, null);
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

// ─── Detail-sync: selection + detail lifecycle ──────────────────────────────

describe('detail-sync lifecycle', () => {
  it('selecting an item clears any previously loaded detail', () => {
    const detailA = makeDetailResponse({ item: makeQueueItem({ id: 'wq-1' }) });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail: detailA },
      { type: 'selection/select', workItemId: 'wq-2' },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-2');
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailAvailability, null);
  });

  it('detail-loaded updates detailAvailability from the response', () => {
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1' }),
      availability: 'partial',
    });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(state.selection.detailAvailability, 'partial');
  });

  it('snapshot refresh reconciles detail.item from queue data', () => {
    const initialSnapshot = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-1', status: 'active', lastCheckpointSummary: 'v1' })],
    });
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1', status: 'active', lastCheckpointSummary: 'v1' }),
    });
    const updatedSnapshot = makeSnapshotResponse({
      queue: [
        makeQueueItem({
          id: 'wq-1',
          status: 'paused',
          lastCheckpointSummary: 'v2',
          detailAvailability: 'partial',
        }),
      ],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: initialSnapshot },
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'snapshot/success', snapshot: updatedSnapshot },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.equal(state.selection.detail?.item.status, 'paused');
    assert.equal(state.selection.detail?.item.lastCheckpointSummary, 'v2');
    assert.equal(state.selection.detailAvailability, 'partial');
  });

  it('snapshot refresh clears detail when selected item is removed', () => {
    const snapshot = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-1' })],
    });
    const detail = makeDetailResponse({ item: makeQueueItem({ id: 'wq-1' }) });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot },
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'snapshot/success', snapshot: makeSnapshotResponse({ queue: [] }) },
    ]);

    assert.equal(state.selection.selectedWorkItemId, null);
    assert.equal(state.selection.detail, null);
  });

  it('snapshot refresh preserves null detail when no detail was loaded yet', () => {
    const snapshot = makeSnapshotResponse({
      queue: [makeQueueItem({ id: 'wq-1' })],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot },
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.equal(state.selection.detail, null);
  });

  it('detail-loaded with checkpoint data is preserved through selection', () => {
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1' }),
      checkpoints: [
        {
          id: 'cp-1',
          sequence: 0,
          label: 'Init',
          status: 'reached',
          timestamp: NOW,
          detail: null,
        },
        {
          id: 'cp-2',
          sequence: 1,
          label: 'Tests pass',
          status: 'waiting',
          timestamp: LATER,
          detail: 'Waiting for CI',
        },
      ],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(state.selection.detail?.checkpoints.length, 2);
    assert.equal(state.selection.detail?.checkpoints[0].label, 'Init');
    assert.equal(state.selection.detail?.checkpoints[1].status, 'waiting');
  });

  it('detail-loading on a previously loaded item clears stale detail', () => {
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1' }),
      checkpoints: [
        { id: 'cp-1', sequence: 0, label: 'Init', status: 'reached', timestamp: NOW, detail: null },
      ],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'selection/detail-loading' },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailFetchStatus, 'loading');
  });

  it('detail-failed on a previously loaded item clears stale detail', () => {
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1' }),
      checkpoints: [
        { id: 'cp-1', sequence: 0, label: 'Init', status: 'reached', timestamp: NOW, detail: null },
      ],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
      { type: 'selection/detail-failed' },
    ]);

    assert.equal(state.selection.selectedWorkItemId, 'wq-1');
    assert.equal(state.selection.detail, null);
    assert.equal(state.selection.detailFetchStatus, 'error');
  });

  it('full refetch cycle replaces stale detail with fresh data', () => {
    const oldDetail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1', title: 'Old' }),
      availability: 'partial',
    });
    const newDetail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1', title: 'New' }),
      availability: 'ready',
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail: oldDetail },
      { type: 'selection/detail-loading' },
      { type: 'selection/detail-loaded', detail: newDetail },
    ]);

    assert.equal(state.selection.detail?.item.title, 'New');
    assert.equal(state.selection.detailAvailability, 'ready');
    assert.equal(state.selection.detailFetchStatus, 'idle');
  });
});

// ─── Health and budget snapshot lifecycle ────────────────────────────────────

describe('health and budget snapshot lifecycle', () => {
  it('snapshot with health data is accessible via state.snapshot.health', () => {
    const health = {
      status: 'healthy' as const,
      scope: 'global' as const,
      observedAt: NOW,
      message: null,
      detailsAvailability: 'ready' as const,
    };
    const snapshot = makeSnapshotResponse({ health });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.deepEqual(state.snapshot?.health, health);
  });

  it('snapshot with budget data is accessible via state.snapshot.budget', () => {
    const budget = {
      status: 'normal' as const,
      scope: 'global' as const,
      scopeId: null,
      summary: 'Token usage within limits',
      used: 5000,
      limit: 100000,
      unit: 'tokens',
      complete: true,
    };
    const snapshot = makeSnapshotResponse({ budget });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.deepEqual(state.snapshot?.budget, budget);
  });

  it('snapshot with null health and budget stores them as null', () => {
    const snapshot = makeSnapshotResponse({ health: null, budget: null });
    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.snapshot?.health, null);
    assert.equal(state.snapshot?.budget, null);
  });

  it('health transitions across snapshot refreshes', () => {
    const healthySnapshot = makeSnapshotResponse({
      health: {
        status: 'healthy',
        scope: 'global',
        observedAt: NOW,
        message: null,
        detailsAvailability: 'ready',
      },
    });
    const degradedSnapshot = makeSnapshotResponse({
      health: {
        status: 'degraded',
        scope: 'global',
        observedAt: LATER,
        message: 'Agent pool reduced',
        detailsAvailability: 'partial',
      },
      lastSynchronizedAt: LATER,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: healthySnapshot },
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot: degradedSnapshot },
    ]);

    assert.equal(state.snapshot?.health?.status, 'degraded');
    assert.equal(state.snapshot?.health?.message, 'Agent pool reduced');
  });

  it('budget transitions from normal to warning across refreshes', () => {
    const normalBudget = makeSnapshotResponse({
      budget: {
        status: 'normal',
        scope: 'global',
        scopeId: null,
        summary: 'Within limits',
        used: 5000,
        limit: 100000,
        unit: 'tokens',
        complete: true,
      },
    });
    const warningBudget = makeSnapshotResponse({
      budget: {
        status: 'warning',
        scope: 'global',
        scopeId: null,
        summary: 'Approaching limit',
        used: 85000,
        limit: 100000,
        unit: 'tokens',
        complete: true,
      },
      lastSynchronizedAt: LATER,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: normalBudget },
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot: warningBudget },
    ]);

    assert.equal(state.snapshot?.budget?.status, 'warning');
    assert.equal(state.snapshot?.budget?.summary, 'Approaching limit');
  });

  it('budget transitions to exceeded state', () => {
    const snapshot = makeSnapshotResponse({
      budget: {
        status: 'exceeded',
        scope: 'global',
        scopeId: null,
        summary: 'Daily budget exceeded',
        used: 120000,
        limit: 100000,
        unit: 'tokens',
        complete: true,
      },
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.snapshot?.budget?.status, 'exceeded');
  });

  it('budget with unavailable status is stored correctly', () => {
    const snapshot = makeSnapshotResponse({
      budget: {
        status: 'unavailable',
        scope: 'global',
        scopeId: null,
        summary: 'Budget data unavailable',
        used: null,
        limit: null,
        unit: null,
        complete: false,
      },
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/request' },
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.snapshot?.budget?.status, 'unavailable');
    assert.equal(state.snapshot?.budget?.complete, false);
  });

  it('snapshot failure preserves previous health/budget data', () => {
    const snapshot = makeSnapshotResponse({
      health: {
        status: 'healthy',
        scope: 'global',
        observedAt: NOW,
        message: null,
        detailsAvailability: 'ready',
      },
      budget: {
        status: 'normal',
        scope: 'global',
        scopeId: null,
        summary: 'Within limits',
        used: 5000,
        limit: 100000,
        unit: 'tokens',
        complete: true,
      },
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot },
      { type: 'snapshot/request' },
      { type: 'snapshot/failure' },
    ]);

    assert.equal(state.snapshot?.health?.status, 'healthy');
    assert.equal(state.snapshot?.budget?.status, 'normal');
    assert.equal(state.snapshotStatus, 'error');
    assert.equal(state.freshness, 'stale');
  });
});

// ─── Item-level budget in detail responses ──────────────────────────────────

describe('item-level budget in detail responses', () => {
  it('detail response with itemBudget is accessible via selection.detail', () => {
    const itemBudget = {
      status: 'warning' as const,
      scope: 'work-item' as const,
      scopeId: 'wq-1',
      summary: 'Work item over 80%',
      used: 8500,
      limit: 10000,
      unit: 'tokens',
      complete: true,
    };
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1' }),
      itemBudget,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.deepEqual(state.selection.detail?.itemBudget, itemBudget);
  });

  it('detail response with null itemBudget stores null', () => {
    const detail = makeDetailResponse({
      item: makeQueueItem({ id: 'wq-1' }),
      itemBudget: null,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'selection/select', workItemId: 'wq-1' },
      { type: 'selection/detail-loaded', detail },
    ]);

    assert.equal(state.selection.detail?.itemBudget, null);
  });
});

// ─── Risk signals in queue items through reducer ────────────────────────────

describe('risk signals in queue items through reducer', () => {
  it('stores risk signals on queue items from snapshot', () => {
    const snapshot = makeSnapshotResponse({
      queue: [
        makeQueueItem({
          id: 'wq-1',
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Budget 80%', scope: 'global' },
            { kind: 'health', severity: 'critical', summary: 'Agent down', scope: 'global' },
          ],
        }),
      ],
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot },
    ]);

    assert.equal(state.snapshot?.queue[0].riskSignals.length, 2);
    assert.equal(state.snapshot?.queue[0].riskSignals[0].kind, 'budget');
    assert.equal(state.snapshot?.queue[0].riskSignals[1].severity, 'critical');
  });

  it('snapshot refresh updates risk signals on existing items', () => {
    const first = makeSnapshotResponse({
      queue: [
        makeQueueItem({
          id: 'wq-1',
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Budget 80%', scope: 'global' },
          ],
        }),
      ],
    });
    const second = makeSnapshotResponse({
      queue: [
        makeQueueItem({
          id: 'wq-1',
          riskSignals: [
            { kind: 'budget', severity: 'critical', summary: 'Budget exceeded', scope: 'global' },
          ],
        }),
      ],
      lastSynchronizedAt: LATER,
    });

    const state = applyActions(createInitialOperationsState(), [
      { type: 'snapshot/success', snapshot: first },
      { type: 'snapshot/success', snapshot: second },
    ]);

    assert.equal(state.snapshot?.queue[0].riskSignals[0].severity, 'critical');
    assert.equal(state.snapshot?.queue[0].riskSignals[0].summary, 'Budget exceeded');
  });
});
