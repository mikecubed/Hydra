/**
 * Session service — lifecycle management: create, validate, extend,
 * expire, invalidate, logout. Uses FSM for all state transitions.
 */
import type { Clock } from '../shared/clock.ts';
import { SystemClock } from '../shared/clock.ts';
import { type SessionStore, type StoredSession } from './session-store.ts';
import { transition, isTerminal } from './session-state-machine.ts';
import { createError } from '../shared/errors.ts';
import type { AuditService } from '../audit/audit-service.ts';

export interface SessionServiceConfig {
  sessionLifetimeMs: number;
  warningThresholdMs: number;
  maxExtensions: number;
  extensionDurationMs: number;
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
}

const DEFAULT_CONFIG: SessionServiceConfig = {
  sessionLifetimeMs: 8 * 60 * 60 * 1000, // 8 hours
  warningThresholdMs: 15 * 60 * 1000, // 15 minutes
  maxExtensions: 3,
  extensionDurationMs: 8 * 60 * 60 * 1000,
  maxConcurrentSessions: 5,
  idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
};

/** Maps FSM triggers to audit event types. */
const TRIGGER_TO_AUDIT: Record<string, string> = {
  expire: 'session.expired',
  invalidate: 'session.invalidated',
  logout: 'session.logged-out',
  'daemon-down': 'session.daemon-unreachable',
  'daemon-up': 'session.daemon-restored',
};

export class SessionService {
  readonly store: SessionStore;
  private readonly clock: Clock;
  readonly config: SessionServiceConfig;
  private readonly auditService?: AuditService;

  constructor(
    store: SessionStore,
    clock: Clock = new SystemClock(),
    config: Partial<SessionServiceConfig> = {},
    auditService?: AuditService,
  ) {
    this.store = store;
    this.clock = clock;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.auditService = auditService;
  }

  async create(operatorId: string, sourceIp: string): Promise<StoredSession> {
    // Enforce concurrent session limit (FR-017)
    const active = this.store.listByOperator(operatorId).filter((s) => !isTerminal(s.state));
    if (active.length >= this.config.maxConcurrentSessions) {
      // Invalidate oldest
      const oldest = active.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )[0];
      await this.transitionSession(oldest.id, 'invalidate', 'concurrent-session-limit');
    }

    const expiresAt = new Date(this.clock.now() + this.config.sessionLifetimeMs).toISOString();
    const now = new Date(this.clock.now()).toISOString();
    const session = this.store.create(operatorId, expiresAt, sourceIp, now);

    try {
      await this.auditService?.record(
        'session.created',
        operatorId,
        session.id,
        { sourceIp },
        'success',
      );
    } catch (err) {
      // Rollback: remove the session so no live session exists without audit
      this.store.delete(session.id);
      throw err;
    }

    return session;
  }

  async validate(sessionId: string): Promise<StoredSession> {
    const session = this.store.get(sessionId);
    if (!session) throw createError('SESSION_NOT_FOUND');

    if (isTerminal(session.state)) {
      if (session.state === 'expired') throw createError('SESSION_EXPIRED');
      if (session.state === 'invalidated') throw createError('SESSION_INVALIDATED');
      throw createError('SESSION_NOT_FOUND');
    }

    // Check absolute expiry
    const now = this.clock.now();
    if (now >= new Date(session.expiresAt).getTime()) {
      await this.transitionSession(sessionId, 'expire');
      throw createError('SESSION_EXPIRED');
    }

    // Check expiring-soon threshold
    const remaining = new Date(session.expiresAt).getTime() - now;
    if (remaining <= this.config.warningThresholdMs && session.state === 'active') {
      await this.transitionSession(sessionId, 'warn-expiry');
    }

    return session;
  }

  /** Check idle timeout. Returns true if session is idle. */
  isIdle(session: StoredSession): boolean {
    const now = this.clock.now();
    const lastActivity = new Date(session.lastActivityAt).getTime();
    if (Number.isNaN(lastActivity)) return true; // Invalid timestamp, consider idle
    return now - lastActivity > this.config.idleTimeoutMs;
  }

  touchActivity(sessionId: string): void {
    this.store.update(sessionId, { lastActivityAt: new Date(this.clock.now()).toISOString() });
  }

  /** Whether a session is within the extension-eligible time window. */
  isInExtensionWindow(session: StoredSession): boolean {
    const now = this.clock.now();
    const expiresAtMs = new Date(session.expiresAt).getTime();
    if (now >= expiresAtMs) return false; // already expired
    const remaining = expiresAtMs - now;
    return remaining <= this.config.warningThresholdMs;
  }

  async extend(sessionId: string): Promise<StoredSession> {
    const session = this.store.get(sessionId);
    if (!session) throw createError('SESSION_NOT_FOUND');

    if (isTerminal(session.state)) {
      throw createError('SESSION_EXPIRED', `Cannot extend session in '${session.state}' state`);
    }

    if (session.extendedCount >= this.config.maxExtensions) {
      throw createError('SESSION_EXPIRED', 'Maximum session extensions reached');
    }

    // Check time-based eligibility — the extension window is the source of
    // truth, not whether a prior validate() happened to flip the FSM state.
    if (!this.isInExtensionWindow(session)) {
      throw createError('SESSION_EXPIRED', 'Session is not within the extension window');
    }

    // Snapshot pre-mutation state for rollback (must be captured before any
    // store mutations, since store.update mutates the object in place).
    const snapshot = {
      state: session.state,
      expiresAt: session.expiresAt,
      extendedCount: session.extendedCount,
      lastActivityAt: session.lastActivityAt,
    };

    // If the session is still 'active' but within the window, auto-transition
    // to 'expiring-soon' so the FSM extend transition is valid.
    let currentState = session.state;
    if (currentState === 'active') {
      const warnResult = transition(currentState, 'warn-expiry');
      if (warnResult.ok) {
        this.store.update(sessionId, { state: warnResult.newState });
        currentState = warnResult.newState;
      }
    }

    const result = transition(currentState, 'extend');
    if (!result.ok) {
      throw createError('SESSION_EXPIRED', result.error);
    }

    const newExpiresAt = new Date(this.clock.now() + this.config.extensionDurationMs).toISOString();
    const updated = this.store.update(sessionId, {
      state: result.newState,
      expiresAt: newExpiresAt,
      extendedCount: session.extendedCount + 1,
      lastActivityAt: new Date(this.clock.now()).toISOString(),
    });
    if (!updated) throw createError('SESSION_NOT_FOUND');

    try {
      await this.auditService?.record(
        'session.extended',
        session.operatorId,
        sessionId,
        { extendedCount: session.extendedCount + 1 },
        'success',
      );
    } catch (err) {
      // Rollback to pre-mutation state
      this.store.update(sessionId, snapshot);
      throw err;
    }

    return updated;
  }

  async logout(sessionId: string): Promise<void> {
    await this.transitionSession(sessionId, 'logout');
  }

  async invalidate(sessionId: string, reason: string): Promise<void> {
    await this.transitionSession(sessionId, 'invalidate', reason);
  }

  async invalidateAllForOperator(operatorId: string, reason: string): Promise<void> {
    const sessions = this.store.listByOperator(operatorId).filter((s) => !isTerminal(s.state));
    for (const s of sessions) {
      await this.transitionSession(s.id, 'invalidate', reason);
    }
  }

  async markDaemonDown(sessionId: string): Promise<void> {
    await this.transitionSession(sessionId, 'daemon-down');
  }

  async markDaemonUp(sessionId: string): Promise<void> {
    await this.transitionSession(sessionId, 'daemon-up');
  }

  private async transitionSession(
    sessionId: string,
    trigger: Parameters<typeof transition>[1],
    reason?: string,
  ): Promise<void> {
    const session = this.store.get(sessionId);
    if (session == null) return;
    const result = transition(session.state, trigger);
    if (!result.ok) return; // silently ignore invalid transitions

    // Snapshot pre-mutation state for rollback
    const snapshot = {
      state: session.state,
      invalidatedReason: session.invalidatedReason,
    };

    const updates: Partial<StoredSession> = { state: result.newState };
    if (reason != null && result.newState === 'invalidated') {
      updates.invalidatedReason = reason;
    }
    this.store.update(sessionId, updates);

    const eventType = TRIGGER_TO_AUDIT[trigger];
    if (eventType && this.auditService) {
      try {
        await this.auditService.record(
          eventType,
          session.operatorId,
          sessionId,
          reason == null ? {} : { reason },
          'success',
        );
      } catch (err) {
        // Rollback to pre-mutation state
        this.store.update(sessionId, snapshot);
        throw err;
      }
    }
  }
}
