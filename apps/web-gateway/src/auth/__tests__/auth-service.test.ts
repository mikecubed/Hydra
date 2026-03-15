import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../auth-service.ts';
import { OperatorStore } from '../operator-store.ts';
import { RateLimiter } from '../rate-limiter.ts';
import { SessionService } from '../../session/session-service.ts';
import { SessionStore } from '../../session/session-store.ts';
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
});
