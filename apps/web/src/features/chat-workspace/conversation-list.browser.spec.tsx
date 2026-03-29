import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ListConversationsResponse } from '@hydra/web-contracts';
import { AppProviders } from '../../app/providers.tsx';
import {
  FakeWebSocket,
  latestSocket,
  openAndSubscribe,
  resetFakeWebSockets,
} from './__tests__/browser-helpers.ts';

const fetchSpy = vi.fn<typeof fetch>();

const emptyHistoryResponse = {
  turns: [],
  totalCount: 0,
  hasMore: false,
};

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  fetchSpy.mockReset();
  resetFakeWebSockets();
  vi.unstubAllGlobals();
  cleanup();
});

function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function installFetchStub(handler: (url: string, init: RequestInit | undefined) => Response): void {
  fetchSpy.mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url === '/session/info') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            operatorId: 'test-operator',
            state: 'active',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            lastActivityAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    try {
      return Promise.resolve(handler(url, init));
    } catch (err: unknown) {
      if (/^\/conversations\/[^/]+\/approvals$/.test(url)) {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/operations/snapshot') {
        return Promise.resolve(
          jsonResponse({
            queue: [],
            health: null,
            budget: null,
            availability: 'empty',
            lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
            nextCursor: null,
          }),
        );
      }
      if (url === '/config/safe') {
        return Promise.resolve(
          jsonResponse({
            config: {
              routing: { mode: 'balanced' },
              models: {},
              usage: { dailyTokenBudget: {}, weeklyTokenBudget: {} },
            },
            revision: 'rev-conversation-list',
          }),
        );
      }
      if (url === '/audit' || url === '/audit?limit=20') {
        return Promise.resolve(jsonResponse({ records: [], nextCursor: null, totalCount: 0 }));
      }
      throw err;
    }
  });
  vi.stubGlobal('fetch', fetchSpy);
}

function openWorkspaceSocket(): void {
  act(() => {
    latestSocket().simulateOpen();
  });
}

// eslint-disable-next-line max-lines-per-function
describe('workspace conversation browsing', () => {
  it('clears the initial list error after a successful create flow', async () => {
    const createResponse = {
      id: 'conv-new',
      title: 'Fresh conversation',
      status: 'active',
      createdAt: '2026-03-21T00:00:00.000Z',
      updatedAt: '2026-03-21T00:00:00.000Z',
      turnCount: 0,
      pendingInstructionCount: 0,
    };
    const submitResponse = {
      turn: {
        id: 'turn-1',
        conversationId: 'conv-new',
        position: 1,
        kind: 'operator',
        attribution: { type: 'operator', label: 'Operator' },
        instruction: 'Create a conversation anyway',
        status: 'submitted',
        createdAt: '2026-03-21T00:00:01.000Z',
      },
      streamId: 'stream-1',
    };

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({ message: 'Gateway down' }, 503, 'Service Unavailable');
      }

      if (url === '/conversations' && init?.method === 'POST') {
        return jsonResponse(createResponse);
      }

      if (url === '/conversations/conv-new/turns' && init?.method === 'POST') {
        return jsonResponse(submitResponse);
      }

      if (url === '/conversations/conv-new/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText(/service unavailable/i)).toBeInTheDocument();
    openWorkspaceSocket();

    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Create a conversation anyway' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByRole('button', { name: /fresh conversation/i })).toBeTruthy();
    expect(screen.queryByText(/service unavailable/i)).toBeNull();
    expect(screen.getByText('Active conversation: Fresh conversation')).toBeTruthy();
  });

  it('keeps create mode disabled until the initial conversation load completes', async () => {
    let resolveList: ((value: Response) => void) | undefined;
    const listResponse: ListConversationsResponse = {
      conversations: [],
      totalCount: 0,
    };

    fetchSpy.mockImplementation((input) => {
      if (requestUrl(input) === '/session/info') {
        return Promise.resolve(
          jsonResponse({
            operatorId: 'test-operator',
            state: 'active',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            lastActivityAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          }),
        );
      }
      return new Promise<Response>((resolve) => {
        resolveList = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    const textbox = await screen.findByRole('textbox', { name: /instruction/i });
    const sendButton = screen.getByRole('button', { name: /send/i });

    expect(textbox.getAttribute('disabled')).not.toBeNull();
    fireEvent.change(textbox, { target: { value: 'Create the first conversation' } });
    expect(sendButton.getAttribute('disabled')).not.toBeNull();
    expect(screen.getAllByText('Loading conversations…')).toHaveLength(2);

    resolveList?.(jsonResponse(listResponse));
    await vi.waitFor(() => {
      expect(() => latestSocket()).not.toThrow();
    });
    openWorkspaceSocket();

    expect(await screen.findByText('Ready for operator input')).toBeTruthy();
    const enabledTextbox = screen.getByRole('textbox', { name: /instruction/i });
    expect(enabledTextbox.getAttribute('disabled')).toBeNull();
    fireEvent.change(enabledTextbox, {
      target: { value: 'Create the first conversation' },
    });
    expect(screen.getByRole('button', { name: /send/i }).getAttribute('disabled')).toBeNull();
  });

  it('enters create mode when the New conversation button is clicked', async () => {
    const response: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Existing conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 2,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse(response);
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    const existingButton = await screen.findByRole('button', { name: /existing conversation/i });
    expect(existingButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }));

    expect(existingButton.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Active conversation: No conversation selected')).toBeTruthy();
  });

  it('loads conversations, auto-selects the first one, and switches visible context', async () => {
    const response: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 3,
          pendingInstructionCount: 1,
        },
        {
          id: 'conv-2',
          title: 'Release follow-up',
          status: 'active',
          createdAt: '2026-03-19T00:00:00.000Z',
          updatedAt: '2026-03-20T13:00:00.000Z',
          turnCount: 8,
          pendingInstructionCount: 0,
          parentConversationId: 'conv-1',
          forkPointTurnId: 'turn-2',
        },
      ],
      totalCount: 2,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse(response);
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      if (url === '/conversations/conv-2/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    const primaryButton = await screen.findByRole('button', { name: /primary conversation/i });
    openAndSubscribe('conv-1');
    expect(primaryButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Active conversation: Primary conversation')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /instruction/i })).toBeTruthy();
    expect(screen.getByText('Ready for operator input')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /release follow-up/i }));

    expect(
      screen.getByRole('button', { name: /release follow-up/i }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText('Active conversation: Release follow-up')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /instruction/i })).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/conversations?status=active&limit=20',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    );
  });

  // eslint-disable-next-line max-lines-per-function
  it('selects created conversation and refreshes list after create-mode submit', async () => {
    const existingList: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-existing',
          title: 'Existing conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };

    const createResponse = {
      id: 'conv-created',
      title: 'Created conversation',
      status: 'active',
      createdAt: '2026-03-21T00:00:00.000Z',
      updatedAt: '2026-03-21T00:00:00.000Z',
      turnCount: 0,
      pendingInstructionCount: 0,
    };

    const submitResponse = {
      turn: {
        id: 'turn-first',
        conversationId: 'conv-created',
        position: 1,
        kind: 'operator',
        attribution: { type: 'operator', label: 'Operator' },
        instruction: 'Hello Hydra',
        status: 'submitted',
        createdAt: '2026-03-21T00:00:01.000Z',
      },
      streamId: 'stream-new',
    };

    let submitCalled = false;
    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount++;
        if (listCallCount <= 1) {
          return jsonResponse(existingList);
        }
        // Post-submit reload includes the newly created conversation
        return jsonResponse({
          conversations: [
            ...existingList.conversations,
            { ...createResponse, turnCount: 1, pendingInstructionCount: 1 },
          ],
          totalCount: 2,
        });
      }

      if (url === '/conversations/conv-existing/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      if (url === '/conversations' && init?.method === 'POST') {
        return jsonResponse(createResponse);
      }

      if (url === '/conversations/conv-created/turns' && init?.method === 'POST') {
        submitCalled = true;
        return jsonResponse(submitResponse);
      }

      if (url === '/conversations/conv-created/turns?limit=50') {
        // Initial load — transcript updates now arrive via WS streaming.
        return jsonResponse(emptyHistoryResponse);
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    // Wait for the existing conversation to load and auto-select
    await screen.findByRole('button', { name: /existing conversation/i });
    openAndSubscribe('conv-existing');

    // Enter create mode
    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }));

    // Type and submit
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Hello Hydra' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // The created conversation should appear and be selected
    expect(await screen.findByRole('button', { name: /created conversation/i })).toBeTruthy();

    // Submit POST was made; transcript content now arrives via WS streaming
    // (not via REST refresh) to prevent in-flight state clobber.
    await vi.waitFor(() => {
      expect(submitCalled).toBe(true);
    });

    // Conversation list should have refreshed
    await vi.waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  it('reloads the conversation list after create so pre-existing conversations appear', async () => {
    const preExisting = {
      id: 'conv-old',
      title: 'Pre-existing conversation',
      status: 'active',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T12:00:00.000Z',
      turnCount: 5,
      pendingInstructionCount: 0,
    };

    const createResponse = {
      id: 'conv-new',
      title: 'Fresh conversation',
      status: 'active',
      createdAt: '2026-03-21T00:00:00.000Z',
      updatedAt: '2026-03-21T00:00:00.000Z',
      turnCount: 0,
      pendingInstructionCount: 0,
    };

    const submitResponse = {
      turn: {
        id: 'turn-1',
        conversationId: 'conv-new',
        position: 1,
        kind: 'operator',
        attribution: { type: 'operator', label: 'Operator' },
        instruction: 'Start fresh',
        status: 'submitted',
        createdAt: '2026-03-21T00:00:01.000Z',
      },
      streamId: 'stream-1',
    };

    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount++;
        if (listCallCount <= 1) {
          // Initial load fails
          return jsonResponse({ message: 'Gateway down' }, 503, 'Service Unavailable');
        }
        // Reload after create succeeds, includes pre-existing + newly created
        return jsonResponse({
          conversations: [createResponse, preExisting],
          totalCount: 2,
        });
      }

      if (url === '/conversations' && init?.method === 'POST') {
        return jsonResponse(createResponse);
      }

      if (url === '/conversations/conv-new/turns' && init?.method === 'POST') {
        return jsonResponse(submitResponse);
      }

      if (url === '/conversations/conv-new/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      if (url === '/conversations/conv-old/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    // Initial list load fails
    expect((await screen.findByRole('alert')).textContent).toContain('Service Unavailable');
    openWorkspaceSocket();

    // Create a conversation despite the failed list load
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Start fresh' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // After create, the reload returns both conversations
    expect(await screen.findByRole('button', { name: /pre-existing conversation/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /fresh conversation/i })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listCallCount).toBeGreaterThanOrEqual(2);
  });

  it('refreshes sidebar metadata after a continue-mode submit', async () => {
    const initialList: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Active conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };

    const submitResponse = {
      turn: {
        id: 'turn-2',
        conversationId: 'conv-1',
        position: 2,
        kind: 'operator',
        attribution: { type: 'operator', label: 'Operator' },
        instruction: 'Follow-up message',
        status: 'submitted',
        createdAt: '2026-03-20T13:00:00.000Z',
      },
      streamId: 'stream-2',
    };

    const refreshedList: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Active conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T13:00:00.000Z',
          turnCount: 2,
          pendingInstructionCount: 1,
        },
      ],
      totalCount: 1,
    };

    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount++;
        if (listCallCount <= 1) {
          return jsonResponse(initialList);
        }
        return jsonResponse(refreshedList);
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(emptyHistoryResponse);
      }

      if (url === '/conversations/conv-1/turns' && init?.method === 'POST') {
        return jsonResponse(submitResponse);
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    // Wait for list to load with initial turnCount of 1
    await screen.findByRole('button', { name: /active conversation/i });
    expect(screen.getByText('1 turns · 0 pending')).toBeTruthy();
    openAndSubscribe('conv-1');

    // Submit a follow-up instruction
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Follow-up message' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Sidebar metadata should refresh to show updated counts
    expect(await screen.findByText('2 turns · 1 pending')).toBeTruthy();
    expect(listCallCount).toBeGreaterThanOrEqual(2);
  });
});
