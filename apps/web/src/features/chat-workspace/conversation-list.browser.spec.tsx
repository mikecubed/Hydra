import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ListConversationsResponse } from '@hydra/web-contracts';
import { AppProviders } from '../../app/providers.tsx';

const fetchSpy = vi.fn<typeof fetch>();

const emptyHistoryResponse = {
  turns: [],
  totalCount: 0,
  hasMore: false,
};

afterEach(() => {
  fetchSpy.mockReset();
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
  fetchSpy.mockImplementation((input, init) => Promise.resolve(handler(requestUrl(input), init)));
  vi.stubGlobal('fetch', fetchSpy);
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

    expect((await screen.findByRole('alert')).textContent).toContain('Service Unavailable');

    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Create a conversation anyway' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByRole('button', { name: /fresh conversation/i })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Active conversation: Fresh conversation')).toBeTruthy();
  });

  it('keeps create mode disabled until the initial conversation load completes', async () => {
    let resolveList: ((value: Response) => void) | undefined;
    const listResponse: ListConversationsResponse = {
      conversations: [],
      totalCount: 0,
    };

    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    const textbox = await screen.findByRole('textbox', { name: /instruction/i });
    const sendButton = screen.getByRole('button', { name: /send/i });

    fireEvent.change(textbox, { target: { value: 'Create the first conversation' } });
    expect(sendButton.getAttribute('disabled')).not.toBeNull();
    expect(screen.getAllByText('Loading conversations…')).toHaveLength(2);

    resolveList?.(jsonResponse(listResponse));

    expect(await screen.findByText('Ready for operator input')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Create the first conversation' },
    });
    expect(screen.getByRole('button', { name: /send/i }).getAttribute('disabled')).toBeNull();
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
});
