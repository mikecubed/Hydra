import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ListConversationsResponse, LoadTurnHistoryResponse, Turn } from '@hydra/web-contracts';
import { AppProviders } from '../../app/providers.tsx';

const fetchSpy = vi.fn<typeof fetch>();

afterEach(() => {
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const listResponse: ListConversationsResponse = {
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

function makeTurn(overrides: Partial<Turn> & { id: string; conversationId: string }): Turn {
  return {
    position: 1,
    kind: 'operator',
    attribution: { type: 'operator', label: 'Operator' },
    instruction: 'default instruction',
    status: 'completed',
    createdAt: '2026-03-20T12:00:00.000Z',
    ...overrides,
  } as Turn;
}

function makeHistoryResponse(
  turns: Turn[],
  hasMore = false,
): LoadTurnHistoryResponse {
  return { turns, totalCount: turns.length, hasMore };
}

/**
 * Stub fetch with ordered route matching.
 * Routes are checked in array order so more-specific patterns should come first.
 */
function stubFetchRoutes(routes: ReadonlyArray<readonly [pattern: string, body: unknown]>): void {
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{"message":"no matching route"}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchSpy);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('workspace conversation browsing', () => {
  it('loads conversations, auto-selects the first one, and switches visible context', async () => {
    stubFetchRoutes([
      ['/conversations/conv-1/turns', makeHistoryResponse([])],
      ['/conversations/conv-2/turns', makeHistoryResponse([])],
      ['/conversations?', listResponse],
    ]);

    render(<AppProviders />);

    const primaryButton = await screen.findByRole('button', { name: /primary conversation/i });
    expect(primaryButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Active conversation: Primary conversation')).toBeTruthy();
    expect(screen.getByText('Draft belongs to: Primary conversation')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /release follow-up/i }));

    expect(
      screen.getByRole('button', { name: /release follow-up/i }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText('Active conversation: Release follow-up')).toBeTruthy();
    expect(screen.getByText('Draft belongs to: Release follow-up')).toBeTruthy();
  });

  it('loads transcript history for the auto-selected conversation', async () => {
    const conv1History = makeHistoryResponse([
      makeTurn({
        id: 'turn-1',
        conversationId: 'conv-1',
        kind: 'operator',
        instruction: 'Analyse the build',
      }),
      makeTurn({
        id: 'turn-2',
        conversationId: 'conv-1',
        position: 2,
        kind: 'system',
        response: 'Build looks clean.',
        status: 'completed',
      }),
    ]);

    stubFetchRoutes([
      ['/conversations/conv-1/turns', conv1History],
      ['/conversations?', listResponse],
    ]);

    render(<AppProviders />);

    // Wait for conversation list to load and auto-select
    await screen.findByRole('button', { name: /primary conversation/i });

    // Transcript entries should appear from loadHistory
    expect(await screen.findByText('Analyse the build')).toBeTruthy();
    expect(screen.getByText('Build looks clean.')).toBeTruthy();
  });

  it('loads transcript history when switching to a different conversation', async () => {
    const conv1History = makeHistoryResponse([
      makeTurn({ id: 'turn-1', conversationId: 'conv-1', instruction: 'First conv turn' }),
    ]);
    const conv2History = makeHistoryResponse([
      makeTurn({
        id: 'turn-3',
        conversationId: 'conv-2',
        kind: 'system',
        response: 'Second conv response',
      }),
    ]);

    stubFetchRoutes([
      ['/conversations/conv-1/turns', conv1History],
      ['/conversations/conv-2/turns', conv2History],
      ['/conversations?', listResponse],
    ]);

    render(<AppProviders />);

    // Wait for initial load
    await screen.findByText('First conv turn');

    // Switch to second conversation
    fireEvent.click(screen.getByRole('button', { name: /release follow-up/i }));

    // Second conversation's transcript should load
    expect(await screen.findByText('Second conv response')).toBeTruthy();
  });

  it('shows error state when transcript history fails to load', async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes('/turns')) {
        return new Response(JSON.stringify({ message: 'Not found' }), {
          status: 404,
          statusText: 'Not Found',
        });
      }
      return new Response(JSON.stringify(listResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    // Wait for conversation list to load
    await screen.findByRole('button', { name: /primary conversation/i });

    // Transcript should show error state
    expect(await screen.findByText('Failed to load transcript.')).toBeTruthy();
  });
});
