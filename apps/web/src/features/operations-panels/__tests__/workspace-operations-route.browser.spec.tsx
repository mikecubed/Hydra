import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { GetOperationsSnapshotResponse } from '@hydra/web-contracts';

import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  resetFakeWebSockets,
} from '../../chat-workspace/__tests__/browser-helpers.ts';

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
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

describe('workspace operations panel hydration', () => {
  it('shows loading state on first paint before snapshot resolves', async () => {
    let resolveSnapshot!: (r: Response) => void;
    const snapshotPromise = new Promise<Response>((r) => {
      resolveSnapshot = r;
    });

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(jsonResponse({ conversations: [], totalCount: 0 }));
      }
      if (url === '/operations/snapshot') {
        return snapshotPromise;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    // Before the snapshot resolves, the route should already be in loading state
    // (router mounts asynchronously, so wait for the shell to appear)
    await waitFor(() => {
      expect(screen.getByText('Refreshing\u2026')).toBeInTheDocument();
    });
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/loading/i);

    // Now resolve the snapshot
    const snapshot: GetOperationsSnapshotResponse = {
      queue: [],
      health: null,
      budget: null,
      availability: 'empty',
      lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
      nextCursor: null,
    };
    resolveSnapshot(jsonResponse(snapshot));

    // After resolution, loading indicator should disappear
    expect(await screen.findByText('live')).toBeInTheDocument();
  });

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
        scope: 'global',
        observedAt: '2026-07-01T00:00:00.000Z',
        message: 'Daemon healthy',
        detailsAvailability: 'ready',
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
