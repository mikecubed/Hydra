/**
 * Tests for mutations routes (T013/T014 — Phase 2 config mutations).
 *
 * Unit tests use a mock DaemonMutationsClient injected via the route factory.
 * Wiring tests use the full gateway app to verify auth + CSRF protection.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { DaemonMutationsClient } from '../daemon-mutations-client.ts';
import type { DaemonMutationsResult } from '../daemon-mutations-client.ts';
import type { GetSafeConfigResponse, PatchRoutingModeResponse } from '@hydra/web-contracts';
import { createMutationsRouter } from '../mutations-routes.ts';
import { createGatewayErrorResponse } from '../../shared/gateway-error-response.ts';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';

const ORIGIN = 'http://127.0.0.1:4174';

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockMutClient = DaemonMutationsClient & {
  getSafeConfig: ReturnType<typeof mock.fn<DaemonMutationsClient['getSafeConfig']>>;
  postRoutingMode: ReturnType<typeof mock.fn<DaemonMutationsClient['postRoutingMode']>>;
  postModelTier: ReturnType<typeof mock.fn<DaemonMutationsClient['postModelTier']>>;
  postBudget: ReturnType<typeof mock.fn<DaemonMutationsClient['postBudget']>>;
  postWorkflowLaunch: ReturnType<typeof mock.fn<DaemonMutationsClient['postWorkflowLaunch']>>;
  getAudit: ReturnType<typeof mock.fn<DaemonMutationsClient['getAudit']>>;
};

function createMockMutClient(): MockMutClient {
  const client = new DaemonMutationsClient({
    baseUrl: 'http://daemon.invalid',
  }) as MockMutClient;

  const safeConfigData: GetSafeConfigResponse = {
    config: { routing: { mode: 'economy' } },
    revision: 'rev-1',
  };

  const mutationResponse: PatchRoutingModeResponse = {
    snapshot: { routing: { mode: 'balanced' } },
    appliedRevision: 'rev-2',
    timestamp: '2026-03-22T10:00:00.000Z',
  };

  client.getSafeConfig = mock.fn<DaemonMutationsClient['getSafeConfig']>(() =>
    Promise.resolve({ data: safeConfigData }),
  );
  client.postRoutingMode = mock.fn<DaemonMutationsClient['postRoutingMode']>(() =>
    Promise.resolve({ data: mutationResponse }),
  );
  client.postModelTier = mock.fn<DaemonMutationsClient['postModelTier']>(() =>
    Promise.resolve({ data: mutationResponse }),
  );
  client.postBudget = mock.fn<DaemonMutationsClient['postBudget']>(() =>
    Promise.resolve({ data: mutationResponse }),
  );
  client.postWorkflowLaunch = mock.fn<DaemonMutationsClient['postWorkflowLaunch']>(() =>
    Promise.resolve({
      data: {
        taskId: 'task-1',
        workflow: 'evolve' as const,
        launchedAt: '2026-03-22T10:00:00.000Z',
        destructive: false,
      },
    }),
  );
  client.getAudit = mock.fn<DaemonMutationsClient['getAudit']>(() =>
    Promise.resolve({ data: { records: [], nextCursor: null } }),
  );

  return client;
}

/** Build a Hono app with mutations routes pre-wired. Simulates auth middleware. */
function buildTestApp(mutClient: DaemonMutationsClient): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('operatorId' as never, 'test-operator' as never);
    c.set('sessionId' as never, 'test-session-123' as never);
    await next();
  });
  app.route('/mutations', createMutationsRouter(mutClient));
  return app;
}

function buildRequest(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: method === 'GET' ? undefined : opts.body,
  });
}

// ── Unit tests: GET /mutations/config/safe ────────────────────────────────────

describe('Mutations routes — GET /mutations/config/safe (T013)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 with safe config data', async () => {
    const res = await app.request(buildRequest('GET', '/mutations/config/safe'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as GetSafeConfigResponse;
    assert.equal(body.revision, 'rev-1');
    assert.deepStrictEqual(body.config, { routing: { mode: 'economy' } });
  });

  it('returns 503 when daemon is unavailable', async () => {
    mockClient.getSafeConfig.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'DAEMON_UNREACHABLE',
          category: 'daemon-unavailable',
          message: 'Daemon unreachable',
        }),
      } as DaemonMutationsResult<GetSafeConfigResponse>),
    );

    const res = await app.request(buildRequest('GET', '/mutations/config/safe'));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Daemon unreachable');
  });
});

// ── Unit tests: POST /mutations/config/routing/mode ───────────────────────────

describe('Mutations routes — POST /mutations/config/routing/mode (T013)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 with mutation response on valid body', async () => {
    const body = { mode: 'balanced', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/mutations/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as PatchRoutingModeResponse;
    assert.equal(data.appliedRevision, 'rev-2');
    assert.equal(mockClient.postRoutingMode.mock.callCount(), 1);
  });

  it('returns 400 on invalid mode value', async () => {
    const body = { mode: 'turbo', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/mutations/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postRoutingMode.mock.callCount(), 0);
  });

  it('returns 400 on missing expectedRevision', async () => {
    const body = { mode: 'economy' };
    const res = await app.request(
      buildRequest('POST', '/mutations/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postRoutingMode.mock.callCount(), 0);
  });

  it('returns 400 on empty/null body', async () => {
    const res = await app.request(
      buildRequest('POST', '/mutations/config/routing/mode', { body: '' }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postRoutingMode.mock.callCount(), 0);
  });

  it('returns 409 when daemon returns stale-revision', async () => {
    mockClient.postRoutingMode.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'STALE_REVISION',
          category: 'stale-revision',
          message: 'Revision mismatch',
          httpStatus: 409,
        }),
      } as DaemonMutationsResult<PatchRoutingModeResponse>),
    );

    const body = { mode: 'economy', expectedRevision: 'rev-old' };
    const res = await app.request(
      buildRequest('POST', '/mutations/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 409);
    const data = (await res.json()) as { error: string };
    assert.ok(data.error.includes('reload and retry'));
  });

  it('returns 503 when daemon is unavailable', async () => {
    mockClient.postRoutingMode.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'DAEMON_UNREACHABLE',
          category: 'daemon-unavailable',
          message: 'Daemon unreachable',
        }),
      } as DaemonMutationsResult<PatchRoutingModeResponse>),
    );

    const body = { mode: 'balanced', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/mutations/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 503);
  });
});

// ── Wiring tests: auth + CSRF protection ──────────────────────────────────────

function gwRequest(
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
  const req = gwRequest('POST', '/auth/login', {
    body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
    headers: { origin: ORIGIN },
  });
  const res = await gw.app.request(req);
  assert.equal(res.status, 200);
  return parseCookies(res);
}

describe('Mutations route wiring — auth/CSRF (T014)', () => {
  let gw: GatewayApp;
  let clock: FakeClock;
  let fetchMock: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    fetchMock = mock.fn<typeof globalThis.fetch>();

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
      daemonClientOptions: {
        baseUrl: 'http://localhost:4173',
        fetchFn: fetchMock,
        timeoutMs: 5000,
      },
      mutationsClientOptions: {
        baseUrl: 'http://localhost:4173',
        fetchFn: fetchMock,
        timeoutMs: 5000,
      },
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');
  });

  afterEach(() => {
    gw.heartbeat.stop();
    fetchMock.mock.resetCalls();
  });

  it('rejects unauthenticated GET /mutations/config/safe with 401', async () => {
    const req = gwRequest('GET', '/mutations/config/safe', { headers: { origin: ORIGIN } });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.category, 'auth');
  });

  it('GET /mutations/config/safe with valid session succeeds', async () => {
    const cookies = await login(gw);

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ config: { routing: { mode: 'economy' } }, revision: 'rev-1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = gwRequest('GET', '/mutations/config/safe', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
  });

  it('POST /mutations/config/routing/mode missing CSRF → 403', async () => {
    const cookies = await login(gw);

    const req = gwRequest('POST', '/mutations/config/routing/mode', {
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 403);
  });

  it('POST /mutations/config/routing/mode with expired session → 401', async () => {
    const cookies = await login(gw);

    // Advance clock past session lifetime
    clock.advance(3700_000);

    const req = gwRequest('POST', '/mutations/config/routing/mode', {
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
  });

  it('POST /mutations/config/routing/mode with valid session and CSRF → calls daemon', async () => {
    const cookies = await login(gw);

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            snapshot: { routing: { mode: 'balanced' } },
            appliedRevision: 'rev-2',
            timestamp: '2026-03-22T10:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = gwRequest('POST', '/mutations/config/routing/mode', {
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { appliedRevision: string };
    assert.equal(body.appliedRevision, 'rev-2');
  });

  it('POST /mutations/config/routing/mode with invalid mode → 400 (daemon never called)', async () => {
    const cookies = await login(gw);

    const req = gwRequest('POST', '/mutations/config/routing/mode', {
      body: JSON.stringify({ mode: 'turbo', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 400);
    // Daemon should not have been called — only the login call should exist
    const postLoginCalls = fetchMock.mock.calls.filter((call) => {
      const url = call.arguments[0] as string;
      return url.includes('/config/routing/mode');
    });
    assert.equal(postLoginCalls.length, 0);
  });
});
