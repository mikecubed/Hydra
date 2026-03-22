/**
 * Tests for the live-streaming integration layer.
 *
 * Covers:
 * - applyStreamEventsToConversation: pure reconciliation dispatch helper
 * - Stream subscription lifecycle logic (subscribe/unsubscribe/cleanup)
 * - Duplicate suppression via reconciler high-water marks
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamEvent } from '@hydra/web-contracts';

import {
  createWorkspaceStore,
  type PromptViewState,
  type TranscriptEntryState,
  type WorkspaceStore,
} from '../model/workspace-store.ts';
import {
  applyStreamEventsToConversation,
  createStreamSubscriptionState,
} from '../model/stream-subscription.ts';
import { claimApprovalHydrationRetry } from '../model/approval-hydration-retries.ts';
import {
  pickBestApprovalPerTurn,
  selectHydratedApprovalPrompt,
} from '../model/approval-selection.ts';

import type { ApprovalRequest } from '@hydra/web-contracts';

// ─── Factories ──────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<StreamEvent> & { seq: number; turnId: string }): StreamEvent {
  return {
    kind: 'text-delta',
    payload: {},
    timestamp: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function storeWithConversation(conversationId: string): WorkspaceStore {
  const store = createWorkspaceStore();
  store.dispatch({ type: 'conversation/select', conversationId });
  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId,
    entries: [],
    hasMoreHistory: false,
  });
  return store;
}

function storeWithEntries(
  conversationId: string,
  entries: readonly TranscriptEntryState[],
): WorkspaceStore {
  const store = createWorkspaceStore();
  store.dispatch({ type: 'conversation/select', conversationId });
  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId,
    entries,
    hasMoreHistory: false,
  });
  return store;
}

// ─── createStreamSubscriptionState ──────────────────────────────────────────

describe('createStreamSubscriptionState', () => {
  it('returns empty reconciler state', () => {
    const state = createStreamSubscriptionState();
    assert.equal(state.reconcilerState.highWaterSeq.size, 0);
  });
});

describe('claimApprovalHydrationRetry', () => {
  it('increments retry count until the budget is exhausted', () => {
    const retryCounts = new Map<string, number>();

    assert.equal(claimApprovalHydrationRetry(retryCounts, 'conv-1'), true);
    assert.equal(retryCounts.get('conv-1'), 1);

    assert.equal(claimApprovalHydrationRetry(retryCounts, 'conv-1'), true);
    assert.equal(retryCounts.get('conv-1'), 2);

    assert.equal(claimApprovalHydrationRetry(retryCounts, 'conv-1'), true);
    assert.equal(retryCounts.get('conv-1'), 3);
  });

  it('clears exhausted retry entries so later loader runs get a fresh budget', () => {
    const retryCounts = new Map<string, number>([['conv-1', 3]]);

    assert.equal(claimApprovalHydrationRetry(retryCounts, 'conv-1'), false);
    assert.equal(retryCounts.has('conv-1'), false);

    assert.equal(claimApprovalHydrationRetry(retryCounts, 'conv-1'), true);
    assert.equal(retryCounts.get('conv-1'), 1);
  });
});

// ─── pickBestApprovalPerTurn ─────────────────────────────────────────────────

function makeApproval(overrides: Partial<ApprovalRequest> & { id: string }): ApprovalRequest {
  return {
    turnId: 'turn-1',
    status: 'pending',
    prompt: 'Approve?',
    context: {},
    contextHash: 'hash-1',
    responseOptions: [{ key: 'approve', label: 'Approve' }],
    createdAt: '2026-03-20T12:00:00.000Z',
    ...overrides,
  };
}

function makePrompt(overrides: Partial<PromptViewState> = {}): PromptViewState {
  return {
    promptId: 'prompt-1',
    parentTurnId: 'turn-1',
    status: 'pending',
    allowedResponses: [],
    contextBlocks: [],
    lastResponseSummary: null,
    errorMessage: null,
    staleReason: null,
    ...overrides,
  };
}

describe('pickBestApprovalPerTurn', () => {
  it('returns empty map for empty input', () => {
    const result = pickBestApprovalPerTurn([]);
    assert.equal(result.size, 0);
  });

  it('returns single approval unchanged', () => {
    const approval = makeApproval({ id: 'a1' });
    const result = pickBestApprovalPerTurn([approval]);
    assert.equal(result.size, 1);
    assert.equal(result.get('turn-1')?.id, 'a1');
  });

  it('prefers pending over stale for the same turn', () => {
    const stale = makeApproval({
      id: 'a1',
      status: 'stale',
      createdAt: '2026-03-20T13:00:00.000Z',
    });
    const pending = makeApproval({
      id: 'a2',
      status: 'pending',
      createdAt: '2026-03-20T12:00:00.000Z',
    });
    // pending wins even though stale is newer
    const result = pickBestApprovalPerTurn([stale, pending]);
    assert.equal(result.get('turn-1')?.id, 'a2');
  });

  it('prefers pending over stale regardless of input order', () => {
    const pending = makeApproval({ id: 'a2', status: 'pending' });
    const stale = makeApproval({
      id: 'a1',
      status: 'stale',
      createdAt: '2026-03-20T13:00:00.000Z',
    });
    const result = pickBestApprovalPerTurn([pending, stale]);
    assert.equal(result.get('turn-1')?.id, 'a2');
  });

  it('within same status, prefers newest createdAt', () => {
    const older = makeApproval({
      id: 'a1',
      status: 'pending',
      createdAt: '2026-03-20T12:00:00.000Z',
    });
    const newer = makeApproval({
      id: 'a2',
      status: 'pending',
      createdAt: '2026-03-20T13:00:00.000Z',
    });
    const result = pickBestApprovalPerTurn([older, newer]);
    assert.equal(result.get('turn-1')?.id, 'a2');
  });

  it('within same status and timestamp tie, falls back to id compare', () => {
    const a = makeApproval({
      id: 'approval-aaa',
      status: 'pending',
      createdAt: '2026-03-20T12:00:00.000Z',
    });
    const b = makeApproval({
      id: 'approval-bbb',
      status: 'pending',
      createdAt: '2026-03-20T12:00:00.000Z',
    });
    // Lexicographically smaller id wins (deterministic)
    const result = pickBestApprovalPerTurn([b, a]);
    assert.equal(result.get('turn-1')?.id, 'approval-aaa');
  });

  it('handles invalid timestamps with id fallback', () => {
    const a = makeApproval({
      id: 'approval-aaa',
      status: 'stale',
      createdAt: 'not-a-date' as unknown as string,
    });
    const b = makeApproval({
      id: 'approval-bbb',
      status: 'stale',
      createdAt: 'also-invalid' as unknown as string,
    });
    const result = pickBestApprovalPerTurn([b, a]);
    assert.equal(result.get('turn-1')?.id, 'approval-aaa');
  });

  it('prefers a valid timestamp over an invalid one before id fallback', () => {
    const invalid = makeApproval({
      id: 'approval-aaa',
      status: 'pending',
      createdAt: 'not-a-date' as unknown as string,
    });
    const valid = makeApproval({
      id: 'approval-zzz',
      status: 'pending',
      createdAt: '2026-03-20T13:00:00.000Z',
    });

    const result = pickBestApprovalPerTurn([invalid, valid]);
    assert.equal(result.get('turn-1')?.id, 'approval-zzz');
  });

  it('handles multiple turns independently', () => {
    const t1Stale = makeApproval({
      id: 'a1',
      turnId: 'turn-1',
      status: 'stale',
      createdAt: '2026-03-20T13:00:00.000Z',
    });
    const t1Pending = makeApproval({
      id: 'a2',
      turnId: 'turn-1',
      status: 'pending',
      createdAt: '2026-03-20T12:00:00.000Z',
    });
    const t2Only = makeApproval({
      id: 'a3',
      turnId: 'turn-2',
      status: 'stale',
    });
    const result = pickBestApprovalPerTurn([t1Stale, t1Pending, t2Only]);
    assert.equal(result.size, 2);
    assert.equal(result.get('turn-1')?.id, 'a2');
    assert.equal(result.get('turn-2')?.id, 'a3');
  });

  it('three approvals for one turn: stale-old, stale-new, pending-old → pending wins', () => {
    const staleOld = makeApproval({
      id: 'a1',
      status: 'stale',
      createdAt: '2026-03-20T10:00:00.000Z',
    });
    const staleNew = makeApproval({
      id: 'a2',
      status: 'stale',
      createdAt: '2026-03-20T14:00:00.000Z',
    });
    const pendingOld = makeApproval({
      id: 'a3',
      status: 'pending',
      createdAt: '2026-03-20T11:00:00.000Z',
    });
    const result = pickBestApprovalPerTurn([staleOld, staleNew, pendingOld]);
    assert.equal(result.get('turn-1')?.id, 'a3');
  });
});

describe('selectHydratedApprovalPrompt', () => {
  it('replaces an older prompt cycle when rest hydration selects a different prompt id', () => {
    const existing = makePrompt({
      promptId: 'approval-old',
      status: 'stale',
      allowedResponses: [],
      contextBlocks: [],
      staleReason: 'superseded',
    });
    const rest = makePrompt({
      promptId: 'approval-new',
      status: 'pending',
      allowedResponses: [{ key: 'approve', label: 'Approve' }],
      contextBlocks: [{ blockId: 'ctx-1', kind: 'text', text: 'Fresh context', metadata: null }],
    });

    const merged = selectHydratedApprovalPrompt(existing, rest);
    assert.equal(merged.promptId, 'approval-new');
    assert.equal(merged.status, 'pending');
    assert.deepEqual(merged.allowedResponses, [{ key: 'approve', label: 'Approve' }]);
  });

  it('preserves a different in-flight prompt cycle when rest hydration is not more actionable', () => {
    const existing = makePrompt({
      promptId: 'approval-live',
      status: 'pending',
      allowedResponses: [{ key: 'approve', label: 'Approve live' }],
    });
    const rest = makePrompt({
      promptId: 'approval-rest',
      status: 'pending',
      allowedResponses: [{ key: 'approve', label: 'Approve rest' }],
    });

    const merged = selectHydratedApprovalPrompt(existing, rest);
    assert.equal(merged.promptId, 'approval-live');
    assert.deepEqual(merged.allowedResponses, [{ key: 'approve', label: 'Approve live' }]);
  });
});

// ─── applyStreamEventsToConversation ────────────────────────────────────────

describe('applyStreamEventsToConversation', () => {
  it('applies a text-delta to an empty conversation', () => {
    const store = storeWithConversation('conv-1');
    const sub = createStreamSubscriptionState();

    const events: StreamEvent[] = [
      makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'stream-started',
        payload: {},
      }),
      makeEvent({
        seq: 2,
        turnId: 'turn-1',
        kind: 'text-delta',
        payload: { text: 'Hello ' },
      }),
    ];

    const next = applyStreamEventsToConversation(store, 'conv-1', events, sub);

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].turnId, 'turn-1');
    assert.equal(entries[0].status, 'streaming');
    assert.equal(entries[0].contentBlocks[0]?.text, 'Hello ');
    assert.equal(next.reconcilerState.highWaterSeq.get('turn-1'), 2);
  });

  it('appends incremental text deltas', () => {
    const store = storeWithConversation('conv-1');
    let sub = createStreamSubscriptionState();

    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'Hello ' } }),
      ],
      sub,
    );

    applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 3, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'world' } })],
      sub,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries[0].contentBlocks[0]?.text, 'Hello world');
  });

  it('suppresses duplicate events via high-water marks', () => {
    const store = storeWithConversation('conv-1');
    let sub = createStreamSubscriptionState();

    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'once' } }),
      ],
      sub,
    );

    // Re-deliver the same events — should be no-ops
    applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'once' } }),
      ],
      sub,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries[0].contentBlocks[0]?.text, 'once');
  });

  it('handles stream-completed status transition', () => {
    const store = storeWithConversation('conv-1');
    const sub = createStreamSubscriptionState();

    applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'done' } }),
        makeEvent({
          seq: 3,
          turnId: 'turn-1',
          kind: 'stream-completed',
          payload: { status: 'completed' },
        }),
      ],
      sub,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries[0].status, 'completed');
  });

  it('preserves existing history entries when streaming adds new turns', () => {
    const existingEntry: TranscriptEntryState = {
      entryId: 'turn-old',
      kind: 'turn',
      turnId: 'turn-old',
      status: 'completed',
      timestamp: '2026-06-01T00:00:00.000Z',
      contentBlocks: [{ blockId: 'blk-1', kind: 'text', text: 'old message', metadata: null }],
      artifacts: [],
      controls: [],
      prompt: null,
    };

    const store = storeWithEntries('conv-1', [existingEntry]);
    const sub = createStreamSubscriptionState();

    applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-new', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 'turn-new',
          kind: 'text-delta',
          payload: { text: 'new message' },
        }),
      ],
      sub,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries.length, 2);
    assert.equal(entries[0].turnId, 'turn-old');
    assert.equal(entries[0].contentBlocks[0]?.text, 'old message');
    assert.equal(entries[1].turnId, 'turn-new');
  });

  it('handles stream-failed with error reason', () => {
    const store = storeWithConversation('conv-1');
    const sub = createStreamSubscriptionState();

    applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 'turn-1',
          kind: 'stream-failed',
          payload: { reason: 'Agent crashed' },
        }),
      ],
      sub,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries[0].status, 'failed');
    const errorBlock = entries[0].contentBlocks.find((b) => b.kind === 'status');
    assert.equal(errorBlock?.text, 'Agent crashed');
  });

  it('no-ops for a non-existent conversation', () => {
    const store = storeWithConversation('conv-1');
    const sub = createStreamSubscriptionState();

    const next = applyStreamEventsToConversation(
      store,
      'conv-other',
      [makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} })],
      sub,
    );

    // Should return unchanged state
    assert.equal(next.reconcilerState.highWaterSeq.size, 0);
  });

  it('handles activity-marker events', () => {
    const store = storeWithConversation('conv-1');
    const sub = createStreamSubscriptionState();

    applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({
          seq: 1,
          turnId: 'turn-1',
          kind: 'activity-marker',
          payload: { description: 'Installing deps' },
        }),
      ],
      sub,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    const activity = entries.find((e) => e.kind === 'activity-group');
    assert.ok(activity);
    assert.equal(activity.contentBlocks[0]?.text, 'Installing deps');
  });
});
