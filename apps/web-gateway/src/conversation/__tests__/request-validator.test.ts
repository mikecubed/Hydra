/**
 * Tests for request-validator middleware (T009).
 *
 * Validates that the middleware runs Zod safeParse on request bodies
 * and returns GatewayErrorResponse with category 'validation' on failure.
 */
/* eslint-disable n/no-unsupported-features/node-builtins -- Request is stable in Node 24 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  CreateConversationRequest,
  SubmitInstructionRequest,
  RespondToApprovalRequest,
  ListConversationsRequest,
} from '@hydra/web-contracts';
import { validateBody, validateQuery } from '../request-validator.ts';
import type { GatewayErrorResponse } from '../../shared/gateway-error-response.ts';

function buildRequest(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : opts.body,
  });
}

describe('validateBody middleware', () => {
  it('passes valid CreateConversationRequest through', async () => {
    const app = new Hono();
    app.post('/test', validateBody(CreateConversationRequest), (c) => c.json({ ok: true }));

    const res = await app.request(
      buildRequest('POST', '/test', { body: JSON.stringify({ title: 'My conv' }) }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('passes empty body for CreateConversationRequest (all optional)', async () => {
    const app = new Hono();
    app.post('/test', validateBody(CreateConversationRequest), (c) => c.json({ ok: true }));

    const res = await app.request(buildRequest('POST', '/test', { body: JSON.stringify({}) }));
    assert.equal(res.status, 200);
  });

  it('rejects invalid SubmitInstructionRequest — missing required fields', async () => {
    const app = new Hono();
    app.post('/test', validateBody(SubmitInstructionRequest), (c) => c.json({ ok: true }));

    const res = await app.request(buildRequest('POST', '/test', { body: JSON.stringify({}) }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'validation');
    assert.ok(body.message.length > 0, 'error message should be present');
    assert.ok(body.code.length > 0, 'error code should be present');
  });

  it('rejects SubmitInstructionRequest with empty instruction', async () => {
    const app = new Hono();
    app.post('/test', validateBody(SubmitInstructionRequest), (c) => c.json({ ok: true }));

    const res = await app.request(
      buildRequest('POST', '/test', {
        body: JSON.stringify({ conversationId: 'c1', instruction: '' }),
      }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'validation');
  });

  it('passes valid SubmitInstructionRequest', async () => {
    const app = new Hono();
    app.post('/test', validateBody(SubmitInstructionRequest), (c) => c.json({ ok: true }));

    const res = await app.request(
      buildRequest('POST', '/test', {
        body: JSON.stringify({ conversationId: 'c1', instruction: 'Do something' }),
      }),
    );
    assert.equal(res.status, 200);
  });

  it('rejects RespondToApprovalRequest with empty response', async () => {
    const app = new Hono();
    app.post('/test', validateBody(RespondToApprovalRequest), (c) => c.json({ ok: true }));

    const res = await app.request(
      buildRequest('POST', '/test', { body: JSON.stringify({ response: '' }) }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'validation');
  });

  it('passes valid RespondToApprovalRequest', async () => {
    const app = new Hono();
    app.post('/test', validateBody(RespondToApprovalRequest), (c) => c.json({ ok: true }));

    const res = await app.request(
      buildRequest('POST', '/test', {
        body: JSON.stringify({ response: 'approve' }),
      }),
    );
    assert.equal(res.status, 200);
  });

  it('rejects malformed JSON body', async () => {
    const app = new Hono();
    app.post('/test', validateBody(CreateConversationRequest), (c) => c.json({ ok: true }));

    const res = await app.request(buildRequest('POST', '/test', { body: 'not json{{{' }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'validation');
  });

  it('stores parsed body in context variable', async () => {
    const app = new Hono();
    app.post('/test', validateBody(SubmitInstructionRequest), (c) => {
      const parsed = c.get('validatedBody' as never);
      return c.json({ parsed });
    });

    const payload = { conversationId: 'c1', instruction: 'hello' };
    const res = await app.request(buildRequest('POST', '/test', { body: JSON.stringify(payload) }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: typeof payload };
    assert.equal(body.parsed.conversationId, 'c1');
    assert.equal(body.parsed.instruction, 'hello');
  });
});

describe('validateQuery middleware', () => {
  it('passes valid ListConversationsRequest query params', async () => {
    const app = new Hono();
    app.get('/test', validateQuery(ListConversationsRequest), (c) => {
      const parsed = c.get('validatedQuery' as never);
      return c.json({ parsed });
    });

    const res = await app.request(buildRequest('GET', '/test?status=active&limit=10'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { status: string; limit: number } };
    assert.equal(body.parsed.status, 'active');
    assert.equal(body.parsed.limit, 10);
  });

  it('rejects invalid query params', async () => {
    const app = new Hono();
    app.get('/test', validateQuery(ListConversationsRequest), (c) => c.json({ ok: true }));

    const res = await app.request(buildRequest('GET', '/test?limit=-5'));
    assert.equal(res.status, 400);
    const body = (await res.json()) as GatewayErrorResponse;
    assert.equal(body.ok, false);
    assert.equal(body.category, 'validation');
  });

  it('applies defaults from schema', async () => {
    const app = new Hono();
    app.get('/test', validateQuery(ListConversationsRequest), (c) => {
      const parsed = c.get('validatedQuery' as never);
      return c.json({ parsed });
    });

    const res = await app.request(buildRequest('GET', '/test'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { limit: number } };
    assert.equal(body.parsed.limit, 20);
  });

  it('preserves numeric-looking cursor as string — no blanket coercion (Issue 3 regression)', async () => {
    const app = new Hono();
    app.get('/test', validateQuery(ListConversationsRequest), (c) => {
      const parsed = c.get('validatedQuery' as never) as { cursor?: string; limit: number };
      return c.json({ parsed });
    });

    const res = await app.request(buildRequest('GET', '/test?cursor=12345&limit=10'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { cursor: string; limit: number } };
    // cursor must remain a string even though it looks numeric
    assert.equal(typeof body.parsed.cursor, 'string');
    assert.equal(body.parsed.cursor, '12345');
    // limit should still be coerced to a number
    assert.equal(typeof body.parsed.limit, 'number');
    assert.equal(body.parsed.limit, 10);
  });
});
