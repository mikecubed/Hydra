/**
 * T043 — Control actions unit tests.
 *
 * Covers the control-actions module: submitControlAction orchestration,
 * pending bookkeeping, outcome handling (accepted/rejected/stale/superseded),
 * and authoritative refetch after resolution.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { OperationalControlView, SubmitControlActionResponse } from '@hydra/web-contracts';

import type { OperationsClient } from '../api/operations-client.ts';
import type { OperationsAction } from '../model/operations-reducer.ts';
import { submitControl, type SubmitControlOptions } from '../model/control-actions.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';

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

function makeAcceptedResponse(
  overrides: Partial<SubmitControlActionResponse> = {},
): SubmitControlActionResponse {
  return {
    outcome: 'accepted',
    control: makeControl({ availability: 'accepted', expectedRevision: 'rev-2' }),
    workItemId: 'wq-1',
    resolvedAt: NOW,
    ...overrides,
  };
}

function createMockClient(
  submitFn: OperationsClient['submitControlAction'] = () => Promise.resolve(makeAcceptedResponse()),
): OperationsClient {
  return {
    getSnapshot: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemDetail: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemCheckpoints: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemExecution: mock.fn(() => Promise.reject(new Error('not implemented'))),
    getWorkItemControls: mock.fn(() => Promise.reject(new Error('not implemented'))),
    submitControlAction: mock.fn(submitFn),
    discoverControls: mock.fn(() => Promise.reject(new Error('not implemented'))),
  } as unknown as OperationsClient;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('submitControl', () => {
  it('dispatches controls/submit-pending before sending the request', async () => {
    const dispatched: OperationsAction[] = [];
    let requestStarted = false;
    const client = createMockClient(async () => {
      requestStarted = true;
      return makeAcceptedResponse();
    });

    const opts: SubmitControlOptions = {
      client,
      dispatch: (action) => {
        dispatched.push(action);
        // At the time pending is dispatched, the request must not have started
        if (action.type === 'controls/submit-pending') {
          assert.equal(requestStarted, false, 'pending dispatch should precede HTTP request');
        }
      },
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    };

    await submitControl(opts);

    assert.ok(dispatched.some((a) => a.type === 'controls/submit-pending'));
  });

  it('dispatches controls/submit-resolved after a successful submit', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => makeAcceptedResponse());

    await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });

    const resolved = dispatched.filter((a) => a.type === 'controls/submit-resolved');
    assert.equal(resolved.length, 1);
    if (resolved[0].type === 'controls/submit-resolved') {
      assert.equal(resolved[0].workItemId, 'wq-1');
    }
  });

  it('returns the outcome from the gateway response', async () => {
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'rejected' }));
    const dispatched: OperationsAction[] = [];

    const result = await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });

    assert.equal(result.outcome, 'rejected');
  });

  it('dispatches controls/submit-resolved even when outcome is rejected', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'rejected' }));

    await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });

    assert.ok(dispatched.some((a) => a.type === 'controls/submit-resolved'));
  });

  it('dispatches controls/submit-resolved on stale outcome', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'stale' }));

    await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });

    assert.ok(dispatched.some((a) => a.type === 'controls/submit-resolved'));
  });

  it('dispatches controls/submit-resolved on superseded outcome', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'superseded' }));

    await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });

    assert.ok(dispatched.some((a) => a.type === 'controls/submit-resolved'));
  });

  it('dispatches controls/submit-resolved on HTTP error and rethrows', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => {
      throw new Error('Network failure');
    });

    await assert.rejects(
      () =>
        submitControl({
          client,
          dispatch: (action) => dispatched.push(action),
          workItemId: 'wq-1',
          controlId: 'ctrl-1',
          requestedOptionId: 'opt-1',
          expectedRevision: 'rev-1',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Network failure/u);
        return true;
      },
    );

    assert.ok(dispatched.some((a) => a.type === 'controls/submit-resolved'));
  });

  it('calls onRefetchDetail when provided and outcome is accepted', async () => {
    let refetchedId: string | null = null;
    const client = createMockClient(async () => makeAcceptedResponse());

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchDetail: (id) => {
        refetchedId = id;
      },
    });

    assert.equal(refetchedId, 'wq-1');
  });

  it('calls onRefetchDetail on rejected outcome for authoritative reconciliation', async () => {
    let refetchedId: string | null = null;
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'rejected' }));

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchDetail: (id) => {
        refetchedId = id;
      },
    });

    assert.equal(refetchedId, 'wq-1');
  });

  it('calls onRefetchDetail on stale outcome', async () => {
    let refetchedId: string | null = null;
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'stale' }));

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchDetail: (id) => {
        refetchedId = id;
      },
    });

    assert.equal(refetchedId, 'wq-1');
  });

  it('does not call onRefetchDetail on HTTP error', async () => {
    let refetchCalled = false;
    const client = createMockClient(async () => {
      throw new Error('Network failure');
    });

    try {
      await submitControl({
        client,
        dispatch: () => {},
        workItemId: 'wq-1',
        controlId: 'ctrl-1',
        requestedOptionId: 'opt-1',
        expectedRevision: 'rev-1',
        onRefetchDetail: () => {
          refetchCalled = true;
        },
      });
    } catch {
      // expected
    }

    assert.equal(refetchCalled, false);
  });

  it('includes generated requestId in pending action', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => makeAcceptedResponse());

    await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });

    const pending = dispatched.find((a) => a.type === 'controls/submit-pending');
    assert.ok(pending);
    if (pending.type === 'controls/submit-pending') {
      assert.ok(pending.pending.requestId.length > 0);
      assert.equal(pending.pending.workItemId, 'wq-1');
      assert.equal(pending.pending.controlId, 'ctrl-1');
      assert.equal(pending.pending.requestedOptionId, 'opt-1');
    }
  });

  // ─── Issue 1: onRefetchSnapshot ─────────────────────────────────────────

  it('calls onRefetchSnapshot on accepted outcome', async () => {
    let snapshotRefetched = false;
    const client = createMockClient(async () => makeAcceptedResponse());

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchSnapshot: () => {
        snapshotRefetched = true;
      },
    });

    assert.equal(snapshotRefetched, true);
  });

  it('calls onRefetchSnapshot on rejected outcome', async () => {
    let snapshotRefetched = false;
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'rejected' }));

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchSnapshot: () => {
        snapshotRefetched = true;
      },
    });

    assert.equal(snapshotRefetched, true);
  });

  it('calls onRefetchSnapshot on stale outcome', async () => {
    let snapshotRefetched = false;
    const client = createMockClient(async () => makeAcceptedResponse({ outcome: 'stale' }));

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchSnapshot: () => {
        snapshotRefetched = true;
      },
    });

    assert.equal(snapshotRefetched, true);
  });

  it('does not call onRefetchSnapshot on HTTP error', async () => {
    let snapshotRefetched = false;
    const client = createMockClient(async () => {
      throw new Error('Network failure');
    });

    try {
      await submitControl({
        client,
        dispatch: () => {},
        workItemId: 'wq-1',
        controlId: 'ctrl-1',
        requestedOptionId: 'opt-1',
        expectedRevision: 'rev-1',
        onRefetchSnapshot: () => {
          snapshotRefetched = true;
        },
      });
    } catch {
      // expected
    }

    assert.equal(snapshotRefetched, false);
  });

  it('calls both onRefetchDetail and onRefetchSnapshot on success', async () => {
    let detailRefetched = false;
    let snapshotRefetched = false;
    const client = createMockClient(async () => makeAcceptedResponse());

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchDetail: () => {
        detailRefetched = true;
      },
      onRefetchSnapshot: () => {
        snapshotRefetched = true;
      },
    });

    assert.equal(detailRefetched, true);
    assert.equal(snapshotRefetched, true);
  });

  // ─── Issue 2: caller catch pattern (unhandled rejection guard) ──────────

  it('rejection is catchable by caller after state reconciliation completes', async () => {
    const dispatched: OperationsAction[] = [];
    const client = createMockClient(async () => {
      throw new Error('Network failure');
    });

    // Mirrors the fixed component pattern: .catch() after submitControl
    let caughtError: unknown = null;
    await submitControl({
      client,
      dispatch: (action) => dispatched.push(action),
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    }).catch((err: unknown) => {
      caughtError = err;
    });

    // State reconciliation must have occurred before the catch handler
    assert.ok(dispatched.some((a) => a.type === 'controls/submit-resolved'));
    // The error must be available to the caller for reporting
    assert.ok(caughtError instanceof Error);
    assert.match(caughtError.message, /Network failure/u);
  });

  it('rejection does not call onRefetchSnapshot even when caller catches', async () => {
    let snapshotRefetched = false;
    const client = createMockClient(async () => {
      throw new Error('Server error');
    });

    await submitControl({
      client,
      dispatch: () => {},
      workItemId: 'wq-1',
      controlId: 'ctrl-1',
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
      onRefetchSnapshot: () => {
        snapshotRefetched = true;
      },
    }).catch(() => {
      // Caller catches rejection — mirrors component fix
    });

    assert.equal(snapshotRefetched, false, 'snapshot refetch must not fire on HTTP error');
  });
});
