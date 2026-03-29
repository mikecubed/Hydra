import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonClient } from '../daemon-client.ts';

/**
 * Helper: build a mock Response with JSON body.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Helper: builds a mock Response returning valid ok:true JSON.
 */
function okResponse(body: unknown): Response {
  return jsonResponse(200, body);
}

/**
 * Helper: builds a daemon error response.
 */
function daemonError(
  status: number,
  error: string,
  message: string,
  extras?: { conversationId?: string; turnId?: string },
): Response {
  return jsonResponse(status, { ok: false, error, message, ...extras });
}

describe('DaemonClient', () => {
  const baseUrl = 'http://localhost:4173';
  let fetchMock: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;
  let client: DaemonClient;

  beforeEach(() => {
    fetchMock = mock.fn<typeof globalThis.fetch>();
    client = new DaemonClient({ baseUrl, fetchFn: fetchMock, timeoutMs: 5000 });
  });

  afterEach(() => {
    fetchMock.mock.resetCalls();
  });

  // ─── Configuration ──────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('uses default timeout of 5000ms', () => {
      const defaultClient = new DaemonClient({ baseUrl, fetchFn: fetchMock });
      // Verify via a call that the signal is provided
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ id: 'c1' })));
      void defaultClient.createConversation({});
      assert.equal(fetchMock.mock.callCount(), 1);
      const callArgs = fetchMock.mock.calls[0].arguments;
      assert.ok(callArgs[1]?.signal, 'Should pass AbortSignal');
    });

    it('accepts custom timeout', () => {
      const customClient = new DaemonClient({
        baseUrl,
        fetchFn: fetchMock,
        timeoutMs: 10_000,
      });
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ id: 'c1' })));
      void customClient.createConversation({});
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  });

  // ─── Lifecycle Endpoints ────────────────────────────────────────────────────

  describe('createConversation', () => {
    it('sends POST /conversations with body', async () => {
      const convBody = {
        id: 'conv-1',
        status: 'active',
        turnCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pendingInstructionCount: 0,
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(convBody)));

      const result = await client.createConversation({ title: 'Test' });

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations`);
      assert.equal(opts?.method, 'POST');
      assert.deepStrictEqual(JSON.parse(opts?.body as string), { title: 'Test' });
      assert.ok('data' in result);
    });

    it('returns translated error on daemon 4xx', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(400, 'INVALID_INPUT', 'Missing field')),
      );

      const result = await client.createConversation({});
      assert.ok('error' in result);
      const err = result.error;
      assert.equal(err.ok, false);
      assert.equal(err.category, 'validation');
    });
  });

  describe('listConversations', () => {
    it('sends GET /conversations with query params', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ conversations: [], nextCursor: undefined, totalCount: 0 })),
      );

      const result = await client.listConversations({ limit: 10, status: 'active' });

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).includes('/conversations?'));
      assert.ok((url as string).includes('limit=10'));
      assert.ok((url as string).includes('status=active'));
      assert.ok('data' in result);
    });
  });

  describe('openConversation', () => {
    it('sends GET /conversations/:id', async () => {
      const body = {
        conversation: { id: 'c1' },
        recentTurns: [],
        totalTurnCount: 0,
        pendingApprovals: [],
      };
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse(body)));

      const result = await client.openConversation('c1');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1`);
      assert.ok('data' in result);
    });
  });

  describe('resumeConversation', () => {
    it('sends POST /conversations/:id/resume', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ conversation: {}, events: [], pendingApprovals: [] })),
      );

      await client.resumeConversation('c1', { lastAcknowledgedSeq: 5 });

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/resume`);
      assert.equal(opts?.method, 'POST');
    });

    it('injects path conversationId into daemon body — body cannot override (Issue 1 fix)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ conversation: {}, events: [], pendingApprovals: [] })),
      );

      await client.resumeConversation('path-id', { lastAcknowledgedSeq: 5 });

      const opts = fetchMock.mock.calls[0].arguments[1];
      const sentBody = JSON.parse(opts?.body as string) as { conversationId: string };
      assert.equal(sentBody.conversationId, 'path-id');
    });
  });

  describe('archiveConversation', () => {
    it('sends POST /conversations/:id/archive', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ success: true })));

      await client.archiveConversation('c1');

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/archive`);
      assert.equal(opts?.method, 'POST');
    });
  });

  // ─── Turn Endpoints ─────────────────────────────────────────────────────────

  describe('submitInstruction', () => {
    it('sends POST /conversations/:convId/turns', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ turn: { id: 't1' }, streamId: 'stream-1' })),
      );

      await client.submitInstruction('c1', {
        instruction: 'Do something',
      });

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/turns`);
      assert.equal(opts?.method, 'POST');
    });

    it('injects path conversationId into daemon body — body cannot override (Issue 1 fix)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ turn: { id: 't1' }, streamId: 'stream-1' })),
      );

      await client.submitInstruction('path-id', {
        instruction: 'Do something',
      });

      const opts = fetchMock.mock.calls[0].arguments[1];
      const sentBody = JSON.parse(opts?.body as string) as { conversationId: string };
      assert.equal(sentBody.conversationId, 'path-id');
    });

    it('forwards X-Session-Id header when sessionId is provided (Issue 1 regression)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ turn: { id: 't1' }, streamId: 'stream-1' })),
      );

      await client.submitInstruction(
        'c1',
        { instruction: 'Do something' },
        { sessionId: 'sess-77' },
      );

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/turns`);
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers['X-Session-Id'], 'sess-77');
      assert.equal(headers['Content-Type'], 'application/json');
    });
  });

  describe('loadTurnHistory', () => {
    it('sends GET /conversations/:convId/turns with query', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ turns: [], totalCount: 0, hasMore: false })),
      );

      await client.loadTurnHistory('c1', { conversationId: 'c1', limit: 20 });

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).startsWith(`${baseUrl}/conversations/c1/turns?`));
    });
  });

  // ─── Approval Endpoints ────────────────────────────────────────────────────

  describe('getPendingApprovals', () => {
    it('sends GET /conversations/:convId/approvals', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ approvals: [] })));

      await client.getPendingApprovals('c1');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/approvals`);
    });
  });

  describe('respondToApproval', () => {
    it('sends POST /approvals/:approvalId/respond with X-Session-Id header', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ success: true, approval: {} })),
      );

      await client.respondToApproval('a1', {
        response: 'yes',
        acknowledgeStaleness: false,
        sessionId: 'sess-42',
      });

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/approvals/a1/respond`);
      assert.equal(opts?.method, 'POST');
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers['X-Session-Id'], 'sess-42');
    });

    it('includes X-Session-Id alongside Content-Type header', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ success: true, approval: {} })),
      );

      await client.respondToApproval('a1', {
        response: 'approved',
        sessionId: 'sess-99',
      });

      const opts = fetchMock.mock.calls[0].arguments[1];
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers['Content-Type'], 'application/json');
      assert.equal(headers['X-Session-Id'], 'sess-99');
    });
  });

  // ─── Work Control ──────────────────────────────────────────────────────────

  describe('cancelWork', () => {
    it('sends POST /conversations/:convId/turns/:turnId/cancel', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ success: true, turn: {} })),
      );

      await client.cancelWork('c1', 't1');

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/turns/t1/cancel`);
      assert.equal(opts?.method, 'POST');
    });
  });

  describe('retryTurn', () => {
    it('sends POST /conversations/:convId/turns/:turnId/retry', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ turn: {}, streamId: 's1' })),
      );

      await client.retryTurn('c1', 't1');

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/turns/t1/retry`);
      assert.equal(opts?.method, 'POST');
    });
  });

  describe('forkConversation', () => {
    it('sends POST /conversations/:convId/fork', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ conversation: {} })));

      await client.forkConversation('c1', {
        conversationId: 'c1',
        forkPointTurnId: 't1',
      });

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/fork`);
      assert.equal(opts?.method, 'POST');
    });
  });

  describe('manageQueue', () => {
    it('sends POST /conversations/:convId/queue', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ queue: [] })));

      await client.manageQueue('c1', {
        conversationId: 'c1',
        action: 'list',
      });

      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/queue`);
      assert.equal(opts?.method, 'POST');
    });
  });

  // ─── Artifact Endpoints ─────────────────────────────────────────────────────

  describe('listArtifactsForTurn', () => {
    it('sends GET /turns/:turnId/artifacts', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ artifacts: [] })));

      await client.listArtifactsForTurn('t1');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/turns/t1/artifacts`);
    });
  });

  describe('listArtifactsForConversation', () => {
    it('sends GET /conversations/:convId/artifacts with query', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ artifacts: [], totalCount: 0 })),
      );

      await client.listArtifactsForConversation('c1', { conversationId: 'c1', limit: 10 });

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).startsWith(`${baseUrl}/conversations/c1/artifacts?`));
    });
  });

  describe('getArtifactContent', () => {
    it('sends GET /artifacts/:artifactId', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(okResponse({ artifact: {}, content: 'hello' })),
      );

      await client.getArtifactContent('art-1');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/artifacts/art-1`);
    });
  });

  // ─── Activity Endpoints ─────────────────────────────────────────────────────

  describe('getActivityEntries', () => {
    it('sends GET /turns/:turnId/activities', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ activities: [] })));

      await client.getActivityEntries('t1');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/turns/t1/activities`);
    });
  });

  describe('filterActivityByAgent', () => {
    it('sends GET /turns/:turnId/activities?agent=...', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ activities: [] })));

      await client.filterActivityByAgent('t1', 'claude');

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.ok((url as string).includes('/turns/t1/activities?'));
      assert.ok((url as string).includes('agent=claude'));
    });
  });

  // ─── Stream Replay (critical for reconnect — T032 dependency) ──────────────

  describe('getStreamReplay', () => {
    it('sends GET /conversations/:convId/turns/:turnId/stream with lastAcknowledgedSeq', async () => {
      const events = [
        {
          seq: 5,
          turnId: 't1',
          kind: 'text-delta',
          payload: { text: 'hello' },
          timestamp: new Date().toISOString(),
        },
      ];
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ events })));

      const result = await client.getStreamReplay('c1', 't1', 4);

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, `${baseUrl}/conversations/c1/turns/t1/stream?lastAcknowledgedSeq=4`);
      assert.ok('data' in result);
    });

    it('returns translated error on daemon 404', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(404, 'NOT_FOUND', 'Turn not found', { turnId: 't1' })),
      );

      const result = await client.getStreamReplay('c1', 't1', 0);
      assert.ok('error' in result);
      const err = result.error;
      assert.equal(err.category, 'validation');
      assert.equal(err.turnId, 't1');
    });
  });

  // ─── Error Handling (cross-cutting) ─────────────────────────────────────────

  describe('error handling', () => {
    it('translates daemon 5xx into daemon category error', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(daemonError(500, 'INTERNAL_ERROR', 'Server error')),
      );

      const result = await client.createConversation({});
      assert.ok('error' in result);
      const err = result.error;
      assert.equal(err.category, 'daemon');
    });

    it('translates network failure into daemon-unavailable', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

      const result = await client.createConversation({});
      assert.ok('error' in result);
      const err = result.error;
      assert.equal(err.category, 'daemon-unavailable');
      assert.equal(err.code, 'DAEMON_UNREACHABLE');
    });

    it('translates timeout (AbortError) into DAEMON_TIMEOUT', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mock.mockImplementation(() => Promise.reject(abortError));

      const result = await client.openConversation('c1');
      assert.ok('error' in result);
      const err = result.error;
      assert.equal(err.category, 'daemon-unavailable');
      assert.equal(err.code, 'DAEMON_TIMEOUT');
    });

    it('logs TypeError fetch failure via console.warn with structured context', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
      const warnMock = mock.method(console, 'warn');
      try {
        await client.createConversation({ title: 'test' });

        assert.ok(warnMock.mock.callCount() >= 1, 'console.warn should be called');
        const [label, ctx] = warnMock.mock.calls[0].arguments as [string, Record<string, string>];
        assert.equal(label, '[DaemonClient] fetch failure');
        assert.equal(ctx['method'], 'POST');
        assert.ok(ctx['url'].includes('/conversations'), 'url should contain the request path');
        assert.equal(ctx['error'], 'TypeError');
        assert.equal(ctx['message'], 'fetch failed');
      } finally {
        warnMock.mock.restore();
      }
    });

    it('logs AbortError fetch failure via console.warn with structured context', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mock.mockImplementation(() => Promise.reject(abortError));
      const warnMock = mock.method(console, 'warn');
      try {
        await client.openConversation('c1');

        assert.ok(warnMock.mock.callCount() >= 1, 'console.warn should be called');
        const [label, ctx] = warnMock.mock.calls[0].arguments as [string, Record<string, string>];
        assert.equal(label, '[DaemonClient] fetch failure');
        assert.equal(ctx['method'], 'GET');
        assert.ok(ctx['url'].includes('/conversations/c1'), 'url should contain the request path');
        assert.equal(ctx['error'], 'AbortError');
        assert.equal(ctx['message'], 'The operation was aborted');
      } finally {
        warnMock.mock.restore();
      }
    });

    it('provides AbortSignal with timeout to fetch', async () => {
      fetchMock.mock.mockImplementation(() => Promise.resolve(okResponse({ id: 'c1' })));

      await client.createConversation({});

      const opts = fetchMock.mock.calls[0].arguments[1];
      assert.ok(opts?.signal instanceof AbortSignal);
    });
  });
});
