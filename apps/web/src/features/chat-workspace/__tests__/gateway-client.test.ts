/**
 * Tests for the browser-side gateway conversation client.
 *
 * Verifies list, detail (open), history, create, and submit operations,
 * including structured error handling via the gateway error parser
 * and CSRF double-submit token injection.
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

/** Build client with a CSRF token injected via getCsrfToken option. */
function buildClientWithCsrf(
  fetchFn: FetchFn,
  csrfToken: string | undefined,
): GatewayClient {
  return createGatewayClient({
    baseUrl: BASE_URL,
    fetch: fetchFn,
    getCsrfToken: () => csrfToken,
  });
}

/** Narrow unknown error to GatewayRequestError and return it. */
function assertGatewayError(err: unknown): GatewayRequestError {
  assert.ok(err instanceof GatewayRequestError);
  return err as GatewayRequestError;
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
        capturedUrl = String(input);
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
        capturedUrl = String(input);
        return jsonResponse({ conversations: [], totalCount: 0 });
      });

      await client.listConversations({ status: 'archived', cursor: 'abc', limit: 10 });

      const url = new URL(capturedUrl);
      assert.equal(url.searchParams.get('status'), 'archived');
      assert.equal(url.searchParams.get('cursor'), 'abc');
      assert.equal(url.searchParams.get('limit'), '10');
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
      const client = buildClient(async () => {
        return new Response('Service Unavailable', { status: 503 });
      });

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
        capturedUrl = String(input);
        return jsonResponse(responseBody);
      });

      const result = await client.openConversation('conv-1');

      assert.ok(
        capturedUrl.endsWith('/conversations/conv-1'),
        `expected URL to end with /conversations/conv-1, got: ${capturedUrl}`,
      );
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
    it('sends GET to /conversations/:convId/turns with query params', async () => {
      const responseBody = { turns: [turnFixture()], totalCount: 1, hasMore: false };
      let capturedUrl = '';

      const client = buildClient(async (input) => {
        capturedUrl = String(input);
        return jsonResponse(responseBody);
      });

      const result = await client.loadHistory('conv-1', {
        fromPosition: 1,
        toPosition: 5,
        limit: 25,
      });

      const url = new URL(capturedUrl);
      assert.ok(
        url.pathname.endsWith('/conversations/conv-1/turns'),
        `expected pathname to end with /conversations/conv-1/turns, got: ${url.pathname}`,
      );
      assert.equal(url.searchParams.get('fromPosition'), '1');
      assert.equal(url.searchParams.get('toPosition'), '5');
      assert.equal(url.searchParams.get('limit'), '25');
      assert.equal(result.turns.length, 1);
      assert.equal(result.hasMore, false);
    });

    it('omits undefined query params', async () => {
      let capturedUrl = '';
      const client = buildClient(async (input) => {
        capturedUrl = String(input);
        return jsonResponse({ turns: [], totalCount: 0, hasMore: false });
      });

      await client.loadHistory('conv-1');
      const url = new URL(capturedUrl);
      assert.equal(url.searchParams.has('fromPosition'), false);
      assert.equal(url.searchParams.has('toPosition'), false);
      assert.equal(url.searchParams.has('limit'), false);
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
        capturedUrl = String(input);
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

  // ── Request headers ─────────────────────────────────────────────────────

  describe('request headers', () => {
    it('includes Content-Type and Accept for all requests', async () => {
      let capturedHeaders: HeadersInit | undefined;

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
      let capturedCredentials: RequestCredentials | undefined;

      const client = buildClient(async (_input, init) => {
        capturedCredentials = init?.credentials;
        return jsonResponse({ conversations: [], totalCount: 0 });
      });

      await client.listConversations();
      assert.equal(capturedCredentials, 'include');
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

  // ── CSRF double-submit token ────────────────────────────────────────────

  describe('CSRF double-submit token', () => {
    it('includes x-csrf-token header on POST when getCsrfToken returns a token', async () => {
      let capturedHeaders: HeadersInit | undefined;

      const client = buildClientWithCsrf(async (_input, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse(conversationFixture());
      }, 'test-csrf-token');

      await client.createConversation({ title: 'csrf test' });

      assert.ok(capturedHeaders);
      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'test-csrf-token');
    });

    it('omits x-csrf-token header on POST when getCsrfToken returns undefined', async () => {
      let capturedHeaders: HeadersInit | undefined;

      const client = buildClientWithCsrf(async (_input, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse(conversationFixture());
      }, undefined);

      await client.createConversation({ title: 'no csrf' });

      assert.ok(capturedHeaders);
      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), null);
    });

    it('does not include x-csrf-token on GET requests', async () => {
      let capturedHeaders: HeadersInit | undefined;

      const client = buildClientWithCsrf(async (_input, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse({ conversations: [], totalCount: 0 });
      }, 'should-not-appear');

      await client.listConversations();

      assert.ok(capturedHeaders);
      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), null);
    });

    it('includes x-csrf-token on submitInstruction (POST)', async () => {
      let capturedHeaders: HeadersInit | undefined;

      const client = buildClientWithCsrf(async (_input, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse({ turn: turnFixture(), streamId: 'stream-1' });
      }, 'submit-csrf');

      await client.submitInstruction('conv-1', { instruction: 'Test' });

      assert.ok(capturedHeaders);
      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), 'submit-csrf');
    });

    it('does not include x-csrf-token on openConversation (GET)', async () => {
      let capturedHeaders: HeadersInit | undefined;

      const client = buildClientWithCsrf(async (_input, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse({
          conversation: conversationFixture(),
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        });
      }, 'should-not-appear');

      await client.openConversation('conv-1');

      assert.ok(capturedHeaders);
      const headers = new Headers(capturedHeaders);
      assert.equal(headers.get('x-csrf-token'), null);
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
          assert.ok((err as TypeError).message.includes('Failed to fetch'));
          return true;
        },
      );
    });
  });
});
