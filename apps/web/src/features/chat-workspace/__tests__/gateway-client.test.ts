/**
 * Tests for the browser-side gateway conversation client.
 *
 * Verifies list, detail (open), history, create, submit, approval retrieval,
 * and approval response operations, including structured error handling via
 * the gateway error parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGatewayClient,
  type GatewayClient,
  type GatewayClientOptions,
  GatewayRequestError,
} from '../api/gateway-client.ts';

import type { GatewayErrorBody } from '../../../shared/gateway-errors.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://gw.test';

const NOW = '2026-06-01T12:00:00.000Z';

function conversationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    title: 'Test conversation',
    status: 'active' as const,
    createdAt: NOW,
    updatedAt: NOW,
    turnCount: 0,
    pendingInstructionCount: 0,
    ...overrides,
  };
}

function turnFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    conversationId: 'conv-1',
    position: 1,
    kind: 'operator' as const,
    attribution: { type: 'operator' as const, label: 'Operator' },
    instruction: 'Hello',
    status: 'completed' as const,
    createdAt: NOW,
    ...overrides,
  };
}

function approvalFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    turnId: 'turn-1',
    status: 'pending' as const,
    prompt: 'Allow file write to /etc/hosts?',
    context: { path: '/etc/hosts' },
    contextHash: 'hash-abc',
    responseOptions: [
      { key: 'allow', label: 'Allow' },
      { key: 'deny', label: 'Deny' },
    ],
    createdAt: NOW,
    ...overrides,
  };
}

function gatewayErrorFixture(overrides: Partial<GatewayErrorBody> = {}): GatewayErrorBody {
  return {
    ok: false,
    code: 'NOT_FOUND',
    category: 'validation',
    message: 'Conversation not found',
    ...overrides,
  };
}

// ─── Fake fetch ─────────────────────────────────────────────────────────────

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CapturedHeaders = RequestInit['headers'];
type CapturedCredentials = RequestInit['credentials'];
type DocumentShim = { cookie?: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(body: GatewayErrorBody, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Helper to build client with fake fetch ─────────────────────────────────

function buildClient(fetchFn: FetchFn, opts?: Partial<GatewayClientOptions>): GatewayClient {
  return createGatewayClient({
    baseUrl: BASE_URL,
    fetch: fetchFn,
    ...opts,
  });
}

/** Narrow unknown error to GatewayRequestError and return it. */
function assertGatewayError(err: unknown): GatewayRequestError {
  assert.ok(err instanceof GatewayRequestError);
  return err;
}

function stringifyInput(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function setDocumentCookieForTest(cookie: string | undefined): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const value = cookie === undefined ? undefined : ({ cookie } satisfies DocumentShim);

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value,
  });

  return () => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDescriptor);
      return;
    }

    delete (globalThis as Record<string, unknown>)['document'];
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GatewayClient', () => {
  // ── listConversations ───────────────────────────────────────────────────

  describe('listConversations', () => {
    it('sends GET with default params and returns parsed response', async () => {
      const conversations = [conversationFixture()];
      const responseBody = { conversations, nextCursor: undefined, totalCount: 1 };
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(responseBody);
      });

      const result = await client.listConversations();

      assert.ok(capturedUrl.includes('/conversations'));
      assert.equal(result.conversations.length, 1);
      assert.equal(result.totalCount, 1);
    });

    it('passes status and cursor query params', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({ conversations: [], totalCount: 0 });
      });

      await client.listConversations({ status: 'archived', cursor: 'abc', limit: 10 });

      const url = new URL(capturedUrl);
      assert.equal(url.searchParams.get('status'), 'archived');
      assert.equal(url.searchParams.get('cursor'), 'abc');
      assert.equal(url.searchParams.get('limit'), '10');
    });

    it('supports a relative baseUrl', async () => {
      let capturedUrl = '';
      const client = buildClient(
        async (input) => {
          capturedUrl = stringifyInput(input);
          return jsonResponse({ conversations: [], totalCount: 0 });
        },
        { baseUrl: '/gateway' },
      );

      await client.listConversations({ status: 'active', limit: 20 });

      assert.equal(capturedUrl, '/gateway/conversations?status=active&limit=20');
    });

    it('throws GatewayRequestError on structured error response', async () => {
      const errBody = gatewayErrorFixture({
        code: 'INTERNAL_ERROR',
        category: 'daemon',
        message: 'Internal failure',
      });

      const client = buildClient(async () => errorResponse(errBody, 500));

      await assert.rejects(
        () => client.listConversations(),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.gatewayError.code, 'INTERNAL_ERROR');
          assert.equal(gErr.gatewayError.category, 'daemon');
          assert.equal(gErr.status, 500);
          return true;
        },
      );
    });

    it('throws GatewayRequestError with fallback on non-JSON error', async () => {
      const client = buildClient(async () => new Response('Service Unavailable', { status: 503 }));

      await assert.rejects(
        () => client.listConversations(),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 503);
          assert.equal(gErr.gatewayError.category, 'daemon');
          return true;
        },
      );
    });
  });

  // ── openConversation (detail) ───────────────────────────────────────────

  describe('openConversation', () => {
    it('sends GET to /conversations/:id and returns full detail', async () => {
      const responseBody = {
        conversation: conversationFixture(),
        recentTurns: [turnFixture()],
        totalTurnCount: 1,
        pendingApprovals: [],
      };
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(responseBody);
      });

      const result = await client.openConversation('conv-1');

      assert.ok(capturedUrl.endsWith('/conversations/conv-1'));
      assert.equal(result.conversation.id, 'conv-1');
      assert.equal(result.recentTurns.length, 1);
      assert.equal(result.totalTurnCount, 1);
    });

    it('throws GatewayRequestError when conversation not found', async () => {
      const errBody = gatewayErrorFixture();
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.openConversation('nonexistent'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          return true;
        },
      );
    });
  });

  // ── loadHistory ─────────────────────────────────────────────────────────

  describe('loadHistory', () => {
    it('sends GET to /conversations/:id/turns with query params', async () => {
      const responseBody = { turns: [turnFixture()], totalCount: 1, hasMore: false };
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(responseBody);
      });

      const result = await client.loadHistory('conv-1', {
        fromPosition: 1,
        toPosition: 5,
        limit: 25,
      });

      const url = new URL(capturedUrl);
      assert.ok(url.pathname.endsWith('/conversations/conv-1/turns'));
      assert.equal(url.searchParams.get('fromPosition'), '1');
      assert.equal(url.searchParams.get('toPosition'), '5');
      assert.equal(url.searchParams.get('limit'), '25');
      assert.equal(result.turns.length, 1);
      assert.equal(result.hasMore, false);
    });

    it('omits undefined query params', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({ turns: [], totalCount: 0, hasMore: false });
      });

      await client.loadHistory('conv-1');
      const url = new URL(capturedUrl);
      assert.equal(url.searchParams.has('fromPosition'), false);
      assert.equal(url.searchParams.has('toPosition'), false);
      assert.equal(url.searchParams.has('limit'), false);
    });

    it('supports a relative baseUrl', async () => {
      let capturedUrl = '';
      const client = buildClient(
        async (input) => {
          capturedUrl = stringifyInput(input);
          return jsonResponse({ turns: [], totalCount: 0, hasMore: false });
        },
        { baseUrl: '/gateway' },
      );

      await client.loadHistory('conv-1', { limit: 10 });

      assert.equal(capturedUrl, '/gateway/conversations/conv-1/turns?limit=10');
    });
  });

  // ── createConversation ──────────────────────────────────────────────────

  describe('createConversation', () => {
    it('sends POST to /conversations with body and returns the conversation', async () => {
      const conv = conversationFixture({ title: 'New chat' });
      let capturedMethod = '';
      let capturedBody = '';

      const client = buildClient(async (_input, init) => {
        capturedMethod = init?.method ?? '';
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(conv);
      });

      const result = await client.createConversation({ title: 'New chat' });

      assert.equal(capturedMethod, 'POST');
      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.title, 'New chat');
      assert.equal(result.id, 'conv-1');
      assert.equal(result.title, 'New chat');
    });

    it('supports fork parameters', async () => {
      let capturedBody = '';
      const client = buildClient(async (_input, init) => {
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(conversationFixture());
      });

      await client.createConversation({
        parentConversationId: 'parent-1',
        forkPointTurnId: 'turn-5',
      });

      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.parentConversationId, 'parent-1');
      assert.equal(parsed.forkPointTurnId, 'turn-5');
    });

    it('sends empty body when no options provided', async () => {
      let capturedBody = '';
      const client = buildClient(async (_input, init) => {
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(conversationFixture());
      });

      await client.createConversation();
      const parsed = JSON.parse(capturedBody);
      assert.deepStrictEqual(parsed, {});
    });
  });

  // ── submitInstruction ───────────────────────────────────────────────────

  describe('submitInstruction', () => {
    it('sends POST to /conversations/:id/turns and returns turn + streamId', async () => {
      const responseBody = {
        turn: turnFixture({ instruction: 'Do something' }),
        streamId: 'stream-abc',
      };
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody = '';

      const client = buildClient(async (input, init) => {
        capturedUrl = stringifyInput(input);
        capturedMethod = init?.method ?? '';
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(responseBody);
      });

      const result = await client.submitInstruction('conv-1', {
        instruction: 'Do something',
      });

      assert.ok(capturedUrl.endsWith('/conversations/conv-1/turns'));
      assert.equal(capturedMethod, 'POST');
      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.instruction, 'Do something');
      assert.equal(result.turn.id, 'turn-1');
      assert.equal(result.streamId, 'stream-abc');
    });

    it('passes metadata through to the body', async () => {
      let capturedBody = '';
      const client = buildClient(async (_input, init) => {
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse({
          turn: turnFixture(),
          streamId: 'stream-1',
        });
      });

      await client.submitInstruction('conv-1', {
        instruction: 'Test',
        metadata: { source: 'ui' },
      });

      const parsed = JSON.parse(capturedBody);
      assert.deepStrictEqual(parsed.metadata, { source: 'ui' });
    });

    it('throws GatewayRequestError on validation error', async () => {
      const errBody = gatewayErrorFixture({
        code: 'INVALID_INPUT',
        category: 'validation',
        message: 'Instruction cannot be empty',
      });

      const client = buildClient(async () => errorResponse(errBody, 422));

      await assert.rejects(
        () => client.submitInstruction('conv-1', { instruction: '' }),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.gatewayError.code, 'INVALID_INPUT');
          assert.equal(gErr.status, 422);
          return true;
        },
      );
    });
  });

  // ── getPendingApprovals ──────────────────────────────────────────────

  describe('getPendingApprovals', () => {
    it('sends GET to /conversations/:id/approvals and returns approvals array', async () => {
      const approval = approvalFixture();
      const responseBody = { approvals: [approval] };
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(responseBody);
      });

      const result = await client.getPendingApprovals('conv-1');

      assert.ok(capturedUrl.endsWith('/conversations/conv-1/approvals'));
      assert.equal(result.approvals.length, 1);
      assert.equal(result.approvals[0].id, 'approval-1');
      assert.equal(result.approvals[0].status, 'pending');
    });

    it('returns empty approvals array when none are pending', async () => {
      const client = buildClient(async () => jsonResponse({ approvals: [] }));

      const result = await client.getPendingApprovals('conv-1');
      assert.deepStrictEqual(result.approvals, []);
    });

    it('encodes special characters in conversation ID', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({ approvals: [] });
      });

      await client.getPendingApprovals('conv/special&id');
      assert.ok(capturedUrl.includes(encodeURIComponent('conv/special&id')));
    });

    it('throws GatewayRequestError when conversation not found', async () => {
      const errBody = gatewayErrorFixture();
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.getPendingApprovals('nonexistent'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          assert.equal(gErr.gatewayError.code, 'NOT_FOUND');
          return true;
        },
      );
    });

    it('supports a relative baseUrl', async () => {
      let capturedUrl = '';
      const client = buildClient(
        async (input) => {
          capturedUrl = stringifyInput(input);
          return jsonResponse({ approvals: [] });
        },
        { baseUrl: '/gateway' },
      );

      await client.getPendingApprovals('conv-1');
      assert.equal(capturedUrl, '/gateway/conversations/conv-1/approvals');
    });
  });

  // ── respondToApproval ─────────────────────────────────────────────

  describe('respondToApproval', () => {
    it('sends POST to /approvals/:id/respond with response body', async () => {
      const updatedApproval = approvalFixture({
        status: 'responded',
        response: 'allow',
        respondedAt: NOW,
      });
      const responseBody = { success: true, approval: updatedApproval };
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody = '';

      const client = buildClient(async (input, init) => {
        capturedUrl = stringifyInput(input);
        capturedMethod = init?.method ?? '';
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(responseBody);
      });

      const result = await client.respondToApproval('approval-1', { response: 'allow' });

      assert.ok(capturedUrl.endsWith('/approvals/approval-1/respond'));
      assert.equal(capturedMethod, 'POST');
      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.response, 'allow');
      assert.equal(result.success, true);
      assert.equal(result.approval.status, 'responded');
      assert.equal(result.approval.response, 'allow');
    });

    it('passes acknowledgeStaleness flag in body', async () => {
      let capturedBody = '';
      const client = buildClient(async (_input, init) => {
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse({
          success: true,
          approval: approvalFixture({ status: 'responded', response: 'allow' }),
        });
      });

      await client.respondToApproval('approval-1', {
        response: 'allow',
        acknowledgeStaleness: true,
      });

      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.response, 'allow');
      assert.equal(parsed.acknowledgeStaleness, true);
    });

    it('returns conflict notification when present', async () => {
      const responseBody = {
        success: true,
        approval: approvalFixture({ status: 'responded', response: 'allow' }),
        conflictNotification: { message: 'Context has changed since approval was created' },
      };
      const client = buildClient(async () => jsonResponse(responseBody));

      const result = await client.respondToApproval('approval-1', { response: 'allow' });

      assert.equal(
        result.conflictNotification?.message,
        'Context has changed since approval was created',
      );
    });

    it('encodes special characters in approval ID', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({
          success: true,
          approval: approvalFixture({ status: 'responded', response: 'allow' }),
        });
      });

      await client.respondToApproval('approval/special&id', { response: 'allow' });
      assert.ok(capturedUrl.includes(encodeURIComponent('approval/special&id')));
    });

    it('throws GatewayRequestError on 409 conflict', async () => {
      const errBody = gatewayErrorFixture({
        code: 'CONFLICT',
        category: 'validation',
        message: 'Approval already responded',
      });
      const client = buildClient(async () => errorResponse(errBody, 409));

      await assert.rejects(
        () => client.respondToApproval('approval-1', { response: 'allow' }),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 409);
          assert.equal(gErr.gatewayError.code, 'CONFLICT');
          return true;
        },
      );
    });

    it('throws GatewayRequestError on 404 expired approval', async () => {
      const errBody = gatewayErrorFixture({
        code: 'NOT_FOUND',
        message: 'Approval not found or expired',
      });
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.respondToApproval('approval-gone', { response: 'allow' }),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          return true;
        },
      );
    });

    it('includes CSRF token on POST', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({
            success: true,
            approval: approvalFixture({ status: 'responded', response: 'deny' }),
          });
        },
        { getCsrfToken: () => 'csrf-approval' },
      );

      await client.respondToApproval('approval-1', { response: 'deny' });

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-approval');
    });
  });

  // ── Request headers ─────────────────────────────────────────────────────

  describe('request headers', () => {
    it('includes Content-Type and Accept for all requests', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(async (_input, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse({ conversations: [], totalCount: 0 });
      });

      await client.listConversations();

      assert.ok(capturedHeaders);
      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('Content-Type'), 'application/json');
      assert.equal(headers.get('Accept'), 'application/json');
    });

    it('includes credentials: include for cookie-based auth', async () => {
      let capturedCredentials: CapturedCredentials;

      const client = buildClient(async (_input, init) => {
        capturedCredentials = init?.credentials;
        return jsonResponse({ conversations: [], totalCount: 0 });
      });

      await client.listConversations();
      assert.equal(capturedCredentials, 'include');
    });

    it('includes x-csrf-token on createConversation when a token is available', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(conversationFixture());
        },
        { getCsrfToken: () => 'csrf-123' },
      );

      await client.createConversation({ title: 'New chat' });

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-123');
    });

    it('includes x-csrf-token on submitInstruction when a token is available', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({ turn: turnFixture(), streamId: 'stream-1' });
        },
        { getCsrfToken: () => 'csrf-456' },
      );

      await client.submitInstruction('conv-1', { instruction: 'Ship it' });

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-456');
    });

    it('omits x-csrf-token on GET requests', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({ conversations: [], totalCount: 0 });
        },
        { getCsrfToken: () => 'csrf-789' },
      );

      await client.listConversations();

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.has('x-csrf-token'), false);
    });

    it('omits x-csrf-token on POST when no token is available', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(conversationFixture());
        },
        { getCsrfToken: () => null },
      );

      await client.createConversation({ title: 'New chat' });

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.has('x-csrf-token'), false);
    });

    it('treats malformed __csrf cookie values as unavailable', async () => {
      let capturedHeaders: CapturedHeaders;
      const restoreDocument = setDocumentCookieForTest('__csrf=%');

      try {
        const client = buildClient(async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(conversationFixture());
        });

        await client.createConversation({ title: 'New chat' });

        const headers = new Headers(capturedHeaders);
        assert.equal(headers.has('x-csrf-token'), false);
      } finally {
        restoreDocument();
      }
    });
  });

  // ── GatewayRequestError ─────────────────────────────────────────────────

  describe('GatewayRequestError', () => {
    it('exposes status, gatewayError, and message', () => {
      const body = gatewayErrorFixture({ message: 'Something broke' });
      const err = new GatewayRequestError(500, body);

      assert.ok(err instanceof Error);
      assert.equal(err.status, 500);
      assert.equal(err.gatewayError.code, 'NOT_FOUND');
      assert.ok(err.message.includes('Something broke'));
    });

    it('is an instance of Error with correct name', () => {
      const err = new GatewayRequestError(400, gatewayErrorFixture());
      assert.equal(err.name, 'GatewayRequestError');
      assert.ok(err instanceof Error);
    });
  });

  // ── cancelTurn ──────────────────────────────────────────────────────────

  describe('cancelTurn', () => {
    it('sends POST to /conversations/:convId/turns/:turnId/cancel and returns updated turn', async () => {
      const cancelledTurn = turnFixture({ status: 'cancelled' });
      const responseBody = { success: true, turn: cancelledTurn };
      let capturedUrl = '';
      let capturedMethod = '';

      const client = buildClient(async (input, init) => {
        capturedUrl = stringifyInput(input);
        capturedMethod = init?.method ?? '';
        return jsonResponse(responseBody);
      });

      const result = await client.cancelTurn('conv-1', 'turn-1');

      assert.ok(capturedUrl.endsWith('/conversations/conv-1/turns/turn-1/cancel'));
      assert.equal(capturedMethod, 'POST');
      assert.equal(result.success, true);
      assert.equal(result.turn.status, 'cancelled');
    });

    it('includes CSRF token on POST', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({
            success: true,
            turn: turnFixture({ status: 'cancelled' }),
          });
        },
        { getCsrfToken: () => 'csrf-cancel' },
      );

      await client.cancelTurn('conv-1', 'turn-1');

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-cancel');
    });

    it('encodes special characters in conversation and turn IDs', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({ success: true, turn: turnFixture({ status: 'cancelled' }) });
      });

      await client.cancelTurn('conv/special', 'turn&special');
      assert.ok(capturedUrl.includes(encodeURIComponent('conv/special')));
      assert.ok(capturedUrl.includes(encodeURIComponent('turn&special')));
    });

    it('throws GatewayRequestError on 409 conflict (turn already completed)', async () => {
      const errBody = gatewayErrorFixture({
        code: 'CONFLICT',
        category: 'validation',
        message: 'Turn already completed',
      });
      const client = buildClient(async () => errorResponse(errBody, 409));

      await assert.rejects(
        () => client.cancelTurn('conv-1', 'turn-1'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 409);
          assert.equal(gErr.gatewayError.code, 'CONFLICT');
          return true;
        },
      );
    });

    it('throws GatewayRequestError on 404 when turn not found', async () => {
      const errBody = gatewayErrorFixture({
        code: 'NOT_FOUND',
        message: 'Turn not found',
      });
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.cancelTurn('conv-1', 'turn-missing'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          return true;
        },
      );
    });
  });

  // ── retryTurn ─────────────────────────────────────────────────────────

  describe('retryTurn', () => {
    it('sends POST to /conversations/:convId/turns/:turnId/retry and returns new turn + streamId', async () => {
      const retriedTurn = turnFixture({ id: 'turn-2', status: 'submitted' });
      const responseBody = { turn: retriedTurn, streamId: 'stream-retry-1' };
      let capturedUrl = '';
      let capturedMethod = '';

      const client = buildClient(async (input, init) => {
        capturedUrl = stringifyInput(input);
        capturedMethod = init?.method ?? '';
        return jsonResponse(responseBody);
      });

      const result = await client.retryTurn('conv-1', 'turn-1');

      assert.ok(capturedUrl.endsWith('/conversations/conv-1/turns/turn-1/retry'));
      assert.equal(capturedMethod, 'POST');
      assert.equal(result.turn.id, 'turn-2');
      assert.equal(result.streamId, 'stream-retry-1');
    });

    it('includes CSRF token on POST', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({
            turn: turnFixture({ id: 'turn-2', status: 'submitted' }),
            streamId: 'stream-retry',
          });
        },
        { getCsrfToken: () => 'csrf-retry' },
      );

      await client.retryTurn('conv-1', 'turn-1');

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-retry');
    });

    it('encodes special characters in conversation and turn IDs', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({
          turn: turnFixture({ status: 'submitted' }),
          streamId: 'stream-1',
        });
      });

      await client.retryTurn('conv/special', 'turn&special');
      assert.ok(capturedUrl.includes(encodeURIComponent('conv/special')));
      assert.ok(capturedUrl.includes(encodeURIComponent('turn&special')));
    });

    it('throws GatewayRequestError on 409 when turn is not retryable', async () => {
      const errBody = gatewayErrorFixture({
        code: 'CONFLICT',
        category: 'validation',
        message: 'Turn is not in a retryable state',
      });
      const client = buildClient(async () => errorResponse(errBody, 409));

      await assert.rejects(
        () => client.retryTurn('conv-1', 'turn-1'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 409);
          assert.equal(gErr.gatewayError.code, 'CONFLICT');
          return true;
        },
      );
    });

    it('throws GatewayRequestError on 404 when turn not found', async () => {
      const errBody = gatewayErrorFixture();
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.retryTurn('conv-1', 'turn-missing'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          return true;
        },
      );
    });
  });

  // ── branchConversation ────────────────────────────────────────────────

  describe('branchConversation', () => {
    it('sends POST to /conversations with parentConversationId + forkPointTurnId', async () => {
      const forkedConv = conversationFixture({ id: 'conv-forked' });
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody = '';

      const client = buildClient(async (input, init) => {
        capturedUrl = stringifyInput(input);
        capturedMethod = init?.method ?? '';
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(forkedConv);
      });

      const result = await client.branchConversation('conv-1', 'turn-3');

      assert.ok(capturedUrl.endsWith('/conversations'));
      assert.equal(capturedMethod, 'POST');
      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.parentConversationId, 'conv-1');
      assert.equal(parsed.forkPointTurnId, 'turn-3');
      assert.equal(result.id, 'conv-forked');
    });

    it('passes optional title through to create body', async () => {
      let capturedBody = '';
      const client = buildClient(async (_input, init) => {
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(conversationFixture({ id: 'conv-forked' }));
      });

      await client.branchConversation('conv-1', 'turn-3', { title: 'Branch from turn 3' });

      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.parentConversationId, 'conv-1');
      assert.equal(parsed.forkPointTurnId, 'turn-3');
      assert.equal(parsed.title, 'Branch from turn 3');
    });

    it('includes CSRF token on POST', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(conversationFixture({ id: 'conv-forked' }));
        },
        { getCsrfToken: () => 'csrf-branch' },
      );

      await client.branchConversation('conv-1', 'turn-3');

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-branch');
    });

    it('throws GatewayRequestError on 404 when source conversation or turn not found', async () => {
      const errBody = gatewayErrorFixture({
        code: 'NOT_FOUND',
        message: 'Source conversation not found',
      });
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.branchConversation('conv-missing', 'turn-1'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          return true;
        },
      );
    });

    it('throws GatewayRequestError on 422 when fork point is invalid', async () => {
      const errBody = gatewayErrorFixture({
        code: 'INVALID_INPUT',
        category: 'validation',
        message: 'Fork point turn does not belong to conversation',
      });
      const client = buildClient(async () => errorResponse(errBody, 422));

      await assert.rejects(
        () => client.branchConversation('conv-1', 'turn-wrong'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 422);
          assert.equal(gErr.gatewayError.code, 'INVALID_INPUT');
          return true;
        },
      );
    });
  });

  // ── followUp ──────────────────────────────────────────────────────────

  describe('followUp', () => {
    it('sends POST to /conversations/:id/turns with instruction body (same as submitInstruction)', async () => {
      const followUpTurn = turnFixture({ id: 'turn-follow', instruction: 'Continue with that' });
      const responseBody = { turn: followUpTurn, streamId: 'stream-follow' };
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody = '';

      const client = buildClient(async (input, init) => {
        capturedUrl = stringifyInput(input);
        capturedMethod = init?.method ?? '';
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse(responseBody);
      });

      const result = await client.followUp('conv-1', { instruction: 'Continue with that' });

      assert.ok(capturedUrl.endsWith('/conversations/conv-1/turns'));
      assert.equal(capturedMethod, 'POST');
      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.instruction, 'Continue with that');
      assert.equal(result.turn.id, 'turn-follow');
      assert.equal(result.streamId, 'stream-follow');
    });

    it('passes metadata through to the body', async () => {
      let capturedBody = '';
      const client = buildClient(async (_input, init) => {
        capturedBody = (init?.body as string) ?? '';
        return jsonResponse({
          turn: turnFixture(),
          streamId: 'stream-1',
        });
      });

      await client.followUp('conv-1', {
        instruction: 'Go ahead',
        metadata: { source: 'control-bar' },
      });

      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.instruction, 'Go ahead');
      assert.deepStrictEqual(parsed.metadata, { source: 'control-bar' });
    });

    it('includes CSRF token on POST', async () => {
      let capturedHeaders: CapturedHeaders;

      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({
            turn: turnFixture(),
            streamId: 'stream-1',
          });
        },
        { getCsrfToken: () => 'csrf-follow' },
      );

      await client.followUp('conv-1', { instruction: 'Continue' });

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'csrf-follow');
    });

    it('throws GatewayRequestError on validation error', async () => {
      const errBody = gatewayErrorFixture({
        code: 'INVALID_INPUT',
        category: 'validation',
        message: 'Instruction cannot be empty',
      });
      const client = buildClient(async () => errorResponse(errBody, 422));

      await assert.rejects(
        () => client.followUp('conv-1', { instruction: '' }),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 422);
          assert.equal(gErr.gatewayError.code, 'INVALID_INPUT');
          return true;
        },
      );
    });
  });

  // ── listArtifactsForTurn ─────────────────────────────────────────────────

  describe('listArtifactsForTurn', () => {
    const artifactFixture = (overrides: Record<string, unknown> = {}) => ({
      id: 'art-1',
      turnId: 'turn-1',
      kind: 'file' as const,
      label: 'main.ts',
      size: 1024,
      createdAt: NOW,
      ...overrides,
    });

    it('sends GET to /turns/:turnId/artifacts and returns artifacts', async () => {
      const artifacts = [artifactFixture()];
      const responseBody = { artifacts };
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(responseBody);
      });

      const result = await client.listArtifactsForTurn('turn-1');

      assert.ok(capturedUrl.endsWith('/turns/turn-1/artifacts'));
      assert.equal(result.artifacts.length, 1);
      assert.equal(result.artifacts[0].id, 'art-1');
      assert.equal(result.artifacts[0].kind, 'file');
    });

    it('encodes the turnId path parameter', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({ artifacts: [] });
      });

      await client.listArtifactsForTurn('turn/special&chars');

      assert.ok(capturedUrl.includes('/turns/turn%2Fspecial%26chars/artifacts'));
    });

    it('throws GatewayRequestError when turn not found', async () => {
      const errBody = gatewayErrorFixture({
        code: 'NOT_FOUND',
        message: 'Turn not found',
      });
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.listArtifactsForTurn('nonexistent'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          assert.equal(gErr.gatewayError.code, 'NOT_FOUND');
          return true;
        },
      );
    });

    it('uses GET method without CSRF header', async () => {
      let capturedHeaders: CapturedHeaders;
      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse({ artifacts: [] });
        },
        { getCsrfToken: () => 'csrf-tok' },
      );

      await client.listArtifactsForTurn('turn-1');

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.has('x-csrf-token'), false);
    });
  });

  // ── getArtifactContent ─────────────────────────────────────────────────

  describe('getArtifactContent', () => {
    const artifactWithContentFixture = (overrides: Record<string, unknown> = {}) => ({
      artifact: {
        id: 'art-1',
        turnId: 'turn-1',
        kind: 'file' as const,
        label: 'main.ts',
        size: 42,
        createdAt: NOW,
      },
      content: 'console.log("hello");',
      ...overrides,
    });

    it('sends GET to /artifacts/:artifactId and returns artifact with content', async () => {
      const responseBody = artifactWithContentFixture();
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(responseBody);
      });

      const result = await client.getArtifactContent('art-1');

      assert.ok(capturedUrl.endsWith('/artifacts/art-1'));
      assert.equal(result.artifact.id, 'art-1');
      assert.equal(result.content, 'console.log("hello");');
    });

    it('encodes the artifactId path parameter', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse(artifactWithContentFixture());
      });

      await client.getArtifactContent('art/special&id');

      assert.ok(capturedUrl.includes('/artifacts/art%2Fspecial%26id'));
    });

    it('throws GatewayRequestError when artifact not found', async () => {
      const errBody = gatewayErrorFixture({
        code: 'NOT_FOUND',
        message: 'Artifact not found',
      });
      const client = buildClient(async () => errorResponse(errBody, 404));

      await assert.rejects(
        () => client.getArtifactContent('nonexistent'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 404);
          assert.equal(gErr.gatewayError.code, 'NOT_FOUND');
          return true;
        },
      );
    });

    it('throws GatewayRequestError with fallback on non-JSON error', async () => {
      const client = buildClient(
        async () => new Response('Internal Server Error', { status: 500 }),
      );

      await assert.rejects(
        () => client.getArtifactContent('art-1'),
        (err: unknown) => {
          const gErr = assertGatewayError(err);
          assert.equal(gErr.status, 500);
          assert.equal(gErr.gatewayError.category, 'daemon');
          return true;
        },
      );
    });

    it('uses GET method without CSRF header', async () => {
      let capturedHeaders: CapturedHeaders;
      const client = buildClient(
        async (_input, init) => {
          capturedHeaders = init?.headers;
          return jsonResponse(artifactWithContentFixture());
        },
        { getCsrfToken: () => 'csrf-tok' },
      );

      await client.getArtifactContent('art-1');

      const headers = new Headers(capturedHeaders);
      assert.equal(headers.has('x-csrf-token'), false);
    });
  });

  // ── Network failure ─────────────────────────────────────────────────────

  describe('network failure', () => {
    it('propagates fetch errors directly (not wrapped)', async () => {
      const client = buildClient(async () => {
        throw new TypeError('Failed to fetch');
      });

      await assert.rejects(
        () => client.listConversations(),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          assert.ok(err.message.includes('Failed to fetch'));
          return true;
        },
      );
    });
  });
});
