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

    // Verify credential
    const cred = operator.credentials.find((c) => !c.isRevoked);
    if (!cred) {
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

    const valid = await verifySecret(secret, cred.hashedSecret, cred.salt);
    if (!valid) {
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

    // Update lastUsedAt
    cred.lastUsedAt = new Date().toISOString();

    // Create session
    const session = await this.sessionService.create(operator.id, sourceKey);

    // Reset rate limiter on success
    this.rateLimiter.reset(sourceKey);

    await this.auditService?.record(
      'auth.attempt.success',
      operator.id,
      session.id,
      {},
      'success',
      sourceKey,
    );

    return { operator, session };
  }

  async reauthenticate(
    identity: string,
    secret: string,
    _sourceKey: string,
    sessionId: string,
  ): Promise<StoredSession> {
    // Validate the session is non-terminal and non-expired (FR-009)
    const session = await this.sessionService.validate(sessionId);

    // Re-authentication is only valid for idle sessions (FR-009)
    if (!this.sessionService.isIdle(session)) {
      throw createError('SESSION_NOT_IDLE');
    }

    const operator = this.operatorStore.getOperatorByIdentity(identity);
    if (operator?.id !== session.operatorId) {
      throw createError('INVALID_CREDENTIALS');
    }

    if (!operator.isActive) throw createError('ACCOUNT_DISABLED');

    const cred = operator.credentials.find((c) => !c.isRevoked);
    if (!cred) throw createError('INVALID_CREDENTIALS');

    const valid = await verifySecret(secret, cred.hashedSecret, cred.salt);
    if (!valid) throw createError('INVALID_CREDENTIALS');

    // Reset idle timer on successful re-auth
    this.sessionService.touchActivity(sessionId);

    await this.auditService?.record(
      'session.idle-reauth',
      operator.id,
      sessionId,
      {},
      'success',
      _sourceKey,
    );

    return session;
  }
}
