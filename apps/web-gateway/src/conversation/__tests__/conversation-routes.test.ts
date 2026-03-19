/**
 * Tests for conversation routes (T010–T014, T043, T046, T047).
 *
 * Tests all REST mediation routes: lifecycle, turns, approvals,
 * work-control, artifacts, and activities. Uses a mock DaemonClient
 * injected via the route factory for unit-level tests (T010-T014, T043),
 * and the real composed gateway app for middleware-layer tests (T046, T047).
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createConversationRoutes } from '../conversation-routes.ts';
import { DaemonClient } from '../daemon-client.ts';
import type { DaemonResult } from '../daemon-client.ts';
import type { GatewayErrorResponse } from '../../shared/gateway-error-response.ts';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';
import { RateLimiter } from '../../auth/rate-limiter.ts';

const ORIGIN = 'http://127.0.0.1:4174';

// ── Test helpers ─────────────────────────────────────────────────────────────

type MockDaemonClient = {
  [K in keyof DaemonClient]: ReturnType<typeof mock.fn>;
};

function createMockDaemonClient(): MockDaemonClient {
  return {
    createConversation: mock.fn(() =>
      Promise.resolve({ data: { id: 'conv-1', status: 'active' } }),
    ),

    listConversations: mock.fn(() =>
      Promise.resolve({ data: { conversations: [], nextCursor: undefined, totalCount: 0 } }),
    ),

    openConversation: mock.fn(() =>
      Promise.resolve({
        data: {
          conversation: { id: 'conv-1', status: 'active' },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      }),
    ),

    resumeConversation: mock.fn(() =>
      Promise.resolve({
        data: {
          conversation: { id: 'conv-1', status: 'active' },
          events: [],
          pendingApprovals: [],
        },
      }),
    ),

    archiveConversation: mock.fn(() => Promise.resolve({ data: { success: true } })),

    submitInstruction: mock.fn(() =>
      Promise.resolve({
        data: { turn: { id: 't1', kind: 'user', status: 'queued' }, streamId: 'stream-1' },
      }),
    ),

    loadTurnHistory: mock.fn(() =>
      Promise.resolve({ data: { turns: [], totalCount: 0, hasMore: false } }),
    ),

    getPendingApprovals: mock.fn(() => Promise.resolve({ data: { approvals: [] } })),

    respondToApproval: mock.fn(() =>
      Promise.resolve({
        data: { success: true, approval: { id: 'a1', status: 'approved' } },
      }),
    ),

    cancelWork: mock.fn(() =>
      Promise.resolve({ data: { success: true, turn: { id: 't1', status: 'cancelled' } } }),
    ),

    retryTurn: mock.fn(() =>
      Promise.resolve({
        data: { turn: { id: 't1', status: 'queued' }, streamId: 'stream-2' },
      }),
    ),

    listArtifactsForTurn: mock.fn(() => Promise.resolve({ data: { artifacts: [] } })),

    listArtifactsForConversation: mock.fn(() =>
      Promise.resolve({ data: { artifacts: [], nextCursor: undefined, totalCount: 0 } }),
    ),

    getArtifactContent: mock.fn(() =>
      Promise.resolve({ data: { artifact: { id: 'art-1' }, content: 'hello' } }),
    ),

    getActivityEntries: mock.fn(() => Promise.resolve({ data: { activities: [] } })),

    filterActivityByAgent: mock.fn(() => Promise.resolve({ data: { activities: [] } })),

    forkConversation: mock.fn(() =>
      Promise.resolve({ data: { conversation: { id: 'conv-fork' } } }),
    ),

    manageQueue: mock.fn(() => Promise.resolve({ data: { queue: [] } })),

    getStreamReplay: mock.fn(() => Promise.resolve({ data: { events: [] } })),
  } as unknown as MockDaemonClient;
}

/**
 * Build a Hono app with conversation routes pre-wired.
 * Sets operatorId and sessionId on the context to simulate auth middleware.
 */
function buildTestApp(daemonClient: MockDaemonClient): Hono {
  const app = new Hono();
  // Simulate auth middleware setting context variables
  app.use('*', async (c, next) => {
    c.set('operatorId' as never, 'test-operator' as never);
    c.set('sessionId' as never, 'test-session-123' as never);
    await next();
  });
  app.route('/', createConversationRoutes(daemonClient as unknown as DaemonClient));
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

/**
 * Build a Request against the full gateway app (origin-aware, with optional cookies).
 * Used by T046/T047 which exercise the real middleware stack.
 */
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

// ── T010: Conversation lifecycle ──────────────────────────────────────────────

describe('Conversation lifecycle routes (T010)', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    app = buildTestApp(mockClient);
  });

  describe('POST /conversations', () => {
    it('creates a conversation and returns daemon response', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations', { body: JSON.stringify({ title: 'Test' }) }),
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as { id: string };
      assert.equal(body.id, 'conv-1');
      assert.equal(mockClient.createConversation.mock.callCount(), 1);
    });

    it('returns 400 on validation failure (bad parentConversationId)', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations', {
          body: JSON.stringify({ parentConversationId: '' }),
        }),
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'validation');
    });

    it('forwards daemon error response', async () => {
      const daemonErr: DaemonResult<never> = {
        error: {
          ok: false,
          code: 'DAEMON_UNREACHABLE',
          category: 'daemon',
          message: 'Daemon unreachable',
        },
      };
      mockClient.createConversation.mock.mockImplementation(() => Promise.resolve(daemonErr));

      const res = await app.request(
        buildRequest('POST', '/conversations', { body: JSON.stringify({}) }),
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'daemon');
    });

    it('routes to forkConversation when both parentConversationId and forkPointTurnId are present', async () => {
      const forkConv = {
        id: 'conv-fork',
        status: 'active',
        turnCount: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        parentConversationId: 'conv-1',
        forkPointTurnId: 't5',
        pendingInstructionCount: 0,
      };
      mockClient.forkConversation.mock.mockImplementation(() =>
        Promise.resolve({ data: { conversation: forkConv } }),
      );

      const res = await app.request(
        buildRequest('POST', '/conversations', {
          body: JSON.stringify({
            parentConversationId: 'conv-1',
            forkPointTurnId: 't5',
            title: 'Forked',
          }),
        }),
      );

      assert.equal(res.status, 201);
      const body = (await res.json()) as { id: string; parentConversationId: string };
      assert.equal(body.id, 'conv-fork');
      assert.equal(body.parentConversationId, 'conv-1');

      // Must call forkConversation, NOT createConversation
      assert.equal(mockClient.forkConversation.mock.callCount(), 1);
      assert.equal(mockClient.createConversation.mock.callCount(), 0);

      // Verify correct arguments to forkConversation
      const [convId, forkBody] = mockClient.forkConversation.mock.calls[0].arguments;
      assert.equal(convId, 'conv-1');
      assert.deepEqual(forkBody, {
        conversationId: 'conv-1',
        forkPointTurnId: 't5',
        title: 'Forked',
      });
    });

    it('returns 400 when only parentConversationId is provided without forkPointTurnId', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations', {
          body: JSON.stringify({ parentConversationId: 'conv-1' }),
        }),
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.code, 'VALIDATION_FAILED');
      assert.equal(body.category, 'validation');
      assert.match(body.message, /parentConversationId.*forkPointTurnId/);
      assert.equal(mockClient.createConversation.mock.callCount(), 0);
      assert.equal(mockClient.forkConversation.mock.callCount(), 0);
    });

    it('returns 400 when only forkPointTurnId is provided without parentConversationId', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations', {
          body: JSON.stringify({ forkPointTurnId: 't5' }),
        }),
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.code, 'VALIDATION_FAILED');
      assert.equal(body.category, 'validation');
      assert.match(body.message, /parentConversationId.*forkPointTurnId/);
      assert.equal(mockClient.createConversation.mock.callCount(), 0);
      assert.equal(mockClient.forkConversation.mock.callCount(), 0);
    });

    it('forwards daemon error from forkConversation', async () => {
      const daemonErr: DaemonResult<never> = {
        error: {
          ok: false,
          code: 'NOT_FOUND',
          category: 'validation',
          message: 'Conversation not found',
          httpStatus: 404,
        },
      };
      mockClient.forkConversation.mock.mockImplementation(() => Promise.resolve(daemonErr));

      const res = await app.request(
        buildRequest('POST', '/conversations', {
          body: JSON.stringify({
            parentConversationId: 'conv-missing',
            forkPointTurnId: 't1',
          }),
        }),
      );
      assert.equal(res.status, 404);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'validation');
      assert.equal(body.code, 'NOT_FOUND');
    });

    it('still creates a plain conversation when no fork fields are present', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations', { body: JSON.stringify({ title: 'Plain' }) }),
      );
      assert.equal(res.status, 201);
      assert.equal(mockClient.createConversation.mock.callCount(), 1);
      assert.equal(mockClient.forkConversation.mock.callCount(), 0);
    });
  });

  describe('GET /conversations', () => {
    it('lists conversations', async () => {
      const res = await app.request(buildRequest('GET', '/conversations'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { conversations: unknown[] };
      assert.ok(Array.isArray(body.conversations));
      assert.equal(mockClient.listConversations.mock.callCount(), 1);
    });

    it('passes query params to daemon client', async () => {
      const res = await app.request(buildRequest('GET', '/conversations?status=active&limit=5'));
      assert.equal(res.status, 200);
      const callArgs = mockClient.listConversations.mock.calls[0].arguments;
      assert.deepEqual(callArgs[0], { status: 'active', limit: 5 });
    });

    it('returns 400 on invalid query params', async () => {
      const res = await app.request(buildRequest('GET', '/conversations?limit=-1'));
      assert.equal(res.status, 400);
    });
  });

  describe('GET /conversations/:id', () => {
    it('opens a conversation', async () => {
      const res = await app.request(buildRequest('GET', '/conversations/conv-1'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { conversation: { id: string } };
      assert.equal(body.conversation.id, 'conv-1');
      assert.equal(mockClient.openConversation.mock.callCount(), 1);
      assert.equal(mockClient.openConversation.mock.calls[0].arguments[0], 'conv-1');
    });
  });

  describe('POST /conversations/:id/resume', () => {
    it('resumes a conversation', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/resume', {
          body: JSON.stringify({ conversationId: 'conv-1', lastAcknowledgedSeq: 5 }),
        }),
      );
      assert.equal(res.status, 200);
      assert.equal(mockClient.resumeConversation.mock.callCount(), 1);
    });

    it('returns 400 for missing lastAcknowledgedSeq', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/resume', {
          body: JSON.stringify({}),
        }),
      );
      assert.equal(res.status, 400);
    });

    it('does not pass conversationId in body — client is path-authoritative (Issue 1 fix)', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/path-id/resume', {
          body: JSON.stringify({ conversationId: 'body-id', lastAcknowledgedSeq: 3 }),
        }),
      );
      assert.equal(res.status, 200);
      const callArgs = mockClient.resumeConversation.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'path-id', 'first arg (path) must be the path param');
      const body = callArgs[1] as Record<string, unknown>;
      assert.equal(body['lastAcknowledgedSeq'], 3);
      assert.equal(
        'conversationId' in body,
        false,
        'body must not contain conversationId — the daemon client injects it from the path arg',
      );
    });

    it('succeeds when body omits conversationId entirely (path is authoritative)', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/resume', {
          body: JSON.stringify({ lastAcknowledgedSeq: 7 }),
        }),
      );
      assert.equal(res.status, 200);
      assert.equal(mockClient.resumeConversation.mock.callCount(), 1);
      const callArgs = mockClient.resumeConversation.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1', 'first arg must be the path param');
      const body = callArgs[1] as { lastAcknowledgedSeq: number };
      assert.equal(body.lastAcknowledgedSeq, 7);
    });
  });

  describe('POST /conversations/:id/archive', () => {
    it('archives a conversation', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/archive', { body: JSON.stringify({}) }),
      );
      assert.equal(res.status, 200);
      assert.equal(mockClient.archiveConversation.mock.callCount(), 1);
      assert.equal(mockClient.archiveConversation.mock.calls[0].arguments[0], 'conv-1');
    });
  });
});

// ── T011: Turn routes ────────────────────────────────────────────────────────

describe('Turn routes (T011)', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    app = buildTestApp(mockClient);
  });

  describe('POST /conversations/:convId/turns', () => {
    it('submits an instruction and returns turn + streamId', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ conversationId: 'conv-1', instruction: 'Do something' }),
        }),
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as { turn: { id: string }; streamId: string };
      assert.equal(body.turn.id, 't1');
      assert.equal(body.streamId, 'stream-1');
    });

    it('returns 400 for empty instruction', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ conversationId: 'conv-1', instruction: '' }),
        }),
      );
      assert.equal(res.status, 400);
    });

    it('forwards authenticated sessionId to daemon via submitInstruction', async () => {
      await app.request(
        buildRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ conversationId: 'conv-1', instruction: 'test' }),
        }),
      );
      const callArgs = mockClient.submitInstruction.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1');
      // sessionId from auth middleware must be forwarded (Issue 1 regression)
      const opts = callArgs[2] as { sessionId: string } | undefined;
      assert.ok(opts, 'third argument with options must be present');
      assert.equal(opts.sessionId, 'test-session-123');
    });

    it('does not pass conversationId in body — client is path-authoritative (Issue 1 fix)', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/path-conv/turns', {
          body: JSON.stringify({ conversationId: 'body-conv', instruction: 'do it' }),
        }),
      );
      assert.equal(res.status, 201);
      const callArgs = mockClient.submitInstruction.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'path-conv', 'first arg must be path param');
      const body = callArgs[1] as Record<string, unknown>;
      assert.equal(body['instruction'], 'do it');
      assert.equal(
        'conversationId' in body,
        false,
        'body must not contain conversationId — the daemon client injects it from the path arg',
      );
    });

    it('succeeds when body omits conversationId entirely (path is authoritative)', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ instruction: 'do something' }),
        }),
      );
      assert.equal(res.status, 201);
      assert.equal(mockClient.submitInstruction.mock.callCount(), 1);
      const callArgs = mockClient.submitInstruction.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1', 'first arg must be path param');
      const body = callArgs[1] as { instruction: string };
      assert.equal(body.instruction, 'do something');
    });
  });

  describe('GET /conversations/:convId/turns', () => {
    it('loads turn history', async () => {
      const res = await app.request(buildRequest('GET', '/conversations/conv-1/turns'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { turns: unknown[]; totalCount: number };
      assert.ok(Array.isArray(body.turns));
      assert.equal(mockClient.loadTurnHistory.mock.callCount(), 1);
    });

    it('passes pagination params to daemon', async () => {
      const res = await app.request(
        buildRequest('GET', '/conversations/conv-1/turns?limit=10&fromPosition=5'),
      );
      assert.equal(res.status, 200);
      const callArgs = mockClient.loadTurnHistory.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1');
      // The query object should contain fromPosition and limit
      const query = callArgs[1] as Record<string, unknown>;
      assert.equal(query['fromPosition'], 5);
      assert.equal(query['limit'], 10);
    });
  });
});

// ── T012: Approval routes ────────────────────────────────────────────────────

describe('Approval routes (T012)', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    app = buildTestApp(mockClient);
  });

  describe('GET /conversations/:convId/approvals', () => {
    it('returns pending approvals', async () => {
      const res = await app.request(buildRequest('GET', '/conversations/conv-1/approvals'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { approvals: unknown[] };
      assert.ok(Array.isArray(body.approvals));
      assert.equal(mockClient.getPendingApprovals.mock.callCount(), 1);
    });
  });

  describe('POST /approvals/:approvalId/respond', () => {
    it('responds to an approval and forwards X-Session-Id', async () => {
      const res = await app.request(
        buildRequest('POST', '/approvals/a1/respond', {
          body: JSON.stringify({ response: 'approve' }),
        }),
      );
      assert.equal(res.status, 200);
      const callArgs = mockClient.respondToApproval.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'a1');
      // Session ID should be forwarded
      const body = callArgs[1] as Record<string, unknown>;
      assert.equal(body['sessionId'], 'test-session-123');
    });

    it('returns 400 for empty response', async () => {
      const res = await app.request(
        buildRequest('POST', '/approvals/a1/respond', {
          body: JSON.stringify({ response: '' }),
        }),
      );
      assert.equal(res.status, 400);
    });

    it('passes acknowledgeStaleness to daemon', async () => {
      const res = await app.request(
        buildRequest('POST', '/approvals/a1/respond', {
          body: JSON.stringify({ response: 'approve', acknowledgeStaleness: true }),
        }),
      );
      assert.equal(res.status, 200);
      const callArgs = mockClient.respondToApproval.mock.calls[0].arguments;
      const body = callArgs[1] as Record<string, unknown>;
      assert.equal(body['acknowledgeStaleness'], true);
    });
  });
});

// ── T013: Work control routes ────────────────────────────────────────────────

describe('Work control routes (T013)', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    app = buildTestApp(mockClient);
  });

  describe('POST /conversations/:convId/turns/:turnId/cancel', () => {
    it('cancels work', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/turns/t1/cancel', {
          body: JSON.stringify({}),
        }),
      );
      assert.equal(res.status, 200);
      const callArgs = mockClient.cancelWork.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1');
      assert.equal(callArgs[1], 't1');
    });
  });

  describe('POST /conversations/:convId/turns/:turnId/retry', () => {
    it('retries a turn', async () => {
      const res = await app.request(
        buildRequest('POST', '/conversations/conv-1/turns/t1/retry', {
          body: JSON.stringify({}),
        }),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { turn: { id: string }; streamId: string };
      assert.equal(body.turn.id, 't1');
      assert.equal(body.streamId, 'stream-2');
      const callArgs = mockClient.retryTurn.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1');
      assert.equal(callArgs[1], 't1');
    });
  });
});

// ── T014: Artifact and activity routes ───────────────────────────────────────

describe('Artifact and activity routes (T014)', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    app = buildTestApp(mockClient);
  });

  describe('GET /turns/:turnId/artifacts', () => {
    it('lists artifacts for a turn', async () => {
      const res = await app.request(buildRequest('GET', '/turns/t1/artifacts'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { artifacts: unknown[] };
      assert.ok(Array.isArray(body.artifacts));
      assert.equal(mockClient.listArtifactsForTurn.mock.callCount(), 1);
      assert.equal(mockClient.listArtifactsForTurn.mock.calls[0].arguments[0], 't1');
    });
  });

  describe('GET /conversations/:convId/artifacts', () => {
    it('lists artifacts for a conversation', async () => {
      const res = await app.request(buildRequest('GET', '/conversations/conv-1/artifacts'));
      assert.equal(res.status, 200);
      assert.equal(mockClient.listArtifactsForConversation.mock.callCount(), 1);
    });

    it('passes query params to daemon', async () => {
      const res = await app.request(
        buildRequest('GET', '/conversations/conv-1/artifacts?kind=code&limit=5'),
      );
      assert.equal(res.status, 200);
      const callArgs = mockClient.listArtifactsForConversation.mock.calls[0].arguments;
      assert.equal(callArgs[0], 'conv-1');
      const query = callArgs[1] as Record<string, unknown>;
      assert.equal(query['kind'], 'code');
      assert.equal(query['limit'], 5);
    });
  });

  describe('GET /artifacts/:artifactId', () => {
    it('gets artifact content', async () => {
      const res = await app.request(buildRequest('GET', '/artifacts/art-1'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { artifact: { id: string }; content: string };
      assert.equal(body.content, 'hello');
      assert.equal(mockClient.getArtifactContent.mock.callCount(), 1);
      assert.equal(mockClient.getArtifactContent.mock.calls[0].arguments[0], 'art-1');
    });
  });

  describe('GET /turns/:turnId/activities', () => {
    it('gets activity entries for a turn', async () => {
      const res = await app.request(buildRequest('GET', '/turns/t1/activities'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { activities: unknown[] };
      assert.ok(Array.isArray(body.activities));
      assert.equal(mockClient.getActivityEntries.mock.callCount(), 1);
      assert.equal(mockClient.getActivityEntries.mock.calls[0].arguments[0], 't1');
    });

    it('delegates to filterActivityByAgent when ?agent= is provided', async () => {
      const res = await app.request(buildRequest('GET', '/turns/t1/activities?agent=claude'));
      assert.equal(res.status, 200);
      assert.equal(mockClient.filterActivityByAgent.mock.callCount(), 1);
      assert.equal(mockClient.getActivityEntries.mock.callCount(), 0);
      const callArgs = mockClient.filterActivityByAgent.mock.calls[0].arguments;
      assert.equal(callArgs[0], 't1');
      assert.equal(callArgs[1], 'claude');
    });

    it('accepts ?agentId= as a browser-facing alias and delegates to filterActivityByAgent', async () => {
      const res = await app.request(buildRequest('GET', '/turns/t1/activities?agentId=claude'));
      assert.equal(res.status, 200);
      assert.equal(mockClient.filterActivityByAgent.mock.callCount(), 1);
      assert.equal(mockClient.getActivityEntries.mock.callCount(), 0);
      const callArgs = mockClient.filterActivityByAgent.mock.calls[0].arguments;
      assert.equal(callArgs[0], 't1');
      assert.equal(callArgs[1], 'claude');
    });

    it('ignores empty filter params and calls unfiltered getActivityEntries', async () => {
      const res = await app.request(buildRequest('GET', '/turns/t1/activities?agentId='));
      assert.equal(res.status, 200);
      assert.equal(mockClient.getActivityEntries.mock.callCount(), 1);
      assert.equal(mockClient.filterActivityByAgent.mock.callCount(), 0);
    });
  });
});

// ── Daemon error forwarding ──────────────────────────────────────────────────

describe('Daemon error forwarding', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    app = buildTestApp(mockClient);
  });

  it('returns 404 for NOT_FOUND daemon errors', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'NOT_FOUND',
        category: 'validation',
        message: 'Conversation not found',
        httpStatus: 404,
      },
    };
    mockClient.openConversation.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(buildRequest('GET', '/conversations/nonexistent'));
    assert.equal(res.status, 404);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.category, 'validation');
  });

  it('preserves daemon 400 for INVALID_INPUT — does not rewrite to 404 (Issue 2 regression)', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'INVALID_INPUT',
        category: 'validation',
        message: 'Invalid field value',
        httpStatus: 400,
      },
    };
    mockClient.createConversation.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(
      buildRequest('POST', '/conversations', { body: JSON.stringify({}) }),
    );
    // Must be 400 (daemon's original status), NOT 404
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.category, 'validation');
    assert.equal(body.code, 'INVALID_INPUT');
  });

  it('preserves daemon 400 for approval invalid_response — does not rewrite to 404 (Issue 2 regression)', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'APPROVAL_INVALID_RESPONSE',
        category: 'validation',
        message: 'Approval rejected: invalid response',
        httpStatus: 400,
      },
    };
    mockClient.respondToApproval.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(
      buildRequest('POST', '/approvals/a1/respond', {
        body: JSON.stringify({ response: 'approve' }),
      }),
    );
    // Must be 400, not 404
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.category, 'validation');
  });

  it('returns 503 for daemon-unreachable errors', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'DAEMON_UNREACHABLE',
        category: 'daemon',
        message: 'Daemon unreachable',
      },
    };
    mockClient.listConversations.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(buildRequest('GET', '/conversations'));
    assert.equal(res.status, 503);
  });

  it('returns 429 for rate-limit errors', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'RATE_LIMITED',
        category: 'rate-limit',
        message: 'Too many requests',
        retryAfterMs: 5000,
      },
    };
    mockClient.createConversation.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(
      buildRequest('POST', '/conversations', { body: JSON.stringify({}) }),
    );
    assert.equal(res.status, 429);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.retryAfterMs, 5000);
  });

  it('returns 401 for auth errors', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'INVALID_CREDENTIALS',
        category: 'auth',
        message: 'Invalid credentials',
      },
    };
    mockClient.submitInstruction.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(
      buildRequest('POST', '/conversations/c1/turns', {
        body: JSON.stringify({ conversationId: 'c1', instruction: 'test' }),
      }),
    );
    assert.equal(res.status, 401);
  });

  it('returns 409 for session errors', async () => {
    const daemonErr: DaemonResult<never> = {
      error: {
        ok: false,
        code: 'CONFLICT',
        category: 'session',
        message: 'Conflict detected',
      },
    };
    mockClient.respondToApproval.mock.mockImplementation(() => Promise.resolve(daemonErr));

    const res = await app.request(
      buildRequest('POST', '/approvals/a1/respond', {
        body: JSON.stringify({ response: 'approve' }),
      }),
    );
    assert.equal(res.status, 409);
  });
});

// ── T043: Daemon unavailable — REST path ─────────────────────────────────────

describe('Daemon unavailable across all REST route categories (T043)', () => {
  let mockClient: MockDaemonClient;
  let app: Hono;

  const daemonUnavailableError: DaemonResult<never> = {
    error: {
      ok: false,
      code: 'DAEMON_UNREACHABLE',
      category: 'daemon',
      message: 'Daemon unreachable',
    },
  };

  function stubAllMethodsUnreachable(client: MockDaemonClient): void {
    for (const key of Object.keys(client) as Array<keyof MockDaemonClient>) {
      client[key].mock.mockImplementation(() => Promise.resolve(daemonUnavailableError));
    }
  }

  beforeEach(() => {
    mockClient = createMockDaemonClient();
    stubAllMethodsUnreachable(mockClient);
    app = buildTestApp(mockClient);
  });

  async function assertDaemonUnavailable(res: Response): Promise<void> {
    assert.equal(res.status, 503, `expected HTTP 503, got ${String(res.status)}`);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'daemon');
    assert.equal(body.code, 'DAEMON_UNREACHABLE');
  }

  // ── Lifecycle routes ──

  it('POST /conversations → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/conversations', { body: JSON.stringify({}) }),
    );
    await assertDaemonUnavailable(res);
  });

  it('GET /conversations → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/conversations'));
    await assertDaemonUnavailable(res);
  });

  it('GET /conversations/:id → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/conversations/conv-1'));
    await assertDaemonUnavailable(res);
  });

  it('POST /conversations/:id/resume → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/conversations/conv-1/resume', {
        body: JSON.stringify({ lastAcknowledgedSeq: 0 }),
      }),
    );
    await assertDaemonUnavailable(res);
  });

  it('POST /conversations/:id/archive → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/conversations/conv-1/archive', { body: JSON.stringify({}) }),
    );
    await assertDaemonUnavailable(res);
  });

  // ── Turn routes ──

  it('POST /conversations/:convId/turns → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/conversations/conv-1/turns', {
        body: JSON.stringify({ instruction: 'test' }),
      }),
    );
    await assertDaemonUnavailable(res);
  });

  it('GET /conversations/:convId/turns → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/conversations/conv-1/turns'));
    await assertDaemonUnavailable(res);
  });

  // ── Approval routes ──

  it('GET /conversations/:convId/approvals → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/conversations/conv-1/approvals'));
    await assertDaemonUnavailable(res);
  });

  it('POST /approvals/:approvalId/respond → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/approvals/a1/respond', {
        body: JSON.stringify({ response: 'approve' }),
      }),
    );
    await assertDaemonUnavailable(res);
  });

  // ── Work control routes ──

  it('POST /conversations/:convId/turns/:turnId/cancel → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/conversations/conv-1/turns/t1/cancel', {
        body: JSON.stringify({}),
      }),
    );
    await assertDaemonUnavailable(res);
  });

  it('POST /conversations/:convId/turns/:turnId/retry → 503 daemon unavailable', async () => {
    const res = await app.request(
      buildRequest('POST', '/conversations/conv-1/turns/t1/retry', { body: JSON.stringify({}) }),
    );
    await assertDaemonUnavailable(res);
  });

  // ── Artifact and activity routes ──

  it('GET /turns/:turnId/artifacts → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/turns/t1/artifacts'));
    await assertDaemonUnavailable(res);
  });

  it('GET /conversations/:convId/artifacts → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/conversations/conv-1/artifacts'));
    await assertDaemonUnavailable(res);
  });

  it('GET /artifacts/:artifactId → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/artifacts/art-1'));
    await assertDaemonUnavailable(res);
  });

  it('GET /turns/:turnId/activities → 503 daemon unavailable', async () => {
    const res = await app.request(buildRequest('GET', '/turns/t1/activities'));
    await assertDaemonUnavailable(res);
  });
});

// ── T046: Rate-limit errors on mutating routes ──────────────────────────────
//
// Exercises the real `createMutatingRateLimiter` middleware with a tight
// threshold (maxAttempts: 3) so the third mutating request on the same
// source key is rejected with 429 — proving the gateway middleware layer
// enforces the limit, not the daemon.

describe('Rate-limit errors on mutating conversation routes (T046)', () => {
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

    // Tight mutating rate-limit: 3 requests per window (login + 2 conversation POSTs)
    // so the 3rd conversation POST exceeds the budget
    const mutatingLimiter = new RateLimiter(clock, {
      maxAttempts: 3,
      windowMs: 60_000,
      lockoutMs: 60_000,
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
      mutatingLimiter,
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');

    // Stub daemon so requests that pass the limiter get a success response
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'conv-1', status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    gw.heartbeat.stop();
  });

  async function loginAndGetCookies(): Promise<{ session: string; csrf: string }> {
    const loginReq = gwRequest('POST', '/auth/login', {
      body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(loginReq);
    assert.equal(res.status, 200, 'login must succeed');
    const jar = parseCookies(res);
    return { session: jar['__session'], csrf: jar['__csrf'] };
  }

  async function authedPost(
    path: string,
    cookies: { session: string; csrf: string },
    body: Record<string, unknown> = {},
  ): Promise<Response> {
    return gw.app.request(
      gwRequest('POST', path, {
        body: JSON.stringify(body),
        cookies: { __session: cookies.session, __csrf: cookies.csrf },
        headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
      }),
    );
  }

  async function assertRateLimited(res: Response): Promise<void> {
    assert.equal(res.status, 429, `expected HTTP 429, got ${String(res.status)}`);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'rate-limit');
    assert.equal(body.code, 'RATE_LIMITED');
  }

  it('POST /conversations → 429 after exceeding mutating rate limit', async () => {
    const cookies = await loginAndGetCookies();
    // Two allowed requests consume the budget
    const r1 = await authedPost('/conversations', cookies);
    assert.equal(r1.status, 201, 'first request must succeed');
    const r2 = await authedPost('/conversations', cookies);
    assert.equal(r2.status, 201, 'second request must succeed');
    // Third exceeds the limit
    const r3 = await authedPost('/conversations', cookies);
    await assertRateLimited(r3);
  });

  it('POST /conversations/:convId/turns → 429 after exceeding mutating rate limit', async () => {
    const cookies = await loginAndGetCookies();
    await authedPost('/conversations/conv-1/turns', cookies, { instruction: 'a' });
    await authedPost('/conversations/conv-1/turns', cookies, { instruction: 'b' });
    const r3 = await authedPost('/conversations/conv-1/turns', cookies, { instruction: 'c' });
    await assertRateLimited(r3);
  });

  it('POST /approvals/:approvalId/respond → 429 after exceeding mutating rate limit', async () => {
    const cookies = await loginAndGetCookies();
    await authedPost('/approvals/a1/respond', cookies, { response: 'approve' });
    await authedPost('/approvals/a1/respond', cookies, { response: 'approve' });
    const r3 = await authedPost('/approvals/a1/respond', cookies, { response: 'approve' });
    await assertRateLimited(r3);
  });

  it('POST /conversations/:convId/turns/:turnId/cancel → 429 after exceeding mutating rate limit', async () => {
    const cookies = await loginAndGetCookies();
    await authedPost('/conversations/conv-1/turns/t1/cancel', cookies);
    await authedPost('/conversations/conv-1/turns/t1/cancel', cookies);
    const r3 = await authedPost('/conversations/conv-1/turns/t1/cancel', cookies);
    await assertRateLimited(r3);
  });

  it('GET /conversations is exempt from mutating rate limit', async () => {
    const cookies = await loginAndGetCookies();
    // Exhaust the mutating budget
    await authedPost('/conversations', cookies);
    await authedPost('/conversations', cookies);
    const r3 = await authedPost('/conversations', cookies);
    assert.equal(r3.status, 429, 'mutating budget should be exhausted');
    // GET (safe method) must still succeed
    const getRes = await gw.app.request(
      gwRequest('GET', '/conversations', {
        cookies: { __session: cookies.session, __csrf: cookies.csrf },
        headers: { origin: ORIGIN },
      }),
    );
    assert.equal(getRes.status, 200, 'safe GET must bypass mutating rate limiter');
  });
});

// ── T047: Auth/session errors on REST ────────────────────────────────────────
//
// Exercises the real auth-middleware + session-service stack via
// `createGatewayApp()`. Three sub-scenarios:
//   1. Missing session — no __session cookie → 401 SESSION_NOT_FOUND
//   2. Expired session — advance clock past lifetime → 401 SESSION_EXPIRED
//   3. Invalidated session — explicit invalidation → 401 SESSION_INVALIDATED

describe('Auth and session errors on conversation REST routes (T047)', () => {
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
  });

  async function loginAndGetCookies(): Promise<{ session: string; csrf: string }> {
    const loginReq = gwRequest('POST', '/auth/login', {
      body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
      headers: { origin: ORIGIN },
    });
    const res = await gw.app.request(loginReq);
    assert.equal(res.status, 200, 'login must succeed');
    const jar = parseCookies(res);
    return { session: jar['__session'], csrf: jar['__csrf'] };
  }

  describe('missing session (no session cookie)', () => {
    it('POST /conversations → 401 auth error without session', async () => {
      const res = await gw.app.request(
        gwRequest('POST', '/conversations', {
          body: JSON.stringify({}),
          headers: { origin: ORIGIN },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.ok, false);
      assert.equal(body.category, 'auth');
      assert.equal(body.code, 'SESSION_NOT_FOUND');
    });

    it('POST /conversations/:convId/turns → 401 auth error without session', async () => {
      const res = await gw.app.request(
        gwRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ instruction: 'test' }),
          headers: { origin: ORIGIN },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'auth');
      assert.equal(body.code, 'SESSION_NOT_FOUND');
    });

    it('POST /approvals/:approvalId/respond → 401 auth error without session', async () => {
      const res = await gw.app.request(
        gwRequest('POST', '/approvals/a1/respond', {
          body: JSON.stringify({ response: 'approve' }),
          headers: { origin: ORIGIN },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'auth');
      assert.equal(body.code, 'SESSION_NOT_FOUND');
    });

    it('GET /conversations → 401 auth error without session', async () => {
      const res = await gw.app.request(
        gwRequest('GET', '/conversations', { headers: { origin: ORIGIN } }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'auth');
      assert.equal(body.code, 'SESSION_NOT_FOUND');
    });
  });

  describe('expired session', () => {
    it('POST /conversations → 401 session error for expired session', async () => {
      const cookies = await loginAndGetCookies();
      // Advance clock past session lifetime (3600 s)
      clock.advance(3600_001);
      const res = await gw.app.request(
        gwRequest('POST', '/conversations', {
          body: JSON.stringify({}),
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_EXPIRED');
    });

    it('POST /conversations/:convId/turns → 401 session error for expired session', async () => {
      const cookies = await loginAndGetCookies();
      clock.advance(3600_001);
      const res = await gw.app.request(
        gwRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ instruction: 'test' }),
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_EXPIRED');
    });

    it('GET /conversations/:id → 401 session error for expired session', async () => {
      const cookies = await loginAndGetCookies();
      clock.advance(3600_001);
      const res = await gw.app.request(
        gwRequest('GET', '/conversations/conv-1', {
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_EXPIRED');
    });

    it('POST /approvals/:approvalId/respond → 401 session error for expired session', async () => {
      const cookies = await loginAndGetCookies();
      clock.advance(3600_001);
      const res = await gw.app.request(
        gwRequest('POST', '/approvals/a1/respond', {
          body: JSON.stringify({ response: 'approve' }),
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_EXPIRED');
    });
  });

  describe('invalidated session', () => {
    it('POST /conversations → 401 session error for invalidated session', async () => {
      const cookies = await loginAndGetCookies();
      await gw.sessionService.invalidate(cookies.session, 'test-invalidation');
      const res = await gw.app.request(
        gwRequest('POST', '/conversations', {
          body: JSON.stringify({}),
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_INVALIDATED');
    });

    it('POST /conversations/:convId/turns → 401 session error for invalidated session', async () => {
      const cookies = await loginAndGetCookies();
      await gw.sessionService.invalidate(cookies.session, 'test-invalidation');
      const res = await gw.app.request(
        gwRequest('POST', '/conversations/conv-1/turns', {
          body: JSON.stringify({ instruction: 'test' }),
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_INVALIDATED');
    });

    it('GET /conversations → 401 session error for invalidated session', async () => {
      const cookies = await loginAndGetCookies();
      await gw.sessionService.invalidate(cookies.session, 'test-invalidation');
      const res = await gw.app.request(
        gwRequest('GET', '/conversations', {
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_INVALIDATED');
    });

    it('POST /conversations/:convId/turns/:turnId/cancel → 401 session error for invalidated session', async () => {
      const cookies = await loginAndGetCookies();
      await gw.sessionService.invalidate(cookies.session, 'test-invalidation');
      const res = await gw.app.request(
        gwRequest('POST', '/conversations/conv-1/turns/t1/cancel', {
          body: JSON.stringify({}),
          cookies: { __session: cookies.session, __csrf: cookies.csrf },
          headers: { origin: ORIGIN, 'x-csrf-token': cookies.csrf },
        }),
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as GatewayErrorResponse;
      assert.equal(body.category, 'session');
      assert.equal(body.code, 'SESSION_INVALIDATED');
    });
  });
});
