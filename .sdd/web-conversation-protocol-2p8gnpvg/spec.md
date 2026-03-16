# Feature Specification: Web Conversation Protocol Slice

**Created**: 2026-03-15
**Status**: Draft
**Input**: Hydra needs a browser-native conversation and streaming interaction model for its future web REPL. This spec defines what operators need from conversations, turns, streaming updates, approvals, reconnect behavior, history, and artifacts — without implementation details.

## User Scenarios & Testing _(mandatory)_

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just
  ONE of them, you should still have a viable MVP that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
-->

### User Story 1 - Open and Continue a Conversation (Priority: P1)

An operator opens a new conversation in the browser, issues instructions, and receives responses organized as a sequence of turns. Each turn captures who initiated it (the operator or the system), the content exchanged, and a stable ordering. The operator can close the browser, return later, and resume the same conversation from where it left off with full history intact.

**Why this priority**: Without a persistent, ordered conversation model, no other interaction — streaming, approvals, reconnect — has a container to live in. This is the foundational data structure for the entire web REPL experience.

**Independent Test**: Create a conversation, add several operator and system turns, close the session, reopen it, and verify the full turn history is present and correctly ordered.

**Acceptance Scenarios**:

1. **Given** the operator has no open conversations, **When** the operator starts a new conversation and sends an instruction, **Then** the system creates a conversation with a unique identity, records the operator's instruction as the first turn, and displays it.
2. **Given** a conversation with three prior turns exists, **When** the operator reopens it after navigating away, **Then** all three turns are displayed in their original order with their content and attribution intact.
3. **Given** a conversation is in progress, **When** the system completes work for an operator's instruction, **Then** the turn's response is populated with a clear attribution to the system (or to a specific agent identity when applicable) and a timestamp.

---

### User Story 2 - Stream Progress During Active Work (Priority: P1)

While the system is executing work in response to an operator instruction, the operator sees a live, incremental stream of progress. This includes partial text output, status changes, and structured activity markers (e.g., "agent X began task Y", "file modified", "test results available"). The stream continues until the work completes, fails, or is cancelled.

**Why this priority**: Without streaming, the browser would go silent during all work — the operator would have no way to know whether the system is working, stuck, or finished. Streaming is essential to making the REPL feel alive and trustworthy.

**Independent Test**: Issue an instruction that triggers multi-step work, observe that incremental updates appear in the browser before the final result, and verify that the stream terminates cleanly when work completes.

**Acceptance Scenarios**:

1. **Given** the operator has submitted an instruction, **When** the system begins executing, **Then** the operator sees incremental progress updates appear in the conversation as they occur, not batched at the end.
2. **Given** a streaming response is in progress, **When** the work completes successfully, **Then** the stream ends with a clear completion marker and the final result is visible as a completed turn.
3. **Given** a streaming response is in progress, **When** the work fails partway through, **Then** the operator sees the progress up to the failure point, a clear error indication, and the conversation remains in a usable state for the next instruction.

---

### User Story 3 - Respond to Approvals and Follow-Up Requests (Priority: P1)

During active work, the system may pause and ask the operator a question — to approve a dangerous action, choose between alternatives, or provide missing information. The operator sees the request inline in the conversation, can respond directly, and work resumes based on the response. If the operator does not respond, the request remains visible and pending until addressed.

**Why this priority**: Hydra's operational model requires human-in-the-loop approval gates. Without browser-native approval handling, the web REPL cannot support supervised autonomous work — the core value proposition.

**Independent Test**: Trigger work that requires an approval, verify the approval prompt appears in the conversation, submit a response, and confirm that work resumes and the response is recorded within the turn.

**Acceptance Scenarios**:

1. **Given** the system encounters an action requiring operator approval during work, **When** it pauses for input, **Then** the operator sees a clearly identified approval request in the conversation with the context needed to make a decision.
2. **Given** an approval request is pending, **When** the operator submits a response (approve, reject, or provide information), **Then** the response is recorded as an event within the active turn, work resumes accordingly, and the request is marked as resolved.
3. **Given** an approval request is pending, **When** the operator refreshes the page or reconnects, **Then** the pending approval request is still visible and actionable — it is not lost or silently timed out.

---

### User Story 4 - Recover from Refresh, Reconnect, and Interruption (Priority: P2)

The operator's browser may lose connectivity, be refreshed, or be closed and reopened. In all cases, when the operator returns, the conversation displays the authoritative state of all work — including any progress that occurred while the browser was disconnected. No turns, streaming output, or approval state is lost due to browser-side interruptions.

**Why this priority**: Browser connections are inherently unreliable. If the operator cannot trust that the displayed state matches reality after a reconnect, the entire system's trustworthiness collapses. This is a prerequisite for production use but depends on conversation and streaming being defined first.

**Independent Test**: Start work that produces streaming output, disconnect the browser mid-stream, reconnect, and verify that the conversation shows the complete authoritative state including any output produced during disconnection.

**Acceptance Scenarios**:

1. **Given** work is actively streaming output, **When** the operator's browser loses connection and then reconnects, **Then** the conversation displays all output produced during the disconnection in the correct order, and live streaming resumes from the current point.
2. **Given** the operator refreshes the browser page during active work, **When** the page reloads, **Then** the conversation is restored to the current authoritative state, including any turns or streaming output that occurred during the reload.
3. **Given** work completed while the browser was disconnected, **When** the operator reconnects, **Then** the completed result is visible as a finished turn with no indication of partial or missing data.

---

### User Story 5 - Cancel, Retry, and Fork Work (Priority: P2)

The operator can cancel work that is in progress. After a completed or failed turn, the operator can retry the instruction or fork the conversation from a prior point to try a different approach. Cancelled, retried, and forked turns are clearly distinguishable in the conversation history.

**Why this priority**: Operators need escape hatches when work goes wrong and the ability to explore alternative approaches. This is important for iterative workflows but depends on having a stable conversation and streaming model first.

**Independent Test**: Start work, cancel it mid-stream, verify the cancellation is recorded. Then retry a failed turn and verify new work begins. Fork from a mid-conversation point and verify the new branch has the correct history prefix.

**Acceptance Scenarios**:

1. **Given** work is actively in progress, **When** the operator cancels it, **Then** the system stops the work, records the cancellation as a turn event, and the conversation is ready to accept a new instruction.
2. **Given** a turn resulted in failure, **When** the operator retries it, **Then** the system re-executes the original instruction and appends the new result as a subsequent turn, with the retry relationship visible in history.
3. **Given** a conversation with multiple turns, **When** the operator forks from a specific prior turn, **Then** a new conversation is created containing all turns up to and including the fork point, and the operator can issue a new instruction from there.

---

### User Story 6 - View Artifacts Produced by Work (Priority: P2)

When work produces artifacts — files, diffs, test results, logs, structured data — the operator can view them directly in the conversation. Artifacts are associated with the turn that produced them and remain accessible in the conversation history.

**Why this priority**: Artifacts are the tangible output of Hydra's work. Without artifact visibility, the operator would need to leave the conversation to inspect results, breaking the workspace metaphor. This depends on conversations and turns existing first.

**Independent Test**: Trigger work that produces at least one artifact, verify the artifact is visible and associated with the correct turn, navigate away and return, and confirm the artifact is still accessible.

**Acceptance Scenarios**:

1. **Given** work produces one or more artifacts, **When** the turn completes, **Then** each artifact is listed and viewable within the conversation, associated with the turn that produced it.
2. **Given** a conversation contains turns with artifacts from a prior session, **When** the operator reopens the conversation, **Then** all previously produced artifacts are still accessible and viewable.
3. **Given** a turn produced multiple artifacts of different kinds (e.g., a file diff and a test result), **When** the operator views the turn, **Then** each artifact is distinguishable by kind and individually accessible.

---

### User Story 7 - Understand Multi-Agent and Council Activity (Priority: P3)

When work involves multiple agents or a council deliberation, the operator can see structured activity that identifies which agents are involved, what each is doing, and how their contributions relate to the overall task. This activity is not flattened into opaque chat text — it preserves the multi-agent structure.

**Why this priority**: Multi-agent visibility is important for operator understanding and trust, but it layers on top of the core conversation, streaming, and artifact models. It can be deferred to after the foundational protocol is stable.

**Independent Test**: Trigger work involving multiple agents, verify that each agent's activity is individually attributable, and confirm that council deliberation steps are represented as structured entries rather than plain text.

**Acceptance Scenarios**:

1. **Given** work is delegated to multiple agents, **When** the operator views the streaming progress, **Then** each agent's activity is attributed to that agent by identity, not merged into a single undifferentiated stream.
2. **Given** a council deliberation occurs during work, **When** the operator views the turn, **Then** the deliberation steps (proposals, votes, consensus) are represented as structured, navigable entries.
3. **Given** a multi-agent turn has completed, **When** the operator reviews it in history, **Then** the agent-level breakdown is preserved and can be expanded or collapsed without losing information.

---

### Edge Cases

- What happens when the operator submits a new instruction while a previous one is still streaming? The system must either queue the new instruction, reject it with a clear message, or support concurrent work — the behavior must be deterministic and visible to the operator.
- What happens when a conversation accumulates a very large number of turns? The system must remain responsive — the operator should not need to wait for the entire history to load before interacting with the most recent turns.
- What happens when an approval request references context that is no longer valid (e.g., a file has changed since the request was created)? The request must indicate staleness rather than silently proceeding on outdated information.
- What happens when the operator attempts to fork from a turn that itself was a fork point? The system must handle multi-level forking gracefully with clear lineage.
- What happens when streaming output is produced faster than the browser can render? The system must not lose data — buffering or catch-up behavior must be defined.
- What happens when two browser tabs or devices are viewing the same conversation simultaneously? Both must reflect the same authoritative state; conflicting operator actions (e.g., two simultaneous approval responses) must be resolved deterministically.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST maintain a persistent conversation as an ordered sequence of turns, where each turn represents one operator instruction and all resulting system work. Each turn has an identity, attribution, content, a timestamp, and a stable position in the sequence. Approvals, agent activity, errors, and cancellation are nested events within the turn, not separate top-level turns.
- **FR-002**: System MUST allow an operator to create a new conversation, continue an existing conversation by appending instructions, and retrieve the full ordered history of any conversation.
- **FR-003**: System MUST deliver incremental streaming updates to the browser while work is in progress, including partial text, status transitions, and structured activity markers.
- **FR-004**: System MUST clearly signal stream lifecycle events: stream started, stream in progress, stream completed, and stream failed.
- **FR-005**: System MUST support inline approval and follow-up requests that pause work, present the request to the operator in the conversation, and resume work upon receiving the operator's response.
- **FR-006**: System MUST persist all conversation state (turns, streaming output, pending approvals, artifacts) server-side so that no data is lost due to browser disconnection, refresh, or closure.
- **FR-007**: System MUST allow a reconnecting browser to synchronize to the current authoritative conversation state, including any turns or streaming output produced during disconnection.
- **FR-008**: System MUST support operator-initiated cancellation of in-progress work, recording the cancellation in the conversation and leaving the conversation ready for new instructions.
- **FR-009**: System MUST support operator-initiated retry of a failed or completed turn, creating a new execution linked to the original instruction.
- **FR-010**: System MUST support operator-initiated forking of a conversation from any prior turn, creating a new conversation that shares history up to the fork point.
- **FR-011**: System MUST associate artifacts (files, diffs, test results, logs, structured data) with the turn that produced them and make them accessible within the conversation.
- **FR-012**: System MUST represent multi-agent activity with per-agent attribution and structured council deliberation entries, rather than flattening them into undifferentiated text.
- **FR-013**: System MUST define deterministic behavior when an operator submits a new instruction while previous work is still in progress (queue, reject, or concurrent execution — but the policy must be explicit and visible).
- **FR-014**: System MUST handle conversations with large turn counts without requiring the entire history to be loaded before the operator can interact with recent turns.
- **FR-015**: System MUST ensure that when multiple browser sessions view the same conversation, all sessions reflect the same authoritative state and conflicting operator actions are resolved deterministically.

### Key Entities

- **Conversation**: A persistent, ordered container for interaction between an operator and the system. Has a unique identity, a creation time, and contains an ordered sequence of turns. May be forked from another conversation at a specific turn.
- **Turn**: A single interaction cycle within a conversation — an operator instruction together with all resulting system work and response. Each turn has an identity, attribution, content, a timestamp, and a position. Approvals, agent activity, errors, and cancellation are represented as nested events within the turn (via StreamEvents and ApprovalRequest entities) rather than separate top-level turns. System-initiated turns (unsolicited notices) are permitted but uncommon. A turn may have associated artifacts and may link to a parent turn (for retries or forks).
- **Stream**: A transient, ordered sequence of incremental updates associated with an in-progress turn. Contains partial text, status changes, and activity markers. Becomes finalized content when the turn completes.
- **Approval Request**: A system-initiated pause within a turn's execution that requires operator input before work can continue. Has a status (pending, responded, expired, stale), the context needed for the decision, and the operator's response once provided.
- **Artifact**: A discrete output produced by a turn — a file, diff, test result, log, or structured data object. Has a kind, a label, content or a reference to content, and is permanently associated with its producing turn.
- **Agent Identity**: A named participant in multi-agent work. Activity within a turn can be attributed to one or more agent identities, preserving the structure of delegation and council deliberation.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An operator can create a conversation, add turns, close the browser, reopen it, and see 100% of prior turns in correct order with no data loss — verified by automated round-trip tests.
- **SC-002**: Streaming updates are visible to the operator within a human-perceptible latency window (under 1 second from production to display under normal conditions) during active work.
- **SC-003**: An operator can respond to an approval request that was issued before a browser disconnection, after reconnecting — the request is still pending and actionable, verified by a reconnect-during-approval test scenario.
- **SC-004**: After any browser disconnection and reconnect, the displayed conversation state matches the authoritative server-side state with zero missing or out-of-order turns — verified by state-comparison tests that disconnect at random points during streaming.
- **SC-005**: Cancellation of in-progress work results in the stream stopping and the conversation accepting a new instruction within 5 seconds of the cancel action.
- **SC-006**: Forking a conversation from turn N produces a new conversation containing exactly turns 1 through N, with no extra or missing turns — verified by automated fork-and-compare tests.
- **SC-007**: Artifacts produced by a turn are accessible in the conversation both immediately after production and after a full browser refresh — verified by artifact persistence tests.
- **SC-008**: Multi-agent activity within a turn is queryable by agent identity — an operator can determine which agent produced which output, verified by attribution tests on multi-agent scenarios.
- **SC-009**: Two simultaneous browser sessions viewing the same conversation see identical turn sequences after any operator action, with conflicts resolved within one subsequent synchronization cycle — verified by concurrent-session tests.

## Dependencies _(mandatory)_

This slice depends on and does NOT re-own the following:

- **web-repl-foundation** — establishes npm workspaces (`packages/`, `apps/` directories), the `packages/web-contracts/` package, and baseline quality gates for new packages. This slice assumes that workspace infrastructure already exists.
- **web-session-and-auth** — owns browser session lifecycle, authentication, operator identity issuance, WebSocket termination, and browser session registry. This slice consumes opaque `operatorId` and `sessionId` values without managing their creation, validation, or transport-level session tracking.

## Follow-On Protocol Families _(out of scope)_

The authoritative protocol docs (`docs/web-interface/04-protocol.md`) identify six required daemon contract families. This slice covers family 1 (conversation messaging) and partially covers family 3 (council/multi-agent eventing). The remaining families are explicit follow-on dependencies that should be specified as separate SDD slices:

- **Command catalog and execution** — typed discovery and invocation of Hydra commands from the browser.
- **Task live output** — streaming task progress, checkpoints, and stdout/stderr-equivalent output in browser-safe form.
- **Config and controlled mutations** — safe read/write of allowlisted config through daemon-owned APIs.
- **Operational intelligence** — agent health, budgets, usage, affinity, and knowledge surfaces.

This slice provides protocol hooks (extensible StreamEvent kinds, extensible contract patterns) that follow-on slices can extend without breaking the conversation foundation.
