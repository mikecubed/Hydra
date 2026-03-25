import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  resetFakeWebSockets,
} from '../../chat-workspace/__tests__/browser-helpers.ts';

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  resetFakeWebSockets();
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

describe('workspace operations panel hydration', () => {
  it('loads the operations snapshot and renders queue items from the gateway', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({ conversations: [], totalCount: 0 });
      }

      if (url === '/operations/snapshot') {
        return jsonResponse({
          queue: [
            {
              id: 'wi-42',
              title: 'Investigate queue hydration',
              status: 'active',
              position: 0,
              relatedConversationId: null,
              relatedSessionId: null,
              ownerLabel: 'codex',
              lastCheckpointSummary: 'Snapshot loaded',
              updatedAt: '2026-07-01T00:00:00.000Z',
              riskSignals: [],
              detailAvailability: 'ready',
            },
          ],
          page: {
            limit: 50,
            nextCursor: null,
            totalApproximate: 1,
          },
          sync: {
            lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
            source: 'daemon',
            transportStatus: 'live',
          },
        });
      }

      if (url.endsWith('/turns?limit=50')) {
        return jsonResponse(EMPTY_HISTORY);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Investigate queue hydration')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/operations/snapshot', expect.any(Object));
  });
});
