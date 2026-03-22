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
  type TranscriptEntryState,
  type WorkspaceStore,
} from '../model/workspace-store.ts';
import {
  applyStreamEventsToConversation,
  createStreamSubscriptionState,
  sealSubscriptionAfterMerge,
} from '../model/stream-subscription.ts';

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

// ─── sealSubscriptionAfterMerge ─────────────────────────────────────────────

describe('sealSubscriptionAfterMerge', () => {
  it('seals terminal turns in the subscription reconciler state', () => {
    const stateMap = new Map<string, ReturnType<typeof createStreamSubscriptionState>>();
    stateMap.set('conv-1', createStreamSubscriptionState());

    const restEntries: TranscriptEntryState[] = [
      {
        entryId: 'turn-a',
        kind: 'turn',
        turnId: 'turn-a',
        status: 'completed',
        timestamp: '2026-07-01T00:00:00.000Z',
        contentBlocks: [],
        artifacts: [],
        controls: [],
        prompt: null,
      },
    ];

    sealSubscriptionAfterMerge(stateMap, 'conv-1', restEntries);
    const sealed = stateMap.get('conv-1')?.reconcilerState.sealedTurns;
    assert.ok(sealed?.has('turn-a'), 'completed turn must be sealed');
  });

  it('replayed text-delta after merge is treated as stale', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, ReturnType<typeof createStreamSubscriptionState>>();

    // Simulate: stream delivered turn-a, then REST confirmed it completed.
    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 'turn-a', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 'turn-a', kind: 'text-delta', payload: { text: 'original' } }),
        makeEvent({
          seq: 3,
          turnId: 'turn-a',
          kind: 'stream-completed',
          payload: { status: 'completed' },
        }),
      ],
      sub,
    );
    stateMap.set('conv-1', sub);

    // Merge REST history (authoritative refresh)
    const restEntries: TranscriptEntryState[] = [
      {
        entryId: 'turn-a',
        kind: 'turn',
        turnId: 'turn-a',
        status: 'completed',
        timestamp: '2026-07-01T00:00:00.000Z',
        contentBlocks: [{ blockId: 'b1', kind: 'text', text: 'REST final', metadata: null }],
        artifacts: [],
        controls: [],
        prompt: null,
      },
    ];
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: restEntries,
      hasMoreHistory: false,
    });
    sealSubscriptionAfterMerge(stateMap, 'conv-1', restEntries);

    // Now replay a text-delta for the sealed turn
    const sealedSub = stateMap.get('conv-1')!;
    const afterReplay = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 99, turnId: 'turn-a', kind: 'text-delta', payload: { text: 'REPLAY' } })],
      sealedSub,
    );

    // The replayed event must not have mutated the entry
    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    const turnA = entries.find((e) => e.turnId === 'turn-a' && e.kind === 'turn');
    assert.ok(turnA);
    assert.equal(turnA.contentBlocks[0]?.text, 'REST final', 'sealed turn must not be mutated');
    // Reconciler must still know the turn is sealed
    assert.ok(
      afterReplay.reconcilerState.sealedTurns?.has('turn-a'),
      'turn must remain sealed after replay',
    );
  });

  it('does not seal non-terminal turns (streaming)', () => {
    const stateMap = new Map<string, ReturnType<typeof createStreamSubscriptionState>>();
    stateMap.set('conv-1', createStreamSubscriptionState());

    const restEntries: TranscriptEntryState[] = [
      {
        entryId: 'turn-live',
        kind: 'turn',
        turnId: 'turn-live',
        status: 'streaming',
        timestamp: '2026-07-01T00:00:00.000Z',
        contentBlocks: [],
        artifacts: [],
        controls: [],
        prompt: null,
      },
    ];

    sealSubscriptionAfterMerge(stateMap, 'conv-1', restEntries);
    const sealed = stateMap.get('conv-1')?.reconcilerState.sealedTurns;
    assert.equal(sealed?.has('turn-live') ?? false, false, 'streaming turn must not be sealed');
  });

  it('creates subscription state if none exists', () => {
    const stateMap = new Map<string, ReturnType<typeof createStreamSubscriptionState>>();
    const restEntries: TranscriptEntryState[] = [
      {
        entryId: 'turn-x',
        kind: 'turn',
        turnId: 'turn-x',
        status: 'failed',
        timestamp: '2026-07-01T00:00:00.000Z',
        contentBlocks: [],
        artifacts: [],
        controls: [],
        prompt: null,
      },
    ];

    sealSubscriptionAfterMerge(stateMap, 'conv-new', restEntries);
    const sealed = stateMap.get('conv-new')?.reconcilerState.sealedTurns;
    assert.ok(sealed?.has('turn-x'), 'should seal even when no prior state');
  });
});
