# Data Model: Web Gateway Conversation Transport

**Date**: 2026-03-16 | **Plan**: [plan.md](./plan.md)

## Gateway Transport Entities

These entities are gateway-internal runtime state — not persisted, not shared with the browser as contract types, and not part of the daemon's data model. They exist only while the gateway process is running.

### WebSocketConnection

Represents a single WebSocket channel between one browser tab and the gateway.

| Attribute                 | Type                                 | Description                                                                                                                                         |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionId`            | `string`                             | Unique identifier (crypto-random UUID, generated at upgrade)                                                                                        |
| `sessionId`               | `string`                             | Bound session ID (from `__session` cookie at upgrade time)                                                                                          |
| `ws`                      | `WebSocket`                          | The `ws` library WebSocket instance                                                                                                                 |
| `subscribedConversations` | `Set<string>`                        | Conversation IDs this connection is subscribed to                                                                                                   |
| `lastAckSeq`              | `Map<string, number>`                | Per-conversation last-acknowledged sequence number                                                                                                  |
| `connectedAt`             | `string`                             | ISO 8601 timestamp of connection establishment                                                                                                      |
| `state`                   | `'open' \| 'closing' \| 'closed'`    | Connection lifecycle state                                                                                                                          |
| `replayState`             | `Map<string, 'live' \| 'replaying'>` | Per-conversation replay barrier state (conversationId → state; entry created on `subscribe`, removed on `unsubscribe`; default per-entry: `'live'`) |
| `pendingEvents`           | `Map<string, StreamEvent[]>`         | Per-conversation queue of live events held during replay                                                                                            |

**Constraints**:

- `sessionId` is immutable for the connection's lifetime (FR-014)
- `state` transitions: `open → closing → closed` (no backward transitions)
- `replayState` is keyed by conversationId; each entry transitions independently: `live → replaying → live`. An entry is set to `replaying` when a `subscribe` for that conversation includes `lastAcknowledgedSeq` and replay begins; it returns to `live` after all buffered (or daemon-fetched) events are sent and the matching `pendingEvents` queue is flushed. The entry is removed when the connection unsubscribes from the conversation.
- While `replayState.get(conversationId)` is `'replaying'`, the event forwarder MUST enqueue arriving live events into `pendingEvents.get(conversationId)` rather than sending immediately; replay on one conversation does NOT block live delivery for other conversations on the same connection. On transition to `'live'`, the per-conversation pending queue is flushed in sequence order (deduplicated by `seq`, discarding any `seq ≤ lastReplayedSeq`) and then cleared
- A closed connection is removed from the registry immediately

**Relationships**:

- Belongs to exactly one session (1:1 binding, immutable)
- Subscribes to 0..N conversations (dynamic via `subscribe`/`unsubscribe`)

---

### ConnectionRegistry

Indexes WebSocket connections for efficient lookup by session and by conversation.

| Attribute        | Type                               | Description                           |
| ---------------- | ---------------------------------- | ------------------------------------- |
| `bySession`      | `Map<string, Set<string>>`         | sessionId → Set of connectionIds      |
| `byConversation` | `Map<string, Set<string>>`         | conversationId → Set of connectionIds |
| `connections`    | `Map<string, WebSocketConnection>` | connectionId → connection object      |

**Operations**:

- `register(connection)`: add to `connections` and `bySession` index
- `unregister(connectionId)`: remove from all indices and subscription maps
- `addSubscription(connectionId, conversationId)`: add to `byConversation` index
- `removeSubscription(connectionId, conversationId)`: remove from `byConversation` index
- `getBySession(sessionId)`: return all connections for a session
- `getByConversation(conversationId)`: return all connections subscribed to a conversation
- `closeAllForSession(sessionId)`: close and unregister all connections for a session

**Invariants**:

- Every connection in `bySession` or `byConversation` MUST also exist in `connections`
- Unregistering a connection cleans up ALL index entries (no dangling references)

---

### EventBuffer

Bounded per-conversation ring buffer of recent StreamEvents for reconnect replay.

| Attribute  | Type                      | Description                                     |
| ---------- | ------------------------- | ----------------------------------------------- |
| `buffers`  | `Map<string, RingBuffer>` | conversationId → ring buffer                    |
| `capacity` | `number`                  | Maximum events per conversation (default: 1000) |

**RingBuffer (internal)**:

| Attribute   | Type            | Description                               |
| ----------- | --------------- | ----------------------------------------- |
| `events`    | `StreamEvent[]` | Circular buffer array                     |
| `head`      | `number`        | Write position (wraps at capacity)        |
| `size`      | `number`        | Current event count (≤ capacity)          |
| `oldestSeq` | `number`        | Sequence number of oldest event in buffer |
| `newestSeq` | `number`        | Sequence number of newest event in buffer |

**Operations**:

- `push(conversationId, event)`: append event; evict oldest if at capacity
- `getEventsSince(conversationId, sinceSeq)`: return events with `seq > sinceSeq` in order
- `getHighwaterSeq(conversationId)`: return `newestSeq` or 0 if empty
- `hasEventsSince(conversationId, sinceSeq)`: check if buffer covers the requested range
- `evictConversation(conversationId)`: remove buffer for a conversation (when no subscribers)

**Constraints**:

- Events are stored in sequence order (monotonically increasing `seq`)
- `getEventsSince()` MUST return events in original order with no gaps or duplicates
- If `sinceSeq < oldestSeq`, the buffer cannot cover the request (caller must fall back to the daemon's per-turn replay endpoint — `getStreamEventsSince(turnId, fromSeq)` for each relevant turn — since the daemon has no conversation-level replay surface)

---

### GatewayErrorResponse

Structured error shape for all gateway error responses (REST JSON bodies and WebSocket error frames).

| Attribute        | Type              | Description                                                                              |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `ok`             | `false` (literal) | Always false for errors                                                                  |
| `code`           | `string`          | Specific error code (e.g., `SESSION_EXPIRED`, `VALIDATION_FAILED`, `DAEMON_UNREACHABLE`) |
| `category`       | `ErrorCategory`   | One of five categories for browser discrimination                                        |
| `message`        | `string`          | Human-readable error message                                                             |
| `conversationId` | `string?`         | Conversation context (when applicable)                                                   |
| `turnId`         | `string?`         | Turn context (when applicable)                                                           |
| `retryAfterMs`   | `number?`         | Retry delay hint (for rate-limit errors)                                                 |

**ErrorCategory Enum**:

| Category       | Meaning                                                   | HTTP Status                                              | Browser Action                             |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `'auth'`       | Authentication failure (invalid credentials, no session)  | 401                                                      | Redirect to login                          |
| `'session'`    | Session state conflict (concurrent edit, archived, stale) | 400 / 409 / 410 (varies by daemon response; 409 default) | Show conflict state, prompt user action    |
| `'validation'` | Request payload failed schema validation                  | 400                                                      | Fix request and retry                      |
| `'daemon'`     | Daemon is unreachable or returned an internal error       | 503                                                      | Show daemon-unavailable state, retry later |
| `'rate-limit'` | Rate limit exceeded                                       | 429                                                      | Wait `retryAfterMs`, then retry            |

**Mapping from existing GatewayError codes**:

| Existing Code         | Category     |
| --------------------- | ------------ |
| `INVALID_CREDENTIALS` | `auth`       |
| `ACCOUNT_DISABLED`    | `auth`       |
| `SESSION_EXPIRED`     | `session`    |
| `SESSION_INVALIDATED` | `session`    |
| `SESSION_NOT_FOUND`   | `auth`       |
| `SESSION_NOT_IDLE`    | `session`    |
| `IDLE_TIMEOUT`        | `session`    |
| `BAD_REQUEST`         | `validation` |
| `CSRF_INVALID`        | `validation` |
| `ORIGIN_REJECTED`     | `auth`       |
| `DAEMON_UNREACHABLE`  | `daemon`     |
| `CLOCK_UNRELIABLE`    | `daemon`     |
| `INTERNAL_ERROR`      | `daemon`     |
| `RATE_LIMITED`        | `rate-limit` |

**New codes added by this slice**:

| Code                     | Category     | When                                                                                                                          |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `CONVERSATION_NOT_FOUND` | `validation` | Daemon returns 404 for conversation                                                                                           |
| `TURN_NOT_FOUND`         | `validation` | Daemon returns 404 for turn                                                                                                   |
| `VALIDATION_FAILED`      | `validation` | Zod schema validation failure                                                                                                 |
| `WS_INVALID_MESSAGE`     | `validation` | Malformed WebSocket message                                                                                                   |
| `WS_BUFFER_OVERFLOW`     | `daemon`     | Event buffer overflow, reconnect needed                                                                                       |
| `WS_SUBSCRIBE_DENIED`    | `auth`       | Not authorized for this conversation _(reserved for multi-operator ownership enforcement; not used in single-operator slice)_ |

---

### DaemonEventBridge

EventEmitter wrapper on the daemon's StreamManager for push event delivery.

| Attribute | Type           | Description                |
| --------- | -------------- | -------------------------- |
| `emitter` | `EventEmitter` | Node.js typed EventEmitter |

**Events Emitted**:

| Event Name     | Payload                                          | When                                         |
| -------------- | ------------------------------------------------ | -------------------------------------------- |
| `stream-event` | `{ conversationId: string, event: StreamEvent }` | Any StreamEvent is produced by StreamManager |

**Lifecycle**:

- Created when the daemon initializes its StreamManager
- Gateway subscribes on startup via `bridge.on('stream-event', handler)`
- Gateway unsubscribes on shutdown via `bridge.removeAllListeners()`
- Bridge holds no state — it is a pass-through from StreamManager to subscribers

---

## Entity Relationships

```text
┌──────────────────────┐
│  DaemonEventBridge    │ ─── emits stream-event ───►┐
│  (lib/daemon/)        │                              │
└──────────────────────┘                              │
                                                       ▼
┌──────────────────────┐     ┌──────────────────────┐
│  EventBuffer          │◄────│  EventForwarder       │
│  (ring buffer/conv)   │     │  (gateway transport)  │
└──────────────────────┘     └───────┬──────────────┘
                                      │ sends to
                                      ▼
┌──────────────────────────────────────────────────┐
│  ConnectionRegistry                                │
│  ┌─────────────────┐  ┌──────────────────────┐    │
│  │ bySession index  │  │ byConversation index │    │
│  │ sessionId → conns│  │ convId → conns       │    │
│  └─────────────────┘  └──────────────────────┘    │
│            │                       │                │
│            ▼                       ▼                │
│  ┌──────────────────────────────────────────┐      │
│  │ WebSocketConnection (per browser tab)     │      │
│  │ - sessionId (immutable binding)           │      │
│  │ - subscribedConversations                 │      │
│  │ - lastAckSeq per conversation             │      │
│  └──────────────────────────────────────────┘      │
└──────────────────────────────────────────────────┘
```

## Entities NOT Introduced by This Slice

The following entities are consumed but not defined here:

- **Conversation**, **Turn**, **StreamEvent**, **ApprovalRequest**, **Artifact**, **ActivityEntry**, **Attribution** — defined by `web-conversation-protocol` in `packages/web-contracts/`
- **Session**, **Operator**, **AuditRecord** — defined by `web-session-auth` in `apps/web-gateway/src/`
- **ConversationStore**, **StreamManager** — defined by `web-conversation-protocol` in `lib/daemon/`
