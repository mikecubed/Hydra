import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createAuthMiddleware } from '../auth-middleware.ts';
import { SessionService } from '../../session/session-service.ts';
import { SessionStore } from '../../session/session-store.ts';
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
    const session = sessionService.create('admin', '127.0.0.1');
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
    const session = sessionService.create('admin', '127.0.0.1');
    clock.advance(3600_001);
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_EXPIRED');
  });

  it('rejects request with invalidated session cookie', async () => {
    const session = sessionService.create('admin', '127.0.0.1');
    sessionService.invalidate(session.id, 'test-reason');
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_INVALIDATED');
  });

  it('rejects request with logged-out session cookie', async () => {
    const session = sessionService.create('admin', '127.0.0.1');
    sessionService.logout(session.id);
    const res = await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 401);
    const body = await jsonBody(res);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
  });

  it('rejects request with idle session', async () => {
    const session = sessionService.create('admin', '127.0.0.1');
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
    const session = sessionService.create('admin', '127.0.0.1');
    clock.advance(100_000);
    await app.request('/protected', {
      headers: { Cookie: `__session=${session.id}` },
    });
    const updated = sessionService.store.get(session.id)!;
    assert.equal(sessionService.isIdle(updated), false);
  });

  it('sets csrfToken context variable', async () => {
    const csrfApp = new Hono<GatewayEnv>();
    csrfApp.use('*', createAuthMiddleware(sessionService));
    csrfApp.get('/csrf', (c) => c.json({ csrf: c.get('csrfToken') }));

    const session = sessionService.create('admin', '127.0.0.1');
    const res = await csrfApp.request('/csrf', {
      headers: { Cookie: `__session=${session.id}` },
    });
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.csrf, session.csrfToken);
  });
});
