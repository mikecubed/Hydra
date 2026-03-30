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

function daemonError(status: number, error: string, message: string): Response {
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
      const c = new DaemonOperationsClient({
        baseUrl: 'http://localhost:4173/',
        fetchFn: fetchMock,
      });
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

  // ─── getWorkItemDetail (US2 — selected work-item reads) ─────────────────────

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
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ item: { id: 'a/b' } })));

      await client.getWorkItemDetail('a/b');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).includes('a%2Fb'));
    });

    it('returns full detail payload on success', async () => {
      const detail = {
        item: { id: 'wi-42' },
        checkpoints: [
          {
            id: 'cp-1',
            sequence: 0,
            label: 'init',
            status: 'reached',
            timestamp: '2026-03-22T10:00:00.000Z',
            detail: null,
          },
        ],
        routing: {
          currentMode: 'auto',
          currentRoute: 'claude',
          changedAt: '2026-03-22T10:00:00.000Z',
          history: [],
        },
        assignments: [
          {
            participantId: 'claude',
            label: 'Claude',
            role: 'architect',
            state: 'active',
            startedAt: '2026-03-22T10:00:00.000Z',
            endedAt: null,
          },
        ],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(detail)));

      const result = await client.getWorkItemDetail('wi-42');

      assert.ok('data' in result);
      assert.deepStrictEqual(result.data, detail);
    });

    it('sends GET method with no request body', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          okResponse({
            item: { id: 'wi-1' },
            checkpoints: [],
            routing: null,
            assignments: [],
            council: null,
            controls: [],
            itemBudget: null,
            availability: 'ready',
          }),
        ),
      );

      await client.getWorkItemDetail('wi-1');

      const [, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(opts?.method, 'GET');
      assert.equal(opts?.body, undefined);
    });

    it('returns translated error on daemon 404', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(404, 'NOT_FOUND', 'Work item not found')),
      );

      const result = await client.getWorkItemDetail('nonexistent');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'validation');
    });

    it('returns translated error on daemon 500', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(500, 'INTERNAL_ERROR', 'Server error')),
      );

      const result = await client.getWorkItemDetail('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
    });

    it('translates network failure into daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.getWorkItemDetail('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon-unavailable');
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });
  });

  // ─── getWorkItemControls (US5 — control reads) ──────────────────────────────

  describe('getWorkItemControls', () => {
    it('sends GET /operations/work-items/:workItemId/controls', async () => {
      const controls = {
        workItemId: 'wi-1',
        controls: [
          {
            controlId: 'ctrl-1',
            kind: 'routing',
            label: 'Route override',
            availability: 'actionable',
            authority: 'granted',
            reason: null,
            options: [{ optionId: 'opt-1', label: 'Claude', selected: true, available: true }],
            expectedRevision: 'rev-1',
            lastResolvedAt: null,
          },
        ],
        availability: 'ready',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(controls)));

      const result = await client.getWorkItemControls('wi-1');

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/operations/work-items/wi-1/controls`);
      assert.equal(opts?.method, 'GET');
      assert.ok('data' in result);
      assert.deepStrictEqual(result.data, controls);
    });

    it('encodes special characters in workItemId', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ workItemId: 'a/b', controls: [], availability: 'ready' })),
      );

      await client.getWorkItemControls('a/b');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).includes('a%2Fb'));
    });

    it('returns translated error on daemon 404', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(404, 'NOT_FOUND', 'Work item not found')),
      );

      const result = await client.getWorkItemControls('nonexistent');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'validation');
    });

    it('returns translated error on daemon 500', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(500, 'INTERNAL_ERROR', 'Server error')),
      );

      const result = await client.getWorkItemControls('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
    });

    it('translates network failure into daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.getWorkItemControls('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });

    it('returns daemon-invalid-response error on malformed controls payload', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ workItemId: 'wi-1', controls: [] })),
      );

      const result = await client.getWorkItemControls('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.code, 'DAEMON_INVALID_RESPONSE');
      assert.equal(result.error.httpStatus, 502);
    });
  });

  // ─── submitControlAction (US5 — control mutations) ─────────────────────────

  describe('submitControlAction', () => {
    const actionBody = {
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    };

    it('sends POST to /operations/work-items/:workItemId/controls/:controlId', async () => {
      const accepted = {
        outcome: 'accepted',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route override',
          availability: 'accepted',
          authority: 'granted',
          reason: null,
          options: [],
          expectedRevision: 'rev-2',
          lastResolvedAt: '2026-03-22T10:00:00.000Z',
        },
        workItemId: 'wi-1',
        resolvedAt: '2026-03-22T10:00:00.000Z',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(accepted)));

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/operations/work-items/wi-1/controls/ctrl-1`);
      assert.equal(opts?.method, 'POST');
      assert.ok('data' in result);
      assert.equal(result.data.outcome, 'accepted');
    });

    it('sends JSON body with requestedOptionId and expectedRevision', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          okResponse({
            outcome: 'accepted',
            control: {},
            workItemId: 'wi-1',
            resolvedAt: '2026-03-22T10:00:00.000Z',
          }),
        ),
      );

      await client.submitControlAction('wi-1', 'ctrl-1', actionBody);

      const [, opts] = fetchMock.mock.calls[0].arguments;
      const parsed = JSON.parse(opts?.body as string);
      assert.equal(parsed.requestedOptionId, 'opt-1');
      assert.equal(parsed.expectedRevision, 'rev-1');
    });

    it('passes through rejected outcome from daemon', async () => {
      const rejected = {
        outcome: 'rejected',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route override',
          availability: 'read-only',
          authority: 'forbidden',
          reason: 'Operator not authorized',
          options: [],
          expectedRevision: 'rev-1',
          lastResolvedAt: null,
        },
        workItemId: 'wi-1',
        resolvedAt: '2026-03-22T10:00:00.000Z',
        message: 'Operator not authorized for this control',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(rejected)));

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);

      assert.ok('data' in result);
      assert.equal(result.data.outcome, 'rejected');
      assert.equal(result.data.message, 'Operator not authorized for this control');
    });

    it('passes through stale outcome from daemon', async () => {
      const stale = {
        outcome: 'stale',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route override',
          availability: 'stale',
          authority: 'granted',
          reason: 'Revision has been superseded',
          options: [],
          expectedRevision: 'rev-3',
          lastResolvedAt: null,
        },
        workItemId: 'wi-1',
        resolvedAt: '2026-03-22T10:00:00.000Z',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(stale)));

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);

      assert.ok('data' in result);
      assert.equal(result.data.outcome, 'stale');
    });

    it('passes through structured stale outcome from daemon 409 responses', async () => {
      const stale = {
        outcome: 'stale',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route override',
          availability: 'stale',
          authority: 'granted',
          reason: 'Revision has been superseded',
          options: [],
          expectedRevision: 'rev-3',
          lastResolvedAt: null,
        },
        workItemId: 'wi-1',
        resolvedAt: '2026-03-22T10:00:00.000Z',
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(jsonResponse(409, stale)));

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);

      assert.ok('data' in result);
      assert.equal(result.data.outcome, 'stale');
      assert.equal(result.data.workItemId, 'wi-1');
    });

    it('encodes special characters in workItemId and controlId', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          okResponse({
            outcome: 'accepted',
            control: {},
            workItemId: 'a/b',
            resolvedAt: '2026-03-22T10:00:00.000Z',
          }),
        ),
      );

      await client.submitControlAction('a/b', 'c/d', actionBody);

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).includes('a%2Fb'));
      assert.ok((url as string).includes('c%2Fd'));
    });

    it('returns translated error on daemon 409 (stale revision)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(409, 'REVISION_STALE', 'Revision token is stale')),
      );

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);
      assert.ok('error' in result);
      assert.equal(result.error.category, 'session');
    });

    it('returns translated error on daemon 403', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(403, 'AUTHORITY_DENIED', 'Not authorized')),
      );

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);
      assert.ok('error' in result);
    });

    it('returns translated error on daemon 500', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(500, 'INTERNAL_ERROR', 'Server error')),
      );

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
    });

    it('translates network failure into daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);
      assert.ok('error' in result);
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });

    it('returns daemon-invalid-response error on malformed submit payload', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ outcome: 'accepted', workItemId: 'wi-1' })),
      );

      const result = await client.submitControlAction('wi-1', 'ctrl-1', actionBody);
      assert.ok('error' in result);
      assert.equal(result.error.code, 'DAEMON_INVALID_RESPONSE');
      assert.equal(result.error.httpStatus, 502);
    });
  });

  // ─── discoverControls (US5 — batch control discovery) ──────────────────────

  describe('discoverControls', () => {
    const discoveryBody = { workItemIds: ['wi-1', 'wi-2'] };

    it('sends POST to /operations/controls/discover', async () => {
      const discovery = {
        items: [
          {
            workItemId: 'wi-1',
            controls: [
              {
                controlId: 'ctrl-1',
                kind: 'routing',
                label: 'Route override',
                availability: 'actionable',
                authority: 'granted',
                reason: null,
                options: [],
                expectedRevision: 'rev-1',
                lastResolvedAt: null,
              },
            ],
            availability: 'ready',
          },
          { workItemId: 'wi-2', controls: [], availability: 'ready' },
        ],
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(discovery)));

      const result = await client.discoverControls(discoveryBody);

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/operations/controls/discover`);
      assert.equal(opts?.method, 'POST');
      assert.ok('data' in result);
      assert.equal(result.data.items.length, 2);
    });

    it('sends JSON body with workItemIds array', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ items: [] })));

      await client.discoverControls(discoveryBody);

      const [, opts] = fetchMock.mock.calls[0].arguments;
      const parsed = JSON.parse(opts?.body as string);
      assert.deepStrictEqual(parsed.workItemIds, ['wi-1', 'wi-2']);
    });

    it('includes optional kindFilter in request body', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ items: [] })));

      await client.discoverControls({ workItemIds: ['wi-1'], kindFilter: 'routing' });

      const [, opts] = fetchMock.mock.calls[0].arguments;
      const parsed = JSON.parse(opts?.body as string);
      assert.equal(parsed.kindFilter, 'routing');
    });

    it('returns translated error on daemon 500', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(500, 'INTERNAL_ERROR', 'Server error')),
      );

      const result = await client.discoverControls(discoveryBody);
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon');
    });

    it('translates network failure into daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.discoverControls(discoveryBody);
      assert.ok('error' in result);
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });

    it('returns translated error on daemon 400 (invalid body)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(400, 'INVALID_INPUT', 'workItemIds must be non-empty')),
      );

      const result = await client.discoverControls(discoveryBody);
      assert.ok('error' in result);
      assert.equal(result.error.category, 'validation');
    });

    it('returns daemon-invalid-response error on malformed discovery payload', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ items: [{ workItemId: 'wi-1' }] })),
      );

      const result = await client.discoverControls(discoveryBody);
      assert.ok('error' in result);
      assert.equal(result.error.code, 'DAEMON_INVALID_RESPONSE');
      assert.equal(result.error.httpStatus, 502);
    });
  });

  // ─── Error handling (cross-cutting) ─────────────────────────────────────────

  describe('error handling', () => {
    it('translates network failure into daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.getOperationsSnapshot();
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon-unavailable');
      assert.equal(result.error.code, 'DAEMON_UNREACHABLE');
    });

    it('translates timeout (AbortError) into daemon-unavailable', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mock.mockImplementation(() => Promise.reject(abortError));

      const result = await client.getWorkItemDetail('wi-1');
      assert.ok('error' in result);
      assert.equal(result.error.category, 'daemon-unavailable');
      assert.equal(result.error.code, 'DAEMON_TIMEOUT');
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
