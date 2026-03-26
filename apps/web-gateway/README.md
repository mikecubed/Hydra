# @hydra/web-gateway

> **Status:** Transport stack is implemented; Phase 8 final verification is still in progress.

Browser-facing HTTP/WebSocket gateway built with Hono and TypeScript.

See [docs/web-interface/07-boundaries-and-governance.md](../../docs/web-interface/07-boundaries-and-governance.md)
for workspace boundary rules, ownership, and governance.

---

## Local Startup Commands

Run these from the repo root when you want the browser and gateway up together against the local
daemon:

1. Start the daemon:

   ```bash
   npm start
   ```

2. In a second terminal, build the browser and start the gateway:

   ```bash
   HYDRA_WEB_OPERATOR_ID=admin \
   HYDRA_WEB_OPERATOR_SECRET=password123 \
   npm --workspace @hydra/web-gateway run start:with-web
   ```

This starts the gateway on `http://127.0.0.1:4174`, serves the built browser bundle from
`apps/web/dist`, points daemon-facing calls at `http://127.0.0.1:4173`, and seeds a local operator
record if one does not already exist in `~/.hydra/web-gateway/operators.json`.

If the web bundle is already built, you can skip the build step and run:

```bash
npm --workspace @hydra/web-gateway run start
```

Environment variables supported by `src/server.ts`:

| Variable                          | Default                 | Purpose                                       |
| --------------------------------- | ----------------------- | --------------------------------------------- |
| `HYDRA_WEB_GATEWAY_HOST`          | `127.0.0.1`             | Bind address for the local gateway server     |
| `HYDRA_WEB_GATEWAY_PORT`          | `4174`                  | HTTP port for the same-origin browser surface |
| `HYDRA_WEB_GATEWAY_ORIGIN`        | `http://127.0.0.1:4174` | Origin enforced by gateway origin checks      |
| `HYDRA_DAEMON_URL`                | `http://127.0.0.1:4173` | Upstream daemon base URL                      |
| `HYDRA_WEB_STATIC_DIR`            | `apps/web/dist`         | Built frontend directory to serve             |
| `HYDRA_WEB_STATE_DIR`             | `~/.hydra/web-gateway`  | Local operator/session/audit state directory  |
| `HYDRA_WEB_OPERATOR_ID`           | unset                   | Optional operator id to seed for local dev    |
| `HYDRA_WEB_OPERATOR_DISPLAY_NAME` | same as operator id     | Optional display name for the seeded operator |
| `HYDRA_WEB_OPERATOR_SECRET`       | unset                   | Optional password for the seeded operator     |

## Runtime Configuration Surface

The gateway is assembled through **`createGatewayApp(deps)`** in `src/index.ts`.
That factory is the live runtime surface used by tests and production wiring.

`GatewayConfig` / `loadGatewayConfig()` in `src/config.ts` is a **standalone validation schema**
with defaults and range checks. It is not consumed by `createGatewayApp()` directly. Use it when
you want one flat validated object, but treat `GatewayAppDeps` as the authoritative runtime API.

## Session and Lifecycle

`deps.sessionConfig` is passed through to `SessionService` as a partial override.

| Parameter               | Default           | Purpose                                                                |
| ----------------------- | ----------------- | ---------------------------------------------------------------------- |
| `sessionLifetimeMs`     | `28_800_000` (8h) | Hard session lifetime before expiry.                                   |
| `warningThresholdMs`    | `900_000` (15m)   | How long before expiry the gateway emits `session-expiring-soon`.      |
| `maxExtensions`         | `3`               | Maximum number of allowed session extensions.                          |
| `extensionDurationMs`   | `28_800_000` (8h) | Duration added on each successful extension.                           |
| `idleTimeoutMs`         | `1_800_000` (30m) | Inactivity threshold used by WebSocket idle cleanup and re-auth rules. |
| `maxConcurrentSessions` | `5`               | Maximum active sessions per operator.                                  |

## Daemon Connectivity

The gateway uses two separate daemon-facing paths with separate config entries.

| Subsystem                | Runtime field                   | Default                 | Notes                                                          |
| ------------------------ | ------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Heartbeat health checks  | `heartbeatConfig.daemonUrl`     | `http://127.0.0.1:4173` | Used by `DaemonHeartbeat` to poll `/status`.                   |
| Heartbeat interval       | `heartbeatConfig.intervalMs`    | `10_000`                | Interval between heartbeat probes.                             |
| Conversation HTTP client | `daemonClientOptions.baseUrl`   | `http://localhost:4173` | Used by `DaemonClient` for conversation REST and replay calls. |
| Conversation timeout     | `daemonClientOptions.timeoutMs` | `5_000`                 | Per-request abort timeout for daemon conversation calls.       |

Additional notes:

- The heartbeat probe itself uses a hard-coded 5 second timeout inside `defaultHealthChecker()`.
- Failed conversation fetches are translated to structured gateway errors such as
  `DAEMON_UNREACHABLE`.
- `deps.daemonClient` and `deps.wsDaemonClient` let callers inject prebuilt clients for tests or
  specialized wiring.

## Security and Network Wiring

| Runtime field                     | Default                            | Purpose                                                                                |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `allowedOrigin`                   | `http://127.0.0.1:4174`            | Exact origin required by HTTP origin guard and WebSocket upgrade checks.               |
| `sourceKeyConfig.trustedProxies`  | `[]`                               | Reverse-proxy allow-list used when resolving `X-Forwarded-For` source keys.            |
| `authRoutesConfig.secureCookies`  | Derived from TLS when not provided | Controls the `Secure` flag on `__session` and `__csrf` cookies.                        |
| `hardenedHeadersConfig.tlsActive` | Derived from TLS when not provided | Controls HSTS/header hardening behavior.                                               |
| `tlsConfig`                       | unset                              | Optional TLS validation and secure-cookie/HSTS inference for non-loopback deployments. |

## Rate Limiting

### Auth rate limiter

`createGatewayApp()` constructs the auth limiter internally as `new RateLimiter(clock)`.
That means the shipped auth defaults are:

| Setting       | Default   |
| ------------- | --------- |
| `maxAttempts` | `5`       |
| `windowMs`    | `60_000`  |
| `lockoutMs`   | `300_000` |

`GatewayAppDeps` does **not** expose per-field auth rate-limit knobs. `authRoutesConfig` only
controls secure-cookie behavior.

### Mutating rate limiter

The gateway also installs a separate limiter for mutating HTTP requests and WebSocket upgrades.
By default `createGatewayApp()` creates:

| Setting       | Default  |
| ------------- | -------- |
| `maxAttempts` | `30`     |
| `windowMs`    | `60_000` |
| `lockoutMs`   | `60_000` |

This limiter is configurable only by supplying a prebuilt `deps.mutatingLimiter`.
`createGatewayApp()` does not expose these thresholds as separate scalar fields.

Important scope note:

- The mutating limiter applies to non-safe HTTP methods and to the `/ws` upgrade handshake.
- It does **not** rate-limit individual `subscribe`, `unsubscribe`, or `ack` WebSocket frames.

## Transport Defaults and Injection Points

Some transport settings are true runtime inputs; others are implementation defaults inside the
transport modules.

| Setting                                           | Default             | Where defined                     | Exposure                                                                                                |
| ------------------------------------------------- | ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Event buffer capacity                             | `1000`              | `EventBuffer` constructor         | Override by injecting a prebuilt `deps.eventBuffer`.                                                    |
| Inactive conversation cleanup timeout             | `300_000` (5m)      | `EventBuffer` constructor         | Override by injecting a prebuilt `deps.eventBuffer`.                                                    |
| Daemon client timeout                             | `5_000`             | `DaemonClient`                    | Override with `deps.daemonClientOptions.timeoutMs` or a prebuilt `deps.daemonClient`.                   |
| WebSocket backpressure high-water mark            | `1_048_576` (1 MiB) | `transport/backpressure.ts`       | Used by `EventForwarder` and `WsMessageHandler`; not currently exposed through `GatewayAppDeps`.        |
| WebSocket hard payload ceiling                    | `1_048_576` (1 MiB) | `transport/ws-server.ts`          | Hard `ws` `maxPayload` ceiling; messages above this are rejected by `ws` before the gateway sees them.  |
| App-level inbound WS message limit                | `8192` (8 KiB)      | `transport/ws-message-handler.ts` | App-level validation limit applied after the `ws` ceiling; oversized messages get `WS_INVALID_MESSAGE`. |
| Pending inbound WS messages per connection        | `64`                | `transport/ws-server.ts`          | Internal queue-depth guard.                                                                             |
| Pending replay events per connection/conversation | `1000`              | `transport/event-forwarder.ts`    | Internal replay-backlog guard.                                                                          |
| Daemon replay concurrency                         | `8`                 | `transport/ws-message-handler.ts` | Internal upper bound for concurrent per-turn replay fetches.                                            |

## Session-Termination Timing

`SessionWsBridge` sends `session-terminated` first, then closes all connections for that session
asynchronously on the next tick (`setTimeout(..., 0)`).

That behavior is an implementation detail, not a configurable `GatewayAppDeps` knob.
