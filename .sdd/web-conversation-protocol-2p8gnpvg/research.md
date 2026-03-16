# Research: Web Conversation Protocol Slice

**Date**: 2025-07-14
**Feature**: Web Conversation Protocol Slice
**Spec**: [spec.md](./spec.md)

## Research Questions and Decisions

### Decision 1: Conversation Identity — New Entity or Adapt Existing Sessions

**Question**: Should the web conversation be a new first-class entity, or should it adapt the existing `ActiveSessionEntry` in `lib/types.ts`?

**Chosen**: New first-class Conversation entity, coexisting with existing daemon sessions.

**Rationale**: The existing `ActiveSessionEntry` represents an orchestration session (a unit of coordinated multi-agent work), not a user-facing dialogue. A web conversation has different lifecycle semantics: it persists across multiple orchestration sessions, supports forking, carries approval state, and is the unit the browser addresses. Conflating the two would create awkward coupling — the operator would lose a conversation when an orchestration session ends.

**Alternatives considered**:

- _Thin wrapper around ActiveSessionEntry_: Lower initial effort but couples conversation lifecycle to orchestration lifecycle. Rejected because conversations must outlive individual sessions.
- _Replace ActiveSessionEntry_: Too disruptive to the existing daemon. The CLI and agent coordination rely on the current session model.

---

### Decision 2: Turn Granularity — One Turn per Instruction or One Turn per Agent Action

**Question**: What constitutes a single "turn" in the conversation? Just the operator's instruction and the top-level response, or every agent-level action within a multi-agent workflow?

**Chosen**: A turn is one operator instruction and all resulting system work. Agent-level actions, approvals, errors, and cancellation are nested _within_ a turn as structured events (StreamEvents, ApprovalRequests, ActivityEntries) — not separate top-level turns.

**Rationale**: This matches the operator's mental model — "I asked for X, the system did Y." Multi-agent details, approval exchanges, and error events are important but secondary. Nesting them inside turns keeps the conversation timeline readable while preserving full detail on expansion. It also aligns with the spec's User Story 7 (multi-agent visibility) being P3 rather than P1. The authoritative protocol docs (`04-protocol.md`) define a turn as "one user input and the resulting assistant/system/agent activity," confirming this model.

**Alternatives considered**:

- _Flat turns per agent action_: Would create extremely long timelines for council deliberations or multi-agent tasks. Rejected for readability.
- _Separate agent activity log_: Cleaner separation but loses the inline visibility the spec requires. The operator should see agent activity _in context_, not in a separate panel.
- _Approval/error/cancellation as separate turns_: Would fragment the timeline and lose the coherence of "I asked, the system worked." Rejected because it obscures the one-instruction-to-one-outcome relationship.

---

### Decision 3: Stream Resumability — Sequence-Based or Timestamp-Based

**Question**: How does a reconnecting browser know where to resume a stream? By event sequence number, by timestamp, or by some other cursor?

**Chosen**: Sequence-based resumption using the daemon's existing event sequence numbers.

**Rationale**: The daemon already assigns monotonically increasing `seq` numbers to all events in `AI_ORCHESTRATOR_EVENTS.ndjson`. This is the natural cursor for replay and resume. The browser tracks the last-acknowledged sequence, and on reconnect requests "events since seq N." This is deterministic and aligns with the existing event-sourcing architecture. Replay from a given `seq` is gap-free at the daemon event-log level; when events are filtered to a single turn, the seq values remain strictly ordered but may contain gaps (since the daemon interleaves events from all sources).

**Alternatives considered**:

- _Timestamp-based_: Simpler conceptually but vulnerable to clock skew and doesn't guarantee gap-free replay. Rejected.
- _Opaque cursor tokens_: More flexible but adds unnecessary abstraction when the daemon already has sequence numbers.

---

### Decision 4: Concurrent Instruction Policy (FR-013)

**Question**: What happens when an operator submits a new instruction while previous work is still streaming?

**Chosen**: Queue-and-notify — the new instruction is accepted into a pending queue, and the operator sees confirmation that it will execute after the current work completes or is cancelled. The operator can reorder or remove queued instructions.

**Rationale**: Rejecting the instruction would be frustrating (the operator thought of something while watching progress). Allowing true concurrent execution would require multi-stream rendering and conflict resolution that belongs in a later phase. Queueing is the simplest behavior that respects the operator's intent without introducing concurrency hazards.

**Alternatives considered**:

- _Reject with message_: Simple but poor UX. Rejected.
- _Concurrent execution_: Powerful but introduces multi-stream UI complexity and potential resource conflicts. Deferred to a future spec.

---

### Decision 5: Fork Implementation — Copy-on-Write or Reference-Based

**Question**: When forking a conversation at turn N, does the system copy all turns 1..N into a new conversation, or does it reference the original conversation up to turn N?

**Chosen**: Reference-based with immutable turn history. The forked conversation stores a reference to the parent conversation and the fork-point turn. Turns before the fork point are read from the parent; new turns after the fork are owned by the child.

**Rationale**: Copy-on-write avoids duplicating potentially large conversation histories with embedded artifacts. It also preserves lineage — the operator can trace a fork back to its origin. The requirement that turns are immutable (append-only within a conversation) makes reference-based reads safe.

**Alternatives considered**:

- _Full copy_: Simpler implementation but wasteful for large conversations and loses explicit lineage. Acceptable fallback if reference-based proves too complex in implementation.

---

### Decision 6: Approval Request Lifecycle

**Question**: What states can an approval request pass through, and what happens if the context it references becomes stale?

**Chosen**: Four states — `pending`, `responded`, `expired`, `stale`. A staleness check is performed when the operator views or responds to a pending approval. If the referenced context has changed (e.g., a file was modified by another agent), the request transitions to `stale` and the operator sees a warning before choosing to proceed or cancel.

**Rationale**: The spec's edge cases explicitly call out stale approvals as a concern. Silent expiration or proceeding on outdated context would violate operator trust. Making staleness visible lets the operator make an informed decision.

**Alternatives considered**:

- _Auto-expire after timeout_: Would lose pending approvals if the operator steps away. Rejected because the spec requires approvals to survive disconnection.
- _No staleness detection_: Simpler but risks the operator approving actions based on outdated context. Rejected for safety.

---

### Decision 7: Large Conversation Handling (FR-014)

**Question**: How does the system remain responsive when a conversation has hundreds or thousands of turns?

**Chosen**: Windowed loading — the browser initially loads the most recent N turns (e.g., the last 50) and can load earlier history on demand by scrolling or explicit request. The server provides a total turn count and supports range-based turn retrieval.

**Rationale**: Loading thousands of turns with embedded artifacts would be slow and memory-intensive. The operator's most common need is to see recent context. Older history is valuable but accessed less frequently. This matches the behavior of mature chat applications.

**Alternatives considered**:

- _Full load with virtualized rendering_: Shifts the problem to the browser. Still requires transferring all data over the network. Rejected for initial implementation.
- _Server-side summarization of old turns_: Interesting but adds complexity. Deferred to a future enhancement.

---

### Decision 8: Multi-Tab Conflict Resolution (FR-015)

**Question**: How are conflicting actions from two browser tabs or devices handled?

**Chosen**: First-write-wins with notification. Each browser session has a session identifier. When a conflicting action arrives (e.g., two approval responses for the same request), the first response is accepted, and subsequent sessions receive a "conflict resolved" notification that lets the UI indicate which session or tab won. Browser-facing presentation should prefer a gateway-mapped safe label or alias when available rather than introducing new raw transport session-id fields solely for conflict notification.

**Rationale**: Optimistic locking would require the operator to explicitly retry on conflict, which is jarring. First-write-wins with notification keeps the workflow moving while ensuring all sessions converge to the same authoritative state. The daemon's event-sourcing model naturally provides the ordering needed.

**Alternatives considered**:

- _Optimistic locking with retry_: More correct but worse UX for a single-operator system. Deferred unless multi-operator support is added.
- _Single-session enforcement_: Would prevent the operator from using multiple devices. Rejected.

---

### Decision 9: Browser Session Ownership — Daemon or Gateway

**Question**: Should the daemon own browser session registration, heartbeat tracking, and WebSocket termination, or should those remain in the gateway?

**Chosen**: Browser session lifecycle (registration, heartbeat, WebSocket termination) belongs to `apps/web-gateway` and the `web-session-and-auth` slice. This conversation protocol slice consumes opaque `operatorId` and `sessionId` values but does not manage their issuance, validation, or transport-level session tracking.

**Rationale**: The architecture docs (`03-architecture.md`) assign browser auth, sessions, and WebSocket termination to the gateway. Moving session registry into the daemon would violate the documented responsibility split and make the daemon aware of browser transport concerns it should not own. The daemon remains authoritative for conversation and task state; the gateway handles browser-facing session mechanics.

**Alternatives considered**:

- _Daemon-owned session registry_: Would centralize all session tracking but violates the architecture boundary. The daemon should not need to know about browser heartbeats or WebSocket lifecycle. Rejected.
- _Hybrid (daemon tracks conversation viewers, gateway tracks transport)_: More nuanced but adds coupling. Deferred — the gateway can notify the daemon about active viewers if needed later.

---

### Decision 10: Protocol Family Scope — Narrow Foundation vs. Broad Coverage

**Question**: The authoritative protocol docs list six required contract families. Should this slice attempt to cover all six, or focus narrowly?

**Chosen**: This slice covers family 1 (conversation messaging) fully and family 3 (council/multi-agent eventing) partially. Families 2 (command catalog), 4 (task live output), 5 (config mutations), and 6 (operational intelligence) are declared as explicit follow-on dependencies with protocol extension hooks.

**Rationale**: Attempting all six families in one slice would make it too large to implement and review effectively. The conversation protocol is the foundational layer that all other families build on. By defining extensible StreamEvent kinds and contract patterns, this slice provides clean extension points without becoming an incomplete pseudo-foundation. The follow-on families can extend the existing event stream and contract surface without breaking changes.

**Alternatives considered**:

- _Cover all six families_: Too broad for a single slice. Would delay delivery and make review difficult. Rejected.
- _Cover only family 1_: Too narrow — would leave no hooks for follow-on families. The current approach includes extension patterns that make follow-on integration smooth.
