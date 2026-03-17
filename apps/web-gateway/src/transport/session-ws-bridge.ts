import type { StoredSession } from '../session/session-store.ts';
import type {
  SessionStateChangeEvent,
  SessionStateBroadcaster,
} from '../session/session-state-broadcaster.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import type { WsConnection } from './ws-connection.ts';

interface SessionWsBridgeOptions {
  broadcaster: SessionStateBroadcaster;
  registry: ConnectionRegistry;
}

export class SessionWsBridge {
  readonly #broadcaster: SessionStateBroadcaster;
  readonly #registry: ConnectionRegistry;

  constructor(options: SessionWsBridgeOptions) {
    this.#broadcaster = options.broadcaster;
    this.#registry = options.registry;
  }

  bindSession(session: StoredSession, connection: WsConnection): () => void {
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearExpiryTimer = () => {
      if (expiryTimer != null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
    };

    const terminateSession = (state: 'expired' | 'invalidated' | 'logged-out', reason?: string) => {
      connection.send({
        type: 'session-terminated',
        state,
        ...(reason === undefined ? {} : { reason }),
      });
      setTimeout(() => {
        this.#registry.closeAllForSession(session.id);
      }, 0);
    };

    const scheduleExpiry = (expiresAt?: string) => {
      clearExpiryTimer();
      if (expiresAt == null || expiresAt === '') {
        return;
      }

      const delayMs = new Date(expiresAt).getTime() - Date.now();
      if (delayMs <= 0) {
        terminateSession('expired', 'Session expired');
        return;
      }

      expiryTimer = setTimeout(() => {
        terminateSession('expired', 'Session expired');
      }, delayMs);
    };

    const callback = (event: SessionStateChangeEvent) => {
      switch (event.newState) {
        case 'expired':
        case 'invalidated':
        case 'logged-out':
          terminateSession(event.newState, event.reason);
          return;
        case 'expiring-soon':
          if (event.expiresAt != null) {
            scheduleExpiry(event.expiresAt);
            connection.send({
              type: 'session-expiring-soon',
              expiresAt: event.expiresAt,
            });
          }
          return;
        case 'daemon-unreachable':
          scheduleExpiry(event.expiresAt);
          connection.send({ type: 'daemon-unavailable' });
          return;
        case 'active':
          scheduleExpiry(event.expiresAt);
          if (event.previousState === 'daemon-unreachable') {
            connection.send({ type: 'daemon-restored' });
          }
          break;
      }
    };

    this.#broadcaster.register(session.id, callback);
    scheduleExpiry(session.expiresAt);

    return () => {
      clearExpiryTimer();
      this.#broadcaster.unregister(session.id, callback);
    };
  }
}
