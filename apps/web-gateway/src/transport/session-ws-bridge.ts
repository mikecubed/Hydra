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
type ApplyExpiry = (expiresAt?: string, emitImmediateWarning?: boolean) => ExpiryOutcome;
type SendExpiringSoon = (expiresAt: string) => void;

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

  #clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer != null) {
      clearTimeout(timer);
    }
    return null;
  }

  #closeSessionConnections(sessionId: string): void {
    setTimeout(() => {
      this.#registry.closeAllForSession(sessionId);
    }, 0);
  }

  #emitStateMessage(
    state: SessionState,
    expiresAt: string,
    connection: WsConnection,
    sendExpiringSoon: SendExpiringSoon,
    applyExpiry: ApplyExpiry,
    terminateSession: TerminateSession,
  ): void {
    switch (state) {
      case 'active':
        applyExpiry(expiresAt, true);
        return;
      case 'expiring-soon':
        sendExpiringSoon(expiresAt);
        applyExpiry(expiresAt);
        return;
      case 'daemon-unreachable':
        connection.send({ type: 'daemon-unavailable' });
        applyExpiry(expiresAt, true);
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
    sendExpiringSoon: SendExpiringSoon,
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
          sendExpiringSoon(event.expiresAt);
          applyExpiry(event.expiresAt);
        }
        return;
      case 'daemon-unreachable':
        connection.send({ type: 'daemon-unavailable' });
        applyExpiry(event.expiresAt, true);
        return;
      case 'active': {
        if (event.expiresAt != null) {
          connection.send({ type: 'session-active', expiresAt: event.expiresAt });
        }
        const expiryResult = applyExpiry(event.expiresAt, true);
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
    let lastWarnedExpiresAt: string | null = null;

    const clearTimers = () => {
      expiryTimer = this.#clearTimer(expiryTimer);
      warningTimer = this.#clearTimer(warningTimer);
    };

    const terminateSession = (state: 'expired' | 'invalidated' | 'logged-out', reason?: string) => {
      connection.send({
        type: 'session-terminated',
        state,
        ...(reason === undefined ? {} : { reason }),
      });
      this.#closeSessionConnections(session.id);
    };

    const sendExpiringSoon: SendExpiringSoon = (expiresAt) => {
      if (lastWarnedExpiresAt === expiresAt) {
        return;
      }
      lastWarnedExpiresAt = expiresAt;
      connection.send({ type: 'session-expiring-soon', expiresAt });
    };

    const applyExpiry: ApplyExpiry = (expiresAt?: string, emitImmediateWarning = false) => {
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
            sendExpiringSoon(expiresAt);
          }, warningDelayMs);
        } else if (emitImmediateWarning) {
          sendExpiringSoon(expiresAt);
        }
      }

      expiryTimer = setTimeout(() => {
        terminateSession('expired', 'Session expired');
      }, delayMs);
      return 'scheduled';
    };

    const callback = (event: SessionStateChangeEvent) => {
      this.#handleStateChange(event, connection, sendExpiringSoon, applyExpiry, terminateSession);
    };

    this.#broadcaster.register(session.id, callback);
    this.#emitStateMessage(
      session.state,
      session.expiresAt,
      connection,
      sendExpiringSoon,
      applyExpiry,
      terminateSession,
    );

    return () => {
      clearTimers();
      this.#broadcaster.unregister(session.id, callback);
    };
  }
}
