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

export interface AuthResult {
  operator: StoredOperator;
  session: StoredSession;
}

export class AuthService {
  private readonly operatorStore: OperatorStore;
  private readonly rateLimiter: RateLimiter;
  private readonly sessionService: SessionService;

  constructor(
    operatorStore: OperatorStore,
    rateLimiter: RateLimiter,
    sessionService: SessionService,
  ) {
    this.operatorStore = operatorStore;
    this.rateLimiter = rateLimiter;
    this.sessionService = sessionService;
  }

  async authenticate(identity: string, secret: string, sourceKey: string): Promise<AuthResult> {
    // Rate limit check (FR-003)
    if (!this.rateLimiter.check(sourceKey)) {
      throw createError('RATE_LIMITED');
    }

    // Look up operator — generic error for both identity and secret failures (FR-002)
    const operator = this.operatorStore.getOperatorByIdentity(identity);
    if (!operator) {
      this.rateLimiter.recordFailure(sourceKey);
      throw createError('INVALID_CREDENTIALS');
    }

    if (!operator.isActive) {
      this.rateLimiter.recordFailure(sourceKey);
      throw createError('ACCOUNT_DISABLED');
    }

    // Verify credential
    const cred = operator.credentials.find((c) => !c.isRevoked);
    if (!cred) {
      this.rateLimiter.recordFailure(sourceKey);
      throw createError('INVALID_CREDENTIALS');
    }

    const valid = await verifySecret(secret, cred.hashedSecret, cred.salt);
    if (!valid) {
      this.rateLimiter.recordFailure(sourceKey);
      throw createError('INVALID_CREDENTIALS');
    }

    // Update lastUsedAt
    cred.lastUsedAt = new Date().toISOString();

    // Create session
    const session = this.sessionService.create(operator.id, sourceKey);

    // Reset rate limiter on success
    this.rateLimiter.reset(sourceKey);

    return { operator, session };
  }

  async reauthenticate(
    identity: string,
    secret: string,
    _sourceKey: string,
    sessionId: string,
  ): Promise<StoredSession> {
    // Validate the session exists and belongs to this operator
    const session = this.sessionService.store.get(sessionId);
    if (!session) throw createError('SESSION_NOT_FOUND');

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

    return session;
  }
}
