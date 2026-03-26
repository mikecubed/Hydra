/**
 * T020 — Sync controller tests.
 *
 * Verifies that createSyncController correctly orchestrates detail fetching:
 * - Dispatches selection/detail-loaded on successful fetch
 * - Cancels stale fetches when selection changes rapidly
 * - Ignores results after dispose
 * - cancelSync prevents in-flight from dispatching
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { GetWorkItemDetailResponse, WorkQueueItemView } from '@hydra/web-contracts';

import type { OperationsClient } from '../api/operations-client.ts';
import type { OperationsAction } from '../model/operations-reducer.ts';
import { createSyncController } from '../model/sync-controller.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';

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

interface DeferredFetch<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function createDeferredFetch<T>(): DeferredFetch<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
    // intentional void — assignments happen via outer scope
  });
  return { promise, resolve, reject };
}

function createMockClient(
  getWorkItemDetailImpl: (workItemId: string) => Promise<GetWorkItemDetailResponse>,
): OperationsClient {
  return {
    getSnapshot: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemDetail: mock.fn(getWorkItemDetailImpl),
    getWorkItemCheckpoints: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemExecution: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemControls: mock.fn(() => Promise.reject(new Error('not implemented'))),
    submitControlAction: mock.fn(() => Promise.reject(new Error('not implemented'))),
    discoverControls: mock.fn(() => Promise.reject(new Error('not implemented'))),
  } as unknown as OperationsClient;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createSyncController', () => {
  it('dispatches selection/detail-loaded on successful fetch', async () => {
    const detail = makeDetailResponse({ item: makeQueueItem({ id: 'wq-1' }) });
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient(() => deferred.promise);
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    deferred.resolve(detail);
    await deferred.promise;

    // Allow microtask queue to flush
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'selection/detail-loaded');
    if (dispatched[0].type === 'selection/detail-loaded') {
      assert.deepEqual(dispatched[0].detail, detail);
    }
  });

  it('cancels stale fetch when selection changes rapidly', async () => {
    const detailA = makeDetailResponse({ item: makeQueueItem({ id: 'wq-A' }) });
    const detailB = makeDetailResponse({ item: makeQueueItem({ id: 'wq-B' }) });
    const deferredA = createDeferredFetch<GetWorkItemDetailResponse>();
    const deferredB = createDeferredFetch<GetWorkItemDetailResponse>();

    let callCount = 0;
    const client = createMockClient((workItemId) => {
      callCount += 1;
      if (workItemId === 'wq-A') return deferredA.promise;
      return deferredB.promise;
    });
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    // Select A, then immediately select B before A resolves
    controller.syncDetail('wq-A');
    controller.syncDetail('wq-B');

    // Resolve both — only B should dispatch
    deferredA.resolve(detailA);
    deferredB.resolve(detailB);
    await Promise.all([deferredA.promise, deferredB.promise]);
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(callCount, 2);
    assert.equal(dispatched.length, 1);
    if (dispatched[0].type === 'selection/detail-loaded') {
      assert.equal(dispatched[0].detail.item.id, 'wq-B');
    }
  });

  it('does not dispatch after dispose', async () => {
    const detail = makeDetailResponse();
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient(() => deferred.promise);
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    controller.dispose();
    deferred.resolve(detail);
    await deferred.promise;
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(dispatched.length, 0);
  });

  it('does not dispatch after cancelSync', async () => {
    const detail = makeDetailResponse();
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient(() => deferred.promise);
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    controller.cancelSync();
    deferred.resolve(detail);
    await deferred.promise;
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(dispatched.length, 0);
  });

  it('does not dispatch when detail fetch rejects', async () => {
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient(() => deferred.promise);
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    deferred.reject(new Error('Network failure'));
    try {
      await deferred.promise;
    } catch {
      // expected
    }
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(dispatched.length, 0);
  });

  it('ignores syncDetail calls after dispose', async () => {
    const client = createMockClient(() => Promise.resolve(makeDetailResponse()));
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.dispose();
    controller.syncDetail('wq-1');
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });

    assert.equal(dispatched.length, 0);
  });
});
