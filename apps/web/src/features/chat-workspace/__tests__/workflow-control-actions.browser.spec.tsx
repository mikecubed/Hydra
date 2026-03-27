/**
 * Browser workflow specs — transcript turn control actions.
 *
 * Phase 5 T037 coverage for cancel, retry, branch, and follow-up control
 * flows surfaced through the merged transcript. Each scenario exercises the
 * full gateway round-trip (fetch stub → store dispatch → DOM convergence)
 * rather than component-level unit wiring.
 *
 * Covers:
 *   1. Cancel in-progress turn via transcript controls
 *   1b. Cancel seal regression — late WS frames blocked by immediate seal
 *   2. Retry a failed turn — new turn appears and streaming continues
 *   3. Branch a completed turn — new conversation created with lineage badge
 *   4. Follow-up action — routes operator into composer flow
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

// ─── Setup / teardown ───────────────────────────────────────────────────────

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

// ─── Shared fixtures ────────────────────────────────────────────────────────

const BASE_TURN = {
  id: 'turn-1',
  conversationId: 'conv-1',
  position: 1,
  kind: 'system',
  attribution: { type: 'agent', label: 'Claude' },
  status: 'executing',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const COMPLETED_TURN = {
  ...BASE_TURN,
  status: 'completed',
  response: 'Here is the analysis.',
  completedAt: '2026-07-01T00:00:10.000Z',
};

const FAILED_TURN = {
  ...BASE_TURN,
  status: 'failed',
  response: 'Partial output before crash.',
  completedAt: '2026-07-01T00:00:05.000Z',
};

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installDeferredCancelFetchStub(
  title: string,
  backgroundReloadGate: Promise<Response>,
): { wasCancelPosted: () => boolean; transcriptReloadCount: () => number } {
  let cancelPosted = false;
  let transcriptReloadCount = 0;

  const handler = (url: string, init: RequestInit | undefined): Response | Promise<Response> => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({
        conversations: [conversation('conv-1', title)],
        totalCount: 1,
      });
    }
    if (url === '/conversations/conv-1/turns?limit=50') {
      transcriptReloadCount += 1;
      if (cancelPosted && transcriptReloadCount > 1) {
        return backgroundReloadGate;
      }
      return jsonResponse({
        turns: [BASE_TURN],
        totalCount: 1,
        hasMore: false,
      });
    }
    if (url === '/conversations/conv-1/turns/turn-1/cancel' && init?.method === 'POST') {
      cancelPosted = true;
      return jsonResponse({
        success: true,
        turn: { ...BASE_TURN, status: 'cancelled' },
      });
    }
    if (url === '/conversations/conv-1/approvals') {
      return jsonResponse({ approvals: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  fetchSpy.mockImplementation((input, init) =>
    Promise.resolve(handler(resolveFetchUrl(input), init)),
  );
  vi.stubGlobal('fetch', fetchSpy);

  return {
    wasCancelPosted: () => cancelPosted,
    transcriptReloadCount: () => transcriptReloadCount,
  };
}

function assertCancelledWithoutGhostContent(): void {
  expect(screen.getByText('cancelled')).toBeInTheDocument();
  expect(screen.queryByText('executing')).not.toBeInTheDocument();
  expect(screen.queryByText('GHOST CONTENT')).not.toBeInTheDocument();
}

async function runCancelSealRegressionScenario(): Promise<void> {
  let resolveBackgroundReload!: (value: Response) => void;
  const backgroundReloadGate = new Promise<Response>((resolve) => {
    resolveBackgroundReload = resolve;
  });

  const fetchState = installDeferredCancelFetchStub('Seal regression', backgroundReloadGate);

  render(<AppProviders />);

  await screen.findByRole('button', { name: /seal regression/i });
  const ws = openAndSubscribe('conv-1');
  expect(await screen.findByText('executing')).toBeInTheDocument();

  act(() => {
    ws.simulateMessage(
      streamFrame('conv-1', 1, 'turn-1', 'stream-started', { attribution: 'Claude' }),
    );
    ws.simulateMessage(
      streamFrame('conv-1', 2, 'turn-1', 'text-delta', { text: 'Pre-cancel output' }),
    );
  });

  expect(await screen.findByText('Pre-cancel output')).toBeInTheDocument();

  const cancelBtn = await screen.findByTestId('turn-action-cancel');
  fireEvent.click(cancelBtn);

  await vi.waitFor(() => {
    expect(fetchState.wasCancelPosted()).toBe(true);
  });
  await vi.waitFor(() => {
    expect(screen.getByText('cancelled')).toBeInTheDocument();
  });

  act(() => {
    ws.simulateMessage(streamFrame('conv-1', 3, 'turn-1', 'text-delta', { text: 'GHOST CONTENT' }));
  });
  assertCancelledWithoutGhostContent();

  act(() => {
    ws.simulateMessage(streamFrame('conv-1', 4, 'turn-1', 'stream-completed'));
  });
  assertCancelledWithoutGhostContent();

  const articles = transcriptArticles();
  expect(articles).toHaveLength(1);
  expect(within(articles[0]).getByText('cancelled')).toBeInTheDocument();

  resolveBackgroundReload(
    jsonResponse({
      turns: [{ ...BASE_TURN, status: 'cancelled' }],
      totalCount: 1,
      hasMore: false,
    }),
  );

  await vi.waitFor(() => {
    expect(fetchState.transcriptReloadCount()).toBeGreaterThanOrEqual(2);
  });

  assertCancelledWithoutGhostContent();
  expect(transcriptArticles()).toHaveLength(1);
}

// ─── 1. Cancel in-progress turn ─────────────────────────────────────────────

describe('cancel in-progress turn', () => {
  it('fires cancel POST and converges transcript to cancelled state without duplicates', async () => {
    let cancelPosted = false;

    installFetchStub((url, init) => {
      // List conversations
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Cancel test')],
          totalCount: 1,
        });
      }
      // Initial history: one executing turn
      if (url === '/conversations/conv-1/turns?limit=50') {
        // After cancel, the authoritative reload returns the cancelled turn
        if (cancelPosted) {
          return jsonResponse({
            turns: [{ ...BASE_TURN, status: 'cancelled' }],
            totalCount: 1,
            hasMore: false,
          });
        }
        return jsonResponse({
          turns: [BASE_TURN],
          totalCount: 1,
          hasMore: false,
        });
      }
      // Cancel endpoint
      if (url === '/conversations/conv-1/turns/turn-1/cancel' && init?.method === 'POST') {
        cancelPosted = true;
        return jsonResponse({
          success: true,
          turn: { ...BASE_TURN, status: 'cancelled' },
        });
      }
      // Approvals (may be fetched)
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    // Wait for the conversation to load and the executing turn to appear
    await screen.findByRole('button', { name: /cancel test/i });

    openAndSubscribe('conv-1');

    expect(await screen.findByText('executing')).toBeInTheDocument();

    // The Cancel button should already be visible on an authoritative in-flight turn.
    const cancelBtn = await screen.findByTestId('turn-action-cancel');
    expect(cancelBtn).toBeInTheDocument();

    // Click cancel
    fireEvent.click(cancelBtn);

    // After cancel POST, the transcript should converge to 'cancelled' status
    await vi.waitFor(() => {
      expect(screen.queryByText('executing')).not.toBeInTheDocument();
    });

    await vi.waitFor(() => {
      expect(screen.getByText('cancelled')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('turn-action-cancel')).not.toBeInTheDocument();

    // Verify: the cancel POST was actually sent
    expect(cancelPosted).toBe(true);

    // Verify: no duplicate transcript articles — should be exactly 1
    const articles = transcriptArticles();
    expect(articles).toHaveLength(1);

    // The single article should show the cancelled state
    expect(within(articles[0]).getByText('cancelled')).toBeInTheDocument();
  });

  it('seals cancelled turn so late websocket frames cannot resurrect it', async () => {
    await runCancelSealRegressionScenario();
  });
});

// ─── 2. Retry failed turn ──────────────────────────────────────────────────

describe('retry failed turn', () => {
  it('sends retry POST, appends new turn, and streaming continues on retried turn', async () => {
    let retryPosted = false;
    let retryPostCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Retry test')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        if (retryPosted) {
          return jsonResponse({
            turns: [
              FAILED_TURN,
              {
                id: 'turn-retry-1',
                conversationId: 'conv-1',
                position: 2,
                kind: 'system',
                attribution: { type: 'agent', label: 'Claude' },
                parentTurnId: 'turn-1',
                status: 'executing',
                createdAt: '2026-07-01T00:01:00.000Z',
              },
            ],
            totalCount: 2,
            hasMore: false,
          });
        }
        return jsonResponse({
          turns: [FAILED_TURN],
          totalCount: 1,
          hasMore: false,
        });
      }
      // Retry endpoint
      if (url === '/conversations/conv-1/turns/turn-1/retry' && init?.method === 'POST') {
        retryPosted = true;
        retryPostCount += 1;
        return jsonResponse({
          turn: {
            id: 'turn-retry-1',
            conversationId: 'conv-1',
            position: 2,
            kind: 'system',
            attribution: { type: 'agent', label: 'Claude' },
            parentTurnId: 'turn-1',
            status: 'executing',
            createdAt: '2026-07-01T00:01:00.000Z',
          },
          streamId: 'stream-retry-1',
        });
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    await screen.findByRole('button', { name: /retry test/i });
    const ws = openAndSubscribe('conv-1');

    // The failed turn should show the failure status and partial output
    expect(await screen.findByText('Partial output before crash.')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();

    // The Retry button should be visible on the failed turn
    const retryBtn = await screen.findByTestId('turn-action-retry');
    expect(retryBtn).toBeInTheDocument();

    // Click retry
    fireEvent.click(retryBtn);
    fireEvent.click(retryBtn);

    // Wait for the retry POST to fire and new turn to reconcile
    await vi.waitFor(() => {
      expect(retryPosted).toBe(true);
    });
    expect(retryPostCount).toBe(1);

    // Now the new turn appears via reconcileTurnEntry — simulate streaming on it
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 3, 'turn-retry-1', 'stream-started', { attribution: 'Claude' }),
      );
      ws.simulateMessage(
        streamFrame('conv-1', 4, 'turn-retry-1', 'text-delta', { text: 'Retried successfully!' }),
      );
      ws.simulateMessage(streamFrame('conv-1', 5, 'turn-retry-1', 'stream-completed'));
    });

    // The retried content should appear
    expect(await screen.findByText('Retried successfully!')).toBeInTheDocument();

    // The original failed turn's output should still be present
    expect(screen.getByText('Partial output before crash.')).toBeInTheDocument();

    // Visible retry lineage remains attached to the retried turn
    const lineageBadges = await screen.findAllByTestId('lineage-badge');
    expect(lineageBadges.some((badge) => badge.textContent.includes('retry'))).toBe(true);
    expect(lineageBadges.some((badge) => badge.textContent.includes('@turn-1'))).toBe(true);

    // Verify ordering — failed turn first, then retry turn
    const articles = transcriptArticles();
    expect(articles.length).toBeGreaterThanOrEqual(2);

    // No duplicate: we should not see multiple entries for the same turn
    const retryEntries = articles.filter((a) => within(a).queryByText('Retried successfully!'));
    expect(retryEntries).toHaveLength(1);
  });
});

// ─── 3. Branch completed turn ───────────────────────────────────────────────

describe('branch completed turn', () => {
  it('creates a new conversation, selects it, and shows lineage badge', async () => {
    let branchPosted = false;
    let branchPostCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        // After branch, include the new conversation in the list
        if (branchPosted) {
          return jsonResponse({
            conversations: [
              conversation('conv-1', 'Branch test'),
              conversation('conv-branch', 'Branch of Branch test', {
                parentConversationId: 'conv-1',
                forkPointTurnId: 'turn-1',
              }),
            ],
            totalCount: 2,
          });
        }
        return jsonResponse({
          conversations: [conversation('conv-1', 'Branch test')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse({
          turns: [COMPLETED_TURN],
          totalCount: 1,
          hasMore: false,
        });
      }
      // Branch = POST /conversations with parentConversationId + forkPointTurnId
      if (url === '/conversations' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        if (body['parentConversationId'] === 'conv-1' && body['forkPointTurnId'] === 'turn-1') {
          branchPosted = true;
          branchPostCount += 1;
          return jsonResponse({
            id: 'conv-branch',
            title: 'Branch of Branch test',
            status: 'active',
            createdAt: '2026-07-01T00:02:00.000Z',
            updatedAt: '2026-07-01T00:02:00.000Z',
            turnCount: 0,
            pendingInstructionCount: 0,
            parentConversationId: 'conv-1',
            forkPointTurnId: 'turn-1',
          });
        }
      }
      if (url === '/conversations/conv-branch/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      if (url === '/conversations/conv-branch/approvals') {
        return jsonResponse({ approvals: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    await screen.findByRole('button', { name: /branch test/i });
    openAndSubscribe('conv-1');

    // Wait for the completed turn to render
    expect(await screen.findByText('Here is the analysis.')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();

    // The Branch button should be visible on the completed turn
    const branchBtn = await screen.findByTestId('turn-action-branch');
    expect(branchBtn).toBeInTheDocument();

    // Click branch
    fireEvent.click(branchBtn);
    fireEvent.click(branchBtn);

    // Wait for the branch POST and conversation selection
    await vi.waitFor(() => {
      expect(branchPosted).toBe(true);
    });
    expect(branchPostCount).toBe(1);

    // The new branch conversation should be selected (title in active indicator)
    await vi.waitFor(() => {
      expect(screen.getByText('Active conversation: Branch of Branch test')).toBeInTheDocument();
    });

    // The lineage badge should be visible for the branched conversation
    const badge = await screen.findByTestId('lineage-badge');
    expect(badge).toBeInTheDocument();
    expect(within(badge).getByText('branch')).toBeInTheDocument();
  });
});

// ─── 4. Follow-up action ────────────────────────────────────────────────────

describe('follow-up action', () => {
  it('routes operator back to composer with follow-up context label', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Follow-up test', { turnCount: 1 })],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse({
          turns: [COMPLETED_TURN],
          totalCount: 1,
          hasMore: false,
        });
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    await screen.findByRole('button', { name: /follow-up test/i });
    openAndSubscribe('conv-1');

    // Wait for the completed turn to render
    expect(await screen.findByText('Here is the analysis.')).toBeInTheDocument();

    // The Follow up button should be visible on the last completed turn
    const followUpBtn = await screen.findByTestId('turn-action-follow-up');
    expect(followUpBtn).toBeInTheDocument();

    // Click follow-up
    fireEvent.click(followUpBtn);

    // The composer should show the follow-up context label
    await vi.waitFor(() => {
      expect(screen.getByText(/Follow-up to turn turn-1/)).toBeInTheDocument();
    });

    // The composer textarea should be present and focusable
    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    expect(textarea).toBeInTheDocument();

    // Verify the operator can type and the send button is available
    fireEvent.change(textarea, { target: { value: 'Can you expand on point 2?' } });
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect(sendBtn).toBeInTheDocument();
    expect(sendBtn).not.toBeDisabled();
  });

  it('does not invent unsupported request fields when submitting follow-up', async () => {
    let submitBody: Record<string, unknown> | null = null;
    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount += 1;
        return jsonResponse({
          conversations: [conversation('conv-1', 'Follow-up submit test', { turnCount: 1 })],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse({
          turns: [COMPLETED_TURN],
          totalCount: 1,
          hasMore: false,
        });
      }
      if (url === '/conversations/conv-1/turns' && init?.method === 'POST') {
        submitBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse({
          turn: {
            id: 'turn-followup-1',
            conversationId: 'conv-1',
            position: 2,
            kind: 'operator',
            attribution: { type: 'operator', label: 'Operator' },
            instruction: 'Expand on point 2',
            status: 'submitted',
            createdAt: '2026-07-01T00:03:00.000Z',
          },
          streamId: 'stream-followup-1',
        });
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    await screen.findByRole('button', { name: /follow-up submit test/i });
    openAndSubscribe('conv-1');

    expect(await screen.findByText('Here is the analysis.')).toBeInTheDocument();

    // Click follow-up to set context
    const followUpBtn = await screen.findByTestId('turn-action-follow-up');
    fireEvent.click(followUpBtn);

    await vi.waitFor(() => {
      expect(screen.getByText(/Follow-up to turn turn-1/)).toBeInTheDocument();
    });

    // Type and submit
    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    fireEvent.change(textarea, { target: { value: 'Expand on point 2' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Wait for submit POST to fire
    const body = await vi.waitFor(() => {
      if (submitBody == null) {
        throw new Error('Expected follow-up submit body to be captured');
      }
      return submitBody;
    });

    expect(body).toHaveProperty('instruction', 'Expand on point 2');
    expect(Object.keys(body).sort()).toEqual(['instruction']);

    await vi.waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2);
    });

    expect(screen.queryByText(/Follow-up to turn turn-1/)).not.toBeInTheDocument();
    expect(screen.getByText('Ready for operator input')).toBeInTheDocument();
  });
});

// ─── Operations controls remain stable during chat control actions ──────────

describe('operations controls remain stable during chat control actions', () => {
  it('operations panel does not disappear or error while chat cancel is in progress', async () => {
    let cancelPosted = false;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Ops stability test')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        if (cancelPosted) {
          return jsonResponse({
            turns: [{ ...BASE_TURN, status: 'cancelled' }],
            totalCount: 1,
            hasMore: false,
          });
        }
        return jsonResponse({
          turns: [BASE_TURN],
          totalCount: 1,
          hasMore: false,
        });
      }
      if (url === '/conversations/conv-1/turns/turn-1/cancel' && init?.method === 'POST') {
        cancelPosted = true;
        return jsonResponse({
          success: true,
          turn: { ...BASE_TURN, status: 'cancelled' },
        });
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      // Operations snapshot — always succeeds
      if (url === '/operations/snapshot') {
        return jsonResponse({
          queue: [
            {
              id: 'wi-1',
              title: 'Background task',
              status: 'active',
              position: 0,
              relatedConversationId: null,
              relatedSessionId: null,
              ownerLabel: null,
              lastCheckpointSummary: null,
              updatedAt: '2026-07-01T12:00:00.000Z',
              riskSignals: [],
              detailAvailability: 'ready',
            },
          ],
          health: null,
          budget: null,
          availability: 'ready',
          lastSynchronizedAt: '2026-07-01T12:00:00.000Z',
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /ops stability test/i });
    openAndSubscribe('conv-1');

    // Wait for the executing turn to appear
    expect(await screen.findByText('executing')).toBeInTheDocument();

    // Operations panel heading should be visible before cancel
    await vi.waitFor(() => {
      expect(screen.getByText('Operations')).toBeInTheDocument();
    });

    // Click cancel on the chat turn
    const cancelBtn = await screen.findByTestId('turn-action-cancel');
    fireEvent.click(cancelBtn);

    // Wait for cancel to complete
    await vi.waitFor(() => {
      expect(screen.getByText('cancelled')).toBeInTheDocument();
    });

    // After cancel completes, the operations panel must still be visible — not gone or in error
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });
});
