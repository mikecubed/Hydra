# Feature Specification: Web Chat Workspace

**Created**: 2026-03-20
**Status**: Draft
**Input**: Build the next web initiative slice, `web-chat-workspace`, on top of the completed transport layer. This slice should deliver the browser chat workspace itself: transcript and composer, streaming rendering, cancel/retry/branch/follow-up flows, approvals and browser-safe interactive prompts, and artifact views — without re-owning protocol, auth, or transport concerns.

> **Scope note — browser workspace slice after transport.** The
> `web-session-auth` slice owns authentication and session lifecycle. The
> `web-conversation-protocol` slice owns conversation entities and contracts. The
> `web-gateway-conversation-transport` slice owns gateway mediation, WebSocket
> transport, and reconnect plumbing. This slice consumes those capabilities and
> defines the operator-facing browser workspace: what the operator sees, how the
> transcript behaves, how work is controlled, how approvals are answered, and
> how artifacts are inspected. Operational dashboards, controlled config
> mutations, and packaging concerns remain out of scope for later slices.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Operator Reads and Continues a Conversation in the Workspace (Priority: P1)

An authenticated operator opens the web workspace, selects a conversation, reads the existing transcript, and sends the next instruction from a composer embedded in the same workspace. The workspace makes the current conversation obvious, shows turns in order, and records new operator input in a way that stays aligned with the authoritative conversation state.

**Why this priority**: Without a usable transcript and composer, the browser has transport but not a working REPL. This is the minimum browser experience that turns the completed backend and transport work into something an operator can actually use.

**Independent Test**: Open an existing conversation in the browser, verify prior turns render in order, send a new instruction from the composer, and confirm the transcript reflects the new turn in the correct conversation.

**Acceptance Scenarios**:

1. **Given** an authenticated operator with at least one existing conversation, **When** the operator opens the workspace and selects a conversation, **Then** the transcript displays the authoritative ordered conversation history with clear turn boundaries and attribution.
2. **Given** an authenticated operator viewing a conversation, **When** the operator enters a new instruction in the composer and submits it, **Then** the workspace records the submission against the active conversation and shows the new turn in the transcript.
3. **Given** multiple conversations are available, **When** the operator switches from one conversation to another, **Then** the workspace updates the visible transcript and composer context to the newly selected conversation without mixing state between them.

---

### User Story 2 — Operator Watches Live Work Unfold in the Transcript (Priority: P1)

After sending an instruction, the operator sees work unfold directly inside the conversation transcript through incremental updates. Partial text, status transitions, structured activity, approvals, and final outcomes all appear in context, preserving the feeling of a live REPL instead of a static request/response form.

**Why this priority**: Streaming visibility is a defining part of Hydra's operator experience. Without inline live rendering, the workspace would feel broken or opaque even if the transport underneath is functioning.

**Independent Test**: Submit an instruction that emits multiple streaming updates, observe the transcript during execution, and confirm updates appear incrementally in the correct turn before completion.

**Acceptance Scenarios**:

1. **Given** an instruction has been submitted from the workspace, **When** the system begins producing updates, **Then** the transcript renders incremental updates in the active turn as they arrive instead of waiting for completion.
2. **Given** a turn is actively streaming, **When** the stream completes, fails, or is cancelled, **Then** the transcript shows the final terminal state clearly and leaves the workspace ready for the next operator action.
3. **Given** multiple kinds of updates occur within the same turn, **When** they are displayed, **Then** text, status, activity, and approval-related updates remain distinguishable and ordered within that turn.

---

### User Story 3 — Operator Handles Approvals and Follow-Up Prompts Inline (Priority: P1)

During work, the system may require the operator to approve an action, choose between options, or answer a follow-up question. The operator handles these prompts directly in the workspace without leaving the conversation context, and the workspace makes it clear whether the prompt is pending, answered, stale, or no longer actionable.

**Why this priority**: Human-in-the-loop interaction is central to Hydra. If approvals and prompts are awkward or easy to miss, the browser workspace fails one of the product's core workflows.

**Independent Test**: Trigger work that pauses for approval or follow-up input, answer the prompt from within the workspace, and verify the transcript records the response and resumed work in the correct turn.

**Acceptance Scenarios**:

1. **Given** active work pauses for operator input, **When** the prompt reaches the workspace, **Then** the operator sees the request inline with enough context to respond safely.
2. **Given** a prompt is pending in the transcript, **When** the operator submits a valid response, **Then** the workspace records the response, marks the prompt resolved, and reflects the resumed work in the same conversation.
3. **Given** a prompt is no longer valid because the underlying work state changed, **When** the operator returns to the workspace, **Then** the prompt is shown as stale or unavailable rather than silently accepting an invalid response.

---

### User Story 4 — Operator Recovers Workspace Context After Refresh or Reconnect (Priority: P2)

If the browser refreshes, sleeps, or temporarily disconnects, the operator returns to a workspace that re-synchronizes to the authoritative conversation state without duplicating or losing visible transcript content. The workspace also communicates whether it is reconnecting, resynchronizing, or ready for normal interaction.

**Why this priority**: The transport slice established reconnect semantics, but operators still need the browser workspace to turn those semantics into a trustworthy experience. A reconnect that technically works but looks confusing still fails the product goal.

**Independent Test**: Start a streaming turn, refresh or disconnect the browser mid-stream, reconnect, and verify the transcript matches the authoritative conversation state with no missing or duplicate visible entries.

**Acceptance Scenarios**:

1. **Given** the operator refreshes the browser during an active turn, **When** the workspace reloads, **Then** the transcript rehydrates to the authoritative state and live updates resume in the correct position.
2. **Given** the browser temporarily loses connectivity, **When** the workspace reconnects, **Then** the operator sees a clear synchronization state and the transcript converges to the authoritative conversation without gaps or duplication.
3. **Given** work completed while the workspace was disconnected, **When** the operator returns, **Then** the finished state is visible in the transcript without requiring manual reconstruction by the operator.

---

### User Story 5 — Operator Controls and Branches Work from the Transcript (Priority: P2)

The workspace allows the operator to take action directly from conversation context: cancel active work, retry a prior turn, branch from a prior point, and submit follow-up instructions that build on the current state. The workspace makes these actions discoverable and clearly shows their effects in conversation history.

**Why this priority**: A real Hydra workspace is not passive. Operators need direct control over work already in progress and the ability to explore alternatives without leaving the transcript.

**Independent Test**: Cancel a running turn, retry a failed turn, branch from an earlier turn into a new conversation, and submit a follow-up instruction. Verify the workspace shows each resulting state change in the appropriate conversation context.

**Acceptance Scenarios**:

1. **Given** a turn is currently in progress, **When** the operator chooses cancel from the workspace, **Then** the turn stops, the transcript records the cancellation, and the conversation becomes ready for the next instruction.
2. **Given** a prior turn is eligible for retry, **When** the operator retries it from the workspace, **Then** a new execution begins and its relationship to the original turn remains visible.
3. **Given** a prior turn is eligible as a branch point, **When** the operator creates a branch from that point, **Then** the workspace opens a new conversation whose visible lineage is clear and whose history matches the selected prefix.
4. **Given** the operator wants to continue the current line of work, **When** the operator submits a follow-up instruction, **Then** the workspace treats it as the next turn in the active conversation rather than creating unrelated state.

---

### User Story 6 — Operator Inspects Artifacts Without Leaving the Workspace (Priority: P2)

When turns produce artifacts such as diffs, files, logs, or test results, the operator can inspect them directly from the conversation workspace. Artifacts remain associated with the turn that produced them and can be revisited later from conversation history.

**Why this priority**: Artifacts are often the most important output of Hydra's work. If operators must leave the workspace or lose context to inspect them, the browser experience stops feeling like a coherent REPL.

**Independent Test**: Produce one or more artifacts from a turn, open them from the workspace, refresh the page, reopen the conversation, and confirm the same artifacts remain accessible from the same turn.

**Acceptance Scenarios**:

1. **Given** a turn produced one or more artifacts, **When** the operator views that turn in the workspace, **Then** the artifacts are visible as part of that turn's context and can be inspected individually.
2. **Given** a conversation contains historical artifacts from earlier work, **When** the operator reopens the conversation later, **Then** those artifacts remain accessible from the associated turns.
3. **Given** a turn produced multiple artifact kinds, **When** the operator inspects them, **Then** the workspace distinguishes them clearly and does not merge unrelated outputs into a single undifferentiated blob.

---

### User Story 7 — Operator Keeps Orientation in Large or Multi-Session Conversations (Priority: P3)

The workspace remains understandable when a conversation becomes long, when multiple browser sessions view the same conversation, or when controls change because another session already acted. The operator can still orient around the latest meaningful state without treating the workspace as a fragile single-tab surface.

**Why this priority**: This matters for production-readiness and trust, but it builds on the more fundamental transcript, streaming, and control flows.

**Independent Test**: Open the same conversation in two browser sessions, perform control actions in one session, and verify the other session converges to the same visible state while stale controls are not silently accepted.

**Acceptance Scenarios**:

1. **Given** a conversation has substantial history, **When** the operator opens it, **Then** the workspace remains usable and the operator can reach the most recent relevant turns without waiting for every historical detail to fully render first.
2. **Given** the same conversation is open in multiple browser sessions, **When** one session performs a control action such as cancel or approval response, **Then** the other session converges to the same authoritative state within the normal synchronization flow.
3. **Given** a visible control became stale because another session already acted, **When** the operator attempts to use the stale control, **Then** the workspace communicates that the action is no longer available instead of pretending it succeeded.

---

### Edge Cases

- What happens when the operator submits a new instruction while a prior turn is still active? The workspace must make the governing policy explicit and visible rather than leaving the operator to infer it from failures or silence.
- What happens when a prompt is pending during a reconnect and is resolved elsewhere before the workspace finishes syncing? The workspace must converge to the authoritative resolved or stale state without presenting an unsafe action path.
- What happens when a conversation is large enough that rendering all prior turns would delay current work? The workspace must preserve operator responsiveness and recent-context usability.
- What happens when the same conversation is open in multiple tabs or devices and both attempt conflicting actions? The workspace must show the authoritative outcome and make any rejected local action understandable.
- What happens when artifact content cannot be displayed inline or is temporarily unavailable? The workspace must communicate the condition clearly without implying the artifact never existed.
- What happens when transcript or artifact content contains untrusted markup-like text? The workspace must present it safely without executing active content.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The workspace MUST present an authenticated operator with a conversation-centered interface that combines transcript viewing and instruction composition in a single coherent surface.
- **FR-002**: The workspace MUST allow the operator to create, select, reopen, and continue conversations without mixing transcript or composer state between conversations.
- **FR-003**: The workspace MUST allow the operator to submit a new instruction from the active conversation context and must reflect the submission in that conversation's visible state.
- **FR-004**: The workspace MUST render streaming turn updates inline within the owning turn in the same order as the authoritative conversation event sequence.
- **FR-005**: The workspace MUST clearly distinguish turn states, including at least pending, actively running, awaiting operator input, completed, failed, and cancelled.
- **FR-006**: The workspace MUST communicate connection and synchronization state clearly enough that the operator can distinguish normal live operation from reconnecting, resynchronizing, session loss, and daemon unavailability.
- **FR-007**: After a browser refresh or reconnect, the workspace MUST reconcile to the authoritative conversation state without displaying duplicate, missing, or out-of-order transcript entries.
- **FR-008**: The workspace MUST present approval requests and follow-up prompts inline with the conversation turn that owns them and must allow eligible operator responses directly from the workspace.
- **FR-009**: The workspace MUST make prompt state explicit, including pending, answered, stale, unavailable, and rejected responses where applicable.
- **FR-010**: The workspace MUST allow the operator to cancel an eligible in-progress turn from conversation context and must reflect the resulting state change in the transcript.
- **FR-011**: The workspace MUST allow the operator to retry an eligible turn from conversation context and must preserve visible lineage between the original turn and the retried execution.
- **FR-012**: The workspace MUST allow the operator to branch from an eligible prior turn into a new conversation and must preserve visible lineage between the source conversation and the branched conversation.
- **FR-013**: The workspace MUST support follow-up instructions as first-class conversation actions so operators can continue the current line of work without re-establishing context manually.
- **FR-014**: The workspace MUST display artifacts in association with the turn that produced them and MUST allow the operator to inspect artifact content or metadata without leaving the workspace context.
- **FR-015**: The workspace MUST remain usable for conversations with large histories, allowing operators to interact with the current conversation context without requiring the entire historical record to render first.
- **FR-016**: The workspace MUST converge to the authoritative conversation state when the same conversation is open in multiple browser sessions, and MUST not silently accept stale controls after another session has already changed the state.
- **FR-017**: The workspace MUST render untrusted transcript, prompt, and artifact content in a browser-safe manner that prevents active content execution or unsafe context escape.
- **FR-018**: The workspace MUST preserve sufficient operator orientation that major state transitions — submit, stream start, prompt pending, cancel, retry, branch, completion, failure, reconnect, and session loss — are all visible and attributable in the transcript.

### Key Entities

- **Workspace Conversation View**: The operator-facing presentation of a single conversation, including transcript, current state, visible controls, and associated artifacts.
- **Composer Draft**: The operator's in-progress instruction text or structured prompt response associated with a specific conversation context.
- **Transcript Entry**: A visible unit within the workspace representing a turn, a nested prompt, a stream update grouping, or another operator-relevant conversation event.
- **Prompt Action**: An operator response opportunity associated with a pending approval or follow-up request, including its allowed response modes and visible status.
- **Artifact View**: The operator-facing representation of a turn-produced artifact, including its label, kind, availability, and inspectable content or metadata.
- **Conversation Lineage**: The visible relationship between a conversation and the prior turns or source conversation from which a retry, follow-up, or branch was created.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An authenticated operator can open a conversation, read its transcript, submit a new instruction, and see the resulting turn appear in the active workspace with zero conversation-context mixups in automated end-to-end tests.
- **SC-002**: Streaming updates become visible in the active transcript within 1 second of authoritative production under normal local conditions, and appear in order with zero duplicate visible entries.
- **SC-003**: After a browser refresh or reconnect during an active turn, the workspace converges to the authoritative conversation state with zero missing or out-of-order visible transcript entries in automated reconnect tests.
- **SC-004**: An approval or follow-up prompt remains actionable after a refresh or reconnect when it is still pending, and is shown as resolved or stale when it is no longer actionable, in 100% of defined prompt recovery tests.
- **SC-005**: Cancel, retry, branch, and follow-up actions executed from the workspace produce visible transcript state changes that match the authoritative conversation state within one normal synchronization cycle.
- **SC-006**: Artifacts produced by a turn remain accessible from the workspace immediately after production and after a full page refresh in 100% of defined artifact persistence tests.
- **SC-007**: Large-conversation tests demonstrate that operators can reach and interact with the most recent conversation context without waiting for the full conversation history to fully render first.
- **SC-008**: Security regression tests confirm that untrusted transcript, prompt, and artifact content never executes active browser content and never escapes its intended display context.
- **SC-009**: Two simultaneous browser sessions viewing the same conversation converge to the same visible conversation state within one synchronization cycle after any supported operator control action.

## Dependencies _(mandatory)_

This slice depends on and does NOT re-own the following:

- **web-repl-foundation** — workspace structure, package boundaries, and baseline quality gates for web packages.
- **web-session-auth** — authentication, session lifecycle, origin/CSRF posture, and session-state signaling.
- **web-conversation-protocol** — conversation, turn, stream, prompt, and artifact contracts plus their semantics.
- **web-gateway-conversation-transport** — gateway REST routes, WebSocket streaming, reconnect/resume, error surfaces, and session-bound conversation transport.

## Assumptions

- The gateway transport delivered by the prior slice is sufficiently stable that this slice can focus on browser interaction and rendering behavior rather than transport invention.
- Conversation creation, selection, streaming, approvals, retry, cancel, and artifact retrieval are available through browser-facing surfaces before this slice starts implementation.
- The operator model remains single-user authenticated access for this slice; broader multi-user collaboration is future work.

## Out of Scope

- **Hydra-native operations panels** — budgets, daemon health dashboards, queue management panels, council visualization, and routing controls belong to `web-hydra-operations-panels`.
- **Controlled mutations and dangerous-action governance** — config editing, workflow launches, destructive-action safeguards, and broader operational mutation UX belong to `web-controlled-mutations`.
- **Transport invention or replacement** — session auth, gateway mediation, WebSocket transport, reconnect buffering, and browser-to-gateway protocol contracts are owned by earlier slices.
- **New daemon-owned conversation semantics** — this slice consumes existing conversation and transport capabilities rather than redefining the conversation model.
- **Offline-first behavior** — operating the workspace without a live authoritative backend is out of scope for this slice.
- **Packaging and release hardening** — distribution, accessibility hardening beyond feature-level acceptance, and packaging polish belong to `web-hardening-and-packaging`.
