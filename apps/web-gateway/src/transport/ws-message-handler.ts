/**
 * WebSocket message handler (T026).
 *
 * Handles client→server messages: subscribe, unsubscribe, ack.
 * Implements the replay barrier pattern for reconnect/resume semantics:
 *   - On subscribe with lastAcknowledgedSeq and buffer hit, replays buffered
 *     events, queues concurrent live arrivals, flushes deduplicated pending
 *     events, then transitions to live.
 *   - On unsubscribe: removes subscription, clears replay/pending state.
 *   - On ack: updates per-conversation lastAckSeq (fire-and-forget).
 *   - On invalid message: responds with type:'error' without closing.
 */
import type { StreamEvent } from '@hydra/web-contracts';
import type { ManagedConnection } from './connection-registry.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import type { EventBuffer } from './event-buffer.ts';
import type { ServerMessage } from './ws-protocol.ts';
import { parseClientMessage } from './ws-protocol.ts';
import type { DaemonClient } from '../conversation/daemon-client.ts';

export interface MessageHandlerDeps {
  readonly registry: ConnectionRegistry;
  readonly buffer: EventBuffer;
  readonly daemonClient: Pick<DaemonClient, 'openConversation'>;
}

function lastSeq(events: ReadonlyArray<StreamEvent>): number | undefined {
  // eslint-disable-next-line unicorn/prefer-at -- `.at()` conflicts with this package's Node compatibility lint rule.
  return events.slice(-1).pop()?.seq;
}

export class WsMessageHandler {
  readonly #registry: ConnectionRegistry;
  readonly #buffer: EventBuffer;
  readonly #daemonClient: MessageHandlerDeps['daemonClient'];

  constructor(deps: MessageHandlerDeps) {
    this.#registry = deps.registry;
    this.#buffer = deps.buffer;
    this.#daemonClient = deps.daemonClient;
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
    // Validate conversation exists via daemon
    const result = await this.#daemonClient.openConversation(conversationId);
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
    const canReplay =
      lastAcknowledgedSeq !== undefined &&
      this.#buffer.hasEventsSince(conversationId, lastAcknowledgedSeq);

    if (canReplay) {
      // ── replay barrier ──────────────────────────────────────────────────
      connection.replayState.set(conversationId, 'replaying');
      connection.pendingEvents.set(conversationId, []);
      this.#registry.addSubscription(connection.connectionId, conversationId);

      const buffered = this.#buffer.getEventsSince(conversationId, lastAcknowledgedSeq);

      // Send each buffered event
      for (const event of buffered) {
        this.#sendStreamEvent(connection, conversationId, event);
      }

      // Compute last replayed seq
      const lastReplayedSeq = lastSeq(buffered) ?? lastAcknowledgedSeq;

      // Flush pending queue (events queued by T027 during replay)
      const pending = connection.pendingEvents.get(conversationId) ?? [];
      const seen = new Map<number, StreamEvent>();
      for (const evt of pending) {
        if (evt.seq > lastReplayedSeq) {
          seen.set(evt.seq, evt);
        }
      }
      const toFlush = [...seen.values()].sort((a, b) => a.seq - b.seq);
      for (const event of toFlush) {
        this.#sendStreamEvent(connection, conversationId, event);
      }

      const currentSeq = lastSeq(toFlush) ?? lastReplayedSeq;

      connection.pendingEvents.delete(conversationId);
      connection.replayState.set(conversationId, 'live');

      connection.send({
        type: 'subscribed',
        conversationId,
        currentSeq,
      });
    } else {
      // ── no replay (initial subscribe or buffer miss) ────────────────────
      connection.replayState.set(conversationId, 'live');
      connection.pendingEvents.set(conversationId, []);
      this.#registry.addSubscription(connection.connectionId, conversationId);

      const currentSeq = this.#buffer.getHighwaterSeq(conversationId);
      connection.send({
        type: 'subscribed',
        conversationId,
        currentSeq,
      });
    }
  }

  #handleUnsubscribe(connection: ManagedConnection, conversationId: string): void {
    this.#registry.removeSubscription(connection.connectionId, conversationId);
    connection.replayState.delete(conversationId);
    connection.pendingEvents.delete(conversationId);

    connection.send({
      type: 'unsubscribed',
      conversationId,
    });
  }

  #sendStreamEvent(
    connection: ManagedConnection,
    conversationId: string,
    event: StreamEvent,
  ): void {
    connection.send({
      type: 'stream-event',
      conversationId,
      event,
    });
  }

  #sendError(
    connection: ManagedConnection,
    code: string,
    message: string,
    category: ServerMessage extends { category: infer C } ? C : string = 'validation',
    conversationId?: string,
  ): void {
    const errorMsg: ServerMessage = {
      type: 'error',
      ok: false as const,
      code,
      category: category as 'validation',
      message,
      ...(conversationId !== undefined && { conversationId }),
    };
    connection.send(errorMsg);
  }
}
