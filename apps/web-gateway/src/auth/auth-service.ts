/**
 * Auth service — authenticate(identity, secret, sourceKey): checks rate limit,
 * looks up operator, verifies credential, creates session. (FR-002, FR-003)
 */
import { verifySecret } from './credential-utils.ts';
import type { OperatorStore, StoredOperator } from './operator-store.ts';
import { type RateLimiter } from './rate-limiter.ts';
import { type SessionService } from '../session/session-service.ts';
import { createError } from '../shared/errors.ts';
import type { StoredSession } from '../session/session-store.ts';
import type { AuditService } from '../audit/audit-service.ts';

export interface AuthResult {
  operator: StoredOperator;
  session: StoredSession;
}

export class AuthService {
  private readonly operatorStore: OperatorStore;
  private readonly rateLimiter: RateLimiter;
  private readonly sessionService: SessionService;
  private readonly auditService?: AuditService;

  constructor(
    operatorStore: OperatorStore,
    rateLimiter: RateLimiter,
    sessionService: SessionService,
    auditService?: AuditService,
  ) {
    this.operatorStore = operatorStore;
    this.rateLimiter = rateLimiter;
    this.sessionService = sessionService;
    this.auditService = auditService;
  }

  async authenticate(identity: string, secret: string, sourceKey: string): Promise<AuthResult> {
    // Rate limit check (FR-003)
    if (!this.rateLimiter.check(sourceKey)) {
      await this.auditService?.record(
        'auth.rate-limited',
        null,
        null,
        { identity },
        'failure',
        sourceKey,
      );
      throw createError('RATE_LIMITED');
    }

    // Look up operator — generic error for both identity and secret failures (FR-002)
    const operator = this.operatorStore.getOperatorByIdentity(identity);
    if (!operator) {
      this.rateLimiter.recordFailure(sourceKey);
      await this.auditService?.record(
        'auth.attempt.failure',
        null,
        null,
        { identity },
        'failure',
        sourceKey,
      );
      throw createError('INVALID_CREDENTIALS');
    }

    if (!operator.isActive) {
      this.rateLimiter.recordFailure(sourceKey);
      await this.auditService?.record(
        'auth.attempt.failure',
        operator.id,
        null,
        { identity, reason: 'account_disabled' },
        'failure',
        sourceKey,
      );
      throw createError('ACCOUNT_DISABLED');
    }

    // Verify credential — try all non-revoked credentials (supports credential rotation)
    const matchedCred = await this.findMatchingCredential(operator, secret);
    if (!matchedCred) {
      this.rateLimiter.recordFailure(sourceKey);
      await this.auditService?.record(
        'auth.attempt.failure',
        operator.id,
        null,
        { identity },
        'failure',
        sourceKey,
      );
      throw createError('INVALID_CREDENTIALS');
    }

    // Update lastUsedAt only on the matching credential
    matchedCred.lastUsedAt = new Date().toISOString();

    // Create session — must be rolled back if success audit fails
    const session = await this.sessionService.create(operator.id, sourceKey);

    // Reset rate limiter on success
    this.rateLimiter.reset(sourceKey);

    try {
      await this.auditService?.record(
        'auth.attempt.success',
        operator.id,
        session.id,
        {},
        'success',
        sourceKey,
      );
    } catch (err) {
      // Rollback: destroy the session so no orphaned auth state exists
      this.sessionService.store.delete(session.id);
      throw err;
    }

    return { operator, session };
  }

  async reauthenticate(
    identity: string,
    secret: string,
    sourceKey: string,
    sessionId: string,
  ): Promise<StoredSession> {
    // Validate the session is non-terminal and non-expired (FR-009)
    const session = await this.sessionService.validate(sessionId);

    // Re-authentication is only valid for idle sessions (FR-009)
    if (!this.sessionService.isIdle(session)) {
      throw createError('SESSION_NOT_IDLE');
    }

    // Rate limit check — same brute-force protection as authenticate() (FR-003)
    if (!this.rateLimiter.check(sourceKey)) {
      await this.auditService?.record(
        'auth.rate-limited',
        null,
        sessionId,
        { identity, context: 'reauth' },
        'failure',
        sourceKey,
      );
      throw createError('RATE_LIMITED');
    }

    const operator = this.operatorStore.getOperatorByIdentity(identity);
    if (operator?.id !== session.operatorId) {
      await this.recordReauthFailure(null, sessionId, identity, sourceKey);
      throw createError('INVALID_CREDENTIALS');
    }

    if (!operator.isActive) {
      await this.recordReauthFailure(
        operator.id,
        sessionId,
        identity,
        sourceKey,
        'account_disabled',
      );
      throw createError('ACCOUNT_DISABLED');
    }

    const matchedCred = await this.findMatchingCredential(operator, secret);
    if (!matchedCred) {
      await this.recordReauthFailure(operator.id, sessionId, identity, sourceKey);
      throw createError('INVALID_CREDENTIALS');
    }

    // Update lastUsedAt only on the matching credential
    matchedCred.lastUsedAt = new Date().toISOString();

    // Reset rate limiter + idle timer on successful re-auth.
    // Snapshot lastActivityAt so we can rollback if the audit write fails.
    this.rateLimiter.reset(sourceKey);
    const previousActivityAt = session.lastActivityAt;
    this.sessionService.touchActivity(sessionId);

    try {
      await this.auditService?.record(
        'session.idle-reauth',
        operator.id,
        sessionId,
        {},
        'success',
        sourceKey,
      );
    } catch (err) {
      // Rollback: restore the previous lastActivityAt so the session stays idle
      this.sessionService.store.update(sessionId, { lastActivityAt: previousActivityAt });
      throw err;
    }

    return session;
  }

  /** Try all non-revoked credentials; return the first match, or undefined. */
  private async findMatchingCredential(
    operator: StoredOperator,
    secret: string,
  ): Promise<StoredOperator['credentials'][number] | undefined> {
    const activeCreds = operator.credentials.filter((c) => !c.isRevoked);
    for (const cred of activeCreds) {
      // eslint-disable-next-line no-await-in-loop -- sequential: stop at first match
      const valid = await verifySecret(secret, cred.hashedSecret, cred.salt);
      if (valid) return cred;
    }
    return undefined;
  }

  private async recordReauthFailure(
    operatorId: string | null,
    sessionId: string,
    identity: string,
    sourceKey: string,
    reason?: string,
  ): Promise<void> {
    this.rateLimiter.recordFailure(sourceKey);
    const detail: Record<string, unknown> = { identity, context: 'reauth' };
    if (reason != null) detail['reason'] = reason;
    await this.auditService?.record(
      'auth.attempt.failure',
      operatorId,
      sessionId,
      detail,
      'failure',
      sourceKey,
    );
  }
}
