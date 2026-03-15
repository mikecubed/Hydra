/**
 * Route-level tests for auth-routes — focused on /logout error handling.
 *
 * Verifies that logout does not falsely succeed when the underlying
 * audit persistence layer fails inside the real composed route stack.
 * Audit failures are injected by poisoning AuditStore.append() so the
 * full transitionSession → AuditService.record → AuditStore.append path
 * executes, rolls back the FSM state, and surfaces as a 500 to the client.
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
  let sessionStore: SessionStore;
  let auditStore: AuditStore;
  let sessionService: SessionService;
  let authService: AuthService;
  let app: Hono<GatewayEnv>;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    operatorStore = new OperatorStore(null);
    const rateLimiter = new RateLimiter(clock);
    sessionStore = new SessionStore(null);
    auditStore = new AuditStore(null);
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

  it('returns 500, preserves cookies, and keeps session active when audit persistence fails during logout', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const sid = result.session.id;

    // Verify session is active before the logout attempt
    assert.equal(sessionStore.get(sid)?.state, 'active');

    // Poison the audit store so the real transitionSession → auditService.record →
    // auditStore.append path throws, triggering the FSM rollback inside transitionSession.
    const originalAppend = auditStore.append.bind(auditStore);
    let callCount = 0;
    auditStore.append = async (record) => {
      callCount++;
      // Let all prior audit writes succeed (create, authenticate) but fail
      // the logout audit write (the 'session.logged-out' event).
      if (record.eventType === 'session.logged-out') {
        throw new Error('Audit write failed: ENOSPC');
      }
      return originalAppend(record);
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${sid}` },
    });

    // The audit append for logout must have been reached
    assert.ok(callCount > 0, 'audit store append must have been called');

    // Response must be 500 (do not falsely report success)
    assert.equal(res.status, 500);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'INTERNAL_ERROR');

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

    // The session must still be active on the server after rollback —
    // this is the critical postcondition that proves rollback worked.
    const post = sessionStore.get(sid);
    assert.ok(post, 'session must still exist in the store');
    assert.equal(post.state, 'active', 'session must be rolled back to active after audit failure');
  });

  it('returns 500 and preserves cookies when auditStore.append() throws unexpected error', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const sid = result.session.id;

    // Poison audit store with an unexpected error on logout events
    auditStore.append = async (record) => {
      if (record.eventType === 'session.logged-out') {
        throw new Error('Unexpected database corruption');
      }
    };

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__session=${sid}` },
    });
    assert.equal(res.status, 500);

    // Cookies preserved — server rolled back, session is still active
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      !setCookies.some((h) => h.startsWith('__session=')),
      'must not clear __session cookie on unexpected error',
    );
    assert.ok(
      !setCookies.some((h) => h.startsWith('__csrf=')),
      'must not clear __csrf cookie on unexpected error',
    );

    // Session must remain active after rollback
    const post = sessionStore.get(sid);
    assert.ok(post, 'session must still exist after unexpected audit error');
    assert.equal(post.state, 'active', 'session must be rolled back to active');
  });

  it('returns 500, preserves cookies, and rolls back FSM state on audit write failure', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const sid = result.session.id;

    // Verify session is active before logout
    const pre = sessionStore.get(sid);
    assert.equal(pre?.state, 'active');

    // Poison audit store: fail only the 'session.logged-out' event
    auditStore.append = async (record) => {
      if (record.eventType === 'session.logged-out') {
        throw new Error('Audit persistence failed: disk full');
      }
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

    // Critical: the session must still be active on the server after
    // transitionSession's rollback — proving the real rollback path works.
    const post = sessionStore.get(sid);
    assert.ok(post, 'session must still exist in store after rollback');
    assert.equal(post.state, 'active', 'session must be rolled back to active');
  });
});

describe('auth-routes: /login malformed body', () => {
  let app: Hono<GatewayEnv>;

  beforeEach(async () => {
    const clock = new FakeClock(Date.now());
    const operatorStore = new OperatorStore(null);
    const rateLimiter = new RateLimiter(clock);
    const sessionStore = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    const sessionService = new SessionService(sessionStore, clock, {}, auditService);
    const authService = new AuthService(operatorStore, rateLimiter, sessionService, auditService);

    await operatorStore.createOperator('admin', 'Admin');
    await operatorStore.addCredential('admin', 'password123');

    const routes = createAuthRoutes(authService, sessionService);
    app = new Hono<GatewayEnv>();
    app.route('/auth', routes);
  });

  it('returns 400 BAD_REQUEST for malformed JSON body', async () => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'BAD_REQUEST');
  });

  it('returns 400 BAD_REQUEST for empty body', async () => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'BAD_REQUEST');
  });

  it('still validates missing credentials after valid JSON parse', async () => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'BAD_REQUEST');
  });
});

describe('auth-routes: /reauth malformed body', () => {
  let app: Hono<GatewayEnv>;
  let sessionService: SessionService;
  let authService: AuthService;

  beforeEach(async () => {
    const clock = new FakeClock(Date.now());
    const operatorStore = new OperatorStore(null);
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

  it('returns 400 BAD_REQUEST for malformed JSON body', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const res = await app.request('/auth/reauth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `__session=${result.session.id}`,
      },
      body: '{broken',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'BAD_REQUEST');
  });

  it('returns 400 BAD_REQUEST for empty body on reauth', async () => {
    const result = await authService.authenticate('admin', 'password123', '127.0.0.1');
    const res = await app.request('/auth/reauth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `__session=${result.session.id}`,
      },
      body: '',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'BAD_REQUEST');
  });

  it('returns 401 when no session cookie even with malformed body', async () => {
    const res = await app.request('/auth/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'SESSION_NOT_FOUND');
  });
});
