import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ListConversationsResponse } from '@hydra/web-contracts';
import { AppProviders } from '../../app/providers.tsx';

const fetchSpy = vi.fn<typeof fetch>();

afterEach(() => {
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

describe('workspace conversation browsing', () => {
  it('keeps create mode disabled until the initial conversation load completes', async () => {
    let resolveList: ((value: Response) => void) | undefined;
    const listResponse: ListConversationsResponse = {
      conversations: [],
      totalCount: 0,
    };

    fetchSpy.mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    const textbox = await screen.findByRole('textbox', { name: /instruction/i });
    const sendButton = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;

    fireEvent.change(textbox, { target: { value: 'Create the first conversation' } });
    expect(sendButton.disabled).toBe(true);
    expect(screen.getAllByText('Loading conversations…')).toHaveLength(2);

    resolveList?.(
      new Response(JSON.stringify(listResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await screen.findByText('Ready for operator input')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Create the first conversation' },
    });
    expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
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

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

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
