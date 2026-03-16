# Research Findings: Web Gateway Conversation Transport

**Date**: 2026-03-16 | **Plan**: [plan.md](./plan.md)

## Decision 1: Daemon Event Bridge via Node.js EventEmitter

### Context

The gateway needs to receive daemon-produced stream events in near-real-time (< 500ms, SC-002) so it can forward them to connected browsers through WebSocket. The daemon's `StreamManager` currently stores events in memory and serves them via a polling HTTP endpoint (`GET /conversations/:convId/turns/:turnId/stream?lastAcknowledgedSeq=N`). This polling model works for the daemon's own REST API but is unsuitable for real-time WebSocket forwarding — the gateway would need to poll every active stream at high frequency, wasting CPU and adding latency.

### Decision

Attach a typed `EventEmitter` to the daemon's `StreamManager`. When any `StreamEvent` is produced (`emitEvent()`, `completeStream()`, `failStream()`, `cancelStream()`), the bridge emits the event on a `stream-event` channel with `{ conversationId, event }` payload. The gateway subscribes to this bridge at startup and receives events with zero latency.

### Implementation

A new `EventBridge` class in `lib/daemon/event-bridge.ts`:

- Wraps `node:events.EventEmitter`
- Single event type: `stream-event`
- Typed payload: `{ conversationId: string, event: StreamEvent }`
- Injected into `StreamManager` constructor (optional, defaults to no-op)
- `StreamManager` calls `bridge.emit()` after every event push

This is an additive change. The bridge is optional — existing `StreamManager` consumers (daemon routes, tests) that don't inject a bridge are unaffected.

### Rationale

1. **In-process deployment model**: Hydra's daemon and gateway run in the same Node.js process. In-process `EventEmitter` is the simplest zero-latency push mechanism.
2. **Minimal surface area**: One event type, one payload shape, one emitter. No protocol negotiation, no connection management, no serialization overhead.
3. **Alignment with existing patterns**: The gateway already uses `SessionStateBroadcaster` (a callback registry) for session events. An `EventEmitter` is the standard Node.js equivalent.
4. **Future-proof**: If Hydra later moves to multi-process deployment, the bridge interface can be replaced with IPC, WebSocket, or pub/sub without changing the gateway's subscription code.

### Alternatives Rejected

| Alternative                                          | Reason for Rejection                                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal SSE endpoint (daemon serves SSE to gateway) | Adds HTTP overhead for in-process communication. Requires the gateway to maintain an HTTP connection to the daemon, handle reconnects, parse SSE framing. Unnecessary complexity when both components share a process. |
| Redis / NATS pub/sub                                 | Violates the no-external-dependency constraint. Hydra targets single-machine local deployment; adding a message broker is architecturally inappropriate.                                                               |
| Polling from gateway to daemon stream endpoint       | Current model. Requires high-frequency polling (~100ms) to meet the 500ms latency target. Wastes CPU proportional to (active streams × poll frequency). Latency is inherently bounded by poll interval.                |
| Shared memory / IPC                                  | Adds complexity (serialization, synchronization) for zero benefit in a single-process model. `EventEmitter` gives the same result with less code.                                                                      |
| WebSocket between daemon and gateway (internal)      | Same drawbacks as SSE: HTTP upgrade overhead, connection lifecycle management, serialization — all for in-process communication.                                                                                       |

---

## Decision 2: WebSocket Library — `ws` (Not Hono/ws)

### Context

The gateway needs a WebSocket server to accept browser connections for real-time streaming. The gateway uses Hono as its HTTP framework. Hono offers a `hono/ws` helper, but its documentation and implementation target Cloudflare Workers and Deno — not Node.js `http.Server`.

### Decision

Use the `ws` npm package (`npm install ws`). Attach the `ws.Server` to the Node.js `http.Server` instance via the `upgrade` event on a dedicated path (`/ws`). Hono handles all REST routes on the same server; `ws` handles WebSocket upgrades.

### Implementation

```typescript
// Conceptual — actual implementation in ws-server.ts
import { WebSocketServer } from 'ws';
import http from 'node:http';

const server = http.createServer(honoApp.fetch);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    // Validate session cookie + origin before accepting
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});
```

### Rationale

1. **Hono/ws doesn't support Node.js**: `hono/ws` uses `WebSocket` adapters for Cloudflare Workers (`cloudflare:sockets`) and Deno (`Deno.upgradeWebSocket`). Node.js uses `http.Server.upgrade` event — a fundamentally different mechanism.
2. **`ws` is the Node.js standard**: Most-used WebSocket library for Node.js, zero native dependencies, stable API, production-proven.
3. **Clean separation**: Hono handles HTTP request/response; `ws` handles the WebSocket protocol. They don't interfere with each other because `upgrade` events bypass Hono's request handler entirely.
4. **Full control over upgrade**: We need to validate session cookies and Origin headers during the upgrade handshake — before the WebSocket connection is established. `ws` `noServer` mode gives us complete control over this validation.

### Alternatives Rejected

| Alternative                                        | Reason for Rejection                                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono/ws`                                          | Does not support Node.js `http.Server`. Would require Deno or Cloudflare Workers runtime.                                                                                                                                   |
| `socket.io`                                        | Adds unnecessary abstraction layer (automatic reconnect, room management, fallback transports, namespace routing). Conflicts with explicit control over connection lifecycle required by the spec. Dependencies add ~200KB. |
| `uWebSockets.js`                                   | Native C++ addon. Violates Hydra's minimalism constraint. Build complexity, platform-specific binaries.                                                                                                                     |
| Raw `node:http` upgrade + manual WebSocket framing | Reimplementing the WebSocket protocol is error-prone and unmaintainable. `ws` handles framing, masking, ping/pong, close handshake correctly.                                                                               |

---

## Decision 3: Gateway-Side Ring Buffer for Reconnect/Resume

### Context

When a browser loses its WebSocket connection (network blip, page refresh, device sleep), it needs to reconnect and receive all events produced during the disconnection (FR-022). Events must replay in order with no gaps or duplicates (FR-024). The daemon already supports `StreamManager.getStreamEventsSince(turnId, fromSeq)` for replay, but this requires an HTTP round-trip and is per-turn — not per-conversation.

### Decision

Maintain a bounded, per-conversation ring buffer of recent `StreamEvent`s at the gateway. On reconnect, check the buffer first; if it covers the requested range, replay from memory. If the requested sequence is older than the buffer's oldest event, fall back to the daemon's per-turn replay endpoint (`GET /conversations/:convId/turns/:turnId/stream?lastAcknowledgedSeq=N`), iterating over the conversation's active/recent turns and merging the results. The gateway buffer abstracts the daemon's turn-scoped replay into a conversation-scoped interface for the WebSocket client.

### Implementation

The `EventBuffer` class:

- `Map<conversationId, RingBuffer>` where `RingBuffer` is a fixed-capacity circular array
- Default capacity: 1000 events per conversation
- Events are pushed by the `EventForwarder` (same event that gets forwarded to WebSocket connections)
- On reconnect: `buffer.getEventsSince(conversationId, lastAckSeq)` → if available, replay directly; if not, fall back to per-turn daemon replay (iterate turns via list-turns, call `getStreamEventsSince(turnId, fromSeq)` for each, merge and deduplicate by seq)

### Rationale

1. **Sub-second replay for common case**: Most disconnections are brief (< 30 seconds). A gateway-local buffer avoids the HTTP round-trip to the daemon, giving sub-100ms replay latency.
2. **Bounded memory**: Ring buffer with configurable capacity. At ~500 bytes per event, 1000 events = ~500KB per active conversation. With 10 active conversations, total buffer ≈ 5MB.
3. **Graceful degradation**: If the buffer can't cover the gap (long disconnection, buffer eviction), the daemon's replay endpoint is the fallback. No data loss — just slightly slower replay.
4. **Simple correctness guarantees**: Events in the buffer are in sequence order (pushed in order by the forwarder). `getEventsSince()` is a simple filter. No reordering needed.

### Alternatives Rejected

| Alternative                                | Reason for Rejection                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon-only replay                         | Correct but slow, and the daemon's replay is turn-scoped (`getStreamEventsSince(turnId, fromSeq)`) — not conversation-scoped. Every reconnect would require HTTP round-trips per-turn plus merge logic. For a 100ms network blip, this adds 50-200ms unnecessarily. The gateway buffer serves as a conversation-scoped cache that avoids per-turn decomposition in the common case. |
| Unbounded buffer                           | Memory risk. A long-running conversation with thousands of streaming events could consume excessive memory. Ring buffer bounds the worst case.                                                                                                                                                                                                                                      |
| Client-side state reconstruction from REST | The spec (FR-023) allows the browser to use REST endpoints for state reconstruction, but this is for full page-refresh scenarios — not for brief disconnections during active streaming. REST reconstruction requires multiple requests (conversation detail + turn history + pending approvals) and doesn't recover mid-stream events.                                             |
| Persistent buffer (file/disk)              | Adds I/O latency and file management complexity. The buffer is for brief disconnections; events older than the buffer can be recovered from the daemon. Persistence provides no additional value.                                                                                                                                                                                   |

---

## Decision 4: Connection Registry — Session and Conversation Indexing

### Context

The gateway needs to efficiently route events to the correct WebSocket connections. Two routing dimensions exist:

1. **By session** — when a session expires, all connections for that session must be terminated (FR-015).
2. **By conversation** — when a stream event arrives, all connections subscribed to that conversation must receive it (FR-010).

### Decision

A `ConnectionRegistry` with two indices:

- `bySession: Map<sessionId, Set<connectionId>>` — for session lifecycle operations
- `byConversation: Map<conversationId, Set<connectionId>>` — for stream event forwarding
- `connections: Map<connectionId, WebSocketConnection>` — master store

### Rationale

1. **O(1) lookup for both routing dimensions**: Session termination is O(connections_per_session), not O(total_connections). Event forwarding is O(connections_per_conversation), not O(total_connections).
2. **Clean lifecycle**: When a connection disconnects, one call to `unregister()` cleans all indices. No orphan references.
3. **Extends existing pattern**: The gateway already has `SessionStateBroadcaster` which maps `sessionId → callbacks`. The registry extends this pattern to also handle conversation routing.
4. **Testable**: Pure data structure with no I/O. Every operation is deterministic.

### Alternatives Rejected

| Alternative                              | Reason for Rejection                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single flat list, linear scan            | O(n) on every event forward. With multiple active conversations and many events per second, this becomes a bottleneck.                            |
| Reuse `SessionStateBroadcaster` directly | Its `StateChangeCallback` shape doesn't carry conversation subscription state. Would need to be generalized — higher coupling, more complex type. |
| Separate registries per dimension        | More code duplication. A single registry with two indices is simpler and guarantees consistency between them.                                     |

---

## Decision 5: REST-Only Commands, WebSocket for Streaming + Lightweight Control

### Context

The spec removed FR-012 (bidirectional command transport over WebSocket). The question is: what messages does the browser send through the WebSocket?

### Decision

Three client→server WebSocket message types only:

- `subscribe { conversationId }` — join a conversation's event stream
- `unsubscribe { conversationId }` — leave a conversation's event stream
- `ack { conversationId, seq }` — acknowledge receipt of events up to a sequence number

All conversation mutations (create, submit instruction, approve, cancel, retry) flow through REST endpoints. The WebSocket is server→client streaming + lightweight client control.

### Rationale

1. **Spec alignment**: FR-012 was explicitly removed. The spec says "commands flow via REST."
2. **Security simplicity**: REST commands go through the full middleware stack (auth, CSRF, rate limiting, validation). Replicating that middleware for WebSocket commands would be duplicative and error-prone.
3. **Testability**: REST endpoints are easily testable with standard HTTP testing tools. WebSocket command testing would require additional infrastructure.
4. **Subscribe/unsubscribe are not mutations**: They're connection-local state changes that determine which events this connection receives. They don't modify conversation state on the daemon.
5. **Ack is idempotent**: Acknowledging a sequence number is a no-op for conversation state — it only updates the connection's local resume position.

---

## Decision 6: Gateway Error Response Shape — Five Categories, Gateway-Internal

### Context

The spec requires (FR-026) a structured error shape that lets the browser distinguish between error categories (FR-027). The spec explicitly states that a shared error contract in `packages/web-contracts` is a follow-on — the gateway defines its own shape.

### Decision

A `GatewayErrorResponse` type with `{ ok: false, code, category, message, conversationId?, turnId?, retryAfterMs? }`. Five categories: `auth`, `session`, `validation`, `daemon`, `rate-limit`. Used for both REST JSON error bodies and WebSocket error frames.

### Rationale

1. **Extends existing code**: The gateway already has `GatewayError` with `code`, `message`, and `statusCode`. Adding `category` is additive.
2. **Browser-discriminable**: The browser can switch on `category` to determine the correct UX response without parsing error codes or HTTP status codes.
3. **Future-promotable**: When a shared contract is needed, the shape can be promoted to `packages/web-contracts` with the same structure. No breaking changes.
4. **Five categories match spec**: FR-027 requires "at minimum five error categories" — these five cover the spec's examples exactly.

### Alternatives Rejected

| Alternative                                  | Reason for Rejection                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reuse `@hydra/web-contracts` `ErrorResponse` | That type covers daemon conversation errors (`NOT_FOUND`, `STALE_APPROVAL`, etc.) but doesn't include auth, session, or rate-limit categories. Different concerns. |
| HTTP status code as the only signal          | 401 means both "not authenticated" and "session expired." The browser needs the `category` to distinguish them.                                                    |
| Define shared contract now                   | Spec explicitly defers this. Adding it now would expand scope and create a cross-package dependency for a shape that may evolve once the browser UI is built.      |
