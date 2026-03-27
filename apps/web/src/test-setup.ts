/**
 * Vitest global setup — extends `expect` with DOM-specific matchers
 * (toBeInTheDocument, toHaveTextContent, etc.) from @testing-library/jest-dom.
 *
 * Also mocks useSession so the SessionProvider mounted inside WorkspaceRoute
 * does not create a second WebSocket on /ws, which would otherwise pollute
 * latestSocket() in chat-workspace browser tests. Tests that need a real or
 * customised useSession behaviour override this with their own vi.mock().
 */
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

vi.mock('./features/auth/hooks/use-session.ts', () => ({
  useSession: () => ({
    session: {
      state: 'active',
      operatorId: 'test-operator',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    isLoading: false,
    extend: async () => {},
    logout: async () => {},
    refresh: async () => {},
  }),
}));
