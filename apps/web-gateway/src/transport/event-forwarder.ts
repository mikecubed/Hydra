/**
 * EventForwarder — subscribes to daemon EventBridge stream-event emissions
 * and forwards them to browser clients via WebSocket connections.
 *
 * For each event:
 *   (a) push to EventBuffer (always, regardless of subscribers)
 *   (b) look up subscribed connections via ConnectionRegistry.getByConversation()
 *   (c) per-connection per-conversation replay check:
 *       - if replayState is 'replaying' → queue in pendingEvents
 *       - if 'live' or no entry → send stream-event WS message immediately
 */

import type { StreamEvent } from '@hydra/web-contracts';
import { DEFAULT_BUFFER_HIGH_WATER_MARK, sendWithBackpressureProtection } from './backpressure.ts';
import type { EventBuffer } from './event-buffer.ts';
import type { ConnectionRegistry, ManagedConnection } from './connection-registry.ts';

export interface StreamEventPayload {
  readonly conversationId: string;
  readonly event: StreamEvent;
}

export interface StreamEventBridgeLike {
  on(eventName: 'stream-event', listener: (payload: StreamEventPayload) => void): unknown;
  removeListener(
    eventName: 'stream-event',
    listener: (payload: StreamEventPayload) => void,
  ): unknown;
}

export interface EventForwarderOptions {
  /** Close connections whose WebSocket bufferedAmount exceeds this (bytes). Default: 1 MiB. */
  bufferHighWaterMark?: number;
}

export class EventForwarder {
  readonly #bridge: StreamEventBridgeLike;
  readonly #buffer: EventBuffer;
  readonly #registry: ConnectionRegistry;
  readonly #highWaterMark: number;
  #listener: ((payload: StreamEventPayload) => void) | null = null;

  constructor(
    bridge: StreamEventBridgeLike,
    buffer: EventBuffer,
    registry: ConnectionRegistry,
    options?: EventForwarderOptions,
  ) {
    this.#bridge = bridge;
    this.#buffer = buffer;
    this.#registry = registry;
    this.#highWaterMark = options?.bufferHighWaterMark ?? DEFAULT_BUFFER_HIGH_WATER_MARK;
  }

  /** Subscribe to the bridge and begin forwarding events. */
  start(): void {
    if (this.#listener) return; // already started

    this.#listener = (payload: StreamEventPayload) => {
      this.#handleStreamEvent(payload.conversationId, payload.event);
    };

    this.#bridge.on('stream-event', this.#listener);
  }

  /** Unsubscribe from the bridge. */
  dispose(): void {
    if (this.#listener) {
      this.#bridge.removeListener('stream-event', this.#listener);
      this.#listener = null;
    }
  }

  #handleStreamEvent(conversationId: string, event: StreamEvent): void {
    // (a) Always buffer
    this.#buffer.push(conversationId, event);

    // (b) Look up subscribed connections
    const connections = this.#registry.getByConversation(conversationId);

    // (c) Forward or queue per connection
    for (const conn of connections) {
      try {
        this.#forwardToConnection(conn, conversationId, event);
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown error';
        console.warn('[EventForwarder] stream delivery failure', {
          connectionId: conn.connectionId,
          conversationId,
          seq: event.seq,
          detail,
        });
        if (!conn.isClosed) {
          conn.close(1011, 'Stream delivery failed');
        }
      }
    }
  }

  #forwardToConnection(conn: ManagedConnection, conversationId: string, event: StreamEvent): void {
    if (conn.isClosed) {
      return;
    }

    const state = conn.replayState.get(conversationId);

    if (state === 'replaying') {
      // Queue for later flush by T026 replay completion
      let queue = conn.pendingEvents.get(conversationId);
      if (!queue) {
        queue = [];
        conn.pendingEvents.set(conversationId, queue);
      }
      queue.push(event);
      return;
    }

    // 'live' or no entry — send immediately
    sendWithBackpressureProtection(
      conn,
      {
        type: 'stream-event',
        conversationId,
        event,
      },
      this.#highWaterMark,
    );
  }
}
