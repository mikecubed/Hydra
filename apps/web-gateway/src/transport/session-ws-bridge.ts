import type { StoredSession } from '../session/session-store.ts';
import type {
  SessionStateChangeEvent,
  SessionStateBroadcaster,
} from '../session/session-state-broadcaster.ts';
import type { Clock } from '../shared/clock.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import type { WsConnection } from './ws-connection.ts';

interface SessionWsBridgeOptions {
  broadcaster: SessionStateBroadcaster;
  registry: ConnectionRegistry;
  clock: Clock;
}

export class SessionWsBridge {
  readonly #broadcaster: SessionStateBroadcaster;
  readonly #registry: ConnectionRegistry;
  readonly #clock: Clock;

  constructor(options: SessionWsBridgeOptions) {
    this.#broadcaster = options.broadcaster;
    this.#registry = options.registry;
    this.#clock = options.clock;
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

    const applyExpiry = (expiresAt?: string): 'none' | 'scheduled' | 'terminated' => {
      clearExpiryTimer();
      if (expiresAt == null || expiresAt === '') {
        return 'none';
      }

      const expiresAtMs = new Date(expiresAt).getTime();
      if (Number.isNaN(expiresAtMs)) {
        terminateSession('expired', 'Session expired');
        return 'terminated';
      }

      const delayMs = expiresAtMs - this.#clock.now();
      if (delayMs <= 0) {
        terminateSession('expired', 'Session expired');
        return 'terminated';
      }

      expiryTimer = setTimeout(() => {
        terminateSession('expired', 'Session expired');
      }, delayMs);
      return 'scheduled';
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
            connection.send({
              type: 'session-expiring-soon',
              expiresAt: event.expiresAt,
            });
            applyExpiry(event.expiresAt);
          }
          return;
        case 'daemon-unreachable':
          connection.send({ type: 'daemon-unavailable' });
          applyExpiry(event.expiresAt);
          return;
        case 'active': {
          const expiryResult = applyExpiry(event.expiresAt);
          if (event.previousState === 'daemon-unreachable' && expiryResult !== 'terminated') {
            connection.send({ type: 'daemon-restored' });
          }
          break;
        }
      }
    };

    this.#broadcaster.register(session.id, callback);
    applyExpiry(session.expiresAt);

    return () => {
      clearExpiryTimer();
      this.#broadcaster.unregister(session.id, callback);
    };
  }
}
