/**
 * Unit tests for EventBridge — daemon-side event subscription mechanism.
 *
 * Covers: event emission with correct shape, multiple listeners, unsubscription,
 * cleanup, typed payload validation, and StreamManager bridge integration.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventBridge } from '../lib/daemon/event-bridge.ts';
import { StreamManager } from '../lib/daemon/stream-manager.ts';
import { ConversationStore } from '../lib/daemon/conversation-store.ts';

import type { StreamEvent } from '@hydra/web-contracts';
import type { StreamEventPayload } from '../lib/daemon/event-bridge.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStreamEvent(overrides?: Partial<StreamEvent>): StreamEvent {
  return {
    seq: 1,
    turnId: 'turn-abc',
    kind: 'text-delta',
    payload: { text: 'hello' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

let bridge: EventBridge;

beforeEach(() => {
  bridge = new EventBridge();
});

// ── Event emission shape ─────────────────────────────────────────────────────

describe('EventBridge — emission shape', () => {
  it('emits stream-event with { conversationId, event } payload', () => {
    const received: Array<{ conversationId: string; event: StreamEvent }> = [];
    bridge.on('stream-event', (data) => received.push(data));

    const event = makeStreamEvent();
    bridge.emitStreamEvent('conv-1', event);

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, 'conv-1');
    assert.deepStrictEqual(received[0].event, event);
  });

  it('preserves all StreamEvent fields in emitted payload', () => {
    const received: Array<{ conversationId: string; event: StreamEvent }> = [];
    bridge.on('stream-event', (data) => received.push(data));

    const event = makeStreamEvent({
      seq: 42,
      turnId: 'turn-xyz',
      kind: 'stream-completed',
      payload: { responseLength: 100 },
    });
    bridge.emitStreamEvent('conv-2', event);

    assert.equal(received[0].event.seq, 42);
    assert.equal(received[0].event.turnId, 'turn-xyz');
    assert.equal(received[0].event.kind, 'stream-completed');
    assert.deepStrictEqual(received[0].event.payload, { responseLength: 100 });
  });
});

// ── Multiple listeners ───────────────────────────────────────────────────────

describe('EventBridge — multiple listeners', () => {
  it('delivers the same event to all registered listeners', () => {
    const receivedA: Array<{ conversationId: string; event: StreamEvent }> = [];
    const receivedB: Array<{ conversationId: string; event: StreamEvent }> = [];

    bridge.on('stream-event', (data) => receivedA.push(data));
    bridge.on('stream-event', (data) => receivedB.push(data));

    const event = makeStreamEvent();
    bridge.emitStreamEvent('conv-1', event);

    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);
    assert.deepStrictEqual(receivedA[0], receivedB[0]);
  });
});

// ── Unsubscription ───────────────────────────────────────────────────────────

describe('EventBridge — unsubscription', () => {
  it('removeListener stops delivery to that listener', () => {
    const received: Array<{ conversationId: string; event: StreamEvent }> = [];
    const listener = (data: { conversationId: string; event: StreamEvent }) => received.push(data);

    bridge.on('stream-event', listener);
    bridge.emitStreamEvent('conv-1', makeStreamEvent());
    assert.equal(received.length, 1);

    bridge.removeListener('stream-event', listener);
    bridge.emitStreamEvent('conv-1', makeStreamEvent());
    assert.equal(received.length, 1, 'should not receive after removeListener');
  });

  it('removeAllListeners stops delivery to all listeners', () => {
    const receivedA: Array<{ conversationId: string; event: StreamEvent }> = [];
    const receivedB: Array<{ conversationId: string; event: StreamEvent }> = [];

    bridge.on('stream-event', (data) => receivedA.push(data));
    bridge.on('stream-event', (data) => receivedB.push(data));

    bridge.emitStreamEvent('conv-1', makeStreamEvent());
    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);

    bridge.removeAllListeners('stream-event');
    bridge.emitStreamEvent('conv-1', makeStreamEvent());
    assert.equal(receivedA.length, 1, 'A should not receive after removeAll');
    assert.equal(receivedB.length, 1, 'B should not receive after removeAll');
  });
});

// ── No event leaks after cleanup ─────────────────────────────────────────────

describe('EventBridge — cleanup', () => {
  it('dispose removes all existing listeners', () => {
    const received: Array<{ conversationId: string; event: StreamEvent }> = [];
    bridge.on('stream-event', (data) => received.push(data));

    bridge.dispose();
    bridge.emitStreamEvent('conv-1', makeStreamEvent());

    assert.equal(received.length, 0, 'no events should be delivered to pre-dispose listeners');
  });

  it('new listeners added after dispose still receive events', () => {
    bridge.on('stream-event', () => {});
    bridge.dispose();

    const received: Array<{ conversationId: string; event: StreamEvent }> = [];
    bridge.on('stream-event', (data) => received.push(data));
    bridge.emitStreamEvent('conv-1', makeStreamEvent());

    assert.equal(received.length, 1, 'post-dispose listener should receive events');
  });

  it('listenerCount returns 0 after dispose', () => {
    bridge.on('stream-event', () => {});
    bridge.on('stream-event', () => {});
    assert.equal(bridge.listenerCount('stream-event'), 2);

    bridge.dispose();
    assert.equal(bridge.listenerCount('stream-event'), 0);
  });

  it('no listeners remain when none were registered', () => {
    assert.equal(bridge.listenerCount('stream-event'), 0);
    bridge.emitStreamEvent('conv-1', makeStreamEvent()); // should not throw
  });
});

// ── StreamManager + EventBridge integration ──────────────────────────────────

const operatorAttribution = { type: 'operator' as const, label: 'Admin' };

/** Helper: create a conversation + turn wired to a bridge-enabled StreamManager. */
function setupBridgedStream() {
  const store = new ConversationStore();
  const eventBridge = new EventBridge();
  const sm = new StreamManager(store, undefined, eventBridge);
  const conv = store.createConversation();
  const turn = store.appendTurn(conv.id, {
    kind: 'operator',
    instruction: 'Hello',
    attribution: operatorAttribution,
  });
  store.updateTurnStatus(turn.id, 'executing');
  return { store, eventBridge, sm, conv, turn };
}

describe('StreamManager + EventBridge — createStream', () => {
  it('emits stream-started through the bridge on createStream', () => {
    const { eventBridge, sm, conv, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.createStream(turn.id);

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, conv.id);
    assert.equal(received[0].event.kind, 'stream-started');
    assert.equal(received[0].event.turnId, turn.id);
  });
});

describe('StreamManager + EventBridge — emitEvent', () => {
  it('emits text-delta through the bridge', () => {
    const { eventBridge, sm, conv, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    sm.createStream(turn.id);
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.emitEvent(turn.id, 'text-delta', { text: 'chunk' });

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, conv.id);
    assert.equal(received[0].event.kind, 'text-delta');
    assert.deepStrictEqual(received[0].event.payload, { text: 'chunk' });
  });

  it('emits activity-marker through the bridge', () => {
    const { eventBridge, sm, conv, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    sm.createStream(turn.id);
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.emitEvent(turn.id, 'activity-marker', { agentId: 'gemini', description: 'Thinking...' });

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, conv.id);
    assert.equal(received[0].event.kind, 'activity-marker');
  });
});

describe('StreamManager + EventBridge — completeStream', () => {
  it('emits stream-completed through the bridge', () => {
    const { eventBridge, sm, conv, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    sm.createStream(turn.id);
    sm.emitEvent(turn.id, 'text-delta', { text: 'response' });
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.completeStream(turn.id);

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, conv.id);
    assert.equal(received[0].event.kind, 'stream-completed');
  });
});

describe('StreamManager + EventBridge — failStream', () => {
  it('emits stream-failed through the bridge', () => {
    const { eventBridge, sm, conv, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    sm.createStream(turn.id);
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.failStream(turn.id, 'Something went wrong');

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, conv.id);
    assert.equal(received[0].event.kind, 'stream-failed');
    assert.deepStrictEqual(received[0].event.payload, { reason: 'Something went wrong' });
  });
});

describe('StreamManager + EventBridge — cancelStream', () => {
  it('emits cancellation through the bridge', () => {
    const { eventBridge, sm, conv, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    sm.createStream(turn.id);
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.cancelStream(turn.id);

    assert.equal(received.length, 1);
    assert.equal(received[0].conversationId, conv.id);
    assert.equal(received[0].event.kind, 'cancellation');
  });
});

// ── Listener isolation ───────────────────────────────────────────────────────

describe('EventBridge — listener isolation', () => {
  it('delivers event to remaining listeners when one throws', () => {
    const received: StreamEventPayload[] = [];
    bridge.on('stream-event', () => {
      throw new Error('boom');
    });
    bridge.on('stream-event', (data) => received.push(data));

    const warnMock = mock.method(console, 'warn', () => {});
    try {
      const event = makeStreamEvent();
      bridge.emitStreamEvent('conv-1', event);

      assert.equal(received.length, 1, 'second listener should still receive the event');
      assert.equal(received[0].conversationId, 'conv-1');
      assert.deepStrictEqual(received[0].event, event);
    } finally {
      warnMock.mock.restore();
    }
  });

  it('delivers event to earlier listeners even when a later one throws', () => {
    const received: StreamEventPayload[] = [];
    bridge.on('stream-event', (data) => received.push(data));
    bridge.on('stream-event', () => {
      throw new Error('boom');
    });

    const warnMock = mock.method(console, 'warn', () => {});
    try {
      bridge.emitStreamEvent('conv-1', makeStreamEvent());
      assert.equal(received.length, 1, 'first listener should receive the event');
    } finally {
      warnMock.mock.restore();
    }
  });

  it('logs a warning per throwing listener', () => {
    const warnMock = mock.method(console, 'warn', () => {});
    try {
      bridge.on('stream-event', () => {
        throw new Error('first boom');
      });
      bridge.on('stream-event', () => {
        throw new Error('second boom');
      });

      bridge.emitStreamEvent('conv-1', makeStreamEvent({ kind: 'text-delta', turnId: 'turn-99' }));

      assert.equal(warnMock.mock.callCount(), 2, 'one warning per throwing listener');
      const msg0 = String(warnMock.mock.calls[0].arguments[0]);
      assert.ok(msg0.includes('[EventBridge]'));
      assert.ok(msg0.includes('text-delta'));
      assert.ok(msg0.includes('first boom'));
      const msg1 = String(warnMock.mock.calls[1].arguments[0]);
      assert.ok(msg1.includes('second boom'));
    } finally {
      warnMock.mock.restore();
    }
  });
});

// ── Throwing-listener resilience ──────────────────────────────────────────────

describe('StreamManager + EventBridge — throwing listener resilience', () => {
  it('createStream succeeds even when a bridge listener throws', () => {
    const { eventBridge, sm, turn } = setupBridgedStream();
    eventBridge.on('stream-event', () => {
      throw new Error('boom from listener');
    });

    const streamId = sm.createStream(turn.id);

    // Stream must be fully registered despite the throwing listener.
    assert.ok(streamId, 'createStream should return a stream id');
    assert.equal(sm.isStreamActive(turn.id), true, 'stream should be active');
    assert.equal(sm.getStreamId(turn.id), streamId, 'streamByTurnId should be set');

    const events = sm.getStreamEvents(turn.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'stream-started');
  });

  it('completeStream finalizes the turn even when a bridge listener throws', () => {
    const { eventBridge, sm, store, turn } = setupBridgedStream();
    sm.createStream(turn.id);
    sm.emitEvent(turn.id, 'text-delta', { text: 'hello' });

    // Attach throwing listener *after* stream creation so it only fires on complete.
    eventBridge.on('stream-event', () => {
      throw new Error('boom from listener');
    });

    sm.completeStream(turn.id);

    // Turn must be finalized with the consolidated response.
    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.status, 'completed', 'turn status should be completed');
    assert.equal(finalTurn?.response, 'hello', 'turn response should be consolidated');

    // Stream should be in terminal state.
    assert.equal(sm.isStreamActive(turn.id), false, 'stream should no longer be active');
  });

  it('failStream finalizes the turn even when a bridge listener throws', () => {
    const { eventBridge, sm, store, turn } = setupBridgedStream();
    sm.createStream(turn.id);

    eventBridge.on('stream-event', () => {
      throw new Error('boom from listener');
    });

    sm.failStream(turn.id, 'agent crashed');

    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.status, 'failed', 'turn status should be failed');
    assert.equal(sm.isStreamActive(turn.id), false);
  });

  it('cancelStream finalizes the turn even when a bridge listener throws', () => {
    const { eventBridge, sm, store, turn } = setupBridgedStream();
    sm.createStream(turn.id);

    eventBridge.on('stream-event', () => {
      throw new Error('boom from listener');
    });

    sm.cancelStream(turn.id);

    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.status, 'cancelled', 'turn status should be cancelled');
    assert.equal(sm.isStreamActive(turn.id), false);
  });

  it('emitEvent records the event even when a bridge listener throws', () => {
    const { eventBridge, sm, turn } = setupBridgedStream();
    sm.createStream(turn.id);

    eventBridge.on('stream-event', () => {
      throw new Error('boom from listener');
    });

    const event = sm.emitEvent(turn.id, 'text-delta', { text: 'chunk' });

    assert.ok(event, 'emitEvent should return the event');
    const events = sm.getStreamEvents(turn.id);
    const deltas = events.filter((e) => e.kind === 'text-delta');
    assert.equal(deltas.length, 1, 'text-delta should be recorded');
  });
});

describe('StreamManager + EventBridge — listener-failure observability', () => {
  it('logs a warning with turn and event kind when a bridge listener throws', () => {
    const { eventBridge, sm, turn } = setupBridgedStream();
    eventBridge.on('stream-event', () => {
      throw new Error('boom from listener');
    });

    const warnMock = mock.method(console, 'warn', () => {});
    try {
      sm.createStream(turn.id);

      assert.equal(warnMock.mock.callCount(), 1, 'console.warn should be called once');
      const msg = String(warnMock.mock.calls[0].arguments[0]);
      assert.ok(msg.includes('EventBridge'), 'warning should mention EventBridge');
      assert.ok(msg.includes(turn.id), 'warning should include turnId');
      assert.ok(msg.includes('stream-started'), 'warning should include event kind');
      assert.ok(msg.includes('boom from listener'), 'warning should include error message');
    } finally {
      warnMock.mock.restore();
    }
  });
});

describe('StreamManager + EventBridge — no bridge (backward compat)', () => {
  it('works without a bridge (existing constructor signature)', () => {
    const store = new ConversationStore();
    const sm = new StreamManager(store);
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');

    sm.createStream(turn.id);
    sm.emitEvent(turn.id, 'text-delta', { text: 'hi' });
    sm.completeStream(turn.id);

    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.response, 'hi');
    assert.equal(finalTurn?.status, 'completed');
  });
});

describe('StreamManager + EventBridge — full lifecycle', () => {
  it('emits all lifecycle events through the bridge in order', () => {
    const { eventBridge, sm, turn } = setupBridgedStream();
    const received: StreamEventPayload[] = [];
    eventBridge.on('stream-event', (data) => received.push(data));

    sm.createStream(turn.id);
    sm.emitEvent(turn.id, 'text-delta', { text: 'a' });
    sm.emitEvent(turn.id, 'text-delta', { text: 'b' });
    sm.completeStream(turn.id);

    assert.equal(received.length, 4);
    assert.equal(received[0].event.kind, 'stream-started');
    assert.equal(received[1].event.kind, 'text-delta');
    assert.equal(received[2].event.kind, 'text-delta');
    assert.equal(received[3].event.kind, 'stream-completed');

    // Sequence numbers should be monotonically increasing
    for (let i = 1; i < received.length; i++) {
      assert.ok(
        received[i].event.seq > received[i - 1].event.seq,
        'seq should be strictly increasing across bridge events',
      );
    }
  });
});
