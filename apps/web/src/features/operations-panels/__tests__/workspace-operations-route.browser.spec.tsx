import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  GetOperationsSnapshotResponse,
  GetWorkItemDetailResponse,
  GetSafeConfigResponse,
  GetAuditResponse,
} from '@hydra/web-contracts';

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

function makeHydrationItem() {
  return {
    id: 'wi-42',
    title: 'Investigate queue hydration',
    status: 'active' as const,
    position: 0,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: 'codex',
    lastCheckpointSummary: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    riskSignals: [],
    detailAvailability: 'ready' as const,
  };
}

function installBaseOperationsStub(snapshot: GetOperationsSnapshotResponse): void {
  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({ conversations: [], totalCount: 0 });
    }

    if (url === '/operations/snapshot') {
      return jsonResponse(snapshot);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function installWorkspaceWithMutationsStub(
  snapshot: GetOperationsSnapshotResponse,
  config: GetSafeConfigResponse,
  audit: GetAuditResponse,
): void {
  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({ conversations: [], totalCount: 0 });
    }

    if (url === '/operations/snapshot') {
      return jsonResponse(snapshot);
    }

    if (url === '/config/safe') {
      return jsonResponse(config);
    }

    if (url === '/audit' || url === '/audit?limit=20') {
      return jsonResponse(audit);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
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

it('shows loading state on first paint before snapshot resolves', async () => {
  let resolveSnapshot!: (r: Response) => void;
  const snapshotPromise = new Promise<Response>((r) => {
    resolveSnapshot = r;
  });

  fetchSpy.mockImplementation((input: RequestInfo | URL) => {
    const url = resolveUrl(input);
    if (url === '/session/info') {
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

  await waitFor(() => {
    expect(screen.getByText('Refreshing…')).toBeInTheDocument();
  });
  expect(screen.getByRole('status', { name: 'Operations refresh status' })).toHaveTextContent(
    'Refreshing…',
  );
  expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/loading/i);

  resolveSnapshot(
    jsonResponse({
      queue: [],
      health: null,
      budget: null,
      availability: 'empty',
      lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
      nextCursor: null,
    }),
  );

  expect(await screen.findByText('live')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Operations refresh status' })).toHaveTextContent(
    'live',
  );
});

it('loads the operations snapshot and renders queue items from the gateway', async () => {
  installBaseOperationsStub({
    queue: [makeHydrationItem()],
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
  });

  render(<AppProviders />);

  expect(await screen.findByText('Investigate queue hydration')).toBeInTheDocument();
  expect(await screen.findByText('live')).toBeInTheDocument();
  expect(fetchSpy).toHaveBeenCalledWith('/operations/snapshot', expect.any(Object));
});

it('mounts config and audit mutation panels in the real workspace sidebar', async () => {
  installWorkspaceWithMutationsStub(
    {
      queue: [makeHydrationItem()],
      health: null,
      budget: null,
      availability: 'ready',
      lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
      nextCursor: null,
    },
    {
      config: {
        routing: { mode: 'balanced' },
        models: {
          claude: {
            default: 'claude-sonnet-4.6',
            fast: 'claude-haiku-4.5',
            cheap: 'claude-haiku-4.5',
            active: 'default',
          },
        },
        usage: {
          dailyTokenBudget: { 'claude-sonnet-4.6': 1_000_000 },
          weeklyTokenBudget: { 'claude-sonnet-4.6': 5_000_000 },
        },
      },
      revision: 'rev-sidebar-1',
    },
    {
      records: [
        {
          id: 'audit-1',
          timestamp: '2026-07-01T00:00:00.000Z',
          eventType: 'workflow.launched',
          operatorId: 'operator-7',
          sessionId: 'session-9',
          targetField: 'workflow.tasks',
          beforeValue: null,
          afterValue: 'T001',
          outcome: 'success',
          rejectionReason: null,
          sourceIp: '127.0.0.1',
        },
      ],
      nextCursor: null,
    },
  );

  render(<AppProviders />);

  expect(await screen.findByText('Investigate queue hydration')).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Routing Mode' })).toBeInTheDocument();
  expect(await screen.findByText('Launch Workflow')).toBeInTheDocument();
  expect(await screen.findByRole('table')).toBeInTheDocument();
  expect(screen.getByLabelText('Mutation audit log')).toBeInTheDocument();
});

it('does not refetch detail when clicking the already-selected work item', async () => {
  const item = makeHydrationItem();
  const detail: GetWorkItemDetailResponse = {
    item,
    checkpoints: [
      {
        id: 'cp-1',
        sequence: 0,
        label: 'Checkpoint ready',
        status: 'reached',
        timestamp: '2026-07-01T00:00:05.000Z',
        detail: null,
      },
    ],
    routing: null,
    assignments: [],
    council: null,
    controls: [],
    itemBudget: null,
    availability: 'partial',
  };
  let detailFetches = 0;

  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({ conversations: [], totalCount: 0 });
    }

    if (url === '/operations/snapshot') {
      return jsonResponse({
        queue: [item],
        health: null,
        budget: null,
        availability: 'ready',
        lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
        nextCursor: null,
      });
    }

    if (url === '/operations/work-items/wi-42') {
      detailFetches += 1;
      return jsonResponse(detail);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  render(<AppProviders />);

  const queueItem = await screen.findByText('Investigate queue hydration');
  fireEvent.click(queueItem);
  expect(await screen.findByText('Checkpoint ready')).toBeInTheDocument();
  expect(detailFetches).toBe(1);

  fireEvent.click(queueItem);
  await waitFor(() => {
    expect(detailFetches).toBe(1);
  });
  expect(screen.getByText('Checkpoint ready')).toBeInTheDocument();
});

it('retries detail fetch when clicking the already-selected work item after a failure', async () => {
  const item = makeHydrationItem();
  const detail: GetWorkItemDetailResponse = {
    item,
    checkpoints: [
      {
        id: 'cp-1',
        sequence: 0,
        label: 'Checkpoint ready',
        status: 'reached',
        timestamp: '2026-07-01T00:00:05.000Z',
        detail: null,
      },
    ],
    routing: null,
    assignments: [],
    council: null,
    controls: [],
    itemBudget: null,
    availability: 'partial',
  };
  let detailFetches = 0;

  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({ conversations: [], totalCount: 0 });
    }

    if (url === '/operations/snapshot') {
      return jsonResponse({
        queue: [item],
        health: null,
        budget: null,
        availability: 'ready',
        lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
        nextCursor: null,
      });
    }

    if (url === '/operations/work-items/wi-42') {
      detailFetches += 1;
      if (detailFetches === 1) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'DAEMON_UNREACHABLE',
            category: 'daemon',
            message: 'Daemon unreachable',
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return jsonResponse(detail);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  render(<AppProviders />);

  const queueItem = await screen.findByText('Investigate queue hydration');
  fireEvent.click(queueItem);
  expect(await screen.findByText('Failed to load checkpoint data.')).toBeInTheDocument();
  expect(detailFetches).toBe(1);

  fireEvent.click(queueItem);
  expect(await screen.findByText('Checkpoint ready')).toBeInTheDocument();
  expect(detailFetches).toBe(2);
});
