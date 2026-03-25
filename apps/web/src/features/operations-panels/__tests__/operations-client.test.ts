/**
 * Tests for the browser-side operations panels client.
 *
 * Verifies relative base URLs, repeated query parameters, default CSRF behavior,
 * and structured gateway error handling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOperationsClient,
  OperationsRequestError,
  OperationsResponseValidationError,
  type OperationsClient,
  type OperationsClientOptions,
} from '../api/operations-client.ts';
import type { GatewayErrorBody } from '../../../shared/gateway-errors.ts';

const BASE_URL = 'https://gw.test';
const NOW = '2026-06-01T12:00:00.000Z';

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

function buildClient(fetchFn: FetchFn, opts?: Partial<OperationsClientOptions>): OperationsClient {
  return createOperationsClient({
    baseUrl: BASE_URL,
    fetch: fetchFn,
    ...opts,
  });
}

function stringifyInput(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
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

function assertOperationsError(err: unknown): OperationsRequestError {
  assert.ok(err instanceof OperationsRequestError);
  return err;
}

describe('OperationsClient', () => {
  it('supports a relative baseUrl for snapshot requests', async () => {
    let capturedUrl = '';
    const client = buildClient(
      async (input) => {
        capturedUrl = stringifyInput(input);
        return jsonResponse({
          queue: [],
          health: null,
          budget: null,
          availability: 'ready',
          lastSynchronizedAt: NOW,
          nextCursor: null,
        });
      },
      { baseUrl: '/gateway' },
    );

    await client.getSnapshot({ statusFilter: ['active', 'paused'], limit: 20 });

    assert.equal(
      capturedUrl,
      '/gateway/operations/snapshot?statusFilter=active&statusFilter=paused&limit=20',
    );
  });

  it('sends the default CSRF token on mutating requests', async () => {
    let capturedToken: string | null = null;
    let capturedCredentials: RequestInit['credentials'];
    const restoreDocument = setDocumentCookieForTest('__csrf=tok123');

    try {
      const client = buildClient(async (_input, init) => {
        const headers = new Headers(init?.headers);
        capturedToken = headers.get('x-csrf-token');
        capturedCredentials = init?.credentials;
        return jsonResponse({
          outcome: 'accepted',
          control: {
            controlId: 'ctrl-1',
            kind: 'routing',
            label: 'Route',
            availability: 'accepted',
            authority: 'granted',
            reason: null,
            options: [],
            expectedRevision: 'rev-2',
            lastResolvedAt: NOW,
          },
          workItemId: 'wq-1',
          resolvedAt: NOW,
        });
      });

      await client.submitControlAction('wq-1', 'ctrl-1', {
        requestedOptionId: 'opt-1',
        expectedRevision: 'rev-1',
      });
    } finally {
      restoreDocument();
    }

    assert.equal(capturedToken, 'tok123');
    assert.equal(capturedCredentials, 'include');
  });

  it('throws OperationsRequestError on structured gateway errors', async () => {
    const client = buildClient(async () =>
      errorResponse(
        {
          ok: false,
          code: 'CSRF_INVALID',
          category: 'auth',
          message: 'Bad CSRF token',
          httpStatus: 403,
        },
        403,
      ),
    );

    await assert.rejects(
      () =>
        client.discoverControls({
          workItemIds: ['wq-1'],
        }),
      (err: unknown) => {
        const gatewayError = assertOperationsError(err);
        assert.equal(gatewayError.status, 403);
        assert.equal(gatewayError.gatewayError.category, 'auth');
        return true;
      },
    );
  });

  it('throws OperationsResponseValidationError on invalid snapshot payloads', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        queue: [],
        health: {
          status: 'healthy',
          summary: 'not-contract-valid',
        },
        budget: null,
        availability: 'ready',
        lastSynchronizedAt: NOW,
        nextCursor: null,
      }),
    );

    await assert.rejects(
      () => client.getSnapshot(),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /Invalid operations snapshot response/u);
        return true;
      },
    );
  });
});
