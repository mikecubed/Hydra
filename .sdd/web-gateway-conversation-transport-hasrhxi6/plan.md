# Implementation Plan: Web Gateway Conversation Transport

**Date**: 2026-03-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `.sdd/web-gateway-conversation-transport-hasrhxi6/spec.md`

## Summary

This plan delivers the mediation and streaming transport layer that connects the browser to the daemon's conversation system through the gateway. It introduces gateway REST routes that validate, mediate, and translate every conversation operation (lifecycle, turns, approvals, work control, artifacts) between authenticated browser sessions and the daemon; a WebSocket connection bound to authenticated sessions for real-time streaming of daemon events to the browser; a daemon-side event subscription mechanism (the "event bridge") so the gateway can receive events as they are produced rather than polling; a gateway-side ring buffer with sequence-based reconnect/resume; and a structured gateway error shape that categorizes failures for the browser. The daemon remains authoritative for all conversation state; the gateway is a mediation and security boundary only.

> **Scope note.** This slice is positioned between `web-conversation-protocol` (which defined the conversation data model, Zod schemas, and daemon routes) and `web-chat-workspace` (which will build the browser UI consuming this transport). Bidirectional WebSocket commands, shared error contracts in `packages/web-contracts`, transport fallback/polling, and browser UI are intentionally excluded. Fork/queue management are daemon-only concerns already implemented; the gateway mediates but does not extend them.

## Prerequisites

This slice depends on and does NOT re-own the following existing deliverables:

- **web-repl-foundation** — npm workspaces, `packages/web-contracts/` package skeleton, quality gates.
- **web-session-auth** — browser session lifecycle, authentication, session cookies (`__session` HttpOnly, `__csrf` double-submit), CSRF protection, origin validation, rate limiting, hardened headers, audit recording, `SessionStateBroadcaster`, `DaemonHeartbeat`. This slice reuses all auth/session/security primitives and middleware without redesigning them. However, the WebSocket notification bridge — wiring `SessionStateBroadcaster` callbacks and `DaemonHeartbeat` state transitions into WS protocol messages — is new plumbing delivered by this slice (Phase 3, task 5). The primitives themselves are not modified; the bridge that connects them to the WS transport layer is new scope.
- **web-conversation-protocol** — conversation data model (Conversation, Turn, StreamEvent, ApprovalRequest, Artifact, ActivityEntry, Attribution), Zod validation schemas in `packages/web-contracts/`, all 6 daemon contract families, daemon REST routes in `lib/daemon/conversation-routes.ts`, `ConversationStore`, and `StreamManager`.
- **Daemon conversation REST routes** — the daemon's 19 HTTP endpoints for conversation operations (lifecycle, turns, approvals, work control, artifacts, activities). The gateway mediates browser requests to these routes via internal HTTP fetch.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict, ES2024, NodeNext modules)
**Primary Dependencies**: Hono 4.x (gateway framework), `ws` (WebSocket server — Node.js standard; Hono's `hono/ws` adapter is Cloudflare/Deno-oriented and does not support Node.js `http.Server` upgrade), Zod 4.x (request validation via `@hydra/web-contracts`), `node:crypto` (connection IDs), `node:events` (daemon event bridge emitter)
**Storage**: In-memory only — gateway event buffer is a bounded ring buffer; all persistent state remains daemon-owned
**Testing**: `node:test` + `node:assert/strict` (native runner); c8 for coverage; Stryker for mutation testing
**Target Platform**: Node.js ≥ 24.0.0, local/LAN browser access (loopback-only by default)
**Project Type**: Gateway service extension (`apps/web-gateway/`) + daemon amendment (`lib/daemon/`)
**Performance Goals**: Stream events visible to browser within 500ms of daemon production (SC-002); reconnect replay completes in < 2 seconds for up to 1000 buffered events
**Constraints**: No new runtime dependencies beyond `ws`; gateway must not become a second source of truth for conversation state; all existing auth/session/security primitives reused without modification (the WS notification bridge that wires them into WebSocket frames is new scope in this slice); daemon amendment is minimal (event emitter + sequence numbering already exists)
**Scale/Scope**: Single operator, multiple browser tabs; conversations up to thousands of turns; event buffer sized for brief disconnections (not permanent storage)

## Project Structure

### Documentation (this feature)

```text
.sdd/web-gateway-conversation-transport-hasrhxi6/
├── spec.md                              # Feature specification
├── plan.md                              # This file
├── research.md                          # Technical decisions and rationale
├── data-model.md                        # Gateway transport entities
├── checklists/
│   └── requirements.md                  # Specification quality checklist
└── tasks.md                             # Generated by /sdd.tasks
```

### Source Code (repository layout)

New code lives in `apps/web-gateway/src/` (gateway transport), `lib/daemon/` (event bridge amendment), and their corresponding test directories. Existing modules are reused without modification.

```text
apps/web-gateway/
├── package.json                          # + ws dependency
└── src/
    ├── index.ts                          # Extended: conversation routes + WS upgrade
    ├── conversation/                     # NEW — gateway conversation mediation module
    │   ├── daemon-client.ts              # HTTP client for daemon conversation endpoints
    │   ├── conversation-routes.ts        # REST route handlers mediating to daemon
    │   ├── request-validator.ts          # Zod-based request validation middleware
    │   └── response-translator.ts        # Daemon → gateway error translation
    ├── transport/                        # NEW — WebSocket transport module
    │   ├── ws-server.ts                  # WebSocket server setup, upgrade handler
    │   ├── ws-connection.ts              # Per-connection state, session binding, lifecycle
    │   ├── ws-message-handler.ts         # Inbound WS message validation and dispatch
    │   ├── connection-registry.ts        # sessionId → connections, conversationId → connections
    │   ├── event-forwarder.ts            # Daemon events → WebSocket frames
    │   ├── event-buffer.ts              # Bounded ring buffer for reconnect/resume
    │   └── ws-protocol.ts               # WS message type definitions (subscribe, ack, error)
    ├── shared/
    │   ├── errors.ts                     # Extended: conversation + transport error codes
    │   ├── types.ts                      # Extended: new context variables
    │   └── gateway-error-response.ts     # NEW — structured error shape (FR-026)
    └── __tests__/
        ├── conversation-routes.test.ts   # REST mediation tests
        ├── daemon-client.test.ts         # Daemon HTTP client tests
        ├── request-validator.test.ts     # Validation tests
        ├── ws-connection.test.ts         # WebSocket lifecycle + session binding tests
        ├── ws-message-handler.test.ts    # Inbound message validation tests
        ├── connection-registry.test.ts   # Registry mapping tests
        ├── event-forwarder.test.ts       # Event forwarding tests
        ├── event-buffer.test.ts          # Ring buffer tests
        ├── response-translator.test.ts   # Error translation tests
        └── transport-integration.test.ts # End-to-end transport tests

lib/daemon/
├── stream-manager.ts                     # AMENDED: add EventEmitter for push notifications
└── event-bridge.ts                       # NEW — EventEmitter wrapper for gateway subscription

test/
└── event-bridge.test.ts                  # Daemon event bridge tests
```

**Structure Decisions**:

- `conversation/` and `transport/` are physically separate modules — REST mediation vs. WebSocket streaming are different concerns with different security, lifecycle, and testing needs.
- `daemon-client.ts` is the sole point of daemon communication for conversation operations — no route handler calls `fetch()` directly.
- `event-bridge.ts` lives in `lib/daemon/` because it is a daemon-side amendment (emitter attached to `StreamManager`). The gateway consumes it through the `EventEmitter` interface.
- No new files in `packages/web-contracts/` — gateway error shape is gateway-internal (FR-026 explicitly states shared contract is a follow-on). Existing conversation schemas are consumed as-is.

## Research Findings

See [research.md](./research.md) for full analysis. Key decisions summarized below.

### Decision 1: Daemon Event Bridge via Node.js EventEmitter

- **Chosen**: Attach a typed `EventEmitter` to the daemon's `StreamManager`. When `StreamManager.emitEvent()`, `completeStream()`, `failStream()`, or `cancelStream()` produce a `StreamEvent`, the bridge emits the event on a `conversationId`-keyed channel. The gateway subscribes to conversations it has active WebSocket clients for.
- **Rationale**: The daemon and gateway run in the same Node.js process (single-process local deployment model). An in-process EventEmitter is the simplest zero-dependency push mechanism, avoids the overhead of SSE/HTTP long-polling between co-located components, and already aligns with the daemon's synchronous event production model. The `StreamManager` already has all stream events with sequence numbers — the bridge just publishes what it already produces.
- **Alternatives rejected**: (a) Internal SSE endpoint — adds HTTP overhead for in-process communication; would be correct for multi-process deployment but Hydra is single-process. (b) Redis pub/sub — violates the no-external-dependency constraint. (c) Polling from gateway to daemon stream endpoint — current model; too slow for 500ms latency target and wastes CPU.

### Decision 2: WebSocket Library — `ws` (Not Hono/ws)

- **Chosen**: Use the `ws` npm package for the WebSocket server, attached to the Node.js `http.Server` via the `upgrade` event. Hono handles all REST routes; `ws` handles WebSocket upgrades on a dedicated path.
- **Rationale**: Hono's built-in `hono/ws` helper targets Cloudflare Workers and Deno — it does not support Node.js `http.Server` upgrade flow. The `ws` package is the de facto standard for Node.js WebSocket servers (0 native dependencies, stable, well-tested). Splitting upgrade handling from REST routing is clean: Hono never sees WebSocket frames, `ws` never sees REST requests.
- **Alternatives rejected**: (a) `hono/ws` — does not support Node.js `http.Server`. (b) `socket.io` — adds unnecessary abstraction (fallback transports, rooms, namespaces) that conflicts with explicit control over connection lifecycle. (c) `uWebSockets.js` — native addon; violates minimalism constraint.

### Decision 3: Gateway-Side Ring Buffer for Reconnect/Resume

- **Chosen**: The gateway maintains a bounded, per-conversation ring buffer of recent `StreamEvent`s. On reconnect, the browser sends `lastAcknowledgedSeq` via the `subscribe` message and the gateway replays events from the buffer. If the requested sequence is older than the buffer's oldest event, the gateway falls back to the daemon's per-turn replay endpoint (`GET /conversations/:convId/turns/:turnId/stream?lastAcknowledgedSeq=N`) for each active/recent turn in the conversation, since the daemon's replay surface is turn-scoped (`getStreamEventsSince(turnId, fromSeq)`), not conversation-scoped.
- **Rationale**: Brief disconnections (network blip, page transition) need sub-second replay from gateway memory. The daemon supports `getStreamEventsSince(turnId, fromSeq)` for longer gaps but requires a turn ID — there is no conversation-level replay endpoint. The gateway buffer abstracts this mismatch: the buffer is conversation-scoped for simplicity, and the per-turn decomposition only occurs on the rare buffer-miss fallback path. A ring buffer is O(1) insertion, O(n) replay, bounded memory, and trivially testable. Buffer size is configurable; default 1000 events per conversation.
- **Alternatives rejected**: (a) Daemon-only replay — correct but adds HTTP round-trip latency for every reconnect, even brief ones. (b) Unbounded buffer — memory risk. (c) Client-side replay from REST — too slow for live streaming resume.

### Decision 4: Connection Registry — Session and Conversation Indexing

- **Chosen**: A `ConnectionRegistry` maintains two indices: `sessionId → Set<Connection>` (for session lifecycle events — expiry, logout) and `conversationId → Set<Connection>` (for stream event forwarding). A connection joins a conversation by sending a `subscribe` message over WebSocket; it leaves on `unsubscribe` or disconnect.
- **Rationale**: Session binding (FR-014/FR-015) requires finding all connections for a session. Stream forwarding (FR-010) requires finding all connections subscribed to a conversation. Two indices serve both needs without scanning all connections. The `SessionStateBroadcaster` already does `sessionId → callbacks`; the `ConnectionRegistry` extends this pattern to also track conversation subscriptions.
- **Alternatives rejected**: (a) Single flat list with linear scan — O(n) on every event forward. (b) Reuse `SessionStateBroadcaster` directly — its callback shape doesn't carry conversation subscription state.

### Decision 5: REST-Only Commands, WebSocket Server→Client Streaming + Lightweight Client Messages

- **Chosen**: Conversation commands (create, submit instruction, approve, cancel, retry) flow through REST endpoints only. The WebSocket carries server→client stream events plus three lightweight client→server messages: `subscribe` (join a conversation's event stream), `unsubscribe` (leave), and `ack` (acknowledge a sequence number). No conversation mutations over WebSocket.
- **Rationale**: The spec explicitly deferred bidirectional command transport (FR-012 removed). REST commands reuse all existing session/CSRF/rate-limit middleware without duplication. The three client→server WebSocket messages are stateless control frames, not mutations — they don't need CSRF protection.
- **Alternatives rejected**: Full bidirectional WebSocket — spec explicitly defers this to a later slice.

### Decision 6: Gateway Error Response Shape — Gateway-Internal, Five Categories

- **Chosen**: Define a `GatewayErrorResponse` type in `apps/web-gateway/src/shared/gateway-error-response.ts` with fields: `{ ok: false, code: string, category: ErrorCategory, message: string, conversationId?: string, turnId?: string, retryAfterMs?: number }`. The `category` field is one of: `'auth'`, `'session'`, `'validation'`, `'daemon'`, `'rate-limit'`. This shape is used for both REST JSON error bodies and WebSocket error frames.
- **Rationale**: FR-026 requires a gateway-level error shape; FR-027 requires five distinguishable categories. The spec explicitly states a shared cross-layer contract in `packages/web-contracts` is a follow-on. Extending the existing `GatewayError` class (which already has `code` and `statusCode`) with a `category` field is additive and backward-compatible.
- **Alternatives rejected**: (a) Reuse `@hydra/web-contracts` `ErrorResponse` directly — that type is for daemon conversation errors (NOT_FOUND, STALE_APPROVAL, etc.) and doesn't cover auth/session/rate-limit categories. (b) Numeric HTTP status codes as the only category signal — browsers can't distinguish 401 (auth) from 401 (session expired) without a body category.

## Data Model

### Gateway Transport Entities

| Entity                   | Description                                                                               | Key Attributes                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebSocketConnection**  | A single WebSocket channel between one browser tab and the gateway. Bound to one session. | `connectionId`, `sessionId`, `ws` (WebSocket instance), `subscribedConversations: Set<string>`, `lastAckSeq: Map<conversationId, number>`, `connectedAt`, `state` ('open' \| 'closing' \| 'closed'), `replayState: Map<conversationId, 'live' \| 'replaying'>`, `pendingEvents: Map<conversationId, StreamEvent[]>` |
| **ConnectionRegistry**   | Indexes connections by session and by conversation for efficient lookup.                  | `bySession: Map<sessionId, Set<Connection>>`, `byConversation: Map<conversationId, Set<Connection>>`                                                                                                                                                                                                                |
| **EventBuffer**          | Bounded per-conversation ring buffer of recent StreamEvents for reconnect replay.         | `conversationId`, `buffer: StreamEvent[]`, `capacity` (default 1000), `oldestSeq`, `newestSeq`                                                                                                                                                                                                                      |
| **GatewayErrorResponse** | Structured error shape for all gateway error responses (REST and WebSocket).              | `ok: false`, `code: string`, `category: ErrorCategory`, `message: string`, `conversationId?`, `turnId?`, `retryAfterMs?`                                                                                                                                                                                            |
| **DaemonEventBridge**    | EventEmitter wrapper on the daemon's StreamManager for push event delivery.               | Emits `stream-event` with `{ conversationId, event: StreamEvent }`                                                                                                                                                                                                                                                  |

### WebSocket Protocol Messages (Client → Server)

| Message Type  | Fields                                                                        | Purpose                                                                                                      |
| ------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `subscribe`   | `{ type: 'subscribe', conversationId: string, lastAcknowledgedSeq?: number }` | Join (or rejoin) a conversation's event stream; include `lastAcknowledgedSeq` on reconnect to trigger replay |
| `unsubscribe` | `{ type: 'unsubscribe', conversationId: string }`                             | Leave a conversation's event stream                                                                          |
| `ack`         | `{ type: 'ack', conversationId: string, seq: number }`                        | Acknowledge receipt up to sequence number                                                                    |

### WebSocket Protocol Messages (Server → Client)

| Message Type            | Fields                                                                 | Purpose                                                     |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `stream-event`          | `{ type: 'stream-event', conversationId: string, event: StreamEvent }` | Forwarded daemon stream event                               |
| `subscribed`            | `{ type: 'subscribed', conversationId: string, currentSeq: number }`   | Confirm subscription                                        |
| `unsubscribed`          | `{ type: 'unsubscribed', conversationId: string }`                     | Confirm unsubscription                                      |
| `session-terminated`    | `{ type: 'session-terminated', reason: string }`                       | Session expired/invalidated/logged-out                      |
| `session-expiring-soon` | `{ type: 'session-expiring-soon', expiresAt: string }`                 | Session about to expire                                     |
| `daemon-unavailable`    | `{ type: 'daemon-unavailable' }`                                       | Daemon unreachable                                          |
| `daemon-restored`       | `{ type: 'daemon-restored' }`                                          | Daemon reachable again                                      |
| `error`                 | `GatewayErrorResponse` with `type: 'error'`                            | Structured error (malformed message, buffer overflow, etc.) |

### Validation Rules

- WebSocket upgrade requests MUST carry a valid `__session` cookie and a valid `Origin` header — reuse existing gateway middleware logic.
- All REST conversation requests MUST pass Zod schema validation against `@hydra/web-contracts` before forwarding to the daemon.
- Client→server WebSocket messages MUST conform to the message schema; malformed messages produce a `type: 'error'` response without closing the connection (FR-013).
- The event buffer MUST NOT grow beyond its configured capacity; oldest events are evicted on overflow.
- A connection MUST NOT receive events for conversations it has not subscribed to.
- On session termination, ALL connections for that session MUST be closed within 5 seconds (SC-005).

## Interface Contracts

### Gateway REST Conversation Routes

All routes require authenticated session (`createAuthMiddleware`) and CSRF protection (`createCsrfMiddleware`). Request bodies are validated with Zod schemas from `@hydra/web-contracts`. Error responses use `GatewayErrorResponse` shape.

| Route                                         | Method | Request Schema                                | Response Schema                        | Daemon Endpoint                                    |
| --------------------------------------------- | ------ | --------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `/conversations`                              | POST   | `CreateConversationRequest`                   | `CreateConversationResponse`           | `POST /conversations`                              |
| `/conversations`                              | GET    | `ListConversationsRequest` (query)            | `ListConversationsResponse`            | `GET /conversations`                               |
| `/conversations/:id`                          | GET    | `OpenConversationRequest` (param)             | `OpenConversationResponse`             | `GET /conversations/:id`                           |
| `/conversations/:id/resume`                   | POST   | `ResumeConversationRequest`                   | `ResumeConversationResponse`           | `POST /conversations/:id/resume`                   |
| `/conversations/:id/archive`                  | POST   | `ArchiveConversationRequest` (param)          | `ArchiveConversationResponse`          | `POST /conversations/:id/archive`                  |
| `/conversations/:convId/turns`                | POST   | `SubmitInstructionRequest`                    | `SubmitInstructionResponse`            | `POST /conversations/:convId/turns`                |
| `/conversations/:convId/turns`                | GET    | `LoadTurnHistoryRequest` (query)              | `LoadTurnHistoryResponse`              | `GET /conversations/:convId/turns`                 |
| `/conversations/:convId/approvals`            | GET    | `GetPendingApprovalsRequest` (param)          | `GetPendingApprovalsResponse`          | `GET /conversations/:convId/approvals`             |
| `/approvals/:approvalId/respond`              | POST   | `RespondToApprovalRequest`                    | `RespondToApprovalResponse`            | `POST /approvals/:approvalId/respond`              |
| `/conversations/:convId/turns/:turnId/cancel` | POST   | `CancelWorkRequest` (params)                  | `CancelWorkResponse`                   | `POST /conversations/:convId/turns/:turnId/cancel` |
| `/conversations/:convId/turns/:turnId/retry`  | POST   | `RetryTurnRequest` (params)                   | `RetryTurnResponse`                    | `POST /conversations/:convId/turns/:turnId/retry`  |
| `/turns/:turnId/artifacts`                    | GET    | `ListArtifactsForTurnRequest` (param)         | `ListArtifactsForTurnResponse`         | `GET /turns/:turnId/artifacts`                     |
| `/conversations/:convId/artifacts`            | GET    | `ListArtifactsForConversationRequest` (query) | `ListArtifactsForConversationResponse` | `GET /conversations/:convId/artifacts`             |
| `/artifacts/:artifactId`                      | GET    | `GetArtifactContentRequest` (param)           | `GetArtifactContentResponse`           | `GET /artifacts/:artifactId`                       |
| `/turns/:turnId/activities`                   | GET    | (param)                                       | Activity entries                       | `GET /turns/:turnId/activities`                    |

### WebSocket Endpoint

| Endpoint | Upgrade Path             | Auth                                                     | Notes                                         |
| -------- | ------------------------ | -------------------------------------------------------- | --------------------------------------------- |
| `/ws`    | HTTP → WebSocket upgrade | Session cookie + Origin header validated at upgrade time | No CSRF needed (Origin check suffices for WS) |

### Daemon Event Bridge Interface

| Method                                        | Signature                                                                 | Notes                         |
| --------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------- |
| `on('stream-event', handler)`                 | `handler: (data: { conversationId: string, event: StreamEvent }) => void` | Gateway subscribes at startup |
| `getBufferedEvents(conversationId, sinceSeq)` | Returns `StreamEvent[]` from gateway ring buffer                          | For reconnect replay          |

## Implementation Phases

### Phase 0: Gateway Error Response Shape and Daemon Client Foundation

Establish the two foundational pieces everything else depends on: the structured gateway error shape (FR-026/FR-027) and the HTTP client for daemon communication. Both are pure-function/thin-class modules with no external dependencies beyond existing code.

**Tasks**:

1. **TDD: `GatewayErrorResponse` type and `ErrorCategory`** — define the five-category error shape. Write tests asserting category discrimination. Extend existing `ErrorCode` union with conversation-specific codes (`CONVERSATION_NOT_FOUND`, `TURN_NOT_FOUND`, `VALIDATION_FAILED`). Implement `gateway-error-response.ts`.
2. **TDD: `response-translator.ts`** — translate daemon HTTP responses (status codes, `ErrorResponse` bodies from `@hydra/web-contracts`) into `GatewayErrorResponse`. Write tests for every daemon error code mapping. Handle daemon-unreachable (fetch failure) → `{ category: 'daemon' }`.
3. **TDD: `daemon-client.ts`** — typed HTTP client wrapping `fetch()` for all 19 daemon conversation endpoints. Each method accepts validated request params, calls the daemon, and returns parsed response or translated error. Write tests with stubbed fetch. Include timeout handling (5 second default, configurable).

**Validates**: FR-026, FR-027, FR-028 | **Measures**: SC-007, SC-008

### Phase 1: Daemon Event Bridge (Daemon Amendment)

Add the push mechanism the gateway needs to receive stream events in real time, without modifying the daemon's existing API contract or breaking any existing tests.

**Tasks**:

1. **TDD: `event-bridge.ts`** — typed EventEmitter wrapper. Write tests asserting: events are emitted with `{ conversationId, event }` shape, multiple listeners receive the same event, unsubscription stops delivery, no event leaks after cleanup.
2. **Amend `StreamManager`** — inject the event bridge. In `emitEvent()`, `completeStream()`, `failStream()`, `cancelStream()`: after pushing to the stream's event array, emit through the bridge. Write tests asserting bridge emission for each terminal and non-terminal event type.
3. **Verify no regressions** — run full daemon test suite (`test/conversation-routes.test.ts`, `test/conversation-store.test.ts`, `test/conversation-executor.test.ts`, `test/conversation-protocol.integration.test.ts`). The event bridge is additive; zero existing tests should break.

**Validates**: FR-020, SC-012 | **Measures**: SC-002 (latency foundation)

### Phase 2: Request Validation and Gateway REST Conversation Routes

Build the REST mediation layer. Every route follows the same pattern: authenticate → validate → mediate → translate → respond. This phase delivers User Story 1 (P1).

**Tasks**:

1. **TDD: `request-validator.ts`** — middleware that runs Zod `.safeParse()` on request bodies/query params against the appropriate `@hydra/web-contracts` schema. Returns `GatewayErrorResponse` with `category: 'validation'` on failure. Write tests for valid and invalid payloads for each contract.
2. **TDD: Conversation lifecycle routes** — `POST /conversations`, `GET /conversations`, `GET /conversations/:id`, `POST /conversations/:id/resume`, `POST /conversations/:id/archive`. Each test creates a gateway app (reusing `createGatewayApp` pattern), sends requests with/without valid sessions, asserts correct daemon mediation and response shapes.
3. **TDD: Turn routes** — `POST /conversations/:convId/turns`, `GET /conversations/:convId/turns`. Tests assert instruction submission mediates to daemon, turn history returns paginated results.
4. **TDD: Approval routes** — `GET /conversations/:convId/approvals`, `POST /approvals/:approvalId/respond`. Tests assert session-to-operator mapping, approval response forwarding with `X-Session-Id` header.
5. **TDD: Work control routes** — `POST .../cancel`, `POST .../retry`. Tests assert mediation and correct daemon endpoint targeting.
6. **TDD: Artifact and activity routes** — `GET /turns/:turnId/artifacts`, `GET /conversations/:convId/artifacts`, `GET /artifacts/:artifactId`, `GET /turns/:turnId/activities`. Tests assert correct path mapping and response forwarding.
7. **Wire routes into `createGatewayApp`** — add `conversation/` routes under a protected sub-router with `createAuthMiddleware` + `createCsrfMiddleware` (same pattern as `/session` routes). Run `npm run quality` and full test suite.

**Validates**: FR-001, FR-002, FR-003 (REST mediation), FR-004, FR-005, FR-006, FR-007, FR-017, FR-018, FR-019 | **Measures**: SC-001 (REST path), SC-004, SC-008, SC-011

### Phase 3: WebSocket Server, Session Binding, and Connection Registry

Establish the WebSocket infrastructure with full session security. This phase delivers User Story 3 (P1 — session binding) and the foundation for User Story 2 (streaming). It also builds the **WS notification bridge** — new plumbing that wires the existing `SessionStateBroadcaster` and `DaemonHeartbeat` primitives (owned by `web-session-auth`) into WebSocket protocol messages. The primitives themselves are not modified; the bridge that translates their callbacks into WS frames is new scope in this slice.

**Tasks**:

1. **TDD: `ws-protocol.ts`** — define Zod schemas for all client→server and server→client WebSocket message types. Write round-trip parse/serialize tests.
2. **TDD: `connection-registry.ts`** — `register(connectionId, sessionId, ws)`, `unregister(connectionId)`, `getBySession(sessionId)`, `getByConversation(conversationId)`, `addSubscription(connectionId, conversationId)`, `removeSubscription(connectionId, conversationId)`. Write tests for indexing correctness, cleanup on disconnect, multi-tab scenarios (multiple connections per session).
3. **TDD: `ws-connection.ts`** — per-connection lifecycle: creation (binds sessionId from upgrade request), message dispatch, close handling, error handling. Write tests for session binding immutability, graceful close, and state transitions.
4. **TDD: `ws-server.ts`** — `ws.Server` setup, attached to Node.js `http.Server` via `upgrade` event. Upgrade handler: parse cookies from upgrade request, validate `__session` cookie against `SessionService.validate()`, validate Origin header against `allowedOrigin`, reject with 401/403 if invalid. Write tests for: valid session → connection established, expired session → 401 reject, missing session → 401 reject, wrong origin → 403 reject, no session cookie → 401 reject.
5. **TDD: Session & daemon lifecycle → WS bridge** — new plumbing wiring `SessionStateBroadcaster` and `DaemonHeartbeat` into WS connection lifecycle. Register a `SessionStateBroadcaster` callback per connected session that translates session state-change events into WS protocol messages. Verify the end-to-end chain: `DaemonHeartbeat.tick()` → `SessionService` state transition → `SessionStateBroadcaster.broadcast()` → WS callback → send WS message. If any link in this chain is missing (e.g., `SessionService` does not call the broadcaster on daemon-state transitions), add the missing bridge here. Map terminal states (`expired`, `invalidated`, `logged-out`) → `session-terminated` + `closeAllForSession()`; `expiring-soon` → `session-expiring-soon`; `daemon-unreachable` → `daemon-unavailable`; recovery → `daemon-restored`. Write tests asserting termination timing (≤ 5 seconds per SC-005) and daemon-unavailable/restored delivery to all open connections.
6. **Wire into gateway app** — extend `createGatewayApp` to accept `server: http.Server` parameter, attach WebSocket server. Export the connection registry for test access.

**Validates**: FR-008, FR-009, FR-013, FR-014, FR-015, FR-016, FR-021, SC-005, SC-006 | **Measures**: SC-004, SC-005, SC-006, SC-010, SC-011

### Phase 4: Stream Event Forwarding (Daemon → Gateway → Browser)

Wire the daemon event bridge to the WebSocket connections. This phase delivers User Story 2 (P1 — streaming). It also introduces the **replay barrier** — a per-conversation `replayState` map (`Map<conversationId, 'live' | 'replaying'>`) and matching per-conversation `pendingEvents` queues on `WebSocketConnection` (see Data Model). The replay barrier ensures zero-gap, zero-duplicate ordering during reconnect: while a conversation's entry is `'replaying'`, the event forwarder queues arriving live events for that conversation instead of sending them (events for other conversations on the same connection flow normally); after replay completes, the per-conversation pending queue is flushed (deduplicated by `seq`) and the entry transitions to `'live'`.

**Tasks**:

1. **TDD: `event-buffer.ts`** — bounded ring buffer keyed by conversationId. `push(conversationId, event)`: append; evict oldest if over capacity. `getEventsSince(conversationId, seq)`: return events with `seq > sinceSeq` in order. `getHighwaterSeq(conversationId)`: return newest seq. Write tests for: insertion, eviction at boundary, retrieval correctness, empty buffer, seq-based filtering, gap-free ordering guarantee. _(Introduced here because the event forwarder pushes to the buffer on every event, and the `subscribe` handler reads from it to populate `currentSeq` and serve buffer-hit replays.)_
2. **TDD: `ws-message-handler.ts`** — handle `subscribe`, `unsubscribe`, and `ack` messages from the browser. On `subscribe`: validate conversationId exists on the daemon (mediate an existence check via daemon-client; per-operator ownership enforcement is deferred to a multi-operator slice since the current daemon `ConversationStore` and conversation contracts have no owner/operator field). If the client includes `lastAcknowledgedSeq` and the buffer covers the range, set `replayState.set(conversationId, 'replaying')` and send buffered events; on completion, flush `pendingEvents.get(conversationId)`, set `replayState.set(conversationId, 'live')`, and resume normal forwarding (buffer-miss fallback to the daemon's per-turn replay is handled in Phase 5). On `unsubscribe`: remove from registry, delete `replayState` and `pendingEvents` entries for the conversation, respond with `unsubscribed`. On `ack`: update connection's `lastAckSeq` for the conversation. On invalid message: respond with `type: 'error'` without closing connection (FR-013). Write tests for each flow including malformed messages, reconnect-with-seq, concurrent live event arrival during replay (assert events are held back, then flushed in order), **and simultaneous replay on conversation A while conversation B remains live on the same connection (assert B events are not blocked)**.
3. **TDD: `event-forwarder.ts`** — subscribe to daemon event bridge `stream-event` emissions. For each event: (a) push to `EventBuffer` for the conversation, (b) look up connections subscribed to the event's `conversationId` via `ConnectionRegistry.getByConversation()`, (c) check each connection's per-conversation `replayState`: if `replayState.get(conversationId)` is `'replaying'`, append the event to `pendingEvents.get(conversationId)`; if `'live'` (or no entry), serialize as a `stream-event` WebSocket message and send immediately. Write tests asserting: single subscriber receives event, multiple subscribers all receive the same event, unsubscribed connections don't receive, event payload matches daemon StreamEvent, buffer is populated, a conversation in `replaying` state does NOT receive live events until replay completes, **and a connection replaying conversation A still receives live events for conversation B without delay**.
4. **TDD: Multi-tab forwarding** — write tests asserting that multiple connections (different tabs, same session) both receive the same stream events when subscribed to the same conversation (edge case from spec).
5. **TDD: Buffer overflow handling** — when a connection's send buffer backs up (slow client), the gateway must close the connection with a structured error so the browser can reconnect (spec edge case). Write tests with artificial backpressure.
6. **Integration test: end-to-end streaming** — create gateway app with daemon + event bridge, authenticate, open WebSocket, subscribe to conversation, submit instruction via REST, assert stream events arrive through WebSocket as daemon produces them.

**Validates**: FR-010, FR-011, FR-020, FR-022 (buffer-hit path) | **Measures**: SC-001 (full path), SC-002, SC-003 (buffer-hit), SC-010, SC-012

### Phase 5: Reconnect/Resume — Daemon Fallback and Ordering Guarantees

Complete the reconnect protocol by adding the daemon fallback path for buffer misses. The event buffer and buffer-hit replay are introduced in Phase 4; this phase adds the per-turn daemon fallback logic, replay ordering guarantees, and end-to-end reconnect scenarios. This phase delivers User Story 4 (P2).

**Tasks**:

1. **TDD: Daemon fallback replay** — when a `subscribe` with `lastAcknowledgedSeq` arrives and the gateway buffer cannot cover the range (requested seq < buffer's `oldestSeq`), fall back to the daemon's per-turn replay endpoint. The gateway must: (a) identify active/recent turns for the conversation (via `daemon-client` list-turns call), (b) call `GET /conversations/:convId/turns/:turnId/stream?lastAcknowledgedSeq=N` for each turn whose events may fall in the missed range, (c) merge and deduplicate the per-turn results into a single ordered replay stream keyed by `seq`, (d) forward the replayed events to the client, then resume live forwarding. Write tests for the fallback path including multi-turn conversations and conversations where some turns have no missed events. _(The daemon's replay surface is turn-scoped — `getStreamEventsSince(turnId, fromSeq)` — so the gateway must decompose conversation-scoped replay into per-turn calls.)_
2. **TDD: Reconnect flow (end-to-end)** — when a browser reconnects (new WebSocket, sends `subscribe` with `lastAcknowledgedSeq`), the gateway: (a) validates session (rejects if expired/invalidated — FR-025), (b) checks buffer for events since `lastAcknowledgedSeq`, (c) if buffer covers the range, replays from buffer (Phase 4 subscribe handler), (d) if buffer doesn't cover, invokes daemon per-turn fallback (task 1 above), (e) after replay, resumes live forwarding. Write tests for each path.
3. **TDD: Replay ordering guarantees** — write tests asserting FR-024: replayed events preserve original ordering and sequence numbers, no reordering, no gaps, no duplicates. Include tests where events arrive during the replay window and where the daemon fallback merges events from multiple turns.
4. **TDD: Reconnect with invalid session** — reconnect attempt with expired/invalidated session is rejected before any events are replayed (FR-025). Write negative tests.
5. **TDD: Page refresh scenario** — simulate: establish connection, receive events, close connection (simulating page unload), create new connection with same session, subscribe with last seq, assert replay + live resume.

**Validates**: FR-022, FR-023, FR-024, FR-025 | **Measures**: SC-003, SC-004

### Phase 6: Approval, Work Control, and Artifact Mediation via REST + WebSocket Events

Ensure control operations mediated through REST produce the expected WebSocket events. This phase delivers User Story 5 (P2).

**Tasks**:

1. **TDD: Approval round-trip** — submit instruction that triggers approval (daemon executor), assert `approval-prompt` event arrives through WebSocket, submit approval response via REST `POST /approvals/:id/respond`, assert `approval-response` event arrives through WebSocket and daemon resumes work.
2. **TDD: Cancel round-trip** — submit instruction, start receiving stream events, send `POST .../cancel` via REST, assert `cancellation` event arrives through WebSocket and stream stops.
3. **TDD: Retry round-trip** — fail a turn, send `POST .../retry` via REST, assert new stream starts and events flow through WebSocket.
4. **TDD: Artifact notice forwarding** — daemon emits `artifact-notice` stream event during work, assert it arrives through WebSocket with correct payload.

**Validates**: FR-003, FR-004, FR-010 (approval/control events) | **Measures**: SC-001 (complete lifecycle)

### Phase 7: Error Boundaries and Edge Cases

Systematically verify every error category and edge case from the spec. This phase delivers User Story 6 (P2).

**Tasks**:

1. **TDD: Daemon unavailable — REST** — stub daemon as unreachable, send conversation request, assert `GatewayErrorResponse` with `category: 'daemon'` and correct HTTP status 503 (SC-007).
2. **TDD: Daemon unavailable — WebSocket** — establish WebSocket, trigger daemon heartbeat failure, assert `daemon-unavailable` event through WebSocket, connection stays open for grace period, assert `daemon-restored` when heartbeat recovers.
3. **TDD: Validation errors** — send malformed requests to each REST route, assert `GatewayErrorResponse` with `category: 'validation'` and HTTP 400.
4. **TDD: Rate limit errors** — exceed mutating rate limit, assert `GatewayErrorResponse` with `category: 'rate-limit'` and HTTP 429, `retryAfterMs` present.
5. **TDD: Auth/session errors on REST** — send requests without session, with expired session, assert `GatewayErrorResponse` with `category: 'auth'` or `category: 'session'`.
6. **TDD: Malformed WebSocket messages** — send invalid JSON, unknown message types, missing fields through WebSocket, assert structured error response without connection termination (SC-010).
7. **TDD: Multi-tab edge case** — two tabs connected to same conversation, one submits instruction, both receive events.
8. **TDD: Idle WebSocket connection** — connection established but no conversations subscribed, assert connection stays alive and valid.
9. **TDD: Conversation not found on subscribe** — attempt to subscribe to a non-existent conversationId, assert `CONVERSATION_NOT_FOUND` error without leaking daemon internals. _(Per-operator ownership enforcement is deferred to a multi-operator slice; the current daemon `ConversationStore` and conversation contracts have no owner/operator field. The spec edge case "conversation the operator does not own" is addressed by this deferral.)_
10. **TDD: Gateway restart** — all connections lost; browser treats as disconnection and uses reconnect flow (test documents this contract, doesn't prevent it).

**Validates**: FR-021, FR-026, FR-027, FR-028 | **Measures**: SC-004, SC-007, SC-008, SC-010

### Phase 8: Integration Tests, Quality Gates, and Documentation

End-to-end verification of all success criteria and final documentation.

**Tasks**:

1. **End-to-end transport test** — single test exercising the full User Story 1 path: authenticate → create conversation → submit instruction → receive stream events through WebSocket → load turn history via REST → verify zero direct daemon communication from browser.
2. **Latency measurement test** — verify SC-002: stream events visible to browser within 500ms of daemon production under loopback conditions.
3. **Disconnect-resume stress test** — verify SC-003: disconnect at random points during streaming, reconnect with last ack seq, assert 100% event replay with zero gaps/duplicates.
4. **Session-bypass comprehensive test** — verify SC-004: every REST route and every WebSocket message type rejects unauthenticated access.
5. **Run `npm run quality`** — verify SC-011: ESLint, TypeScript strict, coverage thresholds all pass.
6. **Run full test suite** — `npm test` from monorepo root. Zero regressions.
7. **Update documentation** — document WebSocket protocol in `docs/web-interface/`, update architecture docs with transport layer, add gateway configuration documentation for buffer sizes/timeouts.
8. **Generate tasks** — run `/sdd.tasks` to produce `tasks.md` for implementation tracking.

**Validates**: SC-001 through SC-012 | **Measures**: All success criteria

## Risk Mitigation

| Risk                                                          | Mitigation                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws` library adds a new dependency                            | `ws` is zero-dependency, well-maintained, and the Node.js ecosystem standard. Lock version in package.json.                                                                                                                                     |
| Event bridge adds coupling between daemon and gateway         | Bridge is a typed EventEmitter interface — gateway depends on the event shape, not the StreamManager implementation. Bridge can be replaced with IPC/HTTP for future multi-process deployment.                                                  |
| Ring buffer memory growth                                     | Bounded by configuration (default 1000 events per conversation). Conversations are evicted from buffer when no connections are subscribed. Buffer size is configurable without code changes.                                                    |
| WebSocket connections surviving session expiry                | SessionStateBroadcaster callback fires on every session state change. Integration tests verify ≤ 5 second termination. Belt-and-suspenders: periodic connection audit sweeps (every 30 seconds) close any connection whose session is terminal. |
| Daemon stream events produced faster than browser can consume | Per-connection send buffer monitoring. If backpressure exceeds threshold, close connection with structured error; browser reconnects and resumes via replay.                                                                                    |
| Hono upgrade handling conflicts with `ws`                     | WebSocket upgrade is handled at the `http.Server` level before Hono sees the request. No conflict — they operate on different protocol paths.                                                                                                   |
| Existing daemon tests break from StreamManager amendment      | Event bridge injection is optional (defaults to no-op emitter). Existing tests that don't inject a bridge are unaffected. New tests verify bridge behavior.                                                                                     |
| Browser sends commands over WebSocket (spec drift)            | `ws-message-handler.ts` explicitly rejects any message type not in `{ subscribe, unsubscribe, ack }` with a structured error. This is tested.                                                                                                   |
