/**
 * @hydra/web-gateway — app factory.
 *
 * Composes auth/session routes with security middleware into a production Hono app.
 * Exported as `createGatewayApp()` so both the production entry point and tests
 * can instantiate a fully-wired stack.
 */
import type { Server } from 'node:http';
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
import {
  createMutatingRateLimiter,
  DEFAULT_MUTATING_LIMITS,
} from './security/mutating-rate-limiter.ts';
import {
  DaemonHeartbeat,
  defaultHealthChecker,
  type HealthChecker,
  type DaemonHeartbeatConfig,
} from './session/daemon-heartbeat.ts';
import type { Clock } from './shared/clock.ts';
import { SystemClock } from './shared/clock.ts';
import { createSourceKeyMiddleware, type SourceKeyConfig } from './security/source-key.ts';
import { validateTlsConfig, isSecure, type TlsConfig } from './security/tls-guard.ts';
import { DaemonClient, type DaemonClientOptions } from './conversation/daemon-client.ts';
import { createConversationRoutes } from './conversation/conversation-routes.ts';
import { SessionStateBroadcaster } from './session/session-state-broadcaster.ts';
import { ConnectionRegistry } from './transport/connection-registry.ts';
import { EventBuffer } from './transport/event-buffer.ts';
import type { StreamEventBridgeLike } from './transport/event-forwarder.ts';
import { GatewayWsServer } from './transport/ws-server.ts';

export interface GatewayAppDeps {
  clock?: Clock;
  sessionStore?: SessionStore;
  operatorStore?: OperatorStore;
  auditStore?: AuditStore;
  sessionConfig?: Partial<SessionServiceConfig>;
  authRoutesConfig?: AuthRoutesConfig;
  hardenedHeadersConfig?: HardenedHeadersConfig;
  allowedOrigin?: string;
  healthChecker?: HealthChecker;
  heartbeatConfig?: Partial<DaemonHeartbeatConfig>;
  sourceKeyConfig?: SourceKeyConfig;
  tlsConfig?: TlsConfig;
  /** Daemon client options for conversation routes (FR-018). */
  daemonClientOptions?: DaemonClientOptions;
  /** Pre-built DaemonClient (for testing). Overrides daemonClientOptions. */
  daemonClient?: DaemonClient;
  /** Optional narrower daemon client for WebSocket subscribe validation. */
  wsDaemonClient?: Pick<DaemonClient, 'openConversation'>;
  /** Optional HTTP server for WebSocket upgrade wiring. */
  server?: Server;
  sessionStateBroadcaster?: SessionStateBroadcaster;
  connectionRegistry?: ConnectionRegistry;
  eventBuffer?: EventBuffer;
  streamEventBridge?: StreamEventBridgeLike;
}

export interface GatewayApp {
  app: Hono<GatewayEnv>;
  sessionService: SessionService;
  authService: AuthService;
  auditService: AuditService;
  operatorStore: OperatorStore;
  heartbeat: DaemonHeartbeat;
  sessionStateBroadcaster: SessionStateBroadcaster;
  connectionRegistry: ConnectionRegistry;
  eventBuffer: EventBuffer;
  wsServer?: GatewayWsServer;
}

function resolveSecurityConfigs(deps: GatewayAppDeps): {
  authRoutesConfig: AuthRoutesConfig;
  headersConfig: HardenedHeadersConfig;
} {
  const secureCookies =
    deps.authRoutesConfig?.secureCookies ?? (deps.tlsConfig ? isSecure(deps.tlsConfig) : false);
  const tlsActive =
    deps.hardenedHeadersConfig?.tlsActive ?? (deps.tlsConfig ? isSecure(deps.tlsConfig) : false);
  return {
    authRoutesConfig: { secureCookies },
    headersConfig: { tlsActive },
  };
}

function createProtectedAuthApp(
  authService: AuthService,
  sessionService: SessionService,
  authRoutesConfig: AuthRoutesConfig,
): Hono<GatewayEnv> {
  const authRoutes = createAuthRoutes(authService, sessionService, authRoutesConfig);
  const authApp = new Hono<GatewayEnv>();
  authApp.use('/logout', createCsrfMiddleware());
  authApp.use('/reauth', createCsrfMiddleware());
  authApp.route('/', authRoutes);
  return authApp;
}

function createProtectedRouteGroup(
  child: Hono<GatewayEnv>,
  sessionService: SessionService,
  auditService: AuditService,
): Hono<GatewayEnv> {
  const protectedApp = new Hono<GatewayEnv>();
  protectedApp.use('*', createAuthMiddleware(sessionService, auditService));
  protectedApp.use('*', createCsrfMiddleware());
  protectedApp.route('/', child);
  return protectedApp;
}

function createOptionalWsServer(
  deps: GatewayAppDeps,
  options: {
    server?: Server;
    sessionService: SessionService;
    sessionStateBroadcaster: SessionStateBroadcaster;
    allowedOrigin: string;
    connectionRegistry: ConnectionRegistry;
    clock: Clock;
    mutatingLimiter: RateLimiter;
    daemonClient: DaemonClient;
    eventBuffer: EventBuffer;
  },
): GatewayWsServer | undefined {
  if (options.server == null) {
    return undefined;
  }

  return new GatewayWsServer({
    server: options.server,
    sessionService: options.sessionService,
    broadcaster: options.sessionStateBroadcaster,
    allowedOrigin: options.allowedOrigin,
    connectionRegistry: options.connectionRegistry,
    clock: options.clock,
    sourceKeyConfig: deps.sourceKeyConfig,
    mutatingLimiter: options.mutatingLimiter,
    daemonClient: deps.wsDaemonClient ?? options.daemonClient,
    eventBuffer: options.eventBuffer,
    streamEventBridge: deps.streamEventBridge,
  });
}

export function createGatewayApp(deps: GatewayAppDeps = {}): GatewayApp {
  // TLS validation: non-loopback deployments require cert+key (FR-024)
  if (deps.tlsConfig) {
    validateTlsConfig(deps.tlsConfig);
  }

  const resolvedConfigs = resolveSecurityConfigs(deps);

  const clock = deps.clock ?? new SystemClock();
  const sessionStore = deps.sessionStore ?? new SessionStore(null);
  const operatorStore = deps.operatorStore ?? new OperatorStore(null);
  const auditStore = deps.auditStore ?? new AuditStore(null);
  const allowedOrigin = deps.allowedOrigin ?? 'http://127.0.0.1:4174';

  const auditService = new AuditService(auditStore, clock);
  const sessionStateBroadcaster = deps.sessionStateBroadcaster ?? new SessionStateBroadcaster();
  const sessionService = new SessionService(
    sessionStore,
    clock,
    deps.sessionConfig,
    auditService,
    sessionStateBroadcaster,
  );
  const rateLimiter = new RateLimiter(clock);
  const authService = new AuthService(operatorStore, rateLimiter, sessionService, auditService);
  const connectionRegistry = deps.connectionRegistry ?? new ConnectionRegistry();
  const eventBuffer = deps.eventBuffer ?? new EventBuffer();

  const heartbeat = new DaemonHeartbeat(
    sessionService,
    sessionStore,
    deps.healthChecker ?? defaultHealthChecker,
    deps.heartbeatConfig,
  );
  heartbeat.start();
  const mutatingLimiter = new RateLimiter(clock, DEFAULT_MUTATING_LIMITS);

  const app = new Hono<GatewayEnv>();

  // Source-key middleware — must run before any rate limiter
  app.use('*', createSourceKeyMiddleware(deps.sourceKeyConfig));

  // Global security headers
  app.use('*', createHardenedHeaders(resolvedConfigs.headersConfig));

  // Origin guard on all routes
  app.use('*', createOriginGuard(allowedOrigin));

  // Mutating rate limiter
  app.use('*', createMutatingRateLimiter(mutatingLimiter));

  // Auth routes — login is unauthenticated; logout/reauth need CSRF protection
  app.route(
    '/auth',
    createProtectedAuthApp(authService, sessionService, resolvedConfigs.authRoutesConfig),
  );

  // Session routes (info/extend) — require valid session + CSRF
  const sessionRoutes = createSessionRoutes(sessionService);
  app.route('/session', createProtectedRouteGroup(sessionRoutes, sessionService, auditService));

  // Conversation routes (T015, T015b) — require valid session + CSRF.
  // Routes define their own paths: /conversations/*, /approvals/*, /turns/*, /artifacts/*
  const daemonClient =
    deps.daemonClient ??
    new DaemonClient(deps.daemonClientOptions ?? { baseUrl: 'http://localhost:4173' });
  const conversationRoutes = createConversationRoutes(daemonClient);
  app.route('/', createProtectedRouteGroup(conversationRoutes, sessionService, auditService));

  const wsServer = createOptionalWsServer(deps, {
    server: deps.server,
    sessionService,
    sessionStateBroadcaster,
    allowedOrigin,
    connectionRegistry,
    clock,
    mutatingLimiter,
    daemonClient,
    eventBuffer,
  });

  return {
    app,
    sessionService,
    authService,
    auditService,
    operatorStore,
    heartbeat,
    sessionStateBroadcaster,
    connectionRegistry,
    eventBuffer,
    wsServer,
  };
}
