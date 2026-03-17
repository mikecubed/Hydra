/**
 * WebSocket message handler (T026, T032).
 *
 * Handles client→server messages: subscribe, unsubscribe, ack.
 * Implements the replay barrier pattern for reconnect/resume semantics:
 *   - On subscribe with lastAcknowledgedSeq and buffer hit, replays buffered
 *     events, queues concurrent live arrivals, flushes deduplicated pending
 *     events, then transitions to live.
 *   - On subscribe with lastAcknowledgedSeq and buffer miss, falls back to
 *     daemon per-turn stream replay (T032): loads the full turn range for the
 *     conversation, retrieves per-turn events, merges/deduplicates, and sends
 *     under the replay barrier.
 *   - On unsubscribe: removes subscription, clears replay/pending state.
 *   - On ack: updates per-conversation lastAckSeq (fire-and-forget).
 *   - On invalid message: responds with type:'error' without closing.
 */
import type { StreamEvent, LoadTurnHistoryResponse } from '@hydra/web-contracts';
import { DEFAULT_BUFFER_HIGH_WATER_MARK, sendWithBackpressureProtection } from './backpressure.ts';
import type { ManagedConnection } from './connection-registry.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import type { EventBuffer } from './event-buffer.ts';
import type { ServerMessage } from './ws-protocol.ts';
import { parseClientMessage } from './ws-protocol.ts';
import type { DaemonClient } from '../conversation/daemon-client.ts';
import type { DaemonResult } from '../conversation/daemon-client.ts';

export interface MessageHandlerDeps {
  readonly registry: ConnectionRegistry;
  readonly buffer: EventBuffer;
  readonly daemonClient: Pick<
    DaemonClient,
    'openConversation' | 'loadTurnHistory' | 'getStreamReplay'
  >;
  readonly bufferHighWaterMark?: number;
}

function lastSeq(events: ReadonlyArray<StreamEvent>): number | undefined {
  // eslint-disable-next-line unicorn/prefer-at -- `.at()` conflicts with this package's Node compatibility lint rule.
  return events.slice(-1).pop()?.seq;
}

export class WsMessageHandler {
  readonly #registry: ConnectionRegistry;
  readonly #buffer: EventBuffer;
  readonly #daemonClient: MessageHandlerDeps['daemonClient'];
  readonly #bufferHighWaterMark: number;
  readonly #daemonReplayRetryFloors = new Map<string, number>();

  constructor(deps: MessageHandlerDeps) {
    this.#registry = deps.registry;
    this.#buffer = deps.buffer;
    this.#daemonClient = deps.daemonClient;
    this.#bufferHighWaterMark = deps.bufferHighWaterMark ?? DEFAULT_BUFFER_HIGH_WATER_MARK;
  }

  async handleMessage(connection: ManagedConnection, rawMessage: string): Promise<void> {
    const parsed = parseClientMessage(rawMessage);
    if (!parsed.ok) {
      this.#sendError(connection, 'WS_INVALID_MESSAGE', parsed.detail);
      return;
    }

    const { message } = parsed;

    switch (message.type) {
      case 'subscribe':
        await this.#handleSubscribe(
          connection,
          message.conversationId,
          message.lastAcknowledgedSeq,
        );
        break;
      case 'unsubscribe':
        this.#handleUnsubscribe(connection, message.conversationId);
        break;
      case 'ack':
        connection.updateAck(message.conversationId, message.seq);
        break;
    }
  }

  async #handleSubscribe(
    connection: ManagedConnection,
    conversationId: string,
    lastAcknowledgedSeq?: number,
  ): Promise<void> {
    const subscribeStartSeq = lastAcknowledgedSeq ?? this.#buffer.getHighwaterSeq(conversationId);
    const hadSafeReplayBufferAtStart =
      lastAcknowledgedSeq !== undefined &&
      !this.#mustBypassBufferReplay(conversationId, lastAcknowledgedSeq) &&
      this.#buffer.hasEventsSince(conversationId, lastAcknowledgedSeq);

    if (connection.subscribedConversations.has(conversationId)) {
      connection.replayState.set(conversationId, 'live');
      if (
        !this.#sendSubscribed(
          connection,
          conversationId,
          this.#buffer.getHighwaterSeq(conversationId),
        )
      ) {
        this.#cleanupSubscriptionState(connection, conversationId);
      }
      return;
    }

    this.#registry.addPendingInterest(connection.connectionId, conversationId);

    try {
      // Validate conversation exists via daemon
      const result = await this.#daemonClient.openConversation(conversationId);
      if (connection.isClosed) {
        return;
      }
      if ('error' in result) {
        this.#sendError(
          connection,
          result.error.code,
          result.error.message,
          result.error.category,
          conversationId,
        );
        return;
      }

      // Determine whether buffer can satisfy a replay
      const replayFromSeq = lastAcknowledgedSeq ?? subscribeStartSeq;
      const mustBypassBuffer = this.#mustBypassBufferReplay(conversationId, replayFromSeq);
      const canReplay =
        !mustBypassBuffer && this.#buffer.hasEventsSince(conversationId, replayFromSeq);

      if (lastAcknowledgedSeq !== undefined && !hadSafeReplayBufferAtStart) {
        this.#recordReplayRetryFloor(conversationId, lastAcknowledgedSeq);
        await this.#startDaemonReplaySubscription(
          connection,
          conversationId,
          lastAcknowledgedSeq,
          result.data.totalTurnCount,
        );
      } else if (canReplay) {
        this.#startReplaySubscription(connection, conversationId, replayFromSeq);
      } else if (lastAcknowledgedSeq === undefined) {
        // ── initial subscribe (no replay needed) ──────────────────────────
        this.#startLiveSubscription(connection, conversationId);
      } else {
        // ── buffer miss on reconnect → daemon fallback (T032) ─────────────
        this.#recordReplayRetryFloor(conversationId, lastAcknowledgedSeq);
        await this.#startDaemonReplaySubscription(
          connection,
          conversationId,
          lastAcknowledgedSeq,
          result.data.totalTurnCount,
        );
      }
    } finally {
      this.#registry.removePendingInterest(connection.connectionId, conversationId);
    }
  }

  #startReplaySubscription(
    connection: ManagedConnection,
    conversationId: string,
    replayFromSeq: number,
  ): void {
    connection.replayState.set(conversationId, 'replaying');
    connection.pendingEvents.set(conversationId, []);
    this.#registry.addSubscription(connection.connectionId, conversationId);

    const buffered = this.#buffer.getEventsSince(conversationId, replayFromSeq);
    for (const event of buffered) {
      if (!this.#sendStreamEvent(connection, conversationId, event)) {
        this.#cleanupSubscriptionState(connection, conversationId);
        return;
      }
    }

    // This replay path is intentionally synchronous today: no `await` occurs
    // between `addSubscription()` above and the transition to `'live'` below.
    // That means pendingEvents normally stays empty in production unless replay
    // delivery becomes async in the future.
    const lastReplayedSeq = lastSeq(buffered) ?? replayFromSeq;
    const currentSeq = this.#flushPendingReplayEvents(connection, conversationId, lastReplayedSeq);
    if (currentSeq === null) {
      return;
    }

    connection.pendingEvents.delete(conversationId);
    connection.replayState.set(conversationId, 'live');

    if (!this.#sendSubscribed(connection, conversationId, currentSeq)) {
      this.#cleanupSubscriptionState(connection, conversationId);
    }
  }

  /**
   * Daemon fallback replay (T032): fetch missed events from the daemon when
   * the in-memory EventBuffer cannot satisfy a reconnect replay.
   *
   * Loads the full turn range for the conversation using the daemon's
   * `fromPosition`/`toPosition` contract, fetches per-turn stream replay,
   * merges/deduplicates events by seq, and sends them under the replay barrier.
   *
   * If any per-turn getStreamReplay call fails, the replay is aborted: an
   * error is sent to the client and subscription state is cleaned up rather
   * than silently promoting to live with incomplete data.
   */
  async #startDaemonReplaySubscription(
    connection: ManagedConnection,
    conversationId: string,
    lastAcknowledgedSeq: number,
    totalTurnCount: number,
  ): Promise<void> {
    connection.replayState.set(conversationId, 'replaying');
    connection.pendingEvents.set(conversationId, []);
    this.#registry.addSubscription(connection.connectionId, conversationId);

    const allTurnsResult = await this.#loadTurnsForReplay(
      connection,
      conversationId,
      totalTurnCount,
    );
    if (allTurnsResult === null) {
      return;
    }
    if ('error' in allTurnsResult) {
      this.#abortReplay(
        connection,
        conversationId,
        lastAcknowledgedSeq,
        'REPLAY_INCOMPLETE',
        'Unable to load turn history for replay',
      );
      return;
    }

    const turns = allTurnsResult.data.turns;

    const replayResults = await Promise.all(
      turns.map((turn) =>
        this.#daemonClient.getStreamReplay(conversationId, turn.id, lastAcknowledgedSeq),
      ),
    );

    if (connection.isClosed) return;

    // ── Abort on any per-turn replay error ──────────────────────────────
    const failedTurnIds = this.#collectReplayFailures(turns, replayResults);
    if (failedTurnIds.length > 0) {
      this.#abortReplay(
        connection,
        conversationId,
        lastAcknowledgedSeq,
        'REPLAY_INCOMPLETE',
        `Stream replay failed for turn(s): ${failedTurnIds.join(', ')}`,
      );
      return;
    }

    const sorted = this.#mergeAndDedup(
      replayResults,
      lastAcknowledgedSeq,
      this.#buffer.getEventsSince(conversationId, lastAcknowledgedSeq),
    );

    for (const event of sorted) {
      if (!this.#sendStreamEvent(connection, conversationId, event)) {
        this.#cleanupSubscriptionState(connection, conversationId);
        return;
      }
    }

    // Flush pending live events that arrived during daemon fetch
    const lastReplayedSeq = lastSeq(sorted) ?? lastAcknowledgedSeq;
    const currentSeq = this.#flushPendingReplayEvents(connection, conversationId, lastReplayedSeq);
    if (currentSeq === null) return;

    connection.pendingEvents.delete(conversationId);
    connection.replayState.set(conversationId, 'live');

    if (!this.#sendSubscribed(connection, conversationId, currentSeq)) {
      this.#cleanupSubscriptionState(connection, conversationId);
    }
  }

  #collectReplayFailures(
    turns: LoadTurnHistoryResponse['turns'],
    replayResults: ReadonlyArray<DaemonResult<{ events: StreamEvent[] }>>,
  ): string[] {
    const failed: string[] = [];
    for (const [i, result] of replayResults.entries()) {
      if ('error' in result) {
        failed.push(turns[i].id);
      }
    }
    return failed;
  }

  #mergeAndDedup(
    replayResults: ReadonlyArray<DaemonResult<{ events: StreamEvent[] }>>,
    lastAcknowledgedSeq: number,
    extraEvents: ReadonlyArray<StreamEvent> = [],
  ): StreamEvent[] {
    const allEvents: StreamEvent[] = [];
    for (const result of replayResults) {
      if ('data' in result) {
        allEvents.push(...result.data.events);
      }
    }
    allEvents.push(...extraEvents);
    const deduped = new Map<number, StreamEvent>();
    for (const event of allEvents) {
      if (event.seq > lastAcknowledgedSeq) {
        deduped.set(event.seq, event);
      }
    }
    return [...deduped.values()].sort((a, b) => a.seq - b.seq);
  }

  #abortReplay(
    connection: ManagedConnection,
    conversationId: string,
    lastAcknowledgedSeq: number,
    code: string,
    message: string,
  ): void {
    this.#recordReplayRetryFloor(conversationId, lastAcknowledgedSeq);
    this.#sendError(connection, code, message, 'daemon', conversationId);
    this.#cleanupSubscriptionState(connection, conversationId);
  }

  #mustBypassBufferReplay(conversationId: string, replayFromSeq: number): boolean {
    const retryFloor = this.#daemonReplayRetryFloors.get(conversationId);
    return retryFloor !== undefined && replayFromSeq <= retryFloor;
  }

  #recordReplayRetryFloor(conversationId: string, replayFromSeq: number): void {
    const currentFloor =
      this.#daemonReplayRetryFloors.get(conversationId) ?? Number.NEGATIVE_INFINITY;
    if (replayFromSeq > currentFloor) {
      this.#daemonReplayRetryFloors.set(conversationId, replayFromSeq);
    }
  }

  async #loadTurnsForReplay(
    connection: ManagedConnection,
    conversationId: string,
    totalTurnCount: number,
  ): Promise<DaemonResult<{ turns: LoadTurnHistoryResponse['turns'] }> | null> {
    if (totalTurnCount < 1) {
      return { data: { turns: [] } };
    }

    const result = await this.#daemonClient.loadTurnHistory(conversationId, {
      conversationId,
      fromPosition: 1,
      toPosition: totalTurnCount,
    });

    if (connection.isClosed) {
      return null;
    }

    if ('error' in result) {
      return result;
    }

    if (result.data.turns.length < totalTurnCount) {
      return {
        error: {
          ok: false,
          code: 'REPLAY_INCOMPLETE',
          category: 'daemon',
          message: 'Turn history replay response was incomplete',
        },
      };
    }

    return { data: { turns: result.data.turns } };
  }

  #flushPendingReplayEvents(
    connection: ManagedConnection,
    conversationId: string,
    lastReplayedSeq: number,
  ): number | null {
    const pending = connection.pendingEvents.get(conversationId) ?? [];
    const seen = new Map<number, StreamEvent>();
    for (const event of pending) {
      if (event.seq > lastReplayedSeq) {
        seen.set(event.seq, event);
      }
    }

    const toFlush = [...seen.values()].sort((a, b) => a.seq - b.seq);
    for (const event of toFlush) {
      if (!this.#sendStreamEvent(connection, conversationId, event)) {
        this.#cleanupSubscriptionState(connection, conversationId);
        return null;
      }
    }

    return lastSeq(toFlush) ?? lastReplayedSeq;
  }

  #startLiveSubscription(connection: ManagedConnection, conversationId: string): void {
    connection.replayState.set(conversationId, 'live');
    connection.pendingEvents.set(conversationId, []);
    this.#registry.addSubscription(connection.connectionId, conversationId);

    const currentSeq = this.#buffer.getHighwaterSeq(conversationId);
    if (!this.#sendSubscribed(connection, conversationId, currentSeq)) {
      this.#cleanupSubscriptionState(connection, conversationId);
    }
  }

  #handleUnsubscribe(connection: ManagedConnection, conversationId: string): void {
    this.#registry.removeSubscription(connection.connectionId, conversationId);
    connection.replayState.delete(conversationId);
    connection.pendingEvents.delete(conversationId);

    this.#sendUnsubscribed(connection, conversationId);
  }

  #sendStreamEvent(
    connection: ManagedConnection,
    conversationId: string,
    event: StreamEvent,
  ): boolean {
    return sendWithBackpressureProtection(
      connection,
      {
        type: 'stream-event',
        conversationId,
        event,
      },
      this.#bufferHighWaterMark,
    );
  }

  #sendSubscribed(
    connection: ManagedConnection,
    conversationId: string,
    currentSeq: number,
  ): boolean {
    return sendWithBackpressureProtection(
      connection,
      {
        type: 'subscribed',
        conversationId,
        currentSeq,
      },
      this.#bufferHighWaterMark,
    );
  }

  #sendUnsubscribed(connection: ManagedConnection, conversationId: string): boolean {
    return sendWithBackpressureProtection(
      connection,
      {
        type: 'unsubscribed',
        conversationId,
      },
      this.#bufferHighWaterMark,
    );
  }

  #cleanupSubscriptionState(connection: ManagedConnection, conversationId: string): void {
    this.#registry.removeSubscription(connection.connectionId, conversationId);
    connection.replayState.delete(conversationId);
    connection.pendingEvents.delete(conversationId);
  }

  #sendError(
    connection: ManagedConnection,
    code: string,
    message: string,
    category: Extract<ServerMessage, { type: 'error' }>['category'] = 'validation',
    conversationId?: string,
  ): void {
    void sendWithBackpressureProtection(
      connection,
      {
        type: 'error',
        ok: false as const,
        code,
        category,
        message,
        ...(conversationId !== undefined && { conversationId }),
      },
      this.#bufferHighWaterMark,
    );
  }
}
