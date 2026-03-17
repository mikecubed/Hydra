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

import { randomUUID } from 'node:crypto';

import type { ConversationStore } from './conversation-store.ts';
import type { EventBridge } from './event-bridge.ts';
import type { StreamEvent as StreamEventType } from '@hydra/web-contracts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
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
  /** ISO timestamp when the stream entered a terminal state (completed/failed/cancelled). */
  completedAt?: string;
}

const TERMINAL_STREAM_STATUSES: ReadonlySet<StreamStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Default retention: 5 minutes after terminal state. */
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;

/** Tombstone metadata for a purged stream — supports deterministic expiry. */
interface PurgeTombstone {
  highSeq: number;
  purgedAt: number;
}

// ── StreamManager ────────────────────────────────────────────────────────────

export class StreamManager {
  private readonly streams = new Map<string, StreamState>();
  private readonly streamByTurnId = new Map<string, string>();
  private readonly purgedHighSeqByTurnId = new Map<string, PurgeTombstone>();
  private seq = 0;
  private readonly store: ConversationStore;
  private readonly retentionMs: number;
  private readonly bridge?: EventBridge;

  /** Tombstone TTL — 2× stream retention gives clients ample time to catch up. */
  private readonly tombstoneRetentionMs: number;

  /** Hard cap on tombstone entries to prevent unbounded memory growth. */
  private static readonly MAX_TOMBSTONES = 10_000;

  constructor(store: ConversationStore, retentionMs = DEFAULT_RETENTION_MS, bridge?: EventBridge) {
    this.store = store;
    this.retentionMs = retentionMs;
    this.tombstoneRetentionMs = retentionMs * 2;
    this.bridge = bridge;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Emit an event through the bridge if one is configured.
   *  Listener exceptions are caught so they never disrupt stream lifecycle. */
  private bridgeEmit(turnId: string, event: StreamEventType): void {
    if (!this.bridge) return;
    const turn = this.store.getTurn(turnId);
    if (!turn) return;
    try {
      this.bridge.emitStreamEvent(turn.conversationId, event);
    } catch (err: unknown) {
      // Bridge consumer errors must not break daemon stream operations.
      // Log a warning so failures are observable and diagnosable.
      const detail = err instanceof Error ? err.message : 'unknown error';
      console.warn(
        `[StreamManager] bridgeEmit listener error (turn=${turnId}, kind=${event.kind}): ${detail}`,
      );
    }
  }

  /**
   * Create a new stream for a turn. Emits a `stream-started` event.
   * @returns The stream id for subscription.
   */
  createStream(turnId: string): string {
    this.purgedHighSeqByTurnId.delete(turnId);
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
    this.bridgeEmit(turnId, startEvent);

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
    this.bridgeEmit(turnId, event);
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
    this.bridgeEmit(turnId, completedEvent);
    state.status = 'completed';
    state.completedAt = nowIso();

    // Finalize the turn
    this.store.finalizeTurn(turnId, 'completed', response === '' ? undefined : response);

    this.purgeExpiredStreams();
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
    this.bridgeEmit(turnId, failedEvent);
    state.status = 'failed';
    state.completedAt = nowIso();

    this.store.finalizeTurn(turnId, 'failed', reason);

    this.purgeExpiredStreams();
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
    this.bridgeEmit(turnId, cancelEvent);
    state.status = 'cancelled';
    state.completedAt = nowIso();

    this.store.finalizeTurn(turnId, 'cancelled');

    this.purgeExpiredStreams();
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
    return this.getStreamEvents(turnId).filter((e) => e.seq > fromSeq);
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

  getPurgedHighSeq(turnId: string): number | undefined {
    return this.purgedHighSeqByTurnId.get(turnId)?.highSeq;
  }

  /** Number of purge tombstones currently tracked. */
  get tombstoneCount(): number {
    return this.purgedHighSeqByTurnId.size;
  }

  /**
   * Remove terminal streams older than `maxAgeMs` (defaults to configured
   * retention). Active streams are never purged — only completed, failed, or
   * cancelled streams past the retention window are removed.
   *
   * @returns The number of streams purged.
   */
  purgeTerminalStreams(maxAgeMs?: number): number {
    const cutoff = Date.now() - (maxAgeMs ?? this.retentionMs);
    let purged = 0;
    for (const [streamId, state] of this.streams) {
      if (!TERMINAL_STREAM_STATUSES.has(state.status)) continue;
      if (state.completedAt === undefined) continue;
      if (new Date(state.completedAt).getTime() <= cutoff) {
        // eslint-disable-next-line unicorn/prefer-at -- `.at()` conflicts with this repo's Node compatibility lint rule.
        const highSeq = state.events.slice(-1).pop()?.seq ?? 0;
        this.purgedHighSeqByTurnId.set(state.turnId, {
          highSeq,
          purgedAt: Date.now(),
        });
        this.streams.delete(streamId);
        this.streamByTurnId.delete(state.turnId);
        purged += 1;
      }
    }

    // Evict expired tombstones (deterministic TTL-based expiry)
    const tombstoneCutoff = Date.now() - this.tombstoneRetentionMs;
    for (const [turnId, tombstone] of this.purgedHighSeqByTurnId) {
      if (tombstone.purgedAt <= tombstoneCutoff) {
        this.purgedHighSeqByTurnId.delete(turnId);
      }
    }

    // Hard cap: evict oldest tombstones if the map exceeds the maximum size
    if (this.purgedHighSeqByTurnId.size > StreamManager.MAX_TOMBSTONES) {
      const entries = [...this.purgedHighSeqByTurnId.entries()].sort(
        (a, b) => a[1].purgedAt - b[1].purgedAt,
      );
      const excess = entries.length - StreamManager.MAX_TOMBSTONES;
      for (let i = 0; i < excess; i++) {
        this.purgedHighSeqByTurnId.delete(entries[i][0]);
      }
    }

    return purged;
  }

  /** Number of streams currently tracked (active + retained terminal). */
  get streamCount(): number {
    return this.streams.size;
  }

  /**
   * Internal: purge expired streams after each terminal transition.
   * Uses the instance retention setting.
   */
  private purgeExpiredStreams(): void {
    this.purgeTerminalStreams();
  }
}
