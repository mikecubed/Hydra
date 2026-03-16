/**
 * Route-level tests for session-routes — focused on /extend error paths.
 *
 * Covers daemon-unreachable sessions returning 503 instead of expired-session.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createSessionRoutes } from '../session-routes.ts';
import { SessionService } from '../session-service.ts';
import { SessionStore } from '../session-store.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { AuditStore } from '../../audit/audit-store.ts';
import { FakeClock } from '../../shared/clock.ts';
import type { GatewayEnv } from '../../shared/types.ts';

describe('session-routes: POST /extend', () => {
  let clock: FakeClock;
  let sessionService: SessionService;
  let sessionStore: SessionStore;
  let app: Hono<GatewayEnv>;

  beforeEach(() => {
    clock = new FakeClock(Date.now());
    sessionStore = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    sessionService = new SessionService(
      sessionStore,
      clock,
      {
        sessionLifetimeMs: 3600_000,
        warningThresholdMs: 600_000,
        maxExtensions: 3,
        extensionDurationMs: 3600_000,
        maxConcurrentSessions: 5,
        idleTimeoutMs: 1800_000,
      },
      auditService,
    );

    const routes = createSessionRoutes(sessionService);
    app = new Hono<GatewayEnv>();
    app.route('/session', routes);
  });

  it('returns 503 DAEMON_UNREACHABLE when extending a daemon-unreachable session', async () => {
    const session = await sessionService.create('op-1', '127.0.0.1');

    // Simulate daemon going down
    await sessionService.markDaemonDown(session.id);
    assert.equal(sessionStore.get(session.id)?.state, 'daemon-unreachable');

    const res = await app.request('/session/extend', {
      method: 'POST',
      headers: { Cookie: `__session=${session.id}` },
    });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'DAEMON_UNREACHABLE');
  });

  it('extend succeeds after daemon recovers', async () => {
    const session = await sessionService.create('op-1', '127.0.0.1');

    // Daemon down then up
    await sessionService.markDaemonDown(session.id);
    await sessionService.markDaemonUp(session.id);
    assert.equal(sessionStore.get(session.id)?.state, 'active');

    // Advance into extension window
    clock.advance(3001_000);

    const res = await app.request('/session/extend', {
      method: 'POST',
      headers: { Cookie: `__session=${session.id}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { newExpiresAt: string };
    assert.ok(body.newExpiresAt);
  });

  it('returns 401 when no session cookie is present', async () => {
    const res = await app.request('/session/extend', { method: 'POST' });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'SESSION_NOT_FOUND');
  });
});
