import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type Router,
} from '@tanstack/react-router';
import { AppShell } from './app-shell.tsx';
import { WorkspaceIndexRoute } from '../routes/index.tsx';
import { WorkspaceRoute } from '../routes/workspace.tsx';

export interface AppRouterContext {
  readonly queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<AppRouterContext>()({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceIndexRoute,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workspace',
  component: WorkspaceRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute]);

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
