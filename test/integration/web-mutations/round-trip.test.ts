/**
 * T039-T041 — Round-trip integration tests for web-controlled-mutations.
 *
 * T039: All six mutation/read endpoints; auth guard; audit record creation.
 * T040: Concurrent optimistic-concurrency determinism using the mutex.
 * T041: Audit cursor pagination round-trip (45 records + 1,000-record stress).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { createGatewayApp, type GatewayApp } from '../../../apps/web-gateway/src/index.ts';
import { DaemonMutationsClient } from '../../../apps/web-gateway/src/mutations/daemon-mutations-client.ts';
import type { DaemonMutationsResult } from '../../../apps/web-gateway/src/mutations/daemon-mutations-client.ts';
import { AuditStore } from '../../../apps/web-gateway/src/audit/audit-store.ts';
import {
  GetSafeConfigResponse,
  PatchRoutingModeResponse,
  PatchModelTierResponse,
  PatchBudgetResponse,
  PostWorkflowLaunchResponse,
  GetAuditResponse,
} from '@hydra/web-contracts';
import type {
  GetSafeConfigResponse as GetSafeConfigResponseType,
  PatchRoutingModeResponse as PatchRoutingModeResponseType,
  PostWorkflowLaunchResponse as PostWorkflowLaunchResponseType,
  GetAuditResponse as GetAuditResponseType,
  MutationAuditRecord,
} from '@hydra/web-contracts';
import {
  handleMutationRoute,
  _clearAuditStoreForTest,
  _injectAuditRecordsForTest,
  computeConfigRevision,
} from '../../../lib/daemon/mutation-routes.ts';
import { configMutex } from '../../../lib/daemon/mutation-lock.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORIGIN = 'http://127.0.0.1:4174';

const SAFE_CONFIG_DATA: GetSafeConfigResponseType = {
  config: {
    routing: { mode: 'economy' },
    models: { claude: { default: 'claude-opus-4-6' } },
    usage: {
      dailyTokenBudget: { 'claude-opus-4-6': 1_000_000 },
      weeklyTokenBudget: { 'claude-opus-4-6': 5_000_000 },
    },
  },
  revision: 'rev-abc',
};

const MUTATION_RESPONSE: PatchRoutingModeResponseType = {
  snapshot: {
    routing: { mode: 'balanced' },
    models: {},
    usage: { dailyTokenBudget: {}, weeklyTokenBudget: {} },
  },
  appliedRevision: 'rev-xyz',
  timestamp: '2026-03-28T06:00:00.000Z',
};

const LAUNCH_RESPONSE: PostWorkflowLaunchResponseType = {
  taskId: 'task-integration-001',
  workflow: 'tasks',
  launchedAt: '2026-03-28T06:00:00.000Z',
  destructive: false,
};

function makeMockMutClient(overrides: Partial<DaemonMutationsClient> = {}): DaemonMutationsClient {
  const client = new DaemonMutationsClient({
    baseUrl: 'http://daemon.invalid',
  }) as DaemonMutationsClient & Record<string, unknown>;

  client.getSafeConfig = (): Promise<DaemonMutationsResult<GetSafeConfigResponseType>> =>
    Promise.resolve({ data: SAFE_CONFIG_DATA });
  client.postRoutingMode = (): Promise<DaemonMutationsResult<PatchRoutingModeResponseType>> =>
    Promise.resolve({ data: MUTATION_RESPONSE });
  client.postModelTier = (): Promise<DaemonMutationsResult<PatchRoutingModeResponseType>> =>
    Promise.resolve({ data: MUTATION_RESPONSE });
  client.postBudget = (): Promise<DaemonMutationsResult<PatchRoutingModeResponseType>> =>
    Promise.resolve({ data: MUTATION_RESPONSE });
  client.postWorkflowLaunch = (): Promise<DaemonMutationsResult<PostWorkflowLaunchResponseType>> =>
    Promise.resolve({ data: LAUNCH_RESPONSE });
  client.getAudit = (): Promise<DaemonMutationsResult<GetAuditResponseType>> =>
    Promise.resolve({ data: { records: [], nextCursor: null } });

  for (const [key, val] of Object.entries(overrides)) {
    (client as Record<string, unknown>)[key] = val;
  }
  return client;
}

/** Login helper — returns session + csrf cookie map. */
async function loginGateway(gw: GatewayApp): Promise<Record<string, string>> {
  const req = new Request(`${ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
  });
  const res = await gw.app.request(req);
  assert.equal(res.status, 200, 'login failed');
  const jar: Record<string, string> = {};
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) jar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return jar;
}

function buildAuthRequest(
  method: string,
  path: string,
  cookies: Record<string, string>,
  body?: Record<string, unknown>,
): Request {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      cookie: cookieHeader,
      ...(method === 'GET' ? {} : { 'x-csrf-token': cookies['__csrf'] ?? '' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

// ── T039 ─────────────────────────────────────────────────────────────────────

describe('T039 — Gateway round-trip: all six mutation/read endpoints', () => {
  let gw: GatewayApp;
  let cookies: Record<string, string>;

  before(async () => {
    gw = createGatewayApp({
      allowedOrigin: ORIGIN,
      heartbeatConfig: { intervalMs: 60_000 },
      mutationsClient: makeMockMutClient(),
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');
    cookies = await loginGateway(gw);
  });

  after(() => {
    gw.heartbeat.stop();
  });

  it('GET /config/safe — 200 + schema-valid body', async () => {
    const res = await gw.app.request(buildAuthRequest('GET', '/config/safe', cookies));
    assert.equal(res.status, 200);
    const body = await res.json();
    const parsed = GetSafeConfigResponse.safeParse(body);
    assert.ok(
      parsed.success,
      `GetSafeConfigResponse schema: ${JSON.stringify('error' in parsed ? parsed.error.issues : [])}`,
    );
  });

  it('POST /config/routing/mode — 200 + schema-valid body', async () => {
    const res = await gw.app.request(
      buildAuthRequest('POST', '/config/routing/mode', cookies, {
        mode: 'balanced',
        expectedRevision: 'rev-abc',
      }),
    );
    assert.equal(res.status, 200);
    const parsed = PatchRoutingModeResponse.safeParse(await res.json());
    assert.ok(parsed.success, 'PatchRoutingModeResponse schema failed');
  });

  it('POST /config/models/:agent/active — 200 + schema-valid body', async () => {
    const res = await gw.app.request(
      buildAuthRequest('POST', '/config/models/claude/active', cookies, {
        tier: 'fast',
        expectedRevision: 'rev-abc',
      }),
    );
    assert.equal(res.status, 200);
    const parsed = PatchModelTierResponse.safeParse(await res.json());
    assert.ok(parsed.success, 'PatchModelTierResponse schema failed');
  });

  it('POST /config/usage/budget — 200 + schema-valid body', async () => {
    const res = await gw.app.request(
      buildAuthRequest('POST', '/config/usage/budget', cookies, {
        modelId: 'claude-opus-4-6',
        dailyLimit: 2_000_000,
        weeklyLimit: 10_000_000,
        expectedRevision: 'rev-abc',
      }),
    );
    assert.equal(res.status, 200);
    const parsed = PatchBudgetResponse.safeParse(await res.json());
    assert.ok(parsed.success, 'PatchBudgetResponse schema failed');
  });

  it('POST /workflows/launch — 200/202 + schema-valid body', async () => {
    const res = await gw.app.request(
      buildAuthRequest('POST', '/workflows/launch', cookies, {
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: 'rev-abc',
      }),
    );
    assert.ok(
      res.status === 200 || res.status === 202,
      `Expected 200 or 202; got ${String(res.status)}`,
    );
    const parsed = PostWorkflowLaunchResponse.safeParse(await res.json());
    assert.ok(parsed.success, 'PostWorkflowLaunchResponse schema failed');
  });

  it('GET /audit — 200 + schema-valid body', async () => {
    const res = await gw.app.request(buildAuthRequest('GET', '/audit', cookies));
    assert.equal(res.status, 200);
    const parsed = GetAuditResponse.safeParse(await res.json());
    assert.ok(
      parsed.success,
      `GetAuditResponse schema: ${JSON.stringify('error' in parsed ? parsed.error.issues : [])}`,
    );
  });

  it('POST /config/routing/mode: request body forwarded verbatim to daemon stub', async () => {
    const sentPayload = { mode: 'performance', expectedRevision: 'rev-abc' };
    let capturedBody: unknown;

    const overriddenClient = makeMockMutClient({
      postRoutingMode(body: unknown) {
        capturedBody = body;
        return Promise.resolve({ data: MUTATION_RESPONSE });
      },
    });
    const gw2 = createGatewayApp({
      allowedOrigin: ORIGIN,
      heartbeatConfig: { intervalMs: 60_000 },
      mutationsClient: overriddenClient,
    });
    try {
      await gw2.operatorStore.createOperator('admin', 'Admin');
      await gw2.operatorStore.addCredential('admin', 'password123');
      const cookies2 = await loginGateway(gw2);
      await gw2.app.request(
        buildAuthRequest('POST', '/config/routing/mode', cookies2, sentPayload),
      );
      assert.deepStrictEqual(capturedBody, sentPayload);
    } finally {
      gw2.heartbeat.stop();
    }
  });

  it('POST /config/routing/mode: auditService.record invoked before response (SEC-06)', async () => {
    // Inject a custom auditStore so we can inspect records after the mutation.
    // createGatewayApp accepts auditStore? in its deps and wires it through AuditService.
    const auditStore = new AuditStore(null);
    const gw2 = createGatewayApp({
      allowedOrigin: ORIGIN,
      heartbeatConfig: { intervalMs: 60_000 },
      mutationsClient: makeMockMutClient(),
      auditStore,
    });
    try {
      await gw2.operatorStore.createOperator('admin', 'Admin');
      await gw2.operatorStore.addCredential('admin', 'password123');
      const cookies2 = await loginGateway(gw2);
      const res = await gw2.app.request(
        buildAuthRequest('POST', '/config/routing/mode', cookies2, {
          mode: 'balanced',
          expectedRevision: 'rev-abc',
        }),
      );
      assert.equal(res.status, 200);

      // By the time await resolves, the handler has completed and the audit must be written.
      const records = auditStore.getRecords();
      assert.ok(records.length > 0, 'Expected at least one audit record after successful mutation');
      assert.ok(
        records.some((r) => r.eventType === 'config.routing.mode.changed'),
        `Expected 'config.routing.mode.changed' audit record; got: ${JSON.stringify(records.map((r) => r.eventType))}`,
      );
    } finally {
      gw2.heartbeat.stop();
    }
  });

  it('POST /config/routing/mode: 401 when no session cookie', async () => {
    const req = new Request(`${ORIGIN}/config/routing/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 401);
  });

  it('POST /config/routing/mode: 403 when CSRF token absent', async () => {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const req = new Request(`${ORIGIN}/config/routing/mode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: cookieHeader,
        // No x-csrf-token header
      },
      body: JSON.stringify({ mode: 'balanced', expectedRevision: 'rev-1' }),
    });
    const res = await gw.app.request(req);
    assert.equal(res.status, 403);
  });
});

// ── T040 ─────────────────────────────────────────────────────────────────────

describe('T040 — Concurrent optimistic-concurrency determinism', () => {
  /**
   * In-process "test daemon" using the real configMutex.
   * Simulates lib/daemon/mutation-routes.ts revision-check pattern without file I/O.
   */
  let currentRevision = 'rev-t040-initial';

  async function submitMutation(expectedRevision: string): Promise<number> {
    const release = await configMutex.acquire();
    try {
      if (expectedRevision !== currentRevision) return 409;
      // Yield so the other microtask can observe the locked state
      await Promise.resolve();
      currentRevision = computeConfigRevision({ routing: { mode: currentRevision } });
      return 200;
    } finally {
      release();
    }
  }

  beforeEach(() => {
    currentRevision = 'rev-t040-initial';
  });

  it('exactly one 200 and one 409 when two concurrent requests share the same expectedRevision', async () => {
    const [r1, r2] = await Promise.all([
      submitMutation('rev-t040-initial'),
      submitMutation('rev-t040-initial'),
    ]);
    assert.deepStrictEqual(
      [r1, r2].sort((a, b) => a - b),
      [200, 409],
    );
  });

  it('deterministic: 1-success / 1-fail across 10 consecutive runs', async () => {
    for (let run = 0; run < 10; run++) {
      const seed = `rev-run-${String(run)}`;
      currentRevision = seed;
      const [r1, r2] = await Promise.all([submitMutation(seed), submitMutation(seed)]);
      assert.deepStrictEqual(
        [r1, r2].sort((a, b) => a - b),
        [200, 409],
        `Run ${String(run + 1)}: expected [200, 409] got [${String(r1)}, ${String(r2)}]`,
      );
    }
  });
});

// ── T041 ─────────────────────────────────────────────────────────────────────

describe('T041 — Audit cursor pagination round-trip', () => {
  let daemonServer: http.Server;
  let daemonBaseUrl: string;

  function makeAuditRecord(index: number): MutationAuditRecord {
    // Evenly spaced timestamps guarantee deterministic cursor ordering
    const ts = new Date(1_740_000_000_000 + index * 1_000).toISOString();
    return {
      id: `rec-${String(index).padStart(6, '0')}`,
      timestamp: ts,
      eventType: 'config.routing.mode.changed',
      operatorId: `op-${String(index)}`,
      sessionId: `sess-${String(index)}`,
      targetField: 'routing.mode',
      beforeValue: 'auto',
      afterValue: 'economy',
      outcome: 'success',
      rejectionReason: null,
      sourceIp: '127.0.0.1',
    };
  }

  before(async () => {
    const port = await getFreePort();
    daemonServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
      void handleMutationRoute(req, res, url).then((handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      daemonServer.listen(port, '127.0.0.1', resolve);
    });
    daemonBaseUrl = `http://127.0.0.1:${String(port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      daemonServer.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  afterEach(() => {
    _clearAuditStoreForTest();
  });

  async function fetchAuditPage(cursor?: string, limit = 20): Promise<GetAuditResponseType> {
    const url = new URL('/audit', daemonBaseUrl);
    url.searchParams.set('limit', String(limit));
    if (cursor != null) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString());
    assert.equal(res.status, 200);
    return (await res.json()) as GetAuditResponseType;
  }

  it('45 records: paginates correctly across 3 pages (20 + 20 + 5)', async () => {
    _injectAuditRecordsForTest(Array.from({ length: 45 }, (_, i) => makeAuditRecord(i)));

    const page1 = await fetchAuditPage();
    assert.equal(page1.records.length, 20, 'page 1 should have 20 records');
    assert.notEqual(page1.nextCursor, null, 'page 1 should have nextCursor');

    const page2 = await fetchAuditPage(page1.nextCursor!);
    assert.equal(page2.records.length, 20, 'page 2 should have 20 records');
    assert.notEqual(page2.nextCursor, null, 'page 2 should have nextCursor');

    const ids1 = new Set(page1.records.map((r) => r.id));
    for (const r of page2.records) {
      assert.ok(!ids1.has(r.id), `Duplicate record ${r.id} found in page 2`);
    }

    const page3 = await fetchAuditPage(page2.nextCursor!);
    assert.equal(page3.records.length, 5, 'page 3 should have 5 records');
    assert.equal(page3.nextCursor, null, 'page 3 should have no nextCursor');

    const allIds = new Set([
      ...page1.records.map((r) => r.id),
      ...page2.records.map((r) => r.id),
      ...page3.records.map((r) => r.id),
    ]);
    assert.equal(allIds.size, 45, `Total unique records should be 45; got ${String(allIds.size)}`);
  });

  it('1,000-record stress: all 50 pages with no duplicates or dropped records', async () => {
    _injectAuditRecordsForTest(Array.from({ length: 1_000 }, (_, i) => makeAuditRecord(i)));

    const seenIds = new Set<string>();
    let cursor: string | null | undefined;
    let pageCount = 0;

    do {
      const page = await fetchAuditPage(cursor ?? undefined);
      for (const r of page.records) {
        assert.ok(!seenIds.has(r.id), `Duplicate record ${r.id} on page ${String(pageCount + 1)}`);
        seenIds.add(r.id);
      }
      cursor = page.nextCursor;
      pageCount++;
      if (pageCount > 60) {
        assert.fail('Infinite pagination: exceeded 60 pages');
        break;
      }
    } while (cursor != null);

    assert.equal(seenIds.size, 1_000, `Expected 1,000 unique records; got ${String(seenIds.size)}`);
    assert.equal(pageCount, 50, `Expected 50 pages; got ${String(pageCount)}`);
  });
});
