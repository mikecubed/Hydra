/**
 * StreamManager — turn stream lifecycle management for the daemon.
 *
 * Coordinates turn execution, incremental event delivery, and stream lifecycle
 * (start → progress → complete/fail/cancel). Supports reconnect resumption
 * from last-acknowledged sequence. Finalizes turn content on completion.
 *
 * Each StreamEvent is assigned a monotonically increasing sequence number
 * that aligns with the daemon's event-sourcing model.
 */

import type { ConversationStore } from './conversation-store.ts';
import type { StreamEvent as StreamEventType } from '../../packages/web-contracts/src/stream.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

type StreamStatus = 'active' | 'completed' | 'failed' | 'cancelled';

interface StreamState {
  turnId: string;
  streamId: string;
  status: StreamStatus;
  events: StreamEventType[];
}

// ── StreamManager ────────────────────────────────────────────────────────────

export class StreamManager {
  private readonly streams = new Map<string, StreamState>();
  private readonly streamByTurnId = new Map<string, string>();
  private seq = 0;
  private readonly store: ConversationStore;

  constructor(store: ConversationStore) {
    this.store = store;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * Create a new stream for a turn. Emits a `stream-started` event.
   * @returns The stream id for subscription.
   */
  createStream(turnId: string): string {
    const streamId = generateId('stream');
    const state: StreamState = {
      turnId,
      streamId,
      status: 'active',
      events: [],
    };

    // Emit stream-started
    const startEvent: StreamEventType = {
      seq: this.nextSeq(),
      turnId,
      kind: 'stream-started',
      payload: { streamId },
      timestamp: nowIso(),
    };
    state.events.push(startEvent);

    this.streams.set(streamId, state);
    this.streamByTurnId.set(turnId, streamId);

    return streamId;
  }

  /**
   * Emit a stream event for the given turn.
   */
  emitEvent(
    turnId: string,
    kind: StreamEventType['kind'],
    payload: Record<string, unknown>,
  ): StreamEventType {
    const streamId = this.streamByTurnId.get(turnId);
    if (streamId === undefined) throw new Error(`No active stream for turn: ${turnId}`);
    const state = this.streams.get(streamId);
    if (state === undefined) throw new Error(`Stream not found: ${streamId}`);
    if (state.status !== 'active') {
      throw new Error(`Stream is not active: ${streamId} (status: ${state.status})`);
    }

    const event: StreamEventType = {
      seq: this.nextSeq(),
      turnId,
      kind,
      payload,
      timestamp: nowIso(),
    };
    state.events.push(event);
    return event;
  }

  /**
   * Complete the stream — consolidates text-delta events into the turn's
   * response field and emits `stream-completed`.
   */
  completeStream(turnId: string): void {
    const streamId = this.streamByTurnId.get(turnId);
    if (streamId === undefined) return;
    const state = this.streams.get(streamId);
    if (state?.status !== 'active') return;

    // Consolidate text-delta events into response
    const textChunks = state.events
      .filter((e) => e.kind === 'text-delta')
      .map((e) => (e.payload as { text?: string }).text ?? '');
    const response = textChunks.join('');

    // Emit stream-completed
    const completedEvent: StreamEventType = {
      seq: this.nextSeq(),
      turnId,
      kind: 'stream-completed',
      payload: { responseLength: response.length },
      timestamp: nowIso(),
    };
    state.events.push(completedEvent);
    state.status = 'completed';

    // Finalize the turn
    this.store.finalizeTurn(turnId, 'completed', response === '' ? undefined : response);
  }

  /**
   * Fail the stream — emits `stream-failed` and marks the turn as failed.
   */
  failStream(turnId: string, reason: string): void {
    const streamId = this.streamByTurnId.get(turnId);
    if (streamId === undefined) return;
    const state = this.streams.get(streamId);
    if (state?.status !== 'active') return;

    const failedEvent: StreamEventType = {
      seq: this.nextSeq(),
      turnId,
      kind: 'stream-failed',
      payload: { reason },
      timestamp: nowIso(),
    };
    state.events.push(failedEvent);
    state.status = 'failed';

    this.store.finalizeTurn(turnId, 'failed', reason);
  }

  /**
   * Cancel the stream — emits `cancellation` and marks the turn as cancelled.
   * Idempotent: no-op if the stream is already in a terminal state.
   */
  cancelStream(turnId: string): void {
    const streamId = this.streamByTurnId.get(turnId);
    if (streamId === undefined) return;
    const state = this.streams.get(streamId);
    if (state?.status !== 'active') return;

    const cancelEvent: StreamEventType = {
      seq: this.nextSeq(),
      turnId,
      kind: 'cancellation',
      payload: {},
      timestamp: nowIso(),
    };
    state.events.push(cancelEvent);
    state.status = 'cancelled';

    this.store.finalizeTurn(turnId, 'cancelled');
  }

  /**
   * Get all stream events for a turn.
   */
  getStreamEvents(turnId: string): StreamEventType[] {
    const streamId = this.streamByTurnId.get(turnId);
    if (streamId === undefined) return [];
    const state = this.streams.get(streamId);
    return state ? [...state.events] : [];
  }

  /**
   * Get stream events since a given sequence number (for reconnect resumption).
   */
  getStreamEventsSince(turnId: string, fromSeq: number): StreamEventType[] {
    return this.getStreamEvents(turnId).filter((e) => e.seq >= fromSeq);
  }

  /**
   * Check whether a stream is currently active for a turn.
   */
  isStreamActive(turnId: string): boolean {
    const streamId = this.streamByTurnId.get(turnId);
    if (streamId === undefined) return false;
    const state = this.streams.get(streamId);
    return state?.status === 'active';
  }

  /**
   * Get the stream id for a turn (for subscription).
   */
  getStreamId(turnId: string): string | undefined {
    return this.streamByTurnId.get(turnId);
  }
}
