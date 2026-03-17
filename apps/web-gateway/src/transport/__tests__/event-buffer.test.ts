import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@hydra/web-contracts';
import { EventBuffer } from '../event-buffer.ts';

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

function lastEvent(events: ReadonlyArray<StreamEvent>): StreamEvent | undefined {
  // eslint-disable-next-line unicorn/prefer-at -- `.at()` conflicts with this package's Node compatibility lint rule.
  return events.slice(-1).pop();
}

// ─── construction ───────────────────────────────────────────────────────────

describe('EventBuffer', () => {
  describe('construction', () => {
    it('creates with default capacity 1000', () => {
      const buf = new EventBuffer();
      // Should not throw; capacity is internal but default is 1000
      assert.ok(buf);
    });

    it('accepts a custom capacity', () => {
      const buf = new EventBuffer(5);
      assert.ok(buf);
    });

    it('rejects capacity of 0', () => {
      assert.throws(() => new EventBuffer(0), {
        name: 'RangeError',
        message: /capacity must be a positive integer/,
      });
    });

    it('rejects negative capacity', () => {
      assert.throws(() => new EventBuffer(-3), {
        name: 'RangeError',
        message: /capacity must be a positive integer/,
      });
    });

    it('rejects non-integer capacity', () => {
      assert.throws(() => new EventBuffer(2.5), {
        name: 'RangeError',
        message: /capacity must be a positive integer/,
      });
    });

    it('rejects NaN capacity', () => {
      assert.throws(() => new EventBuffer(Number.NaN), {
        name: 'RangeError',
        message: /capacity must be a positive integer/,
      });
    });

    it('rejects Infinity capacity', () => {
      assert.throws(() => new EventBuffer(Infinity), {
        name: 'RangeError',
        message: /capacity must be a positive integer/,
      });
    });
  });

  // ─── push / insertion ───────────────────────────────────────────────────

  describe('push', () => {
    let buf: EventBuffer;
    beforeEach(() => {
      buf = new EventBuffer(5);
    });

    it('stores an event for a conversation', () => {
      buf.push('conv-1', makeEvent(1));
      const events = buf.getEventsSince('conv-1', 0);
      assert.equal(events.length, 1);
      assert.equal(events[0].seq, 1);
    });

    it('stores events for multiple conversations independently', () => {
      buf.push('conv-1', makeEvent(1));
      buf.push('conv-2', makeEvent(2));
      assert.equal(buf.getEventsSince('conv-1', 0).length, 1);
      assert.equal(buf.getEventsSince('conv-2', 0).length, 1);
    });

    it('appends multiple events in insertion order', () => {
      buf.push('conv-1', makeEvent(10));
      buf.push('conv-1', makeEvent(20));
      buf.push('conv-1', makeEvent(30));
      const events = buf.getEventsSince('conv-1', 0);
      assert.deepEqual(
        events.map((e) => e.seq),
        [10, 20, 30],
      );
    });
    it('mutating the original event after push does not corrupt buffer or highwater', () => {
      const event = makeEvent(42);
      buf.push('c', event);

      // Mutate the original object the caller still holds
      event.seq = 9999;
      event.payload['text'] = 'corrupted';

      // Buffer contents must be unchanged
      const events = buf.getEventsSince('c', 0);
      assert.equal(events[0].seq, 42);
      assert.equal(events[0].payload['text'], 'chunk-42');

      // Highwater must be unchanged
      assert.equal(buf.getHighwaterSeq('c'), 42);
    });
  });

  // ─── eviction at boundary ─────────────────────────────────────────────

  describe('eviction at capacity boundary', () => {
    it('evicts oldest event when capacity is exceeded', () => {
      const buf = new EventBuffer(3);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.push('c', makeEvent(3));
      // At capacity — next push evicts seq 1
      buf.push('c', makeEvent(4));
      const events = buf.getEventsSince('c', 0);
      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((e) => e.seq),
        [2, 3, 4],
      );
    });

    it('continues evicting on successive pushes beyond capacity', () => {
      const buf = new EventBuffer(2);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.push('c', makeEvent(3));
      buf.push('c', makeEvent(4));
      buf.push('c', makeEvent(5));
      const events = buf.getEventsSince('c', 0);
      assert.deepEqual(
        events.map((e) => e.seq),
        [4, 5],
      );
    });

    it('eviction is per-conversation', () => {
      const buf = new EventBuffer(2);
      buf.push('a', makeEvent(1));
      buf.push('a', makeEvent(2));
      buf.push('a', makeEvent(3)); // evicts a:seq-1
      buf.push('b', makeEvent(10));
      assert.deepEqual(
        buf.getEventsSince('a', 0).map((e) => e.seq),
        [2, 3],
      );
      assert.deepEqual(
        buf.getEventsSince('b', 0).map((e) => e.seq),
        [10],
      );
    });
  });

  // ─── capacity enforcement ─────────────────────────────────────────────

  describe('capacity enforcement', () => {
    it('never exceeds configured capacity', () => {
      const cap = 4;
      const buf = new EventBuffer(cap);
      for (let i = 1; i <= 20; i++) {
        buf.push('c', makeEvent(i));
        assert.ok(buf.getEventsSince('c', 0).length <= cap);
      }
    });

    it('capacity of 1 keeps only the last event', () => {
      const buf = new EventBuffer(1);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.push('c', makeEvent(3));
      const events = buf.getEventsSince('c', 0);
      assert.equal(events.length, 1);
      assert.equal(events[0].seq, 3);
    });
  });

  // ─── getEventsSince / retrieval correctness ───────────────────────────

  describe('getEventsSince', () => {
    let buf: EventBuffer;
    beforeEach(() => {
      buf = new EventBuffer(10);
      for (let i = 1; i <= 5; i++) {
        buf.push('c', makeEvent(i));
      }
    });

    it('returns all events when sinceSeq is 0', () => {
      const events = buf.getEventsSince('c', 0);
      assert.equal(events.length, 5);
      assert.equal(events[0].seq, 1);
      assert.equal(events[4].seq, 5);
    });

    it('returns events with seq strictly greater than sinceSeq', () => {
      const events = buf.getEventsSince('c', 3);
      assert.deepEqual(
        events.map((e) => e.seq),
        [4, 5],
      );
    });

    it('returns empty array when sinceSeq >= highest seq', () => {
      assert.deepEqual(buf.getEventsSince('c', 5), []);
      assert.deepEqual(buf.getEventsSince('c', 100), []);
    });

    it('returns empty array for unknown conversation', () => {
      assert.deepEqual(buf.getEventsSince('unknown', 0), []);
    });

    it('returns events in gap-free insertion order', () => {
      const seqs = buf.getEventsSince('c', 0).map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) {
        assert.ok(seqs[i] > seqs[i - 1], `expected seq[${i}] > seq[${i - 1}]`);
      }
    });

    it('returns defensive copies (not internal references)', () => {
      const first = buf.getEventsSince('c', 0);
      const second = buf.getEventsSince('c', 0);
      assert.notEqual(first, second);
    });

    it('mutating a returned event does not corrupt buffer or highwater', () => {
      const events = buf.getEventsSince('c', 0);
      const originalHighwater = buf.getHighwaterSeq('c');

      // Mutate the last returned event's seq and payload
      const last = lastEvent(events);
      assert.ok(last);
      last.seq = 9999;
      last.payload['text'] = 'corrupted';

      // Buffer contents must be unchanged
      const fresh = buf.getEventsSince('c', 0);
      assert.equal(lastEvent(fresh)?.seq, 5);
      assert.equal(lastEvent(fresh)?.payload['text'], 'chunk-5');

      // Highwater must be unchanged
      assert.equal(buf.getHighwaterSeq('c'), originalHighwater);
    });
  });

  // ─── getHighwaterSeq ──────────────────────────────────────────────────

  describe('getHighwaterSeq', () => {
    it('returns 0 for unknown conversation', () => {
      const buf = new EventBuffer();
      assert.equal(buf.getHighwaterSeq('unknown'), 0);
    });

    it('returns newest seq after pushes', () => {
      const buf = new EventBuffer(10);
      buf.push('c', makeEvent(5));
      buf.push('c', makeEvent(10));
      buf.push('c', makeEvent(15));
      assert.equal(buf.getHighwaterSeq('c'), 15);
    });

    it('returns newest seq even after evictions', () => {
      const buf = new EventBuffer(2);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.push('c', makeEvent(3));
      assert.equal(buf.getHighwaterSeq('c'), 3);
    });
  });

  // ─── hasEventsSince ───────────────────────────────────────────────────

  describe('hasEventsSince', () => {
    it('returns false for unknown conversation', () => {
      const buf = new EventBuffer();
      assert.equal(buf.hasEventsSince('unknown', 0), false);
    });

    it('returns true when buffer covers sinceSeq', () => {
      const buf = new EventBuffer(10);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.push('c', makeEvent(3));
      // Oldest buffered seq is 1, so sinceSeq=0 is covered (events 1,2,3 available)
      assert.equal(buf.hasEventsSince('c', 0), true);
      assert.equal(buf.hasEventsSince('c', 1), true);
      assert.equal(buf.hasEventsSince('c', 2), true);
    });

    it('returns false when buffer has been evicted past sinceSeq', () => {
      const buf = new EventBuffer(2);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.push('c', makeEvent(3));
      // Buffer now holds [2, 3]; sinceSeq=0 means client needs seq=1 which is gone
      assert.equal(buf.hasEventsSince('c', 0), false);
      // sinceSeq=1 → client needs seq>1 → buffer has [2,3] → covered
      assert.equal(buf.hasEventsSince('c', 1), true);
    });

    it('returns false when sinceSeq >= highwater (nothing new)', () => {
      const buf = new EventBuffer(10);
      buf.push('c', makeEvent(1));
      assert.equal(buf.hasEventsSince('c', 1), false);
      assert.equal(buf.hasEventsSince('c', 99), false);
    });

    it('returns true for sparse seqs when no events have been evicted', () => {
      const buf = new EventBuffer(10);
      // Sparse global seqs: only some belong to this conversation
      buf.push('c', makeEvent(5));
      buf.push('c', makeEvent(12));
      buf.push('c', makeEvent(47));
      // Client at sinceSeq=2: buffer has full conversation history, replay is safe
      assert.equal(buf.hasEventsSince('c', 2), true);
      // Client at sinceSeq=5: events 12,47 are > 5
      assert.equal(buf.hasEventsSince('c', 5), true);
      // Client at sinceSeq=12: event 47 is > 12
      assert.equal(buf.hasEventsSince('c', 12), true);
    });

    it('returns true for sparse seqs when evictions do not affect replay', () => {
      const buf = new EventBuffer(2);
      // Push sparse seqs; buffer holds only last 2
      buf.push('c', makeEvent(5)); // will be evicted
      buf.push('c', makeEvent(12));
      buf.push('c', makeEvent(47)); // evicts seq 5
      // Buffer: [12, 47], evictedHigh=5
      // Client at sinceSeq=5: client already has seq 5, buffer has 12,47 → safe
      assert.equal(buf.hasEventsSince('c', 5), true);
      // Client at sinceSeq=10: client is past the evicted range → safe
      assert.equal(buf.hasEventsSince('c', 10), true);
    });

    it('returns false for sparse seqs when eviction drops unseen events', () => {
      const buf = new EventBuffer(2);
      buf.push('c', makeEvent(5)); // will be evicted
      buf.push('c', makeEvent(12));
      buf.push('c', makeEvent(47)); // evicts seq 5
      // Buffer: [12, 47], evictedHigh=5
      // Client at sinceSeq=3: needs everything > 3, but seq 5 was evicted → NOT safe
      assert.equal(buf.hasEventsSince('c', 3), false);
      // Client at sinceSeq=4: also needs seq 5 which was evicted
      assert.equal(buf.hasEventsSince('c', 4), false);
    });
  });

  // ─── evictConversation ────────────────────────────────────────────────

  describe('evictConversation', () => {
    it('removes all buffered events for a conversation', () => {
      const buf = new EventBuffer(10);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.evictConversation('c');
      assert.deepEqual(buf.getEventsSince('c', 0), []);
      assert.equal(buf.getHighwaterSeq('c'), 0);
    });

    it('does not affect other conversations', () => {
      const buf = new EventBuffer(10);
      buf.push('a', makeEvent(1));
      buf.push('b', makeEvent(2));
      buf.evictConversation('a');
      assert.deepEqual(buf.getEventsSince('a', 0), []);
      assert.equal(buf.getEventsSince('b', 0).length, 1);
    });

    it('preserves tombstone so hasEventsSince rejects stale sinceSeq after re-push', () => {
      const buf = new EventBuffer(10);
      buf.push('c', makeEvent(1));
      buf.push('c', makeEvent(2));
      buf.evictConversation('c');
      buf.push('c', makeEvent(3));
      // sinceSeq=0 means client needs everything > 0, but seqs 1 & 2 were
      // explicitly evicted — replay is NOT safe.
      assert.equal(buf.hasEventsSince('c', 0), false);
      // sinceSeq=2 means client already saw 1 & 2, only needs 3 → safe.
      assert.equal(buf.hasEventsSince('c', 2), true);
    });

    it('is a no-op for unknown conversation', () => {
      const buf = new EventBuffer(10);
      // Should not throw
      buf.evictConversation('nonexistent');
      assert.ok(true);
    });
  });

  // ─── empty buffer edge cases ──────────────────────────────────────────

  describe('empty buffer', () => {
    it('getEventsSince returns empty for fresh buffer', () => {
      const buf = new EventBuffer();
      assert.deepEqual(buf.getEventsSince('c', 0), []);
    });

    it('getHighwaterSeq returns 0 for fresh buffer', () => {
      const buf = new EventBuffer();
      assert.equal(buf.getHighwaterSeq('c'), 0);
    });

    it('hasEventsSince returns false for fresh buffer', () => {
      const buf = new EventBuffer();
      assert.equal(buf.hasEventsSince('c', 0), false);
    });
  });

  // ─── gap-free ordering guarantee ──────────────────────────────────────

  describe('gap-free ordering guarantee', () => {
    it('maintains insertion order regardless of seq values', () => {
      const buf = new EventBuffer(10);
      // Push events with non-contiguous seqs
      buf.push('c', makeEvent(10));
      buf.push('c', makeEvent(20));
      buf.push('c', makeEvent(30));
      const events = buf.getEventsSince('c', 0);
      assert.deepEqual(
        events.map((e) => e.seq),
        [10, 20, 30],
      );
    });

    it('preserves order through eviction cycles', () => {
      const buf = new EventBuffer(3);
      for (let i = 1; i <= 6; i++) {
        buf.push('c', makeEvent(i * 10));
      }
      // Buffer should hold last 3: seq 40, 50, 60
      const events = buf.getEventsSince('c', 0);
      assert.deepEqual(
        events.map((e) => e.seq),
        [40, 50, 60],
      );
    });

    it('getEventsSince respects both order and filtering', () => {
      const buf = new EventBuffer(10);
      for (let i = 1; i <= 5; i++) {
        buf.push('c', makeEvent(i * 10));
      }
      // sinceSeq=20 → return events with seq > 20
      const events = buf.getEventsSince('c', 20);
      assert.deepEqual(
        events.map((e) => e.seq),
        [30, 40, 50],
      );
    });
  });
});
