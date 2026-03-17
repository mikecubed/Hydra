/**
 * Per-connection lifecycle model for WebSocket transport.
 *
 * Each WsConnection:
 *   - binds immutably to a sessionId (set at creation)
 *   - generates a unique connectionId via crypto.randomUUID()
 *   - implements a state machine: open → closing → closed
 *   - tracks conversation subscriptions and last acknowledged seq
 *   - cleans up registry on close
 */
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@hydra/web-contracts';
import WebSocket from 'ws';
import type { ConnectionRegistry, ManagedConnection, ReplayState } from './connection-registry.ts';
import { serializeServerMessage, type ServerMessage } from './ws-protocol.ts';

export type WsConnectionState = 'open' | 'closing' | 'closed';

export class WsConnection implements ManagedConnection {
  readonly connectionId: string;
  readonly subscribedConversations = new Set<string>();
  readonly lastAckSeq = new Map<string, number>();
  readonly replayState = new Map<string, ReplayState>();
  readonly pendingEvents = new Map<string, StreamEvent[]>();

  #state: WsConnectionState = 'open';
  readonly #ws: WebSocket;
  readonly #registry: ConnectionRegistry;
  readonly #sessionId: string;

  private constructor(sessionId: string, ws: WebSocket, registry: ConnectionRegistry) {
    this.connectionId = randomUUID();
    this.#sessionId = sessionId;
    this.#ws = ws;
    this.#registry = registry;

    // Register in the registry
    registry.register(this);

    // Listen for external close (network drop, peer close)
    ws.on('close', () => {
      this.#handleSocketClosed();
    });
    ws.on('error', () => {
      this.#handleSocketErrored();
    });
  }

  static create(sessionId: string, ws: WebSocket, registry: ConnectionRegistry): WsConnection {
    return new WsConnection(sessionId, ws, registry);
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get state(): WsConnectionState {
    return this.#state;
  }

  get isClosed(): boolean {
    return this.#state === 'closing' || this.#state === 'closed';
  }

  send(msg: ServerMessage): void {
    if (this.isClosed || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(serializeServerMessage(msg));
  }

  close(code?: number, reason?: string): void {
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    this.#ws.close(code, reason);
  }

  updateAck(conversationId: string, seq: number): void {
    const current = this.lastAckSeq.get(conversationId) ?? -1;
    if (seq > current) {
      this.lastAckSeq.set(conversationId, seq);
    }
  }

  #handleSocketClosed(): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closed';
    this.#registry.unregister(this.connectionId);
  }

  #handleSocketErrored(): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closing';
    if (typeof this.#ws.terminate === 'function') {
      this.#ws.terminate();
    }
    this.#handleSocketClosed();
  }
}
