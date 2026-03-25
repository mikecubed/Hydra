# Feature Specification: Web Hydra Operations Panels

**Created**: 2026-03-25
**Status**: Draft
**Input**: Create the next web-interface feature specification for Hydra: `web-hydra-operations-panels`, grounded in the existing web-interface roadmap and boundaries, and focused on Hydra-native operational visibility and control surfaces that build on the completed browser chat workspace.

> **Scope note — Hydra-native control surfaces after the chat workspace.** The
> existing browser workspace already covers conversations, transcript
> streaming, approvals, reconnect UX, turn controls, and artifact inspection.
> This slice adds operational visibility and control surfaces on top of that
> workspace: queue and checkpoint awareness, routing and mode controls, agent
> and council visibility, budget awareness, daemon health, and multi-agent
> execution views. The daemon remains authoritative for orchestration state and
> durable mutations, and the gateway remains an adapter rather than a second
> control plane.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Operator Sees Active Hydra Work Across the Queue (Priority: P1)

An authenticated operator can open the browser workspace and immediately see what Hydra is doing beyond the currently open conversation: which work items are waiting, running, paused, blocked, or completed recently, and how those items relate to the operator's active session. The operator can understand queue state without leaving the browser workspace or inspecting raw daemon output.

**Why this priority**: The chat workspace already lets an operator work inside a single conversation. The next missing capability is operational awareness across Hydra's broader execution state so the operator can make safe decisions about what to watch, continue, or defer.

**Independent Test**: Present the operator with a mix of queued, running, and recently completed work items, then verify the browser shows each item with its current state, ordering, and relationship to the active conversation or task context.

**Acceptance Scenarios**:

1. **Given** Hydra has multiple work items in different states, **When** the operator opens the operations panels, **Then** the operator can distinguish waiting, active, blocked, paused, failed, cancelled, and completed work items without opening each conversation individually.
2. **Given** the operator is focused on a specific conversation, **When** that conversation has related queued or active work, **Then** the operations panels make that relationship visible without mixing unrelated work into the conversation transcript.
3. **Given** queue state changes while the operator is viewing the browser workspace, **When** work is added, started, reprioritized, paused, resumed, or finished, **Then** the operations panels converge to the updated authoritative state and preserve the operator's orientation.

---

### User Story 2 — Operator Understands Checkpoints and Execution Progress (Priority: P1)

While Hydra is working, the operator can see meaningful checkpoints that explain progress, waiting states, resumptions, and important execution transitions. Checkpoint visibility gives the operator confidence that work is progressing intentionally rather than silently stalling.

**Why this priority**: Queue visibility alone tells the operator what is active, but not whether active work is progressing safely. Checkpoint awareness is essential to make Hydra's orchestration legible in a browser-native way.

**Independent Test**: Start work that produces multiple checkpoints, then verify the browser presents checkpoint history and current checkpoint state in a way that lets the operator explain what happened before, during, and after execution.

**Acceptance Scenarios**:

1. **Given** a work item has passed through multiple checkpoints, **When** the operator inspects that item from the operations panels, **Then** the operator can see the ordered checkpoint history and the current checkpoint state.
2. **Given** work pauses because it is awaiting input, approval, or recovery, **When** the pause is reflected in authoritative state, **Then** the operations panels show the latest checkpoint or waiting condition rather than implying silent failure.
3. **Given** a work item resumes after being paused or recovered, **When** new progress is reported, **Then** the checkpoint view makes the resumed path visible without erasing prior checkpoint history.

---

### User Story 3 — Operator Monitors Health, Budgets, and Operational Risk (Priority: P1)

The operator can monitor daemon health and execution budgets from the same browser workspace used for Hydra conversations. The operator can tell whether the system is healthy, degraded, unavailable, or approaching budget limits, and can see whether a warning applies globally or only to a specific work item.

**Why this priority**: Hydra-native operation requires more than conversation visibility. Operators need confidence that the underlying system is healthy and that active work is staying inside allowed cost or effort limits.

**Independent Test**: Simulate normal, warning, degraded, and unavailable conditions for daemon health and budget usage, then verify the browser communicates the affected scope, urgency, and authoritative current state.

**Acceptance Scenarios**:

1. **Given** the daemon is healthy and work budgets are within normal range, **When** the operator views the operations panels, **Then** the health and budget surfaces communicate a normal state without requiring extra investigation.
2. **Given** a budget threshold is nearing or exceeded for a work item or session, **When** the authoritative state reflects that warning, **Then** the operations panels show the warning with enough context for the operator to understand which work is affected.
3. **Given** the daemon becomes unavailable or degraded, **When** the browser receives that state, **Then** the operations panels clearly separate system-health degradation from conversation-specific failures.

---

### User Story 4 — Operator Understands Routing, Mode, Agent, and Council Decisions (Priority: P2)

For active or recent work, the operator can see how Hydra chose to route the work, which execution mode is active, which agent or agents are participating, and whether a council or multi-agent process is underway. The operator can understand these decisions without reading internal logs or inferring them from transcript text.

**Why this priority**: Hydra's native value comes from orchestration choices, agent selection, and council behavior. Without making those choices visible, the browser still hides core product behavior behind a generic chat surface.

**Independent Test**: Run work that changes routing, mode, agent selection, or council participation, then verify the browser shows the current and recent authoritative decisions in operator-facing language.

**Acceptance Scenarios**:

1. **Given** work is running under a specific routing or execution mode, **When** the operator views the related operational details, **Then** the current routing and mode are visible with enough context to distinguish them from other possible states.
2. **Given** Hydra changes the selected agent or participating group during execution, **When** that change is reflected in authoritative state, **Then** the operations panels show the new assignment and preserve visible history of the prior assignment.
3. **Given** a council or multi-agent process is active, **When** the operator views the work item, **Then** the browser makes the participating contributors and overall progression visible without requiring the operator to parse raw event output.

---

### User Story 5 — Operator Uses Safe Operational Controls from the Browser (Priority: P2)

When Hydra permits it, the operator can change eligible routing, mode, agent, or council-related controls from the browser and receive authoritative confirmation of the result. The browser makes it clear which controls are available, which are read-only, and when a requested change was rejected, superseded, or became stale.

**Why this priority**: Phase 3 includes operational controls, but those controls must remain subordinate to daemon authority. Operators need safe, explicit control surfaces that never pretend the browser owns orchestration state.

**Independent Test**: Expose a set of allowed and disallowed control changes, perform an eligible control change, and verify the browser reflects acceptance, rejection, staleness, and resulting authoritative state correctly.

**Acceptance Scenarios**:

1. **Given** a work item allows a routing, mode, agent, or council-related change, **When** the operator requests the change from the browser, **Then** the operations panels show that the request is pending until the authoritative result is known and then reflect the resulting state.
2. **Given** a visible control is not currently eligible, **When** the operator inspects the operations panels, **Then** the browser marks that control as unavailable or read-only rather than inviting an unsafe action.
3. **Given** another session or system event changes the same control first, **When** the operator attempts the now-stale action, **Then** the browser explains that the action is no longer valid and converges to the authoritative state.

---

### User Story 6 — Operator Visualizes Multi-Agent and Council Execution Clearly (Priority: P3)

The operator can visualize how multiple agents or council participants contributed to a work item over time, including whether execution is sequential, overlapping, waiting, or concluded. The visualization remains understandable even when many participants or transitions are involved.

**Why this priority**: This deepens operator trust and comprehension, but it builds on the more fundamental queue, checkpoint, health, and control surfaces delivered in the higher-priority stories.

**Independent Test**: Observe a work item that uses multiple contributors or a council process, then verify the browser presents the contributors, major transitions, and current overall status in a way that an operator can explain after the fact.

**Acceptance Scenarios**:

1. **Given** multiple contributors participate in a work item, **When** the operator opens the execution view, **Then** the browser distinguishes each contributor's participation and major state transitions.
2. **Given** contributor activity overlaps or proceeds in stages, **When** the operator reviews the execution view, **Then** the sequence remains understandable and does not collapse distinct participation into an ambiguous summary.
3. **Given** a council concludes, is interrupted, or fails to reach an outcome, **When** the operator inspects the completed view, **Then** the final council state is visible and distinguishable from ongoing work.

---

### Edge Cases

- What happens when queue state changes rapidly while the operator is inspecting one work item? The operations panels must preserve orientation and avoid implying a stable state that has already changed.
- What happens when checkpoint history is incomplete because the browser connected late or recovered from interruption? The browser must distinguish recovered authoritative history from still-unavailable detail.
- What happens when a budget warning applies to only one work item while overall daemon health remains normal? The browser must separate local risk from global system degradation.
- What happens when the daemon is reachable again after being unavailable? The operations panels must show the restored state without implying that missed control requests were accepted.
- What happens when a control becomes stale because another browser session or automated system action already changed the state? The browser must reject the stale path visibly and converge to the new authoritative state.
- What happens when a work item uses many agents or repeated council transitions? The execution view must remain interpretable without flattening distinct participants into an unreadable mass.
- What happens when an operator lacks authority for a visible control? The browser must show the control as unavailable or read-only rather than presenting it as a broken action.
- What happens when no operational data is currently available for a newly opened or idle workspace? The browser must show an explicit empty state rather than implying load failure.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST provide Hydra-native operations panels within the browser workspace that add operational visibility beyond the existing conversation transcript and artifact experience.
- **FR-002**: The system MUST present the authoritative task or work queue state, including at least waiting, active, paused, blocked, completed, failed, and cancelled items, without requiring the operator to inspect each conversation individually.
- **FR-003**: The system MUST show each visible work item's relationship to its relevant conversation, session, or execution context when such a relationship exists.
- **FR-004**: The system MUST present ordered checkpoint history and current checkpoint status for eligible work items.
- **FR-005**: The system MUST distinguish active progress, waiting-for-input states, recovery states, and terminal states so operators can tell whether work is progressing or stalled.
- **FR-006**: The system MUST present daemon health in a way that distinguishes healthy, degraded, unavailable, and recovering conditions.
- **FR-007**: The system MUST present budget status in a way that distinguishes normal, warning, exceeded, and unavailable budget conditions, and MUST identify the affected scope when known.
- **FR-008**: The system MUST make routing, execution mode, selected agent, and council or multi-agent participation visible for eligible work items.
- **FR-009**: The system MUST preserve visible history when routing, mode, selected agent, or council participation changes during execution.
- **FR-010**: The system MUST provide a browser-safe operational view of council and multi-agent execution that allows an operator to understand contributors, major transitions, and current overall status.
- **FR-011**: The system MUST make it explicit which operational controls are currently actionable, read-only, unavailable, or stale.
- **FR-012**: When the daemon allows a routing, mode, agent, or council-related change, the system MUST let the operator request that change from the browser and MUST reflect the authoritative result.
- **FR-013**: The system MUST not present the browser or gateway as the source of truth for orchestration state; visible state changes and control outcomes MUST reconcile to the daemon-authoritative result.
- **FR-014**: The system MUST converge to authoritative queue, checkpoint, control, budget, and health state after reconnect, refresh, or concurrent browser activity without silently preserving stale local assumptions.
- **FR-015**: The system MUST distinguish global daemon conditions from work-item-specific conditions so operators can tell whether an issue affects the whole system or a single execution.
- **FR-016**: The system MUST provide explicit empty, unavailable, and partial-data states so operators can distinguish lack of work from lack of visibility.
- **FR-017**: The system MUST ensure that operational visibility and controls extend the existing browser workspace rather than re-defining conversation, transcript, approval, reconnect, or artifact behaviors already owned by earlier slices.
- **FR-018**: The system MUST preserve workspace and package boundaries such that browser-facing behavior remains within the web workspace, adapter behavior remains within the gateway, and daemon-owned orchestration state and durable mutations remain authoritative outside the browser.

### Key Entities

- **Work Queue Item**: An operator-visible unit of Hydra work, including its current state, relative ordering, owning context, and overall execution status.
- **Checkpoint Record**: A meaningful execution waypoint attached to a work queue item, including its order, visible label, timing context, and current or historical status.
- **Operational Control State**: The operator-facing description of whether a routing, mode, agent, or council-related control is actionable, pending, read-only, unavailable, stale, accepted, or rejected.
- **Routing or Mode Selection**: The authoritative current execution path or mode attached to a work item, along with prior visible changes when they matter to operator understanding.
- **Agent Assignment**: The current or historical contributor selection for a work item, including when one contributor replaced, joined, or yielded to another.
- **Council Execution View**: The operator-facing representation of a multi-contributor or council process, including participants, major transitions, and final overall state.
- **Budget Status**: The current budget posture for a work item, session, or broader operational scope, including severity and whether the data is complete or unavailable.
- **Daemon Health Snapshot**: The current authoritative view of daemon availability and health relevant to browser operators, including whether the condition is normal, degraded, unavailable, or recovering.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In automated end-to-end tests, an operator can identify the current state of every visible queued or active work item in the operations panels with 100% agreement against the authoritative state fixture.
- **SC-002**: In checkpoint progression tests, operators can see current checkpoint status and ordered checkpoint history for eligible work items with zero missing or out-of-order visible checkpoint entries after synchronization completes.
- **SC-003**: In health and budget warning tests, the browser correctly distinguishes global daemon issues from work-item-specific warnings in 100% of defined scenarios.
- **SC-004**: In control-state tests, every visible routing, mode, agent, or council-related control is labeled as actionable, pending, read-only, unavailable, stale, accepted, or rejected in a way that matches the authoritative result in 100% of defined cases.
- **SC-005**: After refresh, reconnect, or concurrent-browser recovery, the operations panels converge to authoritative queue, checkpoint, control, budget, and health state within one normal synchronization cycle with zero stale-success presentations in automated recovery tests.
- **SC-006**: In multi-agent and council execution tests, operators can identify the participating contributors and final overall execution state for each scenario without consulting transcript text or raw daemon output.
- **SC-007**: In empty-state and partial-data tests, operators can distinguish no active operational data from unavailable or incomplete operational data in 100% of defined scenarios.
- **SC-008**: In regression tests for previously delivered chat-workspace behavior, the addition of operations panels introduces zero failures in conversation rendering, approvals, reconnect handling, turn controls, or artifact inspection flows.

## Dependencies _(mandatory)_

This slice depends on and does NOT re-own the following:

- **web-repl-foundation** — workspace structure, web package boundaries, and baseline quality expectations for the browser experience.
- **web-session-auth** — authenticated browser sessions, session-state signaling, and browser-safe session lifecycle handling.
- **web-conversation-protocol** — authoritative conversation, turn, prompt, artifact, and stream semantics already used by the workspace.
- **web-gateway-conversation-transport** — browser-to-daemon mediation, live synchronization, replay, and recovery behavior that this slice builds upon.
- **web-chat-workspace** — conversation transcript, streaming rendering, approvals, reconnect UX, turn controls, and artifact inspection that this slice extends rather than replaces.

## Assumptions

- The browser workspace delivered by earlier slices remains the operator's primary entry point, and these operations panels are an additional surface within that experience rather than a separate product.
- The daemon can provide authoritative operational state for queue, checkpoints, controls, budgets, health, and multi-agent execution, even if some browser-facing details require further contract definition during planning.
- Operational controls in this slice are limited to safe, daemon-authorized routing, mode, agent, and council-related changes; broader destructive or durable configuration mutations remain outside this scope.
- Multi-session and reconnect behavior continue to follow the established authoritative-sync model rather than introducing browser-owned offline orchestration.

## Out of Scope

- **Re-specifying the chat workspace** — conversation lists, transcript rendering, approvals, reconnect UX, turn controls, and artifact inspection are already covered by `web-chat-workspace`.
- **Creating a second browser control plane** — the browser and gateway do not become the authoritative owner of orchestration state or durable mutations.
- **Controlled configuration editing or workflow launches** — broader safe-mutation experiences belong to `web-controlled-mutations`.
- **Packaging, release hardening, or broad accessibility completion work** — final hardening and packaging belong to `web-hardening-and-packaging`.
- **Direct browser coupling to Hydra core internals** — this slice must preserve the existing web boundary rules rather than letting browser code depend directly on Hydra core internals.
