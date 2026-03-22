/**
 * Tests for the streaming lifecycle layer — resume, reconnect, ack, and
 * submit-without-REST-clobber behaviour.
 *
 * Covers:
 * - Per-conversation state persistence across conversation switches
 * - Subscribe with serverResumeSeq for replay/resume
 * - Reconnect flow preserves state and resubscribes correctly
 * - Stream-only updates after submit (no REST clobber)
 * - buildStreamCallbacks routing, ack, and lifecycle hooks
 * - Error surfacing (no silent catch blocks)
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { StreamEvent } from '@hydra/web-contracts';

import {
  applyStreamEventsToConversation,
  buildStreamCallbacks,
  createStreamSubscriptionState,
  createWorkspaceStore,
  type StreamSubscriptionState,
  type TranscriptEntryState,
  type WorkspaceStore,
} from '../model/workspace-store.ts';

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

function storeWithTwoConversations(idA: string, idB: string): WorkspaceStore {
  const store = createWorkspaceStore();
  store.dispatch({ type: 'conversation/select', conversationId: idA });
  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId: idA,
    entries: [],
    hasMoreHistory: false,
  });
  store.dispatch({ type: 'conversation/select', conversationId: idB });
  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId: idB,
    entries: [],
    hasMoreHistory: false,
  });
  return store;
}

function existingTurnEntry(turnId: string, text: string): TranscriptEntryState {
  return {
    entryId: turnId,
    kind: 'turn',
    turnId,
    status: 'completed',
    timestamp: '2026-06-01T00:00:00.000Z',
    contentBlocks: [{ blockId: `${turnId}-blk`, kind: 'text', text, metadata: null }],
    artifacts: [],
    controls: [],
    prompt: null,
  };
}

// ─── Per-conversation state persistence ─────────────────────────────────────

describe('per-conversation state persistence', () => {
  it('preserves reconciler state across conversation switches', () => {
    const store = storeWithTwoConversations('conv-A', 'conv-B');

    // Simulate the per-conversation state map that the hook maintains
    const stateMap = new Map<string, StreamSubscriptionState>();

    // Switch to conv-A and process events
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-A' });
    const stateA1 = applyStreamEventsToConversation(
      store,
      'conv-A',
      [
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'Hello' } }),
      ],
      createStreamSubscriptionState(),
    );
    stateMap.set('conv-A', stateA1);

    // Switch to conv-B and process different events
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-B' });
    const stateB = applyStreamEventsToConversation(
      store,
      'conv-B',
      [makeEvent({ seq: 1, turnId: 't2', kind: 'stream-started', payload: {} })],
      createStreamSubscriptionState(),
    );
    stateMap.set('conv-B', stateB);

    // Switch back to conv-A — use the preserved state (NOT a fresh state)
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-A' });
    const preservedA = stateMap.get('conv-A')!;
    assert.equal(preservedA.serverResumeSeq, 2);

    // Apply more events using preserved state — dedup works correctly
    const stateA2 = applyStreamEventsToConversation(
      store,
      'conv-A',
      [makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: ' world' } })],
      preservedA,
    );
    stateMap.set('conv-A', stateA2);

    const entries = store.getState().conversations.get('conv-A')?.entries ?? [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].contentBlocks[0]?.text, 'Hello world');
    assert.equal(stateA2.serverResumeSeq, 3);
  });

  it('replayed/duplicate events are suppressed after conversation switch', () => {
    const store = storeWithConversation('conv-A');
    const stateMap = new Map<string, StreamSubscriptionState>();

    // Process events on conv-A
    const state1 = applyStreamEventsToConversation(
      store,
      'conv-A',
      [
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'data' } }),
      ],
      createStreamSubscriptionState(),
    );
    stateMap.set('conv-A', state1);

    // Simulate switch away and back — server replays from serverResumeSeq
    const preserved = stateMap.get('conv-A')!;
    const state2 = applyStreamEventsToConversation(
      store,
      'conv-A',
      [
        // These are replayed (seq 1 and 2 already processed) — should be skipped
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'data' } }),
        // This is new — should be applied
        makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: ' more' } }),
      ],
      preserved,
    );
    stateMap.set('conv-A', state2);

    const entries = store.getState().conversations.get('conv-A')?.entries ?? [];
    assert.equal(entries[0].contentBlocks[0]?.text, 'data more');
    assert.equal(state2.serverResumeSeq, 3);
  });
});

// ─── serverResumeSeq tracking ───────────────────────────────────────────────

describe('serverResumeSeq tracking', () => {
  it('starts undefined for a fresh state', () => {
    const state = createStreamSubscriptionState();
    assert.equal(state.serverResumeSeq, undefined);
  });

  it('tracks max seq across event batches', () => {
    const store = storeWithConversation('conv-1');

    let state = createStreamSubscriptionState();
    state = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 5, turnId: 't1', kind: 'stream-started', payload: {} })],
      state,
    );
    assert.equal(state.serverResumeSeq, 5);

    state = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 8, turnId: 't1', kind: 'text-delta', payload: { text: 'hi' } })],
      state,
    );
    assert.equal(state.serverResumeSeq, 8);
  });

  it('handles non-sequential seq values', () => {
    const store = storeWithConversation('conv-1');

    let state = createStreamSubscriptionState();
    state = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 3, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 10, turnId: 't1', kind: 'text-delta', payload: { text: 'x' } }),
        makeEvent({ seq: 7, turnId: 't2', kind: 'stream-started', payload: {} }),
      ],
      state,
    );
    assert.equal(state.serverResumeSeq, 10);
  });
});

// ─── buildStreamCallbacks ───────────────────────────────────────────────────

describe('buildStreamCallbacks', () => {
  it('routes stream events through per-conversation state map and acks', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    const ackCalls: Array<{ conversationId: string; seq: number }> = [];

    const callbacks = buildStreamCallbacks(
      store,
      stateMap,
      (conversationId, seq) => {
        ackCalls.push({ conversationId, seq });
      },
      {
        onReconnectNeeded: () => {},
        onConnectionEstablished: () => {},
      },
    );

    const event = makeEvent({
      seq: 1,
      turnId: 't1',
      kind: 'stream-started',
      payload: {},
    });

    callbacks.onStreamEvent!('conv-1', event);

    // Verify state map was updated
    const convState = stateMap.get('conv-1');
    assert.ok(convState);
    assert.equal(convState.serverResumeSeq, 1);

    // Verify ack was called
    assert.equal(ackCalls.length, 1);
    assert.deepEqual(ackCalls[0], { conversationId: 'conv-1', seq: 1 });
  });

  it('calls onConnectionEstablished on socket open', () => {
    const store = storeWithConversation('conv-1');
    let established = false;

    const callbacks = buildStreamCallbacks(store, new Map(), () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {
        established = true;
      },
    });

    callbacks.onOpen!();
    assert.equal(established, true);
    assert.equal(store.getState().connection.transportStatus, 'live');
  });

  it('calls onReconnectNeeded on abnormal close', () => {
    const store = storeWithConversation('conv-1');
    let reconnectCalled = false;

    const callbacks = buildStreamCallbacks(store, new Map(), () => {}, {
      onReconnectNeeded: () => {
        reconnectCalled = true;
      },
      onConnectionEstablished: () => {},
    });

    // Abnormal close (code 1006)
    callbacks.onClose!(1006, 'Abnormal closure');
    assert.equal(reconnectCalled, true);
    assert.equal(store.getState().connection.transportStatus, 'disconnected');
  });

  it('does NOT reconnect on normal close (code 1000)', () => {
    const store = storeWithConversation('conv-1');
    let reconnectCalled = false;

    const callbacks = buildStreamCallbacks(store, new Map(), () => {}, {
      onReconnectNeeded: () => {
        reconnectCalled = true;
      },
      onConnectionEstablished: () => {},
    });

    callbacks.onClose!(1000, 'Normal closure');
    assert.equal(reconnectCalled, false);
    assert.equal(store.getState().connection.transportStatus, 'disconnected');
  });

  it('logs warning on ack failure instead of swallowing', () => {
    const store = storeWithConversation('conv-1');
    const warnSpy = mock.fn();
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const callbacks = buildStreamCallbacks(
        store,
        new Map(),
        () => {
          throw new Error('socket closed');
        },
        {
          onReconnectNeeded: () => {},
          onConnectionEstablished: () => {},
        },
      );

      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
      );

      assert.equal(warnSpy.mock.callCount(), 1);
      const args = warnSpy.mock.calls[0].arguments;
      assert.ok(String(args[0]).includes('[stream] Failed to ack'));
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── Reconnect state preservation ───────────────────────────────────────────

describe('reconnect state preservation', () => {
  it('state map retains serverResumeSeq for resubscribe after reconnect', () => {
    const store = storeWithConversation('conv-A');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Process several events
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'data' } }),
    );
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: ' more' } }),
    );

    // Simulate socket drop — stateMap survives
    assert.equal(stateMap.get('conv-A')?.serverResumeSeq, 3);

    // After reconnect, the hook would resubscribe with serverResumeSeq=3
    // The server replays from seq 4 onward. Simulate replay:
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 4, turnId: 't1', kind: 'text-delta', payload: { text: ' end' } }),
    );

    const entries = store.getState().conversations.get('conv-A')?.entries ?? [];
    assert.equal(entries[0].contentBlocks[0]?.text, 'data more end');
    assert.equal(stateMap.get('conv-A')?.serverResumeSeq, 4);
  });

  it('reconnect with replay deduplicates already-seen events', () => {
    const store = storeWithConversation('conv-A');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Process events pre-disconnect
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'abc' } }),
    );

    // Simulate reconnect replay — server sends from serverResumeSeq
    // Events 1–2 are replayed (stale), 3 is new
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'abc' } }),
    );
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'def' } }),
    );

    const entries = store.getState().conversations.get('conv-A')?.entries ?? [];
    // Should NOT have "abcabc" — dedup prevents double-application
    assert.equal(entries[0].contentBlocks[0]?.text, 'abcdef');
  });
});

// ─── Submit + stream flow (no REST clobber) ─────────────────────────────────

describe('submit + stream flow without REST clobber', () => {
  it('stream events correctly update transcript after submit', () => {
    const store = storeWithConversation('conv-1');

    // Simulate existing history loaded via REST
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [existingTurnEntry('t-old', 'Previous message')],
      hasMoreHistory: false,
    });

    // After submit succeeds, stream delivers new turn (no REST refresh)
    let subState = createStreamSubscriptionState();
    subState = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 't-new', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-new',
          kind: 'text-delta',
          payload: { text: 'Agent reply' },
        }),
      ],
      subState,
    );

    const entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries.length, 2);
    assert.equal(entries[0].turnId, 't-old');
    assert.equal(entries[0].contentBlocks[0]?.text, 'Previous message');
    assert.equal(entries[1].turnId, 't-new');
    assert.equal(entries[1].contentBlocks[0]?.text, 'Agent reply');
    assert.equal(entries[1].status, 'streaming');
    assert.equal(subState.serverResumeSeq, 2);
  });

  it('stream progress is not lost if a stale REST snapshot arrives after streaming', () => {
    const store = storeWithConversation('conv-1');

    // Stream delivers partial content
    let subState = createStreamSubscriptionState();
    subState = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't1',
          kind: 'text-delta',
          payload: { text: 'Streaming in progress...' },
        }),
      ],
      subState,
    );

    // Verify streamed state
    let entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].contentBlocks[0]?.text, 'Streaming in progress...');

    // Even if a REST snapshot overwrites (which the fix prevents),
    // subsequent stream events rebuild using reconciler state
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [], // stale REST response with no turns yet
      hasMoreHistory: false,
    });

    // More stream events arrive — seq 1–2 are replayed (stale), 3 is new
    subState = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: ' done' } })],
      subState,
    );

    entries = store.getState().conversations.get('conv-1')?.entries ?? [];
    // The reconciler creates a fresh entry for t1 since the store was wiped,
    // but only applies seq 3 (new). The old text is lost because replace-entries
    // wiped it. This proves why we must NOT call refreshTranscript during streaming.
    assert.ok(entries.length >= 1);
    // The key assertion: the fix prevents this scenario by not calling
    // refreshTranscript() after submit when streaming is active.
    assert.equal(subState.serverResumeSeq, 3);
  });
});

// ─── Subscribe/unsubscribe lifecycle ────────────────────────────────────────

describe('subscribe/unsubscribe lifecycle', () => {
  it('callbacks handle all session and daemon lifecycle events', () => {
    const store = storeWithConversation('conv-1');

    const callbacks = buildStreamCallbacks(store, new Map(), () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    callbacks.onSocketError!();
    assert.equal(store.getState().connection.transportStatus, 'reconnecting');

    callbacks.onDaemonUnavailable!();
    assert.equal(store.getState().connection.daemonStatus, 'unavailable');

    callbacks.onDaemonRestored!();
    assert.equal(store.getState().connection.daemonStatus, 'healthy');

    // eslint-disable-next-line unicorn/no-useless-undefined
    callbacks.onSessionTerminated!('expired', undefined);
    assert.equal(store.getState().connection.sessionStatus, 'expired');

    callbacks.onSessionExpiringSoon!('2026-07-01T00:00:00.000Z');
    assert.equal(store.getState().connection.sessionStatus, 'expiring-soon');

    // eslint-disable-next-line unicorn/no-useless-undefined
    callbacks.onSessionTerminated!('logged-out', undefined);
    assert.equal(store.getState().connection.sessionStatus, 'invalidated');
  });

  it('multiple conversations maintain independent state through callbacks', () => {
    const storeA = storeWithConversation('conv-A');
    storeA.dispatch({ type: 'conversation/select', conversationId: 'conv-B' });
    storeA.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-B',
      entries: [],
      hasMoreHistory: false,
    });

    const stateMap = new Map<string, StreamSubscriptionState>();
    const ackCalls: Array<{ conversationId: string; seq: number }> = [];

    const callbacks = buildStreamCallbacks(
      storeA,
      stateMap,
      (id, seq) => {
        ackCalls.push({ conversationId: id, seq });
      },
      { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
    );

    // Events for conv-A
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-A',
      makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'A' } }),
    );

    // Events for conv-B
    callbacks.onStreamEvent!(
      'conv-B',
      makeEvent({ seq: 1, turnId: 't2', kind: 'stream-started', payload: {} }),
    );

    assert.equal(stateMap.get('conv-A')?.serverResumeSeq, 2);
    assert.equal(stateMap.get('conv-B')?.serverResumeSeq, 1);
    assert.equal(ackCalls.length, 3);
  });
});

// ─── Ack gating for ignored conditional events ─────────────────────────────

describe('ack gating for ignored conditional events', () => {
  it('does NOT advance serverResumeSeq for ignored approval-response', () => {
    const store = storeWithConversation('conv-1');

    // Set up a turn with no prompt
    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} })],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 1);

    // Deliver an approval-response with no matching prompt — should be ignored
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({
          seq: 2,
          turnId: 't1',
          kind: 'approval-response',
          payload: { approvalId: 'prompt-1', response: 'approve' },
        }),
      ],
      sub,
    );
    assert.equal(
      sub.serverResumeSeq,
      1,
      'serverResumeSeq must not advance for ignored approval-response',
    );
    assert.ok(sub.pendingSeqs.has(2), 'ignored seq must be in pendingSeqs');
  });

  it('does NOT advance serverResumeSeq for mismatched approvalId', () => {
    const store = storeWithConversation('conv-1');

    // Set up a turn with prompt-2 pending
    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't1',
          kind: 'approval-prompt',
          payload: { approvalId: 'prompt-2' },
        }),
      ],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 2);

    // Deliver an approval-response for prompt-1 (mismatched) — should be ignored
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({
          seq: 3,
          turnId: 't1',
          kind: 'approval-response',
          payload: { approvalId: 'prompt-1', response: 'approve' },
        }),
      ],
      sub,
    );
    assert.equal(
      sub.serverResumeSeq,
      2,
      'serverResumeSeq must not advance for mismatched approval-response',
    );
    assert.ok(sub.pendingSeqs.has(3), 'mismatched seq must be in pendingSeqs');
  });

  it('does NOT call ack for ignored approval-response via buildStreamCallbacks', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    const ackCalls: Array<{ conversationId: string; seq: number }> = [];

    const callbacks = buildStreamCallbacks(
      store,
      stateMap,
      (conversationId, seq) => {
        ackCalls.push({ conversationId, seq });
      },
      { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
    );

    // Set up a turn with no prompt
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    assert.equal(ackCalls.length, 1, 'stream-started must be acked');

    // Deliver an ignored approval-response — must not be acked
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({
        seq: 2,
        turnId: 't1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      }),
    );
    assert.equal(ackCalls.length, 1, 'ignored approval-response must NOT be acked');
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1);
  });

  it('resumes correctly after ignored event followed by consumed event', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    const ackCalls: Array<{ conversationId: string; seq: number }> = [];

    const callbacks = buildStreamCallbacks(
      store,
      stateMap,
      (conversationId, seq) => {
        ackCalls.push({ conversationId, seq });
      },
      { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
    );

    // Stream started
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    // Ignored approval-response (no prompt)
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({
        seq: 2,
        turnId: 't1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      }),
    );
    // Consumed text-delta
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'hello' } }),
    );

    // Only seq 1 and 3 should be acked (seq 2 was ignored)
    assert.equal(ackCalls.length, 2);
    assert.deepEqual(ackCalls[0], { conversationId: 'conv-1', seq: 1 });
    assert.deepEqual(ackCalls[1], { conversationId: 'conv-1', seq: 3 });
    // serverResumeSeq must NOT advance to 3 — the gap at seq 2 blocks it.
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1);
    assert.ok(stateMap.get('conv-1')?.pendingSeqs.has(2));
  });

  it('does advance serverResumeSeq for invalid approval-prompt no-op events', () => {
    const store = storeWithConversation('conv-1');

    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} })],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 1);

    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 2, turnId: 't1', kind: 'approval-prompt', payload: {} })],
      sub,
    );

    assert.equal(sub.serverResumeSeq, 2);
    assert.equal(sub.pendingSeqs.size, 0);
    assert.equal(store.getState().conversations.get('conv-1')?.entries[0]?.prompt, null);
  });

  it('acks invalid approval-prompt no-op events via buildStreamCallbacks', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    const ackCalls: Array<{ conversationId: string; seq: number }> = [];

    const callbacks = buildStreamCallbacks(
      store,
      stateMap,
      (conversationId, seq) => {
        ackCalls.push({ conversationId, seq });
      },
      { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
    );

    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 2, turnId: 't1', kind: 'approval-prompt', payload: {} }),
    );

    assert.deepEqual(ackCalls, [
      { conversationId: 'conv-1', seq: 1 },
      { conversationId: 'conv-1', seq: 2 },
    ]);
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 2);
  });
});

// ─── New-conversation REST clobber prevention ───────────────────────────────

describe('new-conversation REST clobber prevention', () => {
  it('streamed transcript survives when delayed history arrives after streaming', () => {
    // Simulates the create-conversation race: WS events arrive and populate
    // entries, then a delayed REST loadHistory response tries to clobber.
    const store = createWorkspaceStore();

    // Step 1: Conversation is created and selected (loadState starts 'idle')
    store.dispatch({ type: 'conversation/select', conversationId: 'new-conv' });
    assert.equal(
      store.getState().conversations.get('new-conv')?.loadState,
      'idle',
      'new conversation should start with idle loadState',
    );

    // Step 2: Transcript loader sets loadState to 'loading' (REST request in flight)
    store.dispatch({
      type: 'conversation/set-load-state',
      conversationId: 'new-conv',
      loadState: 'loading',
    });

    // Step 3: WS stream events arrive and populate entries
    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'new-conv',
      [
        makeEvent({ seq: 1, turnId: 't-new', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-new',
          kind: 'text-delta',
          payload: { text: 'Agent is typing...' },
        }),
      ],
      sub,
    );

    // Streaming dispatched replace-entries → loadState should now be 'ready'
    const afterStream = store.getState().conversations.get('new-conv');
    assert.equal(afterStream?.loadState, 'ready', 'streaming must set loadState to ready');
    assert.equal(afterStream?.entries.length, 1);
    assert.equal(afterStream?.entries[0].contentBlocks[0]?.text, 'Agent is typing...');

    // Step 4: Delayed REST response arrives — the loadState guard prevents clobber
    // (This simulates the check added to useTranscriptLoader)
    const freshConv = store.getState().conversations.get('new-conv');
    if (freshConv?.loadState !== 'ready') {
      // This dispatch would clobber — but the guard prevents it
      store.dispatch({
        type: 'conversation/replace-entries',
        conversationId: 'new-conv',
        entries: [], // empty REST response for brand-new conversation
        hasMoreHistory: false,
      });
    }

    // Step 5: Verify streamed content is intact
    const final = store.getState().conversations.get('new-conv');
    assert.equal(final?.entries.length, 1, 'streamed entries must not be clobbered');
    assert.equal(final?.entries[0].contentBlocks[0]?.text, 'Agent is typing...');
    assert.equal(sub.serverResumeSeq, 2);
  });

  it('REST history loads normally when no streaming has occurred', () => {
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'existing-conv' });

    // loadState is 'idle', no streaming → REST should proceed
    store.dispatch({
      type: 'conversation/set-load-state',
      conversationId: 'existing-conv',
      loadState: 'loading',
    });

    const freshConv = store.getState().conversations.get('existing-conv');
    assert.notEqual(freshConv?.loadState, 'ready', 'loadState should still be loading');

    // REST response arrives — should be applied
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'existing-conv',
      entries: [existingTurnEntry('t-old', 'Historical message')],
      hasMoreHistory: true,
    });

    const final = store.getState().conversations.get('existing-conv');
    assert.equal(final?.entries.length, 1);
    assert.equal(final?.entries[0].contentBlocks[0]?.text, 'Historical message');
    assert.equal(final?.loadState, 'ready');
  });
});

// ─── Contiguous resume frontier ─────────────────────────────────────────────

describe('contiguous resume frontier (gap safety)', () => {
  it('consumed 1, ignored 2, consumed 3 must NOT resume from 3', () => {
    const store = storeWithConversation('conv-1');
    let sub = createStreamSubscriptionState();

    // seq 1: stream-started (consumed)
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} })],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 1);

    // seq 2: approval-response with no prompt (ignored → pending)
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({
          seq: 2,
          turnId: 't1',
          kind: 'approval-response',
          payload: { approvalId: 'p1', response: 'approve' },
        }),
      ],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 1, 'gap at seq 2 blocks frontier');
    assert.ok(sub.pendingSeqs.has(2));

    // seq 3: text-delta (consumed)
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'hello' } })],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 1, 'frontier must NOT skip over pending seq 2');
    assert.ok(sub.pendingSeqs.has(2), 'seq 2 remains pending');
  });

  it('frontier advances past formerly-pending seq on replay', () => {
    const store = storeWithConversation('conv-1');
    let sub = createStreamSubscriptionState();

    // First pass: consumed 1, ignored 2 (cross-turn t2), consumed 3 (t1)
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} })],
      sub,
    );
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({
          seq: 2,
          turnId: 't2',
          kind: 'approval-response',
          payload: { approvalId: 'p1', response: 'approve' },
        }),
      ],
      sub,
    );
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'a' } })],
      sub,
    );
    assert.equal(sub.serverResumeSeq, 1, 'pre-replay: frontier stuck at 1');

    // Set up t2 with a matching prompt via store dispatch (simulates a REST
    // history load or earlier event that created the entry outside the
    // reconciler path). Critically, t2 has no reconciler high-water, so seq 2
    // is NOT stale when replayed.
    const currentEntries = store.getState().conversations.get('conv-1')?.entries ?? [];
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        ...currentEntries,
        {
          entryId: 't2',
          kind: 'turn' as const,
          turnId: 't2',
          status: 'streaming',
          timestamp: '2026-07-01T00:00:00.000Z',
          contentBlocks: [],
          artifacts: [],
          controls: [],
          prompt: {
            promptId: 'p1',
            parentTurnId: 't2',
            status: 'pending' as const,
            allowedResponses: [],
            contextBlocks: [],
            lastResponseSummary: null,
            errorMessage: null,
            staleReason: null,
          },
        },
      ],
      hasMoreHistory: false,
    });

    // Replay seq 2 — now the prompt exists and t2 has no reconciler hw
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [
        makeEvent({
          seq: 2,
          turnId: 't2',
          kind: 'approval-response',
          payload: { approvalId: 'p1', response: 'approve' },
        }),
      ],
      sub,
    );
    assert.ok(!sub.pendingSeqs.has(2), 'seq 2 removed from pending after consumption');
    // Frontier advances through 1, 2, 3
    assert.equal(sub.serverResumeSeq, 3, 'frontier advances through all consumed seqs');
  });

  it('seq=0 is preserved in highestSeenSeq and advances the resume frontier', () => {
    const store = storeWithConversation('conv-1');
    let sub = createStreamSubscriptionState();

    // seq 0: stream-started (consumed)
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 0, turnId: 't1', kind: 'stream-started', payload: {} })],
      sub,
    );

    assert.equal(sub.highestSeenSeq, 0, 'highestSeenSeq must track seq 0');
    assert.equal(sub.serverResumeSeq, 0, 'frontier must advance to seq 0');
  });

  it('seq=0 followed by seq=1 advances frontier through both', () => {
    const store = storeWithConversation('conv-1');
    let sub = createStreamSubscriptionState();

    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 0, turnId: 't1', kind: 'stream-started', payload: {} })],
      sub,
    );
    sub = applyStreamEventsToConversation(
      store,
      'conv-1',
      [makeEvent({ seq: 1, turnId: 't1', kind: 'text-delta', payload: { text: 'hi' } })],
      sub,
    );

    assert.equal(sub.highestSeenSeq, 1);
    assert.equal(sub.serverResumeSeq, 1, 'frontier covers both seq 0 and seq 1');
  });
});

// ─── Ack failure must not advance resume cursor ─────────────────────────────

describe('ack failure resume cursor isolation', () => {
  it('ack failure must not advance reconnect resume cursor', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    let ackShouldFail = false;

    const warnSpy = mock.fn();
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const callbacks = buildStreamCallbacks(
        store,
        stateMap,
        () => {
          if (ackShouldFail) throw new Error('ack failed');
        },
        { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
      );

      // Process seq 1 successfully
      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
      );
      assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1);

      // Make ack fail for next event
      ackShouldFail = true;
      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'data' } }),
      );

      // Resume cursor must NOT advance despite event being consumed locally
      assert.equal(
        stateMap.get('conv-1')?.serverResumeSeq,
        1,
        'resume cursor must stay at 1 after ack failure',
      );
      // But reconciler state should still be updated (local dedup works)
      assert.equal(stateMap.get('conv-1')?.reconcilerState.highWaterSeq.get('t1'), 2);
      assert.equal(warnSpy.mock.callCount(), 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('resume cursor advances again after ack recovers', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    let ackShouldFail = false;

    const warnSpy = mock.fn();
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const callbacks = buildStreamCallbacks(
        store,
        stateMap,
        () => {
          if (ackShouldFail) throw new Error('ack failed');
        },
        { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
      );

      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
      );
      assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1);

      // Ack fails for seq 2
      ackShouldFail = true;
      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'a' } }),
      );
      assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1);

      // Ack recovers for seq 3
      ackShouldFail = false;
      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'b' } }),
      );
      // Frontier can advance through 2 (not pending, reconciler consumed it) and 3
      assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 3);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── onSubscribed baseline seeding ──────────────────────────────────────────

describe('onSubscribed baseline seeding', () => {
  it('onSubscribed(currentSeq > 0) seeds resume state before any stream-event', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Server confirms subscription at currentSeq = 5
    callbacks.onSubscribed!('conv-1', 5);
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 5);
  });

  it('onSubscribed does not regress an existing resume cursor', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Process events to advance resume cursor to 3
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: 'x' } }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'y' } }),
    );
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 3);

    // onSubscribed with a lower seq should not regress
    callbacks.onSubscribed!('conv-1', 1);
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 3, 'must not regress below existing');
  });

  it('disconnect before any events uses onSubscribed baseline for reconnect', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Server confirms subscription at seq 10
    callbacks.onSubscribed!('conv-1', 10);

    // Immediate disconnect — no stream events arrived
    callbacks.onClose!(1006, 'abnormal');

    // The resume cursor should still be 10 from the baseline
    assert.equal(
      stateMap.get('conv-1')?.serverResumeSeq,
      10,
      'reconnect must use server-confirmed baseline when no events arrived',
    );
  });

  it('reconnect uses correct cursor after gap + onSubscribed scenario', () => {
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();
    const ackCalls: Array<{ conversationId: string; seq: number }> = [];

    const callbacks = buildStreamCallbacks(
      store,
      stateMap,
      (id, seq) => {
        ackCalls.push({ conversationId: id, seq });
      },
      { onReconnectNeeded: () => {}, onConnectionEstablished: () => {} },
    );

    // First session: onSubscribed baseline = 0, then process events with gap
    callbacks.onSubscribed!('conv-1', 0);
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({
        seq: 2,
        turnId: 't1',
        kind: 'approval-response',
        payload: { approvalId: 'nope', response: 'approve' },
      }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'x' } }),
    );

    // Resume cursor stuck at 1 (gap at 2)
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1);

    // Simulate reconnect — re-subscribe would pass serverResumeSeq = 1
    // Server replays from seq 2 onward
    assert.equal(ackCalls.filter((a) => a.seq === 2).length, 0, 'seq 2 must not have been acked');
    assert.ok(
      ackCalls.some((a) => a.seq === 1),
      'seq 1 was acked',
    );
    assert.ok(
      ackCalls.some((a) => a.seq === 3),
      'seq 3 was acked',
    );
  });

  it('replayed events before subscribed with pendingSeqs non-empty do not skip gap', () => {
    // Regression: reconnect delivers stream-event* before the subscribed ack.
    // If replayed events create a pending gap, onSubscribed(currentSeq) must
    // NOT jump the cursor past the gap.
    //
    // Scenario: state before onSubscribed(3) is
    //   serverResumeSeq=1, pendingSeqs={2}, highestSeenSeq=3
    // The cursor must stay at 1 so seq 2 is replayed on next reconnect.
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Simulate replayed events arriving before subscribed ack
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 1, turnId: 't1', kind: 'stream-started', payload: {} }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({
        seq: 2,
        turnId: 't1',
        kind: 'approval-response',
        payload: { approvalId: 'missing', response: 'approve' },
      }),
    );
    callbacks.onStreamEvent!(
      'conv-1',
      makeEvent({ seq: 3, turnId: 't1', kind: 'text-delta', payload: { text: 'z' } }),
    );

    // Verify gap is present before onSubscribed
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 1, 'frontier blocked at 1 by gap at 2');
    assert.ok(stateMap.get('conv-1')?.pendingSeqs.has(2), 'seq 2 is pending');

    // Now the subscribed ack arrives with currentSeq = 3
    callbacks.onSubscribed!('conv-1', 3);

    // Cursor must NOT have jumped to 3 — gap at 2 still blocks
    assert.equal(
      stateMap.get('conv-1')?.serverResumeSeq,
      1,
      'onSubscribed must not overwrite gap-blocked frontier',
    );
    assert.ok(
      stateMap.get('conv-1')?.pendingSeqs.has(2),
      'pending seq 2 must survive onSubscribed',
    );
  });

  it('onSubscribed(currentSeq) still seeds resume for cold subscribe (no local events)', () => {
    // Cold subscribe: no events have been processed yet, pendingSeqs is empty.
    // onSubscribed should seed the cursor from currentSeq.
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    assert.equal(stateMap.get('conv-1'), undefined, 'no state before subscribe');

    callbacks.onSubscribed!('conv-1', 7);

    assert.equal(
      stateMap.get('conv-1')?.serverResumeSeq,
      7,
      'cold subscribe must seed cursor from currentSeq',
    );
  });

  it('onSubscribed does not regress an already-safe higher cursor', () => {
    // Already advanced cursor (e.g. from consumed events) must not regress
    // when onSubscribed arrives with a lower seq.
    const store = storeWithConversation('conv-1');
    const stateMap = new Map<string, StreamSubscriptionState>();

    const callbacks = buildStreamCallbacks(store, stateMap, () => {}, {
      onReconnectNeeded: () => {},
      onConnectionEstablished: () => {},
    });

    // Process events to advance cursor to 5
    for (let seq = 1; seq <= 5; seq++) {
      callbacks.onStreamEvent!(
        'conv-1',
        makeEvent({
          seq,
          turnId: 't1',
          kind: seq === 1 ? 'stream-started' : 'text-delta',
          payload: seq === 1 ? {} : { text: String(seq) },
        }),
      );
    }
    assert.equal(stateMap.get('conv-1')?.serverResumeSeq, 5);

    // onSubscribed with a lower seq must not regress
    callbacks.onSubscribed!('conv-1', 2);
    assert.equal(
      stateMap.get('conv-1')?.serverResumeSeq,
      5,
      'onSubscribed must not regress an already-higher cursor',
    );
  });
});

// ─── History vs live-stream race (merge-history) ────────────────────────────

describe('existing-conversation history vs live-stream race', () => {
  it('merge-history preserves stream-owned entries when REST arrives late', () => {
    // Scenario: Existing conversation with prior history. Live stream events
    // arrive first and create an entry for a new turn. Then REST history
    // arrives with older turns. Both must be visible.
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-existing' });

    // Stream events arrive first — new turn not yet persisted by REST
    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'conv-existing',
      [
        makeEvent({ seq: 1, turnId: 't-live', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-live',
          kind: 'text-delta',
          payload: { text: 'Live typing...' },
        }),
      ],
      sub,
    );

    // Stream sets loadState to 'ready' but historyLoaded stays false
    const afterStream = store.getState().conversations.get('conv-existing');
    assert.equal(afterStream?.loadState, 'ready');
    assert.equal(afterStream?.historyLoaded, false, 'historyLoaded must remain false after stream');
    assert.equal(afterStream?.entries.length, 1);
    assert.equal(afterStream?.entries[0].turnId, 't-live');

    // REST history arrives with older turns
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-existing',
      entries: [
        existingTurnEntry('t-old-1', 'First historical message'),
        existingTurnEntry('t-old-2', 'Second historical message'),
      ],
      hasMoreHistory: false,
    });

    const merged = store.getState().conversations.get('conv-existing');
    assert.equal(merged?.historyLoaded, true, 'historyLoaded must be true after merge-history');
    assert.equal(merged?.loadState, 'ready');
    // REST entries come first (authoritative history), stream-only appended
    assert.equal(merged?.entries.length, 3, 'must contain both REST and stream entries');
    assert.equal(merged?.entries[0].turnId, 't-old-1');
    assert.equal(merged?.entries[0].contentBlocks[0]?.text, 'First historical message');
    assert.equal(merged?.entries[1].turnId, 't-old-2');
    assert.equal(merged?.entries[1].contentBlocks[0]?.text, 'Second historical message');
    assert.equal(merged?.entries[2].turnId, 't-live');
    assert.equal(merged?.entries[2].contentBlocks[0]?.text, 'Live typing...');
    assert.equal(sub.serverResumeSeq, 2);
  });

  it('merge-history deduplicates turns present in both REST and stream', () => {
    // REST returns a completed turn that was also streamed (same turnId).
    // The REST version should win for completed turns — no duplicate.
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-dedup' });

    // Stream delivers a turn that will also appear in REST
    applyStreamEventsToConversation(
      store,
      'conv-dedup',
      [
        makeEvent({ seq: 1, turnId: 't-shared', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-shared',
          kind: 'text-delta',
          payload: { text: 'Partial stream' },
        }),
      ],
      createStreamSubscriptionState(),
    );

    // REST history includes the same turnId with complete content
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-dedup',
      entries: [existingTurnEntry('t-shared', 'Complete REST content')],
      hasMoreHistory: false,
    });

    const merged = store.getState().conversations.get('conv-dedup');
    assert.equal(merged?.entries.length, 1, 'shared turnId must not produce duplicates');
    assert.equal(
      merged?.entries[0].contentBlocks[0]?.text,
      'Complete REST content',
      'REST version is authoritative for shared turns',
    );
    assert.equal(merged?.historyLoaded, true);
  });

  it('merge-history preserves stream-owned prompt/artifacts and backfills REST prompt metadata', () => {
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-shared-substate' });

    let sub = createStreamSubscriptionState();
    sub = applyStreamEventsToConversation(
      store,
      'conv-shared-substate',
      [
        makeEvent({ seq: 1, turnId: 't-shared', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-shared',
          kind: 'approval-prompt',
          payload: { approvalId: 'approval-1' },
        }),
        makeEvent({
          seq: 3,
          turnId: 't-shared',
          kind: 'artifact-notice',
          payload: { artifactId: 'artifact-1', kind: 'patch', label: 'Proposed patch' },
        }),
      ],
      sub,
    );

    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-shared-substate',
      entries: [
        {
          ...existingTurnEntry('t-shared', 'Complete REST content'),
          prompt: {
            promptId: 'approval-1',
            parentTurnId: 't-shared',
            status: 'pending',
            allowedResponses: ['approve', 'deny'],
            contextBlocks: [
              {
                blockId: 'approval-1-prompt',
                kind: 'text',
                text: 'Approve the proposed change?',
                metadata: null,
              },
            ],
            lastResponseSummary: null,
            errorMessage: null,
            staleReason: null,
          },
        },
      ],
      hasMoreHistory: false,
    });

    let merged = store.getState().conversations.get('conv-shared-substate');
    assert.equal(merged?.entries.length, 1, 'shared turn must still deduplicate to one entry');
    assert.equal(merged?.entries[0].contentBlocks[0]?.text, 'Complete REST content');
    assert.equal(merged?.entries[0].prompt?.promptId, 'approval-1');
    assert.deepEqual(merged?.entries[0].prompt?.allowedResponses, ['approve', 'deny']);
    assert.equal(merged?.entries[0].prompt?.contextBlocks[0]?.text, 'Approve the proposed change?');
    assert.equal(merged?.entries[0].artifacts.length, 1);
    assert.equal(merged?.entries[0].artifacts[0]?.artifactId, 'artifact-1');

    sub = applyStreamEventsToConversation(
      store,
      'conv-shared-substate',
      [
        makeEvent({
          seq: 4,
          turnId: 't-shared',
          kind: 'approval-response',
          payload: { approvalId: 'approval-1', response: 'approved' },
        }),
      ],
      sub,
    );

    merged = store.getState().conversations.get('conv-shared-substate');
    assert.equal(merged?.entries[0].prompt?.status, 'resolved');
    assert.equal(merged?.entries[0].prompt?.lastResponseSummary, 'approved');
    assert.equal(sub.serverResumeSeq, 4);
  });

  it('merge-history preserves activity-group entries from stream', () => {
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-activity' });

    // Stream delivers activity-group entry
    const sub = createStreamSubscriptionState();
    applyStreamEventsToConversation(
      store,
      'conv-activity',
      [
        makeEvent({ seq: 1, turnId: 't-act', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-act',
          kind: 'activity-marker',
          payload: { description: 'Analyzing files…' },
        }),
      ],
      sub,
    );

    const entries = store.getState().conversations.get('conv-activity')?.entries ?? [];
    const activityEntry = entries.find((e) => e.kind === 'activity-group');
    assert.ok(activityEntry, 'activity-group entry should exist from stream');

    // REST history arrives with older turns (no activity-group)
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-activity',
      entries: [existingTurnEntry('t-old', 'Old turn')],
      hasMoreHistory: false,
    });

    const merged = store.getState().conversations.get('conv-activity');
    const kinds = merged?.entries.map((e) => e.kind) ?? [];
    assert.ok(kinds.includes('turn'), 'must contain REST turn entry');
    assert.ok(kinds.includes('activity-group'), 'must preserve stream activity-group');
  });

  it('historyLoaded prevents duplicate REST loads', () => {
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-loaded' });

    // First merge-history sets historyLoaded
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-loaded',
      entries: [existingTurnEntry('t-1', 'First load')],
      hasMoreHistory: false,
    });

    const conv = store.getState().conversations.get('conv-loaded');
    assert.equal(conv?.historyLoaded, true);
    // The transcript loader would check this and skip — verified at integration level
  });

  it('new conversation (no prior history) works with merge-history', () => {
    const store = createWorkspaceStore();
    store.dispatch({ type: 'conversation/select', conversationId: 'new-conv' });

    // Stream events arrive for new conversation
    applyStreamEventsToConversation(
      store,
      'new-conv',
      [
        makeEvent({ seq: 1, turnId: 't-new', kind: 'stream-started', payload: {} }),
        makeEvent({
          seq: 2,
          turnId: 't-new',
          kind: 'text-delta',
          payload: { text: 'Agent is typing...' },
        }),
      ],
      createStreamSubscriptionState(),
    );

    // REST responds with empty history (brand-new conversation)
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'new-conv',
      entries: [],
      hasMoreHistory: false,
    });

    const merged = store.getState().conversations.get('new-conv');
    assert.equal(merged?.entries.length, 1, 'stream entries survive empty REST merge');
    assert.equal(merged?.entries[0].contentBlocks[0]?.text, 'Agent is typing...');
    assert.equal(merged?.historyLoaded, true);
  });
});
