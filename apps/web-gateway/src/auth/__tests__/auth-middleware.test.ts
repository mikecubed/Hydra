import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createAuthMiddleware } from '../auth-middleware.ts';
import { SessionService } from '../../session/session-service.ts';
import { SessionStore } from '../../session/session-store.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { AuditStore } from '../../audit/audit-store.ts';
import { FakeClock } from '../../shared/clock.ts';
import type { GatewayEnv } from '../../shared/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

describe('Auth middleware', () => {
  let sessionService: SessionService;
  let clock: FakeClock;
  let app: Hono<GatewayEnv>;

  beforeEach(() => {
    clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    sessionService = new SessionService(store, clock, {
      sessionLifetimeMs: 3600_000,
      warningThresholdMs: 600_000,
      maxExtensions: 3,
      extensionDurationMs: 3600_000,
      maxConcurrentSessions: 5,
      idleTimeoutMs: 1800_000,
    });

    app = new Hono<GatewayEnv>();
    app.use('*', createAuthMiddleware(sessionService));
    app.get('/protected', (c) =>
      c.json({ ok: true, operatorId: c.get('operatorId'), sessionId: c.get('sessionId') }),
    );
  });

  it('rejects request with missing session cookie', async () => {
    const res = await app.request('/protected');
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
  });

  it('rejects request with empty session cookie', async () => {
    const res = await app.request('/protected', {
      headers: { Cookie: '__session=' },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
  });

  it('accepts request with valid session cookie', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.operatorId, 'admin');
    assert.equal(body.sessionId, session.id);
  });

  it('rejects request with expired session cookie', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    clock.advance(3600_001);
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_EXPIRED');
  });

  it('rejects request with invalidated session cookie', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    await sessionService.invalidate(session.id, 'test-reason');
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_INVALIDATED');
  });

  it('rejects request with logged-out session cookie', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    await sessionService.logout(session.id);
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
  });

  it('rejects request with idle session', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    clock.advance(1800_001);
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'IDLE_TIMEOUT');
  });

  it('rejects request with unknown session ID', async () => {
    const res = await app.request('/protected', {
      headers: { Cookie: '__session=nonexistent-id' },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
  });

  it('touches activity on valid request', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    clock.advance(100_000);
    await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    const updated = sessionService.store.get(session.id)!;
    assert.equal(sessionService.isIdle(updated), false);
  });

  it('does not touch activity when downstream middleware rejects', async () => {
    // Simulate the CSRF-before-handler pattern: auth middleware runs, then a
    // downstream middleware rejects with 403. Activity must NOT be refreshed.
    const rejectApp = new Hono<GatewayEnv>();
    rejectApp.use('*', createAuthMiddleware(sessionService));
    rejectApp.use('*', async (c) => {
      return c.json({ code: 'CSRF_INVALID', message: 'bad token' }, 403);
    });
    rejectApp.post('/action', (c) => c.json({ ok: true }));

    const session = await sessionService.create('admin', '127.0.0.1');
    const createdAt = session.lastActivityAt;
    clock.advance(100_000);

    await rejectApp.request('/action', {
      method: 'POST',
      headers: { Cookie: `__session=${session.id}` },
    });
    const after = sessionService.store.get(session.id)!;
    assert.equal(after.lastActivityAt, createdAt, 'activity must not be refreshed on 403');
  });

  it('refreshes activity when downstream returns success', async () => {
    const session = await sessionService.create('admin', '127.0.0.1');
    const createdAt = session.lastActivityAt;
    clock.advance(100_000);

    await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    const after = sessionService.store.get(session.id)!;
    assert.notEqual(after.lastActivityAt, createdAt, 'activity must be refreshed on success');
  });

  it('sets csrfToken context variable', async () => {
    const csrfApp = new Hono<GatewayEnv>();
    csrfApp.use('*', createAuthMiddleware(sessionService));
    csrfApp.get('/csrf', (c) => c.json({ csrf: c.get('csrfToken') }));

    const session = await sessionService.create('admin', '127.0.0.1');
    const res = await csrfApp.request('/csrf', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.csrf, session.csrfToken);
  });

  it('emits session.idle-timeout audit event on idle rejection', async () => {
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);

    const auditedApp = new Hono<GatewayEnv>();
    auditedApp.use('*', createAuthMiddleware(sessionService, auditService));
    auditedApp.get('/protected', (c) => c.json({ ok: true }));

    const session = await sessionService.create('admin', '127.0.0.1');
    clock.advance(1800_001);

    const res = await auditedApp.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);

    const records = auditService.getRecords();
    const idleEvents = records.filter((r) => r.eventType === 'session.idle-timeout');
    assert.equal(idleEvents.length, 1, 'should emit one session.idle-timeout audit event');
    assert.equal(idleEvents[0].operatorId, 'admin');
    assert.equal(idleEvents[0].sessionId, session.id);
    assert.equal(idleEvents[0].outcome, 'failure');
  });
});
