import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../auth-service.ts';
import { OperatorStore } from '../operator-store.ts';
import { RateLimiter } from '../rate-limiter.ts';
import { SessionService } from '../../session/session-service.ts';
import { SessionStore } from '../../session/session-store.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { AuditStore } from '../../audit/audit-store.ts';
import { FakeClock } from '../../shared/clock.ts';

describe('AuthService', () => {
  let operatorStore: OperatorStore;
  let rateLimiter: RateLimiter;
  let sessionService: SessionService;
  let authService: AuthService;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    operatorStore = new OperatorStore(null);
    rateLimiter = new RateLimiter(clock);
    const sessionStore = new SessionStore(null);
    sessionService = new SessionService(sessionStore, clock);
    authService = new AuthService(operatorStore, rateLimiter, sessionService);

    await operatorStore.createOperator('admin', 'Admin');
    await operatorStore.addCredential('admin', 'correct-password');
  });

  it('valid login returns AuthResult', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    assert.equal(result.operator.id, 'admin');
    assert.equal(result.session.state, 'active');
    assert.ok(result.session.id.length > 0);
  });

  it('invalid identity returns generic error', async () => {
    await assert.rejects(() => authService.authenticate('unknown', 'any', '127.0.0.1'), {
      message: /credentials/i,
    });
  });

  it('invalid secret returns same generic error', async () => {
    await assert.rejects(() => authService.authenticate('admin', 'wrong', '127.0.0.1'), {
      message: /credentials/i,
    });
  });

  it('disabled operator rejected', async () => {
    await operatorStore.disableOperator('admin');
    await assert.rejects(() => authService.authenticate('admin', 'correct-password', '127.0.0.1'), {
      message: /disabled/i,
    });
  });

  it('rate-limited source rejected', async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await authService.authenticate('admin', 'wrong', '127.0.0.1');
      } catch {
        // expected
      }
    }
    await assert.rejects(() => authService.authenticate('admin', 'correct-password', '127.0.0.1'), {
      message: /too many/i,
    });
  });

  it('no sessionId in LoginResponse body', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    // The session.id exists internally, but the public LoginResponse contract has no sessionId
    const response = {
      operatorId: result.operator.id,
      expiresAt: result.session.expiresAt,
      state: result.session.state,
    };
    assert.equal('sessionId' in response, false);
  });

  it('reauthenticate rejects active (non-idle) session', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    // Session is fresh — not idle at all
    await assert.rejects(
      () => authService.reauthenticate('admin', 'correct-password', '127.0.0.1', result.session.id),
      { message: /idle/i },
    );
  });

  it('reauthenticate succeeds for idle session', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    // Advance past idle timeout (default 30 min)
    clock.advance(30 * 60 * 1000 + 1);
    const session = await authService.reauthenticate(
      'admin',
      'correct-password',
      '127.0.0.1',
      result.session.id,
    );
    assert.equal(session.id, result.session.id);
  });

  it('reauthenticate rejects expired session', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    // Advance past session lifetime (8h default) — session is both expired and idle
    clock.advance(8 * 60 * 60 * 1000 + 1);
    await assert.rejects(
      () => authService.reauthenticate('admin', 'correct-password', '127.0.0.1', result.session.id),
      { message: /expired/i },
    );
  });

  it('reauthenticate rejects logged-out session', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    await sessionService.logout(result.session.id);
    // Advance past idle timeout so it would be "idle" if still valid
    clock.advance(30 * 60 * 1000 + 1);
    await assert.rejects(
      () => authService.reauthenticate('admin', 'correct-password', '127.0.0.1', result.session.id),
      { message: /session/i },
    );
  });

  it('reauthenticate rejects invalidated session', async () => {
    const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
    await sessionService.invalidate(result.session.id, 'admin-action');
    // Advance past idle timeout so it would be "idle" if still valid
    clock.advance(30 * 60 * 1000 + 1);
    await assert.rejects(
      () => authService.reauthenticate('admin', 'correct-password', '127.0.0.1', result.session.id),
      { message: /invalidated/i },
    );
  });

  it('reauthenticate does not emit idle-reauth audit for non-idle session', async () => {
    const auditStore = new (await import('../../audit/audit-store.ts')).AuditStore(null);
    const auditSvc = new (await import('../../audit/audit-service.ts')).AuditService(
      auditStore,
      clock,
    );
    const authedService = new AuthService(operatorStore, rateLimiter, sessionService, auditSvc);

    const result = await authedService.authenticate('admin', 'correct-password', '127.0.0.1');
    try {
      await authedService.reauthenticate(
        'admin',
        'correct-password',
        '127.0.0.1',
        result.session.id,
      );
    } catch {
      // expected rejection for active session
    }

    const records = auditSvc.getRecords();
    const idleReauthEvents = records.filter((r) => r.eventType === 'session.idle-reauth');
    assert.equal(idleReauthEvents.length, 0, 'should not emit idle-reauth for active session');
  });

  describe('multi-credential operators', () => {
    it('authenticate succeeds with second credential', async () => {
      // Add a second credential to the same operator
      await operatorStore.addCredential('admin', 'second-password');

      // Login with the second credential
      const result = await authService.authenticate('admin', 'second-password', '127.0.0.1');
      assert.equal(result.operator.id, 'admin');
      assert.equal(result.session.state, 'active');
    });

    it('authenticate updates lastUsedAt only on the matching credential', async () => {
      const cred2 = await operatorStore.addCredential('admin', 'second-password');

      await authService.authenticate('admin', 'second-password', '127.0.0.1');

      const operator = operatorStore.getOperator('admin')!;
      const firstCred = operator.credentials[0];
      const secondCred = operator.credentials.find((c) => c.id === cred2.id)!;

      assert.equal(firstCred.lastUsedAt, null, 'first credential should not be touched');
      assert.ok(secondCred.lastUsedAt, 'second credential should have lastUsedAt set');
    });

    it('authenticate rejects when no credential matches', async () => {
      await operatorStore.addCredential('admin', 'second-password');

      await assert.rejects(
        () => authService.authenticate('admin', 'neither-password', '127.0.0.1'),
        { message: /credentials/i },
      );
    });

    it('authenticate skips revoked credentials', async () => {
      const operator = operatorStore.getOperator('admin')!;
      // Revoke the first credential
      operator.credentials[0].isRevoked = true;

      // Add a fresh second credential
      await operatorStore.addCredential('admin', 'new-password');

      // Old credential rejected
      await assert.rejects(
        () => authService.authenticate('admin', 'correct-password', '127.0.0.1'),
        { message: /credentials/i },
      );

      // New credential accepted
      const result = await authService.authenticate('admin', 'new-password', '127.0.0.1');
      assert.equal(result.operator.id, 'admin');
    });

    it('reauthenticate succeeds with second credential', async () => {
      await operatorStore.addCredential('admin', 'second-password');

      // Login with first credential
      const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
      // Advance past idle timeout
      clock.advance(30 * 60 * 1000 + 1);

      // Reauth with second credential
      const session = await authService.reauthenticate(
        'admin',
        'second-password',
        '127.0.0.1',
        result.session.id,
      );
      assert.equal(session.id, result.session.id);
    });

    it('reauthenticate updates lastUsedAt only on the matching credential', async () => {
      const cred2 = await operatorStore.addCredential('admin', 'second-password');

      const result = await authService.authenticate('admin', 'correct-password', '127.0.0.1');
      clock.advance(30 * 60 * 1000 + 1);

      // Clear lastUsedAt from the login to isolate the reauth update
      const operator = operatorStore.getOperator('admin')!;
      for (const c of operator.credentials) c.lastUsedAt = null;

      await authService.reauthenticate('admin', 'second-password', '127.0.0.1', result.session.id);

      const firstCred = operator.credentials[0];
      const secondCred = operator.credentials.find((c) => c.id === cred2.id)!;
      assert.equal(firstCred.lastUsedAt, null, 'first credential should not be touched by reauth');
      assert.ok(secondCred.lastUsedAt, 'second credential should have lastUsedAt set by reauth');
    });
  });

  describe('reauthenticate rate-limiting and failure auditing', () => {
    let auditService: AuditService;
    let authedService: AuthService;
    let rateLimiterForReauth: RateLimiter;

    beforeEach(async () => {
      const auditStore = new AuditStore(null);
      auditService = new AuditService(auditStore, clock);
      rateLimiterForReauth = new RateLimiter(clock, {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 300_000,
      });
      const sessionStore = new SessionStore(null);
      const sessionSvc = new SessionService(sessionStore, clock);
      authedService = new AuthService(
        operatorStore,
        rateLimiterForReauth,
        sessionSvc,
        auditService,
      );
    });

    async function loginAndMakeIdle(): Promise<string> {
      const result = await authedService.authenticate('admin', 'correct-password', '10.0.0.1');
      clock.advance(30 * 60 * 1000 + 1); // past idle timeout
      return result.session.id;
    }

    it('repeated wrong reauth attempts trigger lockout', async () => {
      const sessionId = await loginAndMakeIdle();

      for (let i = 0; i < 3; i++) {
        await assert.rejects(
          () => authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId),
          { message: /credentials/i },
        );
      }

      // Next attempt should be rate-limited, not credential-checked
      await assert.rejects(
        () => authedService.reauthenticate('admin', 'correct-password', '10.0.0.1', sessionId),
        { message: /too many/i },
      );
    });

    it('wrong reauth emits auth.attempt.failure audit events', async () => {
      const sessionId = await loginAndMakeIdle();

      await assert.rejects(
        () => authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId),
        { message: /credentials/i },
      );

      const records = auditService.getRecords();
      const failures = records.filter(
        (r) => r.eventType === 'auth.attempt.failure' && r.detail['context'] === 'reauth',
      );
      assert.equal(failures.length, 1, 'should emit failure audit for wrong reauth');
      assert.equal(failures[0].sessionId, sessionId);
    });

    it('rate-limited reauth emits auth.rate-limited audit event', async () => {
      const sessionId = await loginAndMakeIdle();

      // Exhaust attempts
      for (let i = 0; i < 3; i++) {
        try {
          await authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId);
        } catch {
          /* expected */
        }
      }

      // Trigger rate limit
      await assert.rejects(
        () => authedService.reauthenticate('admin', 'correct-password', '10.0.0.1', sessionId),
        { message: /too many/i },
      );

      const records = auditService.getRecords();
      const rateLimited = records.filter(
        (r) => r.eventType === 'auth.rate-limited' && r.detail['context'] === 'reauth',
      );
      assert.equal(rateLimited.length, 1, 'should emit rate-limited audit for reauth');
      assert.equal(rateLimited[0].sessionId, sessionId);
    });

    it('successful reauth resets rate limiter', async () => {
      const sessionId = await loginAndMakeIdle();

      // Use 2 of 3 allowed attempts
      for (let i = 0; i < 2; i++) {
        try {
          await authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId);
        } catch {
          /* expected */
        }
      }

      // Successful reauth should reset the counter
      await authedService.reauthenticate('admin', 'correct-password', '10.0.0.1', sessionId);

      // Re-idle the session
      clock.advance(30 * 60 * 1000 + 1);

      // Should have full 3 attempts again (not locked out after 1 more failure)
      await assert.rejects(
        () => authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId),
        { message: /credentials/i },
      );
      await assert.rejects(
        () => authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId),
        { message: /credentials/i },
      );
      // 2 more failures accepted — still not locked out; third would lock
      await assert.rejects(
        () => authedService.reauthenticate('admin', 'wrong', '10.0.0.1', sessionId),
        { message: /credentials/i },
      );
      await assert.rejects(
        () => authedService.reauthenticate('admin', 'correct-password', '10.0.0.1', sessionId),
        { message: /too many/i },
      );
    });
  });
});
