/**
 * Route-level tests for auth-routes — focused on /logout error handling.
 *
 * Verifies that logout does not falsely succeed when the underlying
 * sessionService.logout() or audit persistence fails.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createAuthRoutes } from '../auth-routes.ts';
import { AuthService } from '../auth-service.ts';
import { OperatorStore } from '../operator-store.ts';
import { RateLimiter } from '../rate-limiter.ts';
import { SessionService } from '../../session/session-service.ts';
import { SessionStore } from '../../session/session-store.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { AuditStore } from '../../audit/audit-store.ts';
import { FakeClock } from '../../shared/clock.ts';
import type { GatewayEnv } from '../../shared/types.ts';

describe('auth-routes: /logout', () => {
  let clock: FakeClock;
  let operatorStore: OperatorStore;
  let sessionService: SessionService;
  let authService: AuthService;
  let app: Hono<GatewayEnv>;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    operatorStore = new OperatorStore(null);
    const rateLimiter = new RateLimiter(clock);
    const sessionStore = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    sessionService = new SessionService(sessionStore, clock, {}, auditService);
    authService = new AuthService(operatorStore, rateLimiter, sessionService, auditService);

    await operatorStore.createOperator('admin', 'Admin');
    await operatorStore.addCredential('admin', 'password123');

    const routes = createAuthRoutes(authService, sessionService);
    app = new Hono<GatewayEnv>();
    app.route('/auth', routes);
  });

  it('returns 200 for normal logout with valid session', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${result.session.id}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['success'], true);
  });

  it('returns 200 when no session cookie is present (no-op)', async () => {
    const res = await app.request('/auth/logout', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['success'], true);
  });

  it('returns 200 when session is already logged out (benign)', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    await sessionService.logout(result.session.id);

    // Second logout via route — session is terminal, transitionSession no-ops
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${result.session.id}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['success'], true);
  });

  it('returns 500 and clears cookies when sessionService.logout() throws (audit persistence failure)', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');

    // Monkey-patch logout to simulate an audit persistence error
    const originalLogout = sessionService.logout.bind(sessionService);
    sessionService.logout = async (_id: string) => {
      // Simulate the logout transition succeeding but audit write failing
      await originalLogout(_id).catch(() => {});
      throw new Error('Audit write failed: ENOSPC');
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${result.session.id}` },
    });
    assert.equal(res.status, 500);

    // Cookies must still be cleared even though the handler returned 500
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      setCookies.some((h) => h.startsWith('__session=')),
      'should clear __session cookie on failure',
    );
    assert.ok(
      setCookies.some((h) => h.startsWith('__csrf=')),
      'should clear __csrf cookie on failure',
    );
  });

  it('returns 500 and clears cookies when sessionService.logout() throws unexpected error', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');

    sessionService.logout = async () => {
      throw new Error('Unexpected database corruption');
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${result.session.id}` },
    });
    assert.equal(res.status, 500);

    const setCookies = res.headers.getSetCookie();
    assert.ok(
      setCookies.some((h) => h.startsWith('__session=')),
      'should clear __session cookie on failure',
    );
    assert.ok(
      setCookies.some((h) => h.startsWith('__csrf=')),
      'should clear __csrf cookie on failure',
    );
  });

  it('clears cookies with 500 on partial failure (session transitioned, audit write failed)', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const sid = result.session.id;

    // Verify session is active before logout
    const pre = sessionService.store.get(sid);
    assert.equal(pre?.state, 'active');

    // Patch: transition succeeds, but a post-transition audit step throws
    const originalLogout = sessionService.logout.bind(sessionService);
    sessionService.logout = async (id: string) => {
      await originalLogout(id);
      // Session is now in terminal 'logged-out' state on the server.
      // Simulate a subsequent audit/persistence step failing:
      throw new Error('Audit persistence failed after state transition');
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${sid}` },
    });

    // Response must be 500 (do not falsely report success)
    assert.equal(res.status, 500);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'INTERNAL_ERROR');

    // Cookies must be cleared despite the failure — the server-side session
    // is already terminal so leaving stale cookies would be inconsistent
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      setCookies.some((h) => h.startsWith('__session=')),
      'must clear __session cookie even on partial failure',
    );
    assert.ok(
      setCookies.some((h) => h.startsWith('__csrf=')),
      'must clear __csrf cookie even on partial failure',
    );

    // Confirm the server-side session actually transitioned to terminal
    const post = sessionService.store.get(sid);
    assert.equal(post?.state, 'logged-out');
  });
});
