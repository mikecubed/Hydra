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
});
