import type { JSX } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type Router,
} from '@tanstack/react-router';
import { AppShell } from './app-shell.tsx';

export interface AppRouterContext {
  readonly queryClient: QueryClient;
}

function WorkspaceBootstrapPlaceholder(): JSX.Element {
  return (
    <section aria-labelledby="workspace-bootstrap-heading">
      <h2 id="workspace-bootstrap-heading" style={{ marginTop: 0, fontSize: '1.5rem' }}>
        Workspace scaffold ready
      </h2>
      <p style={{ lineHeight: 1.6, maxWidth: '48rem' }}>
        The browser shell, router, and provider stack are live. Conversation transcript and composer
        features will attach to this route in the next tasks.
      </p>
    </section>
  );
}

const rootRoute = createRootRouteWithContext<AppRouterContext>()({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceBootstrapPlaceholder,
});

const routeTree = rootRoute.addChildren([indexRoute]);

export type AppRouter = Router<typeof routeTree>;

export function createAppRouter(queryClient: QueryClient): AppRouter {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
