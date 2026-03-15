/**
 * Session service — lifecycle management: create, validate, extend,
 * expire, invalidate, logout. Uses FSM for all state transitions.
 */
import type { Clock } from '../shared/clock.ts';
import { SystemClock } from '../shared/clock.ts';
import { type SessionStore, type StoredSession } from './session-store.ts';
import { transition, isTerminal } from './session-state-machine.ts';
import { createError } from '../shared/errors.ts';

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

export class SessionService {
  readonly store: SessionStore;
  private readonly clock: Clock;
  readonly config: SessionServiceConfig;

  constructor(
    store: SessionStore,
    clock: Clock = new SystemClock(),
    config: Partial<SessionServiceConfig> = {},
  ) {
    this.store = store;
    this.clock = clock;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  create(operatorId: string, sourceIp: string): StoredSession {
    // Enforce concurrent session limit (FR-017)
    const active = this.store.listByOperator(operatorId).filter((s) => !isTerminal(s.state));
    if (active.length >= this.config.maxConcurrentSessions) {
      // Invalidate oldest
      const oldest = active.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )[0];
      this.transitionSession(oldest.id, 'invalidate', 'concurrent-session-limit');
    }

    const expiresAt = new Date(this.clock.now() + this.config.sessionLifetimeMs).toISOString();
    const now = new Date(this.clock.now()).toISOString();
    return this.store.create(operatorId, expiresAt, sourceIp, now);
  }

  validate(sessionId: string): StoredSession {
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
      this.transitionSession(sessionId, 'expire');
      throw createError('SESSION_EXPIRED');
    }

    // Check expiring-soon threshold
    const remaining = new Date(session.expiresAt).getTime() - now;
    if (remaining <= this.config.warningThresholdMs && session.state === 'active') {
      this.transitionSession(sessionId, 'warn-expiry');
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

  extend(sessionId: string): StoredSession {
    const session = this.store.get(sessionId);
    if (!session) throw createError('SESSION_NOT_FOUND');

    if (session.extendedCount >= this.config.maxExtensions) {
      throw createError('SESSION_EXPIRED', 'Maximum session extensions reached');
    }

    const result = transition(session.state, 'extend');
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
    return updated;
  }

  logout(sessionId: string): void {
    this.transitionSession(sessionId, 'logout');
  }

  invalidate(sessionId: string, reason: string): void {
    this.transitionSession(sessionId, 'invalidate', reason);
  }

  invalidateAllForOperator(operatorId: string, reason: string): void {
    const sessions = this.store.listByOperator(operatorId).filter((s) => !isTerminal(s.state));
    for (const s of sessions) {
      this.transitionSession(s.id, 'invalidate', reason);
    }
  }

  markDaemonDown(sessionId: string): void {
    this.transitionSession(sessionId, 'daemon-down');
  }

  markDaemonUp(sessionId: string): void {
    this.transitionSession(sessionId, 'daemon-up');
  }

  private transitionSession(
    sessionId: string,
    trigger: Parameters<typeof transition>[1],
    reason?: string,
  ): void {
    const session = this.store.get(sessionId);
    if (session == null) return;
    const result = transition(session.state, trigger);
    if (!result.ok) return; // silently ignore invalid transitions
    const updates: Partial<StoredSession> = { state: result.newState };
    if (reason != null && result.newState === 'invalidated') {
      updates.invalidatedReason = reason;
    }
    this.store.update(sessionId, updates);
  }
}
