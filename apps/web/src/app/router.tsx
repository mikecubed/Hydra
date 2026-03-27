import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  type Router,
} from '@tanstack/react-router';
import { AppShell } from './app-shell.tsx';
import { WorkspaceIndexRoute } from '../routes/index.tsx';
import { WorkspaceRoute } from '../routes/workspace.tsx';
import { LoginRoute } from '../routes/login.tsx';
import { TERMINAL_STATES } from '@hydra/web-contracts';
import { getSessionInfo } from '../features/auth/api/auth-client.ts';

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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: LoginRoute,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workspace',
  component: WorkspaceRoute,
  beforeLoad: async ({ location }) => {
    const session = await getSessionInfo();
    if (session === null || TERMINAL_STATES.includes(session.state)) {
      const redirectTo = `${location.pathname}${location.searchStr}${location.hash}`;
      throw redirect({ to: '/login', search: { redirectTo } as Record<string, string> }); // eslint-disable-line @typescript-eslint/only-throw-error -- TanStack Router's redirect() is thrown by design
    }
  },
});

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, workspaceRoute]);

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
