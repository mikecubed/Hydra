/**
 * EventBridge — daemon-side event subscription mechanism.
 *
 * A typed EventEmitter wrapper that emits `stream-event` with
 * `{ conversationId: string, event: StreamEvent }` payload. The gateway
 * (or any other consumer) subscribes to this bridge to receive daemon-produced
 * stream events in real time without polling.
 *
 * Lives in lib/daemon/ because it is a daemon-side amendment. The gateway
 * consumes it through the EventEmitter interface.
 */

import { EventEmitter } from 'node:events';

import type { StreamEvent } from '@hydra/web-contracts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StreamEventPayload {
  conversationId: string;
  event: StreamEvent;
}

export interface EventBridgeEvents {
  'stream-event': [StreamEventPayload];
}

// ── EventBridge ──────────────────────────────────────────────────────────────

export class EventBridge {
  private readonly emitter = new EventEmitter();

  /** Emit a stream event with conversation context. */
  emitStreamEvent(conversationId: string, event: StreamEvent): void {
    const payload: StreamEventPayload = { conversationId, event };
    this.emitter.emit('stream-event', payload);
  }

  /** Subscribe to stream events. */
  on(eventName: 'stream-event', listener: (payload: StreamEventPayload) => void): this {
    this.emitter.on(eventName, listener);
    return this;
  }

  /** Remove a specific listener. */
  removeListener(eventName: 'stream-event', listener: (payload: StreamEventPayload) => void): this {
    this.emitter.removeListener(eventName, listener);
    return this;
  }

  /** Remove all listeners for the given event. */
  removeAllListeners(eventName: 'stream-event'): this {
    this.emitter.removeAllListeners(eventName);
    return this;
  }

  /** Return the number of listeners for the given event. */
  listenerCount(eventName: 'stream-event'): number {
    return this.emitter.listenerCount(eventName);
  }

  /** Remove all listeners. New listeners added after dispose will still work. */
  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
