/**
 * Tests for DaemonOperationsClient (T009 — US1 queue visibility).
 *
 * Mirrors the DaemonClient test pattern: mock fetch, verify URL/method/query
 * construction, and error translation for each operations endpoint.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonOperationsClient } from '../daemon-operations-client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResponse(body: unknown): Response {
  return jsonResponse(200, body);
}

function daemonError(
  status: number,
  error: string,
  message: string,
): Response {
  return jsonResponse(status, { ok: false, error, message });
}

describe('DaemonOperationsClient', () => {
  const baseUrl = 'http://localhost:4173';
  let fetchMock: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;
  let client: DaemonOperationsClient;

  beforeEach(() => {
    fetchMock = mock.fn<typeof globalThis.fetch>();
    client = new DaemonOperationsClient({ baseUrl, fetchFn: fetchMock, timeoutMs: 5000 });
  });

  afterEach(() => {
    fetchMock.mock.resetCalls();
  });

  // ─── Configuration ──────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('strips trailing slash from baseUrl', () => {
      const c = new DaemonOperationsClient({ baseUrl: 'http://localhost:4173/', fetchFn: fetchMock });
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ queue: [] })));
      void c.getOperationsSnapshot();
      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok(!(url as string).includes('//operations'));
    });

    it('uses default timeout of 5000ms', () => {
      const c = new DaemonOperationsClient({ baseUrl, fetchFn: fetchMock });
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ queue: [] })));
      void c.getOperationsSnapshot();
      assert.equal(fetchMock.mock.callCount(), 1);
      const callArgs = fetchMock.mock.calls[0].arguments;
      assert.ok(callArgs[1]?.signal, 'Should pass AbortSignal');
    });

    it('accepts custom timeout', () => {
      const c = new DaemonOperationsClient({ baseUrl, fetchFn: fetchMock, timeoutMs: 10_000 });
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ queue: [] })));
      void c.getOperationsSnapshot();
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  });

  // ─── getOperationsSnapshot (US1 — queue visibility) ─────────────────────────

  describe('getOperationsSnapshot', () => {
    it('sends GET /operations/snapshot with no query params by default', async () => {
      const snapshot = {
        queue: [],
        health: null,
        budget: null,
        availability: 'empty',
        lastSynchronizedAt: null,
        nextCursor: null,
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(snapshot)));

      const result = await client.getOperationsSnapshot();

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/operations/snapshot`);
      assert.equal(opts?.method, 'GET');
      assert.ok('data' in result);
      assert.deepStrictEqual(result.data, snapshot);
    });

    it('appends statusFilter as repeated query params', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          okResponse({
            queue: [],
            health: null,
            budget: null,
            availability: 'empty',
            lastSynchronizedAt: null,
            nextCursor: null,
          }),
        ),
      );

      await client.getOperationsSnapshot({ statusFilter: ['active', 'waiting'] });

      const [url] = fetchMock.mock.calls[0].arguments;
      const parsed = new URL(url as string);
      const filters = parsed.searchParams.getAll('statusFilter');
      assert.deepStrictEqual(filters, ['active', 'waiting']);
    });

    it('appends limit and cursor when provided', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          okResponse({
            queue: [],
            health: null,
            budget: null,
            availability: 'empty',
            lastSynchronizedAt: null,
            nextCursor: null,
          }),
        ),
      );

      await client.getOperationsSnapshot({ limit: 25, cursor: 'abc123' });

      const [url] = fetchMock.mock.calls[0].arguments;
      const parsed = new URL(url as string);
      assert.equal(parsed.searchParams.get('limit'), '25');
      assert.equal(parsed.searchParams.get('cursor'), 'abc123');
    });

    it('returns translated error on daemon 5xx', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(500, 'INTERNAL_ERROR', 'Server error')),
      );

      const result = await client.getOperationsSnapshot();
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
    });

    it('returns translated error on daemon 404', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(404, 'NOT_FOUND', 'Endpoint not found')),
      );

      const result = await client.getOperationsSnapshot();
      assert.ok('error' in result);
      assert.equal(result.error.category, 'validation');
    });
  });

  // ─── getWorkItemDetail ──────────────────────────────────────────────────────

  describe('getWorkItemDetail', () => {
    it('sends GET /operations/work-items/:workItemId', async () => {
      const detail = {
        item: { id: 'wi-1' },
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(detail)));

      const result = await client.getWorkItemDetail('wi-1');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/operations/work-items/wi-1`);
      assert.ok('data' in result);
    });

    it('encodes special characters in workItemId', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ item: { id: 'a/b' } })),
      );

      await client.getWorkItemDetail('a/b');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).includes('a%2Fb'));
    });
  });

  // ─── Error handling (cross-cutting) ─────────────────────────────────────────

  describe('error handling', () => {
    it('translates network failure into daemon-unreachable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.getOperationsSnapshot();
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });

    it('translates timeout (AbortError) into daemon-unreachable', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mock.mockImplementation(() => Promise.reject(abortError));

      const result = await client.getWorkItemDetail('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });

    it('provides AbortSignal with timeout to fetch', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ queue: [] })));

      await client.getOperationsSnapshot();

      const opts = fetchMock.mock.calls[0].arguments[1];
      assert.ok(opts?.signal instanceof AbortSignal);
    });

    it('handles non-JSON daemon response body gracefully', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(new Response('not json', { status: 500 })),
      );

      const result = await client.getOperationsSnapshot();
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
    });
  });
});
