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
import type {
  GetSafeConfigResponse,
  PatchRoutingModeResponse,
  PostWorkflowLaunchResponse,
  GetAuditResponse,
} from '@hydra/web-contracts';
import { createMutationsRouter } from '../mutations-routes.ts';
import {
  createGatewayErrorResponse,
  type GatewayErrorResponse,
} from '../../shared/gateway-error-response.ts';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';
import { AuditStore } from '../../audit/audit-store.ts';
import { AuditService } from '../../audit/audit-service.ts';

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
  app.route('/', createMutationsRouter(mutClient));
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

// ── Unit tests: GET /config/safe ────────────────────────────────────

describe('Mutations routes — GET /config/safe (T013)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 with safe config data', async () => {
    const res = await app.request(buildRequest('GET', '/config/safe'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as GetSafeConfigResponse;
    assert.equal(body.revision, 'rev-1');
    assert.deepStrictEqual(body.config, { routing: { mode: 'economy' } });
  });

  it('returns 503 when daemon is unavailable', async () => {
    mockClient.getSafeConfig.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'DAEMON_UNAVAILABLE',
          category: 'daemon-unavailable',
          message: 'Daemon unreachable',
        }),
      } as DaemonMutationsResult<GetSafeConfigResponse>),
    );

    const res = await app.request(buildRequest('GET', '/config/safe'));
    assert.equal(res.status, 503);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'daemon-unavailable');
    assert.ok(body.message.includes('Daemon unreachable'));
  });
});

// ── Unit tests: POST /config/routing/mode ───────────────────────────

describe('Mutations routes — POST /config/routing/mode (T013)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 with mutation response on valid body', async () => {
    const body = { mode: 'balanced', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/config/routing/mode', {
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
      buildRequest('POST', '/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postRoutingMode.mock.callCount(), 0);
  });

  it('returns 400 on missing expectedRevision', async () => {
    const body = { mode: 'economy' };
    const res = await app.request(
      buildRequest('POST', '/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postRoutingMode.mock.callCount(), 0);
  });

  it('returns 400 on empty/null body', async () => {
    const res = await app.request(buildRequest('POST', '/config/routing/mode', { body: '' }));
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
      buildRequest('POST', '/config/routing/mode', {
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 409);
    const data = (await res.json()) as GatewayErrorResponse;
    assert.equal(data.ok, false);
    assert.equal(data.category, 'stale-revision');
    assert.ok(data.message.includes('reload and retry'));
  });

  it('returns 503 when daemon is unavailable', async () => {
    mockClient.postRoutingMode.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'DAEMON_UNAVAILABLE',
          category: 'daemon-unavailable',
          message: 'Daemon unreachable',
        }),
      } as DaemonMutationsResult<PatchRoutingModeResponse>),
    );

    const body = { mode: 'balanced', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/config/routing/mode', {
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

  it('rejects unauthenticated GET /config/safe with 401', async () => {
    const req = gwRequest('GET', '/config/safe', { headers: { origin: ORIGIN } });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.category, 'auth');
  });

  it('GET /config/safe with valid session succeeds', async () => {
    const cookies = await login(gw);

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ config: { routing: { mode: 'economy' } }, revision: 'rev-1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const req = gwRequest('GET', '/config/safe', {
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
  });

  it('POST /config/routing/mode missing CSRF → 403', async () => {
    const cookies = await login(gw);

    const req = gwRequest('POST', '/config/routing/mode', {
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'] },
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 403);
  });

  it('POST /config/routing/mode with expired session → 401', async () => {
    const cookies = await login(gw);

    // Advance clock past session lifetime
    clock.advance(3700_000);

    const req = gwRequest('POST', '/config/routing/mode', {
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
  });

  it('POST /config/routing/mode with valid session and CSRF → calls daemon', async () => {
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

    const req = gwRequest('POST', '/config/routing/mode', {
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
      cookies: { __session: cookies['__session'], __csrf: cookies['__csrf'] },
      headers: { origin: ORIGIN, 'x-csrf-token': cookies['__csrf'] },
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { appliedRevision: string };
    assert.equal(body.appliedRevision, 'rev-2');
  });

  it('POST /config/routing/mode with invalid mode → 400 (daemon never called)', async () => {
    const cookies = await login(gw);

    const req = gwRequest('POST', '/config/routing/mode', {
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

// ── Unit tests: POST /config/models/:agent/active (T019) ─────────────────────

describe('Mutations routes — POST /config/models/:agent/active (T019)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 with mutation response on valid body', async () => {
    const body = { tier: 'fast', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/config/models/claude/active', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 200);
    assert.equal(mockClient.postModelTier.mock.callCount(), 1);
    const [agentArg, bodyArg] = mockClient.postModelTier.mock.calls[0].arguments;
    assert.equal(agentArg, 'claude');
    assert.deepStrictEqual(bodyArg, { tier: 'fast', expectedRevision: 'rev-1' });
  });

  it('returns 400 for unknown agent (T019-AC1)', async () => {
    const body = { tier: 'fast', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/config/models/unknown-bot/active', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postModelTier.mock.callCount(), 0);
  });

  it('returns 400 for invalid tier value', async () => {
    const body = { tier: 'turbo', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/config/models/claude/active', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postModelTier.mock.callCount(), 0);
  });

  it('returns 401 for unauthenticated request via gateway app', async () => {
    const gw = createGatewayApp({ allowedOrigin: ORIGIN, heartbeatConfig: { intervalMs: 60_000 } });
    const req = new Request(`${ORIGIN}/config/models/claude/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ tier: 'fast', expectedRevision: 'rev-1' }),
    });
    const res = await gw.app.request(req);
    gw.heartbeat.stop();
    assert.equal(res.status, 401);
  });

  it('returns 409 when daemon returns stale-revision', async () => {
    mockClient.postModelTier.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'STALE_REVISION',
          category: 'stale-revision',
          message: 'Revision mismatch',
          httpStatus: 409,
        }),
      } as DaemonMutationsResult<PatchRoutingModeResponse>),
    );
    const body = { tier: 'cheap', expectedRevision: 'rev-old' };
    const res = await app.request(
      buildRequest('POST', '/config/models/gemini/active', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 409);
  });
});

// ── Unit tests: POST /config/usage/budget (T019) ─────────────────────────────

describe('Mutations routes — POST /config/usage/budget (T019)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 on valid body', async () => {
    const body = {
      modelId: 'claude-opus-4',
      dailyLimit: 100_000,
      weeklyLimit: 500_000,
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/config/usage/budget', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 200);
    assert.equal(mockClient.postBudget.mock.callCount(), 1);
  });

  it('returns 400 for non-positive dailyLimit (T019-AC2)', async () => {
    const body = {
      modelId: 'claude-opus-4',
      dailyLimit: -1,
      weeklyLimit: 100_000,
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/config/usage/budget', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postBudget.mock.callCount(), 0);
  });

  it('returns 400 when both limits are null', async () => {
    const body = {
      modelId: 'claude-opus-4',
      dailyLimit: null,
      weeklyLimit: null,
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/config/usage/budget', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postBudget.mock.callCount(), 0);
  });

  it('returns 401 for unauthenticated request via gateway app', async () => {
    const gw = createGatewayApp({ allowedOrigin: ORIGIN, heartbeatConfig: { intervalMs: 60_000 } });
    const req = new Request(`${ORIGIN}/config/usage/budget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        modelId: 'x',
        dailyLimit: 100,
        weeklyLimit: null,
        expectedRevision: 'rev-1',
      }),
    });
    const res = await gw.app.request(req);
    gw.heartbeat.stop();
    assert.equal(res.status, 401);
  });
});

// ── Unit tests: POST /workflows/launch (T019) ─────────────────────────────────

describe('Mutations routes — POST /workflows/launch (T019)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 202 on valid workflow launch', async () => {
    mockClient.postWorkflowLaunch.mock.mockImplementation(() =>
      Promise.resolve({
        data: {
          taskId: 'task-abc',
          workflow: 'evolve' as const,
          launchedAt: '2026-03-28T04:00:00.000Z',
          destructive: true,
        },
      } as DaemonMutationsResult<PostWorkflowLaunchResponse>),
    );
    const body = {
      workflow: 'evolve',
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/workflows/launch', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 202);
    const data = (await res.json()) as PostWorkflowLaunchResponse;
    assert.equal(data.destructive, true);
  });

  it('returns 400 for unknown workflow name (T019-AC3)', async () => {
    const body = {
      workflow: 'unknown-workflow',
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/workflows/launch', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postWorkflowLaunch.mock.callCount(), 0);
  });

  it('returns 400 for missing idempotencyKey', async () => {
    const body = { workflow: 'tasks', expectedRevision: 'rev-1' };
    const res = await app.request(
      buildRequest('POST', '/workflows/launch', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    assert.equal(mockClient.postWorkflowLaunch.mock.callCount(), 0);
  });

  it('returns 409 when daemon returns workflow-conflict (T019-AC4)', async () => {
    mockClient.postWorkflowLaunch.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'WORKFLOW_CONFLICT',
          category: 'workflow-conflict',
          message: 'Workflow already running',
          httpStatus: 409,
        }),
      } as DaemonMutationsResult<PostWorkflowLaunchResponse>),
    );
    const body = {
      workflow: 'nightly',
      idempotencyKey: '00000000-0000-4000-8000-000000000003',
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/workflows/launch', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 409);
  });
});

// ── Unit tests: GET /audit (T019) ─────────────────────────────────────────────

describe('Mutations routes — GET /audit (T019)', () => {
  let mockClient: MockMutClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    app = buildTestApp(mockClient);
  });

  it('returns 200 with empty records by default', async () => {
    const res = await app.request(buildRequest('GET', '/audit'));
    assert.equal(res.status, 200);
    const data = (await res.json()) as GetAuditResponse;
    assert.deepStrictEqual(data.records, []);
    assert.equal(data.nextCursor, null);
  });

  it('passes limit and cursor query params to daemon (T019-AC9)', async () => {
    const res = await app.request(buildRequest('GET', '/audit?limit=5&cursor=abc123'));
    assert.equal(res.status, 200);
    assert.equal(mockClient.getAudit.mock.callCount(), 1);
    const [params] = mockClient.getAudit.mock.calls[0].arguments;
    assert.equal(params?.limit, 5);
    assert.equal(params?.cursor, 'abc123');
  });

  it('returns 503 when daemon is unavailable (T019-AC10)', async () => {
    mockClient.getAudit.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'DAEMON_UNAVAILABLE',
          category: 'daemon-unavailable',
          message: 'Daemon unreachable',
        }),
      } as DaemonMutationsResult<GetAuditResponse>),
    );
    const res = await app.request(buildRequest('GET', '/audit'));
    assert.equal(res.status, 503);
  });

  it('returns 401 for unauthenticated request via gateway app', async () => {
    const gw = createGatewayApp({ allowedOrigin: ORIGIN, heartbeatConfig: { intervalMs: 60_000 } });
    const req = new Request(`${ORIGIN}/audit`, {
      method: 'GET',
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(req);
    gw.heartbeat.stop();
    assert.equal(res.status, 401);
  });
});

// ── Rate limit tests (T019 T-3 coverage) ─────────────────────────────────────

describe('Mutations route wiring — rate limit (T019 T-3)', () => {
  let gw: GatewayApp;
  let clock: FakeClock;
  let fetchMock: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;

  beforeEach(async () => {
    clock = new FakeClock(Date.now());
    fetchMock = mock.fn<typeof globalThis.fetch>();
    gw = createGatewayApp({
      clock,
      allowedOrigin: ORIGIN,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 3600_000,
        warningThresholdMs: 600_000,
        maxExtensions: 3,
        extensionDurationMs: 3600_000,
        idleTimeoutMs: 1800_000,
      },
      mutationsClientOptions: {
        baseUrl: 'http://localhost:4173',
        fetchFn: fetchMock,
        timeoutMs: 5000,
      },
      daemonClientOptions: {
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

  it('POST mutations return 429 when rate limited', async () => {
    // Log in to get cookies
    const loginReq = new Request(`${ORIGIN}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
    });
    const loginRes = await gw.app.request(loginReq);
    assert.equal(loginRes.status, 200);
    const jar: Record<string, string> = {};
    for (const sc of loginRes.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) jar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }

    // Exhaust the rate limiter by sending 31 requests (limit is 30)
    const exhaustBody = JSON.stringify({ mode: 'economy', expectedRevision: 'rev-1' });
    for (let i = 0; i < 31; i++) {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
      );
      await gw.app.request(
        new Request(`${ORIGIN}/config/routing/mode`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            'x-csrf-token': jar['__csrf'],
            cookie: `__session=${jar['__session']}; __csrf=${jar['__csrf']}`,
          },
          body: exhaustBody,
        }),
      );
    }

    // 32nd request should be rate-limited
    const res = await gw.app.request(
      new Request(`${ORIGIN}/config/routing/mode`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-csrf-token': jar['__csrf'],
          cookie: `__session=${jar['__session']}; __csrf=${jar['__csrf']}`,
        },
        body: exhaustBody,
      }),
    );
    assert.equal(res.status, 429);
  });
});

// ── T019b: Rejected-attempt audit coverage ────────────────────────────────────

describe('Mutations routes — rejected-attempt audit coverage (T019b)', () => {
  let mockClient: MockMutClient;
  let auditStore: AuditStore;
  let auditService: AuditService;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockMutClient();
    auditStore = new AuditStore(null);
    auditService = new AuditService(auditStore, new FakeClock(Date.now()));
    const appInner = new Hono();
    appInner.use('*', async (c, next) => {
      c.set('operatorId' as never, 'test-op' as never);
      c.set('sessionId' as never, 'test-sess' as never);
      await next();
    });
    appInner.route('/', createMutationsRouter(mockClient, auditService));
    app = appInner;
  });

  it('writes audit record on validation failure (T019b-AC3)', async () => {
    const body = { mode: 'turbo', expectedRevision: 'rev-1' }; // invalid mode
    const res = await app.request(
      buildRequest('POST', '/config/routing/mode', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    const records = auditStore.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'failure');
    assert.equal(records[0].eventType, 'config.mutation.rejected');
  });

  it('writes audit record on workflow validation failure', async () => {
    const body = {
      workflow: 'badname',
      idempotencyKey: '00000000-0000-4000-8000-000000000099',
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/workflows/launch', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 400);
    const records = auditStore.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].eventType, 'workflow.launch.rejected');
    assert.equal(records[0].outcome, 'failure');
  });

  it('writes audit record on daemon error for budget mutation', async () => {
    mockClient.postBudget.mock.mockImplementation(() =>
      Promise.resolve({
        error: createGatewayErrorResponse({
          code: 'DAEMON_UNAVAILABLE',
          category: 'daemon-unavailable',
          message: 'Daemon unreachable',
        }),
      } as DaemonMutationsResult<PatchRoutingModeResponse>),
    );
    const body = {
      modelId: 'claude-opus-4',
      dailyLimit: 100,
      weeklyLimit: null,
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/config/usage/budget', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 503);
    const records = auditStore.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'failure');
  });

  it('writes audit record on successful workflow launch', async () => {
    mockClient.postWorkflowLaunch.mock.mockImplementation(() =>
      Promise.resolve({
        data: {
          taskId: 'tid-1',
          workflow: 'tasks' as const,
          launchedAt: '2026-03-28T04:00:00.000Z',
          destructive: false,
        },
      } as DaemonMutationsResult<PostWorkflowLaunchResponse>),
    );
    const body = {
      workflow: 'tasks',
      idempotencyKey: '00000000-0000-4000-8000-000000000004',
      expectedRevision: 'rev-1',
    };
    const res = await app.request(
      buildRequest('POST', '/workflows/launch', { body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 202);
    const records = auditStore.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].eventType, 'workflow.launched');
    assert.equal(records[0].outcome, 'success');
  });
});
