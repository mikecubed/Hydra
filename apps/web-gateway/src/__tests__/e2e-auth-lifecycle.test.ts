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
    const auditStore = new AuditStore(null);
    auditService = new AuditService(auditStore, clock);
    sessionService = new SessionService(sessionStore, clock, {
      sessionLifetimeMs: 3600_000,
      warningThresholdMs: 600_000,
      maxExtensions: 3,
      extensionDurationMs: 3600_000,
      maxConcurrentSessions: 5,
      idleTimeoutMs: 1800_000,
    }, auditService);
    authService = new AuthService(operatorStore, rateLimiter, sessionService, auditService);

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

    // 2. Session is valid
    const validated = await sessionService.validate(sessionId);
    assert.equal(validated.state, 'active');

    // 3. Move time to expiring-soon
    clock.advance(3000_000);
    const expiring = await sessionService.validate(sessionId);
    assert.equal(expiring.state, 'expiring-soon');

    // 4. Extend
    const extended = await sessionService.extend(sessionId);
    assert.equal(extended.state, 'active');
    assert.equal(extended.extendedCount, 1);

    // 5. Logout
    await sessionService.logout(sessionId);

    // 6. Old session rejected
    await assert.rejects(() => sessionService.validate(sessionId));

    // 7. Re-login works
    const result2 = await authService.authenticate('admin', 'password123', '127.0.0.1');
    assert.equal(result2.session.state, 'active');
    assert.notEqual(result2.session.id, sessionId);

    // 8. Audit trail — verify automatically emitted records
    const records = auditService.getRecords();
    const types = records.map((r) => r.eventType);
    assert.ok(types.includes('auth.attempt.success'), 'should have login success audit');
    assert.ok(types.includes('session.created'), 'should have session.created audit');
    assert.ok(types.includes('session.extended'), 'should have session.extended audit');
    assert.ok(types.includes('session.logged-out'), 'should have session.logged-out audit');
    // Two logins, two session.created events
    assert.equal(types.filter((t) => t === 'auth.attempt.success').length, 2);
    assert.equal(types.filter((t) => t === 'session.created').length, 2);
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

    // Verify reauth audit event
    const records = auditService.getRecords();
    const types = records.map((r) => r.eventType);
    assert.ok(types.includes('session.idle-reauth'), 'should have session.idle-reauth audit');
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

    // Verify audit trail includes failure and rate-limited events
    const records = auditService.getRecords();
    const types = records.map((r) => r.eventType);
    assert.ok(types.includes('auth.attempt.failure'), 'should have auth failure audit');
    assert.ok(types.includes('auth.rate-limited'), 'should have rate-limited audit');

    // Wait for lockout to expire
    clock.advance(300_001);

    // Login succeeds
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    assert.equal(result.session.state, 'active');
  });
});
