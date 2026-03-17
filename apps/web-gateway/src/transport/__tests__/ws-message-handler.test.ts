/**
 * Tests for WsMessageHandler (T026).
 *
 * Covers: subscribe, unsubscribe, ack, malformed messages,
 * buffer-hit replay, replay barrier, and simultaneous replay/live
 * across conversations on the same connection.
 */
import { describe, it, beforeEach } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@hydra/web-contracts';
import type { ManagedConnection } from '../connection-registry.ts';
import { ConnectionRegistry } from '../connection-registry.ts';
import { EventBuffer } from '../event-buffer.ts';
import { serializeServerMessage, type ServerMessage } from '../ws-protocol.ts';
import { WsMessageHandler, type MessageHandlerDeps } from '../ws-message-handler.ts';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEvent(seq: number, kind: StreamEvent['kind'] = 'text-delta'): StreamEvent {
  return {
    seq,
    turnId: `turn-${seq}`,
    kind,
    payload: { text: `chunk-${seq}` },
    timestamp: new Date().toISOString(),
  };
}

/** Track all messages sent through connection.send(). */
function fakeConnection(
  connectionId: string,
  sessionId: string,
): ManagedConnection & {
  sent: ServerMessage[];
  _bufferedAmount: number;
  closeCode?: number;
  closeReason?: string;
} {
  let closed = false;
  const sent: ServerMessage[] = [];
  const connection: ManagedConnection & {
    sent: ServerMessage[];
    _bufferedAmount: number;
    closeCode?: number;
    closeReason?: string;
  } = {
    connectionId,
    sessionId,
    subscribedConversations: new Set(),
    lastAckSeq: new Map(),
    replayState: new Map(),
    pendingEvents: new Map(),
    _bufferedAmount: 0,
    get bufferedAmount() {
      return connection._bufferedAmount;
    },
    sent,
    send(message: ServerMessage): void {
      sent.push(message);
    },
    updateAck(conversationId: string, seq: number): void {
      const current = connection.lastAckSeq.get(conversationId) ?? -1;
      if (seq > current) {
        connection.lastAckSeq.set(conversationId, seq);
      }
    },
    close(code?: number, reason?: string): void {
      closed = true;
      connection.closeCode = code;
      connection.closeReason = reason;
    },
    get isClosed() {
      return closed;
    },
  };
  return connection;
}

function streamEventSize(conversationId: string, event: StreamEvent): number {
  return Buffer.byteLength(
    serializeServerMessage({
      type: 'stream-event',
      conversationId,
      event,
    }),
    'utf8',
  );
}

/** Stub DaemonClient that recognises a set of "valid" conversation IDs. */
function fakeDaemonClient(validIds: Set<string>): MessageHandlerDeps['daemonClient'] {
  return {
    async openConversation(conversationId: string) {
      if (validIds.has(conversationId)) {
        return {
          data: {
            conversation: {
              id: conversationId,
              status: 'active' as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              turnCount: 0,
              pendingInstructionCount: 0,
            },
            recentTurns: [],
            totalTurnCount: 0,
            pendingApprovals: [],
          },
        };
      }
      return {
        error: {
          ok: false as const,
          code: 'CONVERSATION_NOT_FOUND',
          category: 'validation' as const,
          message: 'Conversation not found',
        },
      };
    },
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('WsMessageHandler', () => {
  let registry: ConnectionRegistry;
  let buffer: EventBuffer;
  let handler: WsMessageHandler;
  let conn: ManagedConnection & { sent: ServerMessage[] };
  const validConvs = new Set(['conv-1', 'conv-2', 'conv-3']);
  const HIGH_WATER_MARK = 256;

  beforeEach(() => {
    registry = new ConnectionRegistry();
      buffer = new EventBuffer(100);
      handler = new WsMessageHandler({
        registry,
        buffer,
        daemonClient: fakeDaemonClient(validConvs),
        bufferHighWaterMark: HIGH_WATER_MARK,
      });
    conn = fakeConnection('c1', 's1');
    registry.register(conn);
  });

  // ─── subscribe (no replay) ──────────────────────────────────────────────

  describe('subscribe', () => {
    it('subscribes to a valid conversation and responds with subscribed + currentSeq', async () => {
      const msg = JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      const resp = conn.sent[0];
      assert.equal(resp.type, 'subscribed');
      assert.equal((resp as { conversationId: string }).conversationId, 'conv-1');
      assert.equal((resp as { currentSeq: number }).currentSeq, 0);

      // Registry tracks subscription
      assert.ok(conn.subscribedConversations.has('conv-1'));
      assert.equal(registry.getByConversation('conv-1').size, 1);

      // Replay state is 'live'
      assert.equal(conn.replayState.get('conv-1'), 'live');
    });

    it('returns currentSeq from buffer highwater when events exist', async () => {
      buffer.push('conv-1', makeEvent(5));
      buffer.push('conv-1', makeEvent(10));

      const msg = JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' });
      await handler.handleMessage(conn, msg);

      const resp = conn.sent[0];
      assert.equal(resp.type, 'subscribed');
      assert.equal((resp as { currentSeq: number }).currentSeq, 10);
    });

    it('treats duplicate subscribe for the same conversation as idempotent', async () => {
      buffer.push('conv-1', makeEvent(1));
      buffer.push('conv-1', makeEvent(2));

      const replayingSubscribe = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      await handler.handleMessage(conn, replayingSubscribe);
      conn.sent.splice(0);

      await handler.handleMessage(conn, replayingSubscribe);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'subscribed');
      assert.equal((conn.sent[0] as { currentSeq: number }).currentSeq, 2);
    });

    it('closes duplicate subscribe when the subscribed acknowledgement would exceed the buffer threshold', async () => {
      buffer.push('conv-1', makeEvent(1));
      await handler.handleMessage(conn, JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
      conn.sent.splice(0);

      const subscribedSize = Buffer.byteLength(
        serializeServerMessage({
          type: 'subscribed',
          conversationId: 'conv-1',
          currentSeq: 1,
        }),
        'utf8',
      );
      conn._bufferedAmount = HIGH_WATER_MARK - subscribedSize + 1;

      await handler.handleMessage(conn, JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));

      assert.equal(conn.isClosed, true);
      assert.equal(conn.closeCode, 1008);
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_BUFFER_OVERFLOW');
      assert.equal(conn.subscribedConversations.has('conv-1'), false);
    });

    it('rejects non-existent conversation with error', async () => {
      const msg = JSON.stringify({ type: 'subscribe', conversationId: 'invalid-conv' });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      const resp = conn.sent[0];
      assert.equal(resp.type, 'error');
      assert.equal((resp as { code: string }).code, 'CONVERSATION_NOT_FOUND');
      assert.equal((resp as { category: string }).category, 'validation');

      // Not subscribed
      assert.ok(!conn.subscribedConversations.has('invalid-conv'));
    });
  });

  // ─── subscribe with buffer-hit replay ───────────────────────────────────

  describe('subscribe with replay (buffer hit)', () => {
    it('replays buffered events when lastAcknowledgedSeq is provided and buffer covers range', async () => {
      buffer.push('conv-1', makeEvent(1));
      buffer.push('conv-1', makeEvent(2));
      buffer.push('conv-1', makeEvent(3));

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      await handler.handleMessage(conn, msg);

      // Should get 3 stream-event messages + 1 subscribed
      assert.equal(conn.sent.length, 4);
      assert.equal(conn.sent[0].type, 'stream-event');
      assert.equal(conn.sent[1].type, 'stream-event');
      assert.equal(conn.sent[2].type, 'stream-event');
      assert.equal(conn.sent[3].type, 'subscribed');

      // Verify event ordering
      assert.equal((conn.sent[0] as { event: StreamEvent }).event.seq, 1);
      assert.equal((conn.sent[1] as { event: StreamEvent }).event.seq, 2);
      assert.equal((conn.sent[2] as { event: StreamEvent }).event.seq, 3);

      // subscribed message has currentSeq = last replayed
      assert.equal((conn.sent[3] as { currentSeq: number }).currentSeq, 3);

      // After replay, state is live
      assert.equal(conn.replayState.get('conv-1'), 'live');
    });

    it('replays only events after lastAcknowledgedSeq', async () => {
      buffer.push('conv-1', makeEvent(1));
      buffer.push('conv-1', makeEvent(2));
      buffer.push('conv-1', makeEvent(3));

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 2,
      });
      await handler.handleMessage(conn, msg);

      // Only event 3 + subscribed
      assert.equal(conn.sent.length, 2);
      assert.equal(conn.sent[0].type, 'stream-event');
      assert.equal((conn.sent[0] as { event: StreamEvent }).event.seq, 3);
      assert.equal(conn.sent[1].type, 'subscribed');
      assert.equal((conn.sent[1] as { currentSeq: number }).currentSeq, 3);
    });

    it('closes with WS_BUFFER_OVERFLOW when replay delivery would exceed the buffer threshold', async () => {
      const event = makeEvent(1);
      buffer.push('conv-1', event);
      conn._bufferedAmount = HIGH_WATER_MARK - streamEventSize('conv-1', event) + 1;

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.isClosed, true);
      assert.equal(conn.closeCode, 1008);
      assert.equal(conn.closeReason, 'WS_BUFFER_OVERFLOW');
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_BUFFER_OVERFLOW');
      assert.equal(conn.sent.some((message) => message.type === 'subscribed'), false);
      assert.equal(conn.replayState.has('conv-1'), false);
      assert.equal(conn.pendingEvents.has('conv-1'), false);
      assert.equal(conn.subscribedConversations.has('conv-1'), false);
      assert.equal(registry.getByConversation('conv-1').size, 0);
    });

    it('closes with WS_BUFFER_OVERFLOW when the final subscribed message would exceed the buffer threshold', async () => {
      const event = makeEvent(1);
      buffer.push('conv-1', event);
      const subscribedSize = Buffer.byteLength(
        serializeServerMessage({
          type: 'subscribed',
          conversationId: 'conv-1',
          currentSeq: event.seq,
        }),
        'utf8',
      );
      conn._bufferedAmount = HIGH_WATER_MARK - subscribedSize + 1;

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
      });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.isClosed, true);
      assert.equal(conn.closeCode, 1008);
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_BUFFER_OVERFLOW');
      assert.equal(conn.subscribedConversations.has('conv-1'), false);
    });

    it('sends only subscribed when lastAcknowledgedSeq equals highwater (nothing to replay)', async () => {
      buffer.push('conv-1', makeEvent(5));

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 5,
      });
      await handler.handleMessage(conn, msg);

      // Buffer has events but hasEventsSince returns false (nothing new)
      // Falls through to non-replay path
      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'subscribed');
    });
  });

  // ─── replay barrier: concurrent live events during replay ───────────────

  describe('replay barrier', () => {
    it('sets replayState to replaying during buffer replay', async () => {
      buffer.push('conv-1', makeEvent(1));
      buffer.push('conv-1', makeEvent(2));

      // Intercept send to verify replayState mid-replay
      const statesDuringReplay: string[] = [];
      const origSend = conn.send.bind(conn);
      conn.send = (msg: ServerMessage) => {
        if (msg.type === 'stream-event') {
          statesDuringReplay.push(conn.replayState.get('conv-1') ?? 'none');
        }
        origSend(msg);
      };

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      await handler.handleMessage(conn, msg);

      // During replay sends, state should have been 'replaying'
      assert.deepEqual(statesDuringReplay, ['replaying', 'replaying']);
      // After replay, state is 'live'
      assert.equal(conn.replayState.get('conv-1'), 'live');
    });

    it('flushes pending events queued during replay, deduplicated and ordered', async () => {
      buffer.push('conv-1', makeEvent(1));
      buffer.push('conv-1', makeEvent(2));
      buffer.push('conv-1', makeEvent(3));

      // Simulate T027-like behaviour: queue live events into pendingEvents during replay
      const origSend = conn.send.bind(conn);
      let replayEventsSent = 0;
      conn.send = (msg: ServerMessage) => {
        if (msg.type === 'stream-event' && conn.replayState.get('conv-1') === 'replaying') {
          replayEventsSent++;
          // Simulate concurrent arrival of live events during replay
          if (replayEventsSent === 1) {
            // Event 4 arrives live during replay
            const pending = conn.pendingEvents.get('conv-1');
            if (pending) {
              pending.push(makeEvent(4));
            }
          }
          if (replayEventsSent === 2) {
            // Duplicate event 3 + new event 5 arrive live during replay
            const pending = conn.pendingEvents.get('conv-1');
            if (pending) {
              pending.push(makeEvent(3)); // duplicate of replayed event
              pending.push(makeEvent(5));
            }
          }
        }
        origSend(msg);
      };

      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      await handler.handleMessage(conn, msg);

      // Expect: 3 replay events + 2 flushed pending (4, 5 — dup 3 discarded) + subscribed
      assert.equal(conn.sent.length, 6);

      // Replay: 1, 2, 3
      assert.equal((conn.sent[0] as { event: StreamEvent }).event.seq, 1);
      assert.equal((conn.sent[1] as { event: StreamEvent }).event.seq, 2);
      assert.equal((conn.sent[2] as { event: StreamEvent }).event.seq, 3);

      // Flushed pending: 4, 5 (ordered, deduplicated, seq > lastReplayed=3)
      assert.equal(conn.sent[3].type, 'stream-event');
      assert.equal((conn.sent[3] as { event: StreamEvent }).event.seq, 4);
      assert.equal(conn.sent[4].type, 'stream-event');
      assert.equal((conn.sent[4] as { event: StreamEvent }).event.seq, 5);

      // Final: subscribed
      assert.equal(conn.sent[5].type, 'subscribed');
      assert.equal((conn.sent[5] as { currentSeq: number }).currentSeq, 5);

      // Pending cleared
      assert.ok(!conn.pendingEvents.has('conv-1'));
      assert.equal(conn.replayState.get('conv-1'), 'live');
    });

    it('simultaneous replay on conv-A while conv-B stays live on same connection', async () => {
      // Seed buffer: conv-1 has events, conv-2 does not
      buffer.push('conv-1', makeEvent(1));
      buffer.push('conv-1', makeEvent(2));

      // Subscribe conv-2 first (no replay, goes to 'live')
      const subB = JSON.stringify({ type: 'subscribe', conversationId: 'conv-2' });
      await handler.handleMessage(conn, subB);
      assert.equal(conn.replayState.get('conv-2'), 'live');
      conn.sent.splice(0); // reset for clarity

      // Now subscribe conv-1 with replay
      const subA = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      await handler.handleMessage(conn, subA);

      // conv-2 remained 'live' throughout conv-1's replay
      assert.equal(conn.replayState.get('conv-2'), 'live');
      // conv-1 is now live after replay
      assert.equal(conn.replayState.get('conv-1'), 'live');

      // conv-1 got 2 stream-events + subscribed
      assert.equal(conn.sent.length, 3);
      assert.equal(conn.sent[0].type, 'stream-event');
      assert.equal((conn.sent[0] as { conversationId: string }).conversationId, 'conv-1');
      assert.equal(conn.sent[2].type, 'subscribed');
    });
  });

  // ─── unsubscribe ────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('unsubscribes from a conversation and cleans up state', async () => {
      // First subscribe
      const sub = JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' });
      await handler.handleMessage(conn, sub);
      conn.sent.splice(0);

      // Then unsubscribe
      const unsub = JSON.stringify({ type: 'unsubscribe', conversationId: 'conv-1' });
      await handler.handleMessage(conn, unsub);

      assert.equal(conn.sent.length, 1);
      const resp = conn.sent[0];
      assert.equal(resp.type, 'unsubscribed');
      assert.equal((resp as { conversationId: string }).conversationId, 'conv-1');

      // State cleaned up
      assert.ok(!conn.subscribedConversations.has('conv-1'));
      assert.ok(!conn.replayState.has('conv-1'));
      assert.ok(!conn.pendingEvents.has('conv-1'));
      assert.equal(registry.getByConversation('conv-1').size, 0);
    });

    it('responds unsubscribed even if not currently subscribed', async () => {
      const msg = JSON.stringify({ type: 'unsubscribe', conversationId: 'conv-1' });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'unsubscribed');
    });
  });

  // ─── ack ────────────────────────────────────────────────────────────────

  describe('ack', () => {
    it('updates lastAckSeq for the conversation', async () => {
      const msg = JSON.stringify({ type: 'ack', conversationId: 'conv-1', seq: 42 });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.lastAckSeq.get('conv-1'), 42);
      // No response sent for ack (fire-and-forget)
      assert.equal(conn.sent.length, 0);
    });

    it('allows monotonically increasing ack values', async () => {
      const msg1 = JSON.stringify({ type: 'ack', conversationId: 'conv-1', seq: 10 });
      const msg2 = JSON.stringify({ type: 'ack', conversationId: 'conv-1', seq: 20 });
      await handler.handleMessage(conn, msg1);
      await handler.handleMessage(conn, msg2);

      assert.equal(conn.lastAckSeq.get('conv-1'), 20);
      assert.equal(conn.sent.length, 0);
    });
  });

  // ─── malformed / invalid messages ───────────────────────────────────────

  describe('malformed messages', () => {
    it('responds with error for invalid JSON', async () => {
      await handler.handleMessage(conn, '{not valid json}');

      assert.equal(conn.sent.length, 1);
      const resp = conn.sent[0];
      assert.equal(resp.type, 'error');
      assert.equal((resp as { code: string }).code, 'WS_INVALID_MESSAGE');
      assert.equal((resp as { category: string }).category, 'validation');
    });

    it('responds with error for missing required fields', async () => {
      const msg = JSON.stringify({ type: 'subscribe' }); // missing conversationId
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_INVALID_MESSAGE');
    });

    it('responds with error for unknown message type', async () => {
      const msg = JSON.stringify({ type: 'unknown-cmd', conversationId: 'conv-1' });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_INVALID_MESSAGE');
    });

    it('responds with error for ack with negative seq', async () => {
      const msg = JSON.stringify({ type: 'ack', conversationId: 'conv-1', seq: -1 });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_INVALID_MESSAGE');
    });

    it('responds with error for non-integer seq', async () => {
      const msg = JSON.stringify({ type: 'ack', conversationId: 'conv-1', seq: 3.5 });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'error');
    });

    it('responds with error for empty string conversationId', async () => {
      const msg = JSON.stringify({ type: 'subscribe', conversationId: '' });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'error');
    });

    it('does not close connection on any error', async () => {
      await handler.handleMessage(conn, 'garbage');
      await handler.handleMessage(conn, JSON.stringify({ type: 'subscribe' }));
      await handler.handleMessage(conn, JSON.stringify({ type: 'nope' }));

      assert.ok(!conn.isClosed);
      assert.equal(conn.sent.length, 3);
    });

    it('responds with error for extra properties (strict schema)', async () => {
      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        extraField: true,
      });
      await handler.handleMessage(conn, msg);

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'error');
      assert.equal((conn.sent[0] as { code: string }).code, 'WS_INVALID_MESSAGE');
    });
  });

  // ─── buffer miss on reconnect ───────────────────────────────────────────

  describe('subscribe with buffer miss', () => {
    it('falls through to non-replay subscribe when buffer cannot cover range', async () => {
      // Buffer is empty, but client provides lastAcknowledgedSeq
      const msg = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 100,
      });
      await handler.handleMessage(conn, msg);

      // Should still subscribe, just with currentSeq from buffer (0)
      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'subscribed');
      assert.equal((conn.sent[0] as { currentSeq: number }).currentSeq, 0);
      assert.equal(conn.replayState.get('conv-1'), 'live');
    });
  });
});
