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

const DAEMON_REPLAY_CONCURRENCY = 8;

function lastSeq(events: ReadonlyArray<StreamEvent>): number | undefined {
  return events.at(-1)?.seq;
}

export class WsMessageHandler {
  readonly #registry: ConnectionRegistry;
  readonly #buffer: EventBuffer;
  readonly #daemonClient: MessageHandlerDeps['daemonClient'];
  readonly #bufferHighWaterMark: number;
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

    if (connection.pendingConversations.has(conversationId)) {
      return;
    }

    if (this.#handleExistingSubscription(connection, conversationId)) {
      return;
    }

    const subscribeGeneration = this.#beginSubscribeAttempt(connection, conversationId);
    this.#buffer.markConversationActive(conversationId);
    this.#registry.addPendingInterest(connection.connectionId, conversationId);

    try {
      // Validate conversation exists via daemon
      const result = await this.#daemonClient.openConversation(conversationId);
      if (
        connection.isClosed ||
        !this.#isActiveSubscribeAttempt(connection, conversationId, subscribeGeneration)
      ) {
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
      const canReplay =
        lastAcknowledgedSeq === undefined
          ? this.#buffer.getHighwaterSeq(conversationId) > subscribeStartSeq
          : this.#buffer.hasEventsSince(conversationId, replayFromSeq);

      if (canReplay) {
        this.#startReplaySubscription(connection, conversationId, replayFromSeq);
      } else if (lastAcknowledgedSeq === undefined) {
        // ── initial subscribe (no replay needed) ──────────────────────────
        this.#startLiveSubscription(connection, conversationId);
      } else {
        // ── buffer miss on reconnect → daemon fallback (T032) ─────────────
        await this.#startDaemonReplaySubscription(
          connection,
          conversationId,
          lastAcknowledgedSeq,
          result.data.totalTurnCount,
          subscribeGeneration,
        );
      }
    } finally {
      this.#registry.removePendingInterest(connection.connectionId, conversationId);
      if (!this.#registry.hasInterest(conversationId)) {
        this.#buffer.markConversationInactive(conversationId);
      }
    }
  }

  #handleExistingSubscription(connection: ManagedConnection, conversationId: string): boolean {
    if (!connection.subscribedConversations.has(conversationId)) {
      return false;
    }

    const currentSeq = this.#getExistingSubscriptionSeq(connection, conversationId);
    if (!this.#sendSubscribed(connection, conversationId, currentSeq)) {
      this.#cleanupSubscriptionState(connection, conversationId);
    }
    return true;
  }

  #getExistingSubscriptionSeq(connection: ManagedConnection, conversationId: string): number {
    if (connection.replayState.get(conversationId) === 'replaying') {
      // During active replay: do NOT switch to live or advertise buffer
      // highwater — that would acknowledge seqs not yet delivered. Return
      // only the seq actually delivered so far (may be 0 if replay is
      // still in-flight). The replay completion path will send the real
      // subscribed ack with the final currentSeq.
      return connection.lastDeliveredSeq.get(conversationId) ?? 0;
    }

    // Post-replay (live): safe to include buffer highwater.
    const bufferSeq = this.#buffer.getHighwaterSeq(conversationId);
    const deliveredSeq = connection.lastDeliveredSeq.get(conversationId) ?? 0;
    return Math.max(bufferSeq, deliveredSeq);
  }

  #beginSubscribeAttempt(connection: ManagedConnection, conversationId: string): number {
    const nextGeneration = (connection.subscribeGenerations.get(conversationId) ?? 0) + 1;
    connection.subscribeGenerations.set(conversationId, nextGeneration);
    return nextGeneration;
  }

  #isActiveSubscribeAttempt(
    connection: ManagedConnection,
    conversationId: string,
    subscribeGeneration: number,
  ): boolean {
    return connection.subscribeGenerations.get(conversationId) === subscribeGeneration;
  }

  #invalidateSubscribeAttempt(connection: ManagedConnection, conversationId: string): void {
    const nextGeneration = (connection.subscribeGenerations.get(conversationId) ?? 0) + 1;
    connection.subscribeGenerations.set(conversationId, nextGeneration);
  }

  #startReplaySubscription(
    connection: ManagedConnection,
    conversationId: string,
    replayFromSeq: number,
  ): void {
    this.#buffer.markConversationActive(conversationId);
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
    this.#buffer.markReplaySafeFrom(conversationId, replayFromSeq);

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
    subscribeGeneration: number,
  ): Promise<void> {
    this.#buffer.markConversationActive(conversationId);
    connection.replayState.set(conversationId, 'replaying');
    connection.pendingEvents.set(conversationId, []);
    this.#registry.addSubscription(connection.connectionId, conversationId);

    const allTurnsResult = await this.#loadTurnsForReplay(
      connection,
      conversationId,
      totalTurnCount,
    );
    if (!this.#isActiveSubscribeAttempt(connection, conversationId, subscribeGeneration)) {
      return;
    }
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

    const replayResults = await this.#mapTurnsWithConcurrency(
      turns,
      DAEMON_REPLAY_CONCURRENCY,
      (turn) =>
        this.#daemonClient.getStreamReplay(turn.conversationId, turn.id, lastAcknowledgedSeq),
    );

    if (
      connection.isClosed ||
      !this.#isActiveSubscribeAttempt(connection, conversationId, subscribeGeneration)
    ) {
      return;
    }

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
    const oldestBufferedSeq = this.#buffer.getOldestBufferedSeq(conversationId);
    if (oldestBufferedSeq !== undefined && oldestBufferedSeq > 0) {
      this.#buffer.markReplaySafeFrom(conversationId, oldestBufferedSeq - 1);
    }

    if (!this.#sendSubscribed(connection, conversationId, currentSeq)) {
      this.#cleanupSubscriptionState(connection, conversationId);
    }
  }

  async #mapTurnsWithConcurrency<T>(
    turns: LoadTurnHistoryResponse['turns'],
    concurrency: number,
    mapper: (turn: LoadTurnHistoryResponse['turns'][number]) => Promise<T>,
  ): Promise<T[]> {
    const results: T[] = [];
    results.length = turns.length;
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, turns.length);
    await Promise.all(
      Array.from({ length: workerCount }, async function run(): Promise<void> {
        if (nextIndex >= turns.length) {
          return;
        }
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(turns[currentIndex]);
        return run();
      }),
    );
    return results;
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
    _lastAcknowledgedSeq: number,
    code: string,
    message: string,
  ): void {
    this.#sendError(connection, code, message, 'daemon', conversationId);
    this.#cleanupSubscriptionState(connection, conversationId);
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
    this.#buffer.markConversationActive(conversationId);
    connection.replayState.set(conversationId, 'live');
    this.#registry.addSubscription(connection.connectionId, conversationId);

    const currentSeq = this.#buffer.getHighwaterSeq(conversationId);
    if (currentSeq > 0) {
      this.#buffer.markReplaySafeFrom(conversationId, currentSeq);
    }
    if (!this.#sendSubscribed(connection, conversationId, currentSeq)) {
      this.#cleanupSubscriptionState(connection, conversationId);
    }
  }

  #handleUnsubscribe(connection: ManagedConnection, conversationId: string): void {
    this.#invalidateSubscribeAttempt(connection, conversationId);
    this.#registry.removePendingInterest(connection.connectionId, conversationId);
    this.#registry.removeSubscription(connection.connectionId, conversationId);
    connection.replayState.delete(conversationId);
    connection.pendingEvents.delete(conversationId);
    connection.lastDeliveredSeq.delete(conversationId);
    if (!this.#registry.hasInterest(conversationId)) {
      this.#buffer.markConversationInactive(conversationId);
    }

    this.#sendUnsubscribed(connection, conversationId);
  }

  #sendStreamEvent(
    connection: ManagedConnection,
    conversationId: string,
    event: StreamEvent,
  ): boolean {
    const ok = sendWithBackpressureProtection(
      connection,
      {
        type: 'stream-event',
        conversationId,
        event,
      },
      this.#bufferHighWaterMark,
    );
    if (ok) {
      const prev = connection.lastDeliveredSeq.get(conversationId) ?? 0;
      if (event.seq > prev) {
        connection.lastDeliveredSeq.set(conversationId, event.seq);
      }
    }
    return ok;
  }

  #sendSubscribed(
    connection: ManagedConnection,
    conversationId: string,
    currentSeq: number,
  ): boolean {
    const prev = connection.lastDeliveredSeq.get(conversationId) ?? 0;
    if (currentSeq > prev) {
      connection.lastDeliveredSeq.set(conversationId, currentSeq);
    }
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
    connection.lastDeliveredSeq.delete(conversationId);
    if (!this.#registry.hasInterest(conversationId)) {
      this.#buffer.markConversationInactive(conversationId);
    }
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
