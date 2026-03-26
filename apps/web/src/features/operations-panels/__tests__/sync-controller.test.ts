/**
 * T020 — Sync controller tests.
 *
 * Verifies that createSyncController correctly orchestrates detail fetching:
 * - Dispatches selection/detail-loading then selection/detail-loaded on success
 * - Aborts in-flight HTTP requests when selection changes rapidly
 * - Dispatches selection/detail-failed on non-abort errors
 * - Ignores results after dispose
 * - cancelSync aborts in-flight and prevents dispatch
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
  getWorkItemDetailImpl: (
    workItemId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<GetWorkItemDetailResponse>,
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
  it('dispatches detail-loading then detail-loaded on successful fetch', async () => {
    const detail = makeDetailResponse({ item: makeQueueItem({ id: 'wq-1' }) });
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient(() => deferred.promise);
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');

    // detail-loading should be dispatched synchronously
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'selection/detail-loading');

    deferred.resolve(detail);
    await deferred.promise;

    // Allow microtask queue to flush
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].type, 'selection/detail-loaded');
    if (dispatched[1].type === 'selection/detail-loaded') {
      assert.deepEqual(dispatched[1].detail, detail);
    }
  });

  it('aborts the previous HTTP request when selection changes rapidly', async () => {
    const detailA = makeDetailResponse({ item: makeQueueItem({ id: 'wq-A' }) });
    const detailB = makeDetailResponse({ item: makeQueueItem({ id: 'wq-B' }) });
    const abortedSignals: boolean[] = [];
    const deferredA = createDeferredFetch<GetWorkItemDetailResponse>();
    const deferredB = createDeferredFetch<GetWorkItemDetailResponse>();

    let callCount = 0;
    const client = createMockClient((workItemId, options) => {
      callCount += 1;
      // Record the signal's aborted state at the time of resolution
      if (options?.signal) {
        const signal = options.signal;
        // Track abort events
        const idx = abortedSignals.length;
        abortedSignals.push(false);
        signal.addEventListener('abort', () => {
          abortedSignals[idx] = true;
        });
      }
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

    // The first request's signal should have been aborted
    assert.equal(abortedSignals[0], true, 'first request signal should be aborted');
    assert.equal(abortedSignals[1], false, 'second request signal should not be aborted');

    // Resolve both — only B should dispatch detail-loaded
    deferredA.resolve(detailA);
    deferredB.resolve(detailB);
    await Promise.all([deferredA.promise, deferredB.promise]);
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    assert.equal(callCount, 2);
    // detail-loading (A) + detail-loading (B) + detail-loaded (B)
    const loadedActions = dispatched.filter((a) => a.type === 'selection/detail-loaded');
    assert.equal(loadedActions.length, 1);
    if (loadedActions[0].type === 'selection/detail-loaded') {
      assert.equal(loadedActions[0].detail.item.id, 'wq-B');
    }
  });

  it('passes AbortSignal to the client and aborts on cancelSync', async () => {
    let capturedSignal: AbortSignal | undefined;
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient((_id, options) => {
      capturedSignal = options?.signal;
      return deferred.promise;
    });
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    assert.ok(capturedSignal, 'signal should be passed to client');
    assert.equal(capturedSignal.aborted, false);

    controller.cancelSync();
    assert.equal(capturedSignal.aborted, true, 'signal should be aborted after cancelSync');
  });

  it('passes AbortSignal to the client and aborts on dispose', async () => {
    let capturedSignal: AbortSignal | undefined;
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient((_id, options) => {
      capturedSignal = options?.signal;
      return deferred.promise;
    });

    const controller = createSyncController({
      client,
      dispatch: () => {},
    });

    controller.syncDetail('wq-1');
    assert.ok(capturedSignal, 'signal should be passed to client');
    assert.equal(capturedSignal.aborted, false);

    controller.dispose();
    assert.equal(capturedSignal.aborted, true, 'signal should be aborted after dispose');
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
    // Remove the detail-loading action so we can assert only on post-dispose behavior
    const loadingCount = dispatched.filter((a) => a.type === 'selection/detail-loading').length;
    assert.equal(loadingCount, 1);

    controller.dispose();
    deferred.resolve(detail);
    await deferred.promise;
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    // Only the initial detail-loading should be present, no detail-loaded
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'selection/detail-loading');
  });

  it('does not dispatch detail-loaded after cancelSync', async () => {
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

    // Only detail-loading should be dispatched, not detail-loaded
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'selection/detail-loading');
  });

  it('dispatches detail-failed when detail fetch rejects with non-abort error', async () => {
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

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].type, 'selection/detail-loading');
    assert.equal(dispatched[1].type, 'selection/detail-failed');
  });

  it('dispatches detail-failed when response ID mismatches requested ID', async () => {
    // Simulates the real client's ID mismatch validation error
    const deferred = createDeferredFetch<GetWorkItemDetailResponse>();
    const client = createMockClient(() => deferred.promise);
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    deferred.reject(
      new Error('Work item detail ID mismatch: requested "wq-1" but received "wq-WRONG"'),
    );
    try {
      await deferred.promise;
    } catch {
      // expected — client rejects on ID mismatch
    }
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });

    // Must transition to error, not stay stuck in loading
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].type, 'selection/detail-loading');
    assert.equal(dispatched[1].type, 'selection/detail-failed');
  });

  it('does not dispatch detail-failed for abort errors', async () => {
    const client = createMockClient(
      (_id, options) =>
        // Simulate an immediate abort
        new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
        }),
    );
    const dispatched: OperationsAction[] = [];

    const controller = createSyncController({
      client,
      dispatch: (action) => dispatched.push(action),
    });

    controller.syncDetail('wq-1');
    controller.cancelSync();

    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });

    // Only detail-loading — no detail-failed for abort
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'selection/detail-loading');
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

  it('does not fan out uncontrolled requests on rapid selection', async () => {
    const signals: AbortSignal[] = [];
    const client = createMockClient((_id, options) => {
      if (options?.signal) signals.push(options.signal);
      // Never resolve — simulates slow network
      return new Promise<GetWorkItemDetailResponse>(() => {});
    });

    const controller = createSyncController({
      client,
      dispatch: () => {},
    });

    // Rapidly select 10 different items
    for (let i = 0; i < 10; i++) {
      controller.syncDetail(`wq-${String(i)}`);
    }

    // All but the last signal should be aborted
    assert.equal(signals.length, 10);
    for (let i = 0; i < 9; i++) {
      assert.equal(signals[i].aborted, true, `signal ${String(i)} should be aborted`);
    }
    assert.equal(signals[9].aborted, false, 'last signal should still be active');

    controller.dispose();
  });
});
