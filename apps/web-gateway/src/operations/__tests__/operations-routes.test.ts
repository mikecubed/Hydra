/**
 * Tests for operations routes (T009 — US1 queue visibility).
 *
 * Mirrors the conversation-routes test pattern:
 * - Unit tests use a mock DaemonOperationsClient injected via the route factory.
 * - Wiring tests use the full gateway app to verify auth + CSRF protection.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createOperationsRoutes } from '../operations-routes.ts';
import type { DaemonOperationsClient, DaemonOperationsResult } from '../daemon-operations-client.ts';
import type { GatewayErrorResponse } from '../../shared/gateway-error-response.ts';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';

const ORIGIN = 'http://127.0.0.1:4174';

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockOpsClient = {
  [K in keyof DaemonOperationsClient]: ReturnType<typeof mock.fn>;
};

function createMockOpsClient(): MockOpsClient {
  return {
    getOperationsSnapshot: mock.fn(() =>
      Promise.resolve({
        data: {
          queue: [],
          health: null,
          budget: null,
          availability: 'empty',
          lastSynchronizedAt: null,
          nextCursor: null,
        },
      }),
    ),
    getWorkItemDetail: mock.fn(() =>
      Promise.resolve({
        data: {
          item: { id: 'wi-1' },
          checkpoints: [],
          routing: null,
          assignments: [],
          council: null,
          controls: [],
          itemBudget: null,
          availability: 'ready',
        },
      }),
    ),
    getWorkItemCheckpoints: mock.fn(() =>
      Promise.resolve({
        data: { workItemId: 'wi-1', checkpoints: [], availability: 'ready' },
      }),
    ),
    getWorkItemExecution: mock.fn(() =>
      Promise.resolve({
        data: {
          workItemId: 'wi-1',
          routing: null,
          assignments: [],
          council: null,
          availability: 'ready',
        },
      }),
    ),
    getWorkItemControls: mock.fn(() =>
      Promise.resolve({
        data: { workItemId: 'wi-1', controls: [], availability: 'ready' },
      }),
    ),
    submitControlAction: mock.fn(() =>
      Promise.resolve({ data: { ok: true } }),
    ),
    discoverControls: mock.fn(() =>
      Promise.resolve({ data: { results: [] } }),
    ),
  } as unknown as MockOpsClient;
}

/**
 * Build a Hono app with operations routes pre-wired.
 * Simulates auth middleware context variables.
 */
function buildTestApp(opsClient: MockOpsClient): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('operatorId' as never, 'test-operator' as never);
    c.set('sessionId' as never, 'test-session-123' as never);
    await next();
  });
  app.route(
    '/',
    createOperationsRoutes({ daemonClient: opsClient as unknown as DaemonOperationsClient }),
  );
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

// ── Unit tests: operations snapshot route ─────────────────────────────────────

describe('Operations snapshot routes (T009/T010 — US1)', () => {
  let mockClient: MockOpsClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockOpsClient();
    app = buildTestApp(mockClient);
  });

  describe('GET /operations/snapshot', () => {
    it('returns operations snapshot from daemon client', async () => {
      const res = await app.request(buildRequest('GET', '/operations/snapshot'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { queue: unknown[]; availability: string };
      assert.ok(Array.isArray(body.queue));
      assert.equal(body.availability, 'empty');
      assert.equal(mockClient.getOperationsSnapshot.mock.callCount(), 1);
    });

    it('passes statusFilter query to daemon client', async () => {
      const res = await app.request(
        buildRequest('GET', '/operations/snapshot?statusFilter=active&statusFilter=waiting'),
      );
      assert.equal(res.status, 200);

      const callArgs = mockClient.getOperationsSnapshot.mock.calls[0].arguments;
      const query = callArgs[0] as { statusFilter?: readonly string[] };
      assert.deepStrictEqual(query.statusFilter, ['active', 'waiting']);
    });

    it('passes limit and cursor query to daemon client', async () => {
      const res = await app.request(
        buildRequest('GET', '/operations/snapshot?limit=25&cursor=abc123'),
      );
      assert.equal(res.status, 200);

      const callArgs = mockClient.getOperationsSnapshot.mock.calls[0].arguments;
      const query = callArgs[0] as { limit?: number; cursor?: string };
      assert.equal(query.limit, 25);
      assert.equal(query.cursor, 'abc123');
    });

    it('returns 400 on invalid limit query param', async () => {
      const res = await app.request(
        buildRequest('GET', '/operations/snapshot?limit=-1'),
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'validation');
    });

    it('returns 400 on invalid statusFilter value', async () => {
      const res = await app.request(
        buildRequest('GET', '/operations/snapshot?statusFilter=invalid_status'),
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'validation');
    });

    it('forwards daemon error response with correct status', async () => {
      const daemonErr: DaemonOperationsResult<never> = {
        error: {
          ok: false,
          code: 'DAEMON_UNREACHABLE',
          category: 'daemon',
          message: 'Daemon unreachable',
        },
      };
      mockClient.getOperationsSnapshot.mock.mockImplementation(() => Promise.resolve(daemonErr));

      const res = await app.request(buildRequest('GET', '/operations/snapshot'));
      assert.equal(res.status, 503);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'daemon');
    });

    it('handles empty query gracefully', async () => {
      const res = await app.request(buildRequest('GET', '/operations/snapshot'));
      assert.equal(res.status, 200);
      assert.equal(mockClient.getOperationsSnapshot.mock.callCount(), 1);
    });
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

describe('Operations route wiring — auth/CSRF (T009/T010)', () => {
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
      daemonClientOptions: { baseUrl: 'http://localhost:4173', fetchFn: fetchMock, timeoutMs: 5000 },
      operationsClientOptions: { baseUrl: 'http://localhost:4173', fetchFn: fetchMock, timeoutMs: 5000 },
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');
  });

  afterEach(() => {
    gw.heartbeat.stop();
    fetchMock.mock.resetCalls();
  });

  it('rejects unauthenticated GET /operations/snapshot', async () => {
    const req = gwRequest('GET', '/operations/snapshot', { headers: { origin: ORIGIN } });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
    assert.equal(body.category, 'auth');
  });

  it('GET /operations/snapshot with valid session succeeds', async () => {
    const cookies = await login(gw);
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            queue: [],
            health: null,
            budget: null,
            availability: 'empty',
            lastSynchronizedAt: null,
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = gwRequest('GET', '/operations/snapshot', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { queue: unknown[] };
    assert.ok(Array.isArray(body.queue));
  });
});
