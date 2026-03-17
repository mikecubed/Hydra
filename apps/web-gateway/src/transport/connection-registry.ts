/**
 * Dual-index connection registry for WebSocket transport.
 *
 * Indexes:
 *   sessionId → Set<ManagedConnection>  (session lifecycle events)
 *   conversationId → Set<ManagedConnection>  (stream event forwarding)
 */
import type { StreamEvent } from '@hydra/web-contracts';
import type { ServerMessage } from './ws-protocol.ts';

export type ReplayState = 'live' | 'replaying';

export interface ManagedConnection {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly subscribedConversations: Set<string>;
  readonly lastAckSeq: Map<string, number>;
  readonly replayState: Map<string, ReplayState>;
  readonly pendingEvents: Map<string, StreamEvent[]>;
  /** Bytes queued in the underlying WebSocket send buffer (0 when unavailable). */
  readonly bufferedAmount: number;
  send(message: ServerMessage): void;
  updateAck(conversationId: string, seq: number): void;
  close(code?: number, reason?: string): void;
  readonly isClosed: boolean;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly bySession = new Map<string, Set<ManagedConnection>>();
  private readonly byConversation = new Map<string, Set<ManagedConnection>>();

  get size(): number {
    return this.connections.size;
  }

  register(conn: ManagedConnection): void {
    if (this.connections.has(conn.connectionId)) return;
    this.connections.set(conn.connectionId, conn);

    let sessionSet = this.bySession.get(conn.sessionId);
    if (!sessionSet) {
      sessionSet = new Set();
      this.bySession.set(conn.sessionId, sessionSet);
    }
    sessionSet.add(conn);
  }

  unregister(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // Remove from session index
    const sessionSet = this.bySession.get(conn.sessionId);
    if (sessionSet) {
      sessionSet.delete(conn);
      if (sessionSet.size === 0) {
        this.bySession.delete(conn.sessionId);
      }
    }

    // Remove from all conversation indices
    for (const convId of conn.subscribedConversations) {
      const convSet = this.byConversation.get(convId);
      if (convSet) {
        convSet.delete(conn);
        if (convSet.size === 0) {
          this.byConversation.delete(convId);
        }
      }
    }

    this.connections.delete(connectionId);
  }

  getBySession(sessionId: string): ReadonlySet<ManagedConnection> {
    return this.bySession.get(sessionId) ?? EMPTY_SET;
  }

  getByConversation(conversationId: string): ReadonlySet<ManagedConnection> {
    return this.byConversation.get(conversationId) ?? EMPTY_SET;
  }

  addSubscription(connectionId: string, conversationId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    conn.subscribedConversations.add(conversationId);

    let convSet = this.byConversation.get(conversationId);
    if (!convSet) {
      convSet = new Set();
      this.byConversation.set(conversationId, convSet);
    }
    convSet.add(conn);
  }

  removeSubscription(connectionId: string, conversationId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    conn.subscribedConversations.delete(conversationId);

    const convSet = this.byConversation.get(conversationId);
    if (convSet) {
      convSet.delete(conn);
      if (convSet.size === 0) {
        this.byConversation.delete(conversationId);
      }
    }
  }

  closeAllForSession(sessionId: string): void {
    const sessionSet = this.bySession.get(sessionId);
    if (!sessionSet) return;

    // Snapshot to avoid mutation during iteration
    const connections = [...sessionSet];
    for (const conn of connections) {
      conn.close();
      this.unregister(conn.connectionId);
    }
  }
}

const EMPTY_SET: ReadonlySet<ManagedConnection> = new Set();
