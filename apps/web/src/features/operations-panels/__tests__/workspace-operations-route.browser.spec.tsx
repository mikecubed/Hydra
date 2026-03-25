import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GetOperationsSnapshotResponse } from '@hydra/web-contracts';

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
    const snapshot: GetOperationsSnapshotResponse = {
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
      health: {
        status: 'healthy',
        summary: 'Daemon healthy',
        checkedAt: '2026-07-01T00:00:00.000Z',
      },
      budget: null,
      availability: 'ready',
      lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
      nextCursor: null,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({ conversations: [], totalCount: 0 });
      }

      if (url === '/operations/snapshot') {
        return jsonResponse(snapshot);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Investigate queue hydration')).toBeInTheDocument();
    expect(await screen.findByText('live')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/operations/snapshot', expect.any(Object));
  });
});
