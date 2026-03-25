# Implementation Plan: Web Hydra Operations Panels

**Date**: 2026-03-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `.sdd/web-hydra-operations-panels-4fhrcirf/spec.md`

## Summary

This plan adds Phase 3 Hydra-native operations surfaces to the existing browser workspace without re-owning the delivered chat workspace. The browser gains queue visibility, checkpoint history, daemon health, budget awareness, routing/mode/agent/council visibility, multi-agent execution detail, and daemon-authorized operational controls as a companion surface inside `apps/web/`. The daemon remains the source of truth for operational state and control eligibility, the gateway remains a validating mediation layer, and shared browser-safe contracts in `packages/web-contracts/` define the projection consumed by the browser. In this slice, a browser-visible `WorkQueueItemView` is a daemon-owned projection of a Hydra task/work item, not a rebranding of the existing per-conversation instruction queue; conversation queue data may be linked when relevant, but it is not the primary source of the operations queue.

> **Scope note.** This slice extends the existing workspace route and layout; it does not redesign transcript rendering, approvals, reconnect semantics, artifact inspection, or conversation ownership already delivered by `web-chat-workspace`. The new work is an adjacent operations feature that consumes daemon-authoritative state and surfaces it in browser-native panels.

## Prerequisites

This slice depends on and does NOT re-own the following existing deliverables:

- **web-repl-foundation** — workspace/package boundaries, TypeScript web stack, shared-quality baseline.
- **web-session-auth** — authenticated browser sessions, CSRF/origin posture, session lifecycle signaling, and daemon heartbeat wiring.
- **web-conversation-protocol** — shared contracts for conversations, turns, stream events, approvals, artifacts, and activity records.
- **web-gateway-conversation-transport** — validated browser↔gateway↔daemon mediation, reconnect/replay semantics, structured gateway errors, and daemon availability signaling.
- **web-chat-workspace** — conversation list, transcript, approvals, reconnect UX, turn controls, and artifact inspection that remain the primary owners of chat behavior.

## Technical Context

**Language/Version**: TypeScript 5.9+, strict ESM, Node 24+, React 19 in `apps/web/`  
**Primary Dependencies**: React 19, Vite 8, TanStack Router 1.x, TanStack Query 5.x, Hono 4.x, Zod 4.x, existing Hydra daemon runtime and read/write routes  
**Storage**: No browser- or gateway-owned durable state; browser state is in-memory view state, gateway remains stateless/in-memory, daemon owns operational truth and durable mutations  
**Testing**: Vitest browser/component tests in `apps/web/`; `node:test` integration/unit tests in `apps/web-gateway/` and `packages/web-contracts/`; daemon route/projection tests in `test/`; regression coverage for existing chat workspace flows  
**Target Platform**: Browser workspace in `apps/web/` against local/LAN Hydra gateway and daemon  
**Project Type**: Existing browser application + gateway mediation + shared contract extensions + minimal daemon-owned operations projection surface  
**Performance Goals**: Operations panels converge within one normal synchronization cycle after authoritative changes; detail panels stay interactive with dozens of recent work items; control requests show pending/accepted/rejected/stale outcomes without duplicate success presentation  
**Constraints**: Preserve workspace boundaries (`apps/web` and `apps/web-gateway` consume shared contracts only); do not let gateway become a second control plane; do not re-own chat workspace concerns; no unsafe inference of authoritative state in browser/gateway; operational controls remain daemon-authorized and concurrency-safe  
**Scale/Scope**: Single authenticated operator, multi-tab/browser recovery, active queue plus recent completed work, mixed single-agent and council execution, partial-data and degraded-daemon scenarios

## Authoritative Source Decisions

- **Operations queue authority**: The operations queue is derived from daemon task/work state, normalized into a browser-safe `WorkQueueItemView`. It is intentionally distinct from the existing per-conversation instruction queue contracts under `work-control`.
- **Conversation linkage**: `relatedConversationId` and `relatedSessionId` are optional relationship hints attached by the daemon projection when that linkage is already known from authoritative runtime/session state. The browser does not infer these links.
- **Routing/mode/agent/council history**: This slice must create a daemon-owned operational projection/history for those surfaces rather than implying that current raw config, activity, or session fields already form a browser-safe read model.
- **Budget attribution**: Global budget posture is mandatory in this slice. Per-session or per-work-item budget scope remains part of this feature only when daemon-owned attribution can be produced authoritatively during Phase 2; the plan must not assume that finer-grained accounting already exists.

## Project Structure

### Documentation (this feature)

```text
.sdd/web-hydra-operations-panels-4fhrcirf/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   └── hydra-operations-panels.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository layout)

This slice extends the delivered workspace/gateway/contracts architecture rather than creating a second workspace shell.

```text
apps/web/
└── src/
    ├── routes/
    │   └── workspace.tsx                           # compose chat workspace + operations panels
    ├── features/
    │   ├── chat-workspace/
    │   │   └── components/workspace-layout.tsx    # extend layout with operations slot/rail
    │   └── operations-panels/                     # NEW browser-owned operations feature
    │       ├── api/
    │       │   └── operations-client.ts           # REST adapter for operations snapshot/detail/control routes
    │       ├── model/
    │       │   ├── operations-types.ts            # pure domain/view-state types
    │       │   ├── operations-reducer.ts          # explicit workspace-side operations state
    │       │   ├── selectors.ts                   # derived queue/detail/control selectors
    │       │   ├── sync-controller.ts             # query/poll/refetch orchestration
    │       │   └── control-actions.ts             # pending/stale/result handling for safe controls
    │       ├── components/
    │       │   ├── operations-panel-shell.tsx
    │       │   ├── queue-panel.tsx
    │       │   ├── queue-item-card.tsx
    │       │   ├── checkpoint-panel.tsx
    │       │   ├── health-budget-panel.tsx
    │       │   ├── routing-panel.tsx
    │       │   ├── execution-panel.tsx
    │       │   ├── control-strip.tsx
    │       │   └── empty-state-card.tsx
    │       └── __tests__/
    │           ├── operations-reducer.test.ts
    │           ├── operations-client.test.ts
    │           ├── queue-panel.browser.spec.tsx
    │           ├── health-budget.browser.spec.tsx
    │           ├── control-strip.browser.spec.tsx
    │           └── workspace-operations.integration.test.tsx
    └── shared/
        └── session-state.ts                       # reused daemon/session status vocabulary

packages/web-contracts/
└── src/
    ├── operations.ts                              # NEW shared operations entities/view DTOs
    ├── contracts/
    │   ├── operations-read.ts                     # NEW snapshot/detail/checkpoint read contracts
    │   └── operations-control.ts                  # NEW safe-control request/response contracts
    ├── index.ts                                   # append-only exports
    └── __tests__/
        └── operations-contracts.test.ts

apps/web-gateway/
└── src/
    ├── index.ts                                   # mount operations routes alongside existing routes
    ├── operations/                                # NEW gateway mediation module
    │   ├── daemon-operations-client.ts            # sole daemon communication point for operations routes
    │   ├── operations-routes.ts                   # session-bound read/control routes
    │   ├── request-validator.ts                   # query/body validation for operations DTOs
    │   └── response-translator.ts                 # reuse/extend gateway error mapping if needed
    └── __tests__/
        ├── operations-routes.test.ts
        └── daemon-operations-client.test.ts

lib/daemon/
├── web-operations-routes.ts                       # NEW daemon-owned browser-safe operations projection routes
├── read-routes.ts                                 # mount operations read helpers if needed
└── [existing orchestration/runtime modules]       # reused as authoritative sources only

test/
├── web-operations-routes.test.ts
└── web-operations-projection.test.ts
```

**Structure Decisions**:

- The browser operations feature lives in `apps/web/src/features/operations-panels/` so chat workspace ownership stays intact and route composition remains explicit.
- The existing `workspace.tsx` route remains the composition root; it wires chat and operations features side-by-side rather than merging their reducers into one hidden component state machine.
- Shared operations DTOs live in `packages/web-contracts/` before browser or gateway logic expands, preserving the repo's “shared contracts before shared behavior” rule.
- Gateway mediation for operations lives in its own `apps/web-gateway/src/operations/` module rather than being mixed into conversation transport files.
- Browser-safe operational projections are computed daemon-side in a dedicated route layer so the gateway does not infer orchestration semantics from raw core state.

## Research Findings

See [research.md](./research.md) for full analysis. Key decisions summarized below.

### Decision 1: Compose operations panels into the workspace route instead of expanding chat-workspace ownership

- **Chosen**: Keep `apps/web/src/routes/workspace.tsx` as the integration point and add an `operations-panels` feature rendered as an adjacent rail/panel region.
- **Rationale**: `chat-workspace` already owns transcript/composer/artifact behavior. A sibling feature preserves boundaries, keeps responsibilities legible, and avoids turning the chat store into a general-purpose Hydra control store.
- **Alternatives rejected**: folding all operations state into `chat-workspace/model/`; creating a second standalone browser app route detached from the workspace.

### Decision 2: Use REST snapshot/detail polling for operations state in this slice

- **Chosen**: Deliver operations synchronization through gateway REST snapshot/detail endpoints with query-driven refresh and targeted refetch after control actions, while continuing to reuse existing daemon/session WebSocket notifications for connection status.
- **Rationale**: The current WebSocket transport is conversation-stream oriented. A polling/snapshot model fits queue/health/budget surfaces, minimizes protocol churn, integrates naturally with TanStack Query, and still satisfies the spec's convergence requirement when the polling cycle is explicit.
- **Alternatives rejected**: adding a second WebSocket protocol family in the same slice; deriving operations state from transcript stream events alone.

### Decision 3: Define browser-safe operations contracts before UI or gateway implementation

- **Chosen**: Add dedicated operations entities and contract families in `packages/web-contracts/` for queue snapshots, item detail, checkpoint history, execution participants, health/budget views, and control requests/results.
- **Rationale**: The current shared contracts cover conversation/turn/activity/artifact flows, but they do not define browser-safe queue/health/control vocabulary. Formal contracts prevent browser/gateway duplication and keep daemon-owned projection semantics explicit, including the fact that the operations queue is task/work-item based rather than conversation-queue based.
- **Alternatives rejected**: reusing raw daemon `/state`, `/summary`, `/stats`, or `/self` payloads directly in the browser; inventing browser-only ad hoc types inside `apps/web`.

### Decision 4: Keep the daemon authoritative for both read models and control eligibility

- **Chosen**: Add daemon-owned operations projection endpoints that normalize raw task/session/runtime state into browser-safe DTOs, create an authoritative routing/mode/agent/council history view, and add daemon-owned control endpoints that determine eligibility, concurrency checks, and final outcomes.
- **Rationale**: The browser and gateway cannot safely infer paused vs blocked vs stale control semantics from partial state. Centralizing normalization, history, and eligibility in the daemon preserves authority and avoids the gateway becoming a policy engine.
- **Alternatives rejected**: computing queue state in the gateway from multiple daemon endpoints; letting the browser mark controls actionable based only on local heuristics.

### Decision 5: Stage the feature read-first, then add safe controls

- **Chosen**: Implement read-only operations visibility first (queue, checkpoints, health/budget, routing/participants), then layer daemon-authorized controls with optimistic concurrency and explicit pending/stale/rejected/superseded states.
- **Rationale**: The highest-value stories are operator comprehension and visibility. Sequencing controls after read models reduces risk and gives later control work a stable projection surface, including a daemon-authored control discovery/eligibility contract before any browser mutation affordance ships.
- **Alternatives rejected**: shipping control affordances before authoritative eligibility data exists; bundling all control mutations into the same first pass.

### Decision 6: Preserve the existing chat regression surface and test at four layers

- **Chosen**: Cover (1) shared contracts, (2) daemon projection and gateway mediation, (3) browser reducer/query/controller logic, and (4) browser integration/regression workflows in the existing workspace route.
- **Rationale**: This slice spans boundaries and can easily regress chat behavior indirectly through layout, polling, or route composition. Multi-layer tests are the only safe way to preserve the already-delivered workspace.
- **Alternatives rejected**: UI-only tests; daemon-only tests with no browser convergence coverage.

## Data Model

This slice introduces meaningful browser-facing operational entities and projection rules. See [data-model.md](./data-model.md) for the detailed model.

### Core Browser-Facing Entities

| Entity                       | Description                                                                  | Key Attributes                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **OperationsWorkspaceState** | Browser-owned state for the operations companion surface                     | snapshot status, selected work item, filters, last synchronized marker, partial-data flags                       |
| **WorkQueueItemView**        | Daemon-authored projection of one visible unit of Hydra work                 | id, title, normalized status, ordering, related conversation/session ids, latest checkpoint summary, risk badges |
| **CheckpointRecordView**     | Ordered checkpoint history for a work item                                   | checkpoint id/position, label, status, timestamp, recovery/waiting context                                       |
| **OperationalControlView**   | Browser-facing control affordance with daemon-owned eligibility/result state | control kind, label, availability, pending state, stale reason, result message, expected revision                |
| **RoutingDecisionView**      | Current + prior routing/mode selection for visible work                      | route/mode labels, changed-at markers, provenance, history summary                                               |
| **AgentAssignmentView**      | Current or historical contributor assignment                                 | participant id, label, role, start/end timing, current state                                                     |
| **CouncilExecutionView**     | Summary/timeline of multi-agent execution                                    | participant list, stage summaries, overall status, final outcome                                                 |
| **DaemonHealthView**         | Authoritative workspace-visible daemon health                                | status, observedAt, scope, recovery message                                                                      |
| **BudgetStatusView**         | Authoritative budget posture for workspace/global and optional finer scopes  | status, scope, current usage summary, limit/exceeded metadata, completeness flag                                 |

## Interface Contracts

Full contract-family notes are documented in [contracts/hydra-operations-panels.md](./contracts/hydra-operations-panels.md).

### Planned Contract Families

1. **Operations Read Contracts**
   - workspace snapshot for queue + health + budget overview
   - per-item detail for checkpoints, routing/mode, assignments, council execution, and control eligibility
   - explicit empty/unavailable/partial-data states
2. **Operations Control Contracts**
   - daemon-authorized control discovery plus requests for routing/mode/agent/council-related changes only
   - optimistic concurrency fields for stale request detection
   - normalized accepted/rejected/stale/superseded outcomes
3. **Existing Reused Contracts**
   - conversation, activity, artifact, and session contracts remain dependencies rather than being redefined here

> **Transport note.** This plan does **not** introduce a new public WebSocket family. Operations state is synchronized via REST snapshot/detail contracts plus the already-delivered daemon/session availability signals.

## Implementation Phases

### Phase 1: Shared Operations Vocabulary and Contracts

Define browser-safe operations entities in `packages/web-contracts/` and document them in the contract registry. Cover the task-based operations queue vocabulary, relationship-link semantics, health/budget severity, partial-data semantics, checkpoint records, routing/assignment/council detail, control discovery/eligibility, and control request/result schemas. Tests prove validation, backwards-compatible parse behavior, and append-only barrel exports.

**Delivers**: Contract foundation for FR-001 through FR-016; task-generation-ready API surface.

### Phase 2: Daemon-Owned Operations Projection Surface

Add a daemon-side projection layer that reads existing authoritative task/session/runtime state and emits browser-safe operations DTOs instead of exposing raw `/state`, `/self`, or `/stats` structures directly. Normalize current Hydra task/session vocabulary into operator-facing statuses, define how Hydra tasks become browser work items, join related conversation/session context when known, expose ordered checkpoint history, create a daemon-owned routing/mode/agent/council projection/history view, and surface health/budget detail through explicit read endpoints. If finer-grained budget attribution is not yet authoritatively available, Phase 2 must either add that accounting or mark non-global scopes as unavailable rather than inventing them in the gateway/browser.

**Delivers**: FR-002 through FR-010, FR-013 through FR-016 with daemon authority preserved.

### Phase 3: Gateway Operations Mediation

Add `apps/web-gateway/src/operations/` with session-protected REST routes that validate operations contracts, proxy to daemon operations endpoints, and preserve structured error categories. Reuse existing auth/session/CSRF/origin/rate-limit middleware; keep the gateway free of orchestration-policy logic.

**Delivers**: Browser-safe operations API surface under gateway control; secure mediation for reads and later controls.

### Phase 4: Browser Operations Panels — Read-Only Surfaces

Implement the `operations-panels` browser feature and compose it into `workspace.tsx`/`workspace-layout.tsx` as an adjacent surface. Add queue overview, work-item relationship hints, checkpoints detail, health/budget summary, routing/mode/assignment visibility, and empty/unavailable/partial-data states. Synchronize via query/polling and targeted detail loads without touching transcript ownership.

**Delivers**: User Stories 1–4, FR-001 through FR-010, FR-015 through FR-017.

### Phase 5: Safe Operational Controls

Add explicit control affordances for daemon-authorized routing/mode/agent/council changes only. The daemon must expose control discovery, current eligibility, operator authority, and concurrency tokens before the browser renders an actionable control. The browser shows actionable/read-only/unavailable states, sends control requests with concurrency tokens, keeps controls pending until the authoritative response returns, and then refetches snapshot/detail state so stale local assumptions are cleared.

**Delivers**: User Story 5, FR-011 through FR-014.

### Phase 6: Multi-Agent Visualization, Recovery, and Regression Hardening

Deepen council/multi-agent execution visualization, verify reconnect/refresh/multi-tab convergence, and run regression coverage against existing chat-workspace behaviors and connection-state UX. Ensure empty/partial-data states, degraded daemon states, and stale control paths remain explicit.

**Delivers**: User Story 6, SC-001 through SC-008 verification.

## Risk Mitigation

| Risk                                                                       | Mitigation                                                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser feature accidentally re-owns chat workspace concerns               | Keep operations as a sibling feature; route composition only; avoid mixing operations state into the chat reducer.                                    |
| Gateway starts inferring orchestration policy                              | Move normalization and control eligibility into daemon-owned operations projection routes; gateway only validates and proxies.                        |
| Raw daemon payloads leak unstable/internal structure to the browser        | Introduce dedicated shared operations DTOs and explicit projection tests before UI work.                                                              |
| Polling creates stale-success or orientation issues                        | Use explicit freshness markers, pending control state, targeted refetch on mutation, and partial-data/unavailable distinctions.                       |
| Existing chat flows regress due to layout or route changes                 | Add regression browser tests for transcript, approvals, reconnect banner, turn controls, and artifact inspection.                                     |
| Control actions race across tabs or sessions                               | Require daemon-side concurrency tokens / expected revision, surface stale/superseded outcomes, and always reconcile to refetched authoritative state. |
| Core status vocabulary does not map cleanly to browser-facing queue states | Define normalization in daemon projection helpers and test every mapped state explicitly.                                                             |
