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
import type {
  DaemonOperationsClient as DaemonOperationsClientShape,
  DaemonOperationsResult,
} from '../daemon-operations-client.ts';
import { DaemonOperationsClient } from '../daemon-operations-client.ts';
import type { OperationalControlView, WorkQueueItemView } from '@hydra/web-contracts';
import { createOperationsRoutes } from '../operations-routes.ts';
import type { GatewayErrorResponse } from '../../shared/gateway-error-response.ts';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';

const ORIGIN = 'http://127.0.0.1:4174';
const NOW = '2026-03-22T10:00:00.000Z';

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockOpsClient = DaemonOperationsClient & {
  getOperationsSnapshot: ReturnType<
    typeof mock.fn<DaemonOperationsClientShape['getOperationsSnapshot']>
  >;
  getWorkItemDetail: ReturnType<typeof mock.fn<DaemonOperationsClientShape['getWorkItemDetail']>>;
  getWorkItemCheckpoints: ReturnType<
    typeof mock.fn<DaemonOperationsClientShape['getWorkItemCheckpoints']>
  >;
  getWorkItemExecution: ReturnType<
    typeof mock.fn<DaemonOperationsClientShape['getWorkItemExecution']>
  >;
  getWorkItemControls: ReturnType<
    typeof mock.fn<DaemonOperationsClientShape['getWorkItemControls']>
  >;
  submitControlAction: ReturnType<
    typeof mock.fn<DaemonOperationsClientShape['submitControlAction']>
  >;
  discoverControls: ReturnType<typeof mock.fn<DaemonOperationsClientShape['discoverControls']>>;
};

function makeQueueItem(overrides: Partial<WorkQueueItemView> = {}): WorkQueueItemView {
  return {
    id: 'wi-1',
    title: 'Item',
    status: 'active',
    position: 0,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: null,
    lastCheckpointSummary: null,
    updatedAt: NOW,
    riskSignals: [],
    detailAvailability: 'ready',
    ...overrides,
  };
}

function makeControl(overrides: Partial<OperationalControlView> = {}): OperationalControlView {
  return {
    controlId: 'ctrl-1',
    kind: 'routing',
    label: 'Route override',
    availability: 'actionable',
    authority: 'granted',
    reason: null,
    options: [],
    expectedRevision: 'rev-1',
    lastResolvedAt: null,
    ...overrides,
  };
}

function createMockOpsClient(): MockOpsClient {
  const client = new DaemonOperationsClient({ baseUrl: 'http://daemon.invalid' }) as MockOpsClient;
  client.getOperationsSnapshot = mock.fn<DaemonOperationsClientShape['getOperationsSnapshot']>(() =>
    Promise.resolve({
      data: {
        queue: [],
        availability: 'empty',
        health: null,
        lastSynchronizedAt: null,
        budget: null,
        nextCursor: null,
      },
    }),
  );
  client.getWorkItemDetail = mock.fn<DaemonOperationsClientShape['getWorkItemDetail']>(() =>
    Promise.resolve({
      data: {
        item: makeQueueItem(),
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [makeControl()],
        itemBudget: null,
        availability: 'ready',
      },
    }),
  );
  client.getWorkItemCheckpoints = mock.fn<DaemonOperationsClientShape['getWorkItemCheckpoints']>(
    () =>
      Promise.resolve({
        data: { workItemId: 'wi-1', checkpoints: [], availability: 'ready' },
      }),
  );
  client.getWorkItemExecution = mock.fn<DaemonOperationsClientShape['getWorkItemExecution']>(() =>
    Promise.resolve({
      data: {
        workItemId: 'wi-1',
        routing: null,
        assignments: [],
        council: null,
        availability: 'ready',
      },
    }),
  );
  client.getWorkItemControls = mock.fn<DaemonOperationsClientShape['getWorkItemControls']>(() =>
    Promise.resolve({
      data: { workItemId: 'wi-1', controls: [makeControl()], availability: 'ready' },
    }),
  );
  client.submitControlAction = mock.fn<DaemonOperationsClientShape['submitControlAction']>(() =>
    Promise.resolve({
      data: {
        outcome: 'accepted',
        control: makeControl({ availability: 'accepted', lastResolvedAt: NOW }),
        workItemId: 'wi-1',
        resolvedAt: NOW,
      },
    }),
  );
  client.discoverControls = mock.fn<DaemonOperationsClientShape['discoverControls']>(() =>
    Promise.resolve({
      data: {
        items: [{ workItemId: 'wi-1', controls: [makeControl()], availability: 'ready' }],
      },
    }),
  );
  return client;
}

/**
 * Build a Hono app with operations routes pre-wired.
 * Simulates auth middleware context variables.
 */
function buildTestApp(opsClient: DaemonOperationsClient): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('operatorId' as never, 'test-operator' as never);
    c.set('sessionId' as never, 'test-session-123' as never);
    await next();
  });
  app.route('/', createOperationsRoutes({ daemonClient: opsClient }));
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
      const res = await app.request(buildRequest('GET', '/operations/snapshot?limit=-1'));
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

// ── Unit tests: work-item detail route (T018/T019 — US2) ──────────────────────

describe('Work-item detail routes (T018/T019 — US2)', () => {
  let mockClient: MockOpsClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockOpsClient();
    app = buildTestApp(mockClient);
  });

  describe('GET /operations/work-items/:workItemId', () => {
    it('returns work-item detail from daemon client', async () => {
      const res = await app.request(buildRequest('GET', '/operations/work-items/wi-1'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { item: { id: string }; availability: string };
      assert.equal(body.item.id, 'wi-1');
      assert.equal(body.availability, 'ready');
      assert.equal(mockClient.getWorkItemDetail.mock.callCount(), 1);
    });

    it('passes decoded workItemId to daemon client', async () => {
      const res = await app.request(buildRequest('GET', '/operations/work-items/wi-1'));
      assert.equal(res.status, 200);
      const callArgs = mockClient.getWorkItemDetail.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'wi-1');
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
      mockClient.getWorkItemDetail.mock.mockImplementation(() => Promise.resolve(daemonErr));

      const res = await app.request(buildRequest('GET', '/operations/work-items/wi-1'));
      assert.equal(res.status, 503);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'daemon');
    });

    it('returns 404 for empty workItemId', async () => {
      const res = await app.request(buildRequest('GET', '/operations/work-items/'));
      assert.equal(res.status, 404);
    });

    it('returns full detail payload including checkpoints and controls', async () => {
      const detail = {
        item: makeQueueItem({ id: 'wi-42' }),
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [makeControl()],
        itemBudget: null,
        availability: 'ready' as const,
      };
      mockClient.getWorkItemDetail.mock.mockImplementation(() => Promise.resolve({ data: detail }));

      const res = await app.request(buildRequest('GET', '/operations/work-items/wi-42'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as typeof detail;
      assert.equal(body.item.id, 'wi-42');
      assert.equal(body.controls.length, 1);
    });

    it('handles URL-encoded workItemId with special characters', async () => {
      const res = await app.request(buildRequest('GET', '/operations/work-items/task%2F123'));
      assert.equal(res.status, 200);
      const callArgs = mockClient.getWorkItemDetail.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'task/123');
    });

    it('returns daemon 404 error as validation category', async () => {
      const daemonErr: DaemonOperationsResult<never> = {
        error: {
          ok: false,
          code: 'NOT_FOUND',
          category: 'validation',
          message: 'Work item not found',
          httpStatus: 404,
        },
      };
      mockClient.getWorkItemDetail.mock.mockImplementation(() => Promise.resolve(daemonErr));

      const res = await app.request(buildRequest('GET', '/operations/work-items/nonexistent'));
      assert.equal(res.status, 404);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'validation');
      assert.equal(body.code, 'NOT_FOUND');
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
      daemonClientOptions: {
        baseUrl: 'http://localhost:4173',
        fetchFn: fetchMock,
        timeoutMs: 5000,
      },
      operationsClientOptions: {
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

  it('rejects unauthenticated GET /operations/work-items/:workItemId', async () => {
    const req = gwRequest('GET', '/operations/work-items/wi-1', { headers: { origin: ORIGIN } });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_NOT_FOUND');
    assert.equal(body.category, 'auth');
  });

  it('GET /operations/work-items/:workItemId with valid session succeeds', async () => {
    const cookies = await login(gw);
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            item: {
              id: 'wi-1',
              title: 'Test Item',
              status: 'active',
              position: 0,
              relatedConversationId: null,
              relatedSessionId: null,
              ownerLabel: null,
              lastCheckpointSummary: null,
              updatedAt: NOW,
              riskSignals: [],
              detailAvailability: 'ready',
            },
            checkpoints: [],
            routing: null,
            assignments: [],
            council: null,
            controls: [],
            itemBudget: null,
            availability: 'ready',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = gwRequest('GET', '/operations/work-items/wi-1', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item: { id: string }; availability: string };
    assert.equal(body.item.id, 'wi-1');
    assert.equal(body.availability, 'ready');
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
    const validateMock = mock.method(gw.sessionService, 'validate');
    const touchActivityMock = mock.method(gw.sessionService, 'touchActivity');
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
    assert.equal(validateMock.mock.callCount(), 1);
    assert.equal(touchActivityMock.mock.callCount(), 1);
  });
});
