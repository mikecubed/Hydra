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
import {
  DaemonOperationsClient,
  type DaemonOperationsClientOptions,
} from './operations/daemon-operations-client.ts';
import { createOperationsRoutes } from './operations/operations-routes.ts';
import {
  DaemonMutationsClient,
  type DaemonMutationsClientOptions,
} from './mutations/daemon-mutations-client.ts';
import { createMutationsRouter } from './mutations/mutations-routes.ts';
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
  /** Pre-built operations DaemonOperationsClient (for testing). */
  operationsClient?: DaemonOperationsClient;
  /** Daemon operations client options (defaults to daemonClientOptions.baseUrl). */
  operationsClientOptions?: DaemonOperationsClientOptions;
  /** Pre-built mutations DaemonMutationsClient (for testing). */
  mutationsClient?: DaemonMutationsClient;
  /** Daemon mutations client options (defaults to daemonClientOptions.baseUrl). */
  mutationsClientOptions?: DaemonMutationsClientOptions;
  /** Pre-built mutating rate limiter (for testing). Overrides default limits. */
  mutatingLimiter?: RateLimiter;
  /** Optional narrower daemon client for WebSocket subscribe validation. */
  wsDaemonClient?: Pick<DaemonClient, 'openConversation' | 'loadTurnHistory' | 'getStreamReplay'>;
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

interface GatewayRuntime {
  clock: Clock;
  allowedOrigin: string;
  operatorStore: OperatorStore;
  auditService: AuditService;
  sessionService: SessionService;
  authService: AuthService;
  heartbeat: DaemonHeartbeat;
  sessionStateBroadcaster: SessionStateBroadcaster;
  connectionRegistry: ConnectionRegistry;
  eventBuffer: EventBuffer;
  mutatingLimiter: RateLimiter;
}

function createGatewayRuntime(deps: GatewayAppDeps): GatewayRuntime {
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

  return {
    clock,
    allowedOrigin,
    operatorStore,
    auditService,
    sessionService,
    authService,
    heartbeat,
    sessionStateBroadcaster,
    connectionRegistry,
    eventBuffer,
    mutatingLimiter: deps.mutatingLimiter ?? new RateLimiter(clock, DEFAULT_MUTATING_LIMITS),
  };
}

function applyGatewayMiddleware(
  app: Hono<GatewayEnv>,
  deps: GatewayAppDeps,
  headersConfig: HardenedHeadersConfig,
  allowedOrigin: string,
  mutatingLimiter: RateLimiter,
): void {
  app.use('*', createSourceKeyMiddleware(deps.sourceKeyConfig));
  app.use('*', createHardenedHeaders(headersConfig));
  app.use('*', createOriginGuard(allowedOrigin));
  app.use('*', createMutatingRateLimiter(mutatingLimiter));
}

type DaemonClientOptionLike = DaemonOperationsClientOptions | DaemonMutationsClientOptions;

function resolveDaemonClientOptions(deps: GatewayAppDeps): DaemonClientOptionLike {
  return {
    baseUrl: deps.daemonClientOptions?.baseUrl ?? 'http://localhost:4173',
    ...(deps.daemonClientOptions?.fetchFn != null && { fetchFn: deps.daemonClientOptions.fetchFn }),
    ...(deps.daemonClientOptions?.timeoutMs != null && {
      timeoutMs: deps.daemonClientOptions.timeoutMs,
    }),
  };
}

function createProtectedRootRoutes(
  deps: GatewayAppDeps,
  daemonClient: DaemonClient,
): Hono<GatewayEnv> {
  const protectedRootRoutes = new Hono<GatewayEnv>();
  protectedRootRoutes.route('/', createConversationRoutes(daemonClient));

  const defaultOptions = resolveDaemonClientOptions(deps);
  const operationsClient =
    deps.operationsClient ??
    new DaemonOperationsClient(deps.operationsClientOptions ?? defaultOptions);
  protectedRootRoutes.route('/', createOperationsRoutes({ daemonClient: operationsClient }));

  const mutationsClient =
    deps.mutationsClient ??
    new DaemonMutationsClient(deps.mutationsClientOptions ?? defaultOptions);
  protectedRootRoutes.route('/mutations', createMutationsRouter(mutationsClient));

  return protectedRootRoutes;
}

function registerGatewayRoutes(
  app: Hono<GatewayEnv>,
  deps: GatewayAppDeps,
  runtime: GatewayRuntime,
  authRoutesConfig: AuthRoutesConfig,
): DaemonClient {
  app.route(
    '/auth',
    createProtectedAuthApp(runtime.authService, runtime.sessionService, authRoutesConfig),
  );

  const sessionRoutes = createSessionRoutes(runtime.sessionService);
  app.route(
    '/session',
    createProtectedRouteGroup(sessionRoutes, runtime.sessionService, runtime.auditService),
  );

  const daemonClient =
    deps.daemonClient ??
    new DaemonClient(deps.daemonClientOptions ?? { baseUrl: 'http://localhost:4173' });
  const protectedRootRoutes = createProtectedRootRoutes(deps, daemonClient);
  app.route(
    '/',
    createProtectedRouteGroup(protectedRootRoutes, runtime.sessionService, runtime.auditService),
  );

  return daemonClient;
}

export function createGatewayApp(deps: GatewayAppDeps = {}): GatewayApp {
  // TLS validation: non-loopback deployments require cert+key (FR-024)
  if (deps.tlsConfig) {
    validateTlsConfig(deps.tlsConfig);
  }

  const resolvedConfigs = resolveSecurityConfigs(deps);
  const runtime = createGatewayRuntime(deps);

  const app = new Hono<GatewayEnv>();
  applyGatewayMiddleware(
    app,
    deps,
    resolvedConfigs.headersConfig,
    runtime.allowedOrigin,
    runtime.mutatingLimiter,
  );
  app.get('/healthz', (context) => {
    const daemonHealthy = runtime.heartbeat.isDaemonHealthy();
    return context.json(
      {
        ok: daemonHealthy,
        daemonHealthy,
      },
      daemonHealthy ? 200 : 503,
    );
  });
  const daemonClient = registerGatewayRoutes(app, deps, runtime, resolvedConfigs.authRoutesConfig);

  const wsServer = createOptionalWsServer(deps, {
    server: deps.server,
    sessionService: runtime.sessionService,
    sessionStateBroadcaster: runtime.sessionStateBroadcaster,
    allowedOrigin: runtime.allowedOrigin,
    connectionRegistry: runtime.connectionRegistry,
    clock: runtime.clock,
    mutatingLimiter: runtime.mutatingLimiter,
    daemonClient,
    eventBuffer: runtime.eventBuffer,
  });

  return {
    app,
    sessionService: runtime.sessionService,
    authService: runtime.authService,
    auditService: runtime.auditService,
    operatorStore: runtime.operatorStore,
    heartbeat: runtime.heartbeat,
    sessionStateBroadcaster: runtime.sessionStateBroadcaster,
    connectionRegistry: runtime.connectionRegistry,
    eventBuffer: runtime.eventBuffer,
    wsServer,
  };
}
