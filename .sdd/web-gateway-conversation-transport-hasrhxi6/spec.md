# Feature Specification: Web Gateway Conversation Transport

**Created**: 2026-03-16
**Revised**: 2026-03-16 — tightened per GPT-5.4 review (see revision notes at end)
**Status**: Draft
**Input**: The Hydra web gateway currently terminates browser authentication and session management but exposes no conversation transport. Daemon conversation routes exist for basic lifecycle operations but do **not** yet expose a push/subscription mechanism for streaming events to external consumers, nor do shared snapshot or error-contract surfaces exist as concrete implementations. Before the browser chat workspace can be built, the gateway needs a mediation layer that (a) exposes REST endpoints mediating browser conversation requests to the daemon, (b) provides a WebSocket connection for real-time streaming from daemon to browser, (c) binds WebSocket connections to authenticated sessions, and (d) supports sequence-based reconnect/resume. This spec defines what operators and the browser need from that transport layer — without implementation details.

> **Scope note — transport slice between `web-conversation-protocol` and
> `web-chat-workspace`.** The `web-session-auth` slice delivered
> authentication and session management. The `web-conversation-protocol`
> slice defined the conversation data model, streaming events, approvals,
> artifacts, and daemon contract families. This slice fills the remaining
> gap: the browser-facing gateway transport that connects the two. Daemon
> transport amendments required by this slice (event subscription mechanism,
> sequence-numbered push) are called out as explicit work items here rather
> than assumed to already exist. The browser chat workspace UI
> (`web-chat-workspace`) is the next slice and is intentionally excluded.

## User Scenarios & Testing _(mandatory)_

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just
  ONE of them, you should still have a viable MVP that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
-->

### User Story 1 — Operator Exchanges Conversation Messages Through the Gateway (Priority: P1)

An authenticated operator's browser sends conversation operations — create, open, list, submit instruction, load history — through the gateway. The gateway validates the operator's session, enforces security constraints (CSRF, origin, rate limiting), mediates the request to the daemon's conversation endpoints, and returns the daemon's response to the browser. The operator never communicates with the daemon directly; the gateway is the sole browser-facing surface.

**Why this priority**: Without gateway conversation routes, the browser has no path to reach daemon conversation functionality. This is the minimum viable transport — everything else (streaming, reconnect, approvals) layers on top.

**Independent Test**: Authenticate a browser session, issue a create-conversation request through the gateway, submit an instruction, and load turn history. Verify that each request is mediated to the daemon and the response is returned to the browser with correct contract shapes.

**Acceptance Scenarios**:

1. **Given** an authenticated browser session, **When** the operator sends a create-conversation request through the gateway, **Then** the gateway mediates the request to the daemon, the daemon creates the conversation, and the gateway returns the conversation identity and metadata to the browser.
2. **Given** an authenticated session and an existing conversation, **When** the operator sends a submit-instruction request through the gateway, **Then** the gateway mediates the request to the daemon, the daemon acknowledges it, and the gateway returns the turn identity and stream identity to the browser.
3. **Given** an unauthenticated or expired session, **When** any conversation request arrives at the gateway, **Then** the gateway rejects the request with an authentication error before it reaches the daemon.
4. **Given** an authenticated session, **When** the operator lists conversations or loads turn history, **Then** the gateway mediates the request, returns the daemon's paginated response, and the response conforms to the shared contract schema.

---

### User Story 2 — Operator Receives Streaming Updates Over a WebSocket Connection (Priority: P1)

While the daemon executes work for a submitted instruction, the operator receives incremental streaming updates (text deltas, status changes, activity markers, approval prompts, artifact notices) through a WebSocket connection between the browser and the gateway. The gateway receives events from the daemon and forwards them to the correct browser session. Events arrive in order with sequence numbers that the browser can use for acknowledgment and replay.

**Why this priority**: Without a WebSocket streaming connection, the browser would need to poll for updates — destroying the real-time REPL experience. Streaming is the core value of the transport layer.

**Independent Test**: Authenticate, create a conversation, submit an instruction that produces multi-step output, and verify that the browser receives incremental stream events through the WebSocket as they are produced — not batched at the end.

**Acceptance Scenarios**:

1. **Given** an authenticated session with a WebSocket connection established, **When** the operator submits an instruction that triggers work, **Then** the browser receives incremental stream events (text deltas, status changes) through the WebSocket as the daemon produces them.
2. **Given** an active stream, **When** the daemon signals stream completion, **Then** the browser receives the completion event through the WebSocket and the stream is cleanly finalized.
3. **Given** an active stream, **When** the daemon signals a failure, **Then** the browser receives a gateway-defined error event through the WebSocket and the conversation remains in a usable state.
4. **Given** multiple browser sessions connected to the same conversation, **When** one session submits an instruction, **Then** all connected sessions receive the resulting stream events.

---

### User Story 3 — Operator's WebSocket Connection Is Bound to Their Authenticated Session (Priority: P1)

The WebSocket connection between the browser and the gateway is established only within the context of an authenticated session. The handshake validates the session cookie and origin. If the session expires, is invalidated, or the operator logs out, the WebSocket connection is terminated. No conversation events flow over an unauthenticated or session-expired connection.

**Why this priority**: Without session binding on the WebSocket, any browser could open a streaming connection and receive conversation data — bypassing the entire security model. This is a foundational security requirement, co-equal with the transport itself.

**Independent Test**: Establish a WebSocket connection with a valid session. Then invalidate the session (logout or expiry). Verify the connection is terminated and no further events are received. Separately, attempt to establish a WebSocket connection without a valid session and verify it is rejected.

**Acceptance Scenarios**:

1. **Given** a valid authenticated session, **When** the browser requests a WebSocket connection, **Then** the gateway validates the session cookie and origin, establishes the connection, and begins forwarding events for that session's active conversations.
2. **Given** an active WebSocket connection, **When** the operator's session expires, **Then** the gateway terminates the connection and sends a session-expired notification before closing.
3. **Given** an active WebSocket connection, **When** the operator logs out, **Then** the gateway terminates the connection immediately.
4. **Given** no valid session cookie or a mismatched origin, **When** the browser attempts to establish a WebSocket connection, **Then** the gateway rejects the handshake without establishing the connection.

---

### User Story 4 — Operator Recovers Connection and Resumes After Disconnection (Priority: P2)

When the browser loses its WebSocket connection — due to network interruption, browser refresh, or device sleep — the operator can reconnect through the gateway and resume receiving events from where they left off. The gateway supports sequence-based resume: the browser provides the last acknowledged sequence number, and the gateway replays any events the browser missed (buffered at the gateway or re-fetched from the daemon). No events are lost, duplicated, or delivered out of order during reconnection.

**Why this priority**: Browser connections are inherently unreliable. Without reconnect/resume semantics, every network hiccup or page refresh would require reloading the entire conversation state from scratch and potentially missing in-flight events. This is essential for production reliability but depends on the WebSocket connection existing first.

**Independent Test**: Establish a WebSocket connection, begin receiving stream events, disconnect the browser mid-stream, reconnect with the last acknowledged sequence number, and verify that all events produced during the disconnection are replayed in order and live streaming resumes.

**Acceptance Scenarios**:

1. **Given** a browser that was receiving stream events and lost its WebSocket connection, **When** the browser reconnects and provides the last acknowledged sequence number, **Then** the gateway replays all events produced since that sequence number in correct order (from its own buffer or by re-fetching from the daemon).
2. **Given** a browser that reconnects after missing several events, **When** the resumed event stream catches up to the current position, **Then** live streaming continues seamlessly — the operator sees no gap or duplication.
3. **Given** a browser that refreshes the page during active streaming, **When** the page reloads and re-establishes the WebSocket connection with a last-acknowledged sequence, **Then** the gateway replays missed events so the browser can hydrate correctly. (Full conversation state reconstruction is the browser's responsibility using existing REST endpoints plus the replayed event stream.)
4. **Given** a reconnect attempt with an invalid or expired session, **When** the browser provides a last-acknowledged sequence number, **Then** the gateway rejects the reconnect with an authentication error rather than replaying events to an unauthorized client.

---

### User Story 5 — Operator Responds to Approvals and Controls Work Through the Gateway (Priority: P2)

The operator can respond to approval requests, cancel in-progress work, and retry failed turns — all through the gateway's REST endpoints. These control operations are mediated to the daemon with the same session validation, security enforcement, and error handling as regular conversation operations. The WebSocket connection delivers the resulting state-change events back to the browser; the browser sends control commands via REST.

**Why this priority**: Approvals and work control are essential for supervised autonomous operation, which is Hydra's core value proposition. However, they layer on top of the basic conversation transport and streaming connection and are not required for the minimum viable transport.

**Independent Test**: Trigger work that produces an approval request. Verify the approval prompt arrives through the WebSocket. Send an approval response through the gateway REST endpoint. Verify the daemon resumes work and the resume events arrive through the WebSocket. Separately, test cancel and retry operations via REST.

**Acceptance Scenarios**:

1. **Given** the daemon emits an approval request during active work, **When** the event reaches the gateway, **Then** the gateway forwards it to the browser through the WebSocket as a typed approval-prompt stream event.
2. **Given** a pending approval visible in the browser, **When** the operator submits a response through the gateway REST endpoint, **Then** the gateway validates the session, mediates the response to the daemon, and the daemon resumes work — with the resume events flowing back through the WebSocket.
3. **Given** work is in progress, **When** the operator sends a cancel-work command through the gateway REST endpoint, **Then** the gateway mediates the cancellation to the daemon, the stream stops, and a cancellation event is delivered to the browser via WebSocket.
4. **Given** a failed turn, **When** the operator sends a retry command through the gateway REST endpoint, **Then** the gateway mediates the retry to the daemon and a new stream begins for the retried instruction.

---

### User Story 6 — Gateway Communicates Errors and Boundaries Clearly (Priority: P2)

When the daemon is unavailable, the session is invalid, a request fails validation, or a rate limit is hit, the gateway communicates the failure to the browser with a structured error response that distinguishes between error categories. The browser can always determine whether a failure is an auth problem, a daemon problem, a validation problem, or a transient connectivity issue — and can present the appropriate UX without guessing. Error shape is defined by this slice at the gateway level; a shared cross-layer error contract is a follow-on concern.

**Why this priority**: Without clear error boundaries, the browser would have no way to distinguish "you need to log in again" from "the daemon crashed" from "your request was malformed." This is critical for a trustworthy operator experience but is a cross-cutting concern that applies after the basic transport works.

**Independent Test**: Simulate each failure mode — daemon unavailable, session expired, malformed request, rate limit exceeded — and verify that each produces a distinct, structured error response that the browser can programmatically distinguish.

**Acceptance Scenarios**:

1. **Given** the daemon is unreachable, **When** the browser sends a conversation request through the gateway, **Then** the gateway returns a structured error indicating daemon unavailability, distinct from authentication or validation errors.
2. **Given** a request with an invalid or missing conversation identifier, **When** the gateway receives it, **Then** the gateway returns a structured validation error before forwarding to the daemon.
3. **Given** an active WebSocket connection, **When** the daemon becomes unreachable, **Then** the gateway sends a daemon-unavailable event through the WebSocket and keeps the connection open for a configurable grace period to allow daemon recovery.
4. **Given** a conversation operation that exceeds the mutation rate limit, **When** the request arrives, **Then** the gateway returns a structured rate-limit error with information sufficient for the browser to implement appropriate retry behavior.

---

### ~~User Story 7~~ — Deferred: Transport Degraded Mode

Graceful fallback when WebSocket is unavailable (proxy restrictions, corporate firewalls) is a valid concern but introduces a parallel transport path, a capability-discovery endpoint, and polling semantics that expand this slice beyond its core responsibility. **Deferred to a later slice** (e.g., `web-transport-resilience`). If the plan phase identifies a minimal fallback that fits without scope expansion, it may propose one as a stretch goal.

---

### Edge Cases

- What happens when the operator opens multiple browser tabs, each establishing a WebSocket connection to the same conversation? All connections must receive the same events; the gateway must not duplicate work or create conflicting daemon state.
- What happens when a WebSocket connection is established but the operator has not joined any conversation? The connection should remain idle and valid, ready to receive events when the operator opens a conversation.
- What happens when the daemon produces events faster than the gateway can forward them to the browser? The gateway must buffer events up to a defined limit; if the buffer overflows, it must close the connection with a structured error so the browser can reconnect and resume.
- What happens when a WebSocket connection's session is about to expire? The gateway should send a session-expiring-soon event through the connection, giving the browser a chance to extend the session before disconnection.
- What happens when the gateway restarts while WebSocket connections are active? All connections are lost. The browser must treat this as a disconnection and use the reconnect/resume flow. The gateway must not assume any connection state survives a restart.
- What happens when the browser sends a malformed message through the WebSocket? The gateway must reject the individual message with a structured error through the connection, without terminating the connection itself.
- What happens when a conversation operation targets a conversation the operator does not own? The gateway (or daemon) must reject the operation; the gateway must not leak information about conversations belonging to other operators.

## Requirements _(mandatory)_

### Functional Requirements

#### Gateway Conversation Routes

- **FR-001**: The gateway MUST expose browser-facing REST routes for conversation lifecycle operations: create, open, resume, archive, and list conversations.
- **FR-002**: The gateway MUST expose browser-facing REST routes for turn submission and turn history retrieval.
- **FR-003**: The gateway MUST expose browser-facing REST routes for approval retrieval and approval response submission.
- **FR-004**: The gateway MUST expose browser-facing REST routes for work-control operations: cancel and retry.
- **FR-005**: The gateway MUST expose browser-facing REST routes for artifact listing (by turn and by conversation) and artifact content retrieval.
- **FR-006**: All gateway conversation routes MUST validate request payloads against the conversation contract schemas (as defined by `web-conversation-protocol`) before forwarding to the daemon.
- **FR-007**: All gateway conversation routes MUST require an authenticated session (as defined by the `web-session-auth` slice) and reject unauthenticated requests before they reach the daemon.

#### WebSocket Streaming Connection

- **FR-008**: The gateway MUST support a WebSocket connection between the browser and the gateway for streaming conversation events from daemon to browser.
- **FR-009**: The WebSocket handshake MUST validate the browser's session cookie and Origin header, rejecting connections that fail either check.
- **FR-010**: The gateway MUST forward daemon-produced stream events to all WebSocket connections that are authenticated and subscribed to the relevant conversation.
- **FR-011**: Stream events forwarded through the WebSocket MUST carry sequence numbers enabling the browser to track its acknowledgment position.
- **FR-012**: _(removed — bidirectional command transport over WebSocket deferred; commands flow via REST)_
- **FR-013**: Messages received through the WebSocket (subscription management, acknowledgments) MUST be validated, with malformed messages rejected via a structured error through the connection without terminating it.

#### Session Binding and Lifecycle

- **FR-014**: Every WebSocket connection MUST be bound to exactly one authenticated browser session. The binding is established at handshake and cannot be transferred.
- **FR-015**: When a session expires, is invalidated, or the operator logs out, the gateway MUST terminate all WebSocket connections bound to that session, sending a session-terminated event before closing.
- **FR-016**: The gateway MUST send a session-expiring-soon notification through the WebSocket when the bound session enters its expiry warning window, giving the browser an opportunity to extend the session.
- **FR-017**: The gateway MUST enforce the same rate limits on operations received through REST endpoints regardless of whether a WebSocket connection exists.

#### Gateway-to-Daemon Mediation

- **FR-018**: The gateway MUST mediate between browser-facing routes and daemon conversation endpoints without becoming a second source of truth for conversation state. The daemon remains authoritative.
- **FR-019**: The gateway MUST map authenticated browser sessions to the appropriate daemon context (operator identity, session identity) on every mediated request.
- **FR-020**: The gateway MUST receive daemon-produced stream events for active conversations so it can forward them to connected browsers in near-real-time. **Note:** The daemon does not currently expose a push/subscription mechanism suitable for this purpose. This slice includes the work to design and implement the necessary daemon-side amendment (e.g., an internal event subscription endpoint or SSE feed) as a dependency task within the plan, rather than assuming it already exists.
- **FR-021**: If the daemon becomes unreachable, the gateway MUST communicate daemon unavailability through both REST error responses and WebSocket events, distinguishing it from session or validation errors.

#### Reconnect and Resume

- **FR-022**: The gateway MUST support sequence-based resume: a reconnecting browser provides its last acknowledged sequence number and receives all events produced since that sequence (from gateway buffer or daemon re-fetch).
- **FR-023**: On reconnect after a page refresh, the browser can use existing REST endpoints (conversation detail, turn history) to reconstruct conversation state, combined with replayed events from FR-022. The gateway is NOT required to provide a single "snapshot" endpoint; state reconstruction is the browser's responsibility using existing REST surfaces.
- **FR-024**: During reconnect, event replay MUST preserve the original ordering and sequence numbers — no reordering, no gaps, no duplicates.
- **FR-025**: Reconnect requests MUST validate the session before replaying any events.

#### Error Boundaries

- **FR-026**: The gateway MUST define a gateway-level error response shape (error code, category, human-readable message) for all error responses, both on REST endpoints and through the WebSocket. A shared cross-layer error contract (e.g., in `packages/web-contracts`) is a desirable follow-on but is NOT a prerequisite for this slice; the gateway defines its own shape and a future slice can promote it to a shared contract.
- **FR-027**: The gateway MUST distinguish at minimum five error categories in its responses: authentication failure, session expiry, validation failure, daemon unavailability, and rate-limit exceeded.
- **FR-028**: Daemon errors forwarded through the gateway MUST be translated into the gateway error shape; raw daemon error internals MUST NOT be exposed to the browser.

#### ~~Fallback and Degraded Operation~~ — Deferred

- ~~**FR-029**~~, ~~**FR-030**~~, ~~**FR-031**~~: Transport-capabilities endpoint, REST-only fallback for all operations, and polling-based stream retrieval are deferred to a later slice (e.g., `web-transport-resilience`). This slice assumes WebSocket is available at the gateway boundary. REST endpoints exist for conversation operations regardless, but the streaming path requires WebSocket.

### Key Entities

- **Gateway Conversation Route**: A browser-facing HTTP REST endpoint that mediates conversation operations between the browser and the daemon. Validates session, enforces security, translates errors.
- **WebSocket Connection**: A long-lived WebSocket channel between the browser and the gateway used for streaming events from daemon to browser. Bound to one authenticated session. Terminated when the session ends.
- **Session Binding**: The association between a WebSocket connection and an authenticated browser session. Established at handshake, immutable for the connection's lifetime.
- **Gateway-Daemon Event Bridge**: The mechanism by which the gateway receives daemon-produced stream events for active conversations so it can forward them to connected browsers. This mechanism does not yet exist in the daemon and is an explicit work item within this slice (see FR-020).
- **Resume Checkpoint**: The browser's last acknowledged sequence number, used to request replay of missed events during reconnection.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An authenticated browser can complete the full conversation lifecycle (create → submit instruction → receive stream events → load history) entirely through the gateway — zero direct browser-to-daemon communication. Verified by end-to-end transport tests.
- **SC-002**: Stream events produced by the daemon are visible to the browser through the WebSocket within 500ms of production under normal loopback conditions. Verified by latency measurement tests.
- **SC-003**: After a WebSocket disconnection and reconnect with a last-acknowledged sequence number, 100% of events produced during the disconnection are replayed in correct order with zero gaps or duplicates. Verified by disconnect-resume tests at random points during streaming.
- **SC-004**: Every conversation operation through the gateway (REST and WebSocket control frames) is rejected when the session is invalid — zero unauthenticated conversation access. Verified by session-bypass tests on every route and WebSocket message type.
- **SC-005**: Session expiry terminates all bound WebSocket connections within the session-state propagation window (≤ 5 seconds per `web-session-auth` SC-003). Verified by session-expiry-during-streaming tests.
- **SC-006**: WebSocket handshake rejects connections with invalid session cookies or mismatched Origin headers — zero unauthorized WebSocket connections. Verified by negative handshake tests.
- **SC-007**: When the daemon is unreachable, the gateway returns a structured daemon-unavailable error (distinct from auth and validation errors) on REST routes and through the WebSocket. Verified by daemon-down simulation tests.
- **SC-008**: All gateway conversation routes validate request payloads against conversation contract schemas — zero unvalidated requests forwarded to the daemon. Verified by schema-violation tests on every route.
- **SC-009**: _(removed — REST-only fallback mode deferred to later slice)_
- **SC-010**: Malformed messages received through the WebSocket produce structured error responses without terminating the connection. Verified by bad-message resilience tests.
- **SC-011**: `npm run quality` and `npm test` pass at every task checkpoint.
- **SC-012**: The daemon event bridge (FR-020) is implemented and integration-tested: the gateway can subscribe to daemon events for a conversation and receive them in near-real-time. Verified by gateway↔daemon integration tests.

## Dependencies _(mandatory)_

This slice depends on and does NOT re-own the following **existing** deliverables:

- **web-repl-foundation** — establishes npm workspaces, the `packages/web-contracts/` package, and baseline quality gates. This slice assumes workspace infrastructure already exists.
- **web-session-auth** — owns browser session lifecycle, authentication, session cookies, CSRF protection, origin validation, rate limiting, hardened headers, and audit recording. This slice reuses all session middleware and consumes opaque session/operator identities without managing their creation or validation logic.
- **web-conversation-protocol** — defines the conversation data model (Conversation, Turn, StreamEvent, ApprovalRequest, Artifact, ActivityEntry), the shared validation schemas, and the daemon contract families (lifecycle, turn submission, approval flow, work control, artifact access, multi-agent activity). This slice consumes those schemas for request/response validation and event forwarding — it does NOT redefine any conversation entities.
- **Daemon conversation REST routes** — the daemon's existing HTTP REST API for conversation operations (lifecycle, turns, approvals, work control, artifacts, activities). This slice mediates browser requests to those routes; it does NOT reimplement daemon conversation logic.

### Daemon Transport Amendments (work items within this slice)

The following daemon-side capabilities do **not** yet exist and MUST be delivered as explicit tasks within this slice's plan:

1. **Event subscription / push mechanism** — the daemon currently has no way for the gateway to subscribe to conversation stream events in real time. This slice must design and implement a daemon-side event feed (e.g., an internal SSE endpoint, an in-process event emitter, or a lightweight pub/sub channel) that the gateway can consume. The mechanism should be minimal and internal (gateway↔daemon only), not a general-purpose public API.
2. **Sequence-numbered event stream** — stream events forwarded to the gateway must carry monotonic sequence numbers so the gateway can support resume. If the daemon does not already attach sequence numbers to stream events, this slice adds them.
3. **Event replay / buffer** — after a brief disconnection, missed events must be replayable. The simplest approach is a bounded in-memory ring buffer at the gateway; if daemon-side replay is needed, that is scoped here too.

These amendments are scoped narrowly to what the gateway transport requires. Broader daemon eventing improvements are out of scope.

## Out of Scope

- **Browser chat workspace UI** — rendering conversations, composing instructions, displaying streaming output, approval UX, and artifact viewers are the next slice (`web-chat-workspace`). This slice provides the transport the UI will consume.
- **Conversation data model changes** — entities, schemas, and contract shapes are owned by `web-conversation-protocol`. If gateway transport requirements surface a need for contract changes, those changes should be proposed as amendments to that slice.
- **Daemon conversation logic** — conversation storage, turn execution, stream production, approval lifecycle, and artifact management are daemon responsibilities. This slice mediates; it does not own. (The daemon transport amendments in the Dependencies section are narrow plumbing changes, not conversation logic.)
- **Bidirectional command transport over WebSocket** — the browser sends conversation commands (instruction submission, approval responses, work control) via REST endpoints only in this slice. Promoting commands to WebSocket is a follow-on optimization for a later slice.
- **Shared cross-layer error contract** — this slice defines a gateway-level error shape. Promoting it to a shared contract in `packages/web-contracts` is a follow-on concern.
- **Shared snapshot endpoint** — the browser reconstructs conversation state using existing REST endpoints (conversation detail, turn history) plus replayed events. A single "snapshot" convenience endpoint is a follow-on.
- **Transport fallback / degraded mode** — graceful fallback when WebSocket is unavailable, capability-discovery endpoints, and polling-based streaming are deferred to a later slice (e.g., `web-transport-resilience`).
- **Fork and queue management** — conversation forking and broader queue management are deferred to later slices. This slice covers cancel and retry only.
- **Command catalog, task live output, config mutations, operational intelligence** — contract families 2–6 from `docs/web-interface/04-protocol.md` are follow-on concerns for later slices.
- **Multi-user conversations and cross-operator access** — this slice assumes single-operator-per-conversation; multi-user extensions are future work.

## Relation to `web-chat-workspace`

This slice is the direct prerequisite for the `web-chat-workspace` slice. The boundary is:

| This slice delivers                                 | `web-chat-workspace` consumes it as                       |
| --------------------------------------------------- | --------------------------------------------------------- |
| Gateway REST routes for conversation operations     | API layer the browser UI calls                            |
| WebSocket connection with session binding           | Transport for real-time stream events                     |
| Sequence-based reconnect/resume through the gateway | Reconnect strategy the UI implements                      |
| Gateway-level structured error responses            | Error handling the UI maps to operator-facing messages    |
| Approval/artifact/work-control mediation via REST   | Control surface plumbing the UI wires into its components |
| Daemon event bridge (internal, gateway↔daemon)      | Infrastructure the gateway uses; invisible to the UI      |

The `web-chat-workspace` slice should be able to assume that all conversation operations are available through the gateway and focus entirely on browser rendering, interaction design, and component architecture.

## Revision Notes

**2026-03-16 — GPT-5.4 review tightening:**

1. **WebSocket made explicit** — replaced all "persistent, bidirectional connection" language with "WebSocket" to remove ambiguity about the target transport at the gateway boundary.
2. **Bidirectional command transport deferred** — removed FR-012 (commands over WebSocket). Commands flow via REST; the WebSocket is server→client streaming + lightweight client acknowledgments only. Avoids premature complexity.
3. **Daemon transport amendments made explicit work items** — FR-020 and the new "Daemon Transport Amendments" subsection in Dependencies acknowledge that daemon push/subscription does not yet exist and scope the necessary plumbing as tasks within this slice's plan.
4. **Snapshot assumption removed** — FR-023 no longer requires a "conversation snapshot" endpoint. The browser reconstructs state from existing REST endpoints + event replay. A snapshot convenience endpoint is a follow-on.
5. **Shared error contract assumption removed** — FR-026 defines a gateway-level error shape rather than depending on a shared `ErrorCode`/`ErrorResponse` contract that doesn't exist yet. Promotion to shared contract is a follow-on.
6. **Fallback / capability discovery deferred** — User Story 7 and FR-029/030/031 removed. Transport degraded mode is a real concern but expands scope; deferred to `web-transport-resilience`.
7. **Fork/queue management trimmed** — FR-004 narrowed to cancel and retry only; fork and queue management deferred.
8. **Scope note updated** — no longer claims "Phase 1 completion"; instead positions this slice between `web-conversation-protocol` and `web-chat-workspace` in the SDD sequence.
9. **SC-012 added** — success criterion for the daemon event bridge, since it's now an explicit work item.
