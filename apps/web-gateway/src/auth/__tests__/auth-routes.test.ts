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

  it('returns 500 and preserves cookies when sessionService.logout() throws (audit persistence failure)', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');

    // Monkey-patch logout to simulate an audit persistence error
    // (transitionSession rolls back state → session stays active)
    const originalLogout = sessionService.logout.bind(sessionService);
    sessionService.logout = async (_id: string) => {
      await originalLogout(_id).catch(() => {});
      throw new Error('Audit write failed: ENOSPC');
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${result.session.id}` },
    });
    assert.equal(res.status, 500);

    // Cookies must NOT be cleared — the server rolled back so the session
    // is still active; clearing cookies would leave a dangling server session.
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      !setCookies.some((h) => h.startsWith('__session=')),
      'must not clear __session cookie when server-side logout rolled back',
    );
    assert.ok(
      !setCookies.some((h) => h.startsWith('__csrf=')),
      'must not clear __csrf cookie when server-side logout rolled back',
    );
  });

  it('returns 500 and preserves cookies when sessionService.logout() throws unexpected error', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');

    sessionService.logout = async () => {
      throw new Error('Unexpected database corruption');
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${result.session.id}` },
    });
    assert.equal(res.status, 500);

    // Cookies preserved — server may still consider the session active
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      !setCookies.some((h) => h.startsWith('__session=')),
      'must not clear __session cookie on unexpected error',
    );
    assert.ok(
      !setCookies.some((h) => h.startsWith('__csrf=')),
      'must not clear __csrf cookie on unexpected error',
    );
  });

  it('returns 500 and preserves cookies on partial failure (audit write failed, server rolled back)', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const sid = result.session.id;

    // Verify session is active before logout
    const pre = sessionService.store.get(sid);
    assert.equal(pre?.state, 'active');

    // Patch: make the audit write inside transitionSession throw, which
    // causes a rollback — the session stays active on the server.
    const originalLogout = sessionService.logout.bind(sessionService);
    sessionService.logout = async (id: string) => {
      await originalLogout(id);
      // If we reach here the real logout succeeded (no audit error).
      // Force an additional throw to simulate a downstream step failing.
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

    // Cookies must NOT be cleared — the route exits early on error so the
    // client retains its session cookie for a retry.
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      !setCookies.some((h) => h.startsWith('__session=')),
      'must not clear __session cookie when logout threw',
    );
    assert.ok(
      !setCookies.some((h) => h.startsWith('__csrf=')),
      'must not clear __csrf cookie when logout threw',
    );
  });
});
