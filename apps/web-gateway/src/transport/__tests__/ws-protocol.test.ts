import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientMessageSchema,
  ServerMessageSchema,
  parseClientMessage,
  serializeServerMessage,
  type ServerMessage,
} from '../ws-protocol.ts';

// ─── Client → Server messages ────────────────────────────────────────────────

describe('ClientMessageSchema', () => {
  describe('subscribe', () => {
    it('accepts valid subscribe without lastAcknowledgedSeq', () => {
      const msg = { type: 'subscribe', conversationId: 'conv-1' };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(result.success);
      assert.equal(result.data.type, 'subscribe');
    });

    it('accepts subscribe with lastAcknowledgedSeq', () => {
      const msg = { type: 'subscribe', conversationId: 'conv-1', lastAcknowledgedSeq: 42 };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(result.success);
      if (result.data.type === 'subscribe') {
        assert.equal(result.data.lastAcknowledgedSeq, 42);
      }
    });

    it('rejects subscribe with empty conversationId', () => {
      const msg = { type: 'subscribe', conversationId: '' };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });

    it('rejects subscribe with negative lastAcknowledgedSeq', () => {
      const msg = { type: 'subscribe', conversationId: 'conv-1', lastAcknowledgedSeq: -1 };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });
  });

  describe('unsubscribe', () => {
    it('accepts valid unsubscribe', () => {
      const msg = { type: 'unsubscribe', conversationId: 'conv-1' };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(result.success);
      assert.equal(result.data.type, 'unsubscribe');
    });

    it('rejects unsubscribe with missing conversationId', () => {
      const msg = { type: 'unsubscribe' };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });
  });

  describe('ack', () => {
    it('accepts valid ack', () => {
      const msg = { type: 'ack', conversationId: 'conv-1', seq: 10 };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(result.success);
      if (result.data.type === 'ack') {
        assert.equal(result.data.seq, 10);
      }
    });

    it('rejects ack with missing seq', () => {
      const msg = { type: 'ack', conversationId: 'conv-1' };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });

    it('rejects ack with negative seq', () => {
      const msg = { type: 'ack', conversationId: 'conv-1', seq: -5 };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });
  });

  describe('unknown type', () => {
    it('rejects message with unknown type', () => {
      const msg = { type: 'ping', conversationId: 'conv-1' };
      const result = ClientMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });
  });

  describe('non-object input', () => {
    it('rejects string input', () => {
      const result = ClientMessageSchema.safeParse('hello');
      assert.ok(!result.success);
    });

    it('rejects null', () => {
      const result = ClientMessageSchema.safeParse(null);
      assert.ok(!result.success);
    });
  });
});

// ─── Server → Client messages ────────────────────────────────────────────────

describe('ServerMessageSchema', () => {
  describe('stream-event', () => {
    it('accepts valid stream-event', () => {
      const msg = {
        type: 'stream-event',
        conversationId: 'conv-1',
        event: {
          seq: 1,
          turnId: 'turn-1',
          kind: 'text-delta',
          payload: { text: 'hello' },
          timestamp: '2026-03-16T00:00:00Z',
        },
      };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('subscribed', () => {
    it('accepts valid subscribed', () => {
      const msg = { type: 'subscribed', conversationId: 'conv-1', currentSeq: 5 };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('unsubscribed', () => {
    it('accepts valid unsubscribed', () => {
      const msg = { type: 'unsubscribed', conversationId: 'conv-1' };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('session-terminated', () => {
    it('accepts valid session-terminated', () => {
      const msg = { type: 'session-terminated', state: 'expired', reason: 'Session expired' };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('session-expiring-soon', () => {
    it('accepts valid session-expiring-soon', () => {
      const msg = { type: 'session-expiring-soon', expiresAt: '2026-03-16T01:00:00Z' };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('daemon-unavailable', () => {
    it('accepts valid daemon-unavailable', () => {
      const msg = { type: 'daemon-unavailable' };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('daemon-restored', () => {
    it('accepts valid daemon-restored', () => {
      const msg = { type: 'daemon-restored' };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });
  });

  describe('error', () => {
    it('accepts valid error with all fields', () => {
      const msg = {
        type: 'error',
        ok: false,
        code: 'WS_INVALID_MESSAGE',
        category: 'validation',
        message: 'Parse error',
      };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });

    it('accepts error with optional conversationId', () => {
      const msg = {
        type: 'error',
        ok: false,
        code: 'CONVERSATION_NOT_FOUND',
        category: 'validation',
        message: 'Not found',
        conversationId: 'conv-1',
      };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(result.success);
    });

    it('rejects error without category', () => {
      const msg = {
        type: 'error',
        ok: false,
        code: 'WS_INVALID_MESSAGE',
        message: 'Parse error',
      };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });
  });

  describe('unknown type', () => {
    it('rejects message with unknown type', () => {
      const msg = { type: 'pong' };
      const result = ServerMessageSchema.safeParse(msg);
      assert.ok(!result.success);
    });
  });
});

// ─── parseClientMessage ──────────────────────────────────────────────────────

describe('parseClientMessage', () => {
  it('returns parsed message for valid JSON', () => {
    const raw = JSON.stringify({ type: 'ack', conversationId: 'c', seq: 0 });
    const result = parseClientMessage(raw);
    assert.ok(result.ok);
    assert.equal(result.message.type, 'ack');
  });

  it('returns error for invalid JSON', () => {
    const result = parseClientMessage('not json');
    assert.ok(!result.ok);
    assert.equal(result.code, 'PARSE_ERROR');
  });

  it('returns error for valid JSON but invalid schema', () => {
    const raw = JSON.stringify({ type: 'subscribe' });
    const result = parseClientMessage(raw);
    assert.ok(!result.ok);
    assert.equal(result.code, 'VALIDATION_ERROR');
  });
});

// ─── serializeServerMessage ──────────────────────────────────────────────────

describe('serializeServerMessage', () => {
  it('serializes a server message to JSON string', () => {
    const msg: ServerMessage = { type: 'daemon-restored' };
    const json = serializeServerMessage(msg);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, 'daemon-restored');
  });

  it('round-trips a stream-event message', () => {
    const msg: ServerMessage = {
      type: 'stream-event',
      conversationId: 'conv-1',
      event: {
        seq: 0,
        turnId: 'turn-1',
        kind: 'stream-started',
        payload: {},
        timestamp: '2026-03-16T00:00:00Z',
      },
    };
    const json = serializeServerMessage(msg);
    const result = ServerMessageSchema.safeParse(JSON.parse(json));
    assert.ok(result.success);
  });
});
