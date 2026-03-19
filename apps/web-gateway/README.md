# @hydra/web-gateway

> **Status:** Transport slice (Phases 1–8) — session/auth + real-time WebSocket transport implemented.

Browser-facing HTTP/WebSocket gateway built with Hono and TypeScript.

See [docs/web-interface/07-boundaries-and-governance.md](../../docs/web-interface/07-boundaries-and-governance.md)
for workspace boundary rules, ownership, and governance.

---

## Configuration Reference

The gateway's runtime behaviour is configured through **`createGatewayApp(deps)`** (`src/index.ts`).
Each subsystem accepts its own narrowly-typed config slice via `GatewayAppDeps`, described below.

> **`GatewayConfig` / `loadGatewayConfig()`** (`src/config.ts`) is a _centralized validation
> schema_ that aggregates every knob into one flat object with defaults and range checks.
> It is **not consumed by `createGatewayApp()`** — it exists as a convenience for standalone
> validation and tests. Production callers wire each subsystem config independently through
> `GatewayAppDeps`.

### Session & Lifecycle (`sessionConfig`)

Passed as `deps.sessionConfig` → `SessionService`. Partial overrides merge with defaults.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sessionLifetimeMs` | `number` | `28 800 000` (8 h) | Maximum lifetime of a single session before forced expiry. |
| `warningThresholdMs` | `number` | `900 000` (15 min) | How far before expiry connected WebSocket clients receive a `session-expiring-soon` frame. |
| `maxExtensions` | `number` | `3` | Maximum number of session-lifetime extensions allowed. |
| `extensionDurationMs` | `number` | `28 800 000` (8 h) | Duration added per extension. |
| `idleTimeoutMs` | `number` | `1 800 000` (30 min) | Inactivity period after which a WebSocket connection is closed with `Session idle timeout`. Resets on any inbound message, ping, or pong. |
| `maxConcurrentSessions` | `number` | `5` | Maximum active sessions per operator. |

### Daemon Connectivity

The gateway talks to the Hydra daemon over **two independent HTTP paths** with separate URL knobs:

| Subsystem | Deps field | URL parameter | Default | Used for |
|---|---|---|---|---|
| **Heartbeat** | `deps.heartbeatConfig` | `daemonUrl` | `http://127.0.0.1:4173` | Periodic `/status` health-check pings (`DaemonHeartbeat`). On failure, sessions transition to `daemon-unreachable` and clients receive a `daemon-unavailable` frame. Recovery triggers `daemon-restored`. |
| **Conversation** | `deps.daemonClientOptions` | `baseUrl` | `http://localhost:4173` | All conversation HTTP calls — CRUD, turn history, stream replay (`DaemonClient`). |

Both default to the daemon's standard port but are configured separately, so split-brain
deployments (e.g. heartbeat pointed at a load-balancer VIP, conversation pointed at a
sidecar) are possible.

**Heartbeat additional parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `heartbeatConfig.intervalMs` | `number` | `10 000` (10 s) | Interval between `/status` pings. |

The heartbeat's own HTTP probe uses a hard-coded **5 000 ms** abort timeout (`DaemonHeartbeat` → `defaultHealthChecker`).

**Conversation additional parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `daemonClientOptions.timeoutMs` | `number` | `5 000` (5 s) | Per-request `AbortController` timeout for all daemon HTTP calls. Timeout produces a `DAEMON_UNAVAILABLE` error. |

### Origin & Network

| Deps field | Type | Default | Description |
|---|---|---|---|
| `allowedOrigin` | `string` | `'http://127.0.0.1:4174'` | Expected `Origin` header for WebSocket upgrades and CORS checks (enforced by `createOriginGuard`). |
| `sourceKeyConfig.trustedProxies` | `string[]` | `[]` | IP allow-list of reverse proxies whose `X-Forwarded-For` headers are trusted for source-key resolution. Empty = use transport-level remote address. |
| `tlsConfig.bindAddress` | `string` | _(none)_ | Address the HTTP server binds to. Non-loopback addresses require `certPath` + `keyPath`. |
| `tlsConfig.certPath` / `keyPath` | `string?` | _(none)_ | TLS certificate and key paths. When both are present, auth cookies gain `Secure` flag and HSTS headers are emitted. |

### Rate Limiting

Configured via `authRoutesConfig` (auth rate limiting) and default constructor values (mutating rate limiting).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `rateLimitThreshold` | `number` | `5` | Maximum failed auth attempts per window before lockout. |
| `rateLimitWindowMs` | `number` | `60 000` (1 min) | Sliding window for `rateLimitThreshold`. |
| `lockoutDurationMs` | `number` | `300 000` (5 min) | Lock-out period after exceeding the auth rate-limit. |
| `mutatingRateLimitThreshold` | `number` | `30` | Maximum mutating requests (including WebSocket upgrades) per source key per window. |
| `mutatingRateLimitWindowMs` | `number` | `60 000` (1 min) | Sliding window for `mutatingRateLimitThreshold`. |

---

### Transport-Layer Parameters

These constants and constructor options live in the `src/transport/` modules. They are injectable
at construction time via `GatewayAppDeps` or importable as named constants.

#### Event Buffer (`EventBuffer`)

| Parameter | Injected via | Default | Description |
|---|---|---|---|
| `capacity` | Constructor arg | `1 000` | Maximum events retained per conversation in the in-memory ring buffer. Oldest events are silently evicted when a push exceeds capacity. Used for reconnect replay; if the client's `lastAcknowledgedSeq` falls outside the buffer, replay falls back to the daemon. |
| `inactiveTimeoutMs` | Constructor arg | `300 000` (5 min) | After the last subscriber disconnects from a conversation, the buffer's replay state for that conversation is purged after this timeout. Keeps memory bounded when conversations go idle. |

#### Daemon Client (`DaemonClient`)

See [Daemon Connectivity](#daemon-connectivity) above for `baseUrl` and `timeoutMs`.

#### WebSocket Backpressure

| Parameter | Injected via | Default | Description |
|---|---|---|---|
| `bufferHighWaterMark` | `EventForwarderOptions.bufferHighWaterMark` / `MessageHandlerDeps.bufferHighWaterMark` | `1 048 576` (1 MiB) | Per-connection outbound byte threshold. When `bufferedAmount` would exceed this value after the next send, the gateway sends a `WS_BUFFER_OVERFLOW` error frame and closes the connection with code `1008`. Protects the server from slow consumers. |

#### WebSocket Hard Limits (compile-time constants)

| Constant | Value | Location | Description |
|---|---|---|---|
| `WS_HARD_MAX_PAYLOAD` | `1 048 576` (1 MiB) | `ws-server.ts` | Hard ceiling enforced by the `ws` library on inbound WebSocket frames. Frames exceeding this are terminated at the protocol level. |
| `MAX_INBOUND_MESSAGE_BYTES` | `8 192` (8 KiB) | `ws-message-handler.ts` | App-level inbound message size policy. Messages exceeding this are rejected with a structured `WS_INVALID_MESSAGE` error _without_ closing the connection, allowing the client to retry. |
| `MAX_PENDING_MESSAGES_PER_CONNECTION` | `64` | `ws-server.ts` | Per-connection inbound message queue depth. Exceeding this triggers a `WS_MESSAGE_QUEUE_OVERFLOW` error and connection close (`1008`). Prevents a single client from monopolizing the handler. |
| `MAX_PENDING_REPLAY_EVENTS` | `1 000` | `event-forwarder.ts` | Maximum live events queued per conversation per connection while a replay is in progress. Overflow sends a `WS_REPLAY_OVERFLOW` error and closes the connection (`1008`). |
| `DAEMON_REPLAY_CONCURRENCY` | `8` | `ws-message-handler.ts` | Maximum number of concurrent per-turn stream-replay requests to the daemon during a reconnect replay sequence. Limits daemon fan-out when replaying long conversations. |
