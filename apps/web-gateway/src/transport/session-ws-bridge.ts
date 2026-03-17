import type { StoredSession } from '../session/session-store.ts';
import type {
  SessionStateChangeEvent,
  SessionStateBroadcaster,
} from '../session/session-state-broadcaster.ts';
import type { Clock } from '../shared/clock.ts';
import type { SessionState } from '@hydra/web-contracts';
import type { ConnectionRegistry } from './connection-registry.ts';
import type { WsConnection } from './ws-connection.ts';

interface SessionWsBridgeOptions {
  broadcaster: SessionStateBroadcaster;
  registry: ConnectionRegistry;
  clock: Clock;
  warningThresholdMs?: number;
}

type ExpiryOutcome = 'none' | 'scheduled' | 'terminated';
type TerminateSession = (state: 'expired' | 'invalidated' | 'logged-out', reason?: string) => void;
type ApplyExpiry = (expiresAt?: string) => ExpiryOutcome;

export class SessionWsBridge {
  readonly #broadcaster: SessionStateBroadcaster;
  readonly #registry: ConnectionRegistry;
  readonly #clock: Clock;
  readonly #warningThresholdMs: number;

  constructor(options: SessionWsBridgeOptions) {
    this.#broadcaster = options.broadcaster;
    this.#registry = options.registry;
    this.#clock = options.clock;
    this.#warningThresholdMs = options.warningThresholdMs ?? 0;
  }

  #emitStateMessage(
    state: SessionState,
    expiresAt: string,
    connection: WsConnection,
    applyExpiry: ApplyExpiry,
    terminateSession: TerminateSession,
  ): void {
    switch (state) {
      case 'active':
        applyExpiry(expiresAt);
        return;
      case 'expiring-soon':
        connection.send({ type: 'session-expiring-soon', expiresAt });
        applyExpiry(expiresAt);
        return;
      case 'daemon-unreachable':
        connection.send({ type: 'daemon-unavailable' });
        applyExpiry(expiresAt);
        return;
      case 'expired':
      case 'invalidated':
      case 'logged-out':
        terminateSession(state);
        break;
    }
  }

  #handleStateChange(
    event: SessionStateChangeEvent,
    connection: WsConnection,
    applyExpiry: ApplyExpiry,
    terminateSession: TerminateSession,
  ): void {
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
  }

  bindSession(session: StoredSession, connection: WsConnection): () => void {
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let warningTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (expiryTimer != null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      if (warningTimer != null) {
        clearTimeout(warningTimer);
        warningTimer = null;
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

    const applyExpiry: ApplyExpiry = (expiresAt?: string) => {
      clearTimers();
      if (expiresAt == null) {
        return 'none';
      }
      if (expiresAt === '') {
        terminateSession('expired', 'Session expired');
        return 'terminated';
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

      // Schedule warning when the warning window is reached
      if (this.#warningThresholdMs > 0) {
        const warningDelayMs = delayMs - this.#warningThresholdMs;
        if (warningDelayMs > 0) {
          warningTimer = setTimeout(() => {
            connection.send({ type: 'session-expiring-soon', expiresAt });
          }, warningDelayMs);
        } else {
          // Already inside the warning window (e.g. rebind/recovery) — emit immediately
          connection.send({ type: 'session-expiring-soon', expiresAt });
        }
      }

      expiryTimer = setTimeout(() => {
        terminateSession('expired', 'Session expired');
      }, delayMs);
      return 'scheduled';
    };

    const callback = (event: SessionStateChangeEvent) => {
      this.#handleStateChange(event, connection, applyExpiry, terminateSession);
    };

    this.#broadcaster.register(session.id, callback);
    this.#emitStateMessage(
      session.state,
      session.expiresAt,
      connection,
      applyExpiry,
      terminateSession,
    );

    return () => {
      clearTimers();
      this.#broadcaster.unregister(session.id, callback);
    };
  }
}
