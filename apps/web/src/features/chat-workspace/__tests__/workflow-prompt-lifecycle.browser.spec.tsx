/**
 * Browser workflow specs — prompt lifecycle end-to-end.
 *
 * Covers the gaps not exercised by unit tests in prompt-card.test.ts
 * and prompt-lifecycle.test.ts: full browser integration from stream
 * event / history load → React rendering → user interaction → API call
 * → state transition → DOM update.
 *
 * Scenarios:
 *   1. Pending prompt appears via stream event with context and action buttons
 *   2. Approve happy path: click → responding → API success → resolved summary
 *   3. API 409 conflict → stale message (no retry)
 *   4. API 404 not found → unavailable message (no retry)
 *   5. API error → error display → retry → resolved
 *   6. Turn completion auto-stales a pending prompt
 *   7. Streaming resumes after approval response
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  conversation,
  streamFrame,
  openAndSubscribe,
  transcriptArticles,
  EMPTY_HISTORY,
} from './browser-helpers.ts';

// ─── Shared setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  resetFakeWebSockets();
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Standard approval-prompt stream payload. */
function approvalPayload(
  approvalId: string,
  allowedResponses: string[] = ['approve', 'deny'],
  contextText = 'Approve the proposed changes?',
) {
  return {
    approvalId,
    allowedResponses,
    contextBlocks: [
      { blockId: `${approvalId}-ctx`, kind: 'text', text: contextText, metadata: null },
    ],
  };
}

function approvalRecord(
  approvalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: approvalId,
    turnId: 'turn-1',
    status: 'pending',
    prompt: 'Approve the proposed changes?',
    context: {},
    contextHash: 'ctx-hash',
    responseOptions: [
      { key: 'approve', label: 'Approve' },
      { key: 'deny', label: 'Deny' },
    ],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a successful RespondToApprovalResponse body. */
function approvalSuccessBody(approvalId: string, response: string) {
  return {
    success: true,
    approval: {
      id: approvalId,
      turnId: 'turn-1',
      status: 'responded',
      prompt: 'Approve the proposed changes?',
      context: {},
      contextHash: 'ctx-hash',
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'deny', label: 'Deny' },
      ],
      response,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  };
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response;

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> | null {
  if (typeof init?.body !== 'string') {
    return null;
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

/**
 * Install a fetch stub pre-configured with conversation list, empty history,
 * and empty approvals. The `respondHandler` customises the approval-respond endpoint.
 */
function installDefaultStub(
  respondHandler?: FetchHandler,
  approvals: readonly Record<string, unknown>[] = [],
): void {
  installFetchStub((url, init) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({
        conversations: [conversation('conv-1', 'Prompt lifecycle test')],
        totalCount: 1,
      });
    }
    if (url === '/conversations/conv-1/turns?limit=50') {
      return jsonResponse(EMPTY_HISTORY);
    }
    if (url === '/conversations/conv-1/approvals') {
      return jsonResponse({ approvals });
    }
    if (url.startsWith('/approvals/') && url.endsWith('/respond') && respondHandler) {
      return respondHandler(url, init);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

/** Render the app, wait for conversation button, open WS, return socket. */
async function renderAndSubscribe(): Promise<ReturnType<typeof openAndSubscribe>> {
  render(<AppProviders />);
  await screen.findByRole('button', { name: /prompt lifecycle test/i });
  return openAndSubscribe('conv-1');
}

/** Stream a started turn followed by an approval-prompt event. */
function streamApprovalPrompt(
  ws: ReturnType<typeof openAndSubscribe>,
  approvalId = 'p1',
  startSeq = 1,
  payload: Record<string, unknown> = approvalPayload(approvalId),
) {
  act(() => {
    ws.simulateMessage(
      streamFrame('conv-1', startSeq, 'turn-1', 'stream-started', {
        attribution: 'Claude',
      }),
    );
    ws.simulateMessage(streamFrame('conv-1', startSeq + 1, 'turn-1', 'approval-prompt', payload));
  });
}

function realApprovalPromptPayload(approvalId: string): Record<string, unknown> {
  return { approvalId };
}

function approvalErrorResponse(
  code: string,
  message: string,
  httpStatus: number,
  category = 'session',
): Response {
  return jsonResponse(
    {
      ok: false,
      code,
      category,
      message,
      httpStatus,
    },
    httpStatus,
  );
}

function recordApprovalRequest(
  requests: Array<{ url: string; init: RequestInit | undefined }>,
  response: Response,
): FetchHandler {
  return (url, init) => {
    requests.push({ url, init });
    return response;
  };
}

function installLiveHydrationRetryStub(nextApprovalResponse: () => Response): void {
  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({
        conversations: [conversation('conv-1', 'Prompt lifecycle test')],
        totalCount: 1,
      });
    }
    if (url === '/conversations/conv-1/turns?limit=50') {
      return jsonResponse(EMPTY_HISTORY);
    }
    if (url === '/conversations/conv-1/approvals') {
      return nextApprovalResponse();
    }
    if (url.startsWith('/approvals/') && url.endsWith('/respond')) {
      return jsonResponse(approvalSuccessBody('p-retry', 'approve'));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('prompt lifecycle browser workflows: rendering and success flow', () => {
  // ── 1. Pending prompt appears from stream event ──────────────────────────

  it('hydrates a live prompt from the real approvalId-only stream payload', async () => {
    installDefaultStub(undefined, [approvalRecord('p-live')]);
    const ws = await renderAndSubscribe();

    streamApprovalPrompt(ws, 'p-live', 1, realApprovalPromptPayload('p-live'));

    const card = await screen.findByTestId('approval-prompt');
    await screen.findByText('Approve the proposed changes?', undefined, { timeout: 5000 });

    expect(card).toHaveAttribute('data-prompt-status', 'pending');
    expect(screen.getByTestId('prompt-action-approve')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-action-deny')).toBeInTheDocument();
  });

  it('renders a pending prompt card with context and action buttons from a stream event', async () => {
    installDefaultStub(undefined, [approvalRecord('p1')]);
    const ws = await renderAndSubscribe();

    streamApprovalPrompt(ws, 'p1', 1, realApprovalPromptPayload('p1'));

    // PromptCard visible with pending status
    const card = await screen.findByTestId('approval-prompt');
    expect(card).toHaveAttribute('data-prompt-status', 'pending');
    expect(screen.getByText('⏳ Approval pending')).toBeInTheDocument();

    // Context block rendered
    expect(screen.getByText('Approve the proposed changes?')).toBeInTheDocument();

    // Action buttons present
    expect(screen.getByTestId('prompt-action-approve')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-action-deny')).toBeInTheDocument();

    // Contained within a transcript entry
    const articles = transcriptArticles();
    expect(articles.length).toBeGreaterThanOrEqual(1);
  });

  // ── 2. Approve happy path ────────────────────────────────────────────────

  it('transitions pending → responding → resolved when user approves', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    installDefaultStub(
      (url, init) => {
        requests.push({ url, init });
        return jsonResponse(approvalSuccessBody('p1', 'approve'));
      },
      [approvalRecord('p1')],
    );

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws, 'p1', 1, realApprovalPromptPayload('p1'));

    const card = await screen.findByTestId('approval-prompt');
    expect(card).toHaveAttribute('data-prompt-status', 'pending');

    // Click approve — fires begin-response then API call
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    // The mock fetch resolves instantly so the status may pass through
    // 'responding' within a single microtask. The responding state is
    // fully covered by the unit tests in prompt-card.test.ts. Here we
    // verify the end-to-end outcome in the browser.
    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'resolved');
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/approvals/p1/respond');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(parseRequestBody(requests[0]?.init)).toEqual({ response: 'approve' });

    // Summary displayed
    expect(screen.getByTestId('prompt-summary')).toBeInTheDocument();
    expect(screen.getByText(/Response:/)).toBeInTheDocument();

    // Buttons removed after resolution
    expect(screen.queryByTestId('prompt-actions')).not.toBeInTheDocument();

    // No error/stale artifacts
    expect(screen.queryByTestId('prompt-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-stale-message')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-unavailable-message')).not.toBeInTheDocument();
  });
});

describe('prompt lifecycle browser workflows: response terminal states', () => {
  // ── 3. 409 conflict → stale ─────────────────────────────────────────────

  it('marks prompt stale when API returns 409 conflict', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    installDefaultStub(
      recordApprovalRequest(
        requests,
        approvalErrorResponse('APPROVAL_STALE', 'Approval is stale', 409),
      ),
      [approvalRecord('p1')],
    );

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws, 'p1', 1, realApprovalPromptPayload('p1'));

    const card = await screen.findByTestId('approval-prompt');
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    // Transitions through responding → stale
    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'stale');
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/approvals/p1/respond');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(parseRequestBody(requests[0]?.init)).toEqual({ response: 'approve' });

    // Stale message visible
    expect(screen.getByTestId('prompt-stale-message')).toBeInTheDocument();
    expect(screen.getByText(/no longer actionable/)).toBeInTheDocument();

    // No action buttons (stale is not actionable)
    expect(screen.queryByTestId('prompt-actions')).not.toBeInTheDocument();
  });

  // ── 4. 404 not found → unavailable ──────────────────────────────────────

  it('marks prompt unavailable when API returns 409 already-responded', async () => {
    installDefaultStub(
      () => approvalErrorResponse('APPROVAL_ALREADY_RESPONDED', 'Approval already responded', 409),
      [approvalRecord('p1')],
    );

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws, 'p1', 1, realApprovalPromptPayload('p1'));

    const card = await screen.findByTestId('approval-prompt');
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'unavailable');
    });

    expect(screen.getByTestId('prompt-unavailable-message')).toBeInTheDocument();
    expect(screen.getByText(/no longer available/)).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-actions')).not.toBeInTheDocument();
  });

  it('marks prompt unavailable when API returns 404', async () => {
    installDefaultStub(
      () => approvalErrorResponse('NOT_FOUND', 'Approval not found', 404, 'validation'),
      [approvalRecord('p1')],
    );

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws, 'p1', 1, realApprovalPromptPayload('p1'));

    const card = await screen.findByTestId('approval-prompt');
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'unavailable');
    });

    expect(screen.getByTestId('prompt-unavailable-message')).toBeInTheDocument();
    expect(screen.getByText(/no longer available/)).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-actions')).not.toBeInTheDocument();
  });
});

describe('prompt lifecycle browser workflows: recovery and terminal states', () => {
  // ── 5. API error → retry → resolved ─────────────────────────────────────

  it('retries live prompt hydration until approvals become available', async () => {
    let approvalRequests = 0;
    installLiveHydrationRetryStub(() => {
      approvalRequests += 1;
      if (approvalRequests === 1) {
        return jsonResponse({ approvals: [] });
      }
      return jsonResponse({ approvals: [approvalRecord('p-retry')] });
    });

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws, 'p-retry', 1, realApprovalPromptPayload('p-retry'));

    const card = await screen.findByTestId('approval-prompt');
    expect(card).toHaveAttribute('data-prompt-status', 'pending');

    await screen.findByText('Approve the proposed changes?');
    expect(screen.getByTestId('prompt-action-approve')).toBeInTheDocument();
    expect(approvalRequests).toBe(2);
  });

  it('shows error state after API failure and resolves on retry', async () => {
    let callCount = 0;
    installDefaultStub(() => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse(
          {
            ok: false,
            code: 'INTERNAL',
            category: 'daemon',
            message: 'Internal server error',
            httpStatus: 500,
          },
          500,
        );
      }
      return jsonResponse(approvalSuccessBody('p1', 'approve'));
    });

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws);

    const card = await screen.findByTestId('approval-prompt');

    // First attempt fails
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'error');
    });

    // Error message displayed
    expect(screen.getByTestId('prompt-error')).toBeInTheDocument();

    // Action buttons still present (error is retryable)
    expect(screen.getByTestId('prompt-action-approve')).toBeInTheDocument();

    // Retry: second attempt succeeds
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'resolved');
    });

    expect(screen.getByTestId('prompt-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-error')).not.toBeInTheDocument();
  });

  // ── 6. Turn completion auto-stales a pending prompt ──────────────────────

  it('auto-stales a pending prompt when the owning turn completes', async () => {
    installDefaultStub();
    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws);

    const card = await screen.findByTestId('approval-prompt');
    expect(card).toHaveAttribute('data-prompt-status', 'pending');
    expect(screen.getByTestId('prompt-action-approve')).toBeInTheDocument();

    // Turn completes → reconciler marks prompt stale
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 3, 'turn-1', 'stream-completed', {}));
    });

    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'stale');
    });

    expect(screen.getByTestId('prompt-stale-message')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-actions')).not.toBeInTheDocument();
  });
});

describe('prompt lifecycle browser workflows: resumed streaming ownership', () => {
  // ── 7. Streaming resumes after approval response ─────────────────────────

  it('continues rendering text-delta events after an approval is resolved', async () => {
    installDefaultStub(() => jsonResponse(approvalSuccessBody('p1', 'approve')));

    const ws = await renderAndSubscribe();
    streamApprovalPrompt(ws);

    const card = await screen.findByTestId('approval-prompt');

    // Approve the prompt
    fireEvent.click(screen.getByTestId('prompt-action-approve'));

    await waitFor(() => {
      expect(card).toHaveAttribute('data-prompt-status', 'resolved');
    });

    // Stream continues with text-delta events in the same turn
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 3, 'turn-1', 'text-delta', { text: 'Continuing after approval…' }),
      );
    });

    expect(await screen.findByText('Continuing after approval…')).toBeInTheDocument();

    const articles = transcriptArticles();
    expect(articles).toHaveLength(1);
    const [article] = articles;
    expect(within(article).getByTestId('prompt-summary')).toBeInTheDocument();
    expect(within(article).getByText('Continuing after approval…')).toBeInTheDocument();

    // Stream completes — prompt should stay resolved (not regress to stale)
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 4, 'turn-1', 'stream-completed', {}));
    });

    await waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Text persists, prompt remains resolved
    expect(screen.getByText('Continuing after approval…')).toBeInTheDocument();
    expect(card).toHaveAttribute('data-prompt-status', 'resolved');
  });
});
