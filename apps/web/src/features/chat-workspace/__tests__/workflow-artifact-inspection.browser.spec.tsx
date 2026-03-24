/**
 * Browser workflow spec — artifact hydration and inspection regressions.
 *
 * Covers:
 *   – historical artifact hydration does not duplicate in-flight turn fetches across rerenders
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  jsonResponse,
  conversation,
} from './browser-helpers.ts';

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  resetFakeWebSockets();
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

// eslint-disable-next-line max-lines-per-function -- compact single-scenario regression file
describe('workspace artifact hydration workflows', () => {
  // eslint-disable-next-line max-lines-per-function -- multi-step route hydration regression
  it('does not duplicate in-flight artifact hydration requests across rerenders', async () => {
    const listCounts = new Map<string, number>();
    let resolveSecondTurnArtifacts = (_response: Response): void => {
      throw new Error('Expected turn-2 artifact hydration request to be pending');
    };

    fetchSpy.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [conversation('conv-1', 'Artifact hydration')],
            totalCount: 1,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [
              {
                id: 'turn-1',
                conversationId: 'conv-1',
                position: 1,
                kind: 'agent',
                attribution: { type: 'agent', label: 'Claude' },
                response: 'First turn',
                status: 'completed',
                createdAt: '2026-07-01T00:00:01.000Z',
                completedAt: '2026-07-01T00:00:02.000Z',
              },
              {
                id: 'turn-2',
                conversationId: 'conv-1',
                position: 2,
                kind: 'agent',
                attribution: { type: 'agent', label: 'Claude' },
                response: 'Second turn',
                status: 'completed',
                createdAt: '2026-07-01T00:00:03.000Z',
                completedAt: '2026-07-01T00:00:04.000Z',
              },
            ],
            totalCount: 2,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-1/approvals') {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/turns/turn-1/artifacts') {
        listCounts.set('turn-1', (listCounts.get('turn-1') ?? 0) + 1);
        return Promise.resolve(
          jsonResponse({
            artifacts: [
              {
                id: 'art-1',
                turnId: 'turn-1',
                kind: 'file',
                label: 'first.txt',
                size: 5,
                createdAt: '2026-07-01T00:00:05.000Z',
              },
            ],
          }),
        );
      }
      if (url === '/turns/turn-2/artifacts') {
        listCounts.set('turn-2', (listCounts.get('turn-2') ?? 0) + 1);
        return new Promise<Response>((resolve) => {
          resolveSecondTurnArtifacts = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    await screen.findByRole('button', { name: /artifact hydration/i });
    await screen.findByText('first.txt');

    await vi.waitFor(() => {
      expect(listCounts.get('turn-1')).toBe(1);
      expect(listCounts.get('turn-2')).toBe(1);
    });

    const resolveArtifacts = resolveSecondTurnArtifacts;
    resolveArtifacts(
      jsonResponse({
        artifacts: [
          {
            id: 'art-2',
            turnId: 'turn-2',
            kind: 'file',
            label: 'second.txt',
            size: 6,
            createdAt: '2026-07-01T00:00:06.000Z',
          },
        ],
      }),
    );

    await screen.findByText('second.txt');
    expect(listCounts.get('turn-2')).toBe(1);
  });
});
