/**
 * Integration tests for conversation route wiring in the gateway app (T015, T015b).
 *
 * Verifies that conversation routes are protected by auth + CSRF middleware
 * and correctly wired into the gateway app factory.
 */
/* eslint-disable n/no-unsupported-features/node-builtins -- Request is stable in Node 24 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { DaemonClient } from '../daemon-client.ts';
import { FakeClock } from '../../shared/clock.ts';

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

async function login(gw: GatewayApp): Promise<Record<string, string>> {
  const req = buildRequest('POST', '/auth/login', {
    body: json({ identity: 'admin', secret: 'password123' }),
    headers: { origin: ORIGIN },
  });
  const res = await gw.app.request(req);
  assert.equal(res.status, 200);
  return parseCookies(res);
}

describe('Conversation route wiring (T015, T015b)', () => {
  let gw: GatewayApp;
  let clock: FakeClock;
  let fetchMock: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    fetchMock = mock.fn<typeof globalThis.fetch>();
    const daemonClient = new DaemonClient({
      baseUrl: 'http://localhost:4173',
      fetchFn: fetchMock,
      timeoutMs: 5000,
    });

    gw = createGatewayApp({
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 3600_000,
        warningThresholdMs: 600_000,
        maxExtensions: 3,
        extensionDurationMs: 3600_000,
        idleTimeoutMs: 1800_000,
      },
      daemonClient,
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');
  });

  afterEach(() => {
    gw.heartbeat.stop();
    fetchMock.mock.resetCalls();
  });

  // ── Auth protection ─────────────────────────────────────────────────────

  it('rejects unauthenticated GET /conversations', async () => {
    const req = buildRequest('GET', '/conversations', { headers: { origin: ORIGIN } });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
    assert.equal(body.category, 'auth');
  });

  it('rejects unauthenticated POST /conversations', async () => {
    const req = buildRequest('POST', '/conversations', {
      body: json({}),
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
    assert.equal(body.category, 'auth');
  });

  it('rejects POST /conversations without CSRF token', async () => {
    const cookies = await login(gw);

    const req = buildRequest('POST', '/conversations', {
      body: json({ title: 'Test' }),
      cookies: { __session: cookies['__session'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });

  // ── Authenticated + CSRF conversation requests ─────────────────────────

  it('GET /conversations with valid session succeeds', async () => {
    const cookies = await login(gw);
    // Mock daemon response
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ conversations: [], nextCursor: undefined, totalCount: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const req = buildRequest('GET', '/conversations', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { conversations: unknown[] };
    assert.ok(Array.isArray(body.conversations));
  });

  it('POST /conversations with valid session + CSRF creates conversation', async () => {
    const cookies = await login(gw);
    const csrfToken = cookies['__csrf'];

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'conv-new', status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const req = buildRequest('POST', '/conversations', {
      body: json({ title: 'Test Conversation' }),
      cookies: { __session: cookies['__session'], __csrf: csrfToken },
      headers: { origin: ORIGIN, 'x-csrf-token': csrfToken },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string };
    assert.equal(body.id, 'conv-new');
  });

  it('GET /conversations/:id with valid session opens conversation', async () => {
    const cookies = await login(gw);
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            conversation: { id: 'conv-1', status: 'active' },
            recentTurns: [],
            totalTurnCount: 0,
            pendingApprovals: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = buildRequest('GET', '/conversations/conv-1', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { conversation: { id: string } };
    assert.equal(body.conversation.id, 'conv-1');
  });

  it('POST /approvals/:id/respond with valid session forwards X-Session-Id', async () => {
    const cookies = await login(gw);
    const csrfToken = cookies['__csrf'];

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: true, approval: { id: 'a1', status: 'approved' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = buildRequest('POST', '/approvals/a1/respond', {
      body: json({ response: 'approve' }),
      cookies: { __session: cookies['__session'], __csrf: csrfToken },
      headers: { origin: ORIGIN, 'x-csrf-token': csrfToken },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);

    // Verify daemon received X-Session-Id header
    assert.equal(fetchMock.mock.callCount(), 1);
    const callArgs = fetchMock.mock.calls[0].arguments;
    const daemonHeaders = callArgs[1]?.headers as Record<string, string>;
    assert.ok(daemonHeaders['X-Session-Id'], 'should forward X-Session-Id to daemon');
  });

  it('GET /turns/:turnId/artifacts with valid session succeeds', async () => {
    const cookies = await login(gw);
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ artifacts: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const req = buildRequest('GET', '/turns/t1/artifacts', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
  });

  it('GET /artifacts/:artifactId with valid session succeeds', async () => {
    const cookies = await login(gw);
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ artifact: { id: 'art-1' }, content: 'x' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const req = buildRequest('GET', '/artifacts/art-1', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
  });

  it('GET /turns/:turnId/activities with valid session succeeds', async () => {
    const cookies = await login(gw);
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ activities: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const req = buildRequest('GET', '/turns/t1/activities', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
  });
});
