/**
 * E2E integration test — full auth lifecycle.
 *
 * unauthenticated → login → cookie set → session info → extend →
 * access continues → logout → cookie cleared → old cookie rejected
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OperatorStore } from '../auth/operator-store.ts';
import { RateLimiter } from '../auth/rate-limiter.ts';
import { AuthService } from '../auth/auth-service.ts';
import { SessionService } from '../session/session-service.ts';
import { SessionStore } from '../session/session-store.ts';
import { AuditService } from '../audit/audit-service.ts';
import { AuditStore } from '../audit/audit-store.ts';
import { FakeClock } from '../shared/clock.ts';

describe('E2E: Auth lifecycle', () => {
  let operatorStore: OperatorStore;
  let sessionService: SessionService;
  let authService: AuthService;
  let auditService: AuditService;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    operatorStore = new OperatorStore(null);
    const rateLimiter = new RateLimiter(clock);
    const sessionStore = new SessionStore(null);
    sessionService = new SessionService(sessionStore, clock, {
      sessionLifetimeMs: 3600_000,
      warningThresholdMs: 600_000,
      maxExtensions: 3,
      extensionDurationMs: 3600_000,
      maxConcurrentSessions: 5,
      idleTimeoutMs: 1800_000,
    });
    authService = new AuthService(operatorStore, rateLimiter, sessionService);
    auditService = new AuditService(new AuditStore(null), clock);

    await operatorStore.createOperator('admin', 'Admin');
    await operatorStore.addCredential('admin', 'password123');
  });

  it('full lifecycle: login → extend → logout → reject old cookie', async () => {
    // 1. Login
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    assert.equal(result.session.state, 'active');
    const sessionId = result.session.id;
    const csrfToken = result.session.csrfToken;
    assert.ok(sessionId);
    assert.ok(csrfToken);

    await auditService.record('auth.attempt.success', 'admin', sessionId, {}, 'success');

    // 2. Session is valid
    const validated = sessionService.validate(sessionId);
    assert.equal(validated.state, 'active');

    // 3. Move time to expiring-soon
    clock.advance(3000_000);
    const expiring = sessionService.validate(sessionId);
    assert.equal(expiring.state, 'expiring-soon');

    // 4. Extend
    const extended = sessionService.extend(sessionId);
    assert.equal(extended.state, 'active');
    assert.equal(extended.extendedCount, 1);
    await auditService.record('session.extended', 'admin', sessionId, {}, 'success');

    // 5. Logout
    sessionService.logout(sessionId);
    await auditService.record('session.logged-out', 'admin', sessionId, {}, 'success');

    // 6. Old session rejected
    assert.throws(() => sessionService.validate(sessionId));

    // 7. Re-login works
    const result2 = await authService.authenticate('admin', 'password123', '127.0.0.1');
    assert.equal(result2.session.state, 'active');
    assert.notEqual(result2.session.id, sessionId);

    // 8. Audit trail
    const records = auditService.getRecords();
    assert.equal(records.length, 3);
  });

  it('idle timeout → reauth → same session resumes', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const sessionId = result.session.id;

    // Advance past idle timeout
    clock.advance(1800_001);
    const session = sessionService.store.get(sessionId)!;
    assert.equal(sessionService.isIdle(session), true);

    // Reauth with valid credentials resumes same session
    const resumed = await authService.reauthenticate(
      'admin',
      'password123',
      '127.0.0.1',
      sessionId,
    );
    assert.equal(resumed.id, sessionId);
    // After reauth, idle timer reset
    const updatedSession = sessionService.store.get(sessionId)!;
    assert.equal(sessionService.isIdle(updatedSession), false);
  });

  it('rate limiting: 5 bad logins → locked → lockout expires → login succeeds', async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await authService.authenticate('admin', 'wrong', '127.0.0.1');
      } catch {
        // expected
      }
    }

    // Rate limited
    await assert.rejects(() => authService.authenticate('admin', 'password123', '127.0.0.1'));

    // Wait for lockout to expire
    clock.advance(300_001);

    // Login succeeds
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    assert.equal(result.session.state, 'active');
  });
});
