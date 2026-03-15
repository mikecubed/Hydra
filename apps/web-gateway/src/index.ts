/**
 * @hydra/web-gateway — app factory.
 *
 * Composes auth/session routes with security middleware into a production Hono app.
 * Exported as `createGatewayApp()` so both the production entry point and tests
 * can instantiate a fully-wired stack.
 */
import { Hono } from 'hono';
import type { GatewayEnv } from './shared/types.ts';
import { SessionStore } from './session/session-store.ts';
import { SessionService, type SessionServiceConfig } from './session/session-service.ts';
import { OperatorStore } from './auth/operator-store.ts';
import { RateLimiter } from './auth/rate-limiter.ts';
import { AuthService } from './auth/auth-service.ts';
import { AuditStore } from './audit/audit-store.ts';
import { AuditService } from './audit/audit-service.ts';
import { createAuthRoutes, type AuthRoutesConfig } from './auth/auth-routes.ts';
import { createSessionRoutes } from './session/session-routes.ts';
import { createAuthMiddleware } from './auth/auth-middleware.ts';
import { createOriginGuard } from './security/origin-guard.ts';
import { createCsrfMiddleware } from './security/csrf-middleware.ts';
import { createHardenedHeaders, type HardenedHeadersConfig } from './security/hardened-headers.ts';
import { createMutatingRateLimiter } from './security/mutating-rate-limiter.ts';
import type { Clock } from './shared/clock.ts';
import { SystemClock } from './shared/clock.ts';

export interface GatewayAppDeps {
  clock?: Clock;
  sessionStore?: SessionStore;
  operatorStore?: OperatorStore;
  auditStore?: AuditStore;
  sessionConfig?: Partial<SessionServiceConfig>;
  authRoutesConfig?: AuthRoutesConfig;
  hardenedHeadersConfig?: HardenedHeadersConfig;
  allowedOrigin?: string;
}

export interface GatewayApp {
  app: Hono<GatewayEnv>;
  sessionService: SessionService;
  authService: AuthService;
  auditService: AuditService;
  operatorStore: OperatorStore;
}

export function createGatewayApp(deps: GatewayAppDeps = {}): GatewayApp {
  const clock = deps.clock ?? new SystemClock();
  const sessionStore = deps.sessionStore ?? new SessionStore(null);
  const operatorStore = deps.operatorStore ?? new OperatorStore(null);
  const auditStore = deps.auditStore ?? new AuditStore(null);
  const allowedOrigin = deps.allowedOrigin ?? 'http://127.0.0.1:4174';

  const auditService = new AuditService(auditStore, clock);
  const sessionService = new SessionService(sessionStore, clock, deps.sessionConfig, auditService);
  const rateLimiter = new RateLimiter(clock);
  const authService = new AuthService(operatorStore, rateLimiter, sessionService, auditService);

  const app = new Hono<GatewayEnv>();

  // Global security headers
  app.use('*', createHardenedHeaders(deps.hardenedHeadersConfig));

  // Origin guard on all routes
  app.use('*', createOriginGuard(allowedOrigin));

  // Mutating rate limiter
  app.use('*', createMutatingRateLimiter(clock));

  // Auth routes — login is unauthenticated; logout/reauth need CSRF protection
  const authRoutes = createAuthRoutes(authService, sessionService, deps.authRoutesConfig);
  const authApp = new Hono<GatewayEnv>();
  authApp.use('/logout', createCsrfMiddleware());
  authApp.use('/reauth', createCsrfMiddleware());
  authApp.route('/', authRoutes);
  app.route('/auth', authApp);

  // Session routes (info/extend) — require valid session + CSRF
  const sessionRoutes = createSessionRoutes(sessionService);
  const protectedSession = new Hono<GatewayEnv>();
  protectedSession.use('*', createAuthMiddleware(sessionService, auditService));
  protectedSession.use('*', createCsrfMiddleware());
  protectedSession.route('/', sessionRoutes);
  app.route('/session', protectedSession);

  return { app, sessionService, authService, auditService, operatorStore };
}
