/**
 * Tests for request-validator middleware (T009, T045).
 *
 * Validates that the middleware runs Zod safeParse on request bodies
 * and returns GatewayErrorResponse with category 'validation' on failure.
 *
 * T045 adds systematic malformed-body coverage for every conversation route
 * validator so that validation failures consistently return HTTP 400 with
 * { ok: false, code: 'VALIDATION_FAILED', category: 'validation' }.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  CreateConversationRequest,
  SubmitInstructionRequest,
  SubmitInstructionBody,
  ResumeConversationBody,
  RespondToApprovalRequest,
  ListConversationsRequest,
} from '@hydra/web-contracts';
import { LoadTurnHistoryQuery, ListArtifactsForConversationQuery } from '../conversation-routes.ts';
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

type FakeIssue = { path: ReadonlyArray<PropertyKey>; message: string };

function zodV4Number(): Record<string, unknown> {
  return { def: { type: 'number' } };
}

function zodV4Optional(innerType: Record<string, unknown>): Record<string, unknown> {
  return { def: { type: 'optional', innerType } };
}

function zodV4Nullable(innerType: Record<string, unknown>): Record<string, unknown> {
  return { def: { type: 'nullable', innerType } };
}

function zodV3Default(inner: Record<string, unknown>): Record<string, unknown> {
  return { _def: { typeName: 'ZodDefault', inner } };
}

function zodV4Array(element: Record<string, unknown>): Record<string, unknown> {
  return { def: { type: 'array', element } };
}

function zodV4Readonly(innerType: Record<string, unknown>): Record<string, unknown> {
  return { def: { type: 'readonly', innerType } };
}

function createFakeQuerySchema<T extends Record<string, unknown>>(options: {
  shape: Record<string, unknown>;
  parse: (
    raw: Record<string, unknown>,
  ) => { success: true; data: T } | { success: false; error: { issues: FakeIssue[] } };
}): {
  shape: Record<string, unknown>;
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: FakeIssue[] } };
} {
  return {
    shape: options.shape,
    safeParse(data: unknown) {
      if (data === null || typeof data !== 'object') {
        return { success: false, error: { issues: [{ path: [], message: 'expected object' }] } };
      }
      return options.parse(data as Record<string, unknown>);
    },
  };
}

/**
 * Assert the standard validation-error contract:
 * HTTP 400, ok: false, category: 'validation', code: 'VALIDATION_FAILED', non-empty message.
 */
async function assertValidationError(
  res: Response,
  opts: { messagePart?: string } = {},
): Promise<GatewayErrorResponse> {
  assert.equal(res.status, 400, `expected HTTP 400, got ${res.status}`);
  const body = (await res.json()) as GatewayErrorResponse;
  assert.equal(body.ok, false);
  assert.equal(body.category, 'validation');
  assert.equal(body.code, 'VALIDATION_FAILED');
  assert.ok(body.message.length > 0, 'error message should be non-empty');
  if (opts.messagePart) {
    assert.ok(
      body.message.toLowerCase().includes(opts.messagePart.toLowerCase()),
      `expected message to mention "${opts.messagePart}", got: "${body.message}"`,
    );
  }
  return body;
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

describe('validateQuery numeric coercion — wrapper shapes (Issue 3 fix)', () => {
  it('coerces Zod v4 optional-number wrapper fields from query strings', async () => {
    const schema = createFakeQuerySchema<{ count?: number; name?: string }>({
      shape: {
        count: zodV4Optional(zodV4Number()),
        name: { def: { type: 'string' } },
      },
      parse(raw) {
        if (typeof raw['count'] !== 'number' || typeof raw['name'] !== 'string') {
          return {
            success: false,
            error: { issues: [{ path: ['count'], message: 'count must be a number' }] },
          };
        }
        return { success: true, data: { count: raw['count'], name: raw['name'] } };
      },
    });
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      const parsed = c.get('validatedQuery' as never) as { count?: number; name?: string };
      return c.json({ parsed });
    });

    const res = await app.request(buildRequest('GET', '/test?count=42&name=hello'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { count: number; name: string } };
    assert.equal(typeof body.parsed.count, 'number');
    assert.equal(body.parsed.count, 42);
    assert.equal(typeof body.parsed.name, 'string');
    assert.equal(body.parsed.name, 'hello');
  });

  it('coerces Zod v4 nullable-number wrapper fields from query strings', async () => {
    const schema = createFakeQuerySchema<{ offset: number | null }>({
      shape: {
        offset: zodV4Nullable(zodV4Number()),
      },
      parse(raw) {
        if (typeof raw['offset'] !== 'number') {
          return {
            success: false,
            error: { issues: [{ path: ['offset'], message: 'offset must be a number' }] },
          };
        }
        return { success: true, data: { offset: raw['offset'] } };
      },
    });
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      const parsed = c.get('validatedQuery' as never) as { offset: number | null };
      return c.json({ parsed });
    });

    const res = await app.request(buildRequest('GET', '/test?offset=7'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { offset: number } };
    assert.equal(typeof body.parsed.offset, 'number');
    assert.equal(body.parsed.offset, 7);
  });

  it('coerces Zod v3 default-number wrapper fields from query strings', async () => {
    const schema = createFakeQuerySchema<{ page: number }>({
      shape: {
        page: zodV3Default(zodV4Number()),
      },
      parse(raw) {
        const page = raw['page'] === undefined ? 1 : raw['page'];
        if (typeof page !== 'number') {
          return {
            success: false,
            error: { issues: [{ path: ['page'], message: 'page must be a number' }] },
          };
        }
        return { success: true, data: { page } };
      },
    });
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      const parsed = c.get('validatedQuery' as never) as { page: number };
      return c.json({ parsed });
    });

    // Provided value
    const res = await app.request(buildRequest('GET', '/test?page=3'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { page: number } };
    assert.equal(typeof body.parsed.page, 'number');
    assert.equal(body.parsed.page, 3);

    // Default kicks in
    const res2 = await app.request(buildRequest('GET', '/test'));
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as { parsed: { page: number } };
    assert.equal(body2.parsed.page, 1);
  });

  it('does not coerce string fields even when they look numeric', async () => {
    const schema = createFakeQuerySchema<{ token?: string; limit: number }>({
      shape: {
        token: { def: { type: 'string' } },
        limit: zodV3Default(zodV4Number()),
      },
      parse(raw) {
        const limit = raw['limit'] === undefined ? 10 : raw['limit'];
        if (typeof raw['token'] !== 'string' || typeof limit !== 'number') {
          return {
            success: false,
            error: { issues: [{ path: ['limit'], message: 'limit must be a number' }] },
          };
        }
        return { success: true, data: { token: raw['token'], limit } };
      },
    });
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      const parsed = c.get('validatedQuery' as never) as { token?: string; limit: number };
      return c.json({ parsed });
    });

    const res = await app.request(buildRequest('GET', '/test?token=99999&limit=5'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { token: string; limit: number } };
    assert.equal(typeof body.parsed.token, 'string');
    assert.equal(body.parsed.token, '99999');
    assert.equal(typeof body.parsed.limit, 'number');
    assert.equal(body.parsed.limit, 5);
  });

  it('preserves repeated query params for schema-declared array fields', async () => {
    const schema = createFakeQuerySchema<{ statusFilter: string[]; limit: number }>({
      shape: {
        statusFilter: zodV4Readonly(zodV4Array({ def: { type: 'string' } })),
        limit: zodV4Optional(zodV4Number()),
      },
      parse(raw) {
        if (!Array.isArray(raw['statusFilter']) || typeof raw['limit'] !== 'number') {
          return {
            success: false,
            error: {
              issues: [{ path: ['statusFilter'], message: 'statusFilter must be an array' }],
            },
          };
        }
        return {
          success: true,
          data: {
            statusFilter: raw['statusFilter'] as string[],
            limit: raw['limit'],
          },
        };
      },
    });
    const app = new Hono();
    app.get('/test', validateQuery(schema), (c) => {
      const parsed = c.get('validatedQuery' as never) as { statusFilter: string[]; limit: number };
      return c.json({ parsed });
    });

    const res = await app.request(
      buildRequest('GET', '/test?statusFilter=active&statusFilter=paused&limit=2'),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parsed: { statusFilter: string[]; limit: number } };
    assert.deepStrictEqual(body.parsed.statusFilter, ['active', 'paused']);
    assert.equal(body.parsed.limit, 2);
  });
});

// ── T045: Systematic malformed-body coverage per conversation route schema ───

describe('validateBody — CreateConversationRequest malformed bodies', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.post('/conversations', validateBody(CreateConversationRequest), (c) =>
      c.json({ ok: true }),
    );
    return app;
  }

  it('rejects title as non-string (number)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', { body: JSON.stringify({ title: 42 }) }),
    );
    await assertValidationError(res);
  });

  it('rejects parentConversationId as empty string (min 1)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', {
        body: JSON.stringify({ parentConversationId: '' }),
      }),
    );
    await assertValidationError(res);
  });

  it('rejects forkPointTurnId as empty string (min 1)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', {
        body: JSON.stringify({ forkPointTurnId: '' }),
      }),
    );
    await assertValidationError(res);
  });

  it('accepts parentConversationId without forkPointTurnId at schema layer', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', {
        body: JSON.stringify({ parentConversationId: 'conv-1' }),
      }),
    );
    assert.equal(res.status, 200);
  });

  it('accepts forkPointTurnId without parentConversationId at schema layer', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', {
        body: JSON.stringify({ forkPointTurnId: 'turn-1' }),
      }),
    );
    assert.equal(res.status, 200);
  });

  it('rejects a JSON array body', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', { body: JSON.stringify([1, 2, 3]) }),
    );
    await assertValidationError(res);
  });

  it('rejects a JSON null body', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', { body: JSON.stringify(null) }),
    );
    await assertValidationError(res);
  });

  it('rejects a JSON string body', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', { body: JSON.stringify('hello') }),
    );
    await assertValidationError(res);
  });

  it('rejects a JSON number body', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/conversations', { body: JSON.stringify(123) }),
    );
    await assertValidationError(res);
  });
});

describe('validateBody — SubmitInstructionBody malformed bodies', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.post('/turns', validateBody(SubmitInstructionBody), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects missing instruction field entirely', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', { body: JSON.stringify({}) }),
    );
    await assertValidationError(res);
  });

  it('rejects instruction as wrong type (number)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', { body: JSON.stringify({ instruction: 99 }) }),
    );
    await assertValidationError(res);
  });

  it('rejects instruction as empty string (min 1)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', { body: JSON.stringify({ instruction: '' }) }),
    );
    await assertValidationError(res);
  });

  it('rejects instruction as null', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', { body: JSON.stringify({ instruction: null }) }),
    );
    await assertValidationError(res);
  });

  it('rejects metadata as non-object (string)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', {
        body: JSON.stringify({ instruction: 'do something', metadata: 'bad' }),
      }),
    );
    await assertValidationError(res);
  });

  it('rejects metadata as array', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', {
        body: JSON.stringify({ instruction: 'do something', metadata: [1, 2] }),
      }),
    );
    await assertValidationError(res);
  });

  it('passes valid body with optional metadata', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/turns', {
        body: JSON.stringify({ instruction: 'do something', metadata: { key: 'value' } }),
      }),
    );
    assert.equal(res.status, 200);
  });
});

describe('validateBody — ResumeConversationBody malformed bodies', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.post('/resume', validateBody(ResumeConversationBody), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects empty body — missing required lastAcknowledgedSeq', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/resume', { body: JSON.stringify({}) }),
    );
    await assertValidationError(res);
  });

  it('rejects lastAcknowledgedSeq as string', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/resume', {
        body: JSON.stringify({ lastAcknowledgedSeq: 'abc' }),
      }),
    );
    await assertValidationError(res);
  });

  it('rejects lastAcknowledgedSeq as negative number (nonnegative constraint)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/resume', { body: JSON.stringify({ lastAcknowledgedSeq: -1 }) }),
    );
    await assertValidationError(res);
  });

  it('rejects lastAcknowledgedSeq as float (int constraint)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/resume', { body: JSON.stringify({ lastAcknowledgedSeq: 3.14 }) }),
    );
    await assertValidationError(res);
  });

  it('passes lastAcknowledgedSeq = 0 (nonnegative allows zero)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/resume', { body: JSON.stringify({ lastAcknowledgedSeq: 0 }) }),
    );
    assert.equal(res.status, 200);
  });

  it('passes valid positive integer lastAcknowledgedSeq', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/resume', { body: JSON.stringify({ lastAcknowledgedSeq: 42 }) }),
    );
    assert.equal(res.status, 200);
  });
});

describe('validateBody — RespondToApprovalRequest malformed bodies', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.post('/respond', validateBody(RespondToApprovalRequest), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects missing response field entirely', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/respond', { body: JSON.stringify({}) }),
    );
    await assertValidationError(res);
  });

  it('rejects response as wrong type (number)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/respond', { body: JSON.stringify({ response: 123 }) }),
    );
    await assertValidationError(res);
  });

  it('rejects response as wrong type (boolean)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/respond', { body: JSON.stringify({ response: true }) }),
    );
    await assertValidationError(res);
  });

  it('rejects acknowledgeStaleness as wrong type (string)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/respond', {
        body: JSON.stringify({ response: 'approve', acknowledgeStaleness: 'yes' }),
      }),
    );
    await assertValidationError(res);
  });

  it('rejects acknowledgeStaleness as wrong type (number)', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/respond', {
        body: JSON.stringify({ response: 'approve', acknowledgeStaleness: 1 }),
      }),
    );
    await assertValidationError(res);
  });
});

describe('validateQuery — ListConversationsRequest malformed queries', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.get('/conversations', validateQuery(ListConversationsRequest), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects invalid status enum value', async () => {
    const res = await createApp().request(buildRequest('GET', '/conversations?status=deleted'));
    await assertValidationError(res);
  });

  it('rejects limit = 0 (positive constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/conversations?limit=0'));
    await assertValidationError(res);
  });

  it('rejects limit > 100 (max constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/conversations?limit=101'));
    await assertValidationError(res);
  });

  it('rejects limit as negative number', async () => {
    const res = await createApp().request(buildRequest('GET', '/conversations?limit=-10'));
    await assertValidationError(res);
  });

  it('rejects limit as non-numeric string', async () => {
    const res = await createApp().request(buildRequest('GET', '/conversations?limit=abc'));
    await assertValidationError(res);
  });
});

describe('validateQuery — LoadTurnHistoryQuery malformed queries', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.get('/turns', validateQuery(LoadTurnHistoryQuery), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects limit = 0 (positive constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns?limit=0'));
    await assertValidationError(res);
  });

  it('rejects limit > 100 (max constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns?limit=101'));
    await assertValidationError(res);
  });

  it('rejects fromPosition = 0 (positive constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns?fromPosition=0'));
    await assertValidationError(res);
  });

  it('rejects fromPosition as negative', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns?fromPosition=-1'));
    await assertValidationError(res);
  });

  it('rejects toPosition = 0 (positive constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns?toPosition=0'));
    await assertValidationError(res);
  });

  it('rejects toPosition as negative', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns?toPosition=-3'));
    await assertValidationError(res);
  });

  it('passes with no query params (all optional, defaults apply)', async () => {
    const res = await createApp().request(buildRequest('GET', '/turns'));
    assert.equal(res.status, 200);
  });

  it('passes with valid fromPosition and toPosition', async () => {
    const res = await createApp().request(
      buildRequest('GET', '/turns?fromPosition=1&toPosition=10&limit=50'),
    );
    assert.equal(res.status, 200);
  });
});

describe('validateQuery — ListArtifactsForConversationQuery malformed queries', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.get('/artifacts', validateQuery(ListArtifactsForConversationQuery), (c) =>
      c.json({ ok: true }),
    );
    return app;
  }

  it('rejects limit = 0 (positive constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/artifacts?limit=0'));
    await assertValidationError(res);
  });

  it('rejects limit > 100 (max constraint)', async () => {
    const res = await createApp().request(buildRequest('GET', '/artifacts?limit=200'));
    await assertValidationError(res);
  });

  it('rejects limit as negative', async () => {
    const res = await createApp().request(buildRequest('GET', '/artifacts?limit=-5'));
    await assertValidationError(res);
  });

  it('passes with no params (all optional, defaults apply)', async () => {
    const res = await createApp().request(buildRequest('GET', '/artifacts'));
    assert.equal(res.status, 200);
  });

  it('passes with kind and cursor as strings', async () => {
    const res = await createApp().request(
      buildRequest('GET', '/artifacts?kind=code&cursor=abc123&limit=10'),
    );
    assert.equal(res.status, 200);
  });
});

describe('validateBody — structural edge cases (non-JSON / wrong content)', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.post('/test', validateBody(SubmitInstructionBody), (c) => c.json({ ok: true }));
    return app;
  }

  it('rejects form-encoded body', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/test', {
        body: 'instruction=hello',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    await assertValidationError(res);
  });

  it('rejects empty string body', async () => {
    const res = await createApp().request(buildRequest('POST', '/test', { body: '' }));
    await assertValidationError(res);
  });

  it('rejects body that is a JSON boolean', async () => {
    const res = await createApp().request(
      buildRequest('POST', '/test', { body: JSON.stringify(true) }),
    );
    await assertValidationError(res);
  });
});
