/**
 * Browser workflow spec — artifact persistence across refresh and conversation reopen.
 *
 * T042 / US6 coverage: verifies the independent user story test:
 *   1. Open artifacts from a historical turn via listArtifactsForTurn hydration
 *      and getArtifactContent fetch on selection.
 *   2. Full page refresh — reopen the conversation and confirm artifacts remain
 *      accessible from the same turn context.
 *   3. Switch away and reopen — confirm artifacts are still accessible.
 *
 * REST turn history does NOT inline artifacts; this spec relies on
 * listArtifactsForTurn hydration and getArtifactContent fetch on badge click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  jsonResponse,
  conversation,
  openAndSubscribe,
  transcriptArticles,
} from './browser-helpers.ts';

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  resetFakeWebSockets();
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function completedTurn(
  id: string,
  conversationId: string,
  position: number,
  response: string,
): Record<string, unknown> {
  return {
    id,
    conversationId,
    position,
    kind: 'agent',
    attribution: { type: 'agent', label: 'Claude' },
    response,
    status: 'completed',
    createdAt: `2026-07-01T00:00:0${position}.000Z`,
    completedAt: `2026-07-01T00:00:0${position + 1}.000Z`,
  };
}

const ARTIFACT_META = {
  id: 'art-main',
  turnId: 'turn-1',
  kind: 'file',
  label: 'main.ts',
  size: 42,
  createdAt: '2026-07-01T00:00:10.000Z',
};

const ARTIFACT_CONTENT_RESPONSE = {
  artifact: { ...ARTIFACT_META },
  content: 'console.log("hello world");',
};

const TURN_1_ARTIFACTS_RESPONSE = {
  artifacts: [ARTIFACT_META],
};

const TURN_2_ARTIFACTS_RESPONSE = {
  artifacts: [] as unknown[],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Install a fetch stub that serves the standard single-conversation scenario
 * with two completed turns. Turn 1 has one artifact; turn 2 has none.
 */
function installArtifactScenario(): void {
  fetchSpy.mockImplementation((input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url === '/conversations?status=active&limit=20') {
      return Promise.resolve(
        jsonResponse({
          conversations: [conversation('conv-1', 'Artifact story')],
          totalCount: 1,
        }),
      );
    }
    if (url === '/conversations/conv-1/turns?limit=50') {
      return Promise.resolve(
        jsonResponse({
          turns: [
            completedTurn('turn-1', 'conv-1', 1, 'First turn output'),
            completedTurn('turn-2', 'conv-1', 2, 'Second turn output'),
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
      return Promise.resolve(jsonResponse(TURN_1_ARTIFACTS_RESPONSE));
    }
    if (url === '/turns/turn-2/artifacts') {
      return Promise.resolve(jsonResponse(TURN_2_ARTIFACTS_RESPONSE));
    }
    if (url === '/artifacts/art-main') {
      return Promise.resolve(jsonResponse(ARTIFACT_CONTENT_RESPONSE));
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchSpy);
}

/**
 * Install a two-conversation fetch stub. conv-1 has artifacts, conv-2 does not.
 */
function installTwoConversationScenario(): void {
  fetchSpy.mockImplementation((input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url === '/conversations?status=active&limit=20') {
      return Promise.resolve(
        jsonResponse({
          conversations: [
            conversation('conv-1', 'Artifact story'),
            conversation('conv-2', 'Other work'),
          ],
          totalCount: 2,
        }),
      );
    }
    if (url === '/conversations/conv-1/turns?limit=50') {
      return Promise.resolve(
        jsonResponse({
          turns: [completedTurn('turn-1', 'conv-1', 1, 'First turn output')],
          totalCount: 1,
          hasMore: false,
        }),
      );
    }
    if (url === '/conversations/conv-2/turns?limit=50') {
      return Promise.resolve(
        jsonResponse({
          turns: [completedTurn('turn-x', 'conv-2', 1, 'Other conversation turn')],
          totalCount: 1,
          hasMore: false,
        }),
      );
    }
    if (url === '/conversations/conv-1/approvals') {
      return Promise.resolve(jsonResponse({ approvals: [] }));
    }
    if (url === '/conversations/conv-2/approvals') {
      return Promise.resolve(jsonResponse({ approvals: [] }));
    }
    if (url === '/turns/turn-1/artifacts') {
      return Promise.resolve(jsonResponse(TURN_1_ARTIFACTS_RESPONSE));
    }
    if (url === '/turns/turn-x/artifacts') {
      return Promise.resolve(jsonResponse({ artifacts: [] }));
    }
    if (url === '/artifacts/art-main') {
      return Promise.resolve(jsonResponse(ARTIFACT_CONTENT_RESPONSE));
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchSpy);
}

/**
 * Wait for artifact badge to appear in the first transcript article,
 * click it, and wait for the artifact panel to show with content.
 */
async function openArtifactFromTurn(): Promise<void> {
  // Wait for artifact hydration — badge appears on turn-1
  const badge = await screen.findByTestId('artifact-badge');
  expect(badge).toHaveTextContent('main.ts');

  // Click the badge to trigger getArtifactContent fetch
  fireEvent.click(badge);

  // Artifact panel appears with fetched content
  await screen.findByTestId('artifact-panel');
  await screen.findByTestId('artifact-preview');
  expect(screen.getByText('console.log("hello world");')).toBeInTheDocument();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('workspace artifact persistence workflows', () => {
  it('hydrates artifacts from listArtifactsForTurn and opens content via getArtifactContent', async () => {
    installArtifactScenario();
    render(<AppProviders />);

    // Select conversation
    await screen.findByRole('button', { name: /artifact story/i });

    // Open WS so the workspace is fully initialized
    openAndSubscribe('conv-1', 0);

    // REST history loads two completed turns (neither inlines artifacts)
    await screen.findByText('First turn output');
    await screen.findByText('Second turn output');

    // Artifact hydration: badge appears on turn-1 (via listArtifactsForTurn)
    const badge = await screen.findByTestId('artifact-badge');
    expect(badge).toHaveTextContent('main.ts');

    // Click badge → getArtifactContent fetch → panel opens
    fireEvent.click(badge);
    await screen.findByTestId('artifact-panel');
    expect(screen.getByText('console.log("hello world");')).toBeInTheDocument();

    // Verify the correct API calls were made
    const fetchCalls = fetchSpy.mock.calls.map((c) => {
      const input = c[0] as string | URL | Request;
      return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    });
    expect(fetchCalls).toContain('/turns/turn-1/artifacts');
    expect(fetchCalls).toContain('/turns/turn-2/artifacts');
    expect(fetchCalls).toContain('/artifacts/art-main');
  });

  // eslint-disable-next-line max-lines-per-function -- multi-phase workflow test
  it('artifacts remain accessible after full page refresh', async () => {
    installArtifactScenario();

    // Phase 1: initial render — open artifact
    render(<AppProviders />);
    await screen.findByRole('button', { name: /artifact story/i });
    openAndSubscribe('conv-1', 0);
    await screen.findByText('First turn output');
    await openArtifactFromTurn();

    // Verify panel is visible with content
    expect(screen.getByTestId('artifact-panel')).toBeInTheDocument();
    expect(screen.getByText('console.log("hello world");')).toBeInTheDocument();

    // Phase 2: simulate full page refresh — unmount everything and re-render
    cleanup();
    resetFakeWebSockets();
    fetchSpy.mockReset();

    // Re-install the same scenario (fresh server state, same data)
    installArtifactScenario();
    render(<AppProviders />);

    // Conversation reloads
    await screen.findByRole('button', { name: /artifact story/i });
    openAndSubscribe('conv-1', 0);

    // REST history rehydrates turns
    await screen.findByText('First turn output');
    await screen.findByText('Second turn output');

    // Artifact hydration runs again — badge reappears on turn-1
    const badge = await screen.findByTestId('artifact-badge');
    expect(badge).toHaveTextContent('main.ts');

    // Click badge → content loads from getArtifactContent (fresh fetch)
    fireEvent.click(badge);
    await screen.findByTestId('artifact-panel');
    expect(screen.getByText('console.log("hello world");')).toBeInTheDocument();

    // Turn context preserved — articles correspond to original turns
    const articles = transcriptArticles();
    expect(articles.length).toBeGreaterThanOrEqual(1);
    expect(within(articles[0]!).getByText('First turn output')).toBeInTheDocument();
  });

  // eslint-disable-next-line max-lines-per-function -- multi-phase workflow test
  it('artifacts remain accessible after switching away and reopening conversation', async () => {
    installTwoConversationScenario();

    render(<AppProviders />);

    // Phase 1: open conv-1 and interact with its artifact
    await screen.findByRole('button', { name: /artifact story/i });
    const ws = openAndSubscribe('conv-1', 0);

    await screen.findByText('First turn output');
    await openArtifactFromTurn();

    // Panel is visible
    expect(screen.getByTestId('artifact-panel')).toBeInTheDocument();

    // Phase 2: switch to conv-2
    fireEvent.click(screen.getByRole('button', { name: /other work/i }));
    await vi.waitFor(() => {
      expect(screen.getByText('Active conversation: Other work')).toBeInTheDocument();
    });

    // Artifact panel should be cleared on conversation switch
    expect(screen.queryByTestId('artifact-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('First turn output')).not.toBeInTheDocument();

    // Accept the subscribe for conv-2
    const sub2 = ws.sentMessages.filter(
      (m) => m['type'] === 'subscribe' && m['conversationId'] === 'conv-2',
    );
    expect(sub2).toHaveLength(1);
    act(() => {
      ws.simulateMessage({ type: 'subscribed', conversationId: 'conv-2', currentSeq: 0 });
    });

    await screen.findByText('Other conversation turn');

    // Phase 3: switch back to conv-1
    fireEvent.click(screen.getByRole('button', { name: /artifact story/i }));
    await vi.waitFor(() => {
      expect(screen.getByText('Active conversation: Artifact story')).toBeInTheDocument();
    });

    // Turn history is still present (cached from first load)
    await screen.findByText('First turn output');

    // Artifact badge remains accessible from the same turn context
    const badge = await screen.findByTestId('artifact-badge');
    expect(badge).toHaveTextContent('main.ts');

    // Click badge again → content loads via getArtifactContent
    fireEvent.click(badge);
    await screen.findByTestId('artifact-panel');
    expect(screen.getByText('console.log("hello world");')).toBeInTheDocument();
  });

  it('artifact panel shows loading state before content arrives', async () => {
    let resolveContent: ((r: Response) => void) | null = null;

    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [conversation('conv-1', 'Loading test')],
            totalCount: 1,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [completedTurn('turn-1', 'conv-1', 1, 'Turn with slow artifact')],
            totalCount: 1,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-1/approvals') {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/turns/turn-1/artifacts') {
        return Promise.resolve(jsonResponse(TURN_1_ARTIFACTS_RESPONSE));
      }
      if (url === '/artifacts/art-main') {
        return new Promise<Response>((resolve) => {
          resolveContent = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /loading test/i });
    openAndSubscribe('conv-1', 0);

    await screen.findByText('Turn with slow artifact');

    // Click artifact badge
    const badge = await screen.findByTestId('artifact-badge');
    fireEvent.click(badge);

    // Panel appears in loading state
    await screen.findByTestId('artifact-panel');
    expect(screen.getByTestId('artifact-loading')).toBeInTheDocument();

    // Resolve the content fetch
    expect(resolveContent).not.toBeNull();
    act(() => {
      resolveContent!(jsonResponse(ARTIFACT_CONTENT_RESPONSE));
    });

    // Loading state replaced by content
    await screen.findByTestId('artifact-preview');
    expect(screen.getByText('console.log("hello world");')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-loading')).not.toBeInTheDocument();
  });
});
