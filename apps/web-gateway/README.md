# @hydra/web-gateway

> **Status:** Transport stack is implemented; Phase 8 final verification is still in progress.

Browser-facing HTTP/WebSocket gateway built with Hono and TypeScript.

See [docs/web-interface/07-boundaries-and-governance.md](../../docs/web-interface/07-boundaries-and-governance.md)
for workspace boundary rules, ownership, and governance.

---

## Startup Commands

### Local — source checkout

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

3. Open `http://127.0.0.1:4174/workspace` in your browser.

4. **Log in** — Navigate to `http://127.0.0.1:4174/login` in your browser, enter your
   credentials, and the workspace will open automatically.

This starts the gateway on `http://127.0.0.1:4174`, serves the built browser bundle from
`apps/web/dist`, points daemon-facing calls at `http://127.0.0.1:4173`, and seeds a local operator
record if one does not already exist in `~/.hydra/web-gateway/operators.json`.

If the web bundle is already built, you can skip the build step and run:

```bash
npm --workspace @hydra/web-gateway run start
```

### Local — packaged npm install

Published npm packages include a pre-built web runtime in `dist/web-runtime/`. This directory
contains `server.js` (bundled gateway entry), `web/` (built browser assets), and a `.packaged`
sentinel marker. The browser assets are built from `apps/web` during `prepack`.

1. Start the daemon:

   ```bash
   npm start
   ```

2. In a second terminal, start the packaged gateway:

   ```bash
   HYDRA_WEB_OPERATOR_ID=admin \
   HYDRA_WEB_OPERATOR_SECRET=password123 \
   node dist/web-runtime/server.js
   ```

3. Open `http://127.0.0.1:4174/login` in your browser, enter your credentials, and the workspace
   will open automatically.

The bundled gateway entry automatically resolves its static asset directory to
`dist/web-runtime/web/` — no `HYDRA_WEB_STATIC_DIR` override is needed. Root production
dependencies (`@hono/node-server`, `hono`, `ws`) are included in the published package so the
gateway entry is runnable without workspace-level installs.

> **If `dist/web-runtime/` is missing** from the installed package, the package artifact is
> incomplete. Rebuild from a source checkout with `npm pack` (which runs `prepack` and produces a
> complete tarball). There is no recovery command available inside the installed package itself.

> **Standalone executable:** The standalone exe build (`npm run build:exe`) does not include web
> runtime assets. `hydra --full` is not supported for standalone exe builds.

### Remote host

When running on a server (e.g., `truenas-2.example.com`) that other browsers will reach over the
network:

1. Set `HYDRA_WEB_GATEWAY_HOST=0.0.0.0` (or a specific interface IP) so the server binds to
   a reachable interface — the default `127.0.0.1` is loopback-only.

2. Set `HYDRA_WEB_GATEWAY_ORIGIN` to the **exact URL** browsers will use to reach the gateway.
   The gateway uses this value for origin checks and cookie `Domain` inference. If it does not
   match what the browser sends, every request will be rejected.

3. Set `HYDRA_DAEMON_URL` if the Hydra daemon is not on `http://127.0.0.1:4173`.

**Source checkout:**

```bash
HYDRA_WEB_GATEWAY_HOST=0.0.0.0 \
HYDRA_WEB_GATEWAY_ORIGIN=http://truenas-2.example.com:4174 \
HYDRA_DAEMON_URL=http://truenas-2.example.com:4173 \
HYDRA_WEB_OPERATOR_ID=admin \
HYDRA_WEB_OPERATOR_SECRET=password123 \
npm --workspace @hydra/web-gateway run start:with-web
```

**Packaged npm install:**

```bash
HYDRA_WEB_GATEWAY_HOST=0.0.0.0 \
HYDRA_WEB_GATEWAY_ORIGIN=http://truenas-2.example.com:4174 \
HYDRA_DAEMON_URL=http://truenas-2.example.com:4173 \
HYDRA_WEB_OPERATOR_ID=admin \
HYDRA_WEB_OPERATOR_SECRET=password123 \
node dist/web-runtime/server.js
```

After the gateway starts, log in from any browser on the network:

Navigate to `http://truenas-2.example.com:4174/login` in your browser, enter your credentials,
and the workspace will open automatically.

> **`HYDRA_WEB_GATEWAY_HOST` vs `HYDRA_WEB_GATEWAY_ORIGIN`**
>
> These control different things. `HYDRA_WEB_GATEWAY_HOST` is the **network interface the server
> binds to** — it is a local IP or hostname your OS resolves to a network interface. Setting it to
> a remote hostname that is not a local interface will cause the bind to fail or silently fall back
> to loopback. Use `0.0.0.0` to accept connections on all interfaces.
>
> `HYDRA_WEB_GATEWAY_ORIGIN` is the **public-facing URL** the browser uses to reach the gateway.
> It is used for origin validation and must match the exact scheme, hostname, and port the browser
> sends in the `Origin` header.

### Session errors

**`Gateway 401: No valid session found`** means the browser has no `__session` cookie.  
This always happens before you have logged in. Navigate to `/login` to create a session.

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

## Session Lifecycle

Once an operator is authenticated, the browser client manages the session automatically.

### Polling

`useSession` polls `GET /session/info` every **60 seconds** (±5% random jitter) to keep local
session state current. Polling pauses when the browser tab is hidden and resumes on visibility.
It stops entirely on terminal states (`expired`, `invalidated`, `logged-out`).

### WebSocket real-time events

The browser subscribes to the `/ws` WebSocket endpoint. The gateway broadcasts `SessionEvent`
frames (`state-change`, `expiry-warning`, `forced-logout`) so state transitions take effect
immediately without waiting for the next poll cycle.

On unexpected WebSocket close the client reconnects with binary exponential back-off
(1 s base, 2× per attempt, 30 s cap, ±500 ms jitter).

### Expiry warning

When `session.state` reaches `'expiring-soon'` (default: 15 minutes before expiry), the workspace
shows an amber expiry banner. Operators can:

- **Extend Session** — calls `POST /auth/reauth` (double-submit CSRF cookie required). The gateway
  resets the expiry clock and broadcasts a `state-change` event.
- **Dismiss** — hides the banner locally (session continues to count down).

### Daemon-unreachable state

If the gateway loses connectivity to the Hydra daemon it emits `session.state = 'daemon-unreachable'`.
The workspace shows a full-width error screen with a **Check again** button. There is no redirect
to `/login` — the session is still valid; only the daemon is temporarily unavailable.

### Logout

`POST /auth/logout` invalidates the `__session` and `__csrf` cookies. The browser's **Log out**
button calls this endpoint and redirects to `/login`.

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

## HTTP Auth Endpoints

| Endpoint        | Method | Description                                                                                                                                                                     |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/login`   | `POST` | Authenticate operator. Sets `__session` (HttpOnly) and `__csrf` (JS-readable) cookies on success.                                                                               |
| `/auth/logout`  | `POST` | Invalidate current session. Requires `__session` cookie + `x-csrf-token` header (double-submit CSRF).                                                                           |
| `/auth/reauth`  | `POST` | Extend current session clock. Requires `__session` cookie + `x-csrf-token` header. Returns `ExtendResponse` with `newExpiresAt`. Subject to `maxExtensions` limit (default: 3). |
| `/session/info` | `GET`  | Returns `SessionInfo` for current session, or `401` if session missing/expired.                                                                                                 |

The `__csrf` cookie is set alongside `__session` on login. Read it from `document.cookie` and
send it as the `x-csrf-token` request header on all mutating auth calls.

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

## Verification Checklist

Use this checklist to confirm the gateway is working end-to-end before a release or after
significant changes. Every item uses commands that exist today. This section is the reference for
T030 final verification.

### Gateway tests

- [ ] Gateway test suite passes:
  ```bash
  npm --workspace @hydra/web-gateway run test
  ```

### Source-checkout startup

- [ ] Start the daemon (`npm start`), then the gateway with web build:
  ```bash
  HYDRA_WEB_OPERATOR_ID=admin \
  HYDRA_WEB_OPERATOR_SECRET=password123 \
  npm --workspace @hydra/web-gateway run start:with-web
  ```
- [ ] Gateway starts on `http://127.0.0.1:4174` without errors.
- [ ] `GET /session/info` returns 401 before login (no session cookie).
- [ ] `POST /auth/login` with seeded credentials sets `__session` and `__csrf` cookies.
- [ ] `GET /session/info` returns a valid `SessionInfo` after login.
- [ ] WebSocket connection at `/ws` upgrades successfully with a valid session.
- [ ] Static assets at `/` serve the built browser bundle from `apps/web/dist`.

### Packaged npm runtime

- [ ] Package evidence passes (dry-run pack + tarball checks):
  ```bash
  npm run package:evidence
  ```
- [ ] Generate an installable tarball for the manual smoke test (the source checkout is cleaned
      after `npm pack`):
  ```bash
  npm pack
  ```
- [ ] Manual packaged-runtime smoke tests run from an installed package (for example a temporary
      `npm install ./hydra-*.tgz` in a scratch directory).
- [ ] `node_modules/hydra/dist/web-runtime/server.js` starts and automatically resolves static
      assets from `node_modules/hydra/dist/web-runtime/web/` — no `HYDRA_WEB_STATIC_DIR` override
      needed.
- [ ] Login and session lifecycle behave identically to the source-checkout path.

### Standalone executable (CLI-only)

- [ ] Confirm that standalone exe builds (`npm run build:exe`) do **not** include web runtime
      assets. The exe is CLI-only; `hydra --full` is not supported for exe builds.

### Security and rate limiting

- [ ] Origin validation rejects requests with a mismatched `Origin` header.
- [ ] Auth rate limiter blocks after 5 failed login attempts within 60 seconds (300 s lockout).
- [ ] Mutating rate limiter caps non-safe HTTP methods at 30 requests per 60 seconds per source.
- [ ] CSRF double-submit check rejects `POST /auth/logout` and `POST /auth/reauth` without a
      valid `x-csrf-token` header.

### Session lifecycle

- [ ] Session expiry warning fires at the configured threshold (default: 15 min before expiry).
- [ ] `POST /auth/reauth` extends session and broadcasts a `state-change` WebSocket event.
- [ ] Session extension respects `maxExtensions` limit (default: 3).
- [ ] `POST /auth/logout` invalidates `__session` and `__csrf` cookies.
- [ ] Gateway emits `daemon-unreachable` state when the daemon is stopped, and `daemon-restored`
      when it returns.

### Remote host

- [ ] Setting `HYDRA_WEB_GATEWAY_HOST=0.0.0.0` binds to all interfaces.
- [ ] Setting `HYDRA_WEB_GATEWAY_ORIGIN` to the public URL passes origin validation for remote
      browsers.

### Daemon connectivity

- [ ] Heartbeat probe detects daemon unavailability within `intervalMs` (default: 10 s).
- [ ] Conversation HTTP client returns `DAEMON_UNREACHABLE` (503) when the daemon is down.

## Session-Termination Timing

`SessionWsBridge` sends `session-terminated` first, then closes all connections for that session
asynchronously on the next tick (`setTimeout(..., 0)`).

That behavior is an implementation detail, not a configurable `GatewayAppDeps` knob.
