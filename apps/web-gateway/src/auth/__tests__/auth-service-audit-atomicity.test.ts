/**
 * Regression tests for atomic success paths in AuthService.
 *
 * Verifies that:
 * - authenticate() rolls back the session when the success audit write fails
 * - reauthenticate() rolls back the idle-activity refresh when the success audit write fails
 */
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

describe('AuthService audit atomicity', () => {
  let clock: FakeClock;
  let operatorStore: OperatorStore;
  let sessionStore: SessionStore;
  let auditStore: AuditStore;
  let auditService: AuditService;
  let sessionService: SessionService;
  let rateLimiter: RateLimiter;
  let authService: AuthService;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    operatorStore = new OperatorStore(null);
    sessionStore = new SessionStore(null);
    auditStore = new AuditStore(null);
    auditService = new AuditService(auditStore, clock);
    sessionService = new SessionService(sessionStore, clock, {}, auditService);
    rateLimiter = new RateLimiter(clock);
    authService = new AuthService(operatorStore, rateLimiter, sessionService, auditService);

    await operatorStore.createOperator('admin', 'Admin');
    await operatorStore.addCredential('admin', 'correct-password');
  });

  describe('authenticate() rollback on audit failure', () => {
    it('throws when auth.attempt.success audit fails', async () => {
      const originalAppend = auditStore.append.bind(auditStore);
      auditStore.append = async (record) => {
        if (record.eventType === 'auth.attempt.success') {
          throw new Error('Audit disk full');
        }
        return originalAppend(record);
      };

      await assert.rejects(
        () => authService.authenticate('admin', 'correct-password', '127.0.0.1'),
        { message: /disk full/i },
      );
    });

    it('deletes the session when auth.attempt.success audit fails', async () => {
      const originalAppend = auditStore.append.bind(auditStore);
      auditStore.append = async (record) => {
        if (record.eventType === 'auth.attempt.success') {
          throw new Error('Audit disk full');
        }
        return originalAppend(record);
      };

      try {
        await authService.authenticate('admin', 'correct-password', '127.0.0.1');
      } catch {
        // expected
      }

      // There should be no active sessions in the store
      const sessions = sessionStore.listByOperator('admin');
      const activeSessions = sessions.filter((s) => s.state === 'active');
      assert.equal(activeSessions.length, 0, 'orphaned session must be cleaned up');
    });

    it('session.created audit failure still prevents session creation (upstream rollback)', async () => {
      const originalAppend = auditStore.append.bind(auditStore);
      auditStore.append = async (record) => {
        if (record.eventType === 'session.created') {
          throw new Error('Session create audit failed');
        }
        return originalAppend(record);
      };

      await assert.rejects(
        () => authService.authenticate('admin', 'correct-password', '127.0.0.1'),
        { message: /create audit/i },
      );

      const sessions = sessionStore.listByOperator('admin');
      assert.equal(
        sessions.length,
        0,
        'no session should exist after session.created audit failure',
      );
    });
  });

  describe('reauthenticate() rollback on audit failure', () => {
    it('throws when session.idle-reauth audit fails', async () => {
      const result = await authService.authenticate('admin', 'correct-password', '10.0.0.1');
      clock.advance(30 * 60 * 1000 + 1); // idle

      const originalAppend = auditStore.append.bind(auditStore);
      auditStore.append = async (record) => {
        if (record.eventType === 'session.idle-reauth') {
          throw new Error('Reauth audit write failed');
        }
        return originalAppend(record);
      };

      await assert.rejects(
        () =>
          authService.reauthenticate('admin', 'correct-password', '10.0.0.1', result.session.id),
        { message: /reauth audit/i },
      );
    });

    it('restores lastActivityAt when session.idle-reauth audit fails', async () => {
      const result = await authService.authenticate('admin', 'correct-password', '10.0.0.1');
      clock.advance(30 * 60 * 1000 + 1); // idle

      // Capture the lastActivityAt before the failed reauth
      const sessionBefore = sessionStore.get(result.session.id)!;
      const activityBefore = sessionBefore.lastActivityAt;

      const originalAppend = auditStore.append.bind(auditStore);
      auditStore.append = async (record) => {
        if (record.eventType === 'session.idle-reauth') {
          throw new Error('Reauth audit write failed');
        }
        return originalAppend(record);
      };

      try {
        await authService.reauthenticate(
          'admin',
          'correct-password',
          '10.0.0.1',
          result.session.id,
        );
      } catch {
        // expected
      }

      // lastActivityAt must be restored to the value before reauth
      const sessionAfter = sessionStore.get(result.session.id)!;
      assert.equal(
        sessionAfter.lastActivityAt,
        activityBefore,
        'lastActivityAt must be rolled back so session stays idle',
      );
    });

    it('session remains idle after failed reauth audit', async () => {
      const result = await authService.authenticate('admin', 'correct-password', '10.0.0.1');
      clock.advance(30 * 60 * 1000 + 1); // idle

      const originalAppend = auditStore.append.bind(auditStore);
      auditStore.append = async (record) => {
        if (record.eventType === 'session.idle-reauth') {
          throw new Error('Reauth audit write failed');
        }
        return originalAppend(record);
      };

      try {
        await authService.reauthenticate(
          'admin',
          'correct-password',
          '10.0.0.1',
          result.session.id,
        );
      } catch {
        // expected
      }

      // Verify session is still considered idle (activity not refreshed)
      const session = sessionStore.get(result.session.id)!;
      assert.ok(
        sessionService.isIdle(session),
        'session must still be idle after failed reauth audit',
      );
    });
  });
});
