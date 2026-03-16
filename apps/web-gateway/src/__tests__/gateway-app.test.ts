/**
 * Integration tests for the composed gateway app.
 *
 * Exercises origin guard, CSRF, session auth, and route composition
 * through the fully-assembled Hono stack created by createGatewayApp().
 */
/* eslint-disable n/no-unsupported-features/node-builtins -- Request is stable in Node 24 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayApp, type GatewayApp } from '../index.ts';
import { FakeClock } from '../shared/clock.ts';

const ORIGIN = 'http://127.0.0.1:4174';

function json(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function buildRequest(
  method: string,
  path: string,
  opts: {
    body?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers['cookie'] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : opts.body,
  });
}

/** Parse Set-Cookie headers from a Response into a cookie jar. */
function parseCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  const setCookies = res.headers.getSetCookie();
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      jar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return jar;
}

/** Login helper — returns session + csrf cookies. */
async function login(gw: GatewayApp): Promise<Record<string, string>> {
  const req = buildRequest('POST', '/auth/login', {
    body: json({ identity: 'admin', secret: 'password123' }),
    headers: { origin: ORIGIN },
  });
  const res = await gw.app.request(req);
  assert.equal(res.status, 200);
  return parseCookies(res);
}

describe('Gateway app integration', () => {
  let gw: GatewayApp;
  let clock: FakeClock;
  let healthResult: boolean;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    healthResult = true;
    gw = createGatewayApp({
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => healthResult,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 3600_000,
        warningThresholdMs: 600_000,
        maxExtensions: 3,
        extensionDurationMs: 3600_000,
        idleTimeoutMs: 1800_000,
      },
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');
  });

  afterEach(() => {
    gw.heartbeat.stop();
  });

  // ── Origin guard ─────────────────────────────────────────────────────────

  it('rejects POST without Origin header', async () => {
    const req = buildRequest('POST', '/auth/login', {
      body: json({ identity: 'admin', secret: 'password123' }),
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'ORIGIN_REJECTED');
  });

  it('rejects POST with wrong Origin header', async () => {
    const req = buildRequest('POST', '/auth/login', {
      body: json({ identity: 'admin', secret: 'password123' }),
      headers: { origin: 'http://evil.example.com' },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'ORIGIN_REJECTED');
  });

  // ── Login flow ───────────────────────────────────────────────────────────

  it('login succeeds and sets cookies', async () => {
    const cookies = await login(gw);
    assert.ok(cookies['__session'], 'should set __session cookie');
    assert.ok(cookies['__csrf'], 'should set __csrf cookie');
  });

  it('login with bad credentials returns 401', async () => {
    const req = buildRequest('POST', '/auth/login', {
      body: json({ identity: 'admin', secret: 'wrong' }),
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
  });

  // ── Session info (protected) ─────────────────────────────────────────────

  it('GET /session/info without session cookie returns 401', async () => {
    const req = buildRequest('GET', '/session/info');
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
  });

  it('GET /session/info with valid session returns session data', async () => {
    const cookies = await login(gw);

    const infoReq = buildRequest('GET', '/session/info', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
    });
    const infoRes = await gw.app.request(infoReq);
    assert.equal(infoRes.status, 200);

    const body = (await infoRes.json()) as { operatorId: string; state: string };
    assert.equal(body.operatorId, 'admin');
    assert.equal(body.state, 'active');
  });

  // ── CSRF protection on session/extend ────────────────────────────────────

  it('POST /session/extend without CSRF token returns 403', async () => {
    const cookies = await login(gw);

    // Keep session alive with a request to avoid idle timeout
    clock.advance(1500_000);
    await gw.app.request(
      buildRequest('GET', '/session/info', {
        cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      }),
    );
    clock.advance(1501_000); // total: 3001s — in extension window

    // Try extend WITHOUT X-CSRF-Token header
    const extendReq = buildRequest('POST', '/session/extend', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const extendRes = await gw.app.request(extendReq);
    assert.equal(extendRes.status, 403);
    const body = (await extendRes.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });

  it('POST /session/extend with valid CSRF succeeds', async () => {
    const cookies = await login(gw);

    // Keep session alive then advance into window
    clock.advance(1500_000);
    await gw.app.request(
      buildRequest('GET', '/session/info', {
        cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      }),
    );
    clock.advance(1501_000); // total: 3001s — in extension window

    const extendReq = buildRequest('POST', '/session/extend', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: {
        origin: ORIGIN,
        'x-csrf-token': cookies['__csrf'],
      },
    });
    const extendRes = await gw.app.request(extendReq);
    assert.equal(extendRes.status, 200);

    const body = (await extendRes.json()) as { newExpiresAt: string };
    assert.ok(body.newExpiresAt, 'should return new expiration');
  });

  // ── Hardened headers ─────────────────────────────────────────────────────

  it('responses include security headers', async () => {
    const req = buildRequest('GET', '/session/info');
    const res = await gw.app.request(req);
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('referrer-policy'));
  });

  // ── Logout ───────────────────────────────────────────────────────────────

  it('logout clears cookies and invalidates session', async () => {
    const cookies = await login(gw);

    const logoutReq = buildRequest('POST', '/auth/logout', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const logoutRes = await gw.app.request(logoutReq);
    assert.equal(logoutRes.status, 200);

    // Old session is now invalid
    const infoReq = buildRequest('GET', '/session/info', {
      cookies: { __session: cookies['__session'] },
    });
    const infoRes = await gw.app.request(infoReq);
    assert.notEqual(infoRes.status, 200);
  });

  // ── CSRF protection on /auth/logout ─────────────────────────────────────

  it('POST /auth/logout without CSRF token returns 403', async () => {
    const cookies = await login(gw);

    const logoutReq = buildRequest('POST', '/auth/logout', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const logoutRes = await gw.app.request(logoutReq);
    assert.equal(logoutRes.status, 403);
    const body = (await logoutRes.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });

  it('POST /auth/logout with wrong CSRF token returns 403', async () => {
    const cookies = await login(gw);

    const logoutReq = buildRequest('POST', '/auth/logout', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': 'wrong-token' },
    });
    const logoutRes = await gw.app.request(logoutReq);
    assert.equal(logoutRes.status, 403);
    const body = (await logoutRes.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });

  // ── CSRF protection on /auth/reauth ─────────────────────────────────────

  it('POST /auth/reauth without CSRF token returns 403', async () => {
    const cookies = await login(gw);

    // Advance past idle timeout
    clock.advance(1800_001);

    const reauthReq = buildRequest('POST', '/auth/reauth', {
      body: json({ identity: 'admin', secret: 'password123' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const reauthRes = await gw.app.request(reauthReq);
    assert.equal(reauthRes.status, 403);
    const body = (await reauthRes.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });

  it('POST /auth/reauth with valid CSRF token succeeds', async () => {
    const cookies = await login(gw);

    // Advance past idle timeout
    clock.advance(1800_001);

    const reauthReq = buildRequest('POST', '/auth/reauth', {
      body: json({ identity: 'admin', secret: 'password123' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const reauthRes = await gw.app.request(reauthReq);
    assert.equal(reauthRes.status, 200);
    const body = (await reauthRes.json()) as { operatorId: string };
    assert.equal(body.operatorId, 'admin');
  });

  // ── Login does NOT require CSRF ──────────────────────────────────────────

  it('POST /auth/login without CSRF token succeeds (pre-auth)', async () => {
    const req = buildRequest('POST', '/auth/login', {
      body: json({ identity: 'admin', secret: 'password123' }),
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
  });

  // ── CSRF failure must not refresh idle activity ──────────────────────────

  it('failed CSRF on /session/extend does not refresh idle activity', async () => {
    const cookies = await login(gw);
    const session = gw.sessionService.store.get(cookies['__session'])!;
    const activityBefore = session.lastActivityAt;

    // Advance time but stay within idle window
    clock.advance(900_000);

    // POST /session/extend WITHOUT X-CSRF-Token — should get 403 CSRF_INVALID
    const extendReq = buildRequest('POST', '/session/extend', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const extendRes = await gw.app.request(extendReq);
    assert.equal(extendRes.status, 403);
    const body = (await extendRes.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');

    // Activity must NOT have been refreshed
    const afterSession = gw.sessionService.store.get(cookies['__session'])!;
    assert.equal(
      afterSession.lastActivityAt,
      activityBefore,
      'CSRF failure must not refresh idle activity',
    );
  });

  // ── Malformed JSON on auth routes ─────────────────────────────────────

  it('POST /auth/login with malformed JSON returns 400', async () => {
    const req = buildRequest('POST', '/auth/login', {
      body: '{not-valid-json',
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'BAD_REQUEST');
  });

  it('POST /auth/reauth with malformed JSON returns 400', async () => {
    const cookies = await login(gw);
    clock.advance(1800_001); // idle

    const req = buildRequest('POST', '/auth/reauth', {
      body: '%%%not-json',
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'BAD_REQUEST');
  });

  // ── Reauth (idle-only) ──────────────────────────────────────────────────

  it('reauth rejects active (non-idle) session', async () => {
    const cookies = await login(gw);

    const reauthReq = buildRequest('POST', '/auth/reauth', {
      body: json({ identity: 'admin', secret: 'password123' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const reauthRes = await gw.app.request(reauthReq);
    assert.equal(reauthRes.status, 403);
    const body = (await reauthRes.json()) as { code: string };
    assert.equal(body.code, 'SESSION_NOT_IDLE');
  });

  it('reauth succeeds for idle session', async () => {
    const cookies = await login(gw);

    // Advance past idle timeout
    clock.advance(1800_001);

    const reauthReq = buildRequest('POST', '/auth/reauth', {
      body: json({ identity: 'admin', secret: 'password123' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const reauthRes = await gw.app.request(reauthReq);
    assert.equal(reauthRes.status, 200);
    const body = (await reauthRes.json()) as { operatorId: string };
    assert.equal(body.operatorId, 'admin');
  });

  // ── Idle timeout audit ─────────────────────────────────────────────────

  it('idle timeout emits session.idle-timeout audit event via composed stack', async () => {
    const cookies = await login(gw);

    // Advance past idle timeout
    clock.advance(1800_001);

    const infoReq = buildRequest('GET', '/session/info', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
    });
    const infoRes = await gw.app.request(infoReq);
    assert.equal(infoRes.status, 401);
    const body = (await infoRes.json()) as { code: string };
    assert.equal(body.code, 'IDLE_TIMEOUT');

    // Verify audit trail includes idle-timeout event
    const records = gw.auditService.getRecords();
    const idleEvents = records.filter((r) => r.eventType === 'session.idle-timeout');
    assert.equal(idleEvents.length, 1, 'should emit one session.idle-timeout audit event');
    assert.equal(idleEvents[0].operatorId, 'admin');
    assert.equal(idleEvents[0].outcome, 'failure');
  });

  // ── Session extend without prior validate() (through composed stack) ──

  it('extend works without prior validate() through composed app', async () => {
    const cookies = await login(gw);

    // Keep alive then advance into window — the auth middleware's validate()
    // call is the only validate, proving extend works without a separate
    // user-initiated validate call preceding it.
    clock.advance(1500_000);
    await gw.app.request(
      buildRequest('GET', '/session/info', {
        cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      }),
    );
    clock.advance(1501_000); // total: 3001s — in extension window

    const extendReq = buildRequest('POST', '/session/extend', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: {
        origin: ORIGIN,
        'x-csrf-token': cookies['__csrf'],
      },
    });
    const extendRes = await gw.app.request(extendReq);
    assert.equal(extendRes.status, 200);
    const body = (await extendRes.json()) as { newExpiresAt: string };
    assert.ok(body.newExpiresAt);
  });

  // ── Daemon heartbeat integration ──────────────────────────────────────────

  it('heartbeat is wired: daemon-down marks sessions daemon-unreachable via /session/info', async () => {
    const cookies = await login(gw);

    // Verify session is active
    const infoReq1 = buildRequest('GET', '/session/info', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
    });
    const infoRes1 = await gw.app.request(infoReq1);
    assert.equal(infoRes1.status, 200);
    const body1 = (await infoRes1.json()) as { state: string };
    assert.equal(body1.state, 'active');

    // Simulate daemon going down via the wired heartbeat
    healthResult = false;
    await gw.heartbeat.tick();

    // Session should now be daemon-unreachable — validate still throws,
    // but the session-info route should reflect the state change via the store.
    const session = gw.sessionService.store.get(cookies['__session']);
    assert.ok(session);
    assert.equal(session.state, 'daemon-unreachable');
  });

  it('heartbeat is wired: daemon recovery restores sessions via composed gateway', async () => {
    const cookies = await login(gw);

    // Daemon goes down
    healthResult = false;
    await gw.heartbeat.tick();
    assert.equal(gw.sessionService.store.get(cookies['__session'])?.state, 'daemon-unreachable');

    // Daemon recovers
    healthResult = true;
    await gw.heartbeat.tick();

    // Session should be restored to active
    const infoReq = buildRequest('GET', '/session/info', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
    });
    const infoRes = await gw.app.request(infoReq);
    assert.equal(infoRes.status, 200);
    const body = (await infoRes.json()) as { state: string };
    assert.equal(body.state, 'active');
  });

  it('heartbeat: session expired during daemon outage stays terminal after recovery', async () => {
    const cookies = await login(gw);

    // Daemon goes down
    healthResult = false;
    await gw.heartbeat.tick();
    assert.equal(gw.sessionService.store.get(cookies['__session'])?.state, 'daemon-unreachable');

    // Time passes beyond session lifetime while daemon is down
    clock.advance(3600_001);

    // Daemon recovers — heartbeat validate should detect expiry
    healthResult = true;
    await gw.heartbeat.tick();

    const session = gw.sessionService.store.get(cookies['__session']);
    assert.ok(session);
    assert.equal(session.state, 'expired');

    // And the HTTP route confirms it
    const infoReq = buildRequest('GET', '/session/info', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
    });
    const infoRes = await gw.app.request(infoReq);
    assert.notEqual(infoRes.status, 200);
  });
});
