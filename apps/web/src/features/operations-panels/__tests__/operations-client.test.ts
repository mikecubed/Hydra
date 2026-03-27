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

  it('fetches work item detail with encoded work item ID', async () => {
    let capturedUrl = '';
    const detailBody = {
      item: {
        id: 'wq-1',
        title: 'Task A',
        status: 'active',
        position: 0,
        relatedConversationId: null,
        relatedSessionId: null,
        ownerLabel: null,
        lastCheckpointSummary: null,
        updatedAt: NOW,
        riskSignals: [],
        detailAvailability: 'ready',
      },
      checkpoints: [],
      routing: null,
      assignments: [],
      council: null,
      controls: [],
      itemBudget: null,
      availability: 'ready',
    };

    const client = buildClient(async (input) => {
      capturedUrl = stringifyInput(input);
      return jsonResponse(detailBody);
    });

    const detail = await client.getWorkItemDetail('wq-1');
    assert.equal(capturedUrl, `${BASE_URL}/operations/work-items/wq-1`);
    assert.equal(detail.item.id, 'wq-1');
    assert.equal(detail.availability, 'ready');
  });

  it('forwards AbortSignal to fetch when provided', async () => {
    let capturedSignal: AbortSignal | null | undefined = null;
    const client = buildClient(async (_input, init) => {
      capturedSignal = init?.signal;
      return jsonResponse({
        item: {
          id: 'wq-1',
          title: 'Task A',
          status: 'active',
          position: 0,
          relatedConversationId: null,
          relatedSessionId: null,
          ownerLabel: null,
          lastCheckpointSummary: null,
          updatedAt: NOW,
          riskSignals: [],
          detailAvailability: 'ready',
        },
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      });
    });

    const abortController = new AbortController();
    await client.getWorkItemDetail('wq-1', { signal: abortController.signal });
    assert.ok(capturedSignal, 'AbortSignal should be forwarded to fetch');
    assert.equal(capturedSignal, abortController.signal);
    assert.equal(abortController.signal.aborted, false);
  });

  it('URL-encodes work item IDs containing special characters', async () => {
    let capturedUrl = '';
    const client = buildClient(async (input) => {
      capturedUrl = stringifyInput(input);
      return jsonResponse({
        item: {
          id: 'wq/special item',
          title: 'Special',
          status: 'active',
          position: 0,
          relatedConversationId: null,
          relatedSessionId: null,
          ownerLabel: null,
          lastCheckpointSummary: null,
          updatedAt: NOW,
          riskSignals: [],
          detailAvailability: 'ready',
        },
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      });
    });

    await client.getWorkItemDetail('wq/special item');
    assert.equal(capturedUrl, `${BASE_URL}/operations/work-items/wq%2Fspecial%20item`);
  });

  it('fetches work item checkpoints', async () => {
    let capturedUrl = '';
    const client = buildClient(async (input) => {
      capturedUrl = stringifyInput(input);
      return jsonResponse({
        workItemId: 'wq-1',
        checkpoints: [
          {
            id: 'cp-1',
            sequence: 0,
            label: 'Init',
            status: 'reached',
            timestamp: NOW,
            detail: null,
          },
        ],
        availability: 'ready',
      });
    });

    const result = await client.getWorkItemCheckpoints('wq-1');
    assert.equal(capturedUrl, `${BASE_URL}/operations/work-items/wq-1/checkpoints`);
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].id, 'cp-1');
  });

  it('fetches work item execution', async () => {
    let capturedUrl = '';
    const client = buildClient(async (input) => {
      capturedUrl = stringifyInput(input);
      return jsonResponse({
        workItemId: 'wq-1',
        routing: null,
        assignments: [],
        council: null,
        availability: 'ready',
      });
    });

    const result = await client.getWorkItemExecution('wq-1');
    assert.equal(capturedUrl, `${BASE_URL}/operations/work-items/wq-1/execution`);
    assert.equal(result.workItemId, 'wq-1');
  });

  it('throws OperationsResponseValidationError on invalid detail payloads', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        item: { id: 'wq-1', title: 'Task A', status: 'INVALID_STATUS' },
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      }),
    );

    await assert.rejects(
      () => client.getWorkItemDetail('wq-1'),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /Invalid work item detail response/u);
        return true;
      },
    );
  });

  it('throws OperationsResponseValidationError on non-monotonic checkpoint sequences', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        item: {
          id: 'wq-1',
          title: 'Task A',
          status: 'active',
          position: 0,
          relatedConversationId: null,
          relatedSessionId: null,
          ownerLabel: null,
          lastCheckpointSummary: null,
          updatedAt: NOW,
          riskSignals: [],
          detailAvailability: 'ready',
        },
        checkpoints: [
          {
            id: 'cp-1',
            sequence: 5,
            label: 'Later',
            status: 'reached',
            timestamp: NOW,
            detail: null,
          },
          {
            id: 'cp-2',
            sequence: 2,
            label: 'Earlier',
            status: 'reached',
            timestamp: NOW,
            detail: null,
          },
        ],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      }),
    );

    await assert.rejects(
      () => client.getWorkItemDetail('wq-1'),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /Invalid work item detail response/u);
        return true;
      },
    );
  });

  it('throws OperationsResponseValidationError when detail payload has extra fields', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        item: {
          id: 'wq-1',
          title: 'Task A',
          status: 'active',
          position: 0,
          relatedConversationId: null,
          relatedSessionId: null,
          ownerLabel: null,
          lastCheckpointSummary: null,
          updatedAt: NOW,
          riskSignals: [],
          detailAvailability: 'ready',
        },
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
        unexpectedField: 'should fail strict',
      }),
    );

    await assert.rejects(
      () => client.getWorkItemDetail('wq-1'),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        return true;
      },
    );
  });

  it('throws OperationsResponseValidationError when response ID mismatches requested ID', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        item: {
          id: 'wq-OTHER',
          title: 'Wrong Item',
          status: 'active',
          position: 0,
          relatedConversationId: null,
          relatedSessionId: null,
          ownerLabel: null,
          lastCheckpointSummary: null,
          updatedAt: NOW,
          riskSignals: [],
          detailAvailability: 'ready',
        },
        checkpoints: [],
        routing: null,
        assignments: [],
        council: null,
        controls: [],
        itemBudget: null,
        availability: 'ready',
      }),
    );

    await assert.rejects(
      () => client.getWorkItemDetail('wq-1'),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /ID mismatch/u);
        assert.match(err.message, /wq-1/u);
        assert.match(err.message, /wq-OTHER/u);
        return true;
      },
    );
  });

  // ─── T043: Control discovery, authority, pending, and result coverage ────

  it('calls discoverControls with the correct URL and body', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    const client = buildClient(async (input, init) => {
      capturedUrl = stringifyInput(input);
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as unknown;
      return jsonResponse({
        items: [
          {
            workItemId: 'wq-1',
            controls: [
              {
                controlId: 'ctrl-1',
                kind: 'routing',
                label: 'Route',
                availability: 'actionable',
                authority: 'granted',
                reason: null,
                options: [{ optionId: 'opt-1', label: 'A', selected: false, available: true }],
                expectedRevision: 'rev-1',
                lastResolvedAt: null,
              },
            ],
            availability: 'ready',
          },
        ],
      });
    });

    const result = await client.discoverControls({ workItemIds: ['wq-1'] });
    assert.equal(capturedUrl, `${BASE_URL}/operations/controls/discover`);
    assert.deepEqual(capturedBody, { workItemIds: ['wq-1'] });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].workItemId, 'wq-1');
    assert.equal(result.items[0].controls.length, 1);
  });

  it('calls getWorkItemControls with the correct URL', async () => {
    let capturedUrl = '';
    const client = buildClient(async (input) => {
      capturedUrl = stringifyInput(input);
      return jsonResponse({
        workItemId: 'wq-1',
        controls: [],
        availability: 'ready',
      });
    });

    const result = await client.getWorkItemControls('wq-1');
    assert.equal(capturedUrl, `${BASE_URL}/operations/work-items/wq-1/controls`);
    assert.equal(result.workItemId, 'wq-1');
    assert.deepEqual(result.controls, []);
  });

  it('submits a control action and returns the outcome', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    const client = buildClient(async (input, init) => {
      capturedUrl = stringifyInput(input);
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as unknown;
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

    const result = await client.submitControlAction('wq-1', 'ctrl-1', {
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });
    assert.equal(capturedUrl, `${BASE_URL}/operations/work-items/wq-1/controls/ctrl-1`);
    assert.deepEqual(capturedBody, { requestedOptionId: 'opt-1', expectedRevision: 'rev-1' });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.control.controlId, 'ctrl-1');
  });

  it('returns rejected outcome for unauthorized control action', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        outcome: 'rejected',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route',
          availability: 'read-only',
          authority: 'forbidden',
          reason: 'Operator lacks authority',
          options: [],
          expectedRevision: null,
          lastResolvedAt: NOW,
        },
        workItemId: 'wq-1',
        resolvedAt: NOW,
        message: 'Not authorized',
      }),
    );

    const result = await client.submitControlAction('wq-1', 'ctrl-1', {
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.control.authority, 'forbidden');
  });

  it('returns stale outcome when expectedRevision is outdated', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        outcome: 'stale',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route',
          availability: 'actionable',
          authority: 'granted',
          reason: null,
          options: [{ optionId: 'opt-1', label: 'A', selected: true, available: true }],
          expectedRevision: 'rev-3',
          lastResolvedAt: NOW,
        },
        workItemId: 'wq-1',
        resolvedAt: NOW,
        message: 'Revision outdated',
      }),
    );

    const result = await client.submitControlAction('wq-1', 'ctrl-1', {
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });
    assert.equal(result.outcome, 'stale');
  });

  it('returns superseded outcome when another control took precedence', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        outcome: 'superseded',
        control: {
          controlId: 'ctrl-1',
          kind: 'routing',
          label: 'Route',
          availability: 'read-only',
          authority: 'granted',
          reason: 'Superseded by ctrl-2',
          options: [],
          expectedRevision: null,
          lastResolvedAt: NOW,
        },
        workItemId: 'wq-1',
        resolvedAt: NOW,
      }),
    );

    const result = await client.submitControlAction('wq-1', 'ctrl-1', {
      requestedOptionId: 'opt-1',
      expectedRevision: 'rev-1',
    });
    assert.equal(result.outcome, 'superseded');
  });

  it('throws OperationsResponseValidationError on invalid work item controls payloads', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        workItemId: 'wq-1',
        controls: [],
      }),
    );

    await assert.rejects(
      () => client.getWorkItemControls('wq-1'),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /Invalid work item controls response/u);
        return true;
      },
    );
  });

  it('throws OperationsResponseValidationError on invalid control submit payloads', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        outcome: 'accepted',
        workItemId: 'wq-1',
        resolvedAt: NOW,
      }),
    );

    await assert.rejects(
      () =>
        client.submitControlAction('wq-1', 'ctrl-1', {
          requestedOptionId: 'opt-1',
          expectedRevision: 'rev-1',
        }),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /Invalid control submit response/u);
        return true;
      },
    );
  });

  it('throws OperationsResponseValidationError on invalid control discovery payloads', async () => {
    const client = buildClient(async () =>
      jsonResponse({
        items: [{ workItemId: 'wq-1' }],
      }),
    );

    await assert.rejects(
      () => client.discoverControls({ workItemIds: ['wq-1'] }),
      (err: unknown) => {
        assert.ok(err instanceof OperationsResponseValidationError);
        assert.match(err.message, /Invalid control discovery response/u);
        return true;
      },
    );
  });

  it('throws OperationsRequestError on control discovery HTTP errors', async () => {
    const client = buildClient(async () =>
      errorResponse(
        {
          ok: false,
          code: 'NOT_FOUND',
          category: 'validation',
          message: 'Work item not found',
          httpStatus: 404,
        },
        404,
      ),
    );

    await assert.rejects(
      () => client.discoverControls({ workItemIds: ['wq-missing'] }),
      (err: unknown) => {
        const gatewayError = assertOperationsError(err);
        assert.equal(gatewayError.status, 404);
        return true;
      },
    );
  });

  it('throws OperationsRequestError on control submit HTTP errors', async () => {
    const client = buildClient(async () =>
      errorResponse(
        {
          ok: false,
          code: 'CONFLICT',
          category: 'validation',
          message: 'Revision conflict',
          httpStatus: 409,
        },
        409,
      ),
    );

    await assert.rejects(
      () =>
        client.submitControlAction('wq-1', 'ctrl-1', {
          requestedOptionId: 'opt-1',
          expectedRevision: 'rev-1',
        }),
      (err: unknown) => {
        const gatewayError = assertOperationsError(err);
        assert.equal(gatewayError.status, 409);
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
