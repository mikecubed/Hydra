# @hydra/web-gateway

> **Status:** Transport slice (Phases 1–8) — session/auth + real-time WebSocket transport implemented.

Browser-facing HTTP/WebSocket gateway built with Hono and TypeScript.

See [docs/web-interface/07-boundaries-and-governance.md](../../docs/web-interface/07-boundaries-and-governance.md)
for workspace boundary rules, ownership, and governance.

---

## Configuration Reference

All gateway behaviour is controlled through `GatewayConfig` (defined in `src/config.ts`).
Transport-layer modules accept additional constructor-level options described below.

### Gateway Config (`GatewayConfig`)

Pass overrides to `loadGatewayConfig(overrides)`. Any field not supplied uses its default.

#### Session & Lifecycle

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sessionLifetimeMs` | `number` | `28 800 000` (8 h) | Maximum lifetime of a single session before forced expiry. |
| `warningThresholdMs` | `number` | `900 000` (15 min) | How far before expiry connected WebSocket clients receive a `session-expiring-soon` frame. |
| `maxExtensions` | `number` | `3` | Maximum number of session-lifetime extensions allowed. |
| `extensionDurationMs` | `number` | `28 800 000` (8 h) | Duration added per extension. |
| `idleTimeoutMs` | `number` | `1 800 000` (30 min) | Inactivity period after which a WebSocket connection is closed with `Session idle timeout`. Resets on any inbound message, ping, or pong. |
| `maxConcurrentSessions` | `number` | `5` | Maximum active sessions per operator. |

#### Daemon Heartbeat

| Parameter | Type | Default | Description |
|---|---|---|---|
| `heartbeatIntervalMs` | `number` | `10 000` (10 s) | Interval between daemon `/status` health-check pings. On failure, all active sessions transition to `daemon-unreachable` and connected clients receive a `daemon-unavailable` frame. Recovery triggers `daemon-restored`. |

The heartbeat's own HTTP probe uses a hard-coded **5 000 ms** abort timeout (`DaemonHeartbeat` → `defaultHealthChecker`).

#### Rate Limiting

| Parameter | Type | Default | Description |
|---|---|---|---|
| `rateLimitThreshold` | `number` | `5` | Maximum failed auth attempts per window before lockout. |
| `rateLimitWindowMs` | `number` | `60 000` (1 min) | Sliding window for `rateLimitThreshold`. |
| `lockoutDurationMs` | `number` | `300 000` (5 min) | Lock-out period after exceeding the auth rate-limit. |
| `mutatingRateLimitThreshold` | `number` | `30` | Maximum mutating requests (including WebSocket upgrades) per source key per window. |
| `mutatingRateLimitWindowMs` | `number` | `60 000` (1 min) | Sliding window for `mutatingRateLimitThreshold`. |

#### Audit & Network

| Parameter | Type | Default | Description |
|---|---|---|---|
| `auditRetentionDays` | `number` | `90` | Days to retain audit-log entries. |
| `clockDriftToleranceMs` | `number` | `30 000` (30 s) | Allowed clock skew between gateway and daemon for token / session validation. |
| `bindAddress` | `string` | `'127.0.0.1'` | Address the HTTP server binds to. |
| `gatewayOrigin` | `string` | `'http://127.0.0.1:4174'` | Expected `Origin` header for WebSocket upgrades and CORS checks. |
| `trustedProxies` | `string[]` | `[]` | IP allow-list of reverse proxies whose `X-Forwarded-For` headers are trusted for source-key resolution. Empty = use transport-level remote address. |
| `certPath` / `keyPath` | `string?` | _(none)_ | Optional TLS certificate and key paths for HTTPS listeners. |

---

### Transport-Layer Parameters

These constants and constructor options live in the `src/transport/` modules. They are not part of
`GatewayConfig` but are injectable at construction time or importable as named constants.

#### Event Buffer (`EventBuffer`)

| Parameter | Injected via | Default | Description |
|---|---|---|---|
| `capacity` | Constructor arg | `1 000` | Maximum events retained per conversation in the in-memory ring buffer. Oldest events are silently evicted when a push exceeds capacity. Used for reconnect replay; if the client's `lastAcknowledgedSeq` falls outside the buffer, replay falls back to the daemon. |
| `inactiveTimeoutMs` | Constructor arg | `300 000` (5 min) | After the last subscriber disconnects from a conversation, the buffer's replay state for that conversation is purged after this timeout. Keeps memory bounded when conversations go idle. |

#### Daemon Client (`DaemonClient`)

| Parameter | Injected via | Default | Description |
|---|---|---|---|
| `timeoutMs` | `DaemonClientOptions.timeoutMs` | `5 000` (5 s) | Per-request `AbortController` timeout for all HTTP calls to the daemon (conversation CRUD, turn history, stream replay). Timeout produces a translated `DAEMON_UNAVAILABLE` error to the caller. |
| `baseUrl` | `DaemonClientOptions.baseUrl` | _(required)_ | Daemon base URL (e.g. `http://localhost:4173`). |

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
