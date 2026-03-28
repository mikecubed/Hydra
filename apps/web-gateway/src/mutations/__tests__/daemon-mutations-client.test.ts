/**
 * Tests for DaemonMutationsClient.
 *
 * Mirrors DaemonOperationsClient test pattern: mock fetch, verify URL/method/body
 * construction, and error translation for each mutations endpoint.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonMutationsClient } from '../daemon-mutations-client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResponse(body: unknown): Response {
  return jsonResponse(200, body);
}

describe('DaemonMutationsClient', () => {
  const baseUrl = 'http://localhost:4173';
  let fetchMock: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;
  let client: DaemonMutationsClient;

  beforeEach(() => {
    fetchMock = mock.fn<typeof globalThis.fetch>();
    client = new DaemonMutationsClient({ baseUrl, fetchFn: fetchMock, timeoutMs: 5000 });
  });

  afterEach(() => {
    fetchMock.mock.resetCalls();
  });

  describe('getSafeConfig', () => {
    it('sends GET /config/safe', async () => {
      const configData = { config: { routing: { mode: 'economy' } }, revision: 'rev-1' };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(configData)));

      const result = await client.getSafeConfig();

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/config/safe`);
      assert.equal(opts?.method, 'GET');
      assert.ok('data' in result);
      assert.deepStrictEqual(result.data, configData);
    });
  });

  describe('postRoutingMode', () => {
    it('sends POST /config/routing/mode with body', async () => {
      const responseData = {
        snapshot: { routing: { mode: 'balanced' } },
        appliedRevision: 'rev-2',
        timestamp: '2026-03-22T10:00:00.000Z',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(responseData)));

      const body = { mode: 'balanced' as const, expectedRevision: 'rev-1' };
      const result = await client.postRoutingMode(body);

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/config/routing/mode`);
      assert.equal(opts?.method, 'POST');
      const sentBody = JSON.parse(opts?.body as string) as Record<string, unknown>;
      assert.equal(sentBody['mode'], 'balanced');
      assert.equal(sentBody['expectedRevision'], 'rev-1');
      assert.ok('data' in result);
      assert.deepStrictEqual(result.data, responseData);
    });
  });

  describe('postModelTier', () => {
    it('sends POST /config/models/:agent/active with body', async () => {
      const responseData = {
        snapshot: { routing: { mode: 'economy' } },
        appliedRevision: 'rev-3',
        timestamp: '2026-03-22T10:00:00.000Z',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(responseData)));

      const body = { tier: 'fast' as const, expectedRevision: 'rev-2' };
      const result = await client.postModelTier('claude', body);

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/config/models/claude/active`);
      assert.equal(opts?.method, 'POST');
      const sentBody = JSON.parse(opts?.body as string) as Record<string, unknown>;
      assert.equal(sentBody['tier'], 'fast');
      assert.equal(sentBody['expectedRevision'], 'rev-2');
      assert.ok('data' in result);
    });
  });

  describe('postBudget', () => {
    it('sends POST /config/budget with body', async () => {
      const responseData = {
        snapshot: { routing: { mode: 'economy' } },
        appliedRevision: 'rev-4',
        timestamp: '2026-03-22T10:00:00.000Z',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(responseData)));

      const body = {
        modelId: 'claude-opus',
        dailyLimit: 1000,
        weeklyLimit: null,
        expectedRevision: 'rev-3',
      };
      const result = await client.postBudget(body);

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/config/budget`);
      assert.equal(opts?.method, 'POST');
      assert.ok('data' in result);
    });
  });

  describe('error mapping', () => {
    it('daemon 409 with stale-revision → category stale-revision', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse(409, { error: 'stale-revision', message: 'Revision mismatch' }),
        ),
      );

      const result = await client.postRoutingMode({
        mode: 'economy',
        expectedRevision: 'rev-old',
      });

      assert.ok('error' in result);
      assert.equal(result.error.category, 'stale-revision');
    });

    it('daemon 409 with workflow-conflict → category workflow-conflict', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse(409, { error: 'workflow-conflict', message: 'Already running' }),
        ),
      );

      const result = await client.postWorkflowLaunch({
        workflow: 'evolve',
        label: null,
        idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
        expectedRevision: 'rev-1',
      });

      assert.ok('error' in result);
      assert.equal(result.error.category, 'workflow-conflict');
    });

    it('daemon 503 → category daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(jsonResponse(503, { message: 'Service unavailable' })),
      );

      const result = await client.getSafeConfig();

      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon-unavailable');
    });

    it('fetch rejection (network error) → category daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await client.getSafeConfig();

      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon-unavailable');
      assert.equal(result.error.message, 'Daemon unreachable');
    });
  });

  describe('getAudit', () => {
    it('sends GET /audit with query params', async () => {
      const auditData = { records: [], nextCursor: null };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(auditData)));

      const result = await client.getAudit({ limit: 10, cursor: 'abc' });

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url] = fetchMock.mock.calls[0].arguments;
      const parsed = new URL(url as string);
      assert.equal(parsed.pathname, '/audit');
      assert.equal(parsed.searchParams.get('limit'), '10');
      assert.equal(parsed.searchParams.get('cursor'), 'abc');
      assert.ok('data' in result);
    });

    it('sends GET /audit without query when no params', async () => {
      const auditData = { records: [], nextCursor: null };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(auditData)));

      const result = await client.getAudit();

      const [url] = fetchMock.mock.calls[0].arguments;
      const parsed = new URL(url as string);
      assert.equal(parsed.pathname, '/audit');
      assert.equal(parsed.searchParams.toString(), '');
      assert.ok('data' in result);
    });
  });
});
