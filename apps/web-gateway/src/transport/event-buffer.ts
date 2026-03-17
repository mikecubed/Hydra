import type { StreamEvent } from '@hydra/web-contracts';

// ─── defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CAPACITY = 1000;

function cloneEvent(event: StreamEvent): StreamEvent {
  return {
    ...event,
    payload: JSON.parse(JSON.stringify(event.payload)) as StreamEvent['payload'],
  };
}

// ─── ring buffer (per-conversation) ─────────────────────────────────────────

/**
 * Bounded ring buffer that stores the most recent `capacity` events for each
 * conversation.  Oldest events are silently evicted when a push would exceed
 * the configured capacity.
 *
 * All retrieval methods return defensive copies so callers cannot mutate
 * internal state.
 */
export class EventBuffer {
  private readonly capacity: number;
  private readonly buffers = new Map<string, Array<StreamEvent | undefined>>();
  /** Index of the next write slot inside each conversation's ring. */
  private readonly heads = new Map<string, number>();
  /** Number of events currently stored per conversation (≤ capacity). */
  private readonly sizes = new Map<string, number>();
  /** Highest `seq` evicted from each conversation's ring (undefined = no evictions). */
  private readonly evictedHighSeqs = new Map<string, number>();

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  // ─── writes ─────────────────────────────────────────────────────────────

  /** Append an event, evicting the oldest if the buffer is at capacity. */
  push(conversationId: string, event: StreamEvent): void {
    let ring = this.buffers.get(conversationId);
    if (!ring) {
      ring = Array.from({ length: this.capacity });
      this.buffers.set(conversationId, ring);
      this.heads.set(conversationId, 0);
      this.sizes.set(conversationId, 0);
    }

    const head = this.heads.get(conversationId) ?? 0;
    const size = this.sizes.get(conversationId) ?? 0;

    // Record the seq of the event about to be overwritten (eviction).
    if (size === this.capacity) {
      const evictedEvent = ring[head];
      if (evictedEvent !== undefined) {
        const prev = this.evictedHighSeqs.get(conversationId) ?? 0;
        if (evictedEvent.seq > prev) {
          this.evictedHighSeqs.set(conversationId, evictedEvent.seq);
        }
      }
    }

    ring[head] = cloneEvent(event);
    this.heads.set(conversationId, (head + 1) % this.capacity);

    if (size < this.capacity) {
      this.sizes.set(conversationId, size + 1);
    }
  }

  // ─── reads ──────────────────────────────────────────────────────────────

  /** Return buffered events with `seq > sinceSeq`, in insertion order. */
  getEventsSince(conversationId: string, sinceSeq: number): StreamEvent[] {
    const ordered = this.orderedSnapshot(conversationId);
    return ordered.filter((e) => e.seq > sinceSeq);
  }

  /** Return the highest `seq` in the buffer, or `0` if empty / unknown. */
  getHighwaterSeq(conversationId: string): number {
    const size = this.sizes.get(conversationId) ?? 0;
    if (size === 0) return 0;

    const ring = this.buffers.get(conversationId);
    const head = this.heads.get(conversationId) ?? 0;
    if (!ring) return 0;
    // The newest event is at (head - 1) mod capacity
    const newest = (head - 1 + this.capacity) % this.capacity;
    return ring[newest]?.seq ?? 0;
  }

  /**
   * Check whether the buffer can satisfy a replay from `sinceSeq`.
   *
   * Returns `true` when:
   *  - the conversation has buffered events, AND
   *  - there is at least one event with seq > sinceSeq, AND
   *  - no events with seq > sinceSeq have been evicted from the ring
   *    (i.e. the client hasn't missed any events that were dropped).
   *
   * This works correctly with sparse (globally-monotonic) sequence numbers
   * because it tracks per-conversation eviction metadata rather than assuming
   * contiguous per-conversation seqs.
   */
  hasEventsSince(conversationId: string, sinceSeq: number): boolean {
    const size = this.sizes.get(conversationId) ?? 0;
    if (size === 0) return false;

    const ring = this.buffers.get(conversationId);
    const head = this.heads.get(conversationId) ?? 0;
    if (!ring) return false;

    // Newest buffered event
    const newestIdx = (head - 1 + this.capacity) % this.capacity;
    const newestSeq = ring[newestIdx]?.seq ?? 0;

    // Nothing new for the client.
    if (newestSeq <= sinceSeq) return false;

    // If no events were ever evicted, the buffer holds complete history.
    const evictedHigh = this.evictedHighSeqs.get(conversationId);
    if (evictedHigh === undefined) return true;

    // Events were evicted.  Replay is safe only if the client already has
    // everything that was dropped (sinceSeq >= highest evicted seq).
    return sinceSeq >= evictedHigh;
  }

  // ─── eviction ───────────────────────────────────────────────────────────

  /** Remove all buffered data for a conversation. */
  evictConversation(conversationId: string): void {
    // Preserve a tombstone so hasEventsSince() knows older history was dropped.
    const highwater = this.getHighwaterSeq(conversationId);
    const prevEvicted = this.evictedHighSeqs.get(conversationId) ?? 0;
    const tombstone = Math.max(highwater, prevEvicted);

    this.buffers.delete(conversationId);
    this.heads.delete(conversationId);
    this.sizes.delete(conversationId);

    if (tombstone > 0) {
      this.evictedHighSeqs.set(conversationId, tombstone);
    } else {
      this.evictedHighSeqs.delete(conversationId);
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /** Return a snapshot of buffered events in insertion order (oldest→newest). */
  private orderedSnapshot(conversationId: string): StreamEvent[] {
    const size = this.sizes.get(conversationId) ?? 0;
    if (size === 0) return [];

    const ring = this.buffers.get(conversationId);
    const head = this.heads.get(conversationId) ?? 0;
    if (!ring) return [];

    const result: StreamEvent[] = [];
    // The oldest element starts at `head` when full, or at index 0 when not yet full.
    const start = size < this.capacity ? 0 : head;
    for (let i = 0; i < size; i++) {
      const event = ring[(start + i) % this.capacity];
      if (event !== undefined) {
        result.push(cloneEvent(event));
      }
    }
    return result;
  }
}
